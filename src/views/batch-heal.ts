import type { BatchHealSummary } from "../ops/batch-heal.js";

// ── The batch heal preview, as a panel ───────────────────────────────────────
// This is the one tool in the system whose entire point is that it changes
// nothing: it runs the repair engine across a batch and reports the capacity
// answer — how many claims go out as they are, how many a safe repair covers,
// and how many need a person. There is deliberately no batch apply.
//
// It is therefore also the case the DRY RUN verdict exists for. A panel of green
// numbers headed CLEAR would say the batch was fixed. It was not; it was
// measured.

export interface BatchHealRuleRow {
  rule: string;
  count: number;
  /** Present on review rows: the question a person has to answer. */
  question?: string;
}

export interface BatchHealView {
  /** What the batch was drawn from, in words — "status draft", "all stored claims". */
  scope: string;
  total: number;
  clean: number;
  repairable: number;
  needsHuman: number;
  repairsByRule: BatchHealRuleRow[];
  reviewsByRule: BatchHealRuleRow[];
  /**
   * Rows that did not parse as a claim.
   *
   * Carried separately and never folded into `clean`, which is the figure
   * somebody acts on without reading further.
   */
  excluded: number;
  /** True when the query hit its row limit, so the real batch may be larger. */
  truncated: boolean;
}

export function buildBatchHealView(
  summary: BatchHealSummary,
  opts: { scope: string; excluded: number; truncated: boolean },
): BatchHealView {
  return {
    scope: opts.scope,
    total: summary.total,
    clean: summary.clean,
    repairable: summary.repaired,
    // Named "needs human" rather than "review" because that is what the number
    // is: the only one of the four that is work.
    needsHuman: summary.review,
    repairsByRule: summary.repairsByRule.map((r) => ({ rule: r.rule, count: r.count })),
    reviewsByRule: summary.reviewsByRule.map((r) => ({ rule: r.rule, count: r.count, question: r.question })),
    excluded: opts.excluded,
    truncated: opts.truncated,
  };
}
