// ── Tool call log ────────────────────────────────────────────────────────────
// Until now a failure was visible only where something happened to record it: a
// worklist item, an audit entry, a line in the transcript. support_fmea_diagnose
// could classify failure text expertly and had no way to obtain any, so an
// engineer had to go and find the errors before the tool that explains errors
// could help. This closes that loop.
//
// Two decisions shape the table, and they pull in opposite directions.
//
// WHAT NOT TO STORE. Tool input carries claim data — diagnoses, subscriber ids,
// the contents of a remittance. A log of every tool call that stored its inputs
// would quickly become the largest store of that data in the system, with
// weaker access control than the tables it copied from, and it would sit there
// whether or not anyone ever read it. So inputs are reduced to their SHAPE: the
// key names, never the values. "claim, documentation, em_line" is enough to see
// that a call was malformed; the values add nothing a diagnosis needs.
//
// WHAT MUST BE STORED. The error text is the whole point — it is what the
// classifier reads. It cannot be reduced to a shape without destroying its use.
// But error text is generated, not supplied, and generated text does sometimes
// quote its input: a zod message echoes the value it rejected. So error text is
// SCRUBBED rather than refused.
//
// That is deliberately the opposite of the PHI access log next door, which
// refuses an identifier-shaped reference outright. The difference is who wrote
// the string. There, a caller passing an identifier has a bug at the call site
// and refusing makes them fix it. Here the string came from a library, nobody
// chose it, and refusing would throw away the diagnosis to punish a mistake no
// one made.

export interface ToolCallRecord {
  sessionId: string;
  toolName: string;
  ok: boolean;
  /** "ok" | "invalid_input" | "unknown_tool" | "denied" | "error" */
  outcome: ToolOutcome;
  durationMs: number;
  /** Key names of the input object, never values. */
  inputShape: string;
  /** Scrubbed. Empty on success. */
  errorText: string;
  /**
   * 0 for a call the model made directly, 1+ for one reached through a wrapper.
   *
   * `tool_invoke` re-enters the registry, so one logical call produces two rows:
   * the inner tool and the wrapper. Both are true and both are worth keeping —
   * the wrapper's row is the only record that discovery-by-catalogue happened —
   * but the wrapper PROPAGATES the inner failure, so counting it as its own
   * failure would inflate tool_invoke's rate with every other tool's problems
   * and point an engineer straight at the wrong tool.
   */
  depth: number;
  at: number;
}

export type ToolOutcome = "ok" | "invalid_input" | "unknown_tool" | "denied" | "error";

/**
 * Identifier shapes that must not survive into the log.
 *
 * Same shapes the access log refuses, handled differently — see the header.
 * Replaced with a labelled marker rather than removed, so a reader can see that
 * something was there and what kind: an error message with a silent hole in it
 * reads as a truncation bug.
 */
const IDENTIFIER_SHAPES: Array<{ label: string; pattern: RegExp }> = [
  { label: "SSN", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: "MBI", pattern: /\b[1-9][ACDEFGHJKMNPQRTUVWXY][ACDEFGHJKMNPQRTUVWXY0-9]\d[ACDEFGHJKMNPQRTUVWXY][ACDEFGHJKMNPQRTUVWXY0-9]\d[ACDEFGHJKMNPQRTUVWXY]{2}\d{2}\b/gi },
  { label: "HICN", pattern: /\b\d{9}[A-Z]{1,2}\d?\b/g },
  { label: "email", pattern: /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi },
  { label: "date", pattern: /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g },
];

export const MAX_ERROR_TEXT = 2000;

export function scrubErrorText(text: string): string {
  let out = text;
  for (const s of IDENTIFIER_SHAPES) out = out.replace(s.pattern, `[redacted:${s.label}]`);
  return out.length > MAX_ERROR_TEXT ? `${out.slice(0, MAX_ERROR_TEXT)}…[truncated]` : out;
}

/**
 * The key names of an input object, sorted.
 *
 * Sorted so the same call shape produces the same string regardless of key
 * order, which is what makes "every failure had this shape" a groupable fact
 * rather than a coincidence of serialization.
 */
export function inputShapeOf(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (Array.isArray(input)) return `[${input.length}]`;
  if (typeof input !== "object") return typeof input;
  return Object.keys(input as Record<string, unknown>).sort().join(", ");
}

export function outcomeOf(content: string, isError: boolean | undefined): ToolOutcome {
  if (!isError) return "ok";
  if (content.startsWith("Unknown tool:")) return "unknown_tool";
  if (content.startsWith("Invalid input for")) return "invalid_input";
  if (content.startsWith("User denied permission")) return "denied";
  return "error";
}

// ── Retention ────────────────────────────────────────────────────────────────
// This table grows with every tool call, forever, and nothing else in the system
// does that. An operational log that fills the disk is an operational incident
// of its own, so retention is part of the design rather than a later problem.

export const RETAIN_DAYS = 30;
export const RETAIN_MAX_ROWS = 200_000;

export interface RetentionPlan {
  /** Rows older than this are removed. */
  cutoff: number;
  /** Hard row ceiling regardless of age, so a burst cannot outrun the age rule. */
  maxRows: number;
}

export function retentionPlan(now: number, days = RETAIN_DAYS, maxRows = RETAIN_MAX_ROWS): RetentionPlan {
  return { cutoff: now - days * 86_400_000, maxRows };
}

// ── Reading it back ──────────────────────────────────────────────────────────

export interface FailureSummary {
  total: number;
  failures: number;
  byTool: Array<{ tool: string; calls: number; failures: number; failureRate: number }>;
  slowest: Array<{ tool: string; p50: number; p95: number; calls: number }>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * Per-tool call counts, failure rates and latency.
 *
 * Failure RATE rather than failure count, because the count alone ranks the
 * busiest tool first: `icd10_search` failing 20 times out of 5,000 is healthy
 * and `claim_build_837p` failing 3 times out of 3 is broken, and a list sorted
 * by count puts them in the wrong order.
 */
/**
 * Tools that re-enter the registry, so their failures are somebody else's.
 *
 * `tool_invoke` runs the requested tool through the same choke point and returns
 * its result unchanged. One logical call therefore produces two rows: the inner
 * tool at depth 1, which is the one that actually broke, and the wrapper at
 * depth 0, which merely carried the failure out. Counting the wrapper's failures
 * would put the router at the top of the list every time discovery was used, and
 * an engineer would go and read the router.
 */
export const WRAPPER_TOOLS = new Set(["tool_invoke"]);

export function summarizeCalls(records: ToolCallRecord[], wrappers = WRAPPER_TOOLS): FailureSummary {
  const byTool = new Map<string, { calls: number; failures: number; durations: number[] }>();
  for (const r of records) {
    // Its failure is already attributed accurately on the inner tool's own row.
    if (!r.ok && wrappers.has(r.toolName)) continue;
    const slot = byTool.get(r.toolName) ?? { calls: 0, failures: 0, durations: [] };
    slot.calls++;
    if (!r.ok) slot.failures++;
    slot.durations.push(r.durationMs);
    byTool.set(r.toolName, slot);
  }

  return {
    total: records.length,
    // The headline count excludes wrapper failures for the same reason, so the
    // total and the per-tool table cannot disagree about how much broke.
    failures: records.filter((r) => !r.ok && !wrappers.has(r.toolName)).length,
    byTool: [...byTool.entries()]
      .map(([tool, v]) => ({ tool, calls: v.calls, failures: v.failures, failureRate: v.calls ? v.failures / v.calls : 0 }))
      .filter((t) => t.failures > 0)
      .sort((a, b) => b.failureRate - a.failureRate || b.failures - a.failures),
    slowest: [...byTool.entries()]
      .map(([tool, v]) => {
        const sorted = [...v.durations].sort((a, b) => a - b);
        return { tool, p50: percentile(sorted, 50), p95: percentile(sorted, 95), calls: v.calls };
      })
      .sort((a, b) => b.p95 - a.p95)
      .slice(0, 5),
  };
}

export function renderCallSummary(summary: FailureSummary, windowLabel: string): string {
  if (summary.total === 0) {
    return `No tool calls recorded ${windowLabel}. Calls are logged as they happen, so an empty log means nothing ran in this window — not that nothing failed.`;
  }

  const lines = [
    `${summary.total} tool call(s) ${windowLabel}, ${summary.failures} failed (${((summary.failures / summary.total) * 100).toFixed(1)}%).`,
  ];

  if (summary.byTool.length > 0) {
    lines.push(
      "",
      "By failure RATE, not count — the busiest tool is not the broken one:",
      ...summary.byTool
        .slice(0, 10)
        .map((t) => `  ${(t.failureRate * 100).toFixed(0).padStart(3)}%  ${t.tool}  (${t.failures} of ${t.calls})`),
    );
  }

  if (summary.slowest.length > 0 && summary.slowest[0].p95 > 0) {
    lines.push(
      "",
      "Slowest by p95:",
      ...summary.slowest.map((s) => `  ${String(s.p95).padStart(6)} ms  ${s.tool}  (p50 ${s.p50} ms, ${s.calls} calls)`),
    );
  }
  return lines.join("\n");
}
