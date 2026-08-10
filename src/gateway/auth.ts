import { createHash, timingSafeEqual } from "node:crypto";

// ── Who is allowed to talk to the gateway ────────────────────────────────────
// Until this file existed there was no answer to that question. The gateway had
// no authentication of any kind — no hook, no middleware, nothing — and the
// entire security model was one line of config: `gateway: { host: "127.0.0.1" }`.
// server.ts says so itself, next to the routes that accept provider API keys:
// "the routes exist only because the gateway binds 127.0.0.1 — this is a local
// settings screen, not an admin API."
//
// That is a sound model for a laptop and a catastrophic one the moment the
// process is published, because the thing behind those routes is an admin API
// over PHI, a shell tool, a filesystem tool, and a browser holding payer portal
// credentials. So the rule enforced here is not "check a password" but:
//
//   A GATEWAY THAT IS NOT ON LOOPBACK MUST PROVE EVERY REQUEST, OR SERVE NONE.
//
// Fail-closed, and closed by DEFAULT — an operator who exposes the port and
// forgets to configure identity gets a refusal on every route, not an open
// admin API. The failure mode of getting this backwards is not a broken feature,
// it is a data breach, so the safe state is the one you reach by doing nothing.

/**
 * Whether the bound address is reachable only from this machine.
 *
 * IPv4 loopback is the whole 127/8 block, not just 127.0.0.1 — 127.0.0.53 is an
 * ordinary systemd-resolved address and is no less local. IPv6 loopback is ::1,
 * which also arrives as the IPv4-mapped ::ffff:127.0.0.1 on dual-stack sockets.
 *
 * Everything else is treated as exposed, INCLUDING private LAN ranges. A gateway
 * on 192.168.1.10 is reachable by every device on the office wifi and by anything
 * that gets onto it; "inside the network" has not been a security boundary for a
 * long time, and PHI is exactly the thing that should not rely on it.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost") return true;
  if (h === "::1" || h === "::ffff:127.0.0.1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h.replace(/^::ffff:/, ""));
  if (v4) return Number(v4[1]) === 127;
  return false;
}

export type Exposure = "loopback" | "exposed";

export function classifyBind(host: string): Exposure {
  return isLoopbackHost(host) ? "loopback" : "exposed";
}

/** Who the request is from, once it has been proven. */
export interface Identity {
  /** Verified email from the identity proxy, or "" for a local operator. */
  email: string;
  /** Stable subject id from the identity proxy, or "" for a local operator. */
  subject: string;
  /** How the claim was established. Recorded so an audit row can say. */
  /**
   * How the claim was established.
   *
   * "public" is not a weaker "access" — it means no identity was established
   * at all, and anything that records an actor must say so rather than leave a
   * blank that reads like a missing field.
   */
  via: "loopback" | "access" | "public";
}

export interface AuthDecision {
  ok: boolean;
  identity?: Identity;
  /** HTTP status to send when `ok` is false. */
  status: 401 | 403 | 500 | 200;
  /**
   * Why, in a sentence an operator can act on. Sent to the client only when it
   * is a configuration fault (500) — an unauthenticated caller is told nothing
   * about how the door is locked.
   */
  why: string;
}

/** Header the edge Worker sets, carrying the shared secret. */
export const GATEWAY_TOKEN_HEADER = "x-aethera-gateway-token";
/** Headers Cloudflare Access sets once it has verified a session. */
export const ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email";
export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Both sides are hashed to a fixed 32 bytes first. `timingSafeEqual` THROWS on
 * a length mismatch, so comparing raw strings would answer "is the length
 * right?" via an exception before it ever compared a byte — which is the exact
 * side channel the function exists to close.
 */
function secretsMatch(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface AuthInput {
  exposure: Exposure;
  /** Lower-cased request headers. */
  headers: Record<string, string | string[] | undefined>;
  /**
   * The shared secret the edge is expected to present, from the environment.
   * Empty means none is configured — which is fine on loopback and fatal off it.
   */
  expectedToken: string;
  /**
   * Serve anyone who reaches the edge, with no identity at all.
   *
   * OFF unless explicitly turned on, and it is a decision rather than a
   * convenience: with this set there is no authentication in front of the
   * console, its admin API, the claims database, the shell tool, the
   * filesystem tool, or the browser holding payer portal credentials. Anyone
   * who learns the hostname has all of it.
   *
   * It exists because a fully public demo is a legitimate thing to want, and
   * because the alternative — people commenting out the identity check when
   * they want one — produces the same exposure with nothing naming it. Here it
   * has a name, it is off by default, it is reported at startup, and the tests
   * below state exactly what it gives away.
   *
   * The shared secret is still required even in this mode. It costs a public
   * visitor nothing (the edge presents it, not the browser) and it keeps the
   * container from being addressable by anything other than our own Worker.
   */
  publicAccess?: boolean;
}

function header(headers: AuthInput["headers"], name: string): string {
  const v = headers[name];
  // A repeated header arrives as an array. Taking the first would let an
  // attacker append a second copy of a header the edge already set and hope
  // something downstream reads the other one; refusing the ambiguity is safer
  // than picking a side.
  if (Array.isArray(v)) return "";
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Decide whether one request may be served.
 *
 * Pure, so the rule can be tested without a socket — the same reason every
 * other rule in this codebase lives in a function rather than in a handler.
 *
 * The identity headers are trusted ONLY when the shared secret is present and
 * correct. This is the difference between an authentication check and a
 * decoration: `Cf-Access-Authenticated-User-Email` is a header like any other,
 * and anything that can reach the origin directly can set it to whatever it
 * likes. The secret is what proves the request came through the edge that
 * verified the Access session, so the email is worth reading only after it
 * matches. Reversing that order is the single most common way an Access-fronted
 * origin ends up wide open.
 */
export function authorizeRequest(input: AuthInput): AuthDecision {
  const { exposure, headers, expectedToken } = input;

  if (exposure === "loopback") {
    // Unchanged local behaviour: a gateway only this machine can reach is
    // already authenticated by the operating system. Making a developer
    // configure Access to use their own laptop would get the whole mechanism
    // disabled, and a disabled control protects nothing.
    return { ok: true, identity: { email: "", subject: "", via: "loopback" }, status: 200, why: "" };
  }

  if (expectedToken === "") {
    // Exposed with nothing configured. This is the fail-closed case and the
    // reason this module is written the way it is: the operator gets a locked
    // door and an instruction, not an open admin API.
    return {
      ok: false,
      status: 500,
      why:
        "This gateway is bound to a non-loopback address but ORION_GATEWAY_TOKEN is not set, " +
        "so no request can be authenticated and every request is refused. Set that secret to the same " +
        "value the edge Worker sends, and put Cloudflare Access in front of the hostname.",
    };
  }

  const presented = header(headers, GATEWAY_TOKEN_HEADER);
  if (presented === "" || !secretsMatch(presented, expectedToken)) {
    // Deliberately says nothing about which of the two failed.
    return { ok: false, status: 401, why: "" };
  }

  const email = header(headers, ACCESS_EMAIL_HEADER);
  const jwt = header(headers, ACCESS_JWT_HEADER);

  if (input.publicAccess) {
    // No identity is demanded and none is invented. `via: "public"` is carried
    // through to the PHI access log so those rows say plainly that nobody was
    // identified, rather than attributing the read to a name that was never
    // established. An access review that cannot tell "anonymous" from "a
    // person" is worse than one that reports the truth.
    //
    // A verified email is still preferred if one somehow arrives, so turning
    // Access back on does not require touching this file again.
    return {
      ok: true,
      identity: email === "" ? { email: "", subject: "", via: "public" } : { email, subject: email, via: "access" },
      status: 200,
      why: "",
    };
  }

  if (email === "" || jwt === "") {
    // The edge proved itself but forwarded no identity. That is a misconfigured
    // Access application, not an anonymous user, and it must not be served as
    // one: every PHI access row would be attributed to nobody.
    return { ok: false, status: 403, why: "" };
  }

  return {
    ok: true,
    // The JWT is not decoded here. The edge verified its signature against the
    // team's public keys before it ever forwarded the request; re-parsing it
    // in the origin without re-verifying would be theatre, and verifying it
    // twice is work the edge already did. The subject is derived from the
    // email so PHI rows have a stable actor either way.
    identity: { email, subject: email, via: "access" },
    status: 200,
    why: "",
  };
}

/**
 * Whether the deployment asked to be served to anyone.
 *
 * Pure and exactly one accepted value: the string "1". Not "true", not "yes",
 * not "any non-empty string" — a switch that turns off authentication should
 * not be flippable by a typo like `ORION_PUBLIC=0"` or an accidental `false`,
 * both of which are truthy under the usual loose reading.
 */
export function isPublicAccess(raw: string | undefined): boolean {
  return (raw ?? "").trim() === "1";
}

/**
 * The name to record against a PHI access, given the proven identity.
 *
 * Three outcomes, and the middle one is the point:
 *
 *   a verified email  → the person
 *   public, no email  → "anonymous", said out loud
 *   loopback          → "", so the store keeps its existing fallback
 *
 * Writing "" for a public visitor would let the store attribute the access to
 * the agent, which is the one answer that is actively false: a real human read
 * a real chart and the log would name a program. An access review can act on
 * "anonymous"; it cannot act on a wrong name.
 */
export function actorFor(identity: Identity | undefined): string {
  if (!identity) return "";
  if (identity.email !== "") return identity.email;
  return identity.via === "public" ? "anonymous" : "";
}

/**
 * Routes that stay open when everything else is locked.
 *
 * Only the health probe. Cloudflare needs to reach it to know the container is
 * alive, and it must answer before any identity exists. It returns no data
 * about the installation.
 */
export function isUnauthenticatedPath(path: string): boolean {
  const p = path.split("?")[0];
  return p === "/healthz";
}
