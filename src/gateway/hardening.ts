import { detectPhi } from "../compliance/phi-detect.js";

// ── Rate limiting, headers, and what a metric may say ────────────────────────
//
// The closing sweep. Everything here is pure: decisions in, no I/O, so the
// limiter's behaviour under a burst can be asserted at a literal millisecond
// rather than by sleeping.

// ── Rate limiting ───────────────────────────────────────────────────────────
//
// A token bucket, not a fixed window. A fixed window lets a caller spend the
// whole budget in the last second of one window and the whole budget again in
// the first second of the next — twice the intended rate, at the worst possible
// moment, and it looks compliant in the counters.
//
// WHAT IS AND IS NOT LIMITED. Reads of the console's own assets and /healthz are
// not: rate-limiting a health check makes a monitoring system look like an
// attack, and throttling app.js makes the product feel broken under exactly the
// load where it needs to feel solid. What is limited is the expensive and the
// abusable — starting turns, uploading documents, writing credentials.
//
// The limit is PER IDENTITY where there is one and per address otherwise. Per
// address alone would let one authenticated user behind a NAT exhaust the
// budget for a whole practice.

export interface Bucket {
  /** Tokens remaining, fractional between refills. */
  tokens: number;
  /** When the bucket was last topped up. */
  updatedAt: number;
}

export interface RateLimit {
  /** Sustained requests per minute. */
  perMinute: number;
  /** How much of the budget one caller may spend at once. */
  burst: number;
}

export interface LimitDecision {
  allowed: boolean;
  bucket: Bucket;
  /** Seconds to wait, for a Retry-After header. Zero when allowed. */
  retryAfterSeconds: number;
  reason: string;
}

/** Cost per request class. A turn is not the same size of ask as a session list. */
export const REQUEST_COST: Record<string, number> = {
  turn: 5,
  upload: 10,
  write: 3,
  read: 1,
};

export const DEFAULT_LIMIT: RateLimit = { perMinute: 120, burst: 60 };

export function newBucket(limit: RateLimit, now: number): Bucket {
  return { tokens: limit.burst, updatedAt: now };
}

/**
 * Spend `cost` from the bucket, refilling for elapsed time first.
 *
 * Returns the new bucket rather than mutating, so the caller decides whether a
 * refused request also consumed anything. It does not: a refusal costs nothing,
 * or a caller retrying in a tight loop would hold itself out indefinitely and
 * never recover even after slowing down.
 */
export function spend(bucket: Bucket, limit: RateLimit, cost: number, now: number): LimitDecision {
  const elapsedMinutes = Math.max(0, now - bucket.updatedAt) / 60_000;
  const tokens = Math.min(limit.burst, bucket.tokens + elapsedMinutes * limit.perMinute);

  if (tokens >= cost) {
    return {
      allowed: true,
      bucket: { tokens: tokens - cost, updatedAt: now },
      retryAfterSeconds: 0,
      reason: "",
    };
  }
  const deficit = cost - tokens;
  const seconds = Math.ceil((deficit / limit.perMinute) * 60);
  return {
    allowed: false,
    // Refilled but not spent. See above.
    bucket: { tokens, updatedAt: now },
    retryAfterSeconds: Math.max(1, seconds),
    reason: `Rate limit: ${limit.perMinute} requests/minute with a burst of ${limit.burst}. Retry in ${seconds}s.`,
  };
}

/** Which cost class a path falls into. Unknown paths are reads — the cheapest, so a new route is never accidentally throttled hard. */
/**
 * The console's WebSocket endpoint.
 *
 * Charged, but NOT here — see costOf below and the /ws handler in server.ts.
 */
export const WS_PATH = "/ws";

export function costOf(method: string, url: string): number {
  const path = url.split("?")[0];
  if (path === "/healthz" || path === "/metrics") return 0;
  // ── The upgrade is limited somewhere the client can hear it ───────────────
  // Refusing an upgrade with 429 is a limit stated in a language the browser
  // throws away: the WebSocket API surfaces a failed handshake as a bare error
  // event with no status and no Retry-After, so a throttled tab is
  // indistinguishable from a broken server. It reconnects immediately, which is
  // the behaviour the limit exists to prevent.
  //
  // Zero here means the /ws handler charges the same bucket itself and answers
  // a refusal by ACCEPTING the socket and closing it with 1013 "try again
  // later" — the code a browser client backs off on, and the same mechanism the
  // socket cap already uses. The limit is unchanged; only its audibility is.
  if (path === WS_PATH) return 0;
  if (/\.(js|css|svg|html|png|ico|woff2?)$/.test(path)) return 0;
  if (path.startsWith("/api/upload")) return REQUEST_COST.upload;
  if (method === "POST" && /\/api\/sessions\/[^/]+\/(messages|turn)/.test(path)) return REQUEST_COST.turn;
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) return REQUEST_COST.write;
  return REQUEST_COST.read;
}

// ── Response headers ────────────────────────────────────────────────────────

/**
 * The Content-Security Policy for the console.
 *
 * `'unsafe-inline'` is present for styles and NOT for scripts, and the asymmetry
 * is the point. index.html carries inline `style` attributes on generated rows;
 * removing them is a refactor, and an inline style cannot exfiltrate anything.
 * An inline SCRIPT can, so script-src stays strict — which is what actually
 * limits the damage of an injected string reaching the DOM.
 *
 * connect-src includes ws: and wss: because the console's whole function is a
 * WebSocket. It is scoped to 'self', so a page tricked into opening a socket
 * cannot open one to somebody else's server.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  // The console never embeds anything and must never be embedded — clickjacking
  // an approval dialog is a real attack against a system with an approval gate.
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export function securityHeaders(exposure: "loopback" | "exposed"): Record<string, string> {
  const headers: Record<string, string> = {
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    // No camera or microphone by default. The voice console asks for the
    // microphone explicitly, and this is overridden for that route rather than
    // left open everywhere.
    "permissions-policy": "camera=(), geolocation=(), payment=()",
  };
  if (exposure === "exposed") {
    // HSTS only off loopback. On http://127.0.0.1 it would pin the whole of
    // localhost to HTTPS in the developer's browser, breaking every other local
    // service they run — a genuinely nasty thing to do from a health-care tool.
    headers["strict-transport-security"] = "max-age=15552000; includeSubDomains";
  }
  return headers;
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export interface MetricSample {
  name: string;
  value: number;
  help: string;
  type: "counter" | "gauge";
  labels?: Record<string, string>;
}

/**
 * Render Prometheus text format.
 *
 * THE RULE FOR THIS ENDPOINT: a metric is a COUNT or a DURATION, never an
 * identifier. No claim number, no member id, no session id, no filename, no
 * payer-specific label that could be joined back to a patient. A metrics
 * endpoint is scraped by systems with a different retention policy and a
 * different access list from the database, and it is the easiest place in a
 * product to leak PHI without anybody noticing — a label is just a string, and
 * `claim_id="CLM-1042"` looks perfectly ordinary in a dashboard.
 *
 * Label values are checked here rather than trusted, because the check has to
 * survive somebody adding a metric in a hurry.
 */
function identifierShaped(value: string): boolean {
  // The canonical PHI patterns rather than a second set invented here. A second
  // set drifts from the first, and the one that drifts is always the one nobody
  // is looking at — which would be this one.
  if (detectPhi(value).length > 0) return true;
  // Plus the shapes that are not PHI on sight but are still identifiers, and a
  // metric has no business carrying either: a claim or account number, and
  // anything with an @ in it.
  return /\b[0-9A-Z]{2,}-\d{3,}\b/.test(value) || value.includes("@");
}

export function renderMetrics(samples: MetricSample[]): string {
  const lines: string[] = [];
  for (const s of samples) {
    const labels = Object.entries(s.labels ?? {}).filter(([, v]) => {
      // Dropped, not rendered with a warning: a warning in a metrics response is
      // itself a line a scraper stores.
      return !identifierShaped(v);
    });
    const labelText = labels.length > 0 ? `{${labels.map(([k, v]) => `${k}="${v.replace(/"/g, "")}"`).join(",")}}` : "";
    lines.push(`# HELP ${s.name} ${s.help}`);
    lines.push(`# TYPE ${s.name} ${s.type}`);
    lines.push(`${s.name}${labelText} ${s.value}`);
  }
  return lines.join("\n") + "\n";
}

/** True when a label value would be dropped. Exported so a test can assert the rule rather than the rendering. */
export function looksLikeIdentifier(value: string): boolean {
  return identifierShaped(value);
}

// ── Who is being limited ─────────────────────────────────────────────────────
//
// FOUND IN PRODUCTION, not in a test. The limiter was verified against
// 127.0.0.1, where `req.ip` IS the caller, and reported as working. Behind
// Cloudflare it is not: 25 rapid session-creates all returned 200 and
// orion_rate_limited_total stayed at 0, because `req.ip` was the edge rather
// than the client and the buckets did not correspond to callers at all.
//
// THE TRAP IN THE OBVIOUS FIX. Reading `x-forwarded-for` unconditionally is
// WORSE than the bug: a client can set that header itself, so a caller who
// wants past the limit sends a different value every request and gets a fresh
// bucket each time. That converts an accidentally ineffective limiter into one
// that is trivially and deliberately defeated.
//
// So a forwarded header is trusted ONLY when the deployment says it sits behind
// an edge that overwrites it. Cloudflare sets `cf-connecting-ip` and strips any
// client-supplied copy, which is what makes it trustworthy — and only there.
//
// The default is NOT to trust, and the failure direction is deliberate: an
// untrusted deployment behind a proxy puts every caller in one bucket, which is
// too strict rather than too loose. Refusing too much is visible in a minute;
// refusing nothing is invisible for a month, which is exactly what happened.

export interface KeyInput {
  /** From authorizeRequest, when the caller has an identity. The best signal there is. */
  identity?: string;
  headers: Record<string, string | string[] | undefined>;
  /** Fastify's socket peer. Behind a proxy this is the proxy. */
  socketIp?: string;
  /**
   * Whether a forwarded-for header may be believed.
   *
   * True ONLY when something in front overwrites it. See above — this is the
   * difference between a working limiter and an evadable one.
   */
  trustForwardedFor: boolean;
}

function firstHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return (value[0] ?? "").trim();
  return (value ?? "").trim();
}

/**
 * The bucket key for one request.
 *
 * Identity first where there is one: a signed-in caller is the same caller from
 * two addresses, and limiting them per-address would let one person spend the
 * budget several times over.
 */
export function rateLimitKey(input: KeyInput): string {
  const identity = (input.identity ?? "").trim();
  if (identity !== "") return `id:${identity}`;

  if (input.trustForwardedFor) {
    // Cloudflare's header first — it is a single address and cannot be
    // client-supplied through the edge. x-forwarded-for is the fallback and its
    // FIRST hop is the original client; later hops are proxies.
    const cf = firstHeader(input.headers["cf-connecting-ip"]);
    if (cf !== "") return `ip:${cf}`;
    const xff = firstHeader(input.headers["x-forwarded-for"]).split(",")[0].trim();
    if (xff !== "") return `ip:${xff}`;
    // Trusted but absent. Falling through to the socket rather than inventing a
    // key: an empty header is not an identity, and treating it as one would give
    // every header-less request its own budget.
  }

  const socket = (input.socketIp ?? "").trim();
  return socket !== "" ? `ip:${socket}` : "anonymous";
}

/**
 * Should this deployment believe a forwarded-for header?
 *
 * Explicit opt-in via ORION_TRUST_PROXY, and additionally inferred when the
 * request carries `cf-connecting-ip` AND the deployment is exposed — because
 * that header is set by Cloudflare and stripped from client input, so its
 * presence on an exposed deployment means the edge is in front.
 *
 * The inference is deliberately narrow. It does NOT extend to x-forwarded-for,
 * which anyone can send.
 */
export function shouldTrustForwardedFor(
  explicit: string,
  exposure: "loopback" | "exposed",
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const flag = explicit.trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  if (flag === "0" || flag === "false" || flag === "no") return false;
  return exposure === "exposed" && firstHeader(headers["cf-connecting-ip"]) !== "";
}
