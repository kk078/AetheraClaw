import { CARC } from "../denial-codes.js";

// ── Denial worklist prioritization ───────────────────────────────────────────
// Most worklists sort by dollars or by age. Both lose money, because neither
// accounts for the two facts that actually decide what to work next: how likely
// the item is to be recovered at all, and how soon it stops being recoverable.
//
// The ordering is expected recovery per hour of work, nudged by how close the
// deadline is. Deadlines deliberately do NOT dominate: a $50 item expiring
// tomorrow and a $5,000 item due in ninety days both take ten minutes, so both
// get worked today and doing the larger one first costs nothing. Letting urgency
// override value would just thrash on pennies while five-figure items sat.
//
// Deadlines only destroy value when the work queued ahead of an item outlasts
// it. That case is detected directly — walk the queue accumulating effort and
// name the items whose deadline falls before their projected start — rather than
// approximated with a multiplier. Expired items leave the queue entirely instead
// of absorbing effort that cannot pay off.

export interface Recoverability {
  /** Share of these that get paid when worked, as a starting estimate. */
  probability: number;
  /** Rough hours to work one, used to rank value per unit of effort. */
  effortHours: number;
  action: string;
}

/**
 * Priors by CARC category, keyed to the categories already carried in the CARC
 * dataset. These are starting estimates a practice's own outcomes should replace
 * — they are deliberately coarse, and the tool says so.
 */
export const RECOVERABILITY_BY_CATEGORY: Record<string, Recoverability> = {
  registration: {
    probability: 0.85,
    effortHours: 0.15,
    action: "Fix the demographic or coverage error and resubmit as a corrected claim. High yield, minutes of work — do these first.",
  },
  coding: {
    probability: 0.6,
    effortHours: 0.35,
    action: "Recode or add the correct modifier and resubmit. Verify against the record; do not simply append a modifier to clear the edit.",
  },
  "medical-necessity": {
    probability: 0.4,
    effortHours: 2,
    action: "Appeal with records and the applicable LCD/NCD citation. Slow and uncertain, but the dollars are usually large enough to be worth it.",
  },
  authorization: {
    probability: 0.35,
    effortHours: 1,
    action: "Look for a retro-authorization pathway; many payers allow one within a short window. If none, this may be a write-off with a process fix behind it.",
  },
  coverage: {
    probability: 0.2,
    effortHours: 0.5,
    action: "Usually genuinely non-covered. Check whether an ABN shifts liability to the patient rather than appealing the payer.",
  },
  duplicate: {
    probability: 0.1,
    effortHours: 0.15,
    action: "Verify the original claim's status before doing anything. Most of these are real duplicates and resubmitting compounds the problem.",
  },
  contractual: {
    probability: 0.02,
    effortHours: 0.1,
    action: "A contractual write-off, not a denial. Do not work it — but check payment_variance in case the contracted rate itself is wrong.",
  },
  "patient-responsibility": {
    probability: 0.02,
    effortHours: 0.1,
    action: "Not an appeal at all — this is the patient's balance. Move it to patient billing.",
  },
  timely: {
    probability: 0.25,
    effortHours: 0.5,
    action: "Winnable only with proof of timely filing — an acceptance report, not a submission log. Check for a 277CA acknowledgment before spending time here.",
  },
  regulatory: {
    probability: 0.01,
    effortHours: 0.1,
    action: "A mandated payment adjustment such as sequestration. Nothing to recover.",
  },
};

export const DEFAULT_RECOVERABILITY: Recoverability = {
  probability: 0.35,
  effortHours: 0.5,
  action: "Reason code not in the bundled dataset — read the remittance remark codes to decide the next step.",
};

/** Inside this many days an item is treated as urgent; beyond it, urgency is flat. */
export const URGENT_WITHIN_DAYS = 14;
export const MAX_URGENCY = 10;

export function recoverabilityFor(carc: string | undefined): Recoverability {
  if (!carc) return DEFAULT_RECOVERABILITY;
  if (carc === "29") return RECOVERABILITY_BY_CATEGORY.timely;
  const category = CARC[carc]?.category;
  return (category ? RECOVERABILITY_BY_CATEGORY[category] : undefined) ?? DEFAULT_RECOVERABILITY;
}

/**
 * Urgency rises as the deadline approaches and is flat while it is far off. An
 * item ninety days out scores the same as one sixty days out, because neither
 * is at risk this week and both should yield to whatever is.
 */
export function urgencyMultiplier(daysRemaining: number | null): number {
  if (daysRemaining === null) return 1;
  if (daysRemaining <= 0) return MAX_URGENCY;
  return Math.min(Math.max(URGENT_WITHIN_DAYS / daysRemaining, 1), MAX_URGENCY);
}

export interface WorkItem {
  id: string;
  kind: string;
  title: string;
  amountCents: number;
  carc?: string;
  payer?: string;
  dueAt: number | null;
  createdAt: number;
}

export interface ScoredItem {
  item: WorkItem;
  amount: number;
  probability: number;
  expectedRecovery: number;
  effortHours: number;
  valuePerHour: number;
  daysRemaining: number | null;
  urgency: number;
  score: number;
  expired: boolean;
  /** Set when the work queued ahead of this item outlasts its deadline. */
  atRisk?: boolean;
  action: string;
}

export interface PrioritizeOptions {
  now: number;
  /** Per-CARC overrides learned from the practice's own appeal outcomes. */
  overrides?: Map<string, Recoverability>;
  /** Hours a day actually spent working denials, used to find items the queue will outrun. */
  hoursPerDay?: number;
}

export const DEFAULT_HOURS_PER_DAY = 4;

/**
 * Mark items the queue will not reach in time.
 *
 * Value ordering alone is right when everything gets worked: a $5,000 item and a
 * $50 item that each take ten minutes both get done today, and doing the larger
 * one first costs nothing. The ordering only destroys value when the work ahead
 * of an item outlasts its deadline — so rather than inflating small urgent items
 * past large ones, walk the queue accumulating effort and flag the items whose
 * deadline falls before their projected start. Those are the ones to pull
 * forward, and they are named explicitly instead of being smuggled into a score.
 */
export function flagAtRisk(queue: ScoredItem[], hoursPerDay: number): ScoredItem[] {
  let hoursAhead = 0;
  const atRisk: ScoredItem[] = [];
  for (const item of queue) {
    const daysUntilStarted = hoursAhead / hoursPerDay;
    if (item.daysRemaining !== null && daysUntilStarted > item.daysRemaining) {
      item.atRisk = true;
      atRisk.push(item);
    }
    hoursAhead += item.effortHours;
  }
  return atRisk;
}

export function prioritize(items: WorkItem[], opts: PrioritizeOptions): {
  queue: ScoredItem[];
  expired: ScoredItem[];
  atRisk: ScoredItem[];
} {
  const scored: ScoredItem[] = items.map((item) => {
    const recoverability = opts.overrides?.get(item.carc ?? "") ?? recoverabilityFor(item.carc);
    const amount = item.amountCents / 100;
    const expectedRecovery = amount * recoverability.probability;
    const daysRemaining =
      item.dueAt === null ? null : Math.floor((item.dueAt - opts.now) / 86_400_000);
    const expired = daysRemaining !== null && daysRemaining < 0;
    const urgency = urgencyMultiplier(daysRemaining);
    const valuePerHour = expectedRecovery / recoverability.effortHours;

    return {
      item,
      amount,
      probability: recoverability.probability,
      expectedRecovery: Math.round(expectedRecovery * 100) / 100,
      effortHours: recoverability.effortHours,
      valuePerHour: Math.round(valuePerHour * 100) / 100,
      daysRemaining,
      urgency: Math.round(urgency * 100) / 100,
      score: Math.round(valuePerHour * urgency * 100) / 100,
      expired,
      action: recoverability.action,
    };
  });

  const queue = scored.filter((s) => !s.expired).sort((a, b) => b.score - a.score);
  const atRisk = flagAtRisk(queue, opts.hoursPerDay ?? DEFAULT_HOURS_PER_DAY);
  return {
    queue,
    expired: scored.filter((s) => s.expired).sort((a, b) => b.amount - a.amount),
    atRisk,
  };
}

export function renderQueue(
  result: { queue: ScoredItem[]; expired: ScoredItem[]; atRisk: ScoredItem[] },
  limit = 20,
): string {
  const { queue, expired, atRisk } = result;
  if (queue.length === 0 && expired.length === 0) return "Worklist is empty.";

  const lines: string[] = [];
  const totalExpected = queue.reduce((sum, s) => sum + s.expectedRecovery, 0);
  const totalFace = queue.reduce((sum, s) => sum + s.amount, 0);

  lines.push(
    `${queue.length} workable item(s): $${totalFace.toFixed(2)} denied, $${totalExpected.toFixed(2)} expected to be recovered.`,
    "",
    "Work in this order — expected recovery per hour, weighted by how soon each stops being recoverable:",
  );

  for (const s of queue.slice(0, limit)) {
    const due =
      s.daysRemaining === null
        ? "no deadline"
        : s.daysRemaining === 0
          ? "DUE TODAY"
          : `${s.daysRemaining}d left`;
    lines.push(
      `  ${s.item.id}  $${s.amount.toFixed(2)} · ${(s.probability * 100).toFixed(0)}% recoverable → $${s.expectedRecovery.toFixed(2)} · ${due}${s.urgency > 1 ? ` · urgency ×${s.urgency}` : ""}`,
      `      ${s.item.title}${s.item.carc ? ` [CARC ${s.item.carc}]` : ""}`,
      `      ${s.action}`,
    );
  }
  if (queue.length > limit) lines.push(`  … and ${queue.length - limit} more.`);

  if (atRisk.length > 0) {
    lines.push(
      "",
      `PULL FORWARD — ${atRisk.length} item(s) will expire before the queue reaches them at the current pace:`,
    );
    for (const s of atRisk.slice(0, 10)) {
      lines.push(`  ${s.item.id}  $${s.amount.toFixed(2)} · ${s.daysRemaining}d left  ${s.item.title}`);
    }
    if (atRisk.length > 10) lines.push(`  … and ${atRisk.length - 10} more.`);
    lines.push(
      "  Working strictly by value is right while everything gets done; these are the items where it would cost you the whole amount.",
    );
  }

  if (expired.length > 0) {
    const lost = expired.reduce((sum, s) => sum + s.amount, 0);
    lines.push(
      "",
      `PAST DEADLINE — ${expired.length} item(s), $${lost.toFixed(2)}. Do not work these on the merits; the window has closed.`,
    );
    for (const s of expired.slice(0, 5)) {
      lines.push(`  ${s.item.id}  $${s.amount.toFixed(2)} · ${-(s.daysRemaining ?? 0)}d past  ${s.item.title}`);
    }
    if (expired.length > 5) lines.push(`  … and ${expired.length - 5} more.`);
    lines.push(
      "  The exception is a claim that WAS filed on time: with an acceptance report as proof, a timely-filing denial is still appealable. Check timely_filing_check before writing these off.",
    );
  }

  lines.push(
    "",
    "Recovery rates are coarse per-category starting estimates, not measurements of your practice. Treat the ordering as a first pass and correct it as you see what actually gets paid.",
  );
  return lines.join("\n");
}
