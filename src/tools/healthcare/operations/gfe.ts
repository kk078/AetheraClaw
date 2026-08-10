import { parseYmd } from "../compliance/global-period.js";
import { addDaysYmd } from "../prediction/timely-filing.js";

// ── Good Faith Estimate (No Surprises Act) ───────────────────────────────────
// Owed to uninsured and self-pay patients, on a clock measured in BUSINESS days
// from the moment of scheduling — not from the date of service. Practices
// routinely miss it because the deadline has usually passed by the time anyone
// thinks about the bill.

/** A final bill exceeding the estimate by this much opens patient-provider dispute resolution. */
export const GFE_DISPUTE_THRESHOLD = 400;

/** Scheduled this far out or more, the estimate is due within 3 business days of scheduling. */
export const GFE_LONG_LEAD_BUSINESS_DAYS = 10;
export const GFE_LONG_LEAD_DEADLINE_DAYS = 3;

/** Scheduled this far out or more (but under the long-lead threshold), it is due within 1. */
export const GFE_SHORT_LEAD_BUSINESS_DAYS = 3;
export const GFE_SHORT_LEAD_DEADLINE_DAYS = 1;

/** On request rather than on scheduling, the estimate is due within 3 business days. */
export const GFE_ON_REQUEST_DEADLINE_DAYS = 3;

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function toYmd(d: Date): string {
  return (
    String(d.getUTCFullYear()).padStart(4, "0") +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0")
  );
}

/**
 * Business days skip weekends. Federal holidays are NOT modelled unless supplied
 * — pass them explicitly rather than letting the tool quietly compute a deadline
 * a day later than the real one.
 */
export function addBusinessDays(ymd: string, count: number, holidays: string[] = []): string {
  const holiday = new Set(holidays);
  let date = parseYmd(ymd);
  if (!date) throw new Error(`invalid date "${ymd}" (expected YYYYMMDD)`);
  let remaining = count;
  while (remaining > 0) {
    date = new Date(date.getTime() + 86_400_000);
    if (!isWeekend(date) && !holiday.has(toYmd(date))) remaining--;
  }
  return toYmd(date);
}

/** Business days strictly between two dates, counting the later one. */
export function businessDaysBetween(from: string, to: string, holidays: string[] = []): number {
  const holiday = new Set(holidays);
  const start = parseYmd(from);
  const end = parseYmd(to);
  if (!start || !end || end <= start) return 0;
  let count = 0;
  let cursor = new Date(start.getTime());
  while (cursor < end) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    if (!isWeekend(cursor) && !holiday.has(toYmd(cursor))) count++;
  }
  return count;
}

export interface GfeTiming {
  required: boolean;
  deadline: string;
  leadBusinessDays: number;
  rule: string;
}

/**
 * When the estimate is owed for a scheduled service. Services scheduled fewer
 * than three business days out carry no scheduling-triggered requirement at all
 * — but a patient can still ask, and then the three-day request clock starts.
 */
export function gfeDeadlineForScheduling(
  scheduledOn: string,
  serviceDate: string,
  holidays: string[] = [],
): GfeTiming {
  const lead = businessDaysBetween(scheduledOn, serviceDate, holidays);
  if (lead >= GFE_LONG_LEAD_BUSINESS_DAYS) {
    return {
      required: true,
      deadline: addBusinessDays(scheduledOn, GFE_LONG_LEAD_DEADLINE_DAYS, holidays),
      leadBusinessDays: lead,
      rule: `Scheduled ${lead} business days ahead (${GFE_LONG_LEAD_BUSINESS_DAYS}+), so the estimate is due within ${GFE_LONG_LEAD_DEADLINE_DAYS} business days of scheduling.`,
    };
  }
  if (lead >= GFE_SHORT_LEAD_BUSINESS_DAYS) {
    return {
      required: true,
      deadline: addBusinessDays(scheduledOn, GFE_SHORT_LEAD_DEADLINE_DAYS, holidays),
      leadBusinessDays: lead,
      rule: `Scheduled ${lead} business days ahead (${GFE_SHORT_LEAD_BUSINESS_DAYS}–${GFE_LONG_LEAD_BUSINESS_DAYS - 1}), so the estimate is due within ${GFE_SHORT_LEAD_DEADLINE_DAYS} business day of scheduling.`,
    };
  }
  return {
    required: false,
    deadline: "",
    leadBusinessDays: lead,
    rule: `Scheduled only ${lead} business day(s) ahead, under the ${GFE_SHORT_LEAD_BUSINESS_DAYS}-business-day threshold, so scheduling does not trigger an estimate. If the patient asks for one, it is due within ${GFE_ON_REQUEST_DEADLINE_DAYS} business days of the request.`,
  };
}

export function gfeDeadlineForRequest(requestDate: string, holidays: string[] = []): GfeTiming {
  return {
    required: true,
    deadline: addBusinessDays(requestDate, GFE_ON_REQUEST_DEADLINE_DAYS, holidays),
    leadBusinessDays: 0,
    rule: `Requested by the patient, so the estimate is due within ${GFE_ON_REQUEST_DEADLINE_DAYS} business days of the request.`,
  };
}

export interface GfeLine {
  code: string;
  description: string;
  quantity: number;
  /** Expected charge per unit, in dollars. */
  unitCharge: number;
}

export interface GfeInput {
  patientName: string;
  patientDob: string;
  primaryService: string;
  serviceDate: string;
  diagnoses: string[];
  lines: GfeLine[];
  providerName: string;
  providerNpi: string;
  providerTin: string;
  location: string;
  /** Providers whose charges are NOT included and must be estimated separately. */
  excludedProviders?: string[];
}

export interface GfeTotals {
  lines: Array<GfeLine & { total: number }>;
  total: number;
}

export function totalGfe(lines: GfeLine[]): GfeTotals {
  const withTotals = lines.map((l) => ({ ...l, total: Math.round(l.unitCharge * l.quantity * 100) / 100 }));
  return {
    lines: withTotals,
    total: Math.round(withTotals.reduce((sum, l) => sum + l.total, 0) * 100) / 100,
  };
}

export interface GfeVariance {
  estimate: number;
  billed: number;
  difference: number;
  disputable: boolean;
  message: string;
}

export function checkGfeVariance(estimate: number, billed: number): GfeVariance {
  const difference = Math.round((billed - estimate) * 100) / 100;
  const disputable = difference >= GFE_DISPUTE_THRESHOLD;
  return {
    estimate,
    billed,
    difference,
    disputable,
    message: disputable
      ? `Billed $${billed.toFixed(2)} against an estimate of $${estimate.toFixed(2)} — $${difference.toFixed(2)} over, at or above the $${GFE_DISPUTE_THRESHOLD} threshold. The patient may open patient-provider dispute resolution, and you will have to justify the difference.`
      : difference > 0
        ? `Billed $${billed.toFixed(2)} against an estimate of $${estimate.toFixed(2)} — $${difference.toFixed(2)} over, under the $${GFE_DISPUTE_THRESHOLD} dispute threshold.`
        : `Billed $${billed.toFixed(2)} against an estimate of $${estimate.toFixed(2)} — at or under the estimate.`,
  };
}

/** The estimate as a document, with the disclosures the rule requires. */
export function renderGfe(input: GfeInput, totals: GfeTotals, timing: GfeTiming | null): string {
  const lines: string[] = [
    "# Good Faith Estimate",
    "",
    "This estimate is provided under the No Surprises Act for patients who are uninsured or not billing insurance for this care.",
    "",
    `**Patient:** ${input.patientName}    **Date of birth:** ${input.patientDob}`,
    `**Primary item or service:** ${input.primaryService}`,
    `**Expected date of service:** ${input.serviceDate}`,
    "",
    `**Provider:** ${input.providerName}    **NPI:** ${input.providerNpi}    **TIN:** ${input.providerTin}`,
    `**Location:** ${input.location}`,
    "",
    `**Diagnosis codes:** ${input.diagnoses.join(", ") || "(none supplied)"}`,
    "",
    "## Itemized expected charges",
    "",
    "| Code | Description | Qty | Unit charge | Total |",
    "| --- | --- | ---: | ---: | ---: |",
    ...totals.lines.map(
      (l) => `| ${l.code} | ${l.description} | ${l.quantity} | $${l.unitCharge.toFixed(2)} | $${l.total.toFixed(2)} |`,
    ),
    `| | | | **Total estimate** | **$${totals.total.toFixed(2)}** |`,
    "",
  ];

  if (timing) {
    lines.push(`_Estimate due ${timing.deadline || "on request"}. ${timing.rule}_`, "");
  }

  if (input.excludedProviders?.length) {
    lines.push(
      "## Charges not included here",
      "",
      "These providers may bill separately and are not covered by this estimate. Contact them directly for their own good faith estimates:",
      ...input.excludedProviders.map((p) => `- ${p}`),
      "",
    );
  }

  lines.push(
    "## What this estimate means",
    "",
    `- This is an estimate of expected charges, not a bill, and not a contract. The actual items and services furnished may differ.`,
    `- If you are billed **$${GFE_DISPUTE_THRESHOLD} or more above** this estimate, you may dispute the bill through the federal patient-provider dispute resolution process. You generally have 120 calendar days from the date of the bill to start it.`,
    `- Asking for or receiving this estimate does not oblige you to obtain the care.`,
    `- Keep a copy. For questions about this estimate, contact ${input.providerName}.`,
    "",
    "_Generated by Orion from de-identified/test data. Review before giving it to a patient — this is a drafting aid, not legal advice._",
  );
  return lines.join("\n");
}
