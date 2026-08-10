import type { MemoryStore } from "../memory/store.js";
import type { Job, JobStatus } from "./queue.js";

// The I/O half. Every decision about what a job's next state should be lives in
// queue.ts and is pure; this file only reads and writes rows.

interface JobRow {
  id: string;
  kind: string;
  payload: string;
  status: string;
  attempts: number;
  max_attempts: number;
  run_after: number;
  lease_until: number;
  dedupe_key: string;
  last_error: string;
  session_id: string;
  created_at: number;
  updated_at: number;
}

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    kind: r.kind,
    payload: r.payload,
    status: r.status as JobStatus,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    runAfter: r.run_after,
    leaseUntil: r.lease_until,
    dedupeKey: r.dedupe_key,
    lastError: r.last_error,
    sessionId: r.session_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

type Db = { prepare: (sql: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] } };

function db(store: MemoryStore): Db {
  return (store as unknown as { db: Db }).db;
}

export interface EnqueueResult {
  job: Job;
  /** False when an identical job was already queued. The caller must not treat that as an error. */
  created: boolean;
}

/**
 * Insert a job, or return the one that already exists for this dedupe key.
 *
 * `INSERT OR IGNORE` then read back, rather than SELECT-then-INSERT. The second
 * shape has a window between the check and the write, and two uploads of the
 * same archive arriving together would both pass the check and both insert. The
 * unique index is the thing that actually enforces this; the code just has to
 * not fight it.
 */
export function enqueue(store: MemoryStore, job: Job): EnqueueResult {
  db(store)
    .prepare(
      `INSERT OR IGNORE INTO jobs
       (id, kind, payload, status, attempts, max_attempts, run_after, lease_until, dedupe_key, last_error, session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      job.id, job.kind, job.payload, job.status, job.attempts, job.maxAttempts,
      job.runAfter, job.leaseUntil, job.dedupeKey, job.lastError, job.sessionId, job.createdAt, job.updatedAt,
    );
  const row = db(store).prepare("SELECT * FROM jobs WHERE dedupe_key = ?").get(job.dedupeKey) as JobRow;
  return { job: toJob(row), created: row.id === job.id };
}

export function saveJob(store: MemoryStore, job: Job): void {
  db(store)
    .prepare(
      `UPDATE jobs SET status = ?, attempts = ?, run_after = ?, lease_until = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(job.status, job.attempts, job.runAfter, job.leaseUntil, job.lastError, job.updatedAt, job.id);
}

export function getJob(store: MemoryStore, id: string): Job | null {
  const row = db(store).prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  return row ? toJob(row) : null;
}

/**
 * Jobs that are not finished.
 *
 * `done` rows are excluded because the scheduler never needs them and a queue
 * that has run for a month would otherwise read its whole history on every tick.
 */
export function loadActive(store: MemoryStore): Job[] {
  return (db(store)
    .prepare("SELECT * FROM jobs WHERE status IN ('queued','running','dead') ORDER BY created_at ASC")
    .all() as JobRow[]).map(toJob);
}

export function listJobs(store: MemoryStore, opts: { sessionId?: string; limit?: number } = {}): Job[] {
  const limit = Math.min(opts.limit ?? 50, 500);
  const rows = opts.sessionId
    ? db(store).prepare("SELECT * FROM jobs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?").all(opts.sessionId, limit)
    : db(store).prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit);
  return (rows as JobRow[]).map(toJob);
}

/**
 * Delete finished jobs older than a cutoff.
 *
 * Only `done`. Dead-lettered rows are never swept: they are the ones a person
 * still has to decide about, and a queue that quietly deletes its failures
 * reports a clean board while the work sits unfiled.
 */
export function pruneJobs(store: MemoryStore, olderThanMs: number): number {
  const res = db(store).prepare("DELETE FROM jobs WHERE status = 'done' AND updated_at < ?").run(olderThanMs) as {
    changes?: number;
  };
  return res?.changes ?? 0;
}
