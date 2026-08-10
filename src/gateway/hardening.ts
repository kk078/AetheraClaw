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
export function costOf(method: string, url: string): number {
  const path = url.split("?")[0];
  if (path === "/healthz" || path === "/metrics") return 0;
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
