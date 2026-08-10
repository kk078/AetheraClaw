import { newId } from "../shared/ids.js";
import type { MemoryStore } from "../memory/store.js";
import type { Stage } from "./stages.js";
import { findTransition } from "./stages.js";

// ── The run log, and why a repeated advance must do nothing ──────────────────
//
// The board holds where each claim IS. This holds how it got there.
//
// The property worth the table is replay safety. Advancing a claim is not
// idempotent by nature: apply the same "coded → scrubbing" twice and a naive
// implementation moves it to scrubbing and then onwards, so a claim skips the
// scrub because a request was retried. That defect is invisible — the claim
// looks like a claim, just further along than it earned — and it is exactly the
// shape a retried job, a double-clicked button or a re-delivered webhook
// produces.
//
// So a transition is identified by (item, from, to, key) and the database
// enforces it. Not a check in code: SELECT-then-INSERT has a window, and two
// concurrent retries both pass it.

export interface RunRecord {
  id: string;
  itemId: string;
  claimRef: string;
  fromStage: string;
  toStage: string;
  actor: string;
  automated: boolean;
  note: string;
  idempotencyKey: string;
  createdAt: number;
}

export interface TransitionRequest {
  itemId: string;
  claimRef: string;
  from: Stage;
  to: Stage;
  actor: string;
  automated: boolean;
  note?: string;
  /**
   * What makes two attempts "the same attempt".
   *
   * Defaults to the empty string, which means every distinct (item, from, to)
   * is recorded once ever. That is the strict reading and the safe default: a
   * legitimate second pass through the same transition — a claim that was
   * denied, reworked and re-submitted — must pass a key saying so, rather than
   * relying on the log to guess that this time is different.
   */
  key?: string;
}

export interface TransitionResult {
  applied: boolean;
  /** The reason, when it was not applied. */
  why: string;
  record: RunRecord | null;
}

type Db = { prepare: (sql: string) => { run: (...a: unknown[]) => { changes?: number }; get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] } };

function db(store: MemoryStore): Db {
  return (store as unknown as { db: Db }).db;
}

/**
 * Record a stage transition, once.
 *
 * Returns `applied: false` for a replay rather than throwing. A replay is not
 * an error — it is the correct outcome of a retry, and a caller that treats it
 * as a failure would retry again.
 */
export function recordTransition(store: MemoryStore, req: TransitionRequest, now: number): TransitionResult {
  // The stage machine decides what is legal. Recording an illegal move would
  // put a claim in a state nothing downstream expects, and the log would then
  // be the evidence that it was fine.
  if (!findTransition(req.from, req.to)) {
    return {
      applied: false,
      why: `"${req.from}" does not advance to "${req.to}" in the stage machine. Nothing was recorded.`,
      record: null,
    };
  }

  const record: RunRecord = {
    id: newId("run"),
    itemId: req.itemId,
    claimRef: req.claimRef,
    fromStage: req.from,
    toStage: req.to,
    actor: req.actor,
    automated: req.automated,
    note: req.note ?? "",
    idempotencyKey: req.key ?? "",
    createdAt: now,
  };

  const res = db(store)
    .prepare(
      `INSERT OR IGNORE INTO swarm_runs
       (id, item_id, claim_ref, from_stage, to_stage, actor, automated, note, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id, record.itemId, record.claimRef, record.fromStage, record.toStage,
      record.actor, record.automated ? 1 : 0, record.note, record.idempotencyKey, record.createdAt,
    );

  if ((res.changes ?? 0) === 0) {
    return {
      applied: false,
      why:
        `${req.claimRef} has already been advanced from ${req.from} to ${req.to}. This request was a replay and did ` +
        "nothing — which is the point: applying it again would move the claim a second stage and it would have " +
        "skipped the work in between.",
      record: null,
    };
  }
  return { applied: true, why: "", record };
}

export function loadRuns(store: MemoryStore, itemId: string): RunRecord[] {
  const rows = db(store)
    .prepare("SELECT * FROM swarm_runs WHERE item_id = ? ORDER BY created_at ASC")
    .all(itemId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    itemId: String(r.item_id),
    claimRef: String(r.claim_ref),
    fromStage: String(r.from_stage),
    toStage: String(r.to_stage),
    actor: String(r.actor),
    automated: Number(r.automated) === 1,
    note: String(r.note),
    idempotencyKey: String(r.idempotency_key),
    createdAt: Number(r.created_at),
  }));
}

/**
 * How long each stage actually took, from the log.
 *
 * The board's `updated_at` only knows the CURRENT stage's dwell time. This is
 * how a practice finds out that claims sit in coding for four days — the answer
 * to "where is the time going", which no single row can give.
 */
export function dwellTimes(runs: RunRecord[]): Array<{ stage: string; hours: number }> {
  const out: Array<{ stage: string; hours: number }> = [];
  for (let i = 1; i < runs.length; i++) {
    out.push({ stage: runs[i - 1].toStage, hours: (runs[i].createdAt - runs[i - 1].createdAt) / 3_600_000 });
  }
  return out;
}

export function renderRuns(runs: RunRecord[]): string {
  if (runs.length === 0) return "No transitions recorded for this item.";
  const lines = [`${runs[0].claimRef}: ${runs.length} transition(s).`];
  const dwell = dwellTimes(runs);
  for (const [i, r] of runs.entries()) {
    const held = dwell[i - 1];
    lines.push(
      `  ${r.fromStage} → ${r.toStage}  by ${r.actor || "unknown"}${r.automated ? " (automated)" : ""}` +
        (held ? `  after ${held.hours.toFixed(1)}h in ${held.stage}` : "") +
        (r.note ? `  — ${r.note}` : ""),
    );
  }
  return lines.join("\n");
}
