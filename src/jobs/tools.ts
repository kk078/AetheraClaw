import { z } from "zod";
import { defineTool } from "../tools/registry.js";
import type { MemoryStore } from "../memory/store.js";
import { listJobs } from "./store.js";
import { describeKinds, type JobWorker } from "./worker.js";
import { renderQueue } from "./queue.js";

export const jobListTool = defineTool({
  name: "job_list",
  description:
    "Show deferred work: what is queued, what is running, and what dead-lettered. Call this before telling anyone a " +
    "long operation finished — a job that dead-lettered has NOT run, and for claim submission a dead-lettered job " +
    "means the claim's fate is unknown and must be resolved by checking status, never by resending.",
  schema: z.object({
    session_only: z.boolean().default(false).describe("Limit to jobs started from this session"),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "No job store is attached to this session." };
    const jobs = listJobs(store, {
      sessionId: input.session_only ? ctx.sessionId : undefined,
      limit: input.limit,
    });
    if (jobs.length === 0) return { content: "No jobs recorded." };
    return {
      content: [
        renderQueue(jobs, Date.now()),
        "",
        ...jobs.map(
          (j) =>
            `  ${j.status.padEnd(8)} ${j.kind.padEnd(18)} ${j.id}` +
            (j.attempts > 1 ? `  attempt ${j.attempts}/${j.maxAttempts}` : "") +
            (j.lastError ? `  — ${j.lastError}` : ""),
        ),
      ].join("\n"),
    };
  },
});

export const jobKindsTool = defineTool({
  name: "job_kinds",
  description:
    "List the kinds of deferred work this build can run and, for each, whether a failure is retried automatically. " +
    "Read this before suggesting that a failed job be run again.",
  schema: z.object({}),
  execute: async () => ({ content: describeKinds() }),
});

/** Registered from the gateway, where a worker exists. */
export function jobEnqueueTool(worker: JobWorker) {
  return defineTool({
    name: "job_enqueue",
    description:
      "Queue a long-running operation to run in the background instead of holding a turn open. Enqueuing the same " +
      "work twice with the same dedupe_key joins the first job rather than starting a second.",
    schema: z.object({
      kind: z.string().describe("A kind from job_kinds"),
      payload: z.record(z.unknown()).default({}),
      dedupe_key: z.string().optional().describe("Same key = same job. Use a content hash where one exists."),
    }),
    execute: async (input, ctx) => {
      try {
        const res = worker.enqueue({
          kind: input.kind,
          payload: JSON.stringify(input.payload),
          sessionId: ctx.sessionId,
          dedupeKey: input.dedupe_key,
        });
        return {
          content: res.created
            ? `Queued ${res.job.kind} as ${res.job.id}. Check job_list for progress.`
            : `That work was already queued as ${res.job.id} — this request joined it rather than starting a second run.`,
        };
      } catch (err) {
        // An unknown kind lands here. Saying so beats a stack trace: the fix is
        // to pick a declared kind, and job_kinds lists them.
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  });
}
