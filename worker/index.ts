import { Container, getContainer } from "@cloudflare/containers";

// ── The edge in front of AetheraClaw ─────────────────────────────────────────
// Everything that reaches aetheraonline.com arrives here first. This Worker has
// three jobs, and the order they run in is the security model:
//
//   1. PROVE THE CALLER. Cloudflare Access has already verified the session and
//      set Cf-Access-Jwt-Assertion. This Worker verifies that JWT's signature
//      against the team's public keys before anything else happens, because a
//      header is only a claim until someone checks it.
//   2. PIN THE TENANT. One container instance per tenant, addressed by a
//      Durable Object id derived from the tenant. The database snapshot scheme
//      in scripts/container-boot.mjs is only correct while that holds.
//   3. AUTHENTICATE ITSELF to the container, with a shared secret the origin
//      requires. Without it the container refuses every request — see
//      src/gateway/auth.ts — so a container reached by any other path than this
//      Worker serves nothing.
//
// Note what is NOT here: no caching. Responses from this origin carry PHI, and
// an edge cache would put patient data in POPs around the world. The cache is
// disabled explicitly rather than left to default heuristics.

export interface Env {
  AETHERACLAW: DurableObjectNamespace<AetheraClawContainer>;
  SNAPSHOTS: R2Bucket;
  /** Shared secret the container requires. Held in Secrets Store. */
  GATEWAY_TOKEN: string;
  /** e.g. "aethera.cloudflareaccess.com" — used to fetch the signing keys. */
  ACCESS_TEAM_DOMAIN: string;
  /** The Access application's AUD tag. A JWT for another app must not work here. */
  ACCESS_AUD: string;
}

export class AetheraClawContainer extends Container<Env> {
  defaultPort = 8080;
  // Long enough that a coder stepping away from a worklist does not come back
  // to a cold start and a snapshot restore, short enough that an idle tenant
  // is not billed for a live instance all night.
  sleepAfter = "20m";

  override envVars = {
    AETHERACLAW_HOST: "0.0.0.0",
    AETHERACLAW_PORT: "8080",
    AETHERACLAW_HOME: "/data",
  };
}

// ── Access JWT verification ──────────────────────────────────────────────────

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

/**
 * Cached signing keys.
 *
 * Fetched from the team's well-known endpoint and reused. Cloudflare rotates
 * these, so the cache is time-bounded and a token whose `kid` is not in the
 * cached set forces one refetch before it is rejected — otherwise a rotation
 * would lock every user out until the isolate happened to be recycled.
 */
let keyCache: { fetchedAt: number; keys: Jwk[] } | null = null;
const KEY_TTL_MS = 60 * 60 * 1000;

async function signingKeys(teamDomain: string, force = false): Promise<Jwk[]> {
  const fresh = keyCache && Date.now() - keyCache.fetchedAt < KEY_TTL_MS;
  if (fresh && !force) return keyCache!.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`could not fetch Access signing keys: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  keyCache = { fetchedAt: Date.now(), keys };
  return keys;
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface AccessClaims {
  email: string;
  sub: string;
  aud: string[];
  exp: number;
}

/**
 * Verify an Access JWT, or return null.
 *
 * Every check here has a specific bypass it closes:
 *
 *   SIGNATURE — without it the token is user-supplied JSON and anyone can mint
 *   themselves an admin identity.
 *
 *   AUD — a valid token from a DIFFERENT Access application in the same
 *   account would otherwise be accepted here. That is the cross-app confusion
 *   that makes "we put Access in front of it" quietly false.
 *
 *   EXP — a leaked token would work forever.
 */
export async function verifyAccessJwt(token: string, env: Env): Promise<AccessClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSignature] = parts;

  let header: { kid?: string; alg?: string };
  let payload: AccessClaims & { aud?: string | string[] };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(rawHeader)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(rawPayload)));
  } catch {
    return null;
  }

  // Only RS256. Accepting the algorithm the TOKEN names is the classic JWT
  // confusion bug: "alg":"none" or an HMAC signed with the public key both
  // verify if the verifier is polite enough to follow instructions.
  if (header.alg !== "RS256" || !header.kid) return null;

  let keys = await signingKeys(env.ACCESS_TEAM_DOMAIN);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await signingKeys(env.ACCESS_TEAM_DOMAIN, true); // rotation
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(rawSignature),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  );
  if (!ok) return null;

  const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
  if (!payload.email) return null;

  return { email: payload.email, sub: payload.sub ?? payload.email, aud, exp: payload.exp };
}

/**
 * Which container instance serves this caller.
 *
 * Derived from the verified email's domain, so an organisation shares one
 * instance and one database — matching the database-per-tenant design — and
 * never from anything the CLIENT can set. Taking a tenant from a header or a
 * query parameter would let a caller address another tenant's instance, and the
 * instance is the thing holding that tenant's claims.
 */
export function tenantKey(email: string): string {
  const at = email.lastIndexOf("@");
  const domain = at === -1 ? email : email.slice(at + 1);
  return domain.toLowerCase() || "default";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // The snapshot channel. The container calls back here to restore and to
    // checkpoint its database, because a container cannot hold an R2 binding
    // itself. It is reachable only from inside the container network and is
    // additionally gated on the same shared secret.
    if (url.pathname.startsWith("/snapshot/")) {
      return handleSnapshot(request, env, url);
    }

    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    const token = request.headers.get("Cf-Access-Jwt-Assertion") ?? "";
    if (token === "") {
      // No Access session. This means the hostname is not actually protected by
      // an Access application — a misconfiguration that would otherwise publish
      // the whole console. Refuse rather than pass it through.
      return new Response("This application requires Cloudflare Access. No access session was presented.", {
        status: 401,
      });
    }

    const claims = await verifyAccessJwt(token, env);
    if (!claims) return new Response("Access session could not be verified.", { status: 403 });

    const instance = getContainer(env.AETHERACLAW, tenantKey(claims.email));

    // Re-sign the request for the origin. The container trusts the identity
    // headers ONLY when GATEWAY_TOKEN is correct, so this is where a request
    // earns that trust — after the JWT was verified, never before.
    const headers = new Headers(request.headers);
    headers.set("x-aethera-gateway-token", env.GATEWAY_TOKEN);
    headers.set("cf-access-authenticated-user-email", claims.email);

    const response = await instance.fetch(new Request(request, { headers }));

    // No caching, ever. Said explicitly because the default heuristics would
    // happily cache a 200 with no Cache-Control, and the body may be a claim.
    const out = new Response(response.body, response);
    out.headers.set("Cache-Control", "no-store, private");
    out.headers.set("X-Content-Type-Options", "nosniff");
    out.headers.set("Referrer-Policy", "no-referrer");
    return out;
  },
};

async function handleSnapshot(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.headers.get("x-aethera-gateway-token") !== env.GATEWAY_TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }
  const key = decodeURIComponent(url.pathname.slice("/snapshot/".length));
  if (key === "" || key.includes("..")) return new Response("bad key", { status: 400 });

  if (request.method === "GET") {
    const obj = await env.SNAPSHOTS.get(key);
    if (!obj) return new Response("no snapshot", { status: 404 });
    return new Response(obj.body, { headers: { "content-type": "application/octet-stream" } });
  }
  if (request.method === "PUT") {
    await env.SNAPSHOTS.put(key, request.body);
    return new Response("stored", { status: 200 });
  }
  return new Response("method not allowed", { status: 405 });
}
