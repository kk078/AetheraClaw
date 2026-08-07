import { describe, expect, it } from "vitest";
import {
  CURRENT_MODEL,
  applyHierarchies,
  computeRaf,
  demographicKey,
  normalizeIcd,
  renderRaf,
  validateModel,
  type HccModel,
} from "../src/vbc/hcc.js";
import {
  DEFAULT_LOOKBACK_YEARS,
  daysLeftInYear,
  findRecaptureGaps,
  renderRecapture,
  type CodedDiagnosis,
} from "../src/vbc/recapture.js";
import {
  RADV_EXTRAPOLATION_STATUS,
  meatEvidence,
  renderSuspects,
  reviewConditions,
  type DocumentationExcerpt,
  type SuspectRule,
} from "../src/vbc/suspecting.js";
import { MEASURES, computeAll, computeMeasure, renderMeasures, type Encounter } from "../src/vbc/quality.js";

// ── Model fixture ────────────────────────────────────────────────────────────

const MODEL: HccModel = {
  version: "v28",
  mapping: {
    E119: "HCC37",
    E1165: "HCC37",
    E1122: "HCC36",
    I5022: "HCC226",
    I5042: "HCC226",
    I1: "HCC0",
    N184: "HCC327",
    N186: "HCC326",
    J449: "HCC280",
  },
  definitions: {
    HCC37: { hcc: "HCC37", label: "Diabetes with chronic complications", coefficient: 0.166, hierarchy: "DIABETES", severity: 2 },
    HCC36: { hcc: "HCC36", label: "Diabetes with severe acute complications", coefficient: 0.302, hierarchy: "DIABETES", severity: 3 },
    HCC226: { hcc: "HCC226", label: "Heart failure", coefficient: 0.331, hierarchy: "HEART", severity: 2 },
    HCC327: { hcc: "HCC327", label: "Chronic kidney disease, stage 4", coefficient: 0.222, hierarchy: "CKD", severity: 2 },
    HCC326: { hcc: "HCC326", label: "Chronic kidney disease, stage 5", coefficient: 0.289, hierarchy: "CKD", severity: 3 },
    HCC280: { hcc: "HCC280", label: "COPD", coefficient: 0.169, hierarchy: "", severity: 1 },
    HCC0: { hcc: "HCC0", label: "Not a real category", coefficient: 0, hierarchy: "", severity: 0 },
  },
  demographic: { CMS_F_70_74_NONDUAL_AGED: 0.395, CMS_M_70_74_NONDUAL_AGED: 0.371 },
  interactions: { "Diabetes + heart failure": { coefficient: 0.121, requires: ["HCC37", "HCC226"] } },
};

// ── Hierarchies ──────────────────────────────────────────────────────────────

describe("applyHierarchies", () => {
  it("keeps only the most severe condition in a hierarchy", () => {
    // Coding both forms of one disease does not pay twice, and summing them
    // overstates the score in the direction an auditor tests first.
    const result = applyHierarchies(["HCC37", "HCC36"], MODEL);
    expect(result.kept).toEqual(["HCC36"]);
    expect(result.suppressed).toEqual([{ hcc: "HCC37", by: "HCC36", hierarchy: "DIABETES" }]);
  });

  it("keeps conditions in different hierarchies", () => {
    expect(applyHierarchies(["HCC37", "HCC226"], MODEL).kept).toEqual(["HCC226", "HCC37"]);
  });

  it("keeps a condition with no hierarchy", () => {
    expect(applyHierarchies(["HCC280"], MODEL).kept).toEqual(["HCC280"]);
  });

  it("suppresses every loser, not just the first", () => {
    const model: HccModel = {
      ...MODEL,
      definitions: {
        ...MODEL.definitions,
        HCC38: { hcc: "HCC38", label: "Diabetes without complication", coefficient: 0.105, hierarchy: "DIABETES", severity: 1 },
      },
    };
    const result = applyHierarchies(["HCC38", "HCC37", "HCC36"], model);
    expect(result.kept).toEqual(["HCC36"]);
    expect(result.suppressed.map((s) => s.hcc).sort()).toEqual(["HCC37", "HCC38"]);
  });

  it("deduplicates and ignores categories the model does not define", () => {
    expect(applyHierarchies(["HCC280", "HCC280", "HCC999"], MODEL).kept).toEqual(["HCC280"]);
  });

  it("is order-independent", () => {
    expect(applyHierarchies(["HCC36", "HCC37"], MODEL).kept).toEqual(applyHierarchies(["HCC37", "HCC36"], MODEL).kept);
  });
});

// ── RAF ──────────────────────────────────────────────────────────────────────

const DEMO = { age: 72, sex: "F" as const };

describe("computeRaf", () => {
  it("adds the demographic term to the disease terms", () => {
    const r = computeRaf(DEMO, ["J44.9"], MODEL);
    expect(r.score).toBeCloseTo(0.395 + 0.169, 3);
    expect(r.demographic?.code).toBe("CMS_F_70_74_NONDUAL_AGED");
  });

  it("counts a hierarchy once, not twice", () => {
    // The whole point: E11.9 and E11.22 are both diabetes.
    const both = computeRaf(DEMO, ["E11.9", "E11.22"], MODEL);
    const severeOnly = computeRaf(DEMO, ["E11.22"], MODEL);
    expect(both.score).toBeCloseTo(severeOnly.score, 5);
    expect(both.suppressed).toHaveLength(1);
  });

  it("applies an interaction only when every condition it needs survived", () => {
    const with_ = computeRaf(DEMO, ["E11.9", "I50.22"], MODEL);
    expect(with_.interactions).toHaveLength(1);
    // Coding the more severe diabetes suppresses HCC37, so the interaction that
    // needed HCC37 no longer applies — which is the model, not a bug.
    const without = computeRaf(DEMO, ["E11.22", "I50.22"], MODEL);
    expect(without.interactions).toHaveLength(0);
  });

  it("reports diagnoses that map to no HCC without treating them as errors", () => {
    const r = computeRaf(DEMO, ["Z00.00", "J44.9"], MODEL);
    expect(r.unmapped).toEqual(["Z00.00"]);
    expect(r.hccs).toHaveLength(1);
  });

  it("normalizes the decimal so E11.65 and E1165 agree", () => {
    expect(normalizeIcd("e11.65")).toBe("E1165");
    expect(computeRaf(DEMO, ["E1165"], MODEL).score).toBeCloseTo(computeRaf(DEMO, ["E11.65"], MODEL).score, 5);
  });

  it("says so when there is no demographic coefficient rather than quietly omitting it", () => {
    const r = computeRaf({ age: 30, sex: "M" }, ["J44.9"], MODEL);
    expect(r.demographic).toBeNull();
    expect(r.warnings.join(" ")).toContain("not comparable");
  });

  it("warns when the model is not the one at full weight", () => {
    const r = computeRaf(DEMO, ["J44.9"], { ...MODEL, version: "v24" });
    expect(r.warnings.join(" ")).toContain(CURRENT_MODEL);
    expect(r.warnings.join(" ")).toContain("no weight at all");
  });

  it("breaks the score into terms that can be defended one at a time", () => {
    const text = renderRaf(computeRaf(DEMO, ["E11.9", "E11.22", "I50.22"], MODEL), "PT-1");
    expect(text).toContain("HCC36");
    expect(text).toContain("Suppressed by hierarchy");
    expect(text).toContain("does not pay twice");
    expect(text).toContain("face-to-face encounter");
  });
});

describe("demographicKey", () => {
  it("bands the age and names every dimension", () => {
    expect(demographicKey({ age: 72, sex: "F" })).toBe("CMS_F_70_74_NONDUAL_AGED");
    expect(demographicKey({ age: 96, sex: "M" })).toBe("CMS_M_95_GT_NONDUAL_AGED");
    expect(demographicKey({ age: 67, sex: "M", institutional: true, dualEligible: true, disabled: true })).toBe(
      "INS_M_65_69_DUAL_DIS",
    );
  });
});

describe("validateModel", () => {
  it("refuses a model whose mapping points at undefined categories", () => {
    const broken = { ...MODEL, mapping: { ...MODEL.mapping, X999: "HCC_MISSING" } };
    const result = validateModel(broken);
    expect(typeof result).toBe("string");
    expect(result as string).toContain("silently contribute nothing");
  });

  it("refuses a model with no version", () => {
    expect(validateModel({ mapping: {}, definitions: {} })).toContain("no version");
  });

  it("accepts a complete model", () => {
    expect(typeof validateModel(MODEL)).toBe("object");
  });
});

// ── Recapture ────────────────────────────────────────────────────────────────

const dx = (patientRef: string, code: string, serviceDate: string): CodedDiagnosis => ({
  patientRef,
  code,
  serviceDate,
  claimRef: `C-${serviceDate}`,
});

describe("daysLeftInYear", () => {
  it("counts to 31 December", () => {
    expect(daysLeftInYear("20261231")).toBe(0);
    expect(daysLeftInYear("20261201")).toBe(30);
  });
});

describe("findRecaptureGaps", () => {
  const opts = { year: 2026, asOf: "20260601", model: MODEL };

  it("finds a condition coded last year and not this one", () => {
    const report = findRecaptureGaps([dx("PT-1", "E11.9", "20250310"), dx("PT-1", "I10", "20260215")], opts);
    expect(report.actionable).toHaveLength(1);
    expect(report.actionable[0].hcc).toBe("HCC37");
    expect(report.actionable[0].lastServiceDate).toBe("20250310");
  });

  it("groups by CONDITION, not by code", () => {
    // E11.9 last year and E11.65 this year are both diabetes with chronic
    // complications. Comparing raw codes would report a gap already closed and
    // send a coder looking for something that is done.
    const report = findRecaptureGaps([dx("PT-1", "E11.9", "20250310"), dx("PT-1", "E11.65", "20260410")], opts);
    expect(report.actionable).toHaveLength(0);
    expect(report.captured).toBe(1);
  });

  it("separates patients seen this year from patients not seen at all", () => {
    const report = findRecaptureGaps(
      [
        dx("SEEN", "E11.9", "20250310"),
        dx("SEEN", "I10", "20260215"),
        dx("UNSEEN", "E11.9", "20250310"),
      ],
      opts,
    );
    expect(report.actionable.map((g) => g.patientRef)).toEqual(["SEEN"]);
    expect(report.needsVisit.map((g) => g.patientRef)).toEqual(["UNSEEN"]);
  });

  it("keeps the most recent prior sighting, which is the one a coder pulls", () => {
    const report = findRecaptureGaps(
      [dx("PT-1", "E11.9", "20240310"), dx("PT-1", "E11.9", "20250810"), dx("PT-1", "I10", "20260215")],
      opts,
    );
    expect(report.actionable[0].lastServiceDate).toBe("20250810");
  });

  it("ignores history older than the lookback window", () => {
    const old = findRecaptureGaps([dx("PT-1", "E11.9", "20200310"), dx("PT-1", "I10", "20260215")], opts);
    expect(old.actionable).toHaveLength(0);
    expect(DEFAULT_LOOKBACK_YEARS).toBe(3);
  });

  it("ranks the biggest coefficients first", () => {
    const report = findRecaptureGaps(
      [dx("PT-1", "J44.9", "20250310"), dx("PT-1", "I50.22", "20250310"), dx("PT-1", "I10", "20260215")],
      opts,
    );
    expect(report.actionable.map((g) => g.hcc)).toEqual(["HCC226", "HCC280"]);
  });

  it("does not treat a future-year code as prior history", () => {
    const report = findRecaptureGaps([dx("PT-1", "E11.9", "20270310")], opts);
    expect(report.actionable).toHaveLength(0);
    expect(report.needsVisit).toHaveLength(0);
  });

  it("counts what has already been captured", () => {
    const report = findRecaptureGaps([dx("PT-1", "E11.9", "20250310"), dx("PT-1", "E11.9", "20260310")], opts);
    expect(report.captured).toBe(1);
    expect(report.actionable).toHaveLength(0);
  });

  it("presses harder as the year runs out", () => {
    const late = findRecaptureGaps([dx("PT-1", "E11.9", "20250310"), dx("PT-1", "I10", "20261115")], {
      ...opts,
      asOf: "20261115",
    });
    expect(late.warnings.join(" ")).toContain("no late filing");
  });

  it("says nothing was found rather than nothing was wrong", () => {
    expect(renderRecapture(findRecaptureGaps([], opts))).toContain("Recapture needs claims");
  });

  it("calls the not-seen group a scheduling problem", () => {
    const report = findRecaptureGaps([dx("PT-1", "E11.9", "20250310")], opts);
    expect(renderRecapture(report)).toContain("scheduling problem");
    expect(renderRecapture(report)).toContain("no amount of chart review creates one");
  });

  it("sizes the gap in dollars only when told the conversion", () => {
    const report = findRecaptureGaps([dx("PT-1", "I50.22", "20250310"), dx("PT-1", "I10", "20260215")], opts);
    expect(renderRecapture(report, 0)).not.toContain("~$");
    expect(renderRecapture(report, 10000)).toContain("~$");
  });
});

// ── Suspecting ───────────────────────────────────────────────────────────────

const RULES: SuspectRule[] = [
  { hcc: "HCC226", phrases: ["heart failure", "reduced ejection fraction"], suggestedCode: "I50.22" },
  { hcc: "HCC280", phrases: ["copd", "emphysema"], suggestedCode: "J44.9" },
  { hcc: "HCC37", phrases: ["diabetic neuropathy"], suggestedCode: "E11.42" },
];

const note = (text: string, patientRef = "PT-1"): DocumentationExcerpt => ({
  patientRef,
  serviceDate: "20260410",
  text,
  source: "progress note",
});

describe("meatEvidence", () => {
  it("recognizes each of the four", () => {
    expect(meatEvidence("Continue lisinopril, titrated to 20 mg daily.")).toContain("treat");
    expect(meatEvidence("A1c reviewed, results stable.")).toContain("evaluate");
    expect(meatEvidence("Assessment: heart failure secondary to ischaemia.")).toContain("assess");
    expect(meatEvidence("Well controlled on current therapy, monitoring quarterly.")).toContain("monitor");
  });

  it("finds nothing in a bare mention", () => {
    expect(meatEvidence("Past medical history includes COPD.")).toEqual([]);
  });
});

describe("reviewConditions", () => {
  it("proposes a documented condition that was not coded", () => {
    const review = reviewConditions({
      documentation: [note("Assessment: heart failure with reduced ejection fraction. Continue carvedilol 12.5 mg daily.")],
      codedHccs: [],
      rules: RULES,
      model: MODEL,
    });
    expect(review.add).toHaveLength(1);
    expect(review.add[0].hcc).toBe("HCC226");
    expect(review.add[0].suggestedCode).toBe("I50.22");
    expect(review.add[0].meat.length).toBeGreaterThan(0);
  });

  it("quotes the sentence rather than paraphrasing it", () => {
    const review = reviewConditions({
      documentation: [note("Patient doing well. Assessment: heart failure, continue carvedilol. Follow up in 3 months.")],
      codedHccs: [],
      rules: RULES,
      model: MODEL,
    });
    expect(review.add[0].quote).toContain("heart failure");
    expect(review.add[0].quote).not.toContain("Follow up in 3 months");
  });

  it("separates a bare mention from a documented condition", () => {
    // A condition named in a history, with nothing monitoring, evaluating,
    // assessing or treating it, is the exact thing a RADV audit removes.
    const review = reviewConditions({
      documentation: [note("Past medical history includes COPD and hypertension.")],
      codedHccs: [],
      rules: RULES,
      model: MODEL,
    });
    expect(review.add).toHaveLength(0);
    expect(review.mentions).toHaveLength(1);
    expect(review.mentions[0].mentionOnly).toBe(true);
  });

  it("takes the strongest evidence in the chart, not the first note it reads", () => {
    // Order-dependence here is the worst kind of bug: an intake form listing
    // "history of COPD" ahead of the progress note that assesses and treats it
    // told a coder to drop a condition the record supports.
    const mention = { ...note("Past medical history includes COPD."), serviceDate: "20260101", source: "intake" };
    const documented = { ...note("Assessment: COPD, continue inhaler and monitoring."), source: "progress note" };

    for (const documentation of [[mention, documented], [documented, mention]]) {
      const review = reviewConditions({ documentation, codedHccs: [], rules: RULES, model: MODEL });
      expect(review.add).toHaveLength(1);
      expect(review.mentions).toHaveLength(0);
      expect(review.add[0].source).toBe("progress note");
    }
  });

  it("still reports a mention when that is genuinely all the chart has", () => {
    const review = reviewConditions({
      documentation: [note("Past medical history includes COPD."), note("Family history of emphysema.")],
      codedHccs: [],
      rules: RULES,
      model: MODEL,
    });
    expect(review.add).toHaveLength(0);
    expect(review.mentions).toHaveLength(1);
  });

  it("prefers the more recent note when the evidence is equally strong", () => {
    const early = { ...note("Assessment: COPD, continue inhaler."), serviceDate: "20260101" };
    const late = { ...note("Assessment: COPD, continue inhaler."), serviceDate: "20261101" };
    const review = reviewConditions({ documentation: [early, late], codedHccs: [], rules: RULES, model: MODEL });
    expect(review.add[0].serviceDate).toBe("20261101");
  });

  it("does not propose a condition that is already coded", () => {
    const review = reviewConditions({
      documentation: [note("Assessment: heart failure. Continue carvedilol.")],
      codedHccs: ["HCC226"],
      rules: RULES,
      model: MODEL,
    });
    expect(review.add).toHaveLength(0);
    expect(review.unsupported).toHaveLength(0);
  });

  it("looks the OTHER way too — coded with nothing supporting it", () => {
    // The structural property. A tool that only proposes additions can move a
    // risk score in one direction, which is what an upcoding engine is.
    const review = reviewConditions({
      documentation: [note("Assessment: COPD, continue inhaler.")],
      codedHccs: ["HCC226", "HCC280"],
      rules: RULES,
      model: MODEL,
    });
    expect(review.unsupported.map((u) => u.hcc)).toEqual(["HCC226"]);
    expect(review.add).toHaveLength(0);
  });

  it("nets the two directions, and the net can be negative", () => {
    const review = reviewConditions({
      documentation: [note("Assessment: COPD, continue inhaler.")],
      codedHccs: ["HCC226"],
      rules: RULES,
      model: MODEL,
    });
    // +0.169 COPD added, −0.331 heart failure unsupported.
    expect(review.netRaf).toBeCloseTo(0.169 - 0.331, 3);
    expect(review.netRaf).toBeLessThan(0);
  });

  it("flags a run where every proposal happens to raise the score", () => {
    const review = reviewConditions({
      documentation: [note("Assessment: heart failure, continue carvedilol.")],
      codedHccs: [],
      rules: RULES,
      model: MODEL,
    });
    expect(review.warnings.join(" ")).toContain("upcoding tool looks like");
  });

  it("does not flag that when the review found something in both directions", () => {
    const review = reviewConditions({
      documentation: [note("Assessment: COPD, continue inhaler.")],
      codedHccs: ["HCC226"],
      rules: RULES,
      model: MODEL,
    });
    expect(review.warnings.join(" ")).not.toContain("upcoding tool looks like");
  });

  it("skips a rule for a category the model does not have", () => {
    const review = reviewConditions({
      documentation: [note("Assessment: something.")],
      codedHccs: [],
      rules: [{ hcc: "HCC_NOPE", phrases: ["something"], suggestedCode: "X" }],
      model: MODEL,
    });
    expect(review.add).toHaveLength(0);
    expect(review.warnings.join(" ")).toContain("no such category");
  });
});

describe("renderSuspects", () => {
  const review = reviewConditions({
    documentation: [note("Assessment: COPD, continue inhaler. Past history includes diabetic neuropathy.")],
    codedHccs: ["HCC226"],
    rules: RULES,
    model: MODEL,
  });

  it("shows both directions in one report", () => {
    const text = renderSuspects(review);
    expect(text).toContain("Documented and not coded");
    expect(text).toContain("Coded this year with no supporting documentation");
  });

  it("tells the reader not to code a bare mention", () => {
    expect(renderSuspects(review)).toContain("do NOT code these");
  });

  it("says nothing here is a code", () => {
    expect(renderSuspects(review)).toContain("None of this is a code");
  });

  it("states the RADV extrapolation question as unsettled", () => {
    // Assuming it is dead invites sloppiness; assuming it is alive overstates a
    // live legal question.
    expect(renderSuspects(review)).toContain(RADV_EXTRAPOLATION_STATUS);
    expect(RADV_EXTRAPOLATION_STATUS).toContain("unsettled");
    expect(RADV_EXTRAPOLATION_STATUS).toContain("under appeal");
  });
});

// ── Quality measures ─────────────────────────────────────────────────────────

const enc = (patientRef: string, codes: string[], age = 60): Encounter => ({
  patientRef,
  serviceDate: "20260401",
  age,
  codes,
});

describe("computeMeasure", () => {
  const bp = MEASURES.find((m) => m.id === "MIPS-236")!;

  it("counts only patients in the denominator", () => {
    const r = computeMeasure(bp, [enc("A", ["I10", "3074F"]), enc("B", ["J44.9"])]);
    expect(r.denominator).toBe(1);
    expect(r.numerator).toBe(1);
    expect(r.rate).toBe(1);
  });

  it("respects the age bounds", () => {
    const r = computeMeasure(bp, [enc("YOUNG", ["I10", "3074F"], 12), enc("OLD", ["I10", "3074F"], 90)]);
    expect(r.denominator).toBe(0);
  });

  it("removes exclusions from the denominator", () => {
    const r = computeMeasure(bp, [enc("A", ["I10", "N18.6"]), enc("B", ["I10", "3074F"])]);
    expect(r.denominator).toBe(2);
    expect(r.excluded).toBe(1);
    expect(r.rate).toBe(1);
  });

  it("separates 'reported as not met' from 'not reported at all'", () => {
    // The distinction the whole module exists for: a patient whose blood
    // pressure was controlled and whose Category II code was never submitted
    // looks identical to one nobody measured.
    const r = computeMeasure(bp, [
      enc("MET", ["I10", "3074F"]),
      enc("NOTMET", ["I10", "3077F"]),
      enc("SILENT", ["I10"]),
    ]);
    expect(r.numerator).toBe(1);
    expect(r.notMet).toBe(1);
    expect(r.unreported).toBe(1);
    expect(r.rate).toBeCloseTo(1 / 3, 5);
    // Among those actually reported, performance is 50%.
    expect(r.rateIfReported).toBeCloseTo(0.5, 5);
  });

  it("rolls a patient's encounters together rather than counting visits", () => {
    const r = computeMeasure(bp, [enc("A", ["I10"]), enc("A", ["3074F"])]);
    expect(r.denominator).toBe(1);
    expect(r.numerator).toBe(1);
  });

  it("matches an ICD-10 category to its children", () => {
    expect(computeMeasure(bp, [enc("A", ["I11.9", "3074F"])]).denominator).toBe(1);
  });

  it("handles an empty population without dividing by zero", () => {
    const r = computeMeasure(bp, []);
    expect(r.rate).toBe(0);
    expect(r.rateIfReported).toBe(0);
  });

  it("marks the diabetes measure as inverse", () => {
    const a1c = MEASURES.find((m) => m.id === "MIPS-001")!;
    expect(computeMeasure(a1c, [enc("A", ["E11.9", "3046F"])]).inverse).toBe(true);
  });
});

describe("renderMeasures", () => {
  const bp = MEASURES.find((m) => m.id === "MIPS-236")!;

  it("says when a poor rate is a reporting problem rather than a performance one", () => {
    const encounters = [enc("MET", ["I10", "3074F"]), ...Array.from({ length: 6 }, (_, i) => enc(`S${i}`, ["I10"]))];
    const text = renderMeasures([computeMeasure(bp, encounters)]);
    expect(text).toContain("reporting problem before it is a performance one");
    expect(text).toContain("no Category II code either way");
  });

  it("does not claim a performance signal when nobody was reported on", () => {
    const text = renderMeasures([computeMeasure(bp, [enc("A", ["I10"]), enc("B", ["I10"])])]);
    expect(text).toContain("measures submission and not care");
    expect(text).not.toContain("Among the 0");
  });

  it("keeps one measure's wording out of another's report", () => {
    const depression = MEASURES.find((m) => m.id === "MIPS-134")!;
    const text = renderMeasures([
      computeMeasure(depression, [enc("A", ["99213", "G8431"]), ...Array.from({ length: 6 }, (_, i) => enc(`S${i}`, ["99213"]))]),
    ]);
    expect(text).toContain("reporting problem");
    expect(text).not.toContain("blood pressure");
  });

  it("marks the inverse measure so it is not read backwards", () => {
    const a1c = MEASURES.find((m) => m.id === "MIPS-001")!;
    expect(renderMeasures([computeMeasure(a1c, [enc("A", ["E11.9", "3046F"])])])).toContain("INVERSE");
  });

  it("always prints what a claim cannot see", () => {
    expect(renderMeasures([computeMeasure(bp, [enc("A", ["I10", "3074F"])])])).toContain("Category II");
  });

  it("says so when nobody is in any denominator", () => {
    expect(renderMeasures(computeAll([enc("A", ["Z01.00"])]))).toContain("No measure had anybody");
  });
});
