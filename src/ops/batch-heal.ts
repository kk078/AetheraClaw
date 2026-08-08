import { autohealClaim, type Repair } from "../tools/healthcare/autoheal.js";
import type { ClaimInput } from "../tools/healthcare/x12/837.js";

// ── Batch auto-heal preview ──────────────────────────────────────────────────
// claim_autoheal answers one claim at a time. An ops team receives a batch of
// four hundred, and the question is not "what is wrong with claim 217" but "how
// many of these can go out tonight and how many need a coder tomorrow" — a
// capacity question, and the answer is a number rather than a list.
//
// Preview, never apply. The same reason claim_autoheal returns a repaired claim
// rather than writing one: a batch operation that silently rewrote four hundred
// claims would be the largest single unreviewed change this system could make,
// and the safe repairs are exactly the ones nobody would notice going wrong.
//
// The split that matters is not "fixed vs broken". It is:
//   CLEAN     — nothing to do; these go out as they are.
//   REPAIRED  — a safe repair applies; the claim already said this.
//   REVIEW    — needs a fact the claim does not contain. A human, per claim.
// Only the third is work, and its size is what an ops lead actually schedules
// against.

export interface ClaimHealResult {
  claimId: string;
  applied: Repair[];
  needsReview: Repair[];
  status: "clean" | "repaired" | "review";
}

export interface BatchHealSummary {
  total: number;
  clean: number;
  repaired: number;
  review: number;
  /** Safe repairs by rule, so a recurring formatting fault is visible as one problem. */
  repairsByRule: Array<{ rule: string; count: number }>;
  /** Review items by rule, ordered by how many claims they hold up. */
  reviewsByRule: Array<{ rule: string; count: number; question: string }>;
  results: ClaimHealResult[];
}

export function batchHeal(claims: ClaimInput[]): BatchHealSummary {
  const results: ClaimHealResult[] = claims.map((claim) => {
    const r = autohealClaim(claim);
    const status: ClaimHealResult["status"] =
      r.needsReview.length > 0 ? "review" : r.applied.length > 0 ? "repaired" : "clean";
    return { claimId: claim.claim_id, applied: r.applied, needsReview: r.needsReview, status };
  });

  const repairs = new Map<string, number>();
  const reviews = new Map<string, { count: number; question: string }>();
  for (const r of results) {
    for (const a of r.applied) repairs.set(a.rule, (repairs.get(a.rule) ?? 0) + 1);
    for (const n of r.needsReview) {
      const slot = reviews.get(n.rule) ?? { count: 0, question: n.question ?? "" };
      slot.count++;
      reviews.set(n.rule, slot);
    }
  }

  return {
    total: results.length,
    clean: results.filter((r) => r.status === "clean").length,
    repaired: results.filter((r) => r.status === "repaired").length,
    review: results.filter((r) => r.status === "review").length,
    repairsByRule: [...repairs.entries()].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count),
    reviewsByRule: [...reviews.entries()]
      .map(([rule, v]) => ({ rule, ...v }))
      .sort((a, b) => b.count - a.count),
    results,
  };
}

export function renderBatchHeal(s: BatchHealSummary, limit = 15): string {
  if (s.total === 0) return "No claims in the batch.";

  const pct = (n: number) => `${((n / s.total) * 100).toFixed(0)}%`;
  const lines = [
    `${s.total} claim(s) previewed. NOTHING WAS WRITTEN — this is a dry run over every claim.`,
    "",
    `  ${String(s.clean).padStart(5)}  ${pct(s.clean).padStart(4)}  clean, go as they are`,
    `  ${String(s.repaired).padStart(5)}  ${pct(s.repaired).padStart(4)}  a safe repair applies`,
    `  ${String(s.review).padStart(5)}  ${pct(s.review).padStart(4)}  NEED A HUMAN`,
    "",
    `Only the last number is work. ${s.review} claim(s) need a person; the other ${s.total - s.review} do not.`,
  ];

  if (s.repairsByRule.length > 0) {
    lines.push(
      "",
      "Safe repairs — each writes down what the claim already said:",
      ...s.repairsByRule.map((r) => `  ${String(r.count).padStart(5)} × ${r.rule}`),
    );
  }

  if (s.reviewsByRule.length > 0) {
    lines.push("", "Holding up a human, most claims first:");
    for (const r of s.reviewsByRule) {
      lines.push(`  ${String(r.count).padStart(5)} × ${r.rule}`, `          ${r.question}`);
    }
  }

  // Stated once for both groupings rather than only under the review list. The
  // repeated SAFE repair is if anything the stronger signal: eight claims that
  // all needed the same date reformatted is one charge-capture form emitting the
  // wrong format, and healing them one at a time forever is the failure mode —
  // it works, so nobody goes and fixes the form.
  if ([...s.repairsByRule, ...s.reviewsByRule].some((r) => r.count > 1)) {
    lines.push(
      "",
      "A rule appearing on many claims at once is usually one upstream fault, not many independent ones — a charge-capture form emitting the wrong date format, or a template with a stale place of service. Fixing it at the source clears the whole group and stops the next batch arriving the same way.",
    );
  }

  const needing = s.results.filter((r) => r.status === "review").slice(0, limit);
  if (needing.length > 0) {
    lines.push("", "Claims needing review:", ...needing.map((r) => `  ${r.claimId}: ${r.needsReview.map((n) => n.rule).join(", ")}`));
    if (s.review > needing.length) lines.push(`  … and ${s.review - needing.length} more.`);
  }

  lines.push(
    "",
    "To apply the safe repairs, run claim_autoheal per claim and pass the repaired claim on. There is deliberately no batch apply: rewriting hundreds of claims in one unreviewed action would be the largest single change this system can make, and safe repairs are exactly the ones nobody would notice going wrong.",
  );
  return lines.join("\n");
}
