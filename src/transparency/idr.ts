import { addBusinessDays } from "../tools/healthcare/operations/gfe.js";

// ── No Surprises Act dispute resolution ──────────────────────────────────────
// Federal IDR is baseball arbitration: each side submits one offer and the
// arbitrator picks one of them outright. There is no splitting the difference,
// which changes what a good offer is. The number to submit is the highest one
// you can fully justify, not the highest one you want — an aggressive offer
// beside a defensible one loses the whole dispute rather than landing halfway.
//
// And the loser pays the arbitrator. That makes IDR an economic decision before
// it is a clinical or legal one, and for a single modest claim the arithmetic
// usually says do not bother. Batching is what changes the answer: up to fifty
// line items can share one determination and one fee.

/** Open negotiation runs 30 business days before IDR can be initiated at all. */
export const OPEN_NEGOTIATION_BUSINESS_DAYS = 30;
/**
 * The non-initiating party must respond through the federal portal by the 15th
 * business day of that window — added by the June 2026 operations rule, and easy
 * to miss because nothing in the old process required a response at all.
 */
export const OPEN_NEGOTIATION_RESPONSE_BUSINESS_DAY = 15;
/** Initiation window: 4 business days beginning on the 31st business day. */
export const INITIATION_WINDOW_BUSINESS_DAYS = 4;
/** After a determination, 90 calendar days before the same parties can dispute the same service again. */
export const COOLING_OFF_CALENDAR_DAYS = 90;
/** When open negotiation ends inside a cooling-off period, initiation gets 30 business days after it lifts. */
export const POST_COOLING_OFF_WINDOW_BUSINESS_DAYS = 30;

/**
 * Administrative fee per party. Reduced from $115 to $15 by the June 2026
 * operations rule, effective for disputes initiated on or after 11 June 2026.
 *
 * The drop matters more than it looks: it was a real deterrent on small
 * disputes and is now close to a rounding error, which moves the decision
 * entirely onto the arbitrator's fee below.
 */
export const ADMIN_FEE_CENTS = 1_500;
export const ADMIN_FEE_BEFORE_JUNE_2026_CENTS = 11_500;
export const ADMIN_FEE_CHANGE_DATE = "20260611";

/** Certified IDR entity fee ranges for disputes initiated in 2026. Loser pays. */
export const IDRE_FEE_SINGLE_CENTS = { min: 20_000, max: 84_000 };
export const IDRE_FEE_BATCHED_CENTS = { min: 26_800, max: 117_300 };

/** A batch may carry at most this many line items. */
export const MAX_BATCH_LINE_ITEMS = 50;

export function adminFeeCents(initiatedOn: string): number {
  return initiatedOn >= ADMIN_FEE_CHANGE_DATE ? ADMIN_FEE_CENTS : ADMIN_FEE_BEFORE_JUNE_2026_CENTS;
}

export interface IdrDeadlines {
  openNegotiationStart: string;
  /** The portal response the non-initiating party owes. */
  responseDue: string;
  openNegotiationEnds: string;
  initiationOpens: string;
  initiationCloses: string;
  coolingOff: boolean;
  notes: string[];
}

/**
 * The dates.
 *
 * All in business days, which is where these get missed — a 30-business-day
 * window is six calendar weeks, and a diary entry set 30 calendar days out
 * closes the door two weeks early.
 */
export function idrDeadlines(
  initialPaymentOrDenial: string,
  options: { holidays?: string[]; priorDeterminationOn?: string } = {},
): IdrDeadlines {
  const holidays = options.holidays ?? [];
  const notes: string[] = [];

  const responseDue = addBusinessDays(initialPaymentOrDenial, OPEN_NEGOTIATION_RESPONSE_BUSINESS_DAY, holidays);
  const openNegotiationEnds = addBusinessDays(initialPaymentOrDenial, OPEN_NEGOTIATION_BUSINESS_DAYS, holidays);

  let initiationOpens = addBusinessDays(initialPaymentOrDenial, OPEN_NEGOTIATION_BUSINESS_DAYS + 1, holidays);
  let initiationCloses = addBusinessDays(initiationOpens, INITIATION_WINDOW_BUSINESS_DAYS - 1, holidays);
  let coolingOff = false;

  if (options.priorDeterminationOn) {
    const suspensionEnds = addCalendarDays(options.priorDeterminationOn, COOLING_OFF_CALENDAR_DAYS);
    if (openNegotiationEnds <= suspensionEnds) {
      coolingOff = true;
      initiationOpens = addCalendarDays(suspensionEnds, 1);
      initiationCloses = addBusinessDays(initiationOpens, POST_COOLING_OFF_WINDOW_BUSINESS_DAYS - 1, holidays);
      notes.push(
        `A determination on ${options.priorDeterminationOn} between the same parties for the same or a similar service suspends this dispute for ${COOLING_OFF_CALENDAR_DAYS} calendar days. Open negotiation ended inside that window, so initiation moves to a ${POST_COOLING_OFF_WINDOW_BUSINESS_DAYS}-business-day window after the suspension lifts — longer than the usual four days, which is the one place this process is forgiving.`,
      );
    }
  }

  notes.push(
    coolingOff
      ? `The initiation window here is ${POST_COOLING_OFF_WINDOW_BUSINESS_DAYS} business days rather than the usual ${INITIATION_WINDOW_BUSINESS_DAYS}, because the cooling-off period extended it. Miss it and the dispute is gone — there is no late filing and no good-cause extension.`
      : `The initiation window is ${INITIATION_WINDOW_BUSINESS_DAYS} business days wide. Miss it and the dispute is gone — there is no late filing and no good-cause extension.`,
    `The non-initiating party owes a portal response by ${responseDue}. Nothing in the old process required one, so a payer that ignores it is not necessarily stonewalling — it may not know.`,
  );

  return {
    openNegotiationStart: initialPaymentOrDenial,
    responseDue,
    openNegotiationEnds,
    initiationOpens,
    initiationCloses,
    coolingOff,
    notes,
  };
}

function addCalendarDays(ymd: string, days: number): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6)) - 1;
  const d = Number(ymd.slice(6, 8));
  const date = new Date(Date.UTC(y, m, d + days));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

// ── Is it worth disputing? ───────────────────────────────────────────────────

export interface DisputeInput {
  /** The gap between what was billed-and-justified and what was paid, in cents. */
  amountInDisputeCents: number;
  /** Line items to be batched together. 1 is a single dispute. */
  lineItems: number;
  /** Honest odds of prevailing. The arbitrator picks one offer outright. */
  winProbability: number;
  initiatedOn: string;
}

export interface DisputeEconomics {
  lineItems: number;
  batched: boolean;
  overBatchLimit: boolean;
  adminFeeCents: number;
  /** Arbitrator fee if you lose, at the low and high ends of the published range. */
  idreFeeLowCents: number;
  idreFeeHighCents: number;
  /** Expected value at the pessimistic (high-fee) end. */
  expectedValueCents: number;
  expectedValueOptimisticCents: number;
  /** Amount in dispute at which the pessimistic expectation turns positive. */
  breakEvenCents: number;
  worthIt: boolean;
  reasons: string[];
}

/**
 * The arithmetic that decides it.
 *
 * Deliberately evaluated at the HIGH end of the arbitrator's fee range for the
 * headline verdict. The fee is not known in advance, and a decision that only
 * works if the cheapest arbitrator is assigned is not a decision.
 */
export function disputeEconomics(input: DisputeInput): DisputeEconomics {
  const lineItems = Math.max(1, Math.floor(input.lineItems));
  const batched = lineItems > 1;
  const overBatchLimit = lineItems > MAX_BATCH_LINE_ITEMS;
  const range = batched ? IDRE_FEE_BATCHED_CENTS : IDRE_FEE_SINGLE_CENTS;
  const admin = adminFeeCents(input.initiatedOn);
  const p = Math.min(1, Math.max(0, input.winProbability));

  // Win: recover the amount, admin fee refunded, other side pays the arbitrator.
  // Lose: recover nothing, pay the arbitrator, admin fee spent.
  const ev = (fee: number) => p * input.amountInDisputeCents - (1 - p) * (fee + admin);
  const expectedValueCents = ev(range.max);
  const expectedValueOptimisticCents = ev(range.min);

  const breakEvenCents = p > 0 ? ((1 - p) * (range.max + admin)) / p : Number.POSITIVE_INFINITY;

  const reasons: string[] = [];
  if (overBatchLimit) {
    reasons.push(
      `A batch may carry at most ${MAX_BATCH_LINE_ITEMS} line items; this has ${lineItems}. Split it, and note that each batch pays its own arbitrator fee — the second batch is not free.`,
    );
  }
  if (batched && !overBatchLimit) {
    const perItem = range.max / lineItems;
    reasons.push(
      `Batched across ${lineItems} line items, the worst-case arbitrator fee works out at $${(perItem / 100).toFixed(2)} each rather than $${(IDRE_FEE_SINGLE_CENTS.max / 100).toFixed(2)}. Batching is the single biggest lever on whether a dispute is worth filing.`,
    );
  }
  if (!batched) {
    reasons.push(
      `Filed alone, a loss costs $${((range.max + admin) / 100).toFixed(2)}. Batching similar line items — same service code, or one patient's consecutive dates on one claim form — spreads that across up to ${MAX_BATCH_LINE_ITEMS} of them.`,
    );
  }
  if (expectedValueCents <= 0 && expectedValueOptimisticCents > 0 && !overBatchLimit) {
    reasons.push(
      "This only works out if a cheap arbitrator is assigned, and which one you get is not something you control. Treat that as a no.",
    );
  }
  if (p >= 0.9) {
    reasons.push(
      "A win probability above 90% is worth questioning. This is baseball arbitration — the arbitrator picks one offer outright — and a confident offer that is not fully evidenced loses the entire dispute rather than landing halfway.",
    );
  }

  return {
    lineItems,
    batched,
    overBatchLimit,
    adminFeeCents: admin,
    idreFeeLowCents: range.min,
    idreFeeHighCents: range.max,
    expectedValueCents,
    expectedValueOptimisticCents,
    breakEvenCents,
    worthIt: expectedValueCents > 0 && !overBatchLimit,
    reasons,
  };
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function renderDispute(economics: DisputeEconomics, deadlines?: IdrDeadlines): string {
  const lines = [
    economics.overBatchLimit
      ? `Cannot be filed as one batch. The economics are fine — expected value ${money(economics.expectedValueCents)} — but the batch is over the ${MAX_BATCH_LINE_ITEMS}-item limit and has to be split first.`
      : economics.worthIt
        ? `Worth disputing. Expected value ${money(economics.expectedValueCents)} even if the most expensive arbitrator is assigned.`
        : `Not worth disputing on these numbers. Expected value ${money(economics.expectedValueCents)} at the top of the fee range.`,
    "",
    `${economics.lineItems} line item(s)${economics.batched ? " batched" : ", filed alone"}.`,
    `  Administrative fee: ${money(economics.adminFeeCents)} per party, refunded to whoever prevails.`,
    `  Arbitrator fee: ${money(economics.idreFeeLowCents)} to ${money(economics.idreFeeHighCents)}, paid entirely by the loser.`,
    Number.isFinite(economics.breakEvenCents)
      ? `  Break-even: an amount in dispute above ${money(economics.breakEvenCents)} at these odds.`
      : "  Break-even: unreachable at a zero win probability.",
  ];

  for (const reason of economics.reasons) lines.push(`  ${reason}`);

  if (deadlines) {
    lines.push(
      "",
      "Dates, all in BUSINESS days — a 30-business-day window is six calendar weeks, and a diary entry set 30 calendar days out closes the door a fortnight early:",
      `  Open negotiation runs ${deadlines.openNegotiationStart} → ${deadlines.openNegotiationEnds}`,
      `  Other party's portal response due ${deadlines.responseDue}`,
      `  Initiation window ${deadlines.initiationOpens} → ${deadlines.initiationCloses}${deadlines.coolingOff ? "  (extended by a cooling-off period)" : ""}`,
      ...deadlines.notes.map((n) => `  ${n}`),
    );
  }

  lines.push(
    "",
    "One offer each, and the arbitrator picks one of them outright. Submit the highest number the evidence fully carries rather than the highest number you would like — there is no meeting in the middle here, and an unsupported offer beside a supported one loses everything.",
  );

  return lines.join("\n");
}
