import type { PracticeModel } from "./model.js";

// ── What-if ──────────────────────────────────────────────────────────────────
// A scenario changes what the practice DOES from here on. It does not change
// what has already happened, and that distinction is the whole reason these are
// separate functions rather than a multiplier over the forecast.
//
// Drop a payer and their cash does not stop tomorrow — every claim already
// submitted to them is still going to pay out on the fitted curve, over the
// next several months. A model that zeroed them immediately would show a cliff
// that does not exist and would answer the question backwards.
//
// The same asymmetry runs the other way and is the entire point of asking. Hire
// a provider and the charges start on day one, but the cash starts a lag-curve
// later. The ramp IS the lag curve. A practice that plans around the charges
// rather than the ramp runs out of money in month two of a good decision.

export type ScenarioKind =
  | "baseline"
  | "drop_payer"
  | "rate_change"
  | "volume_change"
  | "add_provider"
  | "denial_rate_change";

export interface Scenario {
  kind: ScenarioKind;
  /** drop_payer: which one. Empty elsewhere. */
  payer: string;
  /** rate_change / volume_change / denial_rate_change: e.g. -0.03 for a 3% cut. */
  change: number;
  /** add_provider: share of an average existing provider's output, e.g. 0.6. */
  productivity: number;
  /** add_provider / drop_payer: days from now the change takes effect. */
  startDay: number;
  /** add_provider: days to reach full productivity. A new panel does not fill overnight. */
  rampDays: number;
  label: string;
}

export const BASELINE: Scenario = {
  kind: "baseline",
  payer: "",
  change: 0,
  productivity: 0,
  startDay: 0,
  rampDays: 0,
  label: "Baseline — nothing changes",
};

export function scenario(over: Partial<Scenario> & { kind: ScenarioKind }): Scenario {
  return { ...BASELINE, ...over, label: over.label ?? describeScenario({ ...BASELINE, ...over }) };
}

export function describeScenario(s: Scenario): string {
  const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  switch (s.kind) {
    case "baseline":
      return "Baseline — nothing changes";
    case "drop_payer":
      return `Stop taking ${s.payer}${s.startDay > 0 ? ` from day ${s.startDay}` : ""}`;
    case "rate_change":
      return `Reimbursement ${pct(s.change)}${s.payer ? ` from ${s.payer}` : " across all payers"}`;
    case "volume_change":
      return `Volume ${pct(s.change)}`;
    case "add_provider":
      return `Add a provider at ${(s.productivity * 100).toFixed(0)}% productivity from day ${s.startDay}, ramping over ${s.rampDays} day(s)`;
    case "denial_rate_change":
      return `Denial rate ${pct(s.change)}${s.payer ? ` at ${s.payer}` : ""}`;
  }
}

/** Per-payer multipliers applied to work not yet done, on a given future day. */
export interface FutureAdjustment {
  volume: number;
  rate: number;
  denialRateDelta: number;
}

const NEUTRAL: FutureAdjustment = { volume: 1, rate: 1, denialRateDelta: 0 };

/**
 * What the scenario does to future work for one payer on one day.
 *
 * Everything here is about services not yet rendered. Claims already in the
 * book are never passed through this function.
 */
export function futureAdjustment(s: Scenario, payer: string, day: number): FutureAdjustment {
  if (s.kind === "baseline" || day < s.startDay) return NEUTRAL;
  const matches = !s.payer || s.payer.toLowerCase() === payer.toLowerCase();

  switch (s.kind) {
    case "drop_payer":
      return matches ? { ...NEUTRAL, volume: 0 } : NEUTRAL;
    case "rate_change":
      return matches ? { ...NEUTRAL, rate: Math.max(0, 1 + s.change) } : NEUTRAL;
    case "volume_change":
      return matches ? { ...NEUTRAL, volume: Math.max(0, 1 + s.change) } : NEUTRAL;
    case "denial_rate_change":
      return matches ? { ...NEUTRAL, denialRateDelta: s.change } : NEUTRAL;
    case "add_provider": {
      // Linear ramp to full productivity. The cash ramp is longer than this one
      // by however long the payer takes to pay, which the simulation applies.
      const elapsed = day - s.startDay;
      const fraction = s.rampDays > 0 ? Math.min(1, elapsed / s.rampDays) : 1;
      return { ...NEUTRAL, volume: 1 + s.productivity * fraction };
    }
    default:
      return NEUTRAL;
  }
}

export interface ScenarioCheck {
  ok: boolean;
  problems: string[];
  notes: string[];
}

/** Catch a scenario that cannot mean what it says before it is simulated. */
export function checkScenario(s: Scenario, model: PracticeModel): ScenarioCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  const known = model.payers.map((p) => p.payer);

  if (s.payer && !known.some((p) => p.toLowerCase() === s.payer.toLowerCase())) {
    problems.push(
      `No payer named "${s.payer}" in the history. Known: ${known.join(", ") || "(none)"}. A scenario against a payer with no data would change nothing and read as though it did.`,
    );
  }
  if (s.kind === "add_provider" && s.productivity <= 0) {
    problems.push("A provider at zero productivity is the baseline. Set productivity above 0.");
  }
  if (s.kind === "rate_change" && s.change <= -1) {
    problems.push("A rate change of -100% or worse is not a rate change, it is dropping the payer.");
  }

  if (s.kind === "drop_payer") {
    const affected = model.inFlight.filter((c) => c.payer.toLowerCase() === s.payer.toLowerCase());
    const value = affected.reduce((sum, c) => sum + c.charge, 0);
    if (affected.length > 0) {
      notes.push(
        `${affected.length} ${s.payer} claim(s) worth $${value.toFixed(2)} are already submitted and are NOT cancelled by this scenario — they pay out on the fitted curve over the coming months. What the forecast shows is the point where that tail runs dry, which is the number that matters.`,
      );
    }
  }
  if (s.kind === "add_provider") {
    const median = model.pooled.medianDays;
    if (median !== null) {
      notes.push(
        `Charges start on day ${s.startDay}; cash follows about ${median} day(s) behind, and that gap is the thing to plan around. Full productivity at day ${s.startDay + s.rampDays} means full cash somewhere near day ${s.startDay + s.rampDays + median}.`,
      );
    }
  }
  if ((s.kind === "rate_change" || s.kind === "denial_rate_change") && model.inFlight.length > 0) {
    notes.push(
      `This applies to services not yet rendered. The ${model.inFlight.length} claim(s) already in the book adjudicate under the old terms.`,
    );
  }

  return { ok: problems.length === 0, problems, notes };
}
