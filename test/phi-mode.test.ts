import { describe, expect, it } from "vitest";
import { detectPhi, phiVerdict, redact, scanText } from "../src/compliance/phi-detect.js";
import { checkProduction } from "../src/config/production-check.js";
import { phiSection, buildSystemPrompt } from "../src/agent/system-prompt.js";
import { retentionDecision, retentionReport } from "../src/compliance/retention.js";
import { assessCommandRisk } from "../src/tools/shell.js";
import { uploadGate } from "../src/compliance/upload-gate.js";

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

// ── Retention and shell hardening — the rest of Phase 1 ─────────────────────

describe("retentionDecision", () => {
  const NOW = 1_700_000_000_000;

  it("is OFF at zero, and zero is not 'delete everything'", () => {
    // The asymmetry is deliberate. Misreading this setting must mean keeping
    // data too long, which is recoverable — not destroying a practice's
    // documents because a config value was blank.
    for (const days of [0, -1, Number.NaN]) {
      expect(retentionDecision({ documentDays: days }, NOW).enforce, String(days)).toBe(false);
    }
  });

  it("computes the cut-off from the clock it is given", () => {
    const d = retentionDecision({ documentDays: 30 }, NOW);
    expect(d.enforce).toBe(true);
    expect(d.cutoff).toBe(NOW - 30 * 86_400_000);
    expect(d.note).toMatch(/30 day/);
  });

  it("says nothing when nothing was deleted", () => {
    // A daily "removed 0 documents" trains people to skip the line where the
    // real number will one day be.
    expect(retentionReport(0, 0, 30)).toBe("");
    expect(retentionReport(4, 12000, 30)).toMatch(/deleted 4 document/);
  });
});

describe("shell risk in production PHI mode", () => {
  it("makes a read of the patient data store ask, even with a read-only command", () => {
    // `grep -r 1EG4 /data` is a read-only command by every other test in this
    // file, and it is also a search of every stored document with no prompt and
    // no PHI access row — the read trail routed around by a tool that was never
    // asked to think about it.
    for (const cmd of ["grep -r Rivera /data", "cat ~/.orion/orion.db", "ls /data/"]) {
      expect(assessCommandRisk(cmd, { phiMode: "production" }).level, cmd).toBe("confirm");
      expect(assessCommandRisk(cmd, { phiMode: "production" }).reason).toMatch(/patient data store|credentials/);
    }
  });

  it("does NOT add that friction in education mode", () => {
    // On a laptop full of synthetic claims, making every `ls ~/.orion` ask is
    // the kind of friction that gets a control switched off.
    expect(assessCommandRisk("ls /data/").level).toBe("safe");
    expect(assessCommandRisk("ls /data/", { phiMode: "education" }).level).toBe("safe");
  });

  it("leaves ordinary workspace commands alone in both modes", () => {
    for (const mode of ["education", "production"] as const) {
      expect(assessCommandRisk("cat README.md", { phiMode: mode }).level, mode).toBe("safe");
      expect(assessCommandRisk("git status", { phiMode: mode }).level, mode).toBe("safe");
    }
  });

  it("still refuses credentials and separators regardless of mode", () => {
    expect(assessCommandRisk("cat .env", { phiMode: "education" }).level).toBe("confirm");
    expect(assessCommandRisk("ls\nrm -rf ~", { phiMode: "production" }).level).toBe("confirm");
  });
});

describe("uploadGate — per-file acknowledgement", () => {
  it("does nothing in education mode", () => {
    expect(uploadGate({ mode: "education", acknowledged: false, filename: "eob.pdf" }).allow).toBe(true);
  });

  it("requires an acknowledgement per file in production", () => {
    const d = uploadGate({ mode: "production", acknowledged: false, filename: "eob.pdf" });
    expect(d.allow).toBe(false);
    expect(d.status).toBe(428);
  });

  it("answers 428, not 403 or 400", () => {
    // The upload is permitted once somebody says so. A 403 would tell the
    // client it was forbidden; a 400 would send a developer hunting for a bug
    // in their own code. 428 is "your request is fine and is missing a
    // precondition you can satisfy and retry".
    expect(uploadGate({ mode: "production", acknowledged: false, filename: "x" }).status).toBe(428);
  });

  it("names the file, so the prompt is about a specific record", () => {
    const d = uploadGate({ mode: "production", acknowledged: false, filename: "remit-march.pdf" });
    expect(d.why).toContain("remit-march.pdf");
  });

  it("proceeds once acknowledged", () => {
    expect(uploadGate({ mode: "production", acknowledged: true, filename: "eob.pdf" }).allow).toBe(true);
  });
});
