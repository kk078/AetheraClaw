import { describe, expect, it } from "vitest";
import {
  DENIAL_REVIEW_THRESHOLD,
  assessEmLevel,
  evaluateGate,
  ladderFor,
  renderEmRisk,
  renderGate,
  type EmRisk,
  type GateInput,
} from "../src/tools/healthcare/presubmit.js";

const mdm = (over: Partial<Parameters<typeof assessEmLevel>[1]> = {}): Parameters<typeof assessEmLevel>[1] => ({
  patient_type: "established",
  problems: {
    minor_problems: 0,
    stable_chronic: 0,
    exacerbated_chronic: 0,
    acute_uncomplicated: 0,
    acute_complicated_or_systemic: 0,
    threat_to_life: false,
  },
  data: {
    tests_reviewed: 0,
    tests_ordered: 0,
    external_notes: 0,
    independent_historian: false,
    independent_interpretation: false,
    discussed_with_external: false,
  },
  risk: "minimal",
  ...over,
});

/** Documentation that scores to moderate MDM → 99214 established. */
const MODERATE = mdm({
  problems: { ...mdm().problems, exacerbated_chronic: 1 },
  data: { ...mdm().data, tests_reviewed: 2, tests_ordered: 1 },
  risk: "moderate",
});

describe("E/M level risk — both directions", () => {
  it("agrees when the code matches the documented MDM", () => {
    const r = assessEmLevel("99214", MODERATE);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.direction).toBe("supported");
    expect(r.severity).toBe("info");
    // Agreement is about the MDM as scored, not about the note being complete.
    expect(r.remedy).toMatch(/not that the note is complete/);
  });

  it("calls one level above the documentation a warning", () => {
    const r = assessEmLevel("99215", MODERATE);
    if ("error" in r) throw new Error(r.error);
    expect(r.direction).toBe("above_documentation");
    expect(r.distance).toBe(1);
    expect(r.severity).toBe("warning");
  });

  it("calls two levels above an error, not a scoring disagreement", () => {
    const straightforward = mdm();
    const r = assessEmLevel("99215", straightforward);
    if ("error" in r) throw new Error(r.error);
    expect(r.direction).toBe("above_documentation");
    expect(r.distance).toBe(3);
    expect(r.severity).toBe("error");
    expect(r.remedy).toMatch(/False Claims Act/);
  });

  it("refuses to endorse amending the note to fit the code", () => {
    const r = assessEmLevel("99215", MODERATE);
    if ("error" in r) throw new Error(r.error);
    expect(r.remedy).toMatch(/changing the note to fit the code after the fact is not/);
  });

  it("REPORTS undercoding too, and does not treat it as compliant-and-done", () => {
    // The direction the proposed design omitted. Reporting only upcoding
    // teaches defensive downcoding, which pulls a practice under its own peer
    // benchmark — itself an audit selection criterion.
    const r = assessEmLevel("99212", MODERATE);
    if ("error" in r) throw new Error(r.error);
    expect(r.direction).toBe("below_documentation");
    expect(r.distance).toBe(2);
    expect(r.severity).toBe("info");
    expect(r.remedy).toMatch(/revenue earned and not billed/);
    expect(r.remedy).toMatch(/audit selection criterion/);
  });

  it("refuses to compare across the new/established ladders", () => {
    // 99204 and 99214 are the same MDM level for different patient types;
    // subtracting their indexes across ladders would be arithmetic on
    // unrelated scales.
    const r = assessEmLevel("99204", MODERATE); // MODERATE is established
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/not comparable level for level/);
  });

  it("rejects a code outside the office/outpatient set", () => {
    const r = assessEmLevel("99223", MODERATE);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/99202–99205/);
  });

  it("knows both ladders", () => {
    expect(ladderFor("99203")).toContain("99205");
    expect(ladderFor("99213")).toContain("99215");
    expect(ladderFor("99215")).not.toContain("99205");
    expect(ladderFor("11721")).toBeUndefined();
  });

  it("always says the record decides", () => {
    const r = assessEmLevel("99214", MODERATE);
    if ("error" in r) throw new Error(r.error);
    expect(renderEmRisk(r)).toMatch(/The record decides the level/);
  });
});

describe("pre-submission gate", () => {
  const gate = (over: Partial<GateInput> = {}): GateInput => ({
    scrubFindings: [],
    denialProbability: null,
    denialFactors: [],
    checksNotRun: [],
    ...over,
  });

  const emRisk = (over: Partial<EmRisk> = {}): EmRisk => ({
    direction: "above_documentation",
    billedCode: "99215",
    supportedCode: "99214",
    distance: 1,
    severity: "warning",
    message: "",
    remedy: "",
    ...over,
  });

  it("clears a claim with nothing wrong", () => {
    expect(evaluateGate(gate()).verdict).toBe("clear");
  });

  it("holds on a scrub error", () => {
    const r = evaluateGate(gate({ scrubFindings: [{ severity: "error", rule: "dx-pointer-missing", message: "" }] }));
    expect(r.verdict).toBe("hold");
    expect(r.reasons[0]).toMatch(/do not adjudicate/);
  });

  it("reviews rather than holds on a warning", () => {
    // A two-valued gate becomes a rubber stamp: everything not blocked reads as
    // approved, so the borderline cases go out with the clean ones.
    expect(evaluateGate(gate({ scrubFindings: [{ severity: "warning", rule: "modifier-25", message: "" }] })).verdict).toBe("review");
  });

  it("holds on E/M two levels above the note, reviews at one", () => {
    expect(evaluateGate(gate({ emRisk: emRisk({ distance: 2, severity: "error" }) })).verdict).toBe("hold");
    expect(evaluateGate(gate({ emRisk: emRisk() })).verdict).toBe("review");
  });

  it("reviews on elevated predicted denial risk", () => {
    expect(evaluateGate(gate({ denialProbability: DENIAL_REVIEW_THRESHOLD })).verdict).toBe("review");
    expect(evaluateGate(gate({ denialProbability: 0.05 })).verdict).toBe("clear");
  });

  it("surfaces undercoding as a review rather than passing it silently", () => {
    const r = evaluateGate(gate({ emRisk: emRisk({ direction: "below_documentation", distance: 2, severity: "info" }) }));
    expect(r.verdict).toBe("review");
    expect(r.reasons.join(" ")).toMatch(/revenue left on the table/);
  });

  it("does not downgrade a hold because of a lesser finding", () => {
    const r = evaluateGate(
      gate({
        scrubFindings: [
          { severity: "error", rule: "npi-invalid", message: "" },
          { severity: "warning", rule: "modifier-25", message: "" },
        ],
        denialProbability: 0.9,
      }),
    );
    expect(r.verdict).toBe("hold");
  });
});

describe("gate blind spots", () => {
  it("puts unrun checks FIRST, not buried under the verdict", () => {
    const out = renderGate({
      verdict: "clear",
      reasons: [],
      blindSpots: ["NCCI bundling edits — no PTP table installed."],
    });
    // A verdict read without knowing what was skipped is a verdict about a
    // different claim.
    expect(out.indexOf("NOT CHECKED")).toBeLessThan(out.indexOf("No scrub errors"));
  });

  it("refuses to let 'clear' imply the skipped checks passed", () => {
    const out = renderGate({ verdict: "clear", reasons: [], blindSpots: ["NCCI bundling edits."] });
    expect(out).toMatch(/nothing that ran found a problem/);
    expect(out).toMatch(/not a statement about the checks that did not run/);
  });

  it("says clear plainly when everything ran", () => {
    const out = renderGate({ verdict: "clear", reasons: [], blindSpots: [] });
    expect(out).toMatch(/CLEAR — nothing that was checked failed/);
    expect(out).not.toMatch(/NOT CHECKED/);
  });

  it("never claims to know more than the tools it composes", () => {
    const out = renderGate({ verdict: "clear", reasons: [], blindSpots: [] });
    expect(out).toMatch(/none of them read the chart/);
  });
});
