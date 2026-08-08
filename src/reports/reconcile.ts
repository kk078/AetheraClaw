import type { Era, EraProviderAdjustment } from "../tools/healthcare/x12/835.js";

// ── Deposit reconciliation ───────────────────────────────────────────────────
// An 835 balances on one equation:
//
//     BPR02  =  Σ CLP04  −  Σ PLB amounts
//     (check)   (claim payments)  (provider-level adjustments)
//
// Until PLB was parsed, nothing in this system could evaluate the right-hand
// side, so a payer recouping $4,000 from a claim paid in March produced a
// smaller cheque this month with no explanation anywhere: the deposit did not
// tie to the posted claims, the posting file could not balance, and nobody was
// told. The money simply vanished.

/**
 * What one provider-level adjustment does to the cheque, in dollars.
 *
 * THE SIGN CONVENTION LIVES HERE AND NOWHERE ELSE. In X12 a positive PLB amount
 * REDUCES the payment — the payer is taking money back. Getting this backwards
 * turns a $4,000 takeback into a $4,000 credit, and the mistake is invisible
 * because both directions produce a plausible number on a plausible-looking
 * report. One function, tested in both directions, is the only defence.
 */
export function checkEffect(adj: EraProviderAdjustment): number {
  return -adj.amount;
}

export type PlbKind =
  /** The payer taking back money it already paid. Real cash, already gone. */
  | "recoupment"
  /** Carried to the NEXT remittance. Not lost — it will arrive. */
  | "forwarding"
  /** Money owed to the provider: interest, incentive, bonus. Usually increases the cheque. */
  | "owed-to-provider"
  /** Withheld by law or contract: levy, IRS withholding, penalty. */
  | "withholding"
  /** Capitation and passthrough payments that are not claim-specific. */
  | "capitation"
  | "other";

export interface PlbReason {
  meaning: string;
  kind: PlbKind;
  /** Anything a reader needs before acting on it. Empty when there is nothing to say. */
  note?: string;
}

export const PLB_REASONS: Record<string, PlbReason> = {
  "72": { meaning: "Authorized return", kind: "recoupment" },
  "90": { meaning: "Early payment allowance", kind: "other" },
  AH: { meaning: "Origination fee", kind: "withholding" },
  AM: { meaning: "Applied to borrower's account", kind: "withholding" },
  AP: { meaning: "Acceleration of benefits", kind: "owed-to-provider" },
  B2: { meaning: "Rebate", kind: "recoupment" },
  B3: { meaning: "Recovery allowance", kind: "recoupment" },
  BD: { meaning: "Bad debt adjustment", kind: "other" },
  BN: { meaning: "Bonus", kind: "owed-to-provider" },
  C5: { meaning: "Temporary allowance", kind: "other" },
  CR: { meaning: "Capitation interest", kind: "capitation" },
  CS: { meaning: "Adjustment", kind: "other", note: "Unspecified by the payer — read the reference identifier before posting it anywhere." },
  CT: { meaning: "Capitation payment", kind: "capitation" },
  CV: { meaning: "Capital passthrough", kind: "capitation" },
  CW: { meaning: "CRNA passthrough", kind: "capitation" },
  DM: { meaning: "Direct medical education passthrough", kind: "capitation" },
  E3: { meaning: "Withholding", kind: "withholding" },
  FB: {
    meaning: "Forwarding balance",
    kind: "forwarding",
    note: "NOT a takeback. This balance carries to the next remittance and will arrive — treating it as lost understates cash.",
  },
  FC: { meaning: "Fund allocation", kind: "other" },
  GO: { meaning: "Graduate medical education passthrough", kind: "capitation" },
  HM: { meaning: "Hemophilia clotting factor supplement", kind: "owed-to-provider" },
  IP: { meaning: "Incentive premium payment", kind: "owed-to-provider" },
  IR: { meaning: "IRS withholding", kind: "withholding" },
  IS: { meaning: "Interim settlement", kind: "other" },
  J1: { meaning: "Nonreimbursable", kind: "other" },
  L3: { meaning: "Penalty", kind: "withholding" },
  L6: { meaning: "Interest owed to the provider", kind: "owed-to-provider" },
  LE: { meaning: "Levy", kind: "withholding", note: "A legal garnishment. Not a billing error and not appealable through the payer." },
  LS: { meaning: "Lump sum", kind: "other" },
  OA: { meaning: "Organ acquisition passthrough", kind: "capitation" },
  OB: { meaning: "Offset for affiliated providers", kind: "recoupment" },
  PI: { meaning: "Periodic interim payment", kind: "capitation" },
  PL: { meaning: "Payment final", kind: "other" },
  RA: { meaning: "Retroactivity adjustment", kind: "other" },
  RE: { meaning: "Return on equity", kind: "owed-to-provider" },
  SL: { meaning: "Student loan repayment", kind: "withholding" },
  TL: { meaning: "Third party liability", kind: "recoupment" },
  WO: {
    meaning: "Overpayment recovery",
    kind: "recoupment",
    note: "The payer is recouping money it already paid. If an open credit balance covers this claim, the refund is already settled — see credit_balance_recoupments.",
  },
  WU: { meaning: "Unspecified recovery", kind: "recoupment" },
};

export function describeReason(code: string): PlbReason {
  return PLB_REASONS[code.toUpperCase()] ?? { meaning: `Unrecognised PLB reason ${code}`, kind: "other" };
}

export interface ReconciledAdjustment extends EraProviderAdjustment {
  reason: PlbReason;
  /** Signed effect on the cheque. Negative = the payer took money off it. */
  effect: number;
}

export interface EraReconciliation {
  payer: string;
  /** BPR02 — what the payer says it sent. */
  checkAmount: number;
  /** Σ CLP04 — what the claims on this remittance say was paid. */
  claimsTotal: number;
  /** Σ effects. Negative when the payer net-reduced the cheque. */
  adjustmentTotal: number;
  /** claimsTotal + adjustmentTotal — what the cheque should be. */
  expectedCheck: number;
  /** checkAmount − expectedCheck. Non-zero means something is unexplained. */
  residual: number;
  balanced: boolean;
  adjustments: ReconciledAdjustment[];
  /** Money genuinely taken back, as a positive number. */
  recoupedTotal: number;
  /** Money carried to the next remittance, as a positive number. Not a loss. */
  forwardedTotal: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Cents of slack. Payers round; a one-cent gap is not a discrepancy worth a headline. */
export const RESIDUAL_TOLERANCE = 0.01;

export function reconcileEra(era: Era): EraReconciliation {
  const adjustments: ReconciledAdjustment[] = (era.providerAdjustments ?? []).map((a) => ({
    ...a,
    reason: describeReason(a.reasonCode),
    effect: checkEffect(a),
  }));

  // Reversals (CLP02 = 22) carry negative payment amounts and are already part
  // of the claim total the payer struck the cheque from, so they are summed
  // like any other claim rather than excluded.
  const claimsTotal = round2(era.claims.reduce((s, c) => s + c.paid, 0));
  const adjustmentTotal = round2(adjustments.reduce((s, a) => s + a.effect, 0));
  const expectedCheck = round2(claimsTotal + adjustmentTotal);
  const residual = round2(era.checkOrEftAmount - expectedCheck);

  return {
    payer: era.payer,
    checkAmount: era.checkOrEftAmount,
    claimsTotal,
    adjustmentTotal,
    expectedCheck,
    residual,
    balanced: Math.abs(residual) <= RESIDUAL_TOLERANCE,
    adjustments,
    recoupedTotal: round2(adjustments.filter((a) => a.reason.kind === "recoupment").reduce((s, a) => s + Math.max(0, -a.effect), 0)),
    forwardedTotal: round2(adjustments.filter((a) => a.reason.kind === "forwarding").reduce((s, a) => s + Math.max(0, -a.effect), 0)),
  };
}

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

export function renderReconciliation(r: EraReconciliation): string {
  const out = [
    `${r.payer || "Payer"} — deposit reconciliation`,
    `  Claim payments       ${money(r.claimsTotal)}`,
    `  Provider adjustments ${money(r.adjustmentTotal)}`,
    `  Expected cheque      ${money(r.expectedCheck)}`,
    `  BPR says             ${money(r.checkAmount)}`,
  ];

  if (r.adjustments.length === 0) {
    out.push("", "No PLB segments on this remittance — the cheque is claim payments alone.");
  } else {
    out.push("", "Provider-level adjustments:");
    for (const a of r.adjustments) {
      const direction = a.effect < 0 ? "off the cheque" : "added to the cheque";
      out.push(`  ${a.reasonCode}  ${money(Math.abs(a.effect))} ${direction}  ${a.reason.meaning}${a.referenceId ? `  (ref ${a.referenceId})` : ""}`);
      if (a.reason.note) out.push(`      ${a.reason.note}`);
    }
  }

  if (r.recoupedTotal > 0 || r.forwardedTotal > 0) {
    out.push("");
    if (r.recoupedTotal > 0) out.push(`Recouped this remittance: ${money(r.recoupedTotal)} — money already paid and now taken back.`);
    if (r.forwardedTotal > 0) out.push(`Forwarded to the next remittance: ${money(r.forwardedTotal)} — carried, not lost.`);
  }

  out.push("");
  if (r.balanced) {
    out.push("Balances: the cheque is fully explained by the claims and adjustments on it.");
  } else {
    // Never absorbed into a rounding line. An unexplained residual is the whole
    // reason to run this, and a report that quietly makes it zero is worse than
    // one that never ran.
    out.push(
      `DOES NOT BALANCE by ${money(r.residual)}.`,
      r.residual > 0
        ? "The payer sent MORE than the claims and adjustments account for — a payment on this remittance is missing from the claim loop, or an adjustment was not reported."
        : "The payer sent LESS than the claims and adjustments account for — something was withheld without a PLB explaining it.",
      "This figure is reported, not absorbed. Do not post the file until it is explained.",
    );
  }
  return out.join("\n");
}

// ── Recoupment linkage ───────────────────────────────────────────────────────
// A WO is the payer SELF-RECOUPING an overpayment. If an open credit balance
// covers the same claim, the refund cheque the ledger is waiting for will never
// be written — the money has already gone back. That row should resolve as
// `adjusted_by_payer`, and until PLB was parsed there was no way to see it.

export interface OpenCredit {
  id: string;
  claimId: string;
  amountCents: number;
  payer: string;
}

export interface RecoupmentMatch {
  credit: OpenCredit;
  adjustment: ReconciledAdjustment;
  /** Recouped amount in cents, as a positive number. */
  recoupedCents: number;
  /** True when the payer took back materially what the ledger says is owed. */
  coversBalance: boolean;
}

/**
 * Match overpayment recoveries against open credit balances.
 *
 * Matched on the claim identifier, which is what a payer puts in the PLB
 * reference. Reported, never applied: the 60-day report-and-return clock and
 * its audit trail are not something to close from a parse, and a mis-matched
 * reference would close a real refund obligation on a guess.
 */
export function matchRecoupments(reconciliations: EraReconciliation[], open: OpenCredit[]): RecoupmentMatch[] {
  const byClaim = new Map<string, OpenCredit[]>();
  for (const c of open) {
    const key = c.claimId.trim().toUpperCase();
    if (!key) continue;
    byClaim.set(key, [...(byClaim.get(key) ?? []), c]);
  }

  const matches: RecoupmentMatch[] = [];
  for (const r of reconciliations) {
    for (const a of r.adjustments) {
      if (a.reason.kind !== "recoupment") continue;
      const key = a.referenceId.trim().toUpperCase();
      if (!key) continue;
      const recoupedCents = Math.round(Math.max(0, -a.effect) * 100);
      for (const credit of byClaim.get(key) ?? []) {
        matches.push({ credit, adjustment: a, recoupedCents, coversBalance: recoupedCents >= credit.amountCents });
      }
    }
  }
  return matches;
}

export function renderRecoupmentMatches(matches: RecoupmentMatch[]): string {
  if (matches.length === 0) {
    return "No open credit balance matches a payer recoupment on the stored remittances. Any refund obligation on the ledger is still owed.";
  }
  const cents = (n: number) => `$${(n / 100).toFixed(2)}`;
  const out = [
    `${matches.length} open credit balance(s) the payer has already recouped:`,
    "",
  ];
  for (const m of matches) {
    out.push(
      `  ${m.credit.id}  claim ${m.credit.claimId}  ledger ${cents(m.credit.amountCents)}  recouped ${cents(m.recoupedCents)} via PLB ${m.adjustment.reasonCode}`,
      m.coversBalance
        ? "      Covers the balance — resolve as adjusted_by_payer rather than sending a refund."
        : `      PARTIAL — ${cents(m.credit.amountCents - m.recoupedCents)} of the balance is still outstanding.`,
    );
  }
  out.push(
    "",
    "Nothing has been changed. Confirm each against the remittance, then use credit_balance_resolve with status adjusted_by_payer — the 60-day clock and its audit trail are not something to close from a parse.",
  );
  return out.join("\n");
}
