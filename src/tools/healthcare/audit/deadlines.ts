import { daysBetween, parseYmd } from "../compliance/global-period.js";

// ── Regulatory clocks ────────────────────────────────────────────────────────
// Every constant below is a published CMS/MAC timeframe. They are exported and
// overridable because the notice a provider actually receives controls: a
// contractor can grant good cause on an ADR, and demand letters state their own
// dates. Tools that use these say so.

/** Documentation-request response window (MAC ADR, RAC, SMRC). Good cause may extend it. */
export const ADR_RESPONSE_DAYS = 45;

/** Medicare fee-for-service appeal ladder. Each window runs from receipt of the prior decision. */
export const APPEAL_LEVELS = [
  { level: 1, name: "Redetermination", forum: "MAC", days: 120, from: "initial determination" },
  { level: 2, name: "Reconsideration", forum: "QIC", days: 180, from: "redetermination" },
  { level: 3, name: "ALJ hearing", forum: "OMHA", days: 60, from: "reconsideration" },
  { level: 4, name: "Appeals Council review", forum: "DAB", days: 60, from: "ALJ decision" },
  { level: 5, name: "Judicial review", forum: "Federal district court", days: 60, from: "Council decision" },
] as const;

export type AppealLevel = (typeof APPEAL_LEVELS)[number]["level"];

/**
 * Limitation on recoupment (MMA §935). Recoupment starts on day 41 after the
 * demand letter unless a valid redetermination is filed by day 30; after an
 * unfavorable redetermination it resumes no earlier than day 60 from the revised
 * notice unless a reconsideration is filed.
 */
export const RECOUPMENT_START_DAY = 41;
export const RECOUPMENT_STAY_L1_DAY = 30;
export const RECOUPMENT_STAY_L2_DAY = 60;

/** ACA §6402(a): report and return an identified overpayment within 60 days of IDENTIFICATION. */
export const REPORT_AND_RETURN_DAYS = 60;

/** CMS-838 credit balance report: due within 30 days after each calendar quarter closes. */
export const CMS838_DAYS_AFTER_QUARTER = 30;

export function addDays(ymd: string, days: number): string {
  const base = parseYmd(ymd);
  if (!base) throw new Error(`invalid date "${ymd}" (expected YYYYMMDD)`);
  const out = new Date(base.getTime() + days * 86_400_000);
  return (
    String(out.getUTCFullYear()).padStart(4, "0") +
    String(out.getUTCMonth() + 1).padStart(2, "0") +
    String(out.getUTCDate()).padStart(2, "0")
  );
}

export function formatYmd(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

export function todayYmd(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

export interface Deadline {
  label: string;
  dueDate: string; // YYYYMMDD
  daysRemaining: number; // negative when overdue
  overdue: boolean;
  note: string;
}

function makeDeadline(label: string, from: string, days: number, note: string, asOf: string): Deadline {
  const dueDate = addDays(from, days);
  const daysRemaining = daysBetween(asOf, dueDate) ?? 0;
  return { label, dueDate, daysRemaining, overdue: daysRemaining < 0, note };
}

/** Response deadline for a records/documentation request. */
export function adrDeadline(requestDate: string, days = ADR_RESPONSE_DAYS, asOf = todayYmd()): Deadline {
  return makeDeadline(
    "Documentation response",
    requestDate,
    days,
    `${days} calendar days from the request date. Contractors may accept late records for good cause (disaster, business interruption), but do not rely on it.`,
    asOf,
  );
}

/** Filing deadline for the next level of Medicare appeal after a determination. */
export function appealDeadline(level: AppealLevel, determinationDate: string, asOf = todayYmd()): Deadline {
  const spec = APPEAL_LEVELS.find((l) => l.level === level);
  if (!spec) throw new Error(`unknown appeal level ${level}`);
  return makeDeadline(
    `Level ${spec.level} — ${spec.name} (${spec.forum})`,
    determinationDate,
    spec.days,
    `${spec.days} days from receipt of the ${spec.from}. Levels 3 and 5 also carry an amount-in-controversy threshold that CMS adjusts annually — verify the current figure.`,
    asOf,
  );
}

/** Every remaining level, for planning an appeal strategy from one determination date. */
export function appealLadder(determinationDate: string, fromLevel: AppealLevel = 1, asOf = todayYmd()): Deadline[] {
  return APPEAL_LEVELS.filter((l) => l.level >= fromLevel).map((l) =>
    l.level === fromLevel
      ? appealDeadline(l.level, determinationDate, asOf)
      : {
          label: `Level ${l.level} — ${l.name} (${l.forum})`,
          dueDate: "",
          daysRemaining: 0,
          overdue: false,
          note: `${l.days} days from receipt of the ${l.from} — the clock starts when that decision arrives.`,
        },
  );
}

export interface RecoupmentTimeline {
  demandLetterDate: string;
  stayByRedetermination: Deadline;
  recoupmentBegins: Deadline;
  stayByReconsiderationNote: string;
}

/** When recoupment starts on a demanded overpayment and what stops it. */
export function recoupmentTimeline(demandLetterDate: string, asOf = todayYmd()): RecoupmentTimeline {
  return {
    demandLetterDate,
    stayByRedetermination: makeDeadline(
      "File redetermination to stay recoupment",
      demandLetterDate,
      RECOUPMENT_STAY_L1_DAY,
      `A valid redetermination received by day ${RECOUPMENT_STAY_L1_DAY} stops recoupment before it starts. Filed later, recoupment stops whenever the appeal is received — money already recouped is refunded with §935 interest only if you win at ALJ or above.`,
      asOf,
    ),
    recoupmentBegins: makeDeadline(
      "Recoupment begins",
      demandLetterDate,
      RECOUPMENT_START_DAY,
      `Day ${RECOUPMENT_START_DAY} from the demand letter unless a timely redetermination was filed.`,
      asOf,
    ),
    stayByReconsiderationNote: `If the redetermination is unfavorable, recoupment resumes no earlier than day ${RECOUPMENT_STAY_L2_DAY} from the revised notice — a reconsideration filed within that window stays it again.`,
  };
}

/** ACA §6402(a) report-and-return deadline. Distinct from the §935 recoupment clock. */
export function refundDeadline(identifiedDate: string, asOf = todayYmd()): Deadline {
  return makeDeadline(
    "Report and return overpayment",
    identifiedDate,
    REPORT_AND_RETURN_DAYS,
    `${REPORT_AND_RETURN_DAYS} days from IDENTIFICATION (ACA §6402(a)). Identification requires reasonable diligence — the clock starts when the overpayment is quantified, not when it is first suspected. Retaining it past the deadline creates False Claims Act exposure.`,
    asOf,
  );
}

/** Next CMS-838 quarterly credit balance report due date (institutional providers). */
export function nextCms838Due(asOf = todayYmd()): Deadline {
  const date = parseYmd(asOf);
  if (!date) throw new Error(`invalid date "${asOf}"`);
  const year = date.getUTCFullYear();
  const quarterEndMonths = [2, 5, 8, 11]; // Mar, Jun, Sep, Dec (0-indexed)

  // Scan this year and the next: the Q4 report is due in January, so from late
  // December the next deadline always falls in the following calendar year.
  for (const y of [year, year + 1]) {
    for (const m of quarterEndMonths) {
      const lastDay = new Date(Date.UTC(y, m + 1, 0));
      const quarterEnd =
        String(lastDay.getUTCFullYear()).padStart(4, "0") +
        String(lastDay.getUTCMonth() + 1).padStart(2, "0") +
        String(lastDay.getUTCDate()).padStart(2, "0");
      const due = addDays(quarterEnd, CMS838_DAYS_AFTER_QUARTER);
      const remaining = daysBetween(asOf, due) ?? 0;
      if (remaining >= 0) {
        return {
          label: `CMS-838 for the quarter ending ${formatYmd(quarterEnd)}`,
          dueDate: due,
          daysRemaining: remaining,
          overdue: false,
          note: `Due within ${CMS838_DAYS_AFTER_QUARTER} days of quarter close. Institutional providers must file even when there are no credit balances to report.`,
        };
      }
    }
  }
  throw new Error(`unable to compute a CMS-838 due date from ${asOf}`);
}

export function describeDeadline(d: Deadline): string {
  const when = d.dueDate ? formatYmd(d.dueDate) : "not yet started";
  const countdown = !d.dueDate
    ? ""
    : d.overdue
      ? `  ** OVERDUE by ${Math.abs(d.daysRemaining)} day(s) **`
      : `  (${d.daysRemaining} day(s) remaining)`;
  return `${d.label}: ${when}${countdown}\n    ${d.note}`;
}
