import { claimCharge, earliestServiceDate, type StoredClaim, type StoredEra } from "../reports/aggregate.js";
import { deriveAllowed } from "../tools/healthcare/intelligence/variance.js";

// ── Fitting the practice ─────────────────────────────────────────────────────
// Everything a cash forecast needs is already in the two tables the rest of the
// system fills: what was billed and when the service happened, and what came
// back and when. This module turns that history into a model.
//
// The hard part is not the arithmetic, it is a selection effect. Payment lag
// fitted only from claims that HAVE a remittance is fitted only from the claims
// that paid — the slow ones and the never-paid ones are still sitting in AR,
// excluded from the sample, pulling the estimate down. A practice would be told
// it gets paid in twenty-four days when the truth has a long tail, and that
// number is the one somebody makes a payroll decision on.
//
// So unresolved claims are not dropped. They enter the fit as right-censored
// observations and the lag curve is a Kaplan-Meier estimate, which is what
// censoring calls for and which also hands the forecast two things it needs
// directly: the probability a claim has paid by day t, and the plateau the
// curve settles at — the share that is never going to pay at all.

/**
 * Medicare may not issue payment on a clean electronic claim before day 14 from
 * receipt (a 13-day floor), and owes interest from day 31. That is a physical
 * boundary, not a tendency: a fitted Medicare curve with real mass below it is
 * measuring something other than what it thinks — usually a bad claim-to-ERA
 * join, or lag anchored to the wrong date.
 */
export const MEDICARE_ELECTRONIC_FLOOR_DAYS = 14;
export const MEDICARE_PAPER_FLOOR_DAYS = 29;
export const MEDICARE_INTEREST_DAY = 31;

/** Below this many resolved claims, a payer gets no fitted curve of its own. */
export const MIN_RESOLVED_PER_PAYER = 12;
/** Below this, the practice as a whole cannot be forecast at all. */
export const MIN_RESOLVED_CLAIMS = 25;

export const DAY_MS = 86_400_000;

// ── Kaplan-Meier ─────────────────────────────────────────────────────────────

export interface Observation {
  /** Days from the service date to payment, or to today if it has not paid. */
  days: number;
  /** True when the claim has actually been adjudicated. False means still outstanding. */
  resolved: boolean;
}

export interface SurvivalPoint {
  day: number;
  /** Probability a claim is STILL unpaid at this day. */
  survival: number;
  atRisk: number;
  events: number;
}

export interface SurvivalCurve {
  points: SurvivalPoint[];
  observations: number;
  resolved: number;
  censored: number;
  /**
   * Where the curve settles — the share of claims that never pay.
   *
   * This is only meaningful out to the last observed event. Beyond that the
   * estimator has nothing to say, which is why `tailIsOpen` exists.
   */
  neverPaidRate: number;
  /** True when the last observation was censored, so the tail is unresolved. */
  tailIsOpen: boolean;
  medianDays: number | null;
}

/**
 * Kaplan-Meier estimate of "still unpaid at day t".
 *
 * S(t) = ∏ (1 − dᵢ/nᵢ) over payment days up to t, where nᵢ is the number still
 * outstanding just before day i. A censored claim reduces nᵢ for later days
 * without ever contributing an event — which is exactly the accounting that
 * stops an unresolved claim from being silently read as "did not pay" or from
 * being dropped as if it never existed.
 */
export function survivalCurve(observations: Observation[]): SurvivalCurve {
  const sorted = [...observations]
    .filter((o) => Number.isFinite(o.days) && o.days >= 0)
    .sort((a, b) => a.days - b.days);

  const byTime = new Map<number, { events: number; censored: number }>();
  for (const o of sorted) {
    const slot = byTime.get(o.days) ?? { events: 0, censored: 0 };
    if (o.resolved) slot.events++;
    else slot.censored++;
    byTime.set(o.days, slot);
  }

  const points: SurvivalPoint[] = [];
  let atRisk = sorted.length;
  let survival = 1;
  let lastEventDay = -1;

  // Within a day, payments are applied before censorings are removed: a claim
  // censored the same day another paid was still at risk when that payment
  // happened. This is the standard convention and it is not cosmetic — the
  // other order shrinks the denominator and biases the curve downward.
  for (const day of [...byTime.keys()].sort((a, b) => a - b)) {
    const { events, censored } = byTime.get(day)!;
    if (events > 0 && atRisk > 0) {
      survival *= 1 - events / atRisk;
      lastEventDay = day;
      points.push({ day, survival, atRisk, events });
    }
    atRisk -= events + censored;
  }

  const resolved = sorted.filter((o) => o.resolved).length;
  const lastObservation = sorted[sorted.length - 1];
  const median = points.find((p) => p.survival <= 0.5);

  return {
    points,
    observations: sorted.length,
    resolved,
    censored: sorted.length - resolved,
    neverPaidRate: survival,
    tailIsOpen: Boolean(lastObservation && !lastObservation.resolved && lastObservation.days > lastEventDay),
    medianDays: median ? median.day : null,
  };
}

/** Probability a claim has paid by day t. */
export function paidByDay(curve: SurvivalCurve, day: number): number {
  let survival = 1;
  for (const p of curve.points) {
    if (p.day > day) break;
    survival = p.survival;
  }
  return 1 - survival;
}

/**
 * Draw a payment day from the curve.
 *
 * Returns null for a claim that never pays — the mass the curve leaves above
 * its plateau. A sampler that always returned a day would forecast every claim
 * as eventually collected, which is the same optimism censoring produces,
 * arriving by a different route.
 */
export function samplePaymentDay(curve: SurvivalCurve, u: number): number | null {
  const target = 1 - u;
  for (const p of curve.points) {
    if (p.survival <= target) return p.day;
  }
  return null;
}

// ── Fitting the model ────────────────────────────────────────────────────────

export interface PayerFit {
  payer: string;
  claims: number;
  resolved: number;
  charges: number;
  /**
   * Paid ÷ charged across claims that were NOT denied — "when this payer pays,
   * it pays this share of the charge".
   *
   * Deliberately not measured over all resolved claims. Denied claims pay zero,
   * so a ratio including them already has the denial rate baked in, and the
   * simulation — which draws denials separately so a scenario can move them —
   * would then subtract denials twice. At a 25% denial rate that turns a 60%
   * collection ratio into an effective 34%, and the forecast quietly understates
   * cash by a third.
   */
  collectionRatio: number;
  /** Share of resolved claims the payer denied outright. Kept independent of the ratio above. */
  denialRate: number;
  /** Share of the allowed amount pushed to the patient, over claims that paid. */
  patientShare: number;
  lag: SurvivalCurve;
  /** False when this payer fell below the minimum and is using the pooled curve. */
  ownCurve: boolean;
  warnings: string[];
}

export interface InFlightClaim {
  claimId: string;
  payer: string;
  charge: number;
  /** Days already elapsed since the service date. */
  ageDays: number;
}

export interface PracticeModel {
  fittedAt: number;
  totalClaims: number;
  resolvedClaims: number;
  payers: PayerFit[];
  pooled: SurvivalCurve;
  /** Claims already billed and not yet adjudicated — money in flight. */
  inFlight: InFlightClaim[];
  /** Average charges billed per 30 days, over the observed window. */
  monthlyCharges: number;
  observedDays: number;
  warnings: string[];
  usable: boolean;
}

function ymdToMs(ymd: string): number | null {
  if (!/^\d{8}$/.test(ymd)) return null;
  return Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
}

function normalizeClaimId(id: string): string {
  return id.trim().toUpperCase();
}

interface Resolution {
  receivedAt: number;
  charged: number;
  paid: number;
  patientResponsibility: number;
  denied: boolean;
}

/**
 * Index remittances by claim id.
 *
 * The same normalization computeArAging uses, deliberately: if the two disagree
 * about which claims are outstanding, the forecast and the AR report will
 * quietly contradict each other and nobody will know which to believe. The
 * EARLIEST remittance wins — a claim reprocessed months later was still first
 * paid on the original date, and taking the latest would inflate every lag.
 */
export function indexResolutions(eras: StoredEra[]): Map<string, Resolution> {
  const out = new Map<string, Resolution>();
  for (const { era, receivedAt } of eras) {
    for (const claim of era.claims) {
      const key = normalizeClaimId(claim.claimId);
      if (!key) continue;
      const existing = out.get(key);
      if (existing && existing.receivedAt <= receivedAt) continue;
      const lines = claim.lines.filter((l) => l.procedure !== "(claim level)");
      const derived = lines.map(deriveAllowed);
      out.set(key, {
        receivedAt,
        charged: derived.reduce((s, d) => s + d.charged, 0) || claim.charged,
        paid: claim.paid,
        patientResponsibility: claim.patientResponsibility,
        denied: claim.statusCode === "4" || (claim.paid <= 0 && claim.charged > 0),
      });
    }
  }
  return out;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Fit the practice from its own history.
 *
 * Every payer with enough resolved claims gets its own lag curve; the rest fall
 * back to the pooled curve and are told so, because a payer fitted from four
 * claims and one fitted from four hundred should not read the same.
 */
export function fitModel(claims: StoredClaim[], eras: StoredEra[], now: number): PracticeModel {
  const resolutions = indexResolutions(eras);
  const warnings: string[] = [];

  interface Bucket {
    payer: string;
    claims: number;
    resolved: number;
    charges: number;
    /** Charged and paid over NON-DENIED claims only — see PayerFit.collectionRatio. */
    charged: number;
    paid: number;
    patient: number;
    denied: number;
    observations: Observation[];
  }
  const buckets = new Map<string, Bucket>();
  const allObservations: Observation[] = [];
  const inFlight: InFlightClaim[] = [];
  let earliestService = Infinity;
  let latestService = -Infinity;
  let totalCharges = 0;
  let undated = 0;

  for (const stored of claims) {
    const payer = (stored.payer || stored.claim.payer_name || "(unknown)").trim();
    const bucket = buckets.get(payer) ?? {
      payer,
      claims: 0,
      resolved: 0,
      charges: 0,
      charged: 0,
      paid: 0,
      patient: 0,
      denied: 0,
      observations: [],
    };

    const charge = claimCharge(stored.claim);
    const serviceDate = earliestServiceDate(stored.claim);
    const startMs = ymdToMs(serviceDate);
    if (startMs === null) undated++;
    const anchor = startMs ?? stored.createdAt;
    earliestService = Math.min(earliestService, anchor);
    latestService = Math.max(latestService, anchor);
    totalCharges += charge;

    bucket.claims++;
    bucket.charges += charge;

    const resolution = resolutions.get(normalizeClaimId(stored.claimId));
    if (resolution) {
      const days = Math.max(0, Math.round((resolution.receivedAt - anchor) / DAY_MS));
      const observation = { days, resolved: true };
      bucket.observations.push(observation);
      allObservations.push(observation);
      bucket.resolved++;
      if (resolution.denied) {
        bucket.denied++;
      } else {
        bucket.charged += resolution.charged;
        bucket.paid += resolution.paid;
        bucket.patient += resolution.patientResponsibility;
      }
    } else {
      // Still outstanding: censored at however long it has been waiting.
      const days = Math.max(0, Math.round((now - anchor) / DAY_MS));
      const observation = { days, resolved: false };
      bucket.observations.push(observation);
      allObservations.push(observation);
      inFlight.push({ claimId: stored.claimId, payer, charge, ageDays: days });
    }

    buckets.set(payer, bucket);
  }

  const pooled = survivalCurve(allObservations);
  const payers: PayerFit[] = [];

  for (const bucket of buckets.values()) {
    const payerWarnings: string[] = [];
    const ownCurve = bucket.resolved >= MIN_RESOLVED_PER_PAYER;
    const lag = ownCurve ? survivalCurve(bucket.observations) : pooled;
    if (!ownCurve) {
      payerWarnings.push(
        `Only ${bucket.resolved} resolved claim(s) — too few for its own timing, so the practice-wide curve is used. Anything this forecast says about ${bucket.payer} specifically is the average, not this payer.`,
      );
    }
    if (/medicare/i.test(bucket.payer) && ownCurve) {
      const early = paidByDay(lag, MEDICARE_ELECTRONIC_FLOOR_DAYS - 1);
      if (early > 0.05) {
        payerWarnings.push(
          `${(early * 100).toFixed(0)}% of this payer's claims appear to pay before day ${MEDICARE_ELECTRONIC_FLOOR_DAYS}, which Medicare cannot do — a clean electronic claim sits on a 13-day payment floor. The lag is almost certainly anchored to the wrong date or the claim-to-remittance join is matching the wrong rows. Treat this curve as broken rather than fast.`,
        );
      }
    }
    if (bucket.resolved > bucket.denied && bucket.charged === 0) {
      payerWarnings.push("Remittances carry no charged amounts, so the collection ratio could not be fitted.");
    }
    if (bucket.resolved > 0 && bucket.denied === bucket.resolved) {
      payerWarnings.push(
        "Every resolved claim from this payer was denied, so there is no collection ratio to fit — the forecast will show nothing arriving from them, which is what the history says.",
      );
    }

    payers.push({
      payer: bucket.payer,
      claims: bucket.claims,
      resolved: bucket.resolved,
      charges: Math.round(bucket.charges * 100) / 100,
      collectionRatio: ratio(bucket.paid, bucket.charged),
      denialRate: ratio(bucket.denied, bucket.resolved),
      patientShare: ratio(bucket.patient, bucket.paid + bucket.patient),
      lag,
      ownCurve,
      warnings: payerWarnings,
    });
  }

  payers.sort((a, b) => b.charges - a.charges);

  const observedDays =
    Number.isFinite(earliestService) && Number.isFinite(latestService)
      ? Math.max(1, Math.round((latestService - earliestService) / DAY_MS) + 1)
      : 0;
  const monthlyCharges = observedDays > 0 ? (totalCharges / observedDays) * 30 : 0;

  const resolvedClaims = allObservations.filter((o) => o.resolved).length;
  if (resolvedClaims < MIN_RESOLVED_CLAIMS) {
    warnings.push(
      `Only ${resolvedClaims} claim(s) have been adjudicated. Below ${MIN_RESOLVED_CLAIMS} there is not enough history to fit timing, and a forecast built on it would be a shape drawn through noise.`,
    );
  }
  if (undated > 0) {
    warnings.push(
      `${undated} claim(s) had no usable service date and were anchored to when the claim was recorded instead. Their lag is measured from the wrong point.`,
    );
  }
  if (pooled.tailIsOpen) {
    warnings.push(
      `The oldest unpaid claim has been outstanding longer than anything that has ever paid, so the far tail of the timing curve is unknown. The never-collected share below (${(pooled.neverPaidRate * 100).toFixed(1)}%) is a lower bound.`,
    );
  }
  if (observedDays > 0 && observedDays < 90) {
    warnings.push(
      `History spans ${observedDays} day(s). A forecast reaching further out than the data behind it is extrapolation.`,
    );
  }

  return {
    fittedAt: now,
    totalClaims: claims.length,
    resolvedClaims,
    payers,
    pooled,
    inFlight,
    monthlyCharges: Math.round(monthlyCharges * 100) / 100,
    observedDays,
    warnings,
    usable: resolvedClaims >= MIN_RESOLVED_CLAIMS,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function money(x: number): string {
  return `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function renderModel(model: PracticeModel): string {
  const lines: string[] = [
    `Fitted from ${model.totalClaims} claim(s), ${model.resolvedClaims} adjudicated, over ${model.observedDays} day(s) of service dates.`,
    `Outstanding: ${model.inFlight.length} claim(s), ${money(model.inFlight.reduce((s, c) => s + c.charge, 0))} billed and not yet adjudicated.`,
    `Billing pace: ${money(model.monthlyCharges)} per 30 days.`,
    "",
    `Practice-wide timing — median ${model.pooled.medianDays ?? "not reached"} day(s) to payment, ${pct(model.pooled.neverPaidRate)} never collected.`,
    `  Fitted from ${model.pooled.observations} claim(s): ${model.pooled.resolved} paid, ${model.pooled.censored} still outstanding and carried as censored rather than dropped, which is what keeps the curve from reading faster than reality.`,
  ];

  if (model.payers.length > 0) {
    lines.push("", "By payer:");
    for (const p of model.payers) {
      lines.push(
        "",
        `  ${p.payer} — ${p.claims} claim(s), ${money(p.charges)} billed`,
        `    collects ${pct(p.collectionRatio)} of charges · denies ${pct(p.denialRate)} · ${pct(p.patientShare)} of collected dollars land on the patient`,
        `    median ${p.lag.medianDays ?? "not reached"} day(s)${p.ownCurve ? "" : " (practice-wide curve — see below)"}`,
      );
      for (const w of p.warnings) lines.push(`    ⚠ ${w}`);
    }
  }

  if (model.warnings.length > 0) {
    lines.push("", "What this model does not know:");
    for (const w of model.warnings) lines.push(`  ⚠ ${w}`);
  }

  if (!model.usable) {
    lines.push("", "Not enough history to forecast from. Fit again once more remittances have been parsed.");
  }

  return lines.join("\n");
}
