// ── The prior-authorization decision clock ───────────────────────────────────
// Two dates matter in CMS-0057-F and they are years apart.
//
// The FHIR Prior Authorization API is due 1 January 2027 — useful, and still in
// the future. But the DECISION TIMEFRAMES have been in force since 1 January
// 2026: an impacted payer owes a decision within 72 hours on an expedited
// request and seven calendar days on a standard one. That obligation exists
// whether or not anybody has built an API, and it is the part a practice can
// hold a payer to today.
//
// So this module computes the deadline, not the endpoint. A late decision is
// the finding, and knowing the exact hour it went late is what makes the
// follow-up call worth placing.

/** Expedited (urgent) requests: 72 HOURS, not three days. */
export const EXPEDITED_DECISION_HOURS = 72;
/** Standard requests: seven CALENDAR days, not business days. */
export const STANDARD_DECISION_CALENDAR_DAYS = 7;
/** Decision timeframes took effect on this date. */
export const DECISION_TIMEFRAMES_EFFECTIVE = "20260101";
/** The FHIR Prior Authorization API compliance date. */
export const PA_API_COMPLIANCE_DATE = "20270101";

/**
 * CMS granted enforcement discretion for an all-FHIR Prior Authorization API
 * that does not use X12 278.
 *
 * Worth stating because the obvious reading of HIPAA Administrative
 * Simplification is that 278 is mandatory for this transaction, and a practice
 * or vendor reasoning from that alone concludes the FHIR route is not allowed.
 */
export const X12_278_ENFORCEMENT_NOTE =
  "HIPAA Administrative Simplification names X12 278 as the prior-authorization transaction, which reads as though FHIR cannot replace it. CMS said otherwise: a payer running an all-FHIR Prior Authorization API without 278 will not be enforced against. Both routes are live, and a payer may be on either.";

export type Urgency = "expedited" | "standard";

export interface DecisionDeadline {
  urgency: Urgency;
  /** When the payer received the request, epoch ms. */
  receivedAt: number;
  dueAt: number;
  /** Negative once the deadline has passed. */
  hoursRemaining: number;
  late: boolean;
  /** How late, in hours. Zero when not late. */
  hoursLate: number;
  /** False for a request predating the rule, where no federal clock applies. */
  covered: boolean;
  notes: string[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function ymd(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * When the payer's decision is due.
 *
 * The units are different on purpose and getting them wrong is the whole
 * mistake: 72 hours is three days measured to the hour, while seven calendar
 * days is a week measured in dates. Treating expedited as "three days" gives
 * the payer until the end of day three and loses most of a day of pressure on
 * exactly the requests where the patient is waiting.
 */
export function decisionDeadline(receivedAt: number, urgency: Urgency, now: number): DecisionDeadline {
  const notes: string[] = [];
  const covered = ymd(receivedAt) >= DECISION_TIMEFRAMES_EFFECTIVE;

  const dueAt =
    urgency === "expedited"
      ? receivedAt + EXPEDITED_DECISION_HOURS * HOUR_MS
      : receivedAt + STANDARD_DECISION_CALENDAR_DAYS * DAY_MS;

  const hoursRemaining = (dueAt - now) / HOUR_MS;
  const late = now > dueAt;

  if (!covered) {
    notes.push(
      `This request was received before ${DECISION_TIMEFRAMES_EFFECTIVE}, when the federal decision timeframes took effect. The deadline below is the rule's arithmetic applied anyway — the payer's contract or state law governs instead, and those are often longer.`,
    );
  }
  notes.push(
    urgency === "expedited"
      ? `Expedited requests run on ${EXPEDITED_DECISION_HOURS} HOURS, measured to the hour. Reading that as three calendar days hands the payer most of an extra day on the requests where somebody is waiting for care.`
      : `Standard requests run on ${STANDARD_DECISION_CALENDAR_DAYS} CALENDAR days — weekends and holidays included, unlike almost every other clock in this project.`,
  );
  if (late) {
    notes.push(
      "A decision that is past due is worth a call with the request reference, and the reference number is what makes that call provable later.",
    );
  }

  return {
    urgency,
    receivedAt,
    dueAt,
    hoursRemaining,
    late,
    hoursLate: late ? (now - dueAt) / HOUR_MS : 0,
    covered,
    notes,
  };
}

/** Days until the FHIR Prior Authorization API is required. Negative once past. */
export function daysUntilApiMandate(now: number): number {
  const target = Date.UTC(
    Number(PA_API_COMPLIANCE_DATE.slice(0, 4)),
    Number(PA_API_COMPLIANCE_DATE.slice(4, 6)) - 1,
    Number(PA_API_COMPLIANCE_DATE.slice(6, 8)),
  );
  return Math.round((target - now) / DAY_MS);
}

/**
 * How a request that has already been decided landed against its deadline.
 *
 * Separate from renderDeadline because a decided request has no countdown left
 * to run. Measuring a settled request against the current time makes it drift
 * further "overdue" every day it sits in the table, and a work queue whose
 * finished rows keep aging is a queue nobody trusts. Pass the decision time as
 * `now` to decisionDeadline and render it through here.
 */
export function renderSettled(deadline: DecisionDeadline): string {
  const due = new Date(deadline.dueAt).toISOString().replace("T", " ").slice(0, 16);
  return deadline.late
    ? `Decided ${deadline.hoursLate.toFixed(1)} hour(s) late — it was due ${due} UTC.`
    : `Decided within the required timeframe, ${deadline.hoursRemaining.toFixed(1)} hour(s) before the ${due} UTC deadline.`;
}

export function renderDeadline(deadline: DecisionDeadline): string {
  const due = new Date(deadline.dueAt).toISOString().replace("T", " ").slice(0, 16);
  const lines = [
    deadline.late
      ? `OVERDUE by ${deadline.hoursLate.toFixed(1)} hour(s). The decision was due ${due} UTC.`
      : `Decision due ${due} UTC — ${deadline.hoursRemaining.toFixed(1)} hour(s) remaining (${deadline.urgency}).`,
  ];
  for (const note of deadline.notes) lines.push(`  ${note}`);
  return lines.join("\n");
}
