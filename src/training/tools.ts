import { z } from "zod";
import { defineTool } from "../tools/registry.js";
import { newId } from "../shared/ids.js";
import type { MemoryStore } from "../memory/store.js";
import { loadEras } from "../tools/healthcare/analytics.js";
import {
  progress,
  renderProgress,
  scoreAttempt,
  selectCases,
  type ScoredAttempt,
  type TrainingCase,
} from "./simulator.js";

type Ctx = { services: Record<string, unknown> };
const store = (ctx: Ctx) => ctx.services.store as MemoryStore;

function loadBank(ctx: Ctx): TrainingCase[] {
  return (store(ctx).db.prepare("SELECT case_json FROM training_cases").all() as Array<{ case_json: string }>).map(
    (r) => JSON.parse(r.case_json) as TrainingCase,
  );
}

/**
 * The practice's own topic mix, taken from what it has actually been paid for.
 *
 * Codes are grouped by their first three characters, which is a rough proxy for
 * a topic and an honest one — it is what the remittances can support without
 * inventing a taxonomy.
 */
function practiceTopics(ctx: Ctx): Array<{ topic: string; weight: number }> {
  const counts = new Map<string, number>();
  let total = 0;
  for (const { era } of loadEras(store(ctx))) {
    for (const claim of era.claims) {
      for (const line of claim.lines) {
        const topic = line.procedure.replace(/[.\s]/g, "").toUpperCase().slice(0, 3);
        if (!topic) continue;
        counts.set(topic, (counts.get(topic) ?? 0) + 1);
        total++;
      }
    }
  }
  return [...counts.entries()].map(([topic, n]) => ({ topic, weight: n / Math.max(1, total) }));
}

export const trainingCaseAddTool = defineTool({
  name: "training_case_add",
  description:
    "Add a coding case to the training bank. Include defensible alternatives where the documentation genuinely supports more than one answer — grading a single right answer where two coders would both survive an audit teaches a coder to distrust a correct instinct, and teaches that coding questions have lookup answers.",
  schema: z.object({
    topic: z.string(),
    difficulty: z.number().int().min(1).max(5).default(2),
    kind: z.enum(["diagnosis", "procedure", "modifier"]).default("diagnosis"),
    scenario: z.string().describe("De-identified or synthetic. Never a real chart."),
    correct: z.array(z.string()).min(1),
    defensible: z.array(z.object({ code: z.string(), why: z.string() })).default([]),
    distractors: z.array(z.object({ code: z.string(), why: z.string() })).default([]),
    rationale: z.string(),
    source: z.string().default("synthetic"),
  }),
  execute: async (input, ctx) => {
    const id = newId("case");
    const testCase: TrainingCase = {
      id,
      topic: input.topic,
      difficulty: input.difficulty,
      kind: input.kind,
      scenario: input.scenario,
      correct: input.correct,
      defensible: input.defensible,
      distractors: input.distractors,
      rationale: input.rationale,
      source: input.source,
    };
    store(ctx)
      .db.prepare(
        "INSERT INTO training_cases (id, topic, difficulty, kind, case_json, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.topic, input.difficulty, input.kind, JSON.stringify(testCase), input.source, Date.now());
    return {
      content: [
        `Case ${id} added — ${input.topic}, difficulty ${input.difficulty}.`,
        input.defensible.length === 0
          ? "No defensible alternatives recorded. If this case genuinely has one right answer that is fine; if it does not, a coder who picks the other reasonable code will be told they were wrong."
          : `${input.defensible.length} defensible alternative(s) recorded.`,
      ].join("\n"),
    };
  },
});

export const trainingDrillTool = defineTool({
  name: "training_drill",
  description:
    "Draw practice cases weighted toward what this practice actually bills, and name what that weighting misses. The weighting is what makes the drill relevant and it is also its ceiling: a bank shaped by the practice's history cannot ask about anything the practice has never billed.",
  schema: z.object({
    count: z.number().int().min(1).max(25).default(5),
    seed: z.string().default("drill").describe("Same seed draws the same set."),
    show_answers: z.boolean().default(false),
  }),
  execute: async (input, ctx) => {
    const bank = loadBank(ctx);
    if (bank.length === 0) return { content: "The case bank is empty. Add cases with training_case_add.", isError: true };

    const selection = selectCases(bank, practiceTopics(ctx), input.count, input.seed);
    const lines: string[] = [];
    for (const c of selection.cases) {
      lines.push(
        `${c.id} — ${c.topic}, difficulty ${c.difficulty}, ${c.kind}`,
        `  ${c.scenario}`,
        ...(input.show_answers
          ? [
              `  Answer: ${c.correct.join(" or ")}. ${c.rationale}`,
              ...c.defensible.map((d) => `  Also defensible: ${d.code} — ${d.why}`),
            ]
          : []),
        "",
      );
    }
    lines.push(...selection.notes.map((n) => `  ${n}`));
    return { content: lines.join("\n") };
  },
});

export const trainingAnswerTool = defineTool({
  name: "training_answer",
  description:
    "Answer a case with a stated confidence, and get the reasoning either way. Confidence is required because accuracy alone cannot separate a coder who knows what they do not know from one who does not — and it is the confident error that reaches a claim, since nobody double-checks a coder who never flags anything.",
  schema: z.object({
    case_id: z.string(),
    answer: z.string(),
    confidence: z.number().min(0).max(1).describe("How sure you are, 0 to 1. Answer honestly; this is half the measurement."),
    learner: z.string().default("coder"),
  }),
  execute: async (input, ctx) => {
    const row = store(ctx).db.prepare("SELECT case_json FROM training_cases WHERE id = ?").get(input.case_id) as
      | { case_json: string }
      | undefined;
    if (!row) return { content: `No case ${input.case_id}.`, isError: true };

    const testCase = JSON.parse(row.case_json) as TrainingCase;
    const now = Date.now();
    const scored = scoreAttempt(testCase, {
      caseId: input.case_id,
      answer: input.answer,
      confidence: input.confidence,
      answeredAt: now,
    });

    store(ctx)
      .db.prepare(
        `INSERT INTO training_attempts (id, case_id, learner, topic, answer, confidence, verdict, credit, explanation, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("att"),
        input.case_id,
        input.learner,
        testCase.topic,
        input.answer,
        input.confidence,
        scored.verdict,
        scored.credit,
        scored.explanation,
        now,
      );

    const label = { correct: "Correct", defensible: "Defensible", incorrect: "Incorrect" }[scored.verdict];
    const lines = [`${label}.`, "", scored.explanation];
    if (scored.verdict === "incorrect" && input.confidence >= 0.8) {
      lines.push(
        "",
        "Answered wrong at high confidence. That is the pattern worth fixing before raw accuracy — an error nobody was asked to check goes out on a claim.",
      );
    }
    return { content: lines.join("\n"), isError: false };
  },
});

export const trainingProgressTool = defineTool({
  name: "training_progress",
  description:
    "Progress by topic, with accuracy and calibration side by side. A Brier score says whether stated confidence carries information about correctness; 0.25 is what answering 50% to everything gets you. Topics with few attempts show their interval rather than a number, because three attempts is not a skill level.",
  schema: z.object({ learner: z.string().default("") }),
  execute: async (input, ctx) => {
    const rows = store(ctx)
      .db.prepare(
        `SELECT * FROM training_attempts ${input.learner ? "WHERE learner = ?" : ""} ORDER BY answered_at ASC`,
      )
      .all(...(input.learner ? [input.learner] : [])) as Array<{
      case_id: string;
      topic: string;
      answer: string;
      confidence: number;
      verdict: string;
      credit: number;
      explanation: string;
    }>;

    const scored: ScoredAttempt[] = rows.map((r) => ({
      caseId: r.case_id,
      topic: r.topic,
      answer: r.answer,
      confidence: r.confidence,
      verdict: r.verdict as ScoredAttempt["verdict"],
      credit: r.credit,
      explanation: r.explanation,
    }));

    return { content: renderProgress(progress(scored)) };
  },
});
