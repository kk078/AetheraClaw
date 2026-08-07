import { parseYmd } from "../compliance/global-period.js";
import { addDays, todayYmd } from "../audit/deadlines.js";

// ── Code-set release cadence ─────────────────────────────────────────────────
// Coding data goes stale on a published schedule, and a practice billing last
// quarter's codes finds out through rejections rather than through a notice.
// Every cadence below is a published CMS/AMA schedule, but releases can slip and
// CMS can issue off-cycle replacement files, so the tools present these as the
// expected calendar rather than a guarantee.

/**
 * ICD-10-CM and ICD-10-PCS update twice a year: the main annual release on
 * October 1 and a mid-year release on April 1. April releases are usually much
 * smaller — some years are only typographical corrections — but they are real
 * and they are binding.
 */
export const ICD10_UPDATE_MONTHS = [4, 10];

/**
 * HCPCS Level II splits its cadence by what is being coded. Non-drug items and
 * services update on the first business day of January and July; drugs and
 * biologicals update every quarter. Practices that bill injectables therefore
 * face four update cycles a year, not two.
 */
export const HCPCS_UPDATE_MONTHS = [1, 7];
export const HCPCS_DRUG_UPDATE_MONTHS = [1, 4, 7, 10];

/** NCCI PTP and MUE files publish four versions a year, effective the 1st of each quarter. */
export const NCCI_UPDATE_MONTHS = [1, 4, 7, 10];

/** CPT (AMA) and the Medicare Physician Fee Schedule turn over each January 1. */
export const ANNUAL_JANUARY = [1];

export type CodeSetId = "icd10cm" | "icd10pcs" | "hcpcs" | "hcpcs_drug" | "ncci" | "cpt" | "mpfs";

export interface CodeSetSpec {
  id: CodeSetId;
  label: string;
  months: number[];
  /** Fiscal-year sets are named for the year their October release runs into. */
  edition: "fiscal" | "calendar";
  hierarchical: boolean;
  note: string;
}

export const CODE_SETS: Record<CodeSetId, CodeSetSpec> = {
  icd10cm: {
    id: "icd10cm",
    label: "ICD-10-CM (diagnoses)",
    months: ICD10_UPDATE_MONTHS,
    edition: "fiscal",
    hierarchical: true,
    note: "Main release October 1, mid-year release April 1. Which edition applies is decided by the DATE OF SERVICE, not the submission date.",
  },
  icd10pcs: {
    id: "icd10pcs",
    label: "ICD-10-PCS (inpatient procedures)",
    months: ICD10_UPDATE_MONTHS,
    edition: "fiscal",
    hierarchical: true,
    note: "Same October 1 / April 1 cadence as ICD-10-CM. Inpatient facility coding only.",
  },
  hcpcs: {
    id: "hcpcs",
    label: "HCPCS Level II (non-drug)",
    months: HCPCS_UPDATE_MONTHS,
    edition: "calendar",
    hierarchical: false,
    note: "Non-drug items and services update the first business day of January and July.",
  },
  hcpcs_drug: {
    id: "hcpcs_drug",
    label: "HCPCS Level II (drugs & biologicals)",
    months: HCPCS_DRUG_UPDATE_MONTHS,
    edition: "calendar",
    hierarchical: false,
    note: "Drugs and biologicals update quarterly — if you bill injectables this is your real cadence, not the January/July one.",
  },
  ncci: {
    id: "ncci",
    label: "NCCI PTP & MUE edits",
    months: NCCI_UPDATE_MONTHS,
    edition: "calendar",
    hierarchical: false,
    note: "Four versions a year, effective the 1st of each quarter. CMS also issues off-cycle replacement files when an edit has to change mid-quarter.",
  },
  cpt: {
    id: "cpt",
    label: "CPT (AMA)",
    months: ANNUAL_JANUARY,
    edition: "calendar",
    hierarchical: false,
    note: "Annual January 1 release. AMA-licensed — AetheraClaw cannot bundle it; supply your own file via healthcare.cptDataPath.",
  },
  mpfs: {
    id: "mpfs",
    label: "Medicare Physician Fee Schedule (RVUs & conversion factor)",
    months: ANNUAL_JANUARY,
    edition: "calendar",
    hierarchical: false,
    note: "Annual January 1 release. The conversion factor has been changed mid-year by legislation before, so confirm it against the current CMS file rather than assuming January's value holds.",
  },
};

function ymd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

/**
 * The fiscal year an ICD-10 edition is named for: FY2027 runs October 1 2026
 * through September 30 2027, so anything from October onward belongs to the
 * following named year.
 */
export function fiscalYearOf(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  return month >= 10 ? year + 1 : year;
}

/** Every release date for a code set within a year, in calendar order. */
function releasesInYear(spec: CodeSetSpec, year: number): string[] {
  return spec.months.map((m) => ymd(year, m, 1));
}

/** The next release that has not yet taken effect as of `asOf`. */
export function nextRelease(setId: CodeSetId, asOf: string = todayYmd()): string {
  const spec = CODE_SETS[setId];
  const year = Number(asOf.slice(0, 4));
  for (const candidate of [...releasesInYear(spec, year), ...releasesInYear(spec, year + 1)]) {
    if (candidate > asOf) return candidate;
  }
  // Unreachable while every set has at least one release a year, but a spec with
  // no months would otherwise silently return undefined.
  throw new Error(`${setId} has no scheduled releases`);
}

/** The most recent release already in effect as of `asOf` (inclusive of today). */
export function currentRelease(setId: CodeSetId, asOf: string = todayYmd()): string {
  const spec = CODE_SETS[setId];
  const year = Number(asOf.slice(0, 4));
  const past = [...releasesInYear(spec, year - 1), ...releasesInYear(spec, year)].filter((d) => d <= asOf);
  return past[past.length - 1];
}

/** Human-readable name of the edition in force, e.g. "FY2026" or "CY2026". */
export function editionLabel(setId: CodeSetId, asOf: string = todayYmd()): string {
  const spec = CODE_SETS[setId];
  return spec.edition === "fiscal" ? `FY${fiscalYearOf(asOf)}` : `CY${asOf.slice(0, 4)}`;
}

export interface UpcomingRelease {
  setId: CodeSetId;
  label: string;
  effective: string;
  daysAway: number;
  edition: string;
  note: string;
}

/** Every code-set release landing within `horizonDays`, soonest first. */
export function upcomingReleases(asOf: string = todayYmd(), horizonDays = 120): UpcomingRelease[] {
  const limit = addDays(asOf, horizonDays);
  const out: UpcomingRelease[] = [];
  for (const spec of Object.values(CODE_SETS)) {
    const year = Number(asOf.slice(0, 4));
    for (const effective of [...releasesInYear(spec, year), ...releasesInYear(spec, year + 1)]) {
      if (effective <= asOf || effective > limit) continue;
      out.push({
        setId: spec.id,
        label: spec.label,
        effective,
        daysAway: daysUntil(asOf, effective),
        edition: editionLabel(spec.id, effective),
        note: spec.note,
      });
    }
  }
  return out.sort((a, b) => a.effective.localeCompare(b.effective) || a.label.localeCompare(b.label));
}

function daysUntil(from: string, to: string): number {
  const a = parseYmd(from);
  const b = parseYmd(to);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export interface Staleness {
  setId: CodeSetId;
  label: string;
  installed: string;
  current: string;
  missedReleases: number;
  stale: boolean;
  message: string;
}

/**
 * How far behind an installed code set has fallen. Counts the releases that took
 * effect after the installed edition, so "one release behind" and "four releases
 * behind" read differently — the second is a practice billing last year's codes.
 */
export function assessStaleness(setId: CodeSetId, installedEffective: string, asOf: string = todayYmd()): Staleness {
  const spec = CODE_SETS[setId];
  const current = currentRelease(setId, asOf);
  const startYear = Number(installedEffective.slice(0, 4));
  const endYear = Number(asOf.slice(0, 4));
  let missed = 0;
  for (let y = startYear; y <= endYear; y++) {
    for (const r of releasesInYear(spec, y)) {
      if (r > installedEffective && r <= asOf) missed++;
    }
  }
  const stale = missed > 0;
  return {
    setId,
    label: spec.label,
    installed: installedEffective,
    current,
    missedReleases: missed,
    stale,
    message: stale
      ? `${spec.label}: installed edition is effective ${installedEffective} but ${missed} release(s) have taken effect since — the current one is ${current}. Claims coded from stale data reject on codes that no longer exist.`
      : `${spec.label}: installed edition (${installedEffective}) is current as of ${asOf}.`,
  };
}

export function describeUpcoming(r: UpcomingRelease): string {
  const when = r.daysAway === 0 ? "today" : r.daysAway === 1 ? "tomorrow" : `in ${r.daysAway} days`;
  return `${r.effective} (${when}) — ${r.label} ${r.edition}\n    ${r.note}`;
}
