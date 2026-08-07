import { z } from "zod";
import { defineTool } from "../../registry.js";
import { newId } from "../../../shared/ids.js";
import type { MemoryStore } from "../../../memory/store.js";
import {
  applyReview,
  normalizeCode,
  renderQueue,
  renderSourceStats,
  sourceStats,
  type ReviewEvent,
  type Suggestion,
  type SuggestionKind,
  type SuggestionStatus,
} from "./queue.js";
import {
  deriveCorrection,
  matchCorrections,
  payerKey,
  renderCorrections,
  type Correction,
} from "./corrections.js";

function db(ctx: { services: Record<string, unknown> }) {
  const store = ctx.services.store as MemoryStore | undefined;
  if (!store) throw new Error("store service unavailable");
  return store.db;
}

interface SuggestionRow {
  id: string;
  claim_ref: string;
  kind: string;
  suggested_code: string;
  suggested_description: string;
  rationale: string;
  provenance: string;
  confidence: number | null;
  source: string;
  payer: string;
  status: string;
  final_code: string;
  reviewer: string;
  review_reason: string;
  created_at: number;
  reviewed_at: number | null;
}

function toSuggestion(row: SuggestionRow): Suggestion {
  return {
    id: row.id,
    claimRef: row.claim_ref,
    kind: row.kind as SuggestionKind,
    suggestedCode: row.suggested_code,
    suggestedDescription: row.suggested_description,
    rationale: row.rationale,
    provenance: row.provenance,
    confidence: row.confidence,
    source: row.source,
    payer: row.payer,
    status: row.status as SuggestionStatus,
    finalCode: row.final_code,
    reviewer: row.reviewer,
    reviewReason: row.review_reason,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

interface CorrectionRow {
  id: string;
  kind: string;
  suggested_code: string;
  corrected_code: string;
  payer_key: string;
  reason: string;
  times_seen: number;
  last_seen_at: number;
  created_at: number;
}

function toCorrection(row: CorrectionRow): Correction {
  return {
    id: row.id,
    kind: row.kind as SuggestionKind,
    suggestedCode: row.suggested_code,
    correctedCode: row.corrected_code,
    payerKey: row.payer_key,
    reason: row.reason,
    timesSeen: row.times_seen,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

function logEvent(ctx: { services: Record<string, unknown> }, event: ReviewEvent, at: number): void {
  db(ctx)
    .prepare(
      `INSERT INTO review_events (id, suggestion_id, action, from_status, to_status, code_before, code_after, reviewer, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId("rev"),
      event.suggestionId,
      event.action,
      event.fromStatus,
      event.toStatus,
      event.codeBefore,
      event.codeAfter,
      event.reviewer,
      event.reason,
      at,
    );
}

const KINDS = ["diagnosis", "procedure", "modifier"] as const;

export const codeSuggestTool = defineTool({
  name: "code_suggest",
  description:
    "Put a suggested code into the review queue instead of onto a claim. Code selection is the coder's and the provider's responsibility, so a suggestion is a proposal until a human accepts it. Include the documentation that supports it — a suggestion a coder cannot trace back to the record is one they have to re-derive from scratch.",
  schema: z.object({
    kind: z.enum(KINDS),
    code: z.string(),
    description: z.string().default(""),
    rationale: z.string().default("").describe("Why this code, in coding terms"),
    provenance: z.string().default("").describe("The supporting text from the documentation, quoted"),
    confidence: z.number().min(0).max(1).optional(),
    claim_ref: z.string().default(""),
    payer: z.string().default(""),
    source: z.string().default("agent").describe("Which tool or agent proposed it"),
  }),
  execute: async (input, ctx) => {
    const id = newId("sug");
    const now = Date.now();
    db(ctx)
      .prepare(
        `INSERT INTO code_suggestions
           (id, claim_ref, kind, suggested_code, suggested_description, rationale, provenance, confidence, source, payer, status, final_code, reviewer, review_reason, created_at, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', '', '', ?, NULL)`,
      )
      .run(
        id,
        input.claim_ref,
        input.kind,
        input.code.trim().toUpperCase(),
        input.description,
        input.rationale,
        input.provenance,
        input.confidence ?? null,
        input.source,
        input.payer,
        now,
      );
    logEvent(
      ctx,
      {
        suggestionId: id,
        action: "suggested",
        fromStatus: "",
        toStatus: "pending",
        codeBefore: "",
        codeAfter: input.code.trim().toUpperCase(),
        reviewer: input.source,
        reason: input.rationale,
      },
      now,
    );
    return {
      content: [
        `Queued ${id}: ${input.kind} ${input.code.trim().toUpperCase()}${input.description ? ` — ${input.description}` : ""}.`,
        input.provenance ? "" : "No supporting documentation was attached. A coder will have to find it themselves before they can accept this.",
        "It is not on any claim until a coder reviews it with review_decide.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});

export const reviewListTool = defineTool({
  name: "review_list",
  description:
    "Show the coding review queue. Defaults to what is still waiting on a human; pass a status to see what was decided and why.",
  schema: z.object({
    status: z.enum(["pending", "accepted", "edited", "rejected", "all"]).default("pending"),
    claim_ref: z.string().optional(),
    kind: z.enum(KINDS).optional(),
    limit: z.number().int().min(1).max(200).default(25),
  }),
  execute: async (input, ctx) => {
    const where: string[] = [];
    const args: unknown[] = [];
    if (input.status !== "all") {
      where.push("status = ?");
      args.push(input.status);
    }
    if (input.claim_ref) {
      where.push("claim_ref = ?");
      args.push(input.claim_ref);
    }
    if (input.kind) {
      where.push("kind = ?");
      args.push(input.kind);
    }
    const rows = db(ctx)
      .prepare(
        `SELECT * FROM code_suggestions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC`,
      )
      .all(...args) as SuggestionRow[];
    return { content: renderQueue(rows.map(toSuggestion), input.limit) };
  },
});

export const reviewDecideTool = defineTool({
  name: "review_decide",
  description:
    "Record a coder's decision on a suggested code: accept it, edit it to the code actually used, or reject it. A reason is required to edit or reject — it is what teaches the next suggestion and what an auditor asks for. Every decision is appended to a review log that is never rewritten, and edits and rejections become corrections recalled before future suggestions.",
  schema: z.object({
    suggestion_id: z.string(),
    action: z.enum(["accept", "edit", "reject", "reopen"]),
    reviewer: z.string().describe("Who is making this decision"),
    reason: z.string().optional().describe("Required for edit, reject, and reopen"),
    final_code: z.string().optional().describe("Required for edit: the code actually used"),
  }),
  execute: async (input, ctx) => {
    const row = db(ctx)
      .prepare("SELECT * FROM code_suggestions WHERE id = ?")
      .get(input.suggestion_id) as SuggestionRow | undefined;
    if (!row) return { content: `No suggestion ${input.suggestion_id}.`, isError: true };

    const outcome = applyReview(toSuggestion(row), {
      action: input.action,
      reviewer: input.reviewer,
      reason: input.reason,
      finalCode: input.final_code,
    });
    if (typeof outcome === "string") return { content: outcome, isError: true };

    const { suggestion, event } = outcome;
    const now = Date.now();
    db(ctx)
      .prepare(
        `UPDATE code_suggestions SET status = ?, final_code = ?, reviewer = ?, review_reason = ?, reviewed_at = ? WHERE id = ?`,
      )
      .run(suggestion.status, suggestion.finalCode, suggestion.reviewer, suggestion.reviewReason, suggestion.reviewedAt, suggestion.id);
    logEvent(ctx, event, now);

    const lines = [
      suggestion.status === "pending"
        ? `${suggestion.id} reopened by ${input.reviewer}.`
        : `${suggestion.id} ${suggestion.status} by ${input.reviewer}` +
          (suggestion.status === "edited" ? `: ${suggestion.suggestedCode} → ${suggestion.finalCode}.` : "."),
    ];

    const seed = deriveCorrection(suggestion);
    if (seed) {
      db(ctx)
        .prepare(
          `INSERT INTO coding_corrections (id, kind, suggested_code, corrected_code, payer_key, reason, times_seen, last_seen_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(kind, suggested_code, corrected_code, payer_key) DO UPDATE SET
             times_seen = times_seen + 1,
             reason = excluded.reason,
             last_seen_at = excluded.last_seen_at`,
        )
        .run(newId("corr"), seed.kind, seed.suggestedCode, seed.correctedCode, seed.payerKey, seed.reason, now, now);
      const stored = db(ctx)
        .prepare(
          "SELECT times_seen FROM coding_corrections WHERE kind = ? AND suggested_code = ? AND corrected_code = ? AND payer_key = ?",
        )
        .get(seed.kind, seed.suggestedCode, seed.correctedCode, seed.payerKey) as { times_seen: number } | undefined;
      lines.push(
        `Recorded as a correction (seen ${stored?.times_seen ?? 1}×) — coding_corrections will surface it before this code is suggested again.`,
      );
    }
    return { content: lines.join("\n") };
  },
});

export const codingCorrectionsTool = defineTool({
  name: "coding_corrections",
  description:
    "Recall what this practice's coders have changed about suggested codes before. Call this BEFORE suggesting codes: a suggestion the coders already rejected once wastes their time twice. Payer-specific corrections outrank general ones, and repeated corrections outrank one-offs. These are the practice's past decisions rather than coding rules — where a correction and the documentation disagree, say so.",
  schema: z.object({
    kind: z.enum(KINDS).optional(),
    codes: z.array(z.string()).default([]).describe("Codes you are considering suggesting"),
    payer: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(15),
  }),
  execute: async (input, ctx) => {
    const rows = db(ctx).prepare("SELECT * FROM coding_corrections").all() as CorrectionRow[];
    const matched = matchCorrections(rows.map(toCorrection), {
      kind: input.kind,
      codes: input.codes,
      payer: input.payer,
    });
    return {
      content: renderCorrections(matched.slice(0, input.limit), {
        kind: input.kind,
        codes: input.codes,
        payer: input.payer,
      }),
    };
  },
});

export const reviewAuditTool = defineTool({
  name: "review_audit",
  description:
    "Show the decision history for a suggestion, or the accept/edit/reject record of each suggestion source. The history is append-only: a decision that was later reopened and changed still shows both, which is the point of keeping it separately from the current status.",
  schema: z.object({
    suggestion_id: z.string().optional().describe("Omit to see per-source statistics instead"),
  }),
  execute: async (input, ctx) => {
    if (!input.suggestion_id) {
      const rows = db(ctx).prepare("SELECT * FROM code_suggestions").all() as SuggestionRow[];
      return { content: renderSourceStats(sourceStats(rows.map(toSuggestion))) };
    }
    const events = db(ctx)
      .prepare("SELECT * FROM review_events WHERE suggestion_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(input.suggestion_id) as Array<{
      action: string;
      from_status: string;
      to_status: string;
      code_before: string;
      code_after: string;
      reviewer: string;
      reason: string;
      created_at: number;
    }>;
    if (events.length === 0) return { content: `No review history for ${input.suggestion_id}.` };
    return {
      content: [
        `Decision history for ${input.suggestion_id}:`,
        "",
        ...events.map((e) => {
          const when = new Date(e.created_at).toISOString().replace("T", " ").slice(0, 19);
          const move =
            e.code_before && e.code_after && e.code_before !== e.code_after
              ? ` ${e.code_before} → ${e.code_after}`
              : e.code_after
                ? ` ${e.code_after}`
                : "";
          return `  ${when}  ${e.action}${move}  by ${e.reviewer || "(unattributed)"}${e.reason ? ` — ${e.reason}` : ""}`;
        }),
      ].join("\n"),
    };
  },
});

export const reviewExportTool = defineTool({
  name: "review_apply",
  description:
    "Collect the codes a coder actually approved for a claim — accepted codes as suggested, edited codes as the coder wrote them — so they can be built into a claim. Pending and rejected suggestions are excluded and counted, because a claim built from unreviewed suggestions is exactly what the queue exists to prevent.",
  schema: z.object({
    claim_ref: z.string(),
    kind: z.enum(KINDS).optional(),
  }),
  execute: async (input, ctx) => {
    const rows = db(ctx)
      .prepare("SELECT * FROM code_suggestions WHERE claim_ref = ?")
      .all(input.claim_ref) as SuggestionRow[];
    if (rows.length === 0) return { content: `No suggestions recorded for claim ${input.claim_ref}.` };

    let suggestions = rows.map(toSuggestion);
    if (input.kind) suggestions = suggestions.filter((s) => s.kind === input.kind);

    const approved = suggestions.filter((s) => s.status === "accepted" || s.status === "edited");
    const pending = suggestions.filter((s) => s.status === "pending");
    const rejected = suggestions.filter((s) => s.status === "rejected");

    const byKind = new Map<string, string[]>();
    for (const s of approved) {
      const code = s.finalCode || s.suggestedCode;
      byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), code]);
    }

    const lines = [`Approved codes for claim ${input.claim_ref}:`, ""];
    if (byKind.size === 0) lines.push("  (none approved yet)");
    for (const [kind, codes] of byKind) lines.push(`  ${kind}: ${codes.join(", ")}`);
    lines.push("");
    if (pending.length > 0) {
      lines.push(
        `${pending.length} suggestion(s) are still awaiting review and are NOT included: ${pending.map((s) => `${s.id} (${s.suggestedCode})`).join(", ")}.`,
      );
    }
    if (rejected.length > 0) lines.push(`${rejected.length} rejected suggestion(s) excluded.`);
    if (pending.length === 0 && rejected.length === 0) lines.push("Every suggestion for this claim has been reviewed.");

    // Deduplicate on the normalized form but emit the code as the coder wrote
    // it — a claim carries "E11.65", not "E1165".
    const uniqueByKind = new Map(
      [...byKind].map(([kind, codes]) => {
        const seen = new Set<string>();
        return [
          kind,
          codes.filter((code) => {
            const key = normalizeCode(code);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }),
        ] as const;
      }),
    );
    lines.push("", JSON.stringify(Object.fromEntries(uniqueByKind), null, 2));
    return { content: lines.join("\n") };
  },
});
