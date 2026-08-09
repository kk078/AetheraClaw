import { CARC } from "../denial-codes.js";
import type { Era, EraClaim } from "../x12/835.js";

// ── Denials into the worklist, on arrival ────────────────────────────────────
// Until now parsing an 835 stored the remittance and printed a summary. The
// denials inside it entered no queue: somebody had to read the summary and open
// items by hand, which in practice means the small ones never get opened at all.
//
// The proposed design called for recalculating a stored priority score whenever
// a remittance arrives. There is no stored score to recalculate — the queue
// computes priority from live rows on every read (see prioritize.ts), so nothing
// can go stale and no invalidation bus is needed. A stored score is precisely
// what would create that problem. What was actually missing is upstream of it:
// the denials never became rows.
//
// Every judgement here is deliberately shallow. This decides WHAT IS A DENIAL
// and WHAT IT IS WORTH, and hands both to the existing prioritizer, which
// already knows how to weigh recoverability against effort and deadlines.

/**
 * Adjustment groups that mean the practice lost money it might get back.
 *
 * CO (contractual obligation) is the write-off the contract requires — it is not
 * a denial and working it recovers nothing. PR is the patient's balance, which
 * belongs in patient billing rather than in a denial queue. OA and PI are where
 * genuine denials live, and CO carries a few too (CO-197 prior auth, CO-50 not
 * medically necessary), so group alone cannot decide it.
 */
const NON_RECOVERABLE_CATEGORIES = new Set(["contractual", "patient-responsibility", "regulatory"]);

export interface DenialCandidate {
  /** Stable across re-parses of the same remittance, so re-ingesting cannot duplicate. */
  key: string;
  claimId: string;
  payer: string;
  carc: string;
  procedure: string;
  amountCents: number;
  title: string;
}

/**
 * Everything in a remittance worth queueing.
 *
 * Amounts are summed per claim+CARC rather than per line: three lines denied for
 * the same reason are one piece of work, and splitting them into three items
 * makes the queue look busy while ranking each at a third of its real value.
 */
export function denialCandidates(era: Era): DenialCandidate[] {
  const byKey = new Map<string, DenialCandidate>();

  for (const claim of era.claims) {
    if (isReversal(claim)) continue;
    for (const line of claim.lines) {
      for (const adj of line.adjustments) {
        if (!isRecoverable(adj.carc)) continue;
        if (adj.amount <= 0) continue;
        const key = `${claim.claimId.trim().toUpperCase()}|${adj.carc}`;
        const existing = byKey.get(key);
        const cents = Math.round(adj.amount * 100);
        if (existing) {
          existing.amountCents += cents;
          if (!existing.procedure.includes(line.procedure)) existing.procedure += `, ${line.procedure}`;
          continue;
        }
        byKey.set(key, {
          key,
          claimId: claim.claimId,
          payer: era.payer,
          carc: adj.carc,
          procedure: line.procedure,
          amountCents: cents,
          title: `${claim.claimId} — CARC ${adj.carc}${CARC[adj.carc] ? `: ${CARC[adj.carc].desc}` : ""}`,
        });
      }
    }
  }

  // Rewrite the title once the procedures are all gathered.
  return [...byKey.values()].map((c) => ({
    ...c,
    title: `${c.claimId} (${c.procedure}) — CARC ${c.carc}${CARC[c.carc] ? `: ${CARC[c.carc].desc}` : ""}`,
  }));
}

/** Status 22 is a reversal of a prior payment, not a denial of new work. */
export function isReversal(claim: EraClaim): boolean {
  return claim.statusCode === "22";
}

export function isRecoverable(carc: string): boolean {
  const category = CARC[carc]?.category;
  // An unknown CARC is queued rather than dropped. A reason code the bundled
  // dataset does not carry is exactly the one nobody will notice going missing,
  // and the prioritizer already applies a conservative default to it.
  if (!category) return true;
  return !NON_RECOVERABLE_CATEGORIES.has(category);
}

export interface IngestSummary {
  opened: number;
  alreadyOpen: number;
  skippedNonRecoverable: number;
  totalCents: number;
}

export function renderIngest(summary: IngestSummary, payer: string): string {
  if (summary.opened === 0 && summary.alreadyOpen === 0) {
    return summary.skippedNonRecoverable > 0
      ? `\nNo worklist items opened. ${summary.skippedNonRecoverable} adjustment(s) were contractual write-offs, patient responsibility or mandated reductions — nothing to recover in any of them.`
      : "";
  }
  const parts = [
    `\n${summary.opened} denial(s) opened in the worklist ($${(summary.totalCents / 100).toFixed(2)} from ${payer}).`,
  ];
  if (summary.alreadyOpen > 0) {
    parts.push(`${summary.alreadyOpen} were already open from an earlier parse of this remittance and were left alone.`);
  }
  if (summary.skippedNonRecoverable > 0) {
    parts.push(
      `${summary.skippedNonRecoverable} adjustment(s) skipped as contractual, patient responsibility or mandated — working those recovers nothing.`,
    );
  }
  parts.push("Run worklist_prioritize to see where they fall against everything else already queued.");
  return parts.join(" ");
}
