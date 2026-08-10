import { Container, getContainer } from "@cloudflare/containers";

// ── The edge in front of Orion ─────────────────────────────────────────
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
  ORION: DurableObjectNamespace<OrionContainer>;
  SNAPSHOTS: R2Bucket;
  /** Shared secret the container requires. Held in Secrets Store. */
  GATEWAY_TOKEN: string;
  /** e.g. "aethera.cloudflareaccess.com" — used to fetch the signing keys. */
  ACCESS_TEAM_DOMAIN: string;
  /** The Access application's AUD tag. A JWT for another app must not work here. */
  ACCESS_AUD: string;
  /**
   * "1" serves this hostname to anyone, with no sign-in.
   *
   * Set in wrangler.jsonc, so the switch is one line in one file that is
   * reviewed in a diff — rather than the state of an Access application in a
   * dashboard, which changes with no commit and no record.
   *
   * Turning it on is not only this variable: the Access application in front of
   * the hostname must ALSO be deleted, or Cloudflare keeps redirecting to its
   * login page and this Worker is never reached. scripts/access-remove.mjs does
   * that half. Either half alone leaves the deployment in a state that does not
   * match what this file says.
   */
  PUBLIC_ACCESS?: string;
  /** "0" turns the microphone back off. Anything else leaves it on. */
  SPEECH_ENABLED?: string;
  /** "browser" | "local" | "cloud". See the note in the container constructor. */
  SPEECH_ENGINE?: string;
  /** Origin the container posts its snapshot back to. Defaults to this hostname. */
  SNAPSHOT_URL?: string;

  // ── Model provider keys ────────────────────────────────────────────────────
  // All optional, and whichever are set are forwarded to the container. Listed
  // individually rather than swept up generically because a Worker's `env` also
  // carries the gateway token, the bindings and the Access identifiers, and
  // "forward everything that looks like a key" is how a secret ends up in a
  // process that had no business holding it.
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OLLAMA_API_KEY?: string;
}

/**
 * The provider keys the gateway reads, by the exact names it reads them under.
 *
 * src/config/config.ts derives the variable from the provider name — anthropic
 * becomes ANTHROPIC_API_KEY, the rest are `${NAME}_API_KEY` — so these strings
 * have to match that derivation or the key arrives and is never looked at.
 */
const PROVIDER_KEY_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OLLAMA_API_KEY",
] as const;

/**
 * Whether this deployment serves anyone.
 *
 * Exactly the string "1", for the same reason src/gateway/auth.ts insists on
 * it: a switch that removes authentication must not be flippable by a value
 * that merely looks truthy.
 */
export function isPublic(env: Env): boolean {
  return (env.PUBLIC_ACCESS ?? "").trim() === "1";
}

/**
 * The instance a public request is served by.
 *
 * There is no verified email in public mode, so there is nothing to derive a
 * tenant from — and inventing one from a header would let a caller choose which
 * database to open, which is exactly what tenantKey exists to prevent. One
 * fixed instance is the honest answer: public means one shared console.
 */
const PUBLIC_TENANT = "public";

export class OrionContainer extends Container<Env> {
  defaultPort = 8080;
  // Long enough that a coder stepping away from a worklist does not come back
  // to a cold start and a snapshot restore, short enough that an idle tenant
  // is not billed for a live instance all night.
  sleepAfter = "20m";

  /**
   * The container's environment, built in the constructor rather than declared
   * as a literal — because one of these values is a SECRET and only exists on
   * `env`.
   *
   * ORION_GATEWAY_TOKEN is the entire reason this is not a static object. The
   * origin compares the edge's header against it, and src/gateway/auth.ts is
   * deliberately fail-closed: bound to 0.0.0.0 with no token configured, it
   * refuses EVERY request with a 500.
   *
   * So omitting it does not produce a broken-looking deployment. It produces a
   * deploy that reports success, a /healthz that answers 200 because the probe
   * is deliberately unauthenticated, and a 500 on every actual page — green
   * everywhere a machine looks and dead everywhere a person does. That is the
   * worst failure shape available here, and it is why this is a constructor.
   *
   * The token reaches the container as an environment variable and never as a
   * layer in the image: `wrangler secret put` holds it encrypted, and an image
   * is copied, cached and shared in ways a secret must not be.
   */
  // `ConstructorParameters` rather than spelling the type out: the base takes
  // `DurableObject['ctx']`, and writing `DurableObjectState` here resolves to a
  // different generic instantiation that does not match. Deriving it from the
  // class cannot drift when the library changes it.
  constructor(...args: ConstructorParameters<typeof Container<Env>>) {
    super(...args);
    const env = args[1];
    const providerKeys: Record<string, string> = {};
    for (const name of PROVIDER_KEY_NAMES) {
      const value = env[name];
      // Only the ones actually set. Forwarding "" would be worse than omitting
      // it: resolveProvider treats a present-but-empty key as a configured
      // provider and picks it, then every turn fails against the model instead
      // of the startup saying plainly that no provider is configured.
      if (value) providerKeys[name] = value;
    }

    this.envVars = {
      ORION_HOST: "0.0.0.0",
      ORION_PORT: "8080",
      ORION_HOME: "/data",
      ORION_GATEWAY_TOKEN: env.GATEWAY_TOKEN,
      // Forwarded from the Worker rather than baked into the Dockerfile, so the
      // posture is decided in ONE place. A copy in the image would be a second
      // switch that can disagree with this one, and the failure mode of that
      // disagreement is the origin demanding an identity the edge stopped
      // sending — every page 403, with both files looking correct in isolation.
      ORION_PUBLIC: isPublic(env) ? "1" : "0",
      // The microphone. Off by default in config, which on a hosted deployment
      // meant the voice interface existed and was invisible — no button, no
      // menu entry, nothing saying why.
      //
      // The browser engine is what "on" means here: Chrome sends the captured
      // audio to Google for recognition, and no BAA covers that. It is
      // acceptable ONLY because this deployment refuses PHI (ORION_PHI=blocked)
      // and the seeded data is synthetic. If PHI is ever permitted, this must
      // move to the "local" engine or come back off.
      ORION_SPEECH: env.SPEECH_ENABLED === "0" ? "0" : "1",
      ORION_SPEECH_ENGINE: env.SPEECH_ENGINE || "browser",
      // ── Where the container sends its snapshot ─────────────────────────────
      // Back through this same Worker, which holds the R2 binding a container
      // cannot hold itself. That indirection is also the access control: the
      // container never carries an R2 credential it could leak, only the shared
      // token, which handleSnapshot below checks.
      //
      // Left unset until now because Cloudflare Access sat in front of this
      // hostname and the container had no session, so every callback would have
      // been redirected to a login page. Access is gone, so the path works —
      // and until it did, everything the operator typed into the console
      // (including a provider key) vanished at the next cold start.
      //
      // ONE TENANT ONLY. The snapshot keys are fixed names, so two tenants
      // would share them and overwrite each other. That is safe exactly while
      // PUBLIC_ACCESS is on, because public mode pins every request to a single
      // instance (PUBLIC_TENANT above). Restoring Access — which is what brings
      // back per-domain tenants — means giving each one its own key prefix
      // first, and this comment is the reminder that it is not optional.
      ORION_SNAPSHOT_URL: env.SNAPSHOT_URL || "https://orion.aetheraonline.com",
      ...providerKeys,
    };
  }
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
    const publicMode = isPublic(env);

    let tenant: string;
    let email = "";

    if (publicMode && token === "") {
      // Serve the anonymous caller. This is the deployment saying, on purpose,
      // that this hostname is a public console.
      tenant = PUBLIC_TENANT;
    } else if (token === "") {
      // No Access session and not public. This means the hostname is not
      // actually protected by an Access application — a misconfiguration that
      // would otherwise publish the whole console. Refuse rather than pass it
      // through.
      return new Response("This application requires Cloudflare Access. No access session was presented.", {
        status: 401,
      });
    } else {
      // A token WAS presented, so it is verified — in public mode too.
      //
      // Public mode lowers the bar for entry; it does not make a forged
      // identity acceptable. If it skipped verification here, anyone could set
      // Cf-Access-Jwt-Assertion to unsigned JSON and have the origin write
      // their chosen name into the PHI access log. An unverifiable token is a
      // failed claim, not an anonymous visitor, so it is refused rather than
      // quietly downgraded to public.
      const claims = await verifyAccessJwt(token, env);
      if (!claims) return new Response("Access session could not be verified.", { status: 403 });
      email = claims.email;
      tenant = tenantKey(claims.email);
    }

    const instance = getContainer(env.ORION, tenant);

    // Re-sign the request for the origin. The container trusts the identity
    // headers ONLY when GATEWAY_TOKEN is correct, so this is where a request
    // earns that trust — after the JWT was verified, never before.
    const headers = new Headers(request.headers);
    headers.set("x-aethera-gateway-token", env.GATEWAY_TOKEN);
    // Deleted first, then set only when proven. Without the delete, a client
    // could send its own cf-access-authenticated-user-email and — in public
    // mode, where nothing overwrites it — have the origin trust it, because the
    // origin trusts that header once the shared token is right. The token is
    // set right here, by us, so the header has to be scrubbed here too.
    headers.delete("cf-access-authenticated-user-email");
    if (email !== "") headers.set("cf-access-authenticated-user-email", email);

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
