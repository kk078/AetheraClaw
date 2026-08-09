import { CARC } from "../tools/healthcare/denial-codes.js";
import type { Era } from "../tools/healthcare/x12/835.js";

// ── Payer policy drift ───────────────────────────────────────────────────────
// A payer rarely announces that it has tightened an edit. What a practice sees
// is a denial rate that was 4% last quarter and is 11% this quarter for one
// code with one payer, and by the time anyone notices, a month of claims has
// gone out under the old assumption.
//
// The naive version of this tool — "alert on a spike in CARC 96" — produces
// alerts nobody trusts, for a reason worth stating plainly: with small
// denominators, ordinary variation looks exactly like a policy change. Three
// denials out of ten last month and eight out of twenty this month is not a
// doubling; it is noise. An alerting tool that cries wolf gets muted, and then
// the real change goes unnoticed too.
//
// So the test is a two-proportion comparison with a minimum denominator on both
// sides, and the output reports the denominators alongside the rates so a human
// can see what the number rests on.

export interface DenialObservation {
  payer: string;
  carc: string;
  denied: boolean;
  at: number;
}

/** Below this in either period, a rate is not a rate. */
export const MIN_PER_PERIOD = 25;

/** Report a change only when it is at least this many percentage points. */
export const MIN_POINT_CHANGE = 5;

export interface DriftFinding {
  payer: string;
  carc: string;
  carcDesc: string;
  beforeRate: number;
  afterRate: number;
  beforeN: number;
  afterN: number;
  pointChange: number;
  /** Standard-error based. Not a p-value — a plain-language confidence band. */
  significant: boolean;
  message: string;
}

/**
 * The boundary between "before" and "after".
 *
 * The MEDIAN observation time, so the two periods carry roughly equal
 * denominators — which is what gives the comparison its statistical power, and
 * is the same choice fee_schedule_drift makes. The consequence worth knowing:
 * this is not a fixed calendar split. If claim volume tripled, the boundary
 * moves later in wall-clock time, so "before" is the older HALF of the
 * observations rather than the older half of the year. That is the right trade
 * for detecting a change, and the wrong one for answering "what happened in
 * Q1" — which is a different question this tool does not claim to answer.
 */
export function splitAt(observations: DenialObservation[]): number {
  if (observations.length === 0) return 0;
  const times = observations.map((o) => o.at).sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

/**
 * Two-proportion z-test, without dressing it up as more than it is.
 *
 * |z| >= 2 is roughly a 95% two-sided band. This is not a hypothesis test
 * anybody should publish; it is the difference between "the rate moved" and
 * "the rate moved by more than the sample can explain", which is the only
 * question this tool needs to answer before it interrupts someone.
 */
export function proportionsDiffer(x1: number, n1: number, x2: number, n2: number): boolean {
  if (n1 === 0 || n2 === 0) return false;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return false;
  return Math.abs((p2 - p1) / se) >= 2;
}

export interface DriftResult {
  findings: DriftFinding[];
  /** Payer/CARC pairs skipped for want of a denominator, so silence is explained. */
  skippedThin: number;
  observations: number;
  splitAt: number;
}

export function detectPolicyDrift(observations: DenialObservation[]): DriftResult {
  const split = splitAt(observations);
  const buckets = new Map<string, { beforeN: number; beforeX: number; afterN: number; afterX: number }>();

  for (const o of observations) {
    const key = `${o.payer}|${o.carc}`;
    const slot = buckets.get(key) ?? { beforeN: 0, beforeX: 0, afterN: 0, afterX: 0 };
    if (o.at < split) {
      slot.beforeN++;
      if (o.denied) slot.beforeX++;
    } else {
      slot.afterN++;
      if (o.denied) slot.afterX++;
    }
    buckets.set(key, slot);
  }

  const findings: DriftFinding[] = [];
  let skippedThin = 0;

  for (const [key, b] of buckets) {
    const [payer, carc] = key.split("|");
    if (b.beforeN < MIN_PER_PERIOD || b.afterN < MIN_PER_PERIOD) {
      skippedThin++;
      continue;
    }
    const beforeRate = (b.beforeX / b.beforeN) * 100;
    const afterRate = (b.afterX / b.afterN) * 100;
    const pointChange = afterRate - beforeRate;
    if (Math.abs(pointChange) < MIN_POINT_CHANGE) continue;
    if (!proportionsDiffer(b.beforeX, b.beforeN, b.afterX, b.afterN)) continue;

    const desc = CARC[carc]?.desc ?? "reason code not in the bundled dataset";
    findings.push({
      payer,
      carc,
      carcDesc: desc,
      beforeRate: Math.round(beforeRate * 10) / 10,
      afterRate: Math.round(afterRate * 10) / 10,
      beforeN: b.beforeN,
      afterN: b.afterN,
      pointChange: Math.round(pointChange * 10) / 10,
      significant: true,
      message: `${payer} CARC ${carc} (${desc}): ${beforeRate.toFixed(1)}% → ${afterRate.toFixed(1)}% (${pointChange > 0 ? "+" : ""}${pointChange.toFixed(1)} points) across ${b.beforeN} then ${b.afterN} adjudicated line(s).`,
    });
  }

  return {
    findings: findings.sort((a, b) => Math.abs(b.pointChange) - Math.abs(a.pointChange)),
    skippedThin,
    observations: observations.length,
    splitAt: split,
  };
}

export function collectDenialObservations(eras: Array<{ era: Era; receivedAt: number }>): DenialObservation[] {
  const out: DenialObservation[] = [];
  for (const { era, receivedAt } of eras) {
    for (const claim of era.claims) {
      if (claim.statusCode === "22") continue; // a reversal is not an adjudication
      // Every CARC seen anywhere on the claim is one observation for that code;
      // the denominator is every claim adjudicated by this payer, so a code that
      // stops appearing shows as a falling rate rather than as silence.
      const carcs = new Set<string>();
      for (const line of claim.lines) for (const adj of line.adjustments) carcs.add(adj.carc);
      for (const carc of carcs) out.push({ payer: era.payer, carc, denied: true, at: receivedAt });
    }
  }
  return out;
}

/**
 * Denominators for every payer/CARC pair over the whole window.
 *
 * Without this, a code that appeared on 40 claims out of 40 and then on 40 out
 * of 800 would look unchanged — the count is flat and the RATE collapsed. The
 * denominator is what makes it a rate rather than a tally.
 */
export function withDenominators(
  eras: Array<{ era: Era; receivedAt: number }>,
): DenialObservation[] {
  const observations: DenialObservation[] = [];
  const codesByPayer = new Map<string, Set<string>>();

  for (const { era } of eras) {
    const set = codesByPayer.get(era.payer) ?? new Set<string>();
    for (const claim of era.claims) {
      for (const line of claim.lines) for (const adj of line.adjustments) set.add(adj.carc);
    }
    codesByPayer.set(era.payer, set);
  }

  for (const { era, receivedAt } of eras) {
    const codes = codesByPayer.get(era.payer) ?? new Set<string>();
    for (const claim of era.claims) {
      if (claim.statusCode === "22") continue;
      const present = new Set<string>();
      for (const line of claim.lines) for (const adj of line.adjustments) present.add(adj.carc);
      for (const carc of codes) {
        observations.push({ payer: era.payer, carc, denied: present.has(carc), at: receivedAt });
      }
    }
  }
  return observations;
}

export function renderDrift(result: DriftResult): string {
  if (result.observations === 0) {
    return "No remittance history, so drift cannot be measured. This tool compares a payer's recent behaviour against its own earlier behaviour — parse 835 files with era_parse_835 first.";
  }

  const lines: string[] = [];
  if (result.findings.length === 0) {
    lines.push(
      `No payer/CARC pair changed by ${MIN_POINT_CHANGE}+ points beyond what the sample explains, across ${result.observations} observation(s).`,
    );
  } else {
    lines.push(
      `${result.findings.length} payer/CARC pair(s) moved measurably. Split at ${new Date(result.splitAt).toISOString().slice(0, 10)}; the first half is the baseline.`,
      "",
      ...result.findings.map((f) => `  ${f.message}`),
      "",
      "A sustained move in one code with one payer is the shape a silent policy change makes. Confirm against the payer's bulletins before rebuilding claims around it — this measures behaviour, and behaviour also moves when your own coding changes.",
    );
  }

  if (result.skippedThin > 0) {
    lines.push(
      "",
      `${result.skippedThin} pair(s) had fewer than ${MIN_PER_PERIOD} adjudicated lines in one of the two periods and were not tested. With denominators that small, ordinary variation is indistinguishable from a policy change, and an alert nobody trusts gets muted — which is how the real change goes unnoticed too.`,
    );
  }
  return lines.join("\n");
}
