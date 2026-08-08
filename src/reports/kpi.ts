import { claimCharge, computeArAging, earliestServiceDate, type StoredClaim, type StoredEra } from "./aggregate.js";

// ── Executive KPIs ───────────────────────────────────────────────────────────
// Days in AR, first-pass clean claim rate, net collection rate. Every one of
// them is easy to compute and easy to compute in a way that flatters the
// practice, and all three lie in the same direction if you are careless.
//
// The single largest error is measuring an unfinished period. A claim submitted
// three weeks ago has not finished paying, so a net collection rate over "the
// last 30 days" counts its charges in the denominator and almost none of its
// payments in the numerator. The number comes out catastrophic, somebody
// explains it away, and the metric stops being watched. The fix is a LAG: NCR is
// measured over claims old enough to have resolved, and this module refuses to
// compute it over a window that is still open rather than producing a figure
// that will be dismissed.
//
// The second error is conflating two different things both called "clean claim
// rate": whether the clearinghouse ACCEPTED the claim, and whether the payer PAID
// it without a denial. A practice can have 98% acceptance and 70% first-pass
// payment. They are reported separately here, because a single blended number
// hides which half of the process is broken.

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function ymdToMs(ymd: string): number | null {
  if (!/^\d{8}$/.test(ymd)) return null;
  return Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
}

/** MGMA and HFMA both compute daily charges over the trailing quarter. */
export const DAR_CHARGE_WINDOW_DAYS = 90;

/**
 * Days a claim needs before its outcome is settled.
 *
 * Medicare may not pay a clean electronic claim before day 14 and owes interest
 * from day 31; commercial prompt-pay statutes cluster at 30–45 days; an appeal
 * of a first denial routinely takes another 60. 120 days is where the great
 * majority of a cohort has stopped moving, and measuring anything newer counts
 * charges whose payments have not arrived yet.
 */
export const NCR_SETTLE_DAYS = 120;

/** Below this the numbers are noise; naming the floor is better than printing a percentage nobody should read. */
export const MIN_CLAIMS_FOR_RATE = 20;

export interface DaysInAr {
  /** Null when there is not enough charge history to divide by. */
  days: number | null;
  totalAr: number;
  averageDailyCharges: number;
  chargeWindowDays: number;
  /** Days of history actually present, which may be shorter than the window. */
  historyDays: number;
  note: string;
}

/**
 * Days in AR = total outstanding ÷ average daily gross charges.
 *
 * The denominator is where this goes wrong. Averaging daily charges over the
 * whole history flatters a growing practice (old quiet months drag the average
 * down, so AR looks like fewer days) and punishes a shrinking one. It is
 * computed over the trailing quarter, and if less than a quarter of history
 * exists the actual span is used and SAID, because dividing 40 days of charges
 * by 90 understates daily volume by more than half and would roughly double the
 * reported days in AR.
 */
export function computeDaysInAr(claims: StoredClaim[], eras: StoredEra[], now: number): DaysInAr {
  const aging = computeArAging(claims, eras, now);
  const windowStart = now - DAR_CHARGE_WINDOW_DAYS * 86_400_000;

  let charges = 0;
  let earliest = now;
  for (const stored of claims) {
    const ms = ymdToMs(earliestServiceDate(stored.claim)) ?? stored.createdAt;
    earliest = Math.min(earliest, ms);
    // Half-open: (windowStart, now]. An inclusive lower bound would admit 91
    // days of service dates while still dividing by 90, overstating daily
    // charges by about a percent and understating days in AR by the same.
    if (ms > windowStart && ms <= now) charges += claimCharge(stored.claim);
  }

  const historyDays = Math.max(1, Math.floor((now - earliest) / 86_400_000));
  const divisor = Math.min(DAR_CHARGE_WINDOW_DAYS, historyDays);
  const averageDailyCharges = round2(charges / divisor);

  if (averageDailyCharges <= 0) {
    return {
      days: null,
      totalAr: aging.total,
      averageDailyCharges: 0,
      chargeWindowDays: divisor,
      historyDays,
      note: "No charges in the measurement window, so there is nothing to divide by. Days in AR is undefined rather than zero — zero would read as 'we collect instantly'.",
    };
  }

  return {
    days: Math.round(aging.total / averageDailyCharges),
    totalAr: aging.total,
    averageDailyCharges,
    chargeWindowDays: divisor,
    historyDays,
    note:
      divisor < DAR_CHARGE_WINDOW_DAYS
        ? `Daily charges averaged over ${divisor} days, the whole history available, rather than the standard ${DAR_CHARGE_WINDOW_DAYS}. Comparisons to a published benchmark are not like-for-like until there is a full quarter.`
        : `Daily charges averaged over the trailing ${DAR_CHARGE_WINDOW_DAYS} days, which is what MGMA and HFMA benchmarks use.`,
  };
}

export interface CleanClaimRate {
  /** Accepted by the clearinghouse/payer front end on first submission. */
  acceptanceRate: number | null;
  acceptedFirstPass: number;
  acknowledged: number;
  /** Adjudicated and paid with no denial adjustment on any line. */
  firstPassPaymentRate: number | null;
  paidFirstPass: number;
  adjudicated: number;
  note: string;
}

export interface AckRecord {
  claimId: string;
  accepted: boolean;
}

/**
 * Two rates, kept apart on purpose.
 *
 * Acceptance is a front-end measure — did the claim get past the clearinghouse
 * edits. First-pass payment is a back-end one — did the payer adjudicate it
 * without a denial. Both are legitimately called "clean claim rate" in the
 * industry, they answer different questions, and a practice with 98% acceptance
 * and 70% first-pass payment has a coding problem that a blended number hides
 * completely.
 */
export function computeCleanClaimRate(acks: AckRecord[], eras: StoredEra[]): CleanClaimRate {
  // First submission only: a claim resubmitted after a rejection must not count
  // its later acceptance as first-pass, or fixing rejections raises the rate.
  const firstAck = new Map<string, boolean>();
  for (const ack of acks) {
    const key = ack.claimId.trim().toUpperCase();
    if (!firstAck.has(key)) firstAck.set(key, ack.accepted);
  }
  const acknowledged = firstAck.size;
  const acceptedFirstPass = [...firstAck.values()].filter(Boolean).length;

  const firstEra = new Map<string, boolean>();
  for (const { era } of eras) {
    for (const claim of era.claims) {
      const key = claim.claimId.trim().toUpperCase();
      if (firstEra.has(key)) continue;
      if (claim.statusCode === "22") continue; // a reversal is not an adjudication
      // Denied outright, or paid with any denial adjustment on a line. CO/PR
      // contractual and patient-responsibility amounts are normal on a clean
      // claim; what disqualifies it is being denied.
      const denied = claim.statusCode === "4" || claim.paid <= 0;
      firstEra.set(key, !denied);
    }
  }
  const adjudicated = firstEra.size;
  const paidFirstPass = [...firstEra.values()].filter(Boolean).length;

  const rate = (n: number, d: number) => (d >= MIN_CLAIMS_FOR_RATE ? round2((n / d) * 100) : null);
  const notes: string[] = [];
  if (acknowledged > 0 && acknowledged < MIN_CLAIMS_FOR_RATE) {
    notes.push(`Only ${acknowledged} acknowledged claim(s) — below ${MIN_CLAIMS_FOR_RATE} a percentage is noise, so none is shown.`);
  }
  if (adjudicated > 0 && adjudicated < MIN_CLAIMS_FOR_RATE) {
    notes.push(`Only ${adjudicated} adjudicated claim(s) — same reason.`);
  }
  if (acknowledged === 0) {
    notes.push("No 277CA acknowledgments recorded, so front-end acceptance cannot be measured. Parse them with ack_parse_277ca as they arrive.");
  }

  return {
    acceptanceRate: rate(acceptedFirstPass, acknowledged),
    acceptedFirstPass,
    acknowledged,
    firstPassPaymentRate: rate(paidFirstPass, adjudicated),
    paidFirstPass,
    adjudicated,
    note: notes.join(" "),
  };
}

export interface NetCollectionRate {
  rate: number | null;
  payments: number;
  charges: number;
  contractualAdjustments: number;
  /** Charges minus contractual adjustments — what was actually collectable. */
  collectable: number;
  claimsMeasured: number;
  cohortEndsAt: number;
  note: string;
}

/**
 * Net collection rate over a SETTLED cohort.
 *
 * NCR = payments ÷ (charges − contractual adjustments). The denominator is what
 * the practice was ever entitled to collect: a contractual write-off was never
 * collectable, so counting it as a miss measures the contract rather than the
 * billing operation.
 *
 * The cohort ends `NCR_SETTLE_DAYS` before now. Including recent claims counts
 * their charges while their payments are still in flight, which drags the rate
 * down for reasons that have nothing to do with performance — the classic way
 * this metric gets computed once, disbelieved, and abandoned.
 */
export function computeNetCollectionRate(
  claims: StoredClaim[],
  eras: StoredEra[],
  now: number,
  settleDays = NCR_SETTLE_DAYS,
): NetCollectionRate {
  const cohortEndsAt = now - settleDays * 86_400_000;

  const settledClaimIds = new Set<string>();
  for (const stored of claims) {
    const ms = ymdToMs(earliestServiceDate(stored.claim)) ?? stored.createdAt;
    if (ms <= cohortEndsAt) settledClaimIds.add(stored.claimId.trim().toUpperCase());
  }

  let payments = 0;
  let charges = 0;
  let contractual = 0;
  let claimsMeasured = 0;
  const seen = new Set<string>();

  for (const { era } of eras) {
    for (const claim of era.claims) {
      const key = claim.claimId.trim().toUpperCase();
      if (!settledClaimIds.has(key) || seen.has(key)) continue;
      if (claim.statusCode === "22") continue;
      seen.add(key);
      claimsMeasured++;
      payments += claim.paid;
      charges += claim.charged;
      for (const line of claim.lines) {
        for (const adj of line.adjustments) {
          // CO is the contractual obligation — the amount the contract says was
          // never collectable. PR is the patient's balance, which IS collectable
          // and must stay in the denominator; treating it as a write-off is how
          // a practice with a large patient-responsibility book reports a
          // flattering NCR while never chasing a patient balance.
          if (adj.group === "CO") contractual += adj.amount;
        }
      }
    }
  }

  const collectable = round2(charges - contractual);
  if (claimsMeasured < MIN_CLAIMS_FOR_RATE || collectable <= 0) {
    return {
      rate: null,
      payments: round2(payments),
      charges: round2(charges),
      contractualAdjustments: round2(contractual),
      collectable,
      claimsMeasured,
      cohortEndsAt,
      note:
        claimsMeasured === 0
          ? `No claims with a date of service on or before ${new Date(cohortEndsAt).toISOString().slice(0, 10)} have a remittance. Net collection rate is deliberately not computed over recent claims — their charges are in, their payments are not, and the result would be meaninglessly low.`
          : `Only ${claimsMeasured} settled claim(s) in the cohort, below the ${MIN_CLAIMS_FOR_RATE} needed for the percentage to mean anything.`,
    };
  }

  return {
    rate: round2((payments / collectable) * 100),
    payments: round2(payments),
    charges: round2(charges),
    contractualAdjustments: round2(contractual),
    collectable,
    claimsMeasured,
    cohortEndsAt,
    note: `Measured over ${claimsMeasured} claim(s) with a date of service on or before ${new Date(cohortEndsAt).toISOString().slice(0, 10)} — old enough to have finished paying. Patient responsibility stays in the denominator: it is collectable, and excluding it would report a flattering rate for a practice that never chases a patient balance.`,
  };
}

export interface KpiSet {
  daysInAr: DaysInAr;
  cleanClaim: CleanClaimRate;
  netCollection: NetCollectionRate;
}

export function computeExecutiveKpis(claims: StoredClaim[], eras: StoredEra[], acks: AckRecord[], now: number): KpiSet {
  return {
    daysInAr: computeDaysInAr(claims, eras, now),
    cleanClaim: computeCleanClaimRate(acks, eras),
    netCollection: computeNetCollectionRate(claims, eras, now),
  };
}

function pct(n: number | null): string {
  return n === null ? "not computable" : `${n.toFixed(1)}%`;
}

export function renderKpis(kpis: KpiSet): string {
  const { daysInAr, cleanClaim, netCollection } = kpis;
  const lines: string[] = ["Executive KPIs", ""];

  lines.push(
    "DAYS IN A/R",
    `  ${daysInAr.days === null ? "not computable" : `${daysInAr.days} days`}  ($${daysInAr.totalAr.toFixed(2)} outstanding ÷ $${daysInAr.averageDailyCharges.toFixed(2)}/day)`,
    `  ${daysInAr.note}`,
    "",
    "CLEAN CLAIM RATE — two separate rates, because they fail for different reasons",
    `  Front-end acceptance:  ${pct(cleanClaim.acceptanceRate)}  (${cleanClaim.acceptedFirstPass} of ${cleanClaim.acknowledged} accepted on first submission)`,
    `  First-pass payment:    ${pct(cleanClaim.firstPassPaymentRate)}  (${cleanClaim.paidFirstPass} of ${cleanClaim.adjudicated} adjudicated without a denial)`,
    "  High acceptance with low first-pass payment is a coding problem; the reverse is a data-entry or enrollment problem. A single blended number hides which.",
  );
  if (cleanClaim.note) lines.push(`  ${cleanClaim.note}`);

  lines.push(
    "",
    "NET COLLECTION RATE",
    `  ${pct(netCollection.rate)}  ($${netCollection.payments.toFixed(2)} collected of $${netCollection.collectable.toFixed(2)} collectable)`,
    `  Charges $${netCollection.charges.toFixed(2)} − contractual $${netCollection.contractualAdjustments.toFixed(2)} = collectable $${netCollection.collectable.toFixed(2)}`,
    `  ${netCollection.note}`,
  );

  return lines.join("\n");
}
