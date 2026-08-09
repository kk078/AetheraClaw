import { mulberry32, seedFrom, wilsonInterval } from "../compliance/sentinel.js";

// ── Coder training simulator ─────────────────────────────────────────────────
// Practice cases drawn from the work the practice actually does, scored with the
// reasoning rather than just the verdict.
//
// Two things make a coding trainer worse than useless, and both are easy to ship
// by accident:
//
//   GRADING ONE RIGHT ANSWER WHERE SEVERAL ARE DEFENSIBLE. Real coding has
//   genuine ambiguity — two coders reading the same note and choosing different
//   codes are often both defensible. A trainer that marks one of them wrong
//   teaches the coder to distrust a correct instinct, and worse, teaches that
//   coding questions have lookup answers. So a case carries defensible
//   alternatives and says why they are defensible.
//
//   MEASURING ACCURACY AND CALLING IT SKILL. The coder who costs a practice
//   money is not the one who gets things wrong — it is the one who gets things
//   wrong CONFIDENTLY, because nobody double-checks a coder who never flags
//   anything. So every attempt carries a stated confidence and the ledger
//   scores calibration alongside accuracy.
//
// And the case mix cuts both ways: calibrating to this practice's work is what
// makes the training relevant, and it is also why the trainer cannot test what
// the practice never sees. Blind spots are reported rather than left implied.

export type CaseKind = "diagnosis" | "procedure" | "modifier";

export interface CaseAnswer {
  code: string;
  why: string;
}

export interface TrainingCase {
  id: string;
  topic: string;
  /** 1 (routine) to 5 (the ones that go to a committee). */
  difficulty: number;
  kind: CaseKind;
  /** De-identified or synthetic scenario. Never a real chart. */
  scenario: string;
  /** Any of these is fully correct. */
  correct: string[];
  /** Defensible on the documentation given, worth partial credit. */
  defensible: CaseAnswer[];
  /** Named wrong answers, each with the reason it is wrong. */
  distractors: CaseAnswer[];
  rationale: string;
  /** Where the case came from — "synthetic" or a de-identified claim reference. */
  source: string;
}

export interface Attempt {
  caseId: string;
  answer: string;
  /** The learner's own stated confidence, 0 to 1. This is half the measurement. */
  confidence: number;
  answeredAt: number;
}

export type Verdict = "correct" | "defensible" | "incorrect";

export interface ScoredAttempt {
  caseId: string;
  topic: string;
  answer: string;
  confidence: number;
  verdict: Verdict;
  /** 1 for correct, 0.5 for defensible, 0 otherwise. */
  credit: number;
  explanation: string;
}

function normalize(code: string): string {
  return code.replace(/[.\s]/g, "").toUpperCase();
}

/**
 * Score one attempt, and explain it either way.
 *
 * A defensible answer is told that it is defensible AND why the keyed answer is
 * preferred — being told only "close" teaches nothing, and being told "wrong"
 * teaches the wrong thing.
 */
export function scoreAttempt(testCase: TrainingCase, attempt: Attempt): ScoredAttempt {
  const answer = normalize(attempt.answer);
  const base = {
    caseId: testCase.id,
    topic: testCase.topic,
    answer: attempt.answer,
    confidence: attempt.confidence,
  };

  if (testCase.correct.some((c) => normalize(c) === answer)) {
    return { ...base, verdict: "correct", credit: 1, explanation: testCase.rationale };
  }

  const defensible = testCase.defensible.find((d) => normalize(d.code) === answer);
  if (defensible) {
    return {
      ...base,
      verdict: "defensible",
      credit: 0.5,
      explanation: `${defensible.code} is defensible on this documentation: ${defensible.why} The keyed answer is ${testCase.correct[0]} — ${testCase.rationale} Two coders could file this differently and both survive an audit, which is worth knowing about this kind of case.`,
    };
  }

  const distractor = testCase.distractors.find((d) => normalize(d.code) === answer);
  return {
    ...base,
    verdict: "incorrect",
    credit: 0,
    explanation: distractor
      ? `${distractor.code} is wrong here: ${distractor.why} The answer is ${testCase.correct[0]} — ${testCase.rationale}`
      : `Not one of the answers this case anticipates. The answer is ${testCase.correct[0]} — ${testCase.rationale}`,
  };
}

/**
 * Brier score: mean squared error between stated confidence and being right.
 *
 * Lower is better; 0 is perfect calibration, 0.25 is what you get by saying 50%
 * to everything, and above that means the confidence is carrying no
 * information. Reported beside accuracy because they measure different things —
 * a coder at 70% accuracy who knows which 30% to flag is worth more than one at
 * 85% who flags nothing.
 */
export function brierScore(scored: ScoredAttempt[]): number {
  if (scored.length === 0) return 0;
  const total = scored.reduce((sum, s) => sum + (s.confidence - s.credit) ** 2, 0);
  return total / scored.length;
}

/** Confident and wrong: the specific failure that costs money. */
export const OVERCONFIDENCE_THRESHOLD = 0.8;

export interface TopicProgress {
  topic: string;
  attempted: number;
  correct: number;
  defensible: number;
  accuracy: number;
  /** Wilson interval on the accuracy — three attempts is not a skill level. */
  lower: number;
  upper: number;
}

export interface Progress {
  topics: TopicProgress[];
  attempted: number;
  accuracy: number;
  brier: number;
  /** Attempts answered with high confidence and scored incorrect. */
  confidentlyWrong: ScoredAttempt[];
  /** Attempts answered with low confidence and scored correct. */
  underconfident: ScoredAttempt[];
  notes: string[];
}

export function progress(scored: ScoredAttempt[]): Progress {
  const byTopic = new Map<string, ScoredAttempt[]>();
  for (const s of scored) {
    const list = byTopic.get(s.topic) ?? [];
    list.push(s);
    byTopic.set(s.topic, list);
  }

  const topics: TopicProgress[] = [...byTopic.entries()]
    .map(([topic, list]) => {
      const correct = list.filter((s) => s.verdict === "correct").length;
      const defensible = list.filter((s) => s.verdict === "defensible").length;
      const credit = list.reduce((sum, s) => sum + s.credit, 0);
      const interval = wilsonInterval(correct, list.length);
      return {
        topic,
        attempted: list.length,
        correct,
        defensible,
        accuracy: credit / list.length,
        lower: interval.lower,
        upper: interval.upper,
      };
    })
    .sort((a, b) => a.accuracy - b.accuracy);

  const credit = scored.reduce((sum, s) => sum + s.credit, 0);
  const confidentlyWrong = scored.filter((s) => s.verdict === "incorrect" && s.confidence >= OVERCONFIDENCE_THRESHOLD);
  const underconfident = scored.filter((s) => s.verdict === "correct" && s.confidence <= 1 - OVERCONFIDENCE_THRESHOLD);

  const notes: string[] = [];
  const brier = brierScore(scored);
  if (confidentlyWrong.length > 0) {
    notes.push(
      `${confidentlyWrong.length} answer(s) were wrong and stated at ${Math.round(OVERCONFIDENCE_THRESHOLD * 100)}% confidence or above. This is the pattern worth working on before raw accuracy — nobody double-checks a coder who never flags anything, so a confident error goes out on a claim.`,
    );
  }
  if (underconfident.length > 0) {
    notes.push(
      `${underconfident.length} correct answer(s) were flagged as uncertain. That is cheaper than the reverse, but it spends a reviewer's time on work that did not need it.`,
    );
  }
  if (brier > 0.25 && scored.length >= 10) {
    notes.push(
      `A Brier score of ${brier.toFixed(3)} is worse than answering 50% to everything (0.25), which means the stated confidence is carrying no information about correctness.`,
    );
  }
  for (const topic of topics) {
    if (topic.attempted < 5) {
      notes.push(
        `${topic.topic}: ${topic.attempted} attempt(s) is not a skill level. The interval runs ${(topic.lower * 100).toFixed(0)}–${(topic.upper * 100).toFixed(0)}%, which is most of the range.`,
      );
    }
  }

  return {
    topics,
    attempted: scored.length,
    accuracy: scored.length > 0 ? credit / scored.length : 0,
    brier,
    confidentlyWrong,
    underconfident,
    notes,
  };
}

/**
 * Pick cases weighted toward the practice's own mix, and name what that misses.
 *
 * The weighting is the point — a coder for a dermatology practice should be
 * drilled on what walks through that door. It is also the limitation: a case
 * bank shaped by the practice's history cannot ask about anything the practice
 * has never billed, and the day it bills one, the coder meets it for the first
 * time on a live claim.
 */
export interface CaseSelection {
  cases: TrainingCase[];
  /** Topics the practice bills that the case bank has nothing for. */
  blindSpots: string[];
  notes: string[];
}

/**
 * How much of the draw deliberately ignores the practice's mix.
 *
 * A pure weighting drills the coder hardest on what they already see every day
 * and never on what they see twice a year — which is backwards, because the
 * rare code is the one they have least practice at and the one that will be
 * miscoded when it turns up. A fifth of the draw is spread evenly across topics
 * so the tail is genuinely reachable rather than reachable in principle: an
 * additive floor small enough not to distort the common case is also small
 * enough that the rare topic never actually appears.
 */
export const EXPLORATION_SHARE = 0.2;

export function selectCases(
  bank: TrainingCase[],
  practiceTopics: Array<{ topic: string; weight: number }>,
  count: number,
  seed: string,
): CaseSelection {
  const rand = mulberry32(seedFrom(seed));
  const available = [...new Set(bank.map((c) => c.topic))];
  const blindSpots = practiceTopics.filter((t) => !available.includes(t.topic)).map((t) => t.topic);

  const casesPerTopic = new Map<string, number>();
  for (const c of bank) casesPerTopic.set(c.topic, (casesPerTopic.get(c.topic) ?? 0) + 1);

  // Weighted draw without replacement (exponential race). A topic's mass is
  // split across its own cases rather than multiplied by them — otherwise a
  // topic that happens to have more cases written for it outranks the practice's
  // actual mix, which is a property of the bank's authoring rather than of the
  // work.
  const pool = bank.map((c) => {
    const practiceWeight = practiceTopics.find((t) => t.topic === c.topic)?.weight ?? 0;
    const topicWeight =
      (1 - EXPLORATION_SHARE) * practiceWeight + EXPLORATION_SHARE / Math.max(1, available.length);
    const rate = topicWeight / Math.max(1, casesPerTopic.get(c.topic) ?? 1);
    return { testCase: c, key: -Math.log(rand() + 1e-12) / rate };
  });
  pool.sort((a, b) => a.key - b.key);

  const notes: string[] = [];
  if (blindSpots.length > 0) {
    notes.push(
      `The practice bills ${blindSpots.join(", ")} and the case bank has nothing for ${blindSpots.length === 1 ? "it" : "them"}. A coder trained only on this bank will meet ${blindSpots.length === 1 ? "that" : "those"} for the first time on a live claim.`,
    );
  }
  if (bank.length < count) {
    notes.push(`Only ${bank.length} case(s) in the bank; ${count} were requested.`);
  }
  notes.push(
    "Cases are weighted toward what this practice actually bills. That is what makes them relevant and it is also the ceiling on what they can test.",
  );

  return { cases: pool.slice(0, count).map((p) => p.testCase), blindSpots, notes };
}

export function renderProgress(result: Progress): string {
  if (result.attempted === 0) return "No attempts recorded yet.";
  const lines = [
    `${result.attempted} attempt(s), ${(result.accuracy * 100).toFixed(0)}% credit, Brier ${result.brier.toFixed(3)} (0 is perfect calibration, 0.25 is what saying "50%" to everything gets you).`,
    "",
    "By topic, weakest first:",
  ];
  for (const t of result.topics) {
    lines.push(
      `  ${t.topic}: ${(t.accuracy * 100).toFixed(0)}% over ${t.attempted} attempt(s) — ${t.correct} correct, ${t.defensible} defensible. 95% CI ${(t.lower * 100).toFixed(0)}–${(t.upper * 100).toFixed(0)}%.`,
    );
  }
  if (result.confidentlyWrong.length > 0) {
    lines.push("", "Confident and wrong:");
    for (const s of result.confidentlyWrong) {
      lines.push(`  ${s.caseId} (${s.topic}) — answered ${s.answer} at ${Math.round(s.confidence * 100)}%. ${s.explanation}`);
    }
  }
  lines.push("", ...result.notes.map((n) => `  ${n}`));
  return lines.join("\n");
}
