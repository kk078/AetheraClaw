import { createHash } from "node:crypto";
import { newId } from "../../../shared/ids.js";
import type { MemoryStore } from "../../../memory/store.js";

// ── The ledger the cap is counted from ───────────────────────────────────────
//
// The I/O half of first-submission.ts. Two rules shape it:
//
//   A ROW IS WRITTEN BEFORE THE SEND, not after. A row written on success would
//   let a submission that crashed mid-flight be retried past the ceiling — which
//   is precisely the case the ceiling exists for, because a crashed send is the
//   one where nobody knows whether the payer got it.
//
//   NOTHING IS EVER DELETED. This is the record of what a practice actually
//   filed and it is the first thing anyone asks for when a payer disputes a
//   filing date.

export type LiveOutcome = "attempted" | "accepted" | "rejected" | "unknown";

export interface LiveSubmission {
  id: string;
  claimRef: string;
  payer: string;
  connector: string;
  environment: string;
  supervisor: string;
  chargeAmount: number;
  x12Sha256: string;
  outcome: LiveOutcome;
  receiptId: string;
  note: string;
  createdAt: number;
}

type Db = {
  prepare: (sql: string) => {
    run: (...a: unknown[]) => { changes?: number };
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
  };
};

function db(store: MemoryStore): Db {
  return (store as unknown as { db: Db }).db;
}

export function digestOf(x12: string): string {
  return createHash("sha256").update(x12).digest("hex");
}

/** How many live submissions this deployment has attempted. Counts ATTEMPTS, not successes. */
export function countLiveSubmissions(store: MemoryStore): number {
  try {
    return (db(store).prepare("SELECT COUNT(*) AS c FROM live_submissions").get() as { c: number }).c;
  } catch {
    // A missing table means none have been made. Returning zero is right; the
    // alternative — throwing — would block a first submission on a schema
    // detail and send somebody looking in the wrong place.
    return 0;
  }
}

/**
 * Has this exact 837 been sent before?
 *
 * The single most useful question in the whole file. A caller that is about to
 * resend after a timeout can ask it and get a real answer rather than guessing.
 */
export function priorSubmissionOf(store: MemoryStore, x12: string): LiveSubmission | null {
  try {
    const row = db(store)
      .prepare("SELECT * FROM live_submissions WHERE x12_sha256 = ? ORDER BY created_at ASC LIMIT 1")
      .get(digestOf(x12)) as Record<string, unknown> | undefined;
    return row ? toSubmission(row) : null;
  } catch {
    return null;
  }
}

function toSubmission(r: Record<string, unknown>): LiveSubmission {
  return {
    id: String(r.id),
    claimRef: String(r.claim_ref ?? ""),
    payer: String(r.payer ?? ""),
    connector: String(r.connector ?? ""),
    environment: String(r.environment ?? ""),
    supervisor: String(r.supervisor ?? ""),
    chargeAmount: Number(r.charge_amount ?? 0),
    x12Sha256: String(r.x12_sha256 ?? ""),
    outcome: String(r.outcome ?? "attempted") as LiveOutcome,
    receiptId: String(r.receipt_id ?? ""),
    note: String(r.note ?? ""),
    createdAt: Number(r.created_at ?? 0),
  };
}

export interface RecordAttemptInput {
  claimRef: string;
  payer: string;
  connector: string;
  environment: string;
  supervisor: string;
  chargeAmount: number;
  x12: string;
  now: number;
}

/** Write the attempt row. Call this BEFORE the send; the id comes back for the outcome update. */
export function recordAttempt(store: MemoryStore, input: RecordAttemptInput): string {
  const id = newId("live");
  db(store)
    .prepare(
      `INSERT INTO live_submissions
       (id, claim_ref, payer, connector, environment, supervisor, charge_amount, x12_sha256, outcome, receipt_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'attempted', '', '', ?)`,
    )
    .run(
      id, input.claimRef, input.payer, input.connector, input.environment,
      input.supervisor, input.chargeAmount, digestOf(input.x12), input.now,
    );
  return id;
}

/**
 * Record what came back.
 *
 * "unknown" is a first-class outcome and the important one. A timeout is not a
 * failure — it is an absence of information about whether the payer received
 * the claim, and recording it as `rejected` would invite exactly the resend
 * that must not happen.
 */
export function recordOutcome(
  store: MemoryStore,
  id: string,
  outcome: LiveOutcome,
  receiptId: string,
  note: string,
): void {
  db(store)
    .prepare("UPDATE live_submissions SET outcome = ?, receipt_id = ?, note = ? WHERE id = ?")
    .run(outcome, receiptId, note.slice(0, 500), id);
}

export function listLiveSubmissions(store: MemoryStore, limit = 50): LiveSubmission[] {
  try {
    return (db(store)
      .prepare("SELECT * FROM live_submissions ORDER BY created_at DESC LIMIT ?")
      .all(Math.min(limit, 500)) as Array<Record<string, unknown>>).map(toSubmission);
  } catch {
    return [];
  }
}

export function renderLedger(rows: LiveSubmission[]): string {
  if (rows.length === 0) return "No live submissions have been attempted from this deployment.";
  const unknown = rows.filter((r) => r.outcome === "unknown");
  const lines = [`${rows.length} live submission(s) attempted.`, ""];
  for (const r of rows) {
    lines.push(
      `  ${r.outcome.padEnd(9)} $${r.chargeAmount.toFixed(2).padStart(9)}  ${r.claimRef}  ${r.payer}` +
        (r.supervisor ? `  supervised by ${r.supervisor}` : "") +
        (r.receiptId ? `  receipt ${r.receiptId}` : ""),
    );
    if (r.note) lines.push(`             ${r.note}`);
  }
  if (unknown.length > 0) {
    lines.push(
      "",
      `${unknown.length} submission(s) have an UNKNOWN outcome. That is not the same as failed: the payer may hold ` +
        "these claims. Resolve each by checking STATUS (276/277) before doing anything else with them — resending " +
        "one the payer already has creates a duplicate, which cannot be undone.",
    );
  }
  // Duplicate digests are the thing this ledger exists to make provable.
  const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.x12Sha256, (seen.get(r.x12Sha256) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  if (dupes.length > 0) {
    lines.push(
      "",
      `${dupes.length} claim(s) were sent MORE THAN ONCE — identical 837 content. If the payer accepted both, ` +
        "these are duplicate claims and need voiding before they adjudicate twice.",
    );
  }
  return lines.join("\n");
}
