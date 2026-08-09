import { z } from "zod";
import { defineTool } from "../registry.js";
import type { MemoryStore } from "../../memory/store.js";
import {
  DEFAULT_APPEAL_COST_CENTS,
  MIN_APPEAL_SAMPLE,
  renderTriage,
  triageAppeals,
  type AppealCandidate,
  type DenialOutcome,
} from "./appeal-economics.js";

const newId = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

function loadOutcomes(store: MemoryStore): DenialOutcome[] {
  try {
    return (
      store.db.prepare("SELECT payer, carc, appealed, overturned FROM appeal_outcomes").all() as Array<{
        payer: string;
        carc: string;
        appealed: number;
        overturned: number;
      }>
    ).map((r) => ({ payer: r.payer, carc: r.carc, appealed: r.appealed === 1, overturned: r.overturned === 1 }));
  } catch {
    return [];
  }
}

export const appealTriageTool = defineTool({
  name: "appeal_triage",
  description:
    "Rank open denials by what appealing them is actually WORTH — recoverable amount × this practice's own overturn rate for that payer and CARC, minus the stated cost of working one — rather than by balance, which puts a $4,000 denial nobody has ever won ahead of a $600 one they win four times in five. Below a real sample of recorded appeals it makes NO recommendation rather than inventing a win rate. It never recommends a write-off: the closest it comes is reporting that a denial is worth less than the work, and before saying that it checks whether the denial belongs to a cluster sharing one cause — a batch of small denials with one upstream fault is the most valuable thing in the queue, not the least.",
  schema: z.object({
    payer: z.string().optional().describe("Only denials from payers matching this substring"),
    appeal_cost_cents: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(`Staff cost of working one appeal, in cents. Default ${DEFAULT_APPEAL_COST_CENTS} — change it and the ranking changes.`),
    limit: z.number().int().min(1).max(200).default(15).describe("How many ranked denials to list"),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "No database in this context.", isError: true };

    const now = Date.now();
    const needle = input.payer?.toLowerCase();
    const candidates: AppealCandidate[] = [];

    for (const r of store.db
      .prepare("SELECT id, detail_json, due_at FROM worklist_items WHERE kind = 'denial' AND status IN ('open','in_progress')")
      .all() as Array<{ id: string; detail_json: string; due_at: number | null }>) {
      let d: { claim_id?: string; payer?: string; carc?: string; amount_cents?: number } | null = null;
      try {
        d = JSON.parse(r.detail_json);
      } catch {
        continue;
      }
      if (!d?.carc) continue;
      const payer = d.payer || "(unnamed)";
      if (needle && !payer.toLowerCase().includes(needle)) continue;
      candidates.push({
        id: r.id,
        claimId: d.claim_id || "(no claim id)",
        payer,
        carc: d.carc,
        amountCents: d.amount_cents ?? 0,
        // Null, not a default: an unknown deadline is not the same as plenty of
        // time, and defaulting it to a large number would rank an expired appeal
        // at the top of the list.
        daysToDeadline: r.due_at === null ? null : Math.floor((r.due_at - now) / 86_400_000),
      });
    }

    const outcomes = loadOutcomes(store);
    const out = renderTriage(triageAppeals(candidates, outcomes, { appealCostCents: input.appeal_cost_cents, now }), input.limit);
    const footer =
      outcomes.length === 0
        ? `\n\nNo appeal outcomes are recorded yet, so no win rate can be estimated for anything above. Record them with appeal_outcome_record as appeals are decided — after ${MIN_APPEAL_SAMPLE} this becomes answerable, and it answers from THIS practice's results rather than an industry average.`
        : `\n\nBased on ${outcomes.length} recorded appeal outcome(s).`;
    return { content: out + footer };
  },
});

export const appealOutcomeRecordTool = defineTool({
  name: "appeal_outcome_record",
  description:
    "Record how an appeal was decided, so appeal_triage can learn this practice's real overturn rate by payer and CARC. Record LOSSES as well as wins — a win rate built only from wins is not a rate. A denial that was never appealed should not be recorded here at all: the denominator is appeals filed, and counting never-appealed denials as losses drives every rate toward zero and produces a tool that recommends never appealing.",
  schema: z.object({
    claim_id: z.string(),
    payer: z.string(),
    carc: z.string().describe("The CARC that was appealed"),
    overturned: z.boolean().describe("Did the appeal recover money?"),
    amount_cents: z.number().int().min(0).default(0).describe("Amount recovered, or the amount at stake if lost"),
    note: z.string().default("").describe("What decided it — the argument that worked, or why it failed"),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "No database in this context.", isError: true };

    store.db
      .prepare(
        `INSERT INTO appeal_outcomes (id, claim_id, payer, carc, appealed, overturned, amount_cents, note, decided_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        newId("ao"),
        input.claim_id,
        input.payer,
        input.carc.trim().toUpperCase(),
        input.overturned ? 1 : 0,
        input.amount_cents,
        input.note,
        Date.now(),
      );

    const rows = loadOutcomes(store);
    const same = rows.filter(
      (r) => r.payer.toLowerCase() === input.payer.toLowerCase() && r.carc.toUpperCase() === input.carc.trim().toUpperCase(),
    );
    const wins = same.filter((r) => r.overturned).length;

    return {
      content: [
        `Recorded: ${input.claim_id} — CARC ${input.carc.trim().toUpperCase()} to ${input.payer} was ${input.overturned ? "OVERTURNED" : "upheld"}.`,
        `${same.length} outcome(s) now recorded for this payer and code (${wins} overturned).`,
        same.length < MIN_APPEAL_SAMPLE
          ? `appeal_triage needs ${MIN_APPEAL_SAMPLE} before it will state a rate for this pair — until then it declines rather than guessing, and falls back to the code across all payers or the practice's overall record if those have enough.`
          : `appeal_triage can now rank this pair on this practice's own results rather than a broader fallback.`,
      ].join("\n"),
    };
  },
});

export const APPEAL_ECONOMICS_TOOLS = [appealTriageTool, appealOutcomeRecordTool];
