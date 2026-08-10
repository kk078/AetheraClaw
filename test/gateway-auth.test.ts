import { describe, expect, it } from "vitest";
import {
  ACCESS_EMAIL_HEADER,
  ACCESS_JWT_HEADER,
  GATEWAY_TOKEN_HEADER,
  authorizeRequest,
  classifyBind,
  isLoopbackHost,
  isUnauthenticatedPath,
} from "../src/gateway/auth.js";

// This module is the only thing standing between a published hostname and an
// admin API over PHI, a shell tool and a browser holding payer credentials.
// Every test here is a specific way in.

const TOKEN = "s3cret-edge-token-value";

describe("isLoopbackHost", () => {
  it("accepts the whole 127/8 block, not just 127.0.0.1", () => {
    // 127.0.0.53 is systemd-resolved's ordinary address and is no less local.
    for (const h of ["127.0.0.1", "127.0.0.53", "127.1.2.3"]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });

  it("accepts IPv6 loopback in the forms a dual-stack socket produces", () => {
    for (const h of ["::1", "[::1]", "::ffff:127.0.0.1", "localhost", "LOCALHOST"]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });

  it("treats PRIVATE LAN addresses as exposed", () => {
    // The failure this prevents: "it's only on the office network" as a
    // security boundary. Every device on that wifi can reach the console, and
    // the console has no password.
    for (const h of ["192.168.1.10", "10.0.0.5", "172.16.4.1", "0.0.0.0", "::"]) {
      expect(isLoopbackHost(h), h).toBe(false);
      expect(classifyBind(h)).toBe("exposed");
    }
  });

  it("does not accept a hostname that merely starts with 127", () => {
    expect(isLoopbackHost("127.example.com")).toBe(false);
    expect(isLoopbackHost("1270.0.0.1")).toBe(false);
  });
});

describe("authorizeRequest on loopback", () => {
  it("serves a local operator with no configuration at all", () => {
    // Local use must stay exactly as it was. A control that makes developers
    // configure Access to use their own laptop is a control that gets disabled.
    const d = authorizeRequest({ exposure: "loopback", headers: {}, expectedToken: "" });
    expect(d.ok).toBe(true);
    expect(d.identity?.via).toBe("loopback");
  });
});

describe("authorizeRequest when exposed", () => {
  it("REFUSES EVERYTHING when no token is configured", () => {
    // The fail-closed case, and the reason the module exists. An operator who
    // publishes the port and forgets the secret gets a locked door, not an open
    // admin API.
    const d = authorizeRequest({ exposure: "exposed", headers: {}, expectedToken: "" });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(500);
    expect(d.why).toMatch(/AETHERACLAW_GATEWAY_TOKEN/);
  });

  it("refuses a request with no edge token", () => {
    const d = authorizeRequest({
      exposure: "exposed",
      headers: { [ACCESS_EMAIL_HEADER]: "coder@clinic.example", [ACCESS_JWT_HEADER]: "eyJ..." },
      expectedToken: TOKEN,
    });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(401);
  });

  it("REFUSES IDENTITY HEADERS THAT ARRIVE WITHOUT THE EDGE TOKEN", () => {
    // The single most important test in this file. Cf-Access-* headers are just
    // headers; anything that can reach the origin can set them. Trusting the
    // email before proving the request came through the edge is how an
    // Access-fronted origin ends up wide open while everyone believes it is
    // protected.
    const forged = authorizeRequest({
      exposure: "exposed",
      headers: {
        [ACCESS_EMAIL_HEADER]: "attacker@evil.example",
        [ACCESS_JWT_HEADER]: "forged",
      },
      expectedToken: TOKEN,
    });
    expect(forged.ok).toBe(false);
    expect(forged.identity).toBeUndefined();
  });

  it("refuses a WRONG edge token", () => {
    const d = authorizeRequest({
      exposure: "exposed",
      headers: {
        [GATEWAY_TOKEN_HEADER]: "not-the-token",
        [ACCESS_EMAIL_HEADER]: "coder@clinic.example",
        [ACCESS_JWT_HEADER]: "eyJ...",
      },
      expectedToken: TOKEN,
    });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(401);
  });

  it("refuses a token of a DIFFERENT LENGTH without throwing", () => {
    // timingSafeEqual throws on unequal lengths. Hashing both sides first is
    // what stops that exception becoming a length oracle — and stops a wrong
    // token crashing the request handler instead of being refused.
    expect(() =>
      authorizeRequest({
        exposure: "exposed",
        headers: { [GATEWAY_TOKEN_HEADER]: "x" },
        expectedToken: TOKEN,
      }),
    ).not.toThrow();
  });

  it("refuses a correct token that carries NO identity", () => {
    // A proven edge that forwarded nobody is a misconfigured Access
    // application, not an anonymous user. Serving it would attribute every PHI
    // access row to no one.
    const d = authorizeRequest({
      exposure: "exposed",
      headers: { [GATEWAY_TOKEN_HEADER]: TOKEN },
      expectedToken: TOKEN,
    });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(403);
  });

  it("refuses a DUPLICATED header rather than picking one", () => {
    // Appending a second copy of a header the edge already set, hoping the
    // origin reads the other one, is a real request-smuggling shape.
    const d = authorizeRequest({
      exposure: "exposed",
      headers: {
        [GATEWAY_TOKEN_HEADER]: [TOKEN, "attacker"],
        [ACCESS_EMAIL_HEADER]: "coder@clinic.example",
        [ACCESS_JWT_HEADER]: "eyJ...",
      },
      expectedToken: TOKEN,
    });
    expect(d.ok).toBe(false);
  });

  it("serves a properly proven request and names the person", () => {
    const d = authorizeRequest({
      exposure: "exposed",
      headers: {
        [GATEWAY_TOKEN_HEADER]: TOKEN,
        [ACCESS_EMAIL_HEADER]: "coder@clinic.example",
        [ACCESS_JWT_HEADER]: "eyJhbGciOiJSUzI1NiJ9.x.y",
      },
      expectedToken: TOKEN,
    });
    expect(d.ok).toBe(true);
    expect(d.identity).toEqual({
      email: "coder@clinic.example",
      subject: "coder@clinic.example",
      via: "access",
    });
  });

  it("tells an unauthenticated caller nothing about why", () => {
    // 401/403 carry no `why`. Only the operator's own misconfiguration (500)
    // explains itself, because that message is the deployment talking to its
    // owner rather than to a stranger.
    for (const headers of [{}, { [GATEWAY_TOKEN_HEADER]: "wrong" }, { [GATEWAY_TOKEN_HEADER]: TOKEN }]) {
      const d = authorizeRequest({ exposure: "exposed", headers, expectedToken: TOKEN });
      expect(d.ok).toBe(false);
      expect(d.why).toBe("");
    }
  });
});

describe("isUnauthenticatedPath", () => {
  it("opens the health probe and nothing else", () => {
    expect(isUnauthenticatedPath("/healthz")).toBe(true);
    expect(isUnauthenticatedPath("/healthz?x=1")).toBe(true);
    for (const p of ["/", "/app.js", "/api/providers", "/api/sessions", "/api/upload", "/healthz/../api/providers"]) {
      expect(isUnauthenticatedPath(p), p).toBe(false);
    }
  });
});
