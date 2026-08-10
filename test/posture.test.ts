import { describe, expect, it } from "vitest";
import { resolvePosture, screenIngress } from "../src/config/posture.js";
import { detectPhi } from "../src/channels/email/classify.js";

// ORION goes onto a public hostname for trials BEFORE the Business Associate
// Agreement exists. What these tests hold in place is the consequence: a
// prospect who drags a real EOB onto the console — the honest thing to do when
// evaluating a document reader — must be refused rather than accommodated.

describe("resolvePosture", () => {
  it("BLOCKS by default the moment the gateway is not on loopback", () => {
    // The default is the whole design. Publishing the application is exactly
    // the condition under which the paperwork matters, so nobody has to
    // remember a flag and forgetting one fails safe.
    const v = resolvePosture({ exposure: "exposed", env: {} });
    expect(v.posture).toBe("blocked");
    expect(v.source).toBe("exposed-default");
  });

  it("leaves a local install alone", () => {
    // A laptop reading its own files is not a disclosure to anybody.
    const v = resolvePosture({ exposure: "loopback", env: {} });
    expect(v.posture).toBe("permitted");
    expect(v.source).toBe("loopback-default");
  });

  it("opens only on the exact word, which is the switch for the day the BAA lands", () => {
    expect(resolvePosture({ exposure: "exposed", env: { ORION_PHI: "permitted" } }).posture).toBe("permitted");
    expect(resolvePosture({ exposure: "exposed", env: { ORION_PHI: "PERMITTED" } }).posture).toBe("permitted");
    expect(resolvePosture({ exposure: "exposed", env: { ORION_PHI: " permitted " } }).posture).toBe("permitted");
  });

  it("treats every OTHER value as blocked, including the plausible ones", () => {
    // "true"/"yes"/"1" are what somebody types when they are guessing at the
    // format. Guessing back at their intent is the wrong instinct when the
    // subject is whether patient data may be stored.
    for (const value of ["true", "yes", "1", "on", "allow", "permit", "premitted", "blocked"]) {
      expect(resolvePosture({ exposure: "exposed", env: { ORION_PHI: value } }).posture, value).toBe("blocked");
    }
  });

  it("honours the pre-rename variable name", () => {
    expect(resolvePosture({ exposure: "exposed", env: { AETHERACLAW_PHI: "permitted" } }).posture).toBe("permitted");
  });

  it("explains itself in words safe to show a prospect mid-demo", () => {
    const v = resolvePosture({ exposure: "exposed", env: {} });
    expect(v.why).toMatch(/synthetic|de-identified/i);
    expect(v.why).toMatch(/refused, not redacted/i);
  });
});

describe("screenIngress", () => {
  const ssn = detectPhi("Patient 123-45-6789 seen on the 4th.");

  it("refuses a document carrying an identifier when blocked", () => {
    const d = screenIngress(ssn, "blocked");
    expect(d.accept).toBe(false);
    expect(d.kinds).toContain("ssn");
  });

  it("NEVER REPEATS THE VALUE IT REFUSED", () => {
    // This refusal is shown in a browser, logged, and quite possibly
    // screenshotted into a deck. A gate that quotes the Social Security number
    // back has disclosed the thing it exists to stop.
    const d = screenIngress(ssn, "blocked");
    expect(JSON.stringify(d)).not.toContain("123-45-6789");
    expect(JSON.stringify(d)).not.toContain("123456789");
  });

  it("says the document was not stored, because it was not", () => {
    const d = screenIngress(ssn, "blocked");
    expect(d.reason).toMatch(/nothing from the file was written/i);
    expect(d.reason).toMatch(/not a hash/i);
  });

  it("points at the way forward rather than just saying no", () => {
    const d = screenIngress(ssn, "blocked");
    expect(d.reason).toMatch(/synthetic or de-identified/i);
  });

  it("passes a document with no identifiers even when blocked", () => {
    // The gate is on PHI, not on documents. A synthetic remittance, a policy
    // PDF and an X12 envelope with no member id all go through untouched —
    // otherwise "blocked" would mean "the product does not work".
    const clean = detectPhi("Claim SYN-WL-001 denied CO-16. Allowed 142.31.");
    expect(clean).toEqual([]);
    expect(screenIngress(clean, "blocked").accept).toBe(true);
  });

  it("passes everything when permitted", () => {
    const d = screenIngress(ssn, "permitted");
    expect(d.accept).toBe(true);
    expect(d.kinds).toEqual([]);
  });

  it("names several kinds readably", () => {
    const many = detectPhi("SSN 123-45-6789 and MBI 1EG4-TE5-MK73 on file.");
    const d = screenIngress(many, "blocked");
    expect(d.kinds.length).toBeGreaterThan(1);
    expect(d.reason).toMatch(/ and /);
  });
});
