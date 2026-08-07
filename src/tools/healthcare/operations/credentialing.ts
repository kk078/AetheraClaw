import { parseYmd } from "../compliance/global-period.js";
import { todayYmd } from "../audit/deadlines.js";
import { addCalendarYears, addDaysYmd, daysBetweenYmd } from "../prediction/timely-filing.js";

// ── Credentialing & enrollment ───────────────────────────────────────────────
// A lapsed credential is the most expensive administrative failure in a practice
// because it is not fixable afterwards: claims for services furnished while the
// provider was not enrolled deny as not-eligible, and no appeal recovers them.
// The work is therefore entirely preventive, which makes it exactly the kind of
// thing that gets forgotten until a remittance explains it.

/** Providers and organizations revalidate Medicare enrollment every five years. */
export const MEDICARE_REVALIDATION_YEARS = 5;

/** DMEPOS suppliers revalidate every three. */
export const DMEPOS_REVALIDATION_YEARS = 3;

/** CAQH ProView data must be re-attested every 120 days or the profile goes stale. */
export const CAQH_ATTESTATION_DAYS = 120;

/** CMS posts revalidation due dates about seven months ahead. */
export const REVALIDATION_NOTICE_MONTHS = 7;

/** Practical lead time to start gathering documents for a revalidation. */
export const REVALIDATION_PREP_DAYS = 180;

/** CARC returned when the provider was not eligible on the date of service. */
export const NOT_ELIGIBLE_CARC = "B7";

export type EnrollmentStatus =
  | "not_started"
  | "application_submitted"
  | "in_review"
  | "approved"
  | "revalidation_due"
  | "deactivated"
  | "terminated";

export type EnrollmentKind = "medicare" | "medicare_dmepos" | "medicaid" | "commercial";

/** Statuses under which the provider may not bill this payer yet (or any more). */
export const NON_BILLABLE_STATUSES = new Set<EnrollmentStatus>([
  "not_started",
  "application_submitted",
  "in_review",
  "deactivated",
  "terminated",
]);

export interface CredentialRecord {
  id: string;
  providerNpi: string;
  providerName: string;
  payer: string;
  kind: EnrollmentKind;
  status: EnrollmentStatus;
  /** YYYYMMDD the enrollment took effect. */
  effectiveDate: string;
  /** YYYYMMDD; computed from the effective date when the payer has not stated one. */
  revalidationDue: string;
  /** YYYYMMDD of the last CAQH attestation, "" when not applicable. */
  caqhAttestedOn: string;
  notes: string;
}

export function revalidationYears(kind: EnrollmentKind): number {
  return kind === "medicare_dmepos" ? DMEPOS_REVALIDATION_YEARS : MEDICARE_REVALIDATION_YEARS;
}

/**
 * The revalidation date implied by the effective date. Medicare publishes the
 * real due date and that always wins — this is the placeholder used until one
 * arrives, so a new enrollment is not simply unwatched.
 */
export function impliedRevalidationDue(effectiveDate: string, kind: EnrollmentKind): string {
  return addCalendarYears(effectiveDate, revalidationYears(kind));
}

export function caqhExpiry(attestedOn: string): string {
  return addDaysYmd(attestedOn, CAQH_ATTESTATION_DAYS);
}

export interface CredentialAlert {
  severity: "error" | "warning" | "info";
  rule: string;
  record: CredentialRecord;
  daysRemaining: number | null;
  message: string;
}

/**
 * Everything wrong or about to go wrong with one enrollment.
 *
 * Ordering matters here: a provider who cannot bill today is a different problem
 * from one whose paperwork is due in five months, and reporting them at the same
 * volume is how the second gets ignored until it becomes the first.
 */
export function assessCredential(
  record: CredentialRecord,
  opts: { asOf?: string; horizonDays?: number } = {},
): CredentialAlert[] {
  const asOf = opts.asOf ?? todayYmd();
  const horizon = opts.horizonDays ?? REVALIDATION_PREP_DAYS;
  const out: CredentialAlert[] = [];

  if (NON_BILLABLE_STATUSES.has(record.status)) {
    const stopped = record.status === "deactivated" || record.status === "terminated";
    out.push({
      severity: "error",
      rule: stopped ? "enrollment-stopped" : "enrollment-incomplete",
      record,
      daysRemaining: null,
      message: stopped
        ? `${record.providerName} is ${record.status} with ${record.payer}. Claims for services furnished while ${record.status} deny as provider-not-eligible (CARC ${NOT_ELIGIBLE_CARC}) and are not recoverable on appeal — stop billing this payer until enrollment is restored.`
        : `${record.providerName} is not yet approved with ${record.payer} (status: ${record.status}). Holding claims until approval is usually better than submitting them, because a denial for provider-not-eligible cannot be appealed away.`,
    });
  }

  if (record.revalidationDue) {
    const days = daysBetweenYmd(asOf, record.revalidationDue);
    if (days < 0) {
      out.push({
        severity: "error",
        rule: "revalidation-overdue",
        record,
        daysRemaining: days,
        message: `${record.providerName}'s ${record.payer} revalidation was due ${record.revalidationDue}, ${-days} day(s) ago. Missing it puts a hold on reimbursement and can deactivate billing privileges outright.`,
      });
    } else if (days <= horizon) {
      out.push({
        severity: days <= 60 ? "warning" : "info",
        rule: "revalidation-due",
        record,
        daysRemaining: days,
        message: `${record.providerName}'s ${record.payer} revalidation is due ${record.revalidationDue} — ${days} day(s) away. Start now: the paperwork takes weeks and the consequence of being late is a payment hold, not a reminder.`,
      });
    }
  }

  if (record.caqhAttestedOn) {
    const expiry = caqhExpiry(record.caqhAttestedOn);
    const days = daysBetweenYmd(asOf, expiry);
    if (days < 0) {
      out.push({
        severity: "error",
        rule: "caqh-expired",
        record,
        daysRemaining: days,
        message: `CAQH attestation for ${record.providerName} expired ${expiry} (last attested ${record.caqhAttestedOn}). A stale profile silently blocks commercial credentialing and is a common cause of development requests — nothing announces it, so it is found only by looking.`,
      });
    } else if (days <= 30) {
      out.push({
        severity: "warning",
        rule: "caqh-due",
        record,
        daysRemaining: days,
        message: `CAQH attestation for ${record.providerName} expires ${expiry} — ${days} day(s) away. Re-attest every ${CAQH_ATTESTATION_DAYS} days.`,
      });
    }
  }

  return out;
}

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 } as const;

export function assessAll(
  records: CredentialRecord[],
  opts: { asOf?: string; horizonDays?: number } = {},
): CredentialAlert[] {
  return records
    .flatMap((r) => assessCredential(r, opts))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        (a.daysRemaining ?? -1e9) - (b.daysRemaining ?? -1e9),
    );
}

export function renderAlerts(alerts: CredentialAlert[], asOf: string): string {
  if (alerts.length === 0) return `No credentialing problems found as of ${asOf}.`;
  const blocking = alerts.filter((a) => a.severity === "error");
  const soon = alerts.filter((a) => a.severity === "warning");
  const later = alerts.filter((a) => a.severity === "info");

  const lines: string[] = [];
  if (blocking.length) {
    lines.push(`BLOCKING — ${blocking.length} item(s) affecting whether you can bill today:`);
    for (const a of blocking) lines.push(`  ${a.message}`);
    lines.push("");
  }
  if (soon.length) {
    lines.push(`SOON — ${soon.length} item(s):`);
    for (const a of soon) lines.push(`  ${a.message}`);
    lines.push("");
  }
  if (later.length) {
    lines.push(`AHEAD — ${later.length} item(s):`);
    for (const a of later) lines.push(`  ${a.message}`);
    lines.push("");
  }
  lines.push(
    "Revalidation dates published by the payer always override the computed ones — these are placeholders so a new enrollment is not left unwatched, not a substitute for the notice.",
  );
  return lines.join("\n");
}

/** Guard used before billing: is this provider billable by this payer on this date? */
export function billableOn(record: CredentialRecord, serviceDate: string): { billable: boolean; reason: string } {
  if (NON_BILLABLE_STATUSES.has(record.status)) {
    return {
      billable: false,
      reason: `${record.providerName} is ${record.status} with ${record.payer}.`,
    };
  }
  if (record.effectiveDate && parseYmd(record.effectiveDate) && serviceDate < record.effectiveDate) {
    return {
      billable: false,
      reason: `Service date ${serviceDate} precedes the ${record.effectiveDate} enrollment effective date with ${record.payer}.`,
    };
  }
  return { billable: true, reason: `Enrolled with ${record.payer} since ${record.effectiveDate || "an unrecorded date"}.` };
}
