import { describe, expect, it } from "vitest";
import { detectPhi, phiVerdict, redact, scanText } from "../src/compliance/phi-detect.js";
import { checkProduction } from "../src/config/production-check.js";
import { phiSection, buildSystemPrompt } from "../src/agent/system-prompt.js";

// Phase 1 of the production programme. These tests exist because every one of
// them is a specific way real patient data ends up somewhere it was promised
// not to be.

// A synthetic remittance — the shape a demo and a real trial both use, and the
// thing that must keep working. Nothing here may be treated as PHI.
const CLEAN = `Remittance advice from Aetna, check 88213.
Claim CLM-4471 allowed 220.00, paid 176.00, adjustment 44.00 (CO-45).
Date of service 03/14/2025. Rendering NPI 1234567893.`;

describe("detectPhi — the frozen high-confidence set", () => {
  it("finds each of the four identifiers", () => {
    expect(detectPhi("SSN 123-45-6789").map((s) => s.kind)).toEqual(["ssn"]);
    expect(detectPhi("MBI 1EG4-TE5-MK73").map((s) => s.kind)).toEqual(["mbi"]);
    expect(detectPhi("DOB: 01/02/1955").map((s) => s.kind)).toEqual(["dob"]);
    expect(detectPhi("HICN 123456789A").map((s) => s.kind)).toContain("hicn");
  });

  it("reports the SHAPE and never the value", () => {
    // A finding that quoted what it found would put the identifier into every
    // log line and UI string built from it — a second copy of exactly the thing
    // being refused.
    for (const s of detectPhi("SSN 123-45-6789 DOB: 01/02/1955")) {
      expect(s.hint).not.toMatch(/123|1955/);
    }
  });

  it("LEAVES A SYNTHETIC REMITTANCE ALONE", () => {
    // The regression that matters most on the live deployment: the ingress
    // posture gate refuses documents on this verdict, so widening detectPhi
    // starts refusing demo files that worked yesterday. A date of service and
    // an NPI are not patient identifiers.
    expect(detectPhi(CLEAN)).toEqual([]);
  });
});

describe("scanText — the wider production scan", () => {
  it("keeps every high-confidence finding and marks it high", () => {
    const scan = scanText("Member SSN 123-45-6789 on file.");
    expect(scan.risk).toBe("likely");
    expect(scan.findings.every((f) => f.kind !== "ssn" || f.confidence === "high")).toBe(true);
  });

  it("reads a bare date beside a person-word as a possible birth date", () => {
    const scan = scanText("Patient seen 01/02/1955, referred by cardiology.");
    expect(scan.risk).toBe("possible");
    expect(scan.findings.map((f) => f.kind)).toContain("name_dob");
  });

  it("does NOT flag a date that is nowhere near a person-word", () => {
    // A date of service in a remittance is a date, not a birth date. Treating
    // every date as PHI would refuse every claim document in the product.
    expect(scanText("Date of service 03/14/2025 for claim CLM-4471.").risk).toBe("none");
  });

  it("does not double-count a labelled DOB as a nearby date too", () => {
    // One identifier must read as one problem. Counting it twice makes a single
    // mistake look like two and inflates every message built from the list.
    const scan = scanText("Patient DOB: 01/02/1955");
    expect(scan.findings.filter((f) => f.kind === "name_dob")).toHaveLength(0);
  });

  it("flags phones, emails and labelled record numbers at medium confidence", () => {
    expect(scanText("Call 617-555-0142").findings.map((f) => f.kind)).toContain("phone");
    expect(scanText("write to a.b@example.com").findings.map((f) => f.kind)).toContain("email");
    expect(scanText("MRN: A9931-22").findings.map((f) => f.kind)).toContain("record_number");
  });

  it("leaves the synthetic remittance at risk none", () => {
    expect(scanText(CLEAN).risk).toBe("none");
  });
});

describe("phiVerdict — where the two modes differ, and where they do not", () => {
  const likely = scanText("SSN 123-45-6789");
  const possible = scanText("Patient seen 01/02/1955");
  const none = scanText(CLEAN);

  it("blocks a high-confidence identifier IN BOTH MODES", () => {
    // An education deployment that lets a labelled SSN into a transcript is not
    // educating anyone about anything.
    for (const mode of ["education", "production"] as const) {
      expect(phiVerdict(likely, mode).allow, mode).toBe(false);
    }
  });

  it("differs on medium confidence, which is the entire setting", () => {
    expect(phiVerdict(possible, "education").allow).toBe(true);
    expect(phiVerdict(possible, "production").allow).toBe(false);
  });

  it("allows clean text in both modes", () => {
    expect(phiVerdict(none, "education").allow).toBe(true);
    expect(phiVerdict(none, "production").allow).toBe(true);
  });

  it("explains without quoting", () => {
    const v = phiVerdict(likely, "production");
    expect(v.why).toMatch(/Social Security number/);
    expect(v.why).not.toMatch(/123-45-6789/);
    // The kinds go to the log; the values never do.
    expect(v.kinds).toContain("ssn");
  });

  it("says plainly that nothing was stored", () => {
    // The sentence a user reads after a refusal has to answer the question they
    // are about to ask, which is "is it in there now".
    expect(phiVerdict(likely, "education").why).toMatch(/not stored|was not stored/);
  });
});

describe("redact", () => {
  it("replaces identifiers with markers", () => {
    const out = redact("SSN 123-45-6789 and DOB: 01/02/1955");
    expect(out).not.toMatch(/123-45-6789/);
    expect(out).toMatch(/REDACTED-SSN/);
  });
});

describe("the production system prompt", () => {
  it("drops the synthetic-data escape hatch", () => {
    // The education text tells the model that clearly synthetic data is fine.
    // A model working on real charts that has been told that has been handed
    // the argument it needs to treat a real record as an example.
    expect(phiSection("education")).toMatch(/synthetic/i);
    expect(phiSection("production")).not.toMatch(/synthetic/i);
  });

  it("states the minimum necessary standard and the disclosure gate", () => {
    const p = phiSection("production");
    expect(p).toMatch(/minimum necessary/i);
    expect(p).toMatch(/approval gate/i);
  });

  it("is reachable through buildSystemPrompt, so the wiring cannot rot", () => {
    expect(buildSystemPrompt("/ws", "production")).toMatch(/handles real patient data/i);
    expect(buildSystemPrompt("/ws")).toMatch(/NOT approved for real patient data/i);
  });
});

describe("checkProduction", () => {
  const base = {
    exposure: "loopback" as const,
    gatewayToken: "",
    phiMode: "education" as const,
    approvalPolicy: "unsafe-only",
    publicAccess: false,
    encryptionKey: "",
    posture: "permitted" as const,
  };

  it("passes a plain loopback development install", () => {
    expect(checkProduction(base).fatal).toBe(false);
  });

  it("REFUSES TO START when exposed with no shared secret", () => {
    // Previously this state started happily and answered 500 to every page —
    // green everywhere a machine looks, dead everywhere a person does.
    const r = checkProduction({ ...base, exposure: "exposed" });
    expect(r.fatal).toBe(true);
    expect(r.checks.find((c) => c.id === "gateway-token")?.message).toMatch(/ORION_GATEWAY_TOKEN/);
  });

  it("refuses production PHI mode with approvals off", () => {
    const r = checkProduction({ ...base, phiMode: "production", approvalPolicy: "never" });
    expect(r.fatal).toBe(true);
    expect(r.checks.find((c) => c.id === "approvals")?.level).toBe("fatal");
  });

  it("refuses production PHI mode on a public console", () => {
    const r = checkProduction({ ...base, phiMode: "production", publicAccess: true });
    expect(r.fatal).toBe(true);
  });

  it("allows public access while the mode is education — today's deployment", () => {
    // The live trial is exactly this: public, synthetic, PHI blocked. It must
    // keep starting.
    const r = checkProduction({
      ...base,
      exposure: "exposed",
      gatewayToken: "a-token-long-enough-to-be-real-32ch",
      publicAccess: true,
      posture: "blocked",
    });
    expect(r.fatal).toBe(false);
  });

  it("warns rather than refuses on the contradictory-but-safe combinations", () => {
    const r = checkProduction({ ...base, phiMode: "production", posture: "blocked" });
    expect(r.fatal).toBe(false);
    expect(r.checks.find((c) => c.id === "posture")?.level).toBe("warn");
    expect(r.checks.find((c) => c.id === "encryption")?.level).toBe("warn");
  });
});
