import { describe, expect, it } from "vitest";
import { isClean, parseCarcList, parseTwinVerdict, renderVerdict } from "../src/tools/healthcare/twin/verdict.js";
import {
  calibrate,
  isWarning,
  playbookNoteFor,
  renderCalibration,
  scorePrediction,
  type Outcome,
  type Prediction,
  type ScoredPrediction,
} from "../src/tools/healthcare/twin/calibration.js";
import {
  DEFAULT_CLEAN_PASSES,
  REVENUE_INCREASING_MODIFIERS,
  assessGauntlet,
  claimFingerprint,
  claimsDiffer,
  diffClaims,
  emLevel,
  renderGauntlet,
  type GauntletRound,
} from "../src/tools/healthcare/twin/gauntlet.js";
import { buildPlaybook, payerKey } from "../src/tools/healthcare/twin/playbook.js";
import type { ClaimInput } from "../src/tools/healthcare/x12/837.js";

// ── Verdict parsing ──────────────────────────────────────────────────────────

const WELL_FORMED = `VERDICT: DENY
CONFIDENCE: high
PREDICTED_CARCS: 50, 97
RATIONALE: Line 2 (20610) bundles into line 1 under NCCI.
REMEDIATION: Report 27447 alone unless the record documents a separate site.`;

describe("twin verdict parsing", () => {
  it("reads a well-formed response", () => {
    const v = parseTwinVerdict(WELL_FORMED);
    expect(v.verdict).toBe("DENY");
    expect(v.confidence).toBe("high");
    expect(v.predictedCarcs).toEqual(["50", "97"]);
    expect(v.rationale).toMatch(/bundles into line 1/);
    expect(v.remediation).toMatch(/Report 27447 alone/);
    expect(v.parseProblems).toEqual([]);
  });

  it("tolerates casing and dashes", () => {
    const v = parseTwinVerdict("verdict - pay\nconfidence - LOW\nrationale - clean claim");
    expect(v.verdict).toBe("PAY");
    expect(v.confidence).toBe("low");
  });

  it("tolerates prose around the labels", () => {
    const v = parseTwinVerdict("Here is my assessment.\n\nVERDICT: PARTIAL\nCONFIDENCE: medium\nPREDICTED_CARCS: 45");
    expect(v.verdict).toBe("PARTIAL");
    expect(v.predictedCarcs).toEqual(["45"]);
  });

  it("refuses to guess a verdict it cannot find", () => {
    // Defaulting to PAY would wave through exactly what the twin exists to catch.
    const v = parseTwinVerdict("I think this claim looks broadly fine, honestly.");
    expect(v.verdict).toBeNull();
    expect(v.parseProblems[0]).toMatch(/not being read as a prediction/);
    expect(isClean(v)).toBe(false);
  });

  it("says so when a denial names no codes to score against", () => {
    const v = parseTwinVerdict("VERDICT: DENY\nCONFIDENCE: high\nRATIONALE: it is bad");
    expect(v.parseProblems.join(" ")).toMatch(/cannot be scored against a remittance/);
  });

  it("keeps the raw response so a parse failure can be investigated", () => {
    expect(parseTwinVerdict("nonsense").raw).toBe("nonsense");
  });

  it("tells the reader an unreadable answer is not a PAY", () => {
    expect(renderVerdict(parseTwinVerdict("nonsense"))).toMatch(/an unreadable answer is not a PAY/);
  });

  it("separates rationale from remediation regardless of order", () => {
    const v = parseTwinVerdict("VERDICT: DENY\nPREDICTED_CARCS: 16\nREMEDIATION: fix the ID\nRATIONALE: bad ID");
    expect(v.remediation).toBe("fix the ID");
    expect(v.rationale).toBe("bad ID");
  });
});

describe("CARC list parsing", () => {
  it("reads a comma-separated list", () => {
    expect(parseCarcList("50, 97, B7")).toEqual(["50", "97", "B7"]);
  });

  it("strips the CARC prefix and trailing punctuation", () => {
    expect(parseCarcList("CARC 50; CARC 16.")).toEqual(["50", "16"]);
  });

  it("treats an empty or none value as no prediction", () => {
    for (const raw of ["", "  ", "none", "N/A", "-"]) expect(parseCarcList(raw)).toEqual([]);
  });

  it("does not turn prose into codes", () => {
    expect(parseCarcList("probably a medical necessity issue")).toEqual([]);
  });

  it("deduplicates", () => {
    expect(parseCarcList("50, 50, 50")).toEqual(["50"]);
  });
});

// ── Calibration ──────────────────────────────────────────────────────────────

const prediction = (over: Partial<Prediction> = {}): Prediction => ({
  claimId: "C1",
  payer: "ACME",
  verdict: "DENY",
  confidence: "high",
  predictedCarcs: ["50"],
  createdAt: 1,
  ...over,
});

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  claimId: "C1",
  denied: true,
  actualCarcs: ["50"],
  ...over,
});

const scored = (p: Partial<Prediction>, o: Partial<Outcome>): ScoredPrediction =>
  scorePrediction(prediction(p), outcome(o));

describe("scoring one prediction", () => {
  it("counts a correct warning as a true positive", () => {
    const s = scored({}, {});
    expect(s.truePositive).toBe(true);
    expect(s.carcHits).toEqual(["50"]);
  });

  it("counts a warning on a paid claim as a false positive", () => {
    const s = scored({}, { denied: false, actualCarcs: [] });
    expect(s.falsePositive).toBe(true);
  });

  it("counts a missed denial as a false negative", () => {
    const s = scored({ verdict: "PAY", predictedCarcs: [] }, {});
    expect(s.falseNegative).toBe(true);
  });

  it("treats PARTIAL as a warning", () => {
    expect(isWarning("PARTIAL")).toBe(true);
    expect(isWarning("DENY")).toBe(true);
    expect(isWarning("PAY")).toBe(false);
  });

  it("matches CARC codes regardless of case", () => {
    expect(scored({ predictedCarcs: ["b7"] }, { actualCarcs: ["B7"] }).carcHits).toEqual(["b7"]);
  });
});

describe("calibration report", () => {
  it("reports recall separately from accuracy", () => {
    // Nine clean claims the twin called clean, one denial it missed.
    const set = [
      ...Array.from({ length: 9 }, (_, i) =>
        scored({ claimId: `P${i}`, verdict: "PAY", predictedCarcs: [] }, { denied: false, actualCarcs: [] }),
      ),
      scored({ claimId: "D1", verdict: "PAY", predictedCarcs: [] }, { denied: true }),
    ];
    const r = calibrate(set);
    expect(r.accuracy).toBeCloseTo(0.9, 6);
    expect(r.denialRecall).toBe(0); // caught none of the denials
  });

  it("says when accuracy is only reflecting the base rate", () => {
    // A twin that never warns scores 90% on a book that denies 10% of the time.
    const set = [
      ...Array.from({ length: 9 }, (_, i) =>
        scored({ claimId: `P${i}`, verdict: "PAY", predictedCarcs: [] }, { denied: false, actualCarcs: [] }),
      ),
      scored({ claimId: "D1", verdict: "PAY", predictedCarcs: [] }, { denied: true }),
    ];
    const r = calibrate(set);
    expect(r.trivialAccuracy).toBeCloseTo(0.9, 6);
    expect(r.beatsTrivial).toBe(false);
    expect(renderCalibration(r)).toMatch(/NOT beating that/);
  });

  it("credits a twin that genuinely beats the trivial baseline", () => {
    const set = [
      scored({ claimId: "D1" }, { denied: true }),
      scored({ claimId: "D2" }, { denied: true }),
      scored({ claimId: "P1", verdict: "PAY", predictedCarcs: [] }, { denied: false, actualCarcs: [] }),
      scored({ claimId: "P2", verdict: "PAY", predictedCarcs: [] }, { denied: false, actualCarcs: [] }),
    ];
    const r = calibrate(set);
    expect(r.accuracy).toBe(1);
    expect(r.beatsTrivial).toBe(true);
    expect(renderCalibration(r)).toMatch(/adding something/);
  });

  it("computes precision as the cost of recall", () => {
    // Warns on everything: catches the denial, but three false alarms.
    const set = [
      scored({ claimId: "D1" }, { denied: true }),
      ...Array.from({ length: 3 }, (_, i) => scored({ claimId: `P${i}` }, { denied: false, actualCarcs: [] })),
    ];
    const r = calibrate(set);
    expect(r.denialRecall).toBe(1);
    expect(r.precision).toBeCloseTo(0.25, 6);
  });

  it("scores reason codes by precision and recall separately", () => {
    const set = [scored({ predictedCarcs: ["50", "97", "16"] }, { actualCarcs: ["50", "45"] })];
    const r = calibrate(set);
    expect(r.carcPrecision).toBeCloseTo(1 / 3, 6); // one of three predicted appeared
    expect(r.carcRecall).toBeCloseTo(1 / 2, 6); // one of two used was predicted
  });

  it("notices when stated confidence does not track being right", () => {
    const set = [
      scored({ claimId: "A", confidence: "high", verdict: "PAY", predictedCarcs: [] }, { denied: true }),
      scored({ claimId: "B", confidence: "high", verdict: "PAY", predictedCarcs: [] }, { denied: true }),
      scored({ claimId: "C", confidence: "low" }, { denied: true }),
    ];
    const r = calibrate(set);
    expect(r.confidenceOrdered).toBe(false);
    expect(renderCalibration(r)).toMatch(/confidence is not informative/);
  });

  it("confirms confidence that does track being right", () => {
    const set = [
      scored({ claimId: "A", confidence: "low", verdict: "PAY", predictedCarcs: [] }, { denied: true }),
      scored({ claimId: "B", confidence: "high" }, { denied: true }),
      scored({ claimId: "C", confidence: "high" }, { denied: true }),
    ];
    expect(calibrate(set).confidenceOrdered).toBe(true);
  });

  it("breaks results out per payer", () => {
    const set = [
      scored({ claimId: "A", payer: "ACME" }, { denied: true }),
      scored({ claimId: "B", payer: "UHC", verdict: "PAY", predictedCarcs: [] }, { denied: true }),
    ];
    const r = calibrate(set);
    expect(r.byPayer.map((p) => p.payer).sort()).toEqual(["ACME", "UHC"]);
  });

  it("says plainly when nothing has been scored", () => {
    expect(renderCalibration(calibrate([]))).toMatch(/No twin predictions have a matching remittance/);
  });
});

describe("playbook notes from misses", () => {
  it("writes a note for a missed denial", () => {
    const note = playbookNoteFor(scored({ verdict: "PAY", predictedCarcs: [] }, { denied: true }));
    expect(note).toMatch(/Missed a denial/);
    expect(note).toMatch(/denial risk with this payer/);
  });

  it("writes a note for an over-call", () => {
    expect(playbookNoteFor(scored({}, { denied: false, actualCarcs: [] }))).toMatch(/Over-called/);
  });

  it("writes a note when the twin was right for the wrong reason", () => {
    const note = playbookNoteFor(scored({ predictedCarcs: ["16"] }, { denied: true, actualCarcs: ["50"] }));
    expect(note).toMatch(/Right for the wrong reason/);
  });

  it("writes nothing when the twin was simply right", () => {
    expect(playbookNoteFor(scored({}, {}))).toBeNull();
  });
});

// ── Gauntlet ─────────────────────────────────────────────────────────────────

const claim = (lines: Array<Partial<{ code: string; modifiers: string[]; units: number; charge: number; pointers: number[]; pos: string }>> = [{}], diagnoses = ["E11.65"]): ClaimInput =>
  ({
    claim_id: "C1",
    payer_name: "ACME",
    payer_id: "P1",
    billing_provider_npi: "1234567893",
    billing_provider_name: "CLINIC",
    subscriber_id: "M1",
    patient_last: "DOE",
    patient_first: "JANE",
    patient_dob: "19700101",
    patient_sex: "F",
    diagnoses,
    service_lines: lines.map((l) => ({
      cpt_hcpcs: l.code ?? "99213",
      modifiers: l.modifiers,
      charge: l.charge ?? 100,
      units: l.units ?? 1,
      dx_pointers: l.pointers ?? [1],
      service_date: "20260515",
      place_of_service: l.pos ?? "11",
    })),
  }) as ClaimInput;

describe("claim fingerprinting", () => {
  it("ignores changes that do not affect what is billed", () => {
    const a = claim();
    const b = { ...claim(), claim_id: "DIFFERENT", patient_last: "ROE" } as ClaimInput;
    expect(claimsDiffer(a, b)).toBe(false);
  });

  it("notices a code change", () => {
    expect(claimsDiffer(claim([{ code: "99213" }]), claim([{ code: "99214" }]))).toBe(true);
  });

  it("treats modifier order as irrelevant", () => {
    expect(claimsDiffer(claim([{ modifiers: ["25", "59"] }]), claim([{ modifiers: ["59", "25"] }]))).toBe(false);
  });

  it("normalizes diagnosis dotting", () => {
    expect(claimsDiffer(claim([{}], ["E11.65"]), claim([{}], ["E1165"]))).toBe(false);
  });

  it("captures every billable field", () => {
    const f = claimFingerprint(claim([{ code: "99214", modifiers: ["25"], units: 2, charge: 200, pointers: [1, 2], pos: "22" }]));
    expect(f.lines[0]).toEqual({ code: "99214", modifiers: ["25"], units: 2, charge: 200, pointers: [1, 2], pos: "22" });
  });
});

describe("E/M level", () => {
  it("reads the level off the code", () => {
    expect(emLevel("99213")).toBe(3);
    expect(emLevel("99205")).toBe(5);
  });

  it("returns null for a code that is not E/M", () => {
    expect(emLevel("20610")).toBeNull();
  });
});

describe("classifying claim changes", () => {
  it("flags an E/M level increase as revenue increasing and needing the record", () => {
    const [change] = diffClaims(claim([{ code: "99213" }]), claim([{ code: "99214" }]));
    expect(change.direction).toBe("revenue_increasing");
    expect(change.needsRecord).toBe(true);
    expect(change.description).toMatch(/E\/M level raised/);
  });

  it("does not flag a level decrease", () => {
    const [change] = diffClaims(claim([{ code: "99214" }]), claim([{ code: "99213" }]));
    expect(change.direction).toBe("revenue_decreasing");
    expect(change.needsRecord).toBe(false);
  });

  it("flags an added distinct-service modifier", () => {
    const changes = diffClaims(claim([{}]), claim([{ modifiers: ["59"] }]));
    expect(changes[0].direction).toBe("revenue_increasing");
    expect(changes[0].description).toMatch(/modifier 59 added/);
  });

  it("knows which modifiers are the risky ones", () => {
    expect(REVENUE_INCREASING_MODIFIERS).toEqual(expect.arrayContaining(["22", "25", "50", "59", "XU"]));
  });

  it("does not flag removing a modifier", () => {
    const [change] = diffClaims(claim([{ modifiers: ["59"] }]), claim([{}]));
    expect(change.direction).toBe("neutral");
    expect(change.needsRecord).toBe(false);
  });

  it("flags added units, added lines and raised charges", () => {
    expect(diffClaims(claim([{ units: 1 }]), claim([{ units: 3 }]))[0].direction).toBe("revenue_increasing");
    expect(diffClaims(claim([{}]), claim([{}, {}]))[0].direction).toBe("revenue_increasing");
    expect(diffClaims(claim([{ charge: 100 }]), claim([{ charge: 250 }]))[0].direction).toBe("revenue_increasing");
  });

  it("treats removing a line as revenue decreasing", () => {
    expect(diffClaims(claim([{}, {}]), claim([{}]))[0].direction).toBe("revenue_decreasing");
  });

  it("treats a pointer or place-of-service correction as neutral but worth checking", () => {
    const pointers = diffClaims(claim([{ pointers: [1] }]), claim([{ pointers: [2] }], ["E11.65", "I10"]));
    expect(pointers.some((c) => c.direction === "neutral" && c.needsRecord)).toBe(true);
    const pos = diffClaims(claim([{ pos: "11" }]), claim([{ pos: "22" }]));
    expect(pos[0]).toMatchObject({ direction: "neutral", needsRecord: true });
  });

  it("finds nothing between identical claims", () => {
    expect(diffClaims(claim(), claim())).toEqual([]);
  });
});

const round = (n: number, verdict: string, changes: GauntletRound["changes"] = []): GauntletRound => ({
  round: n,
  claim: claim(),
  verdict: parseTwinVerdict(`VERDICT: ${verdict}\nCONFIDENCE: medium\nPREDICTED_CARCS: ${verdict === "PAY" ? "" : "50"}`),
  changes,
});

const realFix = [{ direction: "revenue_decreasing" as const, description: "Line 2 removed.", needsRecord: false }];
const upcode = [{ direction: "revenue_increasing" as const, description: "Line 1: E/M level raised.", needsRecord: true }];

describe("assessing a gauntlet run", () => {
  it("requires consecutive clean passes", () => {
    expect(DEFAULT_CLEAN_PASSES).toBe(2);
    expect(assessGauntlet([round(1, "DENY"), round(2, "PAY", realFix)]).converged).toBe(false);
    expect(assessGauntlet([round(1, "DENY"), round(2, "PAY", realFix), round(3, "PAY")]).converged).toBe(true);
  });

  it("does not count a clean pass that was interrupted", () => {
    const out = assessGauntlet([round(1, "PAY"), round(2, "DENY"), round(3, "PAY")]);
    expect(out.cleanPasses).toBe(1);
    expect(out.converged).toBe(false);
  });

  it("calls out converging on a claim that never changed", () => {
    // The twin answered differently the second time. That is inconsistency, not a fix.
    const out = assessGauntlet([round(1, "DENY"), round(2, "PAY"), round(3, "PAY")]);
    expect(out.converged).toBe(true);
    expect(out.convergedWithoutChanges).toBe(true);
    expect(out.submissionReady).toBe(false);
    expect(out.summary).toMatch(/the model being inconsistent, not a claim being fixed/);
  });

  it("refuses to call a claim ready when the fix billed more", () => {
    const out = assessGauntlet([round(1, "DENY"), round(2, "PAY", upcode), round(3, "PAY")]);
    expect(out.converged).toBe(true);
    expect(out.submissionReady).toBe(false);
    expect(out.changesNeedingRecord).toHaveLength(1);
    expect(out.summary).toMatch(/this is upcoding/);
    expect(out.summary).toMatch(/going quiet is not evidence/);
  });

  it("calls a claim ready when a real fix converged", () => {
    const out = assessGauntlet([round(1, "DENY"), round(2, "PAY", realFix), round(3, "PAY")]);
    expect(out.submissionReady).toBe(true);
    expect(out.summary).toMatch(/Still a prediction, not a guarantee/);
  });

  it("says the claim is not ready when the twin never stopped objecting", () => {
    const out = assessGauntlet([round(1, "DENY"), round(2, "DENY", realFix)]);
    expect(out.converged).toBe(false);
    expect(out.summary).toMatch(/still objecting/);
    expect(out.summary).toMatch(/work the remaining findings by hand/);
  });

  it("renders every round with its changes", () => {
    const out = renderGauntlet(assessGauntlet([round(1, "DENY"), round(2, "PAY", upcode), round(3, "PAY")]));
    expect(out).toMatch(/Round 1/);
    expect(out).toMatch(/revenue increasing/);
    expect(out).toMatch(/E\/M level raised/);
  });
});

// ── Playbook ─────────────────────────────────────────────────────────────────

describe("playbook", () => {
  it("says outright when there is no history", () => {
    const p = buildPlaybook({ payer: "ACME", stats: null, notes: [], totalObservations: 0 });
    expect(p).toMatch(/No adjudicated history/);
    expect(p).toMatch(/a guess about payers in general/);
  });

  it("warns that a thin history is thin", () => {
    const p = buildPlaybook({
      payer: "ACME",
      stats: { payer: "ACME", claims: 4, denied: 1, carcs: [] },
      notes: [],
      totalObservations: 4,
    });
    expect(p).toMatch(/thin history/);
    expect(p).toMatch(/Weight published policy over these numbers/);
  });

  it("does not warn when the history is substantial", () => {
    const p = buildPlaybook({
      payer: "ACME",
      stats: { payer: "ACME", claims: 200, denied: 20, carcs: [{ carc: "50", count: 12, amount: 3000 }] },
      notes: [],
      totalObservations: 400,
    });
    expect(p).not.toMatch(/thin history/);
    expect(p).toMatch(/CARC 50/);
  });

  it("keeps learned corrections apart from payer evidence", () => {
    const p = buildPlaybook({
      payer: "ACME",
      stats: { payer: "ACME", claims: 50, denied: 5, carcs: [] },
      notes: [{ kind: "over_call", note: "Over-called C7.", createdAt: 1 }],
      totalObservations: 50,
    });
    expect(p).toMatch(/Where this twin has been wrong before/);
    expect(p).toMatch(/describe this twin's errors, not the payer's rules/);
    expect(p.indexOf("Observed:")).toBeLessThan(p.indexOf("Where this twin has been wrong"));
  });

  it("normalizes a payer name into a key", () => {
    expect(payerKey("ACME Health Plan, Inc.")).toBe("acmehealthplaninc");
  });
});
