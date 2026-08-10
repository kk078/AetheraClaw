import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.js";
import { JobWorker } from "../src/jobs/worker.js";
import { getJob, pruneJobs, saveJob } from "../src/jobs/store.js";
import {
  JOB_KINDS,
  backoffMs,
  claim,
  fail,
  isRunnable,
  makeJob,
  nextRunnable,
  reclaim,
  renderQueue,
  succeed,
  summarise,
  type Job,
} from "../src/jobs/queue.js";

// `now` is a literal in every test. Nothing in the queue reads a clock, so a
// backoff schedule can be asserted exactly rather than approximately.

const T0 = 1_800_000_000_000;

function job(over: Partial<Job> = {}): Job {
  return { ...makeJob({ id: "j1", kind: "archive_ingest", payload: "{}", sessionId: "s1" }, T0), ...over };
}

describe("job kinds", () => {
  it("declares whether each kind may be retried, with a reason", () => {
    for (const k of Object.values(JOB_KINDS)) {
      expect(k.description.length).toBeGreaterThan(30);
      expect(k.leaseMs).toBeGreaterThan(0);
    }
  });

  it("marks claim submission as NOT idempotent", () => {
    // The load-bearing declaration in the whole module. A retry of a submit that
    // actually succeeded files the claim twice, which a payer treats as
    // fraud-adjacent and cannot be undone by deploying a fix.
    expect(JOB_KINDS.claim_submit.idempotent).toBe(false);
    expect(JOB_KINDS.claim_submit.maxAttempts).toBe(1);
  });

  it("refuses an unknown kind rather than inventing a retry policy for it", () => {
    expect(() => makeJob({ id: "x", kind: "invented", payload: "{}", sessionId: "" }, T0)).toThrow(/Unknown job kind/);
  });
});

describe("scheduling", () => {
  it("does not run a job before its run_after", () => {
    expect(isRunnable(job({ runAfter: T0 + 5000 }), T0)).toBe(false);
    expect(isRunnable(job({ runAfter: T0 + 5000 }), T0 + 5000)).toBe(true);
  });

  it("treats a running job with an EXPIRED lease as runnable again", () => {
    // An expired lease means the worker died. That is what makes a crash
    // recoverable without a separate janitor process.
    expect(isRunnable(job({ status: "running", leaseUntil: T0 - 1 }), T0)).toBe(true);
    expect(isRunnable(job({ status: "running", leaseUntil: T0 + 60_000 }), T0)).toBe(false);
  });

  it("never reruns a finished job", () => {
    for (const status of ["done", "dead", "failed"] as const) {
      expect(isRunnable(job({ status }), T0 + 1_000_000)).toBe(false);
    }
  });

  it("takes the oldest runnable first, so nothing starves", () => {
    const old = job({ id: "old", createdAt: T0 - 10_000 });
    const recent = job({ id: "recent", createdAt: T0 });
    expect(nextRunnable([recent, old], T0)?.id).toBe("old");
  });

  it("returns nothing when the queue is empty or everything is scheduled ahead", () => {
    expect(nextRunnable([], T0)).toBeNull();
    expect(nextRunnable([job({ runAfter: T0 + 1 })], T0)).toBeNull();
  });
});

describe("claiming and completing", () => {
  it("stamps a lease and counts the attempt", () => {
    const c = claim(job(), T0);
    expect(c.status).toBe("running");
    expect(c.attempts).toBe(1);
    expect(c.leaseUntil).toBe(T0 + JOB_KINDS.archive_ingest.leaseMs);
  });

  it("clears the lease and the error on success", () => {
    const done = succeed(claim(job({ lastError: "earlier failure" }), T0), T0 + 1000);
    expect(done.status).toBe("done");
    expect(done.leaseUntil).toBe(0);
    expect(done.lastError).toBe("");
  });
});

describe("failure handling", () => {
  it("retries an idempotent job with a growing delay", () => {
    const first = fail(claim(job(), T0), "network reset", T0 + 100);
    expect(first.willRetry).toBe(true);
    expect(first.job.status).toBe("queued");
    expect(first.job.runAfter).toBe(T0 + 100 + backoffMs(1));

    const second = fail(claim(first.job, T0 + 100), "network reset", T0 + 200);
    expect(second.job.runAfter - (T0 + 200)).toBeGreaterThan(first.job.runAfter - (T0 + 100));
  });

  it("caps the backoff rather than scheduling past the point anyone is watching", () => {
    expect(backoffMs(50)).toBe(15 * 60_000);
  });

  it("dead-letters an idempotent job once its attempts are spent", () => {
    let j = job();
    let outcome = { job: j, willRetry: true, note: "" };
    for (let i = 0; i < JOB_KINDS.archive_ingest.maxAttempts; i++) {
      outcome = fail(claim(outcome.job, T0), "boom", T0);
    }
    expect(outcome.willRetry).toBe(false);
    expect(outcome.job.status).toBe("dead");
  });

  it("dead-letters a NON-idempotent job on its very first failure", () => {
    const submit = claim(job({ id: "sub", kind: "claim_submit" }), T0);
    const outcome = fail(submit, "timeout waiting for the clearinghouse", T0);
    expect(outcome.willRetry).toBe(false);
    expect(outcome.job.status).toBe("dead");
    // The note is what a human reads at 4pm on a Friday. It has to say what NOT
    // to do, because the obvious action — send it again — is the harmful one.
    expect(outcome.note).toMatch(/NOT be retried/i);
    expect(outcome.note).toMatch(/STATUS/);
  });

  it("checks idempotency BEFORE attempts, so a config mistake cannot reach a resend", () => {
    // maxAttempts raised to 5 by hand. It must not matter.
    const submit = claim(job({ id: "sub", kind: "claim_submit", maxAttempts: 5 }), T0);
    expect(fail(submit, "boom", T0).willRetry).toBe(false);
  });
});

describe("crash recovery", () => {
  it("requeues an idempotent job whose worker died", () => {
    const orphan = job({ status: "running", leaseUntil: T0 - 1 });
    const [out] = reclaim([orphan], T0);
    expect(out.job.status).toBe("queued");
    expect(out.job.runAfter).toBe(T0);
  });

  it("does NOT restart a submit that was in flight when the process stopped", () => {
    // The process may have died AFTER the 837 went out. Re-running would file
    // it twice, and nothing in a lease expiry distinguishes the two cases.
    const orphan = job({ id: "sub", kind: "claim_submit", status: "running", leaseUntil: T0 - 1 });
    const [out] = reclaim([orphan], T0);
    expect(out.job.status).toBe("dead");
    expect(out.note).toMatch(/NOT being restarted/i);
  });

  it("leaves a job whose lease is still good alone", () => {
    expect(reclaim([job({ status: "running", leaseUntil: T0 + 60_000 })], T0)).toEqual([]);
  });

  it("leaves queued and finished jobs alone", () => {
    expect(reclaim([job({ status: "queued" }), job({ status: "done" })], T0)).toEqual([]);
  });
});

describe("reporting", () => {
  it("counts every status", () => {
    const s = summarise([job({ status: "queued" }), job({ status: "running" }), job({ status: "dead" })]);
    expect(s).toMatchObject({ queued: 1, running: 1, dead: 1, done: 0 });
  });

  it("lists dead-lettered jobs individually rather than as a count", () => {
    // These are the ones a person has to decide about. A number tells nobody
    // which claim is sitting unfiled.
    const out = renderQueue(
      [job({ id: "sub", kind: "claim_submit", status: "dead", lastError: "clearinghouse timeout" })],
      T0,
    );
    expect(out).toContain("sub");
    expect(out).toContain("clearinghouse timeout");
    expect(out).toMatch(/need a decision/i);
  });

  it("flags jobs holding an expired lease", () => {
    expect(renderQueue([job({ status: "running", leaseUntil: T0 - 1 })], T0)).toMatch(/expired lease/);
  });
});

// ── Against a real database ─────────────────────────────────────────────────
// The two properties the roadmap named for this phase can only be shown with a
// store: a job enqueued twice runs once, and a crash-restart resumes. Both are
// about the UNIQUE index and the lease, neither of which exists in the pure
// layer.

describe("the queue against a real database", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "orion-jobs-"));
    store = new MemoryStore(path.join(dir, "test.db"));
  });
  afterEach(() => {
    store.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runs a job enqueued twice exactly once", async () => {
    const ran: string[] = [];
    const worker = new JobWorker({
      store,
      now: () => T0,
      handlers: { archive_ingest: async (j) => void ran.push(j.id) },
    });

    const first = worker.enqueue({ kind: "archive_ingest", payload: "{}", sessionId: "s1", dedupeKey: "sha256:abc" });
    const second = worker.enqueue({ kind: "archive_ingest", payload: "{}", sessionId: "s1", dedupeKey: "sha256:abc" });

    expect(first.created).toBe(true);
    // Not an error — the caller uploaded the same archive twice and the second
    // upload joined the first rather than starting a second batch.
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);

    await worker.drain();
    expect(ran).toEqual([first.job.id]);
  });

  it("resumes an idempotent job left running by a dead process", async () => {
    const worker = new JobWorker({ store, now: () => T0, handlers: {} });
    const { job: enqueued } = worker.enqueue({ kind: "archive_ingest", payload: "{}", sessionId: "s1" });
    // Simulate the crash: claimed, lease stamped, process gone.
    saveJob(store, { ...enqueued, status: "running", leaseUntil: T0 - 1, attempts: 1 });

    const ran: string[] = [];
    const restarted = new JobWorker({
      store,
      now: () => T0,
      handlers: { archive_ingest: async (j) => void ran.push(j.id) },
    });
    restarted.recoverOrphans();
    await restarted.drain();

    expect(ran).toEqual([enqueued.id]);
    expect(getJob(store, enqueued.id)?.status).toBe("done");
  });

  it("does NOT resume a submit left running by a dead process", async () => {
    const worker = new JobWorker({ store, now: () => T0, handlers: {} });
    const { job: enqueued } = worker.enqueue({ kind: "claim_submit", payload: "{}", sessionId: "s1" });
    saveJob(store, { ...enqueued, status: "running", leaseUntil: T0 - 1, attempts: 1 });

    const ran: string[] = [];
    const restarted = new JobWorker({
      store,
      now: () => T0,
      handlers: { claim_submit: async (j) => void ran.push(j.id) },
    });
    restarted.recoverOrphans();
    await restarted.drain();

    expect(ran).toEqual([]);
    expect(getJob(store, enqueued.id)?.status).toBe("dead");
  });

  it("dead-letters a kind with no handler instead of spinning on it", async () => {
    const worker = new JobWorker({ store, now: () => T0, handlers: {} });
    const { job: enqueued } = worker.enqueue({ kind: "dataset_refresh", payload: "{}", sessionId: "" });
    await worker.drain();
    const after = getJob(store, enqueued.id);
    expect(after?.status).toBe("dead");
    expect(after?.lastError).toContain("no handler");
  });

  it("keeps dead-lettered rows when pruning, and removes finished ones", async () => {
    const worker = new JobWorker({
      store,
      now: () => T0,
      handlers: { archive_ingest: async () => {}, dataset_refresh: async () => { throw new Error("nope"); } },
    });
    const ok = worker.enqueue({ kind: "archive_ingest", payload: "{}", sessionId: "" }).job;
    const bad = worker.enqueue({ kind: "dataset_refresh", payload: "{}", sessionId: "" }).job;
    await worker.drain();
    // Force the failing one all the way to dead rather than waiting out backoff.
    saveJob(store, { ...getJob(store, bad.id)!, status: "dead" });

    pruneJobs(store, T0 + 1);
    expect(getJob(store, ok.id)).toBeNull();
    // A queue that quietly deletes its failures reports a clean board while the
    // work sits unfiled.
    expect(getJob(store, bad.id)?.status).toBe("dead");
  });

  it("reports a job's progress through events a UI can render", async () => {
    const events: string[] = [];
    const worker = new JobWorker({
      store,
      now: () => T0,
      emit: (e) => void events.push(String(e.type)),
      handlers: { archive_ingest: async () => {} },
    });
    worker.enqueue({ kind: "archive_ingest", payload: "{}", sessionId: "s1" });
    await worker.drain();
    expect(events).toEqual(["job_enqueued", "job_started", "job_done"]);
  });
});
