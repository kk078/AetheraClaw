import { z } from "zod";
import { defineTool } from "../tools/registry.js";
import type { MemoryStore } from "../memory/store.js";
import { appendAudit } from "../audit/store.js";
import { assembleTrace, normalizeClaimId, renderTrace, type TraceEvent } from "./trace.js";
import { classifyFailure, diagnoseBatch, renderBatch, renderDiagnosis } from "./fmea.js";
import { OVERDUE_JOB_HOURS, STUCK_ATTEMPTS, renderFailedOps, summarize, type StalledItem } from "./failed-ops.js";
import {
  DIFF_SAMPLE,
  MAX_SNAPSHOT_ROWS,
  checkApply,
  checkStatement,
  diffRows,
  previewToken,
  renderPreview,
  type PreviewResult,
} from "./remediate.js";

const DAY = 86_400_000;
const ago = (at: number, now: number) => Math.max(0, Math.floor((now - at) / DAY));

export const traceClaimTool = defineTool({
  name: "support_trace_claim",
  description:
    "Assemble a complete lifecycle timeline for one claim from every table that touched it — build, acknowledgment, filing proof, remittance, worklist, pipeline stage, twin prediction and audit-chain entry — and name the expected stages that NEVER happened, because the gap is usually the answer. Not a distributed trace: this is one process over SQLite, so there are no service hops or queue transitions, and nothing pretends there are.",
  schema: z.object({
    claim_id: z.string().describe("Claim id / patient control number. Matched case-insensitively after trimming."),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "No database in this context.", isError: true };

    const id = normalizeClaimId(input.claim_id);
    const events: TraceEvent[] = [];
    const like = `%${id}%`;

    for (const r of store.db
      .prepare("SELECT id, payer, status, created_at, updated_at, claim_json FROM claims")
      .all() as Array<{ id: string; payer: string; status: string; created_at: number; updated_at: number; claim_json: string }>) {
      let claimId = r.id;
      try {
        claimId = (JSON.parse(r.claim_json) as { claim_id?: string }).claim_id ?? r.id;
      } catch {
        /* fall back to the row id */
      }
      if (normalizeClaimId(claimId) !== id) continue;
      events.push({
        at: r.created_at,
        source: "claim",
        label: `Claim built (${r.payer || "no payer recorded"})`,
        detail: `status=${r.status}`,
      });
      if (r.updated_at > r.created_at) {
        events.push({ at: r.updated_at, source: "claim", label: "Claim row updated", detail: `status=${r.status}` });
      }
    }

    for (const r of store.db
      .prepare("SELECT payer, era_json, received_at FROM remittances WHERE era_json LIKE ?")
      .all(like) as Array<{ payer: string; era_json: string; received_at: number }>) {
      try {
        const era = JSON.parse(r.era_json) as { claims: Array<{ claimId: string; statusCode: string; paid: number; charged: number }> };
        for (const c of era.claims) {
          if (normalizeClaimId(c.claimId) !== id) continue;
          const denied = c.statusCode === "4" || c.paid <= 0;
          events.push({
            at: r.received_at,
            source: "remittance",
            label: denied ? "Remittance: DENIED" : `Remittance: paid $${c.paid.toFixed(2)} of $${c.charged.toFixed(2)}`,
            detail: `payer=${r.payer} status=${c.statusCode}`,
            adverse: denied,
          });
        }
      } catch {
        /* a malformed remittance loses one event, not the trace */
      }
    }

    for (const r of store.db
      .prepare("SELECT accepted_on, payer, source, recorded_at FROM filing_proof WHERE UPPER(TRIM(claim_id)) = ?")
      .all(id) as Array<{ accepted_on: string; payer: string; source: string; recorded_at: number }>) {
      events.push({
        at: r.recorded_at,
        source: "filing_proof",
        label: `Acceptance banked (${r.source})`,
        detail: `payer=${r.payer} accepted_on=${r.accepted_on}`,
      });
    }

    for (const r of store.db
      .prepare("SELECT id, kind, title, status, created_at, detail_json FROM worklist_items WHERE detail_json LIKE ? OR title LIKE ?")
      .all(like, like) as Array<{ id: string; kind: string; title: string; status: string; created_at: number }>) {
      events.push({
        at: r.created_at,
        source: "worklist",
        label: `Worklist item opened (${r.kind})`,
        detail: `${r.title} · status=${r.status}`,
        adverse: r.kind === "denial" || r.kind === "rejection",
      });
    }

    for (const r of store.db
      .prepare("SELECT from_stage, to_stage, actor, detail, created_at FROM blackboard_events WHERE UPPER(TRIM(claim_ref)) = ? ORDER BY created_at")
      .all(id) as Array<{ from_stage: string; to_stage: string; actor: string; detail: string; created_at: number }>) {
      events.push({
        at: r.created_at,
        source: "blackboard",
        label: `Pipeline ${r.from_stage || "(new)"} → ${r.to_stage}`,
        detail: `${r.actor}${r.detail ? ` · ${r.detail}` : ""}`,
        adverse: r.to_stage === "failed",
      });
    }

    for (const r of store.db
      .prepare("SELECT verdict, payer, created_at FROM twin_predictions WHERE UPPER(TRIM(claim_id)) = ?")
      .all(id) as Array<{ verdict: string; payer: string; created_at: number }>) {
      events.push({
        at: r.created_at,
        source: "twin_prediction",
        label: `Payer twin predicted ${r.verdict}`,
        detail: `payer=${r.payer}`,
        adverse: r.verdict === "DENY",
      });
    }

    for (const r of store.db
      .prepare("SELECT seq, kind, actor, summary, created_at FROM audit_chain WHERE summary LIKE ?")
      .all(like) as Array<{ seq: number; kind: string; actor: string; summary: string; created_at: number }>) {
      events.push({
        at: r.created_at,
        source: "audit_chain",
        label: `Audit entry #${r.seq} (${r.kind})`,
        detail: `${r.actor}: ${r.summary}`,
      });
    }

    return { content: renderTrace(assembleTrace(input.claim_id, events)) };
  },
});

export const fmeaTool = defineTool({
  name: "support_fmea_diagnose",
  description:
    "Classify one or many failure texts — error messages, stack frames, 277CA rejection triplets — into a root-cause category with the next steps that resolve it, and a count per category when given a batch (forty failures with one cause is one incident; forty with eleven is a different situation). Anything no rule matches comes back UNCLASSIFIED rather than guessed at: a confident wrong category sends an engineer down the wrong path for an hour precisely because it sounded certain.",
  schema: z.object({
    failures: z.array(z.string()).min(1).describe("Error text, log lines, or acknowledgment status descriptions"),
  }),
  execute: async (input) => {
    if (input.failures.length === 1) {
      return { content: renderDiagnosis(classifyFailure(input.failures[0])) };
    }
    return { content: renderBatch(diagnoseBatch(input.failures)) };
  },
});

export const failedOpsTool = defineTool({
  name: "support_failed_ops",
  description:
    "List work that entered the system and stopped moving: mail held at the PHI boundary, scheduled jobs that should have fired and did not, claims wedged mid-pipeline, and worklist items past their deadline. Items where the delay itself is the loss — a records request in quarantine with an ADR clock running — are marked and sorted first. This is not a message-queue DLQ; there is no queue here, and the name says what it actually inspects.",
  schema: z.object({
    limit: z.number().int().min(1).max(200).default(25),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "No database in this context.", isError: true };
    const now = Date.now();
    const items: StalledItem[] = [];

    for (const r of store.db
      .prepare("SELECT id, sender, subject, kind, received_at FROM inbound_mail WHERE quarantined = 1 AND status = 'new'")
      .all() as Array<{ id: string; sender: string; subject: string; kind: string; received_at: number }>) {
      items.push({
        kind: "quarantined_mail",
        id: r.id,
        label: `${r.kind}: ${r.subject || "(no subject)"}`,
        ageDays: ago(r.received_at, now),
        detail: `from ${r.sender || "unknown"} — held because it carried identifier-shaped text, so the body was never stored`,
        // A records request or audit notice has a deadline running while it sits.
        losing: r.kind === "records_request" || r.kind === "audit_notice" || r.kind === "overpayment_demand",
      });
    }

    for (const r of store.db
      .prepare("SELECT id, name, run_at, interval_ms, last_run_at FROM scheduled_jobs WHERE enabled = 1")
      .all() as Array<{ id: string; name: string; run_at: number | null; interval_ms: number | null; last_run_at: number | null }>) {
      const due = r.run_at ?? (r.interval_ms && r.last_run_at ? r.last_run_at + r.interval_ms : null);
      if (due === null || due > now - OVERDUE_JOB_HOURS * 3_600_000) continue;
      if (r.run_at !== null && r.last_run_at !== null && r.last_run_at >= r.run_at) continue; // one-shot already ran
      items.push({
        kind: "overdue_job",
        id: r.id,
        label: r.name,
        ageDays: ago(due, now),
        detail: `due ${new Date(due).toISOString().slice(0, 16).replace("T", " ")} — never fired, so the reminders it owns were not sent`,
        losing: true,
      });
    }

    for (const r of store.db
      .prepare("SELECT id, claim_ref, stage, attempts, last_error, updated_at FROM blackboard WHERE attempts >= ?")
      .all(STUCK_ATTEMPTS) as Array<{ id: string; claim_ref: string; stage: string; attempts: number; last_error: string; updated_at: number }>) {
      items.push({
        kind: "stuck_claim",
        id: r.id,
        label: `${r.claim_ref} wedged at ${r.stage}`,
        ageDays: ago(r.updated_at, now),
        detail: `${r.attempts} attempt(s)${r.last_error ? ` — ${r.last_error.slice(0, 140)}` : ""}`,
        losing: true,
      });
    }

    for (const r of store.db
      .prepare("SELECT id, title, due_at FROM worklist_items WHERE status IN ('open','in_progress') AND due_at IS NOT NULL AND due_at < ?")
      .all(now) as Array<{ id: string; title: string; due_at: number }>) {
      items.push({
        kind: "expired_worklist",
        id: r.id,
        label: r.title,
        ageDays: ago(r.due_at, now),
        detail: "past its deadline — no longer recoverable on the merits, though a banked acceptance may still win a timely-filing denial",
        losing: true,
      });
    }

    return { content: renderFailedOps(summarize(items), input.limit) };
  },
});

/** Tables a remediation statement may touch. Sessions and the audit chain are not among them. */
const REMEDIABLE_TABLES = new Set([
  "claims",
  "worklist_items",
  "blackboard",
  "credentialing",
  "payer_policies",
  "contract_rates",
  "credit_balances",
  "audit_requests",
  "scheduled_jobs",
  "filing_proof",
  "inbound_mail",
]);

function tableGuard(table: string | undefined): string | null {
  if (!table) return null;
  if (REMEDIABLE_TABLES.has(table)) return null;
  if (table === "audit_chain" || table === "audit_anchors" || table === "phi_access_log") {
    return `Refused: ${table} is append-only evidence. Editing it is the thing an audit log exists to make detectable, and the hash chain would fail verification immediately anyway.`;
  }
  return `Refused: ${table} is not a remediable table. Allowed: ${[...REMEDIABLE_TABLES].sort().join(", ")}.`;
}

/**
 * Run the statement inside a savepoint and roll back unconditionally.
 *
 * There is no branch here that commits. The rollback is in a `finally`, so
 * neither an exception nor an early return can leave the write in place.
 */
function dryRun(store: MemoryStore, sql: string, table: string, kind: string): PreviewResult {
  const token = previewToken(sql);
  const tableRows = Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  const snapshotable = tableRows <= MAX_SNAPSHOT_ROWS;

  const before = snapshotable
    ? (store.db.prepare(`SELECT rowid, * FROM ${table}`).all() as Array<Record<string, unknown>>)
    : [];

  let rowsAffected = 0;
  let after: Array<Record<string, unknown>> = [];
  store.db.exec("SAVEPOINT remediate_preview");
  try {
    rowsAffected = Number(store.db.prepare(sql).run().changes);
    if (snapshotable) after = store.db.prepare(`SELECT rowid, * FROM ${table}`).all() as Array<Record<string, unknown>>;
  } finally {
    // Unconditional. Not "on error" — always. Verified on both drivers, and
    // verified to survive a statement that throws mid-execution.
    store.db.exec("ROLLBACK TO remediate_preview");
    store.db.exec("RELEASE remediate_preview");
  }

  if (!snapshotable) {
    return { ok: true, kind: kind as PreviewResult["kind"], table, rowsAffected, diffs: [], notShown: 0, diffSkippedRows: tableRows, token };
  }

  const diffs = diffRows(before, after, "rowid");
  return {
    ok: true,
    kind: kind as PreviewResult["kind"],
    table,
    rowsAffected,
    diffs: diffs.slice(0, DIFF_SAMPLE),
    notShown: Math.max(0, diffs.length - DIFF_SAMPLE),
    token,
  };
}

export const remediatePreviewTool = defineTool({
  name: "support_remediate_preview",
  description:
    "Run a single UPDATE, DELETE or INSERT against the live database inside a savepoint that is ALWAYS rolled back, and show the exact before/after row diff plus an exact affected-row count. Nothing is written — there is no branch in the preview path that commits. An UPDATE or DELETE with no WHERE clause is refused outright with no override, and so is anything touching the append-only audit tables. Returns a token needed to apply exactly this statement.",
  schema: z.object({
    sql: z.string().describe("One statement. No semicolon-separated batches; the second is the one nobody reviewed."),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "No database in this context.", isError: true };

    const check = checkStatement(input.sql);
    if (!check.ok) return { content: `Not previewed. ${check.reason}`, isError: true };
    const guard = tableGuard(check.table);
    if (guard) return { content: `Not previewed. ${guard}`, isError: true };

    try {
      const result = dryRun(store, input.sql, check.table!, check.kind!);
      return { content: renderPreview(result, input.sql) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          `The statement failed during the dry run, so nothing was written and nothing would be.`,
          "",
          renderDiagnosis(classifyFailure(message)),
        ].join("\n"),
        isError: true,
      };
    }
  },
});

export const remediateApplyTool = defineTool({
  name: "support_remediate_apply",
  description:
    "Apply a remediation statement that has already been previewed. Requires the token support_remediate_preview returned for EXACTLY this SQL — editing the statement, including its WHERE clause, invalidates the token, so applying something nobody previewed is not possible by forgetting. The same refusals as the preview apply, the write is transactional, and the statement and its row count are appended to the tamper-evident audit chain.",
  schema: z.object({
    sql: z.string(),
    token: z.string().describe("From support_remediate_preview, for this exact statement"),
    reason: z.string().min(10).describe("Why this remediation is being applied — recorded in the audit chain"),
  }),
  assessRisk: (input) => ({
    level: "confirm",
    reason: `WRITE to production: ${input.sql.slice(0, 160)}`,
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "No database in this context.", isError: true };

    const gate = checkApply(input.sql, input.token);
    if (!gate.ok) return { content: `Not applied. ${gate.reason}`, isError: true };
    const check = checkStatement(input.sql);
    const guard = tableGuard(check.table);
    if (guard) return { content: `Not applied. ${guard}`, isError: true };

    let changes = 0;
    try {
      store.db.transaction(() => {
        changes = Number(store.db.prepare(input.sql).run().changes);
        appendAudit(store, {
          kind: "remediation",
          actor: ctx.sessionId,
          summary: `${check.kind?.toUpperCase()} ${check.table}: ${changes} row(s) — ${input.reason}`,
          payload: { sql: input.sql, token: input.token, reason: input.reason, changes },
        });
      })();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [`Applied nothing — the transaction rolled back.`, "", renderDiagnosis(classifyFailure(message))].join("\n"),
        isError: true,
      };
    }

    return {
      content: [
        `Applied: ${changes} row(s) changed in ${check.table}.`,
        `Recorded in the audit chain with the statement, the token and the stated reason. Verify with \`aetheraclaw audit verify\`.`,
      ].join("\n"),
    };
  },
});

export const SUPPORT_TOOLS = [traceClaimTool, fmeaTool, failedOpsTool, remediatePreviewTool, remediateApplyTool];
