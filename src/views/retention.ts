import type { RetentionPlan } from "../support/tool-log.js";

// ── Tool-view retention ──────────────────────────────────────────────────────
// `tool_views` grows with every rendered tool call and, until now, shrank never.
// That is the same unbounded growth `tool_calls` has a policy for — but the two
// tables are not the same kind of thing, and copying the policy across would be
// wrong in a way that costs a user their transcript.
//
// A tool-call row is a diagnostic. Nobody misses one from six weeks ago.
// A VIEW is part of a session: it is what the console re-renders when somebody
// reopens that conversation. Delete it and the session still loads, but the
// claim form, the waterfall and the E/M meter come back as bare text — a
// silently degraded record, which is worse than an obviously missing one.
//
// So the order matters, and it is deliberately not "oldest first":
//
//   1. ORPHANS — views whose session no longer exists. There is no foreign key
//      on this table, so deleting a session leaves its views behind forever.
//      This is the only category that is pure dead weight, and in practice it is
//      most of what accumulates.
//   2. AGE — and a long one. Ninety days, not thirty, because the thing being
//      protected is a readable session rather than a log tail.
//   3. A ROW CEILING — the same second bound `tool_calls` has, for the same
//      reason: a burst inside the window outruns the age rule entirely.

/** Long, because what is being kept is a readable session, not a log tail. */
export const VIEW_RETAIN_DAYS = 90;

/** Views are larger than log rows — a rendered claim is kilobytes — so the ceiling is lower. */
export const VIEW_RETAIN_MAX_ROWS = 20_000;

export function viewRetentionPlan(
  now: number,
  days = VIEW_RETAIN_DAYS,
  maxRows = VIEW_RETAIN_MAX_ROWS,
): RetentionPlan {
  return { cutoff: now - days * 86_400_000, maxRows };
}

export interface ViewPruneResult {
  orphaned: number;
  aged: number;
  overCeiling: number;
  total: number;
}

/** Sum the parts, so a caller can report which rule did the work. */
export function totalPruned(r: Omit<ViewPruneResult, "total">): number {
  return r.orphaned + r.aged + r.overCeiling;
}
