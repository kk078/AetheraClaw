import { parseYmd } from "../compliance/global-period.js";
import { todayYmd } from "../audit/deadlines.js";

// ── Timely filing ────────────────────────────────────────────────────────────
// The filing clock is the one deadline in RCM with no appeal on the merits: once
// it runs out the money is simply gone, however clean the claim was. It is also
// the deadline most often lost to a claim that WAS filed on time but cannot be
// proven to have been — which is why proof is modelled here alongside the dates.

/** Medicare fee-for-service: one calendar year from the date of service (ACA §6404). */
export const MEDICARE_FILING_CALENDAR_YEARS = 1;

/**
 * The statutory exceptions at 42 CFR 424.44(b) extend filing through the last
 * day of the SIXTH month following the month the provider received notice.
 */
export const MEDICARE_EXCEPTION_MONTHS = 6;

/** How a timely-filing denial arrives on the remittance. */
export const TIMELY_FILING_CARC = "29";
export const TIMELY_FILING_RARC = "N390";

export type FilingExceptionReason =
  | "administrative_error"
  | "retroactive_entitlement"
  | "retroactive_medicaid_recoupment";

export const MEDICARE_FILING_EXCEPTIONS: Record<FilingExceptionReason, string> = {
  administrative_error:
    "Error or misrepresentation by an HHS employee, Medicare contractor, or agent acting within the scope of its authority.",
  retroactive_entitlement:
    "The beneficiary was notified of Medicare entitlement retroactive to or before the date of service, after the filing period had already run.",
  retroactive_medicaid_recoupment:
    "A State Medicaid agency recouped payment from the provider six months or more after the service was furnished to a dually eligible beneficiary.",
};

export interface FilingWindow {
  payerKey: string;
  label: string;
  /** Either a day count or a calendar-year count — Medicare is defined in calendar years. */
  days?: number;
  calendarYears?: number;
  note: string;
}

/**
 * Seeded starting points, not contract terms. Commercial windows are set by the
 * agreement you signed and vary by plan within the same carrier, so every one of
 * these is overridable and the tools say the contract controls.
 */
export const DEFAULT_FILING_WINDOWS: Record<string, FilingWindow> = {
  medicare: {
    payerKey: "medicare",
    label: "Medicare fee-for-service",
    calendarYears: MEDICARE_FILING_CALENDAR_YEARS,
    note: "One calendar year from the date of service, set by statute (ACA §6404) rather than by contract. Three narrow exceptions exist at 42 CFR 424.44(b).",
  },
  medicare_advantage: {
    payerKey: "medicare_advantage",
    label: "Medicare Advantage",
    days: 365,
    note: "Set by the plan's provider agreement, commonly 365 days. Not the same rule as fee-for-service Medicare.",
  },
  medicaid: {
    payerKey: "medicaid",
    label: "Medicaid",
    days: 365,
    note: "State-specific and often far shorter than a year — some states allow 95 days. Confirm against your state's rule before relying on this.",
  },
  bcbs: { payerKey: "bcbs", label: "Blue Cross Blue Shield", days: 180, note: "Varies widely by plan and state; check the contract." },
  uhc: { payerKey: "uhc", label: "UnitedHealthcare", days: 90, note: "Commonly 90 days for participating providers; check the contract." },
  aetna: { payerKey: "aetna", label: "Aetna", days: 120, note: "Commonly 120 days; check the contract." },
  cigna: { payerKey: "cigna", label: "Cigna", days: 90, note: "Commonly 90 days; check the contract." },
  humana: { payerKey: "humana", label: "Humana", days: 90, note: "Commonly 90 days; check the contract." },
};

export function payerKey(payer: string): string {
  return payer.toLowerCase().replace(/[^a-z]/g, "");
}

/** Resolve a payer name against the window table, tolerating "Medicare Part B" and the like. */
export function resolveWindow(payer: string, table: Record<string, FilingWindow>): FilingWindow | null {
  const key = payerKey(payer);
  if (table[key]) return table[key];
  // Match against the LABEL as well as the key. The seeded keys are
  // abbreviations ("uhc", "bcbs") that are not substrings of the real payer
  // names in 835 N1*PR segments ("UnitedHealthcare", "Blue Cross Blue Shield"),
  // so key-only matching left the two shortest, most dangerous commercial windows
  // (UHC 90d, BCBS 180d) unreachable by their own names. Each candidate's needles
  // are its key and its normalized label; the longest matching needle wins so
  // "medicareadvantage" still beats "medicare".
  const needlesOf = (w: FilingWindow, k: string) => [payerKey(k), w.label ? payerKey(w.label) : ""].filter(Boolean);
  let best: { window: FilingWindow; len: number } | null = null;
  for (const [k, win] of Object.entries(table)) {
    for (const needle of needlesOf(win, k)) {
      if (key.includes(needle) && (!best || needle.length > best.len)) best = { window: win, len: needle.length };
    }
  }
  return best?.window ?? null;
}

function toYmd(d: Date): string {
  return (
    String(d.getUTCFullYear()).padStart(4, "0") +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0")
  );
}

/**
 * Add calendar years, not 365-day blocks. Medicare's limit is "one calendar
 * year after the date of service", so a leap day in between must not shift the
 * deadline by a day. February 29 clamps to February 28 in a non-leap year.
 */
export function addCalendarYears(ymd: string, years: number): string {
  const base = parseYmd(ymd);
  if (!base) throw new Error(`invalid date "${ymd}" (expected YYYYMMDD)`);
  const year = base.getUTCFullYear() + years;
  const month = base.getUTCMonth();
  const day = base.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return toYmd(new Date(Date.UTC(year, month, Math.min(day, lastDay))));
}

export function addDaysYmd(ymd: string, days: number): string {
  const base = parseYmd(ymd);
  if (!base) throw new Error(`invalid date "${ymd}" (expected YYYYMMDD)`);
  return toYmd(new Date(base.getTime() + days * 86_400_000));
}

export function daysBetweenYmd(from: string, to: string): number {
  const a = parseYmd(from);
  const b = parseYmd(to);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** The last day of the Nth month following the month of `ymd`. */
export function lastDayOfNthMonthAfter(ymd: string, months: number): string {
  const base = parseYmd(ymd);
  if (!base) throw new Error(`invalid date "${ymd}" (expected YYYYMMDD)`);
  // Day 0 of month M+N+1 is the last day of month M+N.
  return toYmd(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months + 1, 0)));
}

/** Extended deadline under a 42 CFR 424.44(b) exception, measured from the notice date. */
export function medicareExceptionDeadline(noticeDate: string): string {
  return lastDayOfNthMonthAfter(noticeDate, MEDICARE_EXCEPTION_MONTHS);
}

export interface FilingStatus {
  payer: string;
  serviceDate: string;
  deadline: string;
  daysRemaining: number;
  expired: boolean;
  severity: "error" | "warning" | "info";
  window: FilingWindow | null;
  message: string;
}

export function filingStatus(
  payer: string,
  serviceDate: string,
  opts: { table?: Record<string, FilingWindow>; overrideDays?: number; asOf?: string } = {},
): FilingStatus | { error: string } {
  const asOf = opts.asOf ?? todayYmd();
  const table = opts.table ?? DEFAULT_FILING_WINDOWS;
  const window = opts.overrideDays === undefined ? resolveWindow(payer, table) : null;

  let deadline: string;
  if (opts.overrideDays !== undefined) {
    deadline = addDaysYmd(serviceDate, opts.overrideDays);
  } else if (!window) {
    return {
      error: `No filing window on file for "${payer}". Supply filing_limit_days from the contract, or add the payer with timely_filing_set. Known: ${Object.values(table)
        .map((w) => `${w.payerKey}=${w.calendarYears ? `${w.calendarYears}y` : `${w.days}d`}`)
        .join(", ")}`,
    };
  } else if (window.calendarYears !== undefined) {
    deadline = addCalendarYears(serviceDate, window.calendarYears);
  } else {
    deadline = addDaysYmd(serviceDate, window.days ?? 0);
  }

  const daysRemaining = daysBetweenYmd(asOf, deadline);
  const expired = daysRemaining < 0;
  const severity = expired ? "error" : daysRemaining <= 30 ? "warning" : "info";

  const message = expired
    ? `EXPIRED — the filing deadline was ${deadline}, ${-daysRemaining} day(s) ago. An unfiled claim is unrecoverable; a claim that WAS filed in time can still be won on appeal with proof of timely filing (CARC ${TIMELY_FILING_CARC}, RARC ${TIMELY_FILING_RARC}).`
    : `Deadline ${deadline} — ${daysRemaining} day(s) remaining${daysRemaining <= 30 ? ". File now; this window is closing." : "."}`;

  return {
    payer,
    serviceDate,
    deadline,
    daysRemaining,
    expired,
    severity,
    window,
    message,
  };
}

export interface FilingProof {
  claimId: string;
  acceptedOn: string;
  payerClaimNumber: string;
  source: string;
}

/**
 * What actually wins a CARC 29 appeal. The distinction that decides these cases:
 * a submission report proves you sent something, an ACCEPTANCE report proves the
 * payer received it — only the second is proof. The 277CA acknowledgment is the
 * cleanest form of it, which is why acceptances are banked when acknowledgments
 * are parsed rather than hunted for months later.
 */
export function proofGuidance(proof: FilingProof | null, deadline: string): string {
  if (!proof) {
    return [
      "No acceptance on file for this claim.",
      `Proof of timely filing means an ACCEPTANCE report, not a submission report — a submission log shows you sent a claim, only an acknowledgment shows the payer received it. The 277CA is the cleanest form: parse acknowledgments with ack_parse_277ca as they arrive and the evidence is banked before you need it.`,
      "Failing that: a clearinghouse acceptance report with a timestamp, a payer portal confirmation, or a certified-mail receipt. An internal screenshot of your practice management system is generally not accepted.",
    ].join(" ");
  }
  const inTime = proof.acceptedOn <= deadline;
  return inTime
    ? `Acceptance on file: the payer acknowledged this claim on ${proof.acceptedOn}${proof.payerClaimNumber ? ` as claim ${proof.payerClaimNumber}` : ""}, inside the ${deadline} deadline (source: ${proof.source}). That acknowledgment is your proof of timely filing — attach it to any CARC ${TIMELY_FILING_CARC} appeal.`
    : `Acceptance on file, but dated ${proof.acceptedOn} — AFTER the ${deadline} deadline (source: ${proof.source}). This does not establish timely filing. Check whether an earlier submission was acknowledged, or whether a 42 CFR 424.44(b) exception applies.`;
}
