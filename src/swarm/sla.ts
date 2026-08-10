import type { Stage } from "./stages.js";
import { STAGES } from "./stages.js";

// ── How long a claim may sit, and what it costs when it does ─────────────────
//
// The board says WHERE each claim is. It has never said how long it has been
// there, which is the question that matters: a claim parked in `scrubbing` for
// three days is a coder's afternoon, and the same claim parked for ninety is a
// timely-filing denial that cannot be appealed on the merits.
//
// TWO THINGS ARE DELIBERATELY SEPARATE HERE:
//
//   The STAGE SLA is an internal service target. Missing it is a process
//   problem — work is queueing somewhere.
//
//   The FILING DEADLINE is external and absolute. Missing it is money gone, and
//   no amount of internal process explains it away to a practice.
//
// A single "days in stage" number collapses those into one, and the collapse
// always favours the internal number because it is the one the team controls.
// So both are computed, and the escalation orders by the external one.
//
// Everything is pure and takes `now`. Nothing reads a clock.

export interface StageSla {
  stage: Stage;
  /** Hours the item may sit here before it is late. */
  targetHours: number;
  /** Why this number and not another. A target with no reasoning gets tuned to whatever hides the problem. */
  rationale: string;
}

/**
 * Targets, in hours.
 *
 * Human stages get longer than machine stages because a person has a queue and
 * a machine does not. `submitted` is the longest by far: after a claim is filed
 * the clock belongs to the payer, and an SLA on somebody else's adjudication is
 * a number that only ever measures the payer.
 */
export const STAGE_SLA: Partial<Record<Stage, StageSla>> = {
  captured: { stage: "captured", targetHours: 8, rationale: "Assembly is mechanical. Anything sitting here overnight is a stuck queue, not a workload." },
  coding: { stage: "coding", targetHours: 48, rationale: "A coder's queue. Two working days is a realistic turnaround that still catches a backlog." },
  coded: { stage: "coded", targetHours: 4, rationale: "The scrub is a function call. Hours here mean the pipeline is not running." },
  scrubbing: { stage: "scrubbing", targetHours: 72, rationale: "Findings need a person and sometimes a provider query. Three days before it counts as stuck." },
  twin_review: { stage: "twin_review", targetHours: 8, rationale: "Denial prediction runs locally against this practice's own history, so hours here mean the step is not running rather than that it is thinking." },
  ready_to_submit: { stage: "ready_to_submit", targetHours: 24, rationale: "A claim that is ready and unsent is money sitting still for no reason anyone has stated." },
  submitted: { stage: "submitted", targetHours: 30 * 24, rationale: "The payer's clock, not ours. Long, because an SLA here measures somebody else — but not infinite, because a claim with no acknowledgement after a month was probably never received." },
  denied: { stage: "denied", targetHours: 120, rationale: "Appeal windows start running on the denial date, and the shortest are 30 days." },
  appeal_drafted: { stage: "appeal_drafted", targetHours: 72, rationale: "A drafted appeal that is not sent is the worst of both: the work is done and the window is still running." },
  rejected: { stage: "rejected", targetHours: 24, rationale: "A clearinghouse rejection was never filed. The filing clock is still running and most people believe it is not." },
};

export type SlaStatus = "on_time" | "at_risk" | "breached";

export interface BoardItem {
  id: string;
  claimRef: string;
  payer: string;
  stage: Stage;
  /** Dollars. */
  amount: number;
  attempts: number;
  lastError: string;
  updatedAt: number;
  /** Date of service, CCYYMMDD. Empty when unknown — which is itself worth saying. */
  serviceDate?: string;
  /** Days the payer allows from date of service. Defaults are per-payer and this is the practice's own record. */
  filingLimitDays?: number;
}

export interface SlaVerdict {
  item: BoardItem;
  status: SlaStatus;
  hoursInStage: number;
  targetHours: number | null;
  /** Days left to file, or null when the date of service or the limit is unknown. */
  filingDaysLeft: number | null;
  /** True when the filing window is the binding constraint rather than the stage target. */
  filingIsBinding: boolean;
  reason: string;
}

const HOUR = 3_600_000;

/** Parse CCYYMMDD to epoch ms at UTC midnight. Returns null on anything else. */
export function ymdToMs(ymd: string): number | null {
  if (!/^\d{8}$/.test(ymd)) return null;
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return Date.UTC(y, m - 1, d);
}

/**
 * Where this item stands.
 *
 * `at_risk` exists because a two-valued verdict is a rubber stamp: everything
 * not yet breached reads as fine, so the items worth acting on today — the ones
 * about to go — look identical to the ones filed this morning.
 */
export function slaVerdict(item: BoardItem, now: number): SlaVerdict {
  const spec = STAGE_SLA[item.stage];
  const hoursInStage = Math.max(0, (now - item.updatedAt) / HOUR);
  const targetHours = spec?.targetHours ?? null;

  let filingDaysLeft: number | null = null;
  if (item.serviceDate && item.filingLimitDays) {
    const dos = ymdToMs(item.serviceDate);
    if (dos !== null) {
      const deadline = dos + item.filingLimitDays * 24 * HOUR;
      filingDaysLeft = Math.floor((deadline - now) / (24 * HOUR));
    }
  }

  // A claim that has not been filed and is running out of window is the most
  // urgent thing on any board, whatever stage it is in. Once it is submitted
  // the filing clock has already been met and stops mattering.
  const unfiled = !STAGES[item.stage]?.terminal && !["submitted", "paid", "adjudicated", "closed"].includes(item.stage);
  const filingIsBinding = unfiled && filingDaysLeft !== null && filingDaysLeft <= 30;

  if (filingIsBinding && filingDaysLeft !== null && filingDaysLeft <= 0) {
    return {
      item, status: "breached", hoursInStage, targetHours, filingDaysLeft, filingIsBinding,
      reason:
        `TIMELY FILING WINDOW HAS CLOSED for ${item.claimRef} (${item.payer}). Filing now will be denied on the ` +
        "deadline, and that denial is not appealable on the merits of the care. This is money gone unless the payer " +
        "accepts a late-filing exception.",
    };
  }
  if (filingIsBinding && filingDaysLeft !== null && filingDaysLeft <= 14) {
    return {
      item, status: "at_risk", hoursInStage, targetHours, filingDaysLeft, filingIsBinding,
      reason: `${filingDaysLeft} day(s) left to file ${item.claimRef} (${item.payer}). The filing window, not the stage target, is what is binding here.`,
    };
  }

  if (targetHours === null) {
    return {
      item, status: "on_time", hoursInStage, targetHours, filingDaysLeft, filingIsBinding,
      reason: `No service target is defined for the ${item.stage} stage.`,
    };
  }
  if (hoursInStage > targetHours) {
    return {
      item, status: "breached", hoursInStage, targetHours, filingDaysLeft, filingIsBinding,
      reason: `${item.claimRef} has been in ${item.stage} for ${Math.round(hoursInStage)}h against a ${targetHours}h target. ${spec?.rationale ?? ""}`,
    };
  }
  if (hoursInStage > targetHours * 0.75) {
    return {
      item, status: "at_risk", hoursInStage, targetHours, filingDaysLeft, filingIsBinding,
      reason: `${item.claimRef} is at ${Math.round(hoursInStage)}h of a ${targetHours}h target in ${item.stage}.`,
    };
  }
  return {
    item, status: "on_time", hoursInStage, targetHours, filingDaysLeft, filingIsBinding,
    reason: `${Math.round(hoursInStage)}h of ${targetHours}h.`,
  };
}

export interface Escalation {
  verdict: SlaVerdict;
  /** Higher is more urgent. Ordering only — the number itself is not a quantity of anything. */
  priority: number;
  /** Dollars that stop being collectable if this is not acted on. */
  atRisk: number;
}

/**
 * What needs a person now, worst first.
 *
 * Ordered by MONEY AT RISK inside urgency band, not by age. A board sorted by
 * age puts a $40 copay adjustment above a $9,000 surgical claim that is eleven
 * days from its filing deadline, and whoever works the top of that list is
 * being actively misled about what their morning is worth.
 */
export function escalate(items: BoardItem[], now: number): Escalation[] {
  const out: Escalation[] = [];
  for (const item of items) {
    const verdict = slaVerdict(item, now);
    if (verdict.status === "on_time" && item.lastError === "") continue;

    // Bands, then money within a band. A closed filing window outranks
    // everything because nothing else on this list is unrecoverable.
    let band = 0;
    if (verdict.filingIsBinding && (verdict.filingDaysLeft ?? 99) <= 0) band = 4;
    else if (verdict.filingIsBinding) band = 3;
    else if (verdict.status === "breached") band = 2;
    else if (item.lastError !== "") band = 1;

    out.push({ verdict, priority: band, atRisk: item.amount });
  }
  return out.sort((a, b) => b.priority - a.priority || b.atRisk - a.atRisk);
}

export function renderEscalations(escalations: Escalation[]): string {
  if (escalations.length === 0) return "Nothing on the board is late, at risk, or carrying an error.";
  const money = escalations.reduce((n, e) => n + e.atRisk, 0);
  const lines = [
    `${escalations.length} item(s) need attention. $${money.toFixed(2)} of billed charges is behind or at risk.`,
    "",
  ];
  for (const e of escalations) {
    const i = e.verdict.item;
    lines.push(`  [${e.verdict.status.toUpperCase()}] $${i.amount.toFixed(2)} ${i.claimRef} — ${e.verdict.reason}`);
    // The error is repeated here rather than left on the row it came from. An
    // escalation list somebody reads at 8am is not a place to make them go
    // looking for the reason.
    if (i.lastError) lines.push(`      last error: ${i.lastError} (attempt ${i.attempts})`);
  }
  return lines.join("\n");
}
