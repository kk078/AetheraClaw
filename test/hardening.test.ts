import { describe, expect, it } from "vitest";
import {
  CSP,
  DEFAULT_LIMIT,
  REQUEST_COST,
  costOf,
  looksLikeIdentifier,
  newBucket,
  rateLimitKey,
  renderMetrics,
  shouldTrustForwardedFor,
  securityHeaders,
  spend,
} from "../src/gateway/hardening.js";

const T0 = 1_800_000_000_000;

describe("the token bucket", () => {
  it("allows a burst and then refuses", () => {
    let b = newBucket(DEFAULT_LIMIT, T0);
    let refusals = 0;
    for (let i = 0; i < 20; i++) {
      const d = spend(b, DEFAULT_LIMIT, REQUEST_COST.turn, T0);
      b = d.bucket;
      if (!d.allowed) refusals++;
    }
    // 60 burst tokens at 5 per turn is 12 turns, then it holds.
    expect(refusals).toBe(8);
  });

  it("refills over time rather than resetting on a window boundary", () => {
    // A fixed window lets a caller spend the whole budget in its last second
    // and the whole budget again in the next window's first — twice the rate,
    // and it looks compliant in the counters.
    let b = newBucket(DEFAULT_LIMIT, T0);
    for (let i = 0; i < 12; i++) b = spend(b, DEFAULT_LIMIT, REQUEST_COST.turn, T0).bucket;
    expect(spend(b, DEFAULT_LIMIT, REQUEST_COST.turn, T0).allowed).toBe(false);
    // 30 seconds is 60 tokens back at 120/min, capped at the burst.
    expect(spend(b, DEFAULT_LIMIT, REQUEST_COST.turn, T0 + 30_000).allowed).toBe(true);
  });

  it("never refills past the burst ceiling", () => {
    const idle = spend(newBucket(DEFAULT_LIMIT, T0), DEFAULT_LIMIT, 1, T0 + 86_400_000);
    expect(idle.bucket.tokens).toBeLessThanOrEqual(DEFAULT_LIMIT.burst);
  });

  it("charges NOTHING for a refusal", () => {
    // Otherwise a caller retrying in a tight loop holds itself out
    // indefinitely and never recovers even after it slows down.
    let b = newBucket(DEFAULT_LIMIT, T0);
    for (let i = 0; i < 12; i++) b = spend(b, DEFAULT_LIMIT, REQUEST_COST.turn, T0).bucket;
    const before = spend(b, DEFAULT_LIMIT, REQUEST_COST.turn, T0);
    const after = spend(before.bucket, DEFAULT_LIMIT, REQUEST_COST.turn, T0);
    expect(before.allowed).toBe(false);
    expect(after.bucket.tokens).toBe(before.bucket.tokens);
  });

  it("tells the caller how long to wait", () => {
    let b = newBucket(DEFAULT_LIMIT, T0);
    for (let i = 0; i < 12; i++) b = spend(b, DEFAULT_LIMIT, REQUEST_COST.turn, T0).bucket;
    const d = spend(b, DEFAULT_LIMIT, REQUEST_COST.turn, T0);
    expect(d.retryAfterSeconds).toBeGreaterThan(0);
    expect(d.reason).toMatch(/Retry in/);
  });
});

describe("what gets limited", () => {
  it("charges nothing for health checks or static assets", () => {
    // Rate-limiting a health check makes a monitoring system look like an
    // attack; throttling app.js makes the product feel broken under exactly
    // the load where it needs to feel solid.
    expect(costOf("GET", "/healthz")).toBe(0);
    expect(costOf("GET", "/metrics")).toBe(0);
    expect(costOf("GET", "/app.js")).toBe(0);
    expect(costOf("GET", "/style.css?v=2")).toBe(0);
  });

  it("charges most for an upload and a turn", () => {
    expect(costOf("POST", "/api/upload?session=abc")).toBe(REQUEST_COST.upload);
    expect(costOf("POST", "/api/sessions/s1/messages")).toBe(REQUEST_COST.turn);
    expect(costOf("POST", "/api/providers/anthropic")).toBe(REQUEST_COST.write);
  });

  it("treats an unknown route as the cheapest class", () => {
    // A new route must never be accidentally throttled hard by a rule nobody
    // remembered to update.
    expect(costOf("GET", "/api/something-new")).toBe(REQUEST_COST.read);
  });
});

describe("security headers", () => {
  it("forbids inline SCRIPT while allowing inline style", () => {
    // The asymmetry is the point: an inline style cannot exfiltrate anything,
    // an inline script can, and script-src is what limits the damage of an
    // injected string reaching the DOM.
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(CSP).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("allows the WebSocket the console is built on, scoped to self", () => {
    expect(CSP).toContain("connect-src 'self' ws: wss:");
  });

  it("refuses to be framed", () => {
    // Clickjacking an approval dialog is a real attack against a system whose
    // safety rests on an approval gate.
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(securityHeaders("loopback")["x-frame-options"]).toBe("DENY");
  });

  it("sets HSTS off loopback and NEVER on it", () => {
    // On http://127.0.0.1 it would pin the whole of localhost to HTTPS in the
    // developer's browser and break every other local service they run.
    expect(securityHeaders("loopback")["strict-transport-security"]).toBeUndefined();
    expect(securityHeaders("exposed")["strict-transport-security"]).toContain("max-age");
  });

  it("denies camera and geolocation by default", () => {
    expect(securityHeaders("loopback")["permissions-policy"]).toContain("camera=()");
  });
});

describe("metrics, and the PHI rule for them", () => {
  it("renders Prometheus text", () => {
    const out = renderMetrics([{ name: "orion_up", value: 1, help: "Serving.", type: "gauge" }]);
    expect(out).toContain("# TYPE orion_up gauge");
    expect(out).toContain("orion_up 1");
  });

  it("DROPS an identifier-shaped label rather than exporting it", () => {
    // A metrics endpoint is scraped by systems with a different retention
    // policy and access list from the database. claim_id="CLM-1042" looks
    // perfectly ordinary in a dashboard, which is what makes it dangerous.
    const out = renderMetrics([
      { name: "x", value: 1, help: "h", type: "gauge", labels: { claim: "CLM-1042", stage: "coding" } },
    ]);
    expect(out).not.toContain("CLM-1042");
    expect(out).toContain('stage="coding"');
  });

  it("recognises the shapes worth refusing", () => {
    expect(looksLikeIdentifier("123-45-6789")).toBe(true);
    expect(looksLikeIdentifier("CLM-1042")).toBe(true);
    expect(looksLikeIdentifier("1EG4TE5MK73")).toBe(true);
    expect(looksLikeIdentifier("a@b.com")).toBe(true);
    // Ordinary dimensions must survive, or the rule gets removed as useless.
    expect(looksLikeIdentifier("coding")).toBe(false);
    expect(looksLikeIdentifier("anthropic")).toBe(false);
    expect(looksLikeIdentifier("sandbox")).toBe(false);
  });

  it("drops the label without announcing it in the response", () => {
    // A warning line in a metrics body is itself a line a scraper stores.
    const out = renderMetrics([{ name: "x", value: 1, help: "h", type: "gauge", labels: { c: "CLM-9999" } }]);
    expect(out).not.toMatch(/dropped|redact|warn/i);
  });
});

// ── The bug this section exists for ─────────────────────────────────────────
// The limiter was verified against 127.0.0.1, where req.ip IS the caller, and
// reported as working. In production behind Cloudflare it refused nothing: 25
// rapid writes all returned 200 and orion_rate_limited_total stayed at 0.
// These tests are written against the deployment shape rather than the local
// one, which is what the earlier verification failed to do.

describe("the rate-limit key", () => {
  const cf = (ip: string) => ({ "cf-connecting-ip": ip });

  it("uses the identity when there is one", () => {
    // A signed-in caller is the same caller from two addresses; limiting per
    // address would let one person spend the budget several times over.
    const key = rateLimitKey({ identity: "kim", headers: cf("1.1.1.1"), socketIp: "10.0.0.1", trustForwardedFor: true });
    expect(key).toBe("id:kim");
  });

  it("distinguishes callers behind a trusted edge", () => {
    // The actual production bug: without this, every caller shared the edge's
    // address and nothing ever accumulated.
    const a = rateLimitKey({ headers: cf("203.0.113.7"), socketIp: "10.0.0.1", trustForwardedFor: true });
    const b = rateLimitKey({ headers: cf("203.0.113.8"), socketIp: "10.0.0.1", trustForwardedFor: true });
    expect(a).not.toBe(b);
  });

  it("IGNORES a forwarded header when the deployment does not trust one", () => {
    // The trap in the obvious fix. Reading x-forwarded-for unconditionally is
    // WORSE than the bug: a caller sends a different value every request and
    // gets a fresh bucket each time, turning an ineffective limiter into an
    // evadable one.
    const spoofed = rateLimitKey({
      headers: { "x-forwarded-for": "9.9.9.9" },
      socketIp: "10.0.0.1",
      trustForwardedFor: false,
    });
    const other = rateLimitKey({
      headers: { "x-forwarded-for": "9.9.9.10" },
      socketIp: "10.0.0.1",
      trustForwardedFor: false,
    });
    expect(spoofed).toBe(other);
    expect(spoofed).toBe("ip:10.0.0.1");
  });

  it("takes the FIRST x-forwarded-for hop, which is the client", () => {
    const key = rateLimitKey({
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.5, 10.0.0.6" },
      socketIp: "10.0.0.1",
      trustForwardedFor: true,
    });
    expect(key).toBe("ip:203.0.113.7");
  });

  it("prefers cf-connecting-ip over x-forwarded-for", () => {
    // Cloudflare's header is a single address and cannot be client-supplied
    // through the edge; x-forwarded-for can carry anything the client prepended.
    const key = rateLimitKey({
      headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "9.9.9.9" },
      socketIp: "10.0.0.1",
      trustForwardedFor: true,
    });
    expect(key).toBe("ip:203.0.113.7");
  });

  it("falls back to the socket when a trusted header is absent", () => {
    // An empty header is not an identity. Treating it as one would give every
    // header-less request its own budget — the original bug, reintroduced.
    expect(rateLimitKey({ headers: {}, socketIp: "10.0.0.1", trustForwardedFor: true })).toBe("ip:10.0.0.1");
  });

  it("never returns an empty key", () => {
    expect(rateLimitKey({ headers: {}, trustForwardedFor: false })).toBe("anonymous");
  });
});

describe("deciding whether to trust a forwarded header", () => {
  it("obeys an explicit setting either way", () => {
    expect(shouldTrustForwardedFor("true", "loopback", {})).toBe(true);
    expect(shouldTrustForwardedFor("false", "exposed", { "cf-connecting-ip": "1.1.1.1" })).toBe(false);
  });

  it("infers trust from cf-connecting-ip on an EXPOSED deployment", () => {
    expect(shouldTrustForwardedFor("", "exposed", { "cf-connecting-ip": "203.0.113.7" })).toBe(true);
  });

  it("does NOT infer trust from x-forwarded-for, which anyone can send", () => {
    // The whole inference rests on the header being one the edge overwrites.
    expect(shouldTrustForwardedFor("", "exposed", { "x-forwarded-for": "9.9.9.9" })).toBe(false);
  });

  it("does not trust anything on loopback by default", () => {
    expect(shouldTrustForwardedFor("", "loopback", { "cf-connecting-ip": "1.1.1.1" })).toBe(false);
  });
});
