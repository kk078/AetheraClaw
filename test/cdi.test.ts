import { describe, expect, it } from "vitest";
import {
  ESCAPE_OPTIONS,
  QUERY_BRIEF_STATUS,
  buildQuery,
  checkQueryCompliance,
  checkResponseOverwrite,
  renderQuery,
  type PhysicianQuery,
} from "../src/cdi/query.js";
import {
  DIMENSION_OPTIONS,
  analyzeNote,
  queryFor,
  rankFindings,
  renderFindings,
  summarize,
  type NoteExcerpt,
  type SpecificityRule,
} from "../src/cdi/realtime.js";
import {
  COVERAGE_FRESH_DAYS,
  ELIGIBILITY_FRESH_DAYS,
  greenlight,
  renderGreenlight,
  type GreenlightInput,
} from "../src/cdi/greenlight.js";
import {
  OVERCONFIDENCE_THRESHOLD,
  brierScore,
  progress,
  renderProgress,
  scoreAttempt,
  selectCases,
  type ScoredAttempt,
  type TrainingCase,
} from "../src/training/simulator.js";

const DAY = 86_400_000;

// ── Compliant queries ────────────────────────────────────────────────────────

describe("physician queries", () => {
  const base = {
    patientRef: "PT-9",
    clinicalIndicators: ["Creatinine 2.4, up from 1.1 three weeks ago.", "Urine output 300 mL over 24 hours."],
    author: "CDI",
  };

  it("builds a compliant multiple-choice query and appends every escape option", () => {
    const built = buildQuery({
      ...base,
      format: "multiple_choice",
      question: "The findings above are documented without a stated diagnosis. If the clinical picture supports one, which applies?",
      options: ["Acute kidney injury", "Chronic kidney disease", "Acute on chronic kidney disease"],
    });
    expect(typeof built).not.toBe("string");
    const query = built as PhysicianQuery;

    expect(query.options.filter((o) => !o.escape)).toHaveLength(3);
    for (const escape of ESCAPE_OPTIONS) {
      expect(query.options.some((o) => o.escape && o.text === escape)).toBe(true);
    }
    expect(checkQueryCompliance(query).compliant).toBe(true);
    expect(renderQuery(query)).toMatch(/carries no preferred answer/);
  });

  // The financial patterns are the ones that end careers, so each is asserted
  // individually rather than as a group.
  it.each([
    ["Documenting acute kidney injury here would increase reimbursement for this stay.", /reimburse/i],
    ["Please document acute kidney injury given the creatinine trend.", /please document/i],
    ["Would you agree the patient has acute kidney injury?", /would you agree/i],
    ["Clarifying this would allow us to capture the HCC.", /hcc capture|would (let|allow) us/i],
    ["The patient clearly has acute kidney injury — please confirm.", /clearly ha/i],
  ])("refuses a leading question: %j", (question, expected) => {
    const built = buildQuery({ ...base, format: "open_ended", question });
    expect(typeof built).toBe("string");
    expect(built as string).toMatch(/^Not sent/);
    expect((built as string).toLowerCase()).toMatch(expected);
  });

  it("refuses a query with no clinical indicators", () => {
    const built = buildQuery({
      ...base,
      clinicalIndicators: [],
      format: "open_ended",
      question: "Is there a further diagnosis you would document for this encounter?",
    });
    expect(built as string).toMatch(/definition of leading/);
  });

  it("refuses a menu with no way off it", () => {
    const naked: PhysicianQuery = {
      patientRef: "PT-9",
      format: "multiple_choice",
      question: "Which applies?",
      clinicalIndicators: ["Creatinine 2.4."],
      options: [
        { text: "Acute kidney injury", escape: false },
        { text: "Chronic kidney disease", escape: false },
      ],
      alreadyDocumentedAt: "",
      author: "CDI",
    };
    const check = checkQueryCompliance(naked);
    expect(check.compliant).toBe(false);
    expect(check.problems.join(" ")).toMatch(/no way off it/);
  });

  it("permits a single clinical option but says out loud what it looks like", () => {
    const built = buildQuery({
      ...base,
      format: "multiple_choice",
      question: "If the clinical picture supports a diagnosis, which applies?",
      options: ["Acute kidney injury"],
    }) as PhysicianQuery;
    expect(typeof built).not.toBe("string");
    const check = checkQueryCompliance(built);
    expect(check.compliant).toBe(true);
    expect(check.notes.join(" ")).toMatch(/exactly what a leading query looks like/);
  });

  it("lets a yes/no query verify a documented diagnosis and refuses one that introduces it", () => {
    const verifying = buildQuery({
      ...base,
      format: "yes_no",
      question: "Does the acute kidney injury documented in the progress note remain an active diagnosis at discharge?",
      alreadyDocumentedAt: "progress note, 2026-03-02",
    }) as PhysicianQuery;
    expect(typeof verifying).not.toBe("string");
    expect(verifying.options.some((o) => /unable to determine/i.test(o.text))).toBe(true);

    const introducing = buildQuery({
      ...base,
      format: "yes_no",
      question: "Does this patient have acute kidney injury?",
    });
    expect(introducing as string).toMatch(/may only verify a diagnosis already documented/);
  });

  it("refuses an open-ended query carrying options", () => {
    const mislabelled: PhysicianQuery = {
      patientRef: "PT-9",
      format: "open_ended",
      question: "What is the diagnosis?",
      clinicalIndicators: ["Creatinine 2.4."],
      options: [{ text: "Acute kidney injury", escape: false }],
      alreadyDocumentedAt: "",
      author: "CDI",
    };
    expect(checkQueryCompliance(mislabelled).problems.join(" ")).toMatch(/mislabelled|Label it as one/);
  });

  // Replacing an answered query with a different answer is what "re-query until
  // the provider says the right thing" looks like once it reaches the database:
  // the first answer disappears and the record shows one clean response.
  it("refuses to overwrite an answered query without a stated reason", () => {
    const answered = { response: "Diastolic (HFpEF)", respondedBy: "Dr. A", respondedAt: 1, amendReason: "" };
    expect(checkResponseOverwrite(answered, "")).toMatch(/re-querying until the provider agrees/);
    expect(checkResponseOverwrite(answered, "provider corrected the answer by phone")).toBe("");
    expect(checkResponseOverwrite(null, "")).toBe("");
    expect(checkResponseOverwrite({ ...answered, response: "" }, "")).toBe("");
  });

  it("names which brief version it checked against", () => {
    const check = checkQueryCompliance({
      patientRef: "PT-9",
      format: "open_ended",
      question: "Is there a further diagnosis the findings above support?",
      clinicalIndicators: ["Creatinine 2.4."],
      options: [],
      alreadyDocumentedAt: "",
      author: "CDI",
    });
    expect(check.compliant).toBe(true);
    expect(check.notes).toContain(QUERY_BRIEF_STATUS);
    expect(QUERY_BRIEF_STATUS).toMatch(/2022 Update, which is the operative version/);
    expect(QUERY_BRIEF_STATUS).toMatch(/2026 Update is in progress/);
  });
});

// ── Specificity findings ─────────────────────────────────────────────────────

describe("cdi analysis", () => {
  const rules: SpecificityRule[] = [
    {
      id: "knee-laterality",
      triggers: ["osteoarthritis of the knee", "knee oa"],
      dimension: "laterality",
      needs: "which side",
      unspecifiedCode: "M17.9",
      affectsRiskAdjustment: false,
    },
    {
      id: "chf-type",
      triggers: ["heart failure"],
      dimension: "type",
      needs: "systolic or diastolic, and acute or chronic",
      unspecifiedCode: "I50.9",
      affectsRiskAdjustment: true,
      options: ["Systolic (HFrEF)", "Diastolic (HFpEF)", "Combined systolic and diastolic"],
    },
  ];

  const note: NoteExcerpt = {
    patientRef: "PT-9",
    serviceDate: "20260302",
    source: "progress note",
    text: "Patient reports ongoing pain. Osteoarthritis of the knee is stable on current therapy. Heart failure noted in history. Continue lisinopril 10 mg daily for heart failure, monitoring weight.",
  };

  it("quotes the sentence verbatim and records where it came from", () => {
    const findings = analyzeNote(note, rules);
    const knee = findings.find((f) => f.ruleId === "knee-laterality")!;
    expect(knee.quote).toBe("Osteoarthritis of the knee is stable on current therapy.");
    expect(note.text.slice(knee.offset, knee.offset + "osteoarthritis of the knee".length).toLowerCase()).toBe(
      "osteoarthritis of the knee",
    );
    expect(knee.rationale).toContain("M17.9");
  });

  it("reports one finding per sentence rather than one per note", () => {
    // "heart failure" appears in two different sentences; both are places a
    // reviewer has to look, so collapsing them would hide one.
    const chf = analyzeNote(note, rules).filter((f) => f.ruleId === "chf-type");
    expect(chf).toHaveLength(2);
    expect(chf[0].quote).not.toBe(chf[1].quote);
  });

  it("carries MEAT evidence from the sentence it quoted", () => {
    const findings = analyzeNote(note, rules);
    const treated = findings.find((f) => f.quote.includes("Continue lisinopril"))!;
    expect(treated.meat).toContain("treat");
    const mention = findings.find((f) => f.quote === "Heart failure noted in history.")!;
    expect(mention.meat).toEqual([]);
  });

  it("ranks risk-adjusting gaps above cosmetic ones, and MEAT above bare mentions", () => {
    const ranked = rankFindings(analyzeNote(note, rules));
    expect(ranked[0].ruleId).toBe("chf-type");
    expect(ranked[0].meat.length).toBeGreaterThan(0);
    expect(ranked[ranked.length - 1].ruleId).toBe("knee-laterality");
  });

  it("says plainly that a bare mention is not worth a query", () => {
    const summary = summarize(analyzeNote(note, rules));
    expect(summary.notes.join(" ")).toMatch(/a provider is right to ignore/);
    expect(summary.notes.join(" ")).toMatch(/Unspecified is frequently the correct answer/);
    expect(renderFindings(summary)).toMatch(/specificity gap/);
  });

  it("reports an empty result as nothing having fired, not as a clean note", () => {
    const summary = summarize(analyzeNote({ ...note, text: "Routine visit, no complaints." }, rules));
    expect(summary.notes[0]).toMatch(/not the same as a complete note/);
  });

  it("builds the query from the AXIS, never from a guess at the answer", () => {
    const findings = rankFindings(analyzeNote(note, rules));
    const laterality = findings.find((f) => f.dimension === "laterality")!;
    const query = queryFor(laterality, "CDI") as PhysicianQuery;

    expect(typeof query).not.toBe("string");
    // Exhaustive and neutral: this is what makes a generated query non-leading.
    expect(query.options.filter((o) => !o.escape).map((o) => o.text)).toEqual(DIMENSION_OPTIONS.laterality);
    expect(query.clinicalIndicators).toEqual([laterality.quote]);
    expect(checkQueryCompliance(query).compliant).toBe(true);

    const chf = findings.find((f) => f.dimension === "type")!;
    const narrowed = queryFor(chf, "CDI", rules[1]) as PhysicianQuery;
    expect(narrowed.options.filter((o) => !o.escape).map((o) => o.text)).toEqual(rules[1].options);
  });
});

// ── Pre-service clearance ────────────────────────────────────────────────────

describe("greenlight", () => {
  const serviceDate = "20260320";
  const serviceMs = Date.UTC(2026, 2, 20);

  const clean = (): GreenlightInput => ({
    patientRef: "PT-9",
    serviceDate,
    code: "72148",
    payer: "Acme Health",
    network: "in",
    eligibility: {
      checked: true,
      active: true,
      checkedAt: serviceMs - 2 * DAY,
      planName: "Acme PPO",
      copayCents: 4_000,
      deductibleRemainingCents: 0,
    },
    priorAuth: { requirement: "not_required", authNumber: "", expiresOn: "", checkedAt: serviceMs },
    coverage: { status: "covered", policy: "L12345", checkedAt: serviceMs - 10 * DAY },
    estimate: { allowedCents: 45_000, source: "MPFS" },
  });

  it("clears a clean case and says the clearance is only as fresh as its checks", () => {
    const result = greenlight(clean());
    expect(result.verdict).toBe("go");
    expect(result.blockers).toEqual([]);
    expect(result.cautions).toEqual([]);
    expect(result.patientOwesCents).toBe(4_000);
    expect(result.notes.join(" ")).toMatch(/only as long as those checks stay fresh/);
    expect(renderGreenlight(clean(), result)).toMatch(/^GO/);
  });

  // The failure this module exists to prevent: unknown mapped to a middling
  // score, read as mostly fine, service rendered.
  it("treats an unknown authorization requirement as a STOP, not a risk to price in", () => {
    const result = greenlight({ ...clean(), priorAuth: { ...clean().priorAuth, requirement: "unknown" } });
    expect(result.verdict).toBe("stop");
    expect(result.blockers.join(" ")).toMatch(/cannot be worked around after the fact/);
  });

  it("stops on a required authorization that is missing or expired", () => {
    const missing = greenlight({ ...clean(), priorAuth: { ...clean().priorAuth, requirement: "required" } });
    expect(missing.verdict).toBe("stop");
    expect(missing.blockers.join(" ")).toMatch(/CARC 197/);

    const expired = greenlight({
      ...clean(),
      priorAuth: { requirement: "required", authNumber: "AUTH-1", expiresOn: "20260319", checkedAt: serviceMs },
    });
    expect(expired.verdict).toBe("stop");
    expect(expired.blockers.join(" ")).toMatch(/expired on 20260319/);

    const valid = greenlight({
      ...clean(),
      priorAuth: { requirement: "required", authNumber: "AUTH-1", expiresOn: "20260321", checkedAt: serviceMs },
    });
    expect(valid.verdict).toBe("go");
  });

  it("stops on an inactive or unverified policy", () => {
    const inactive = greenlight({ ...clean(), eligibility: { ...clean().eligibility, active: false } });
    expect(inactive.verdict).toBe("stop");
    expect(inactive.blockers.join(" ")).toMatch(/self-pay visit/);
    expect(inactive.patientOwesCents).toBe(0);
    expect(inactive.patientOwesBasis).toMatch(/no benefit design to compute against/);

    const unchecked = greenlight({ ...clean(), eligibility: { ...clean().eligibility, checked: false } });
    expect(unchecked.verdict).toBe("stop");
    expect(unchecked.blockers[0]).toMatch(/arithmetic on an assumption/);
  });

  it("catches a stale verification by day count and by calendar month", () => {
    const stale = greenlight({
      ...clean(),
      eligibility: { ...clean().eligibility, checkedAt: serviceMs - (ELIGIBILITY_FRESH_DAYS + 1) * DAY },
    });
    expect(stale.verdict).toBe("stop");
    expect(stale.blockers.join(" ")).toMatch(/record of what used to be true/);

    // Nine days old — well inside the day limit — but from February, and
    // commercial coverage terminates at month end.
    const lastMonth = greenlight({ ...clean(), eligibility: { ...clean().eligibility, checkedAt: Date.UTC(2026, 1, 28) } });
    expect(lastMonth.verdict).toBe("caution");
    expect(lastMonth.cautions.join(" ")).toMatch(/terminates at month end/);
  });

  it("stops on a non-covered service and names the ABN", () => {
    const result = greenlight({ ...clean(), coverage: { ...clean().coverage, status: "not_covered" } });
    expect(result.verdict).toBe("stop");
    expect(result.blockers.join(" ")).toMatch(/ABN/);
  });

  it("cautions on unknown coverage, conditional coverage, and a stale determination", () => {
    expect(greenlight({ ...clean(), coverage: { ...clean().coverage, status: "unknown" } }).verdict).toBe("caution");
    expect(greenlight({ ...clean(), coverage: { ...clean().coverage, status: "conditional" } }).verdict).toBe("caution");

    const old = greenlight({
      ...clean(),
      coverage: { ...clean().coverage, checkedAt: serviceMs - (COVERAGE_FRESH_DAYS + 1) * DAY },
    });
    expect(old.cautions.join(" ")).toMatch(/change without notice/);
  });

  it("raises the No Surprises Act on an out-of-network service", () => {
    const result = greenlight({ ...clean(), network: "out" });
    expect(result.verdict).toBe("caution");
    expect(result.cautions.join(" ")).toMatch(/cannot be collected at the desk on the day/);
  });

  // The most common front-desk error there is.
  it("charges the allowed amount under a deductible rather than the copay", () => {
    const result = greenlight({
      ...clean(),
      eligibility: { ...clean().eligibility, deductibleRemainingCents: 120_000 },
    });
    expect(result.patientOwesCents).toBe(45_000);
    expect(result.patientOwesBasis).toMatch(/under-collect by \$410\.00/);

    // And never more than the service itself costs.
    const nearlyMet = greenlight({
      ...clean(),
      eligibility: { ...clean().eligibility, deductibleRemainingCents: 10_000 },
    });
    expect(nearlyMet.patientOwesCents).toBe(10_000);
  });

  it("refuses to reduce the answer to a percentage", () => {
    const result = greenlight({
      ...clean(),
      eligibility: { ...clean().eligibility, active: false },
      priorAuth: { ...clean().priorAuth, requirement: "unknown" },
    });
    expect(result).not.toHaveProperty("score");
    expect(result.notes.join(" ")).toMatch(/three greens and a terminated policy is not 75% clear/);
  });
});

// ── Training simulator ───────────────────────────────────────────────────────

describe("training simulator", () => {
  const testCase: TrainingCase = {
    id: "case-1",
    topic: "E/M",
    difficulty: 3,
    kind: "procedure",
    scenario: "Established patient, two stable chronic conditions reviewed, prescription drug management. 25 minutes total on the date of the encounter.",
    correct: ["99214"],
    defensible: [
      { code: "99213", why: "a reviewer counting the same two stable problems as low complexity lands here, and the note does not settle it." },
    ],
    distractors: [{ code: "99215", why: "high complexity needs more than two stable chronic conditions — this is the level that draws an audit." }],
    rationale: "Two stable chronic conditions plus prescription drug management is moderate MDM, which is 99214.",
    source: "synthetic",
  };

  const attempt = (answer: string, confidence: number) => ({
    caseId: "case-1",
    answer,
    confidence,
    answeredAt: 1,
  });

  it("scores the keyed answer correct with its rationale", () => {
    const scored = scoreAttempt(testCase, attempt("99214", 0.9));
    expect(scored.verdict).toBe("correct");
    expect(scored.credit).toBe(1);
    expect(scored.explanation).toBe(testCase.rationale);
  });

  // Grading one right answer where two are defensible is the thing that teaches
  // a coder to distrust a correct instinct.
  it("gives a defensible alternative partial credit and explains both sides", () => {
    const scored = scoreAttempt(testCase, attempt("99213", 0.6));
    expect(scored.verdict).toBe("defensible");
    expect(scored.credit).toBe(0.5);
    expect(scored.explanation).toMatch(/is defensible on this documentation/);
    expect(scored.explanation).toMatch(/The keyed answer is 99214/);
    expect(scored.explanation).toMatch(/both survive an audit/);
  });

  it("explains a named distractor and an unanticipated answer differently", () => {
    expect(scoreAttempt(testCase, attempt("99215", 0.7)).explanation).toMatch(/draws an audit/);
    expect(scoreAttempt(testCase, attempt("11042", 0.7)).explanation).toMatch(/Not one of the answers this case anticipates/);
  });

  it("normalizes formatting rather than failing a right answer on punctuation", () => {
    expect(scoreAttempt(testCase, attempt(" 99214 ", 0.9)).verdict).toBe("correct");
  });

  it("computes the Brier score against known values", () => {
    // Perfect: certain and right, certain and wrong is 1 — so a single
    // confident error is the worst possible single contribution.
    expect(brierScore([mk("correct", 1, 1)])).toBeCloseTo(0, 9);
    expect(brierScore([mk("incorrect", 0, 1)])).toBeCloseTo(1, 9);
    // Saying 50% to everything gives 0.25 whatever happens.
    expect(brierScore([mk("correct", 1, 0.5), mk("incorrect", 0, 0.5)])).toBeCloseTo(0.25, 9);
    expect(brierScore([])).toBe(0);
  });

  it("separates confident errors from cautious correct answers", () => {
    const scored = [
      mk("incorrect", 0, 0.95, "E/M"),
      mk("incorrect", 0, 0.3, "E/M"),
      mk("correct", 1, 0.1, "ICD-10"),
      mk("correct", 1, 0.9, "ICD-10"),
    ];
    const result = progress(scored);
    expect(result.confidentlyWrong).toHaveLength(1);
    expect(result.confidentlyWrong[0].confidence).toBeGreaterThanOrEqual(OVERCONFIDENCE_THRESHOLD);
    expect(result.underconfident).toHaveLength(1);
    expect(result.notes.join(" ")).toMatch(/nobody double-checks a coder who never flags anything/);
    expect(result.notes.join(" ")).toMatch(/cheaper than the reverse/);
  });

  it("reports a thin topic as an interval rather than as a skill level", () => {
    const result = progress([mk("correct", 1, 0.8, "modifiers"), mk("incorrect", 0, 0.6, "modifiers")]);
    const topic = result.topics.find((t) => t.topic === "modifiers")!;
    expect(topic.attempted).toBe(2);
    expect(topic.upper - topic.lower).toBeGreaterThan(0.5);
    expect(result.notes.join(" ")).toMatch(/is not a skill level/);
    expect(renderProgress(result)).toMatch(/Brier/);
  });

  it("orders topics weakest first and calls out uninformative confidence", () => {
    const scored = [
      ...Array.from({ length: 6 }, () => mk("correct", 1, 0.2, "strong")),
      ...Array.from({ length: 6 }, () => mk("incorrect", 0, 0.9, "weak")),
    ];
    const result = progress(scored);
    expect(result.topics[0].topic).toBe("weak");
    expect(result.brier).toBeGreaterThan(0.25);
    expect(result.notes.join(" ")).toMatch(/carrying no information about correctness/);
  });

  it("says nothing rather than something when there are no attempts", () => {
    expect(renderProgress(progress([]))).toBe("No attempts recorded yet.");
  });

  it("weights the draw toward the practice's mix and names what the bank misses", () => {
    const bank: TrainingCase[] = ["99", "11", "72"].flatMap((prefix) =>
      Array.from({ length: 4 }, (_, i) => ({ ...testCase, id: `${prefix}-${i}`, topic: prefix })),
    );
    const selection = selectCases(bank, [{ topic: "99", weight: 0.9 }, { topic: "11", weight: 0.1 }, { topic: "88", weight: 0.4 }], 6, "s");

    expect(selection.cases).toHaveLength(6);
    expect(selection.cases.filter((c) => c.topic === "99").length).toBeGreaterThan(1);
    expect(selection.blindSpots).toEqual(["88"]);
    expect(selection.notes.join(" ")).toMatch(/for the first time on a live claim/);
    expect(selection.notes.join(" ")).toMatch(/ceiling on what they can test/);
  });

  it("draws the same set for the same seed and a different one otherwise", () => {
    const bank: TrainingCase[] = Array.from({ length: 10 }, (_, i) => ({ ...testCase, id: `c-${i}`, topic: `t${i % 3}` }));
    const topics = [{ topic: "t0", weight: 0.5 }];
    const a = selectCases(bank, topics, 4, "seed-a").cases.map((c) => c.id);
    expect(selectCases(bank, topics, 4, "seed-a").cases.map((c) => c.id)).toEqual(a);
    expect(selectCases(bank, topics, 4, "seed-b").cases.map((c) => c.id)).not.toEqual(a);
  });

  it("keeps a rarely billed topic reachable rather than dropping it to zero", () => {
    // The topic a practice bills least is the one its coders have least practice
    // at, so a pure weighting would guarantee they never meet it here either.
    const bank: TrainingCase[] = Array.from({ length: 6 }, (_, i) => ({
      ...testCase,
      id: `c-${i}`,
      topic: i < 5 ? "common" : "rare",
    }));
    const drawn = Array.from({ length: 40 }, (_, i) =>
      selectCases(bank, [{ topic: "common", weight: 0.99 }], 2, `seed-${i}`).cases.map((c) => c.topic),
    ).flat();
    const rare = drawn.filter((t) => t === "rare").length;

    // Reachable in practice, not merely non-zero in the arithmetic: a floor
    // small enough not to distort the common case is also small enough that the
    // rare topic never actually turns up.
    expect(rare).toBeGreaterThan(3);
    // And still clearly the minority — the weighting is supposed to work.
    expect(rare).toBeLessThan(drawn.length / 2);
  });

  it("splits a topic's mass across its cases rather than multiplying by them", () => {
    // Two topics the practice bills equally, but one had four times as many
    // cases written for it. That is a fact about the bank's authoring, not about
    // the work, and it must not outvote the mix.
    const bank: TrainingCase[] = [
      ...Array.from({ length: 8 }, (_, i) => ({ ...testCase, id: `big-${i}`, topic: "big" })),
      ...Array.from({ length: 2 }, (_, i) => ({ ...testCase, id: `small-${i}`, topic: "small" })),
    ];
    const drawn = Array.from({ length: 60 }, (_, i) =>
      selectCases(bank, [{ topic: "big", weight: 0.5 }, { topic: "small", weight: 0.5 }], 1, `s-${i}`).cases.map(
        (c) => c.topic,
      ),
    ).flat();
    const small = drawn.filter((t) => t === "small").length;
    expect(small / drawn.length).toBeGreaterThan(0.3);
    expect(small / drawn.length).toBeLessThan(0.7);
  });
});

function mk(verdict: ScoredAttempt["verdict"], credit: number, confidence: number, topic = "E/M"): ScoredAttempt {
  return { caseId: "case-1", topic, answer: "x", confidence, verdict, credit, explanation: "" };
}
