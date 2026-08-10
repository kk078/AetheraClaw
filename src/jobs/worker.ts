import { newId } from "../shared/ids.js";
import type { MemoryStore } from "../memory/store.js";
import { JOB_KINDS, claim, fail, makeJob, nextRunnable, reclaim, succeed, type EnqueueRequest, type Job } from "./queue.js";
import { enqueue, loadActive, saveJob } from "./store.js";

// ── The single consumer ──────────────────────────────────────────────────────
//
// One worker, inside the gateway process. Throughput is bounded by it, which is
// acceptable for a billing team and is documented as the limit it is rather than
// discovered later.
//
// The worker's only job is to move rows through the state machine in queue.ts.
// It makes no decisions of its own — in particular it does NOT decide whether to
// retry, because that decision has a domain rule behind it (never resend an 837)
// that belongs somewhere pure and tested rather than in a loop.

export type JobHandler = (job: Job) => Promise<void>;

export interface WorkerDeps {
  store: MemoryStore;
  handlers: Record<string, JobHandler>;
  /** Progress and outcomes, for the UI and the log. */
  emit?: (event: { type: string; [k: string]: unknown }) => void;
  /** Injected so tests do not wait on real time. */
  now?: () => number;
}

export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly now: () => number;

  constructor(private deps: WorkerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Reclaim anything a dead process left behind, then start ticking.
   *
   * Reclaim runs at START, not on a schedule. A lease expires because the
   * process holding it stopped, and the only moment a new process exists to
   * notice that is when it boots.
   */
  start(intervalMs = 2000): void {
    this.recoverOrphans();
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Do not hold the process open. A queue with nothing in it must not be the
    // reason `orion serve` refuses to exit on Ctrl-C.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Jobs whose worker died. Idempotent kinds requeue; the rest dead-letter loudly. */
  recoverOrphans(): void {
    for (const { job, note } of reclaim(loadActive(this.deps.store), this.now())) {
      saveJob(this.deps.store, job);
      this.deps.emit?.({ type: "job_recovered", jobId: job.id, kind: job.kind, status: job.status, note });
      if (job.status === "dead") console.error(`[jobs] ${note}`);
    }
  }

  enqueue(req: Omit<EnqueueRequest, "id"> & { id?: string }): { job: Job; created: boolean } {
    const job = makeJob({ ...req, id: req.id ?? newId("job") }, this.now());
    const res = enqueue(this.deps.store, job);
    this.deps.emit?.({
      type: "job_enqueued",
      jobId: res.job.id,
      kind: res.job.kind,
      // Said out loud rather than swallowed. A caller that uploads the same
      // archive twice should see that the second one joined the first, not
      // believe two batches are running.
      deduped: !res.created,
    });
    return res;
  }

  /** Run at most one job. Returns false when there was nothing to do. */
  async tick(): Promise<boolean> {
    if (this.busy) return false;
    const now = this.now();
    const next = nextRunnable(loadActive(this.deps.store), now);
    if (!next) return false;

    const handler = this.deps.handlers[next.kind];
    if (!handler) {
      // No handler is a deployment problem, not a work problem. It dead-letters
      // rather than spinning: retrying a job nothing can run would burn the
      // attempts and then dead-letter anyway, several minutes later, with a
      // less useful message.
      const outcome = fail(next, `no handler registered for job kind "${next.kind}"`, now);
      saveJob(this.deps.store, { ...outcome.job, status: "dead" });
      this.deps.emit?.({ type: "job_failed", jobId: next.id, kind: next.kind, note: outcome.note });
      return true;
    }

    this.busy = true;
    const running = claim(next, now);
    saveJob(this.deps.store, running);
    this.deps.emit?.({ type: "job_started", jobId: running.id, kind: running.kind, attempt: running.attempts });

    try {
      await handler(running);
      const done = succeed(running, this.now());
      saveJob(this.deps.store, done);
      this.deps.emit?.({ type: "job_done", jobId: done.id, kind: done.kind });
    } catch (err) {
      const outcome = fail(running, err instanceof Error ? err.message : String(err), this.now());
      saveJob(this.deps.store, outcome.job);
      this.deps.emit?.({
        type: "job_failed",
        jobId: outcome.job.id,
        kind: outcome.job.kind,
        willRetry: outcome.willRetry,
        note: outcome.note,
      });
      if (!outcome.willRetry) console.error(`[jobs] ${outcome.note}`);
    } finally {
      this.busy = false;
    }
    return true;
  }

  /** Run until the queue is empty. For tests and for `orion jobs drain`. */
  async drain(maxIterations = 1000): Promise<number> {
    let ran = 0;
    for (let i = 0; i < maxIterations; i++) {
      if (!(await this.tick())) break;
      ran++;
    }
    return ran;
  }
}

export function describeKinds(): string {
  return [
    "Job kinds, and whether a failure may be retried automatically:",
    ...Object.values(JOB_KINDS).map(
      (k) => `  ${k.name.padEnd(18)} ${k.idempotent ? "retryable" : "NEVER RETRIED"}  ${k.description}`,
    ),
  ].join("\n");
}
