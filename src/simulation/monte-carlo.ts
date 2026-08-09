import { mulberry32 } from "../compliance/sentinel.js";
import { paidByDay, samplePaymentDay, type PayerFit, type PracticeModel } from "./model.js";
import { BASELINE, checkScenario, futureAdjustment, type Scenario } from "./scenarios.js";

// ── Monte Carlo cash forecast ────────────────────────────────────────────────
// Two streams of money, simulated separately because they behave nothing alike.
//
// Claims already in the book pay out on the fitted lag curve, conditioned on how
// long they have ALREADY been waiting — a claim ninety days old is not a fresh
// claim, and sampling it as one would have the oldest, most doubtful receivables
// arriving first.
//
// Future work has to be billed before it can be paid, so its cash is the lag
// curve convolved with the billing pace, and a scenario touches only this half.
//
// The variance model matters as much as the mean. Sampling every claim
// independently makes the total collapse to a very narrow band — the central
// limit theorem doing its job on an assumption that is false. Real cash moves in
// blocks: a payer's system goes down for three weeks, a fee schedule changes, a
// credentialing lapse stops one payer entirely. So each path first draws a
// per-payer shock, then draws claims conditioned on it. The bands are still a
// FLOOR on uncertainty, since shocks that hit several payers at once — a
// clearinghouse outage, a bad quarter — are not modelled either.

/** Dispersion of the per-payer, per-path multiplicative shock. */
export const DEFAULT_PAYER_SHOCK_SD = 0.15;
export const DEFAULT_PATHS = 400;
export const DEFAULT_HORIZON_DAYS = 90;

export interface ForecastOptions {
  horizonDays?: number;
  paths?: number;
  seed?: number;
  /** Set to 0 to sample claims independently — narrower bands, and wrong. */
  payerShockSd?: number;
  /** Share of assigned patient responsibility eventually collected, when history cannot say. */
  patientCollectionRate?: number;
  /** Typical days from statement to patient payment, when history cannot say. */
  patientLagDays?: number;
}

export interface ForecastBand {
  day: number;
  p10: number;
  p50: number;
  p90: number;
}

export interface Forecast {
  horizonDays: number;
  paths: number;
  seed: number;
  /** Cumulative insurance cash, by day. */
  insurance: ForecastBand[];
  /** Cumulative patient cash, by day — a separate stream, collected differently. */
  patient: ForecastBand[];
  /** Insurance + patient. */
  total: ForecastBand[];
  fromInFlight: number;
  fromFutureWork: number;
  patientFitted: boolean;
  scenario: Scenario;
  notes: string[];
  warnings: string[];
}

/** Box-Muller, so the shock is a real distribution rather than a coin flip. */
function normal(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * When a claim will pay, given it has already waited `ageDays` without paying.
 *
 * The conditional distribution, not the unconditional one. A claim that has
 * survived ninety days is drawn from what is left of the curve beyond ninety
 * days — treating it as fresh would forecast the oldest receivables as the
 * soonest, which inverts the actual risk.
 */
export function sampleRemainingDays(fit: PayerFit, ageDays: number, u: number): number | null {
  const survivedTo = 1 - paidByDay(fit.lag, ageDays);
  if (survivedTo <= 0) return 0;
  // Rescale the draw into the surviving mass.
  const day = samplePaymentDay(fit.lag, 1 - survivedTo * (1 - u));
  if (day === null) return null;
  return Math.max(0, day - ageDays);
}

function payerFor(model: PracticeModel, name: string): PayerFit | undefined {
  return model.payers.find((p) => p.payer === name);
}

export function forecast(model: PracticeModel, scen: Scenario = BASELINE, options: ForecastOptions = {}): Forecast {
  const horizon = options.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const paths = options.paths ?? DEFAULT_PATHS;
  const seed = options.seed ?? 1;
  const shockSd = options.payerShockSd ?? DEFAULT_PAYER_SHOCK_SD;
  const patientRate = options.patientCollectionRate ?? 0.5;
  const patientLag = options.patientLagDays ?? 45;

  const check = checkScenario(scen, model);
  const notes = [...check.notes];
  const warnings = [...check.problems];

  const insurancePaths: number[][] = [];
  const patientPaths: number[][] = [];
  let inFlightTotal = 0;
  let futureTotal = 0;

  // Charges per payer per day, from the observed mix and pace.
  const totalCharges = model.payers.reduce((s, p) => s + p.charges, 0);
  const dailyByPayer = model.payers.map((p) => ({
    fit: p,
    perDay: totalCharges > 0 ? (model.monthlyCharges / 30) * (p.charges / totalCharges) : 0,
  }));

  for (let path = 0; path < paths; path++) {
    const rand = mulberry32(seed + path * 7919);
    const insurance = new Array<number>(horizon + 1).fill(0);
    const patient = new Array<number>(horizon + 1).fill(0);

    // One shock per payer per path — drawn before any claim, so every claim
    // with that payer moves together.
    const shocks = new Map<string, number>();
    for (const p of model.payers) {
      shocks.set(p.payer, shockSd > 0 ? Math.max(0, 1 + normal(rand) * shockSd) : 1);
    }

    // Money already in the book.
    for (const claim of model.inFlight) {
      const fit = payerFor(model, claim.payer);
      if (!fit) continue;
      const remaining = sampleRemainingDays(fit, claim.ageDays, rand());
      if (remaining === null || remaining > horizon) continue;
      if (rand() < fit.denialRate) continue;
      const shock = shocks.get(claim.payer) ?? 1;
      const collected = claim.charge * fit.collectionRatio * shock;
      const toPatient = collected * fit.patientShare;
      insurance[Math.round(remaining)] += collected - toPatient;
      const patientDay = Math.round(remaining + patientLag);
      if (patientDay <= horizon) patient[patientDay] += toPatient * patientRate;
      if (path === 0) inFlightTotal += collected;
    }

    // Work not yet done. Billed on day d, paid d + lag.
    //
    // One lag is drawn per payer per day rather than per claim, so a day's
    // charges land in a single lump instead of spreading across the curve. The
    // expectation is unchanged and the variance comes out somewhat wider than
    // per-claim sampling would give — which is the safe direction to be wrong
    // in, and consistent with treating the bands as a floor.
    for (let day = 0; day < horizon; day++) {
      for (const { fit, perDay } of dailyByPayer) {
        if (perDay <= 0) continue;
        const adj = futureAdjustment(scen, fit.payer, day);
        const charges = perDay * adj.volume * adj.rate;
        if (charges <= 0) continue;
        const lagDraw = samplePaymentDay(fit.lag, rand());
        if (lagDraw === null) continue;
        const payDay = day + lagDraw;
        if (payDay > horizon) continue;
        const denialRate = Math.min(1, Math.max(0, fit.denialRate + adj.denialRateDelta));
        const shock = shocks.get(fit.payer) ?? 1;
        const collected = charges * fit.collectionRatio * (1 - denialRate) * shock;
        const toPatient = collected * fit.patientShare;
        insurance[Math.round(payDay)] += collected - toPatient;
        const patientDay = Math.round(payDay + patientLag);
        if (patientDay <= horizon) patient[patientDay] += toPatient * patientRate;
        if (path === 0) futureTotal += collected;
      }
    }

    // Cumulative.
    for (let d = 1; d <= horizon; d++) {
      insurance[d] += insurance[d - 1];
      patient[d] += patient[d - 1];
    }
    insurancePaths.push(insurance);
    patientPaths.push(patient);
  }

  const band = (all: number[][]): ForecastBand[] => {
    const out: ForecastBand[] = [];
    for (let d = 0; d <= horizon; d++) {
      const column = all.map((p) => p[d]).sort((a, b) => a - b);
      out.push({ day: d, p10: percentile(column, 0.1), p50: percentile(column, 0.5), p90: percentile(column, 0.9) });
    }
    return out;
  };

  const insurance = band(insurancePaths);
  const patient = band(patientPaths);
  const total: ForecastBand[] = insurance.map((b, i) => ({
    day: b.day,
    p10: b.p10 + patient[i].p10,
    p50: b.p50 + patient[i].p50,
    p90: b.p90 + patient[i].p90,
  }));

  if (shockSd === 0) {
    warnings.push(
      "Payer shocks are switched off, so every claim was sampled independently. The bands below are far narrower than reality — independence is the assumption that makes a forecast look confident and be wrong.",
    );
  }
  warnings.push(
    "The bands cover the variation this model knows about: per-claim timing, denials, and a per-payer shock. They do not cover a clearinghouse outage, a payer taking three weeks off, or a bad quarter across the whole book. Treat them as a floor on uncertainty rather than a range.",
  );
  if (!model.usable) {
    warnings.push("The underlying model was fitted from too little history to be relied on. See the fit warnings.");
  }
  if (model.observedDays > 0 && horizon > model.observedDays) {
    warnings.push(
      `Forecasting ${horizon} days from ${model.observedDays} days of history. Past the length of the history this is extrapolation.`,
    );
  }

  return {
    horizonDays: horizon,
    paths,
    seed,
    insurance,
    patient,
    total,
    fromInFlight: Math.round(inFlightTotal * 100) / 100,
    fromFutureWork: Math.round(futureTotal * 100) / 100,
    patientFitted: model.payers.some((p) => p.patientShare > 0),
    scenario: scen,
    notes,
    warnings,
  };
}

function money(x: number): string {
  return `$${Math.round(x).toLocaleString("en-US")}`;
}

export function renderForecast(f: Forecast): string {
  if (f.warnings.some((w) => w.startsWith("No payer named"))) {
    return f.warnings.join("\n");
  }

  const lines: string[] = [
    `${f.scenario.label}`,
    `${f.horizonDays}-day cash forecast · ${f.paths} simulated paths · seed ${f.seed}`,
    "",
  ];

  const marks = [30, 60, 90, 180, 365].filter((d) => d <= f.horizonDays);
  if (!marks.includes(f.horizonDays)) marks.push(f.horizonDays);

  lines.push("Cumulative cash (P10 / P50 / P90):");
  for (const d of marks) {
    const ins = f.insurance[d];
    const pat = f.patient[d];
    const tot = f.total[d];
    lines.push(
      `  Day ${String(d).padStart(3)}   insurance ${money(ins.p50).padStart(10)}   patient ${money(pat.p50).padStart(9)}   total ${money(tot.p50).padStart(10)}`,
      `             range ${money(tot.p10)} to ${money(tot.p90)}`,
    );
  }

  lines.push(
    "",
    `Of the money in this forecast, ${money(f.fromInFlight)} comes from claims already submitted and ${money(f.fromFutureWork)} from work not yet done.`,
  );

  if (!f.patientFitted) {
    lines.push(
      "",
      "Patient responsibility could not be fitted from the remittances — no patient share appears in them — so the patient line is whatever assumption was passed in, not a measurement. Treat it as a placeholder.",
    );
  } else {
    lines.push(
      "",
      "The patient line is a separate stream on purpose: a dollar assigned to a patient is not a dollar collected, and it arrives much later and incompletely.",
    );
  }

  if (f.notes.length > 0) {
    lines.push("", "About this scenario:");
    for (const n of f.notes) lines.push(`  ${n}`);
  }

  lines.push("", "What this forecast does not cover:");
  for (const w of f.warnings) lines.push(`  ⚠ ${w}`);

  return lines.join("\n");
}

export interface Comparison {
  baseline: Forecast;
  alternative: Forecast;
  deltaAtHorizon: number;
  /** First day the two diverge by more than 1% of baseline — when it starts to bite. */
  divergesAtDay: number | null;
}

export function compare(baseline: Forecast, alternative: Forecast): Comparison {
  const h = Math.min(baseline.horizonDays, alternative.horizonDays);
  let divergesAtDay: number | null = null;
  for (let d = 0; d <= h; d++) {
    const base = baseline.total[d].p50;
    if (base > 0 && Math.abs(alternative.total[d].p50 - base) / base > 0.01) {
      divergesAtDay = d;
      break;
    }
  }
  return {
    baseline,
    alternative,
    deltaAtHorizon: alternative.total[h].p50 - baseline.total[h].p50,
    divergesAtDay,
  };
}

export function renderComparison(c: Comparison): string {
  const h = Math.min(c.baseline.horizonDays, c.alternative.horizonDays);
  const delta = c.deltaAtHorizon;
  const lines = [
    renderForecast(c.alternative),
    "",
    "Against baseline:",
    `  Day ${h}: ${money(c.alternative.total[h].p50)} vs ${money(c.baseline.total[h].p50)} — ${delta >= 0 ? "+" : ""}${money(delta)}`,
  ];
  if (c.divergesAtDay === null) {
    lines.push(
      `  The two never separate by more than 1% inside ${h} days. Whatever this changes, it does not change cash on this horizon — which is worth knowing before deciding on it.`,
    );
  } else {
    lines.push(
      `  They start to separate around day ${c.divergesAtDay}. Before that the two are the same book paying out, which is the lag between making a decision and feeling it.`,
    );
  }
  return lines.join("\n");
}
