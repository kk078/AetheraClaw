// ── The job queue's rules, with no database in sight ─────────────────────────
//
// Long work currently happens inside an agent turn: a 40-file archive, a
// quarterly dataset refresh, a batch of eligibility checks. The turn holds the
// socket open, the browser eventually gives up, and the work is lost with no
// record that it ran. This is the state machine that fixes that.
//
// D4 in the roadmap chose SQLite over Redis/BullMQ, and the reason stands: this
// product's main operational virtue is that it is one process and one file, and
// a second stateful service costs more than the throughput it buys. The price is
// a single consumer, which is stated as the limit it is rather than hidden.
//
// THE RULE THAT MAKES THIS DIFFERENT FROM A GENERIC QUEUE:
//
//   A JOB IS NOT AUTOMATICALLY RETRIED UNLESS ITS KIND SAYS IT IS SAFE TO.
//
// Generic queues retry everything, because generic queues move messages. This
// one can be asked to submit an 837, and `ClearinghouseConnector.submitClaim`
// documents in full why a retry of a submit that actually succeeded is
// unrecoverable: it creates a duplicate claim, which a payer treats as
// fraud-adjacent and a practice discovers as a takeback months later. A timeout
// does not tell you whether the payer received it. So a non-idempotent job that
// fails goes STRAIGHT to dead-letter with the reason and a human decides — and
// the correct next step is a status check, never a resend.
//
// Everything here is pure. `now` is a parameter; nothing calls the clock.

export type JobStatus = "queued" | "running" | "done" | "failed" | "dead";

export interface Job {
  id: string;
  kind: string;
  /** JSON payload, opaque to the queue. */
  payload: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  /** Not runnable before this. Backoff and scheduling both use it. */
  runAfter: number;
  /** Set while running; a lease that has expired means the worker died. */
  leaseUntil: number;
  /** Collision key. Two enqueues with the same key are the same job. */
  dedupeKey: string;
  lastError: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
}

export interface JobKind {
  name: string;
  /**
   * Whether running this twice is harmless.
   *
   * FALSE is the safe default and the interesting case. A false here means a
   * failure is never retried automatically, whatever the cause — see the header.
   */
  idempotent: boolean;
  /** How many attempts an idempotent job gets before dead-letter. */
  maxAttempts: number;
  /** How long a worker may hold it before the lease is considered lost. */
  leaseMs: number;
  description: string;
}

/**
 * The kinds this build knows.
 *
 * Adding a kind is a deliberate act, and `idempotent: true` is a claim about the
 * work that somebody has to be willing to make. Anything that talks to a payer
 * is false and will stay false.
 */
export const JOB_KINDS: Record<string, JobKind> = {
  archive_ingest: {
    name: "archive_ingest",
    idempotent: true,
    maxAttempts: 3,
    leaseMs: 15 * 60_000,
    description:
      "Expand and extract an uploaded archive. Safe to retry: documents dedupe on (sha256, session_id), so a " +
      "re-run re-reads files rather than creating second copies.",
  },
  dataset_refresh: {
    name: "dataset_refresh",
    idempotent: true,
    maxAttempts: 3,
    leaseMs: 30 * 60_000,
    description: "Fetch the current public CMS reference files. Safe to retry: it overwrites whole files.",
  },
  eligibility_batch: {
    name: "eligibility_batch",
    idempotent: true,
    maxAttempts: 2,
    leaseMs: 10 * 60_000,
    description: "Run eligibility for a list of patients. A READ at the payer, so a repeat costs a duplicate enquiry and nothing else.",
  },
  claim_submit: {
    name: "claim_submit",
    idempotent: false,
    maxAttempts: 1,
    leaseMs: 5 * 60_000,
    description:
      "Send an 837. NEVER retried automatically. A timeout does not say whether the payer received it, and a " +
      "resend that duplicates a filed claim cannot be undone by deploying a fix. On failure this dead-letters " +
      "and a human checks STATUS before deciding anything.",
  },
};

export interface EnqueueRequest {
  id: string;
  kind: string;
  payload: string;
  sessionId: string;
  /** Defaults to the id, which makes an unkeyed job always unique. */
  dedupeKey?: string;
  runAfter?: number;
}

/** Build a job row. Throws on an unknown kind rather than inventing a policy for it. */
export function makeJob(req: EnqueueRequest, now: number): Job {
  const spec = JOB_KINDS[req.kind];
  if (!spec) {
    throw new Error(
      `Unknown job kind "${req.kind}". Kinds are declared in src/jobs/queue.ts so that whether a failure may be ` +
        "retried is a decision somebody made, not a default.",
    );
  }
  return {
    id: req.id,
    kind: req.kind,
    payload: req.payload,
    status: "queued",
    attempts: 0,
    maxAttempts: spec.maxAttempts,
    runAfter: req.runAfter ?? now,
    leaseUntil: 0,
    dedupeKey: req.dedupeKey ?? req.id,
    lastError: "",
    sessionId: req.sessionId,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Exponential backoff with a ceiling.
 *
 * Ceilinged because an uncapped backoff on a job that has been retried five
 * times schedules it beyond the point anyone is still watching, which reads to
 * an operator as the job having silently vanished.
 */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
}

/**
 * Is this job runnable now?
 *
 * Two ways in: it is queued and due, or it is `running` with an EXPIRED LEASE,
 * which means the worker holding it died. The second is what makes a crash
 * recoverable without a separate janitor process — the next worker to look
 * simply finds it runnable again.
 */
export function isRunnable(job: Job, now: number): boolean {
  if (job.status === "queued") return job.runAfter <= now;
  if (job.status === "running") return job.leaseUntil <= now;
  return false;
}

/** Pick the next job to run: oldest runnable first, so nothing starves. */
export function nextRunnable(jobs: Job[], now: number): Job | null {
  const runnable = jobs.filter((j) => isRunnable(j, now));
  if (runnable.length === 0) return null;
  return runnable.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
}

/** Take a job: mark it running and stamp a lease. */
export function claim(job: Job, now: number): Job {
  const spec = JOB_KINDS[job.kind];
  return {
    ...job,
    status: "running",
    attempts: job.attempts + 1,
    leaseUntil: now + (spec?.leaseMs ?? 5 * 60_000),
    updatedAt: now,
  };
}

export function succeed(job: Job, now: number): Job {
  return { ...job, status: "done", leaseUntil: 0, lastError: "", updatedAt: now };
}

export interface FailureOutcome {
  job: Job;
  /** True when it will be tried again. */
  willRetry: boolean;
  /** What to tell a human. Always populated when it dead-letters. */
  note: string;
}

/**
 * Record a failure and decide what happens next.
 *
 * The decision order matters. The idempotency check comes FIRST, before attempts
 * are consulted — so a non-idempotent job dead-letters on its first failure even
 * if somebody set maxAttempts to five. Reading the counter first would make an
 * unsafe retry reachable through a configuration mistake, and the whole point is
 * that this one cannot be reached by accident.
 */
export function fail(job: Job, error: string, now: number): FailureOutcome {
  const spec = JOB_KINDS[job.kind];
  const message = error.slice(0, 500);

  if (spec && !spec.idempotent) {
    return {
      job: { ...job, status: "dead", leaseUntil: 0, lastError: message, updatedAt: now },
      willRetry: false,
      note:
        `${job.kind} failed and will NOT be retried automatically: ${message}. This kind is not idempotent — a ` +
        "failure does not say whether the far side received it, so a resend risks doing the work twice. Check the " +
        "STATUS of this work before deciding anything.",
    };
  }

  if (job.attempts >= job.maxAttempts) {
    return {
      job: { ...job, status: "dead", leaseUntil: 0, lastError: message, updatedAt: now },
      willRetry: false,
      note: `${job.kind} failed ${job.attempts} time(s) and has been dead-lettered: ${message}`,
    };
  }

  const delay = backoffMs(job.attempts);
  return {
    job: {
      ...job,
      status: "queued",
      leaseUntil: 0,
      runAfter: now + delay,
      lastError: message,
      updatedAt: now,
    },
    willRetry: true,
    note: `${job.kind} failed (attempt ${job.attempts} of ${job.maxAttempts}), retrying in ${Math.round(delay / 1000)}s: ${message}`,
  };
}

/**
 * Reclaim jobs whose worker died.
 *
 * A job left `running` past its lease is not evidence the work failed — it is
 * evidence nobody is watching it any more. For an idempotent kind that means run
 * it again. For a non-idempotent kind it emphatically does not: the process may
 * have died AFTER the 837 went out, and re-running would file it twice. Those
 * dead-letter, and a human reads the note.
 */
export function reclaim(jobs: Job[], now: number): Array<{ job: Job; note: string }> {
  const out: Array<{ job: Job; note: string }> = [];
  for (const job of jobs) {
    if (job.status !== "running" || job.leaseUntil > now) continue;
    const spec = JOB_KINDS[job.kind];
    if (spec && !spec.idempotent) {
      out.push({
        job: { ...job, status: "dead", leaseUntil: 0, updatedAt: now, lastError: "worker died while this was running" },
        note:
          `${job.kind} ${job.id} was running when the process stopped. It is NOT being restarted: the work may have ` +
          "completed before the crash, and repeating it would do it twice. Check status before resubmitting anything.",
      });
      continue;
    }
    out.push({
      job: { ...job, status: "queued", leaseUntil: 0, runAfter: now, updatedAt: now },
      note: `${job.kind} ${job.id} was reclaimed after its worker stopped, and will run again.`,
    });
  }
  return out;
}

export interface QueueSummary {
  queued: number;
  running: number;
  done: number;
  failed: number;
  dead: number;
}

export function summarise(jobs: Job[]): QueueSummary {
  const s: QueueSummary = { queued: 0, running: 0, done: 0, failed: 0, dead: 0 };
  for (const j of jobs) s[j.status] += 1;
  return s;
}

export function renderQueue(jobs: Job[], now: number): string {
  const s = summarise(jobs);
  const lines = [
    `Jobs: ${s.queued} queued, ${s.running} running, ${s.done} done, ${s.dead} dead-lettered.`,
  ];
  const dead = jobs.filter((j) => j.status === "dead");
  if (dead.length > 0) {
    // Dead-lettered work is listed in full and never summarised into a count.
    // These are the jobs a person has to decide about, and a number tells nobody
    // which claim is sitting unfiled.
    lines.push("", "Dead-lettered — these need a decision, and are not being retried:");
    for (const j of dead) lines.push(`  ${j.kind} ${j.id}: ${j.lastError || "no reason recorded"}`);
  }
  const stuck = jobs.filter((j) => j.status === "running" && j.leaseUntil <= now);
  if (stuck.length > 0) lines.push("", `${stuck.length} job(s) hold an expired lease and will be reclaimed.`);
  return lines.join("\n");
}
