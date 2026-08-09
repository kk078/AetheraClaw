import { normalizeIcd, type HccModel } from "./hcc.js";

// ── Recapture ────────────────────────────────────────────────────────────────
// The annual reset is the whole of it. A chronic condition coded last year
// contributes nothing to this year's risk score unless it is documented in a
// face-to-face encounter and coded again between 1 January and 31 December.
//
// This is the one part of value-based care that is unambiguously legitimate to
// chase. The condition is real, it was documented before, the patient still has
// it — and the only thing missing is that nobody coded it this year. Nothing is
// being added that was not there; the question is whether the encounter that
// already happened captured what it should have.
//
// Which is also the line this module will not cross. A gap is a prompt to look
// at the chart, not a code to submit. If the patient was not seen this year, or
// the note does not support the condition, the answer is that there is no
// recapture — and saying so is more useful than a list of revenue nobody can
// defend.

/** A diagnosis as it was actually coded on a claim. */
export interface CodedDiagnosis {
  patientRef: string;
  code: string;
  /** YYYYMMDD of the encounter it was coded on. */
  serviceDate: string;
  claimRef: string;
}

export interface RecaptureOptions {
  /** The calendar year being captured for. */
  year: number;
  /** Today, as YYYYMMDD — decides how much of the year is left. */
  asOf: string;
  model: HccModel;
  /** Years of history to look back over for a condition worth recapturing. */
  lookbackYears?: number;
}

export const DEFAULT_LOOKBACK_YEARS = 3;

export interface RecaptureGap {
  patientRef: string;
  hcc: string;
  label: string;
  coefficient: number;
  /** The code that carried it last time, and when. */
  lastCode: string;
  lastServiceDate: string;
  lastClaimRef: string;
  /** True when the patient has been seen this year at all. */
  seenThisYear: boolean;
  daysLeft: number;
}

export interface RecaptureReport {
  year: number;
  patients: number;
  /** Patients with at least one gap AND an encounter this year to capture it on. */
  actionable: RecaptureGap[];
  /** Gaps for patients not yet seen this year — a scheduling problem, not a coding one. */
  needsVisit: RecaptureGap[];
  /** Conditions already recaptured this year. */
  captured: number;
  daysLeft: number;
  warnings: string[];
}

function yearOf(serviceDate: string): number {
  return Number(serviceDate.slice(0, 4));
}

export function daysLeftInYear(asOf: string, targetYear: number = yearOf(asOf)): number {
  // Days from asOf to the end of the CAPTURE year, which is not necessarily
  // asOf's year — hcc_recapture takes `year` and `as_of` independently. Using
  // asOf's year alone reported "144 days left" for a 2025 capture run in Aug
  // 2026, when that window closed on 2025-12-31 (correctly 0, and the
  // deadline warning must fire, not stay silent).
  const end = Date.UTC(targetYear, 11, 31);
  const now = Date.UTC(yearOf(asOf), Number(asOf.slice(4, 6)) - 1, Number(asOf.slice(6, 8)));
  return Math.max(0, Math.round((end - now) / 86_400_000));
}

/**
 * Find conditions coded in a prior year and not yet this one.
 *
 * Grouped by HCC rather than by ICD-10 code, deliberately: recapture is about
 * the condition, and a patient whose diabetes was coded as E11.9 last year and
 * E11.65 this year has recaptured it. Comparing raw codes would report a gap
 * that does not exist and send a coder looking for something already done.
 */
export function findRecaptureGaps(history: CodedDiagnosis[], options: RecaptureOptions): RecaptureReport {
  const { year, asOf, model } = options;
  const lookback = options.lookbackYears ?? DEFAULT_LOOKBACK_YEARS;
  const warnings: string[] = [];
  const daysLeft = daysLeftInYear(asOf, year);

  interface PatientState {
    seenThisYear: boolean;
    capturedHccs: Set<string>;
    priorHccs: Map<string, CodedDiagnosis>;
  }
  const patients = new Map<string, PatientState>();
  let unmapped = 0;

  for (const entry of history) {
    if (!/^\d{8}$/.test(entry.serviceDate)) continue;
    const entryYear = yearOf(entry.serviceDate);
    if (entryYear > year || entryYear < year - lookback) continue;

    const state = patients.get(entry.patientRef) ?? {
      seenThisYear: false,
      capturedHccs: new Set<string>(),
      priorHccs: new Map<string, CodedDiagnosis>(),
    };
    if (entryYear === year) state.seenThisYear = true;

    const hcc = model.mapping[normalizeIcd(entry.code)];
    if (!hcc) {
      unmapped++;
      patients.set(entry.patientRef, state);
      continue;
    }

    if (entryYear === year) {
      state.capturedHccs.add(hcc);
    } else {
      // Keep the most recent prior sighting — it is the one a coder will pull.
      const existing = state.priorHccs.get(hcc);
      if (!existing || existing.serviceDate < entry.serviceDate) state.priorHccs.set(hcc, entry);
    }
    patients.set(entry.patientRef, state);
  }

  const actionable: RecaptureGap[] = [];
  const needsVisit: RecaptureGap[] = [];
  let captured = 0;

  for (const [patientRef, state] of patients) {
    captured += state.capturedHccs.size;
    for (const [hcc, last] of state.priorHccs) {
      if (state.capturedHccs.has(hcc)) continue;
      const def = model.definitions[hcc];
      if (!def) continue;
      const gap: RecaptureGap = {
        patientRef,
        hcc,
        label: def.label,
        coefficient: def.coefficient,
        lastCode: last.code.toUpperCase(),
        lastServiceDate: last.serviceDate,
        lastClaimRef: last.claimRef,
        seenThisYear: state.seenThisYear,
        daysLeft,
      };
      (state.seenThisYear ? actionable : needsVisit).push(gap);
    }
  }

  const bySize = (a: RecaptureGap, b: RecaptureGap) => b.coefficient - a.coefficient;
  actionable.sort(bySize);
  needsVisit.sort(bySize);

  if (unmapped > 0) {
    warnings.push(
      `${unmapped} coded diagnosis/es mapped to no HCC in this model and were ignored. Most codes are not HCCs, so that is ordinary — but a chronic condition in that group would be invisible to this report.`,
    );
  }
  if (daysLeft < 60 && actionable.length > 0) {
    warnings.push(
      `${daysLeft} day(s) left in ${year}. A condition not coded by 31 December does not count for the next payment year, and there is no late filing for it.`,
    );
  }
  if (patients.size === 0) {
    warnings.push("No coded history in the lookback window. Recapture needs claims with service dates and patient references.");
  }

  return { year, patients: patients.size, actionable, needsVisit, captured, daysLeft, warnings };
}

function money(coefficient: number, perRafDollar: number): string {
  return perRafDollar > 0 ? ` (~$${(coefficient * perRafDollar).toFixed(0)})` : "";
}

export function renderRecapture(report: RecaptureReport, perRafDollar = 0): string {
  const lines = [
    `Recapture for ${report.year} — ${report.patients} patient(s), ${report.captured} condition(s) already captured, ${report.daysLeft} day(s) left.`,
  ];

  if (report.actionable.length > 0) {
    const total = report.actionable.reduce((s, g) => s + g.coefficient, 0);
    lines.push(
      "",
      `Seen this year, condition not yet coded — ${report.actionable.length} gap(s), ${total.toFixed(3)} RAF${money(total, perRafDollar)}:`,
    );
    for (const g of report.actionable.slice(0, 25)) {
      lines.push(
        `  ${g.patientRef}  ${g.hcc} ${g.label}  ${g.coefficient.toFixed(3)}`,
        `    last coded ${g.lastCode} on ${g.lastServiceDate} (${g.lastClaimRef})`,
      );
    }
    if (report.actionable.length > 25) lines.push(`  … and ${report.actionable.length - 25} more.`);
    lines.push(
      "",
      "These are chart reviews, not codes to submit. The condition has to be addressed in a note from this year — a problem list carried forward is what a RADV audit removes first.",
    );
  }

  if (report.needsVisit.length > 0) {
    const total = report.needsVisit.reduce((s, g) => s + g.coefficient, 0);
    lines.push(
      "",
      `Not seen at all this year — ${report.needsVisit.length} gap(s), ${total.toFixed(3)} RAF${money(total, perRafDollar)}:`,
      "This is a scheduling problem rather than a coding one. Without a face-to-face encounter there is nothing to code, and no amount of chart review creates one.",
    );
    for (const g of report.needsVisit.slice(0, 15)) {
      lines.push(`  ${g.patientRef}  ${g.hcc} ${g.label}  last seen ${g.lastServiceDate}`);
    }
    if (report.needsVisit.length > 15) lines.push(`  … and ${report.needsVisit.length - 15} more.`);
  }

  if (report.actionable.length === 0 && report.needsVisit.length === 0) {
    lines.push("", "No gaps found. Every condition coded in the lookback window has been coded again this year.");
  }

  if (report.warnings.length > 0) lines.push("", ...report.warnings.map((w) => `⚠ ${w}`));
  return lines.join("\n");
}
