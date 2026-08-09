import type { Era, EraServiceLine } from "../x12/835.js";
import { baseProcedureCode, procedureModifiers } from "../x12/segments.js";
import { SEQUESTRATION_CARC } from "./fee-schedule.js";

// ── Payment variance ─────────────────────────────────────────────────────────
// Underpayments do not announce themselves. A payer pays *something*, the claim
// closes as paid, and the difference between what was owed and what arrived is
// only visible if someone computes it. This module derives what the payer
// actually allowed from the remittance, then compares it two ways: against the
// Medicare fee schedule, and against the payer's own established rate.
//
// The second comparison is the one that works everywhere. Commercial payers pay
// a percentage of Medicare that varies by contract, so a fee-schedule comparison
// says little — but a payer paying less than *it* has been paying for the same
// code is a signal regardless of what the contract says.

/** Adjustment groups that represent money the patient owes. */
const PATIENT_GROUPS = new Set(["PR"]);

export interface DerivedAllowed {
  charged: number;
  paid: number;
  patientResponsibility: number;
  sequestration: number;
  contractual: number;
  allowed: number;
  allowedPerUnit: number;
  units: number;
  balanced: boolean;
}

/**
 * Recover the allowed amount from a remittance line.
 *
 *   allowed = paid + patient responsibility + sequestration
 *
 * Sequestration (CARC 253) has to be added back: it is a reduction to the
 * federal payment applied *after* the allowed amount is set, so leaving it in
 * the write-off bucket makes every Medicare line look underpaid by about 1.6%
 * and buries real underpayments in false ones.
 */
/** A line paid nothing with a non-patient adjustment is a denial, not an underpayment. */
export function isLineDenied(line: EraServiceLine): boolean {
  if (line.paid > 0.005) return false;
  const nonPatient = line.adjustments.filter((a) => !PATIENT_GROUPS.has(a.group)).reduce((s, a) => s + a.amount, 0);
  return nonPatient > 0.005;
}

export function deriveAllowed(line: EraServiceLine): DerivedAllowed {
  let patientResponsibility = 0;
  let sequestration = 0;
  let contractual = 0;

  for (const a of line.adjustments) {
    if (a.carc === SEQUESTRATION_CARC) sequestration += a.amount;
    else if (PATIENT_GROUPS.has(a.group)) patientResponsibility += a.amount;
    else contractual += a.amount;
  }

  const allowed = line.paid + patientResponsibility + sequestration;
  const units = line.units > 0 ? line.units : 1;
  const totalAdjustments = patientResponsibility + sequestration + contractual;

  return {
    charged: line.charged,
    paid: line.paid,
    patientResponsibility,
    sequestration,
    contractual,
    allowed: round2(allowed),
    allowedPerUnit: round2(allowed / units),
    units,
    balanced: Math.abs(line.charged - (line.paid + totalAdjustments)) < 0.005,
  };
}

export interface PaidLine {
  payer: string;
  claimId: string;
  code: string;
  modifiers: string[];
  receivedAt: number;
  derived: DerivedAllowed;
  denied: boolean;
}

/** Flatten stored remittances into one comparable line per adjudicated service. */
export function collectPaidLines(eras: Array<{ era: Era; receivedAt: number }>): PaidLine[] {
  const out: PaidLine[] = [];
  for (const { era, receivedAt } of eras) {
    for (const claim of era.claims) {
      for (const line of claim.lines) {
        // parse835 records claim-level adjustments as a synthetic line.
        if (line.procedure === "(claim level)") continue;
        out.push({
          payer: era.payer,
          claimId: claim.claimId,
          code: baseProcedureCode(line.procedure),
          modifiers: procedureModifiers(line.procedure),
          receivedAt,
          derived: deriveAllowed(line),
          // Denied at the CLAIM level (CLP status 4) OR at the LINE level: a line
          // paid $0 with a non-patient-responsibility adjustment is a denial, not
          // an underpayment. Marking only claim-status-4 let a $0 line on an
          // otherwise-paid claim be reported as underpaid by the full expected
          // amount, inflating the recovery figure for a line already queued as a
          // denial. Mirrors risk.ts's collectOutcomes.
          denied: claim.statusCode === "4" || isLineDenied(line),
        });
      }
    }
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : round2((sorted[mid - 1] + sorted[mid]) / 2);
}

export interface Baseline {
  payer: string;
  code: string;
  median: number;
  min: number;
  max: number;
  n: number;
}

export function baselineKey(payer: string, code: string): string {
  return `${payer.trim().toUpperCase()}|${code.trim().toUpperCase()}`;
}

/**
 * What each payer has established it pays for each code, per unit. Denied lines
 * are excluded — a denial is a zero, and letting zeros into the baseline drags
 * the established rate down and hides the underpayments this is meant to find.
 */
export function payerBaselines(lines: PaidLine[]): Map<string, Baseline> {
  const buckets = new Map<string, { payer: string; code: string; values: number[] }>();
  for (const line of lines) {
    if (line.denied || line.derived.allowed <= 0) continue;
    const key = baselineKey(line.payer, line.code);
    const slot = buckets.get(key) ?? { payer: line.payer, code: line.code, values: [] };
    slot.values.push(line.derived.allowedPerUnit);
    buckets.set(key, slot);
  }
  const out = new Map<string, Baseline>();
  for (const [key, b] of buckets) {
    out.set(key, {
      payer: b.payer,
      code: b.code,
      median: median(b.values),
      min: Math.min(...b.values),
      max: Math.max(...b.values),
      n: b.values.length,
    });
  }
  return out;
}

export type VarianceBasis = "fee_schedule" | "payer_history" | "contract";

export interface VarianceFinding {
  severity: "error" | "warning" | "info";
  basis: VarianceBasis;
  payer: string;
  claimId: string;
  code: string;
  expectedPerUnit: number;
  actualPerUnit: number;
  units: number;
  shortfall: number;
  pctBelow: number;
  message: string;
}

export interface VarianceOptions {
  basis: VarianceBasis;
  /** Expected allowed per unit by code — used for the fee_schedule basis. */
  expectedByCode?: Map<string, number>;
  baselines?: Map<string, Baseline>;
  /** Ignore shortfalls smaller than this share of expected. */
  tolerancePct?: number;
  /** Minimum observations before a payer's own history is trusted as a baseline. */
  minSample?: number;
  /** Ignore shortfalls smaller than this many dollars. */
  minDollars?: number;
  /**
   * Per-line expected amount, for bases that need more than the code to decide.
   *
   * A contracted rate depends on payer, code, modifier AND date of service, none
   * of which fit in a code-keyed map. Returning undefined means "no rate applies
   * to this line", which is different from "the rate is zero" and must not
   * become a finding.
   */
  expectedFor?: (line: PaidLine) => { expected: number; note: string } | undefined;
}

export function detectVariance(lines: PaidLine[], opts: VarianceOptions): VarianceFinding[] {
  const tolerance = opts.tolerancePct ?? 0.02;
  const minSample = opts.minSample ?? 3;
  const minDollars = opts.minDollars ?? 1;
  const out: VarianceFinding[] = [];

  for (const line of lines) {
    if (line.denied) continue;

    let expected: number | undefined;
    let sourceNote = "";

    if (opts.expectedFor) {
      const resolved = opts.expectedFor(line);
      if (!resolved) continue;
      expected = resolved.expected;
      sourceNote = resolved.note;
    } else if (opts.basis === "fee_schedule") {
      expected = opts.expectedByCode?.get(line.code.toUpperCase());
      sourceNote = "the Medicare fee schedule";
    } else {
      const baseline = opts.baselines?.get(baselineKey(line.payer, line.code));
      // A baseline built from one or two lines is not a rate, it is an anecdote.
      if (!baseline || baseline.n < minSample) continue;
      expected = baseline.median;
      sourceNote = `this payer's own median across ${baseline.n} line(s)`;
    }
    if (expected === undefined || expected <= 0) continue;

    const actual = line.derived.allowedPerUnit;
    const shortfallPerUnit = expected - actual;
    if (shortfallPerUnit <= 0) continue;

    const pctBelow = shortfallPerUnit / expected;
    const shortfall = round2(shortfallPerUnit * line.derived.units);
    if (pctBelow < tolerance || shortfall < minDollars) continue;

    out.push({
      severity: pctBelow >= 0.1 ? "error" : "warning",
      basis: opts.basis,
      payer: line.payer,
      claimId: line.claimId,
      code: line.code,
      expectedPerUnit: round2(expected),
      actualPerUnit: actual,
      units: line.derived.units,
      shortfall,
      pctBelow: round2(pctBelow * 100),
      message: `${line.code} on claim ${line.claimId}: allowed $${actual.toFixed(2)}/unit against $${expected.toFixed(2)} from ${sourceNote} — $${shortfall.toFixed(2)} short across ${line.derived.units} unit(s), ${(pctBelow * 100).toFixed(1)}% below.`,
    });
  }

  return out.sort((a, b) => b.shortfall - a.shortfall);
}

export interface RateDrift {
  payer: string;
  code: string;
  earlierMedian: number;
  laterMedian: number;
  changePct: number;
  earlierN: number;
  laterN: number;
  message: string;
}

/**
 * A payer quietly repricing a code. Splits each payer × code history at its
 * midpoint by remittance date and compares the two medians: a step down that
 * holds is a fee schedule change nobody sent a letter about, and it keeps
 * costing money every time the code is billed until someone notices.
 */
export function detectRateDrift(lines: PaidLine[], opts: { minPerHalf?: number; thresholdPct?: number } = {}): RateDrift[] {
  const minPerHalf = opts.minPerHalf ?? 3;
  const threshold = opts.thresholdPct ?? 0.05;
  const buckets = new Map<string, PaidLine[]>();

  for (const line of lines) {
    if (line.denied || line.derived.allowed <= 0) continue;
    const key = baselineKey(line.payer, line.code);
    buckets.set(key, [...(buckets.get(key) ?? []), line]);
  }

  const out: RateDrift[] = [];
  for (const group of buckets.values()) {
    if (group.length < minPerHalf * 2) continue;
    const ordered = [...group].sort((a, b) => a.receivedAt - b.receivedAt);
    const split = Math.floor(ordered.length / 2);
    const earlier = ordered.slice(0, split);
    const later = ordered.slice(split);
    if (earlier.length < minPerHalf || later.length < minPerHalf) continue;

    const earlierMedian = median(earlier.map((l) => l.derived.allowedPerUnit));
    const laterMedian = median(later.map((l) => l.derived.allowedPerUnit));
    if (earlierMedian <= 0) continue;

    const changePct = (laterMedian - earlierMedian) / earlierMedian;
    if (changePct > -threshold) continue;

    const { payer, code } = ordered[0];
    out.push({
      payer,
      code,
      earlierMedian,
      laterMedian,
      changePct: round2(changePct * 100),
      earlierN: earlier.length,
      laterN: later.length,
      message: `${payer} dropped ${code} from $${earlierMedian.toFixed(2)}/unit to $${laterMedian.toFixed(2)}/unit — ${Math.abs(changePct * 100).toFixed(1)}% lower across ${later.length} more recent line(s) vs ${earlier.length} earlier. Check the fee schedule attached to this contract; a step down that holds is a reprice, not noise.`,
    });
  }
  return out.sort((a, b) => a.changePct - b.changePct);
}

export function renderVariance(findings: VarianceFinding[], opts: { linesExamined: number; basis: VarianceBasis }): string {
  const basisLabel =
    opts.basis === "fee_schedule" ? "the Medicare fee schedule" : "each payer's own established rate";
  if (findings.length === 0) {
    return `No underpayments found against ${basisLabel} across ${opts.linesExamined} adjudicated line(s).`;
  }
  const total = findings.reduce((sum, f) => sum + f.shortfall, 0);
  const byPayer = new Map<string, { count: number; amount: number }>();
  for (const f of findings) {
    const slot = byPayer.get(f.payer) ?? { count: 0, amount: 0 };
    slot.count++;
    slot.amount += f.shortfall;
    byPayer.set(f.payer, slot);
  }

  const lines: string[] = [
    `${findings.length} underpaid line(s) against ${basisLabel}, $${total.toFixed(2)} total, across ${opts.linesExamined} adjudicated line(s).`,
    "",
    "By payer:",
    ...[...byPayer.entries()]
      .sort((a, b) => b[1].amount - a[1].amount)
      .map(([payer, v]) => `  ${payer || "(unknown)"}: ${v.count} line(s), $${v.amount.toFixed(2)}`),
    "",
    "Largest shortfalls:",
    ...findings.slice(0, 20).map((f) => `  [${f.severity.toUpperCase()}] ${f.message}`),
  ];
  if (findings.length > 20) lines.push(`  … and ${findings.length - 20} more.`);
  return lines.join("\n");
}
