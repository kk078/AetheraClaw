// ── Contracted rates ─────────────────────────────────────────────────────────
// payment_variance already finds underpayments two ways: against Medicare, and
// against the payer's own established median. Both work without a contract on
// file, which is why they were built first — most practices cannot produce their
// fee schedule on demand.
//
// Neither, though, supports the sentence a practice actually wants to write in a
// letter: "you allowed $X where the agreement says $Y." Medicare is not what a
// commercial payer owes, and a payer's own median is a description of its habit,
// not of its obligation — if it has been underpaying a code since the contract
// was signed, the median IS the underpayment and the comparison finds nothing.
//
// So contracted rates are a third basis, and the interesting design decision is
// that they are DATED. A fee schedule amendment is the usual reason a payment
// changes, and a rate table with no effective dates applies today's schedule to
// last year's claims: every old line then reads as underpaid (or as correct)
// for a reason that has nothing to do with the payer's conduct.

export interface ContractRate {
  payerKey: string;
  payer: string;
  code: string;
  /** '' is the base rate; a modifier-specific rate wins over it when both apply. */
  modifier: string;
  allowed: number;
  effectiveFrom: string;
  /** '' means still in force. */
  effectiveTo: string;
  source: string;
}

/**
 * Normalize a payer name for matching — case and punctuation only.
 *
 * Deliberately NOT fuzzy. "Aetna" and "Aetna Better Health" are different
 * entities with different signed fee schedules, and so are "UnitedHealthcare"
 * and "UnitedHealthcare Community Plan". A near-match would apply one contract's
 * rates to another's claims and manufacture underpayments that do not exist,
 * which then go out in a demand letter. A payer whose name is recorded two ways
 * needs two entries, and that is the cheaper mistake.
 */
export function payerKey(payer: string): string {
  return payer.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type RateCheck = { ok: true } | { ok: false; reason: string };

/**
 * Validate a rate before it is stored.
 *
 * A contracted rate becomes the yardstick every payment is measured against and
 * the basis of a recovery letter, so a typo in it manufactures underpayments
 * that do not exist and wastes a biller's week. It is worth being strict.
 */
export function checkRate(rate: Pick<ContractRate, "allowed" | "effectiveFrom" | "effectiveTo" | "code" | "source">): RateCheck {
  if (!/^\d{8}$/.test(rate.effectiveFrom)) {
    return { ok: false, reason: "effective_from must be YYYYMMDD. An undated rate would be applied to claims it never governed." };
  }
  if (rate.effectiveTo && !/^\d{8}$/.test(rate.effectiveTo)) {
    return { ok: false, reason: "effective_to must be YYYYMMDD, or omitted while the rate is still in force." };
  }
  if (rate.effectiveTo && rate.effectiveTo < rate.effectiveFrom) {
    return { ok: false, reason: "effective_to falls before effective_from." };
  }
  if (!(rate.allowed > 0)) {
    return { ok: false, reason: "allowed must be greater than zero. A contracted rate of zero is a non-covered service, which is a coverage question rather than a rate." };
  }
  if (!rate.code.trim()) return { ok: false, reason: "code is required." };
  if (!rate.source.trim()) {
    // Unsourced rates are how a remembered number ends up in a demand letter.
    return {
      ok: false,
      reason: "source is required — name the document and section this rate came from (e.g. 'Aetna PAR agreement 2026 Exhibit A p.4'). A rate nobody can trace back to a signed schedule cannot support a recovery claim, and a remembered one is exactly how a wrong number reaches a payer.",
    };
  }
  return { ok: true };
}

/**
 * The rate in force for a code on a date.
 *
 * A modifier-specific rate outranks the base rate, because that is what a fee
 * schedule exhibit means when it lists both. Where several rates overlap the
 * same date — which should not happen but does, after a schedule is loaded
 * twice — the latest effective_from wins, since that is the amendment.
 */
export function rateFor(
  rates: ContractRate[],
  opts: { payer: string; code: string; modifiers?: string[]; serviceDate: string },
): ContractRate | undefined {
  const key = payerKey(opts.payer);
  const code = opts.code.trim().toUpperCase();
  const mods = (opts.modifiers ?? []).map((m) => m.trim().toUpperCase());

  const inForce = rates.filter(
    (r) =>
      r.payerKey === key &&
      r.code.toUpperCase() === code &&
      r.effectiveFrom <= opts.serviceDate &&
      (r.effectiveTo === "" || r.effectiveTo >= opts.serviceDate),
  );
  if (inForce.length === 0) return undefined;

  const byRecency = (a: ContractRate, b: ContractRate) => b.effectiveFrom.localeCompare(a.effectiveFrom);
  const modifierMatch = inForce.filter((r) => r.modifier !== "" && mods.includes(r.modifier.toUpperCase()));
  if (modifierMatch.length > 0) return modifierMatch.sort(byRecency)[0];
  return inForce.filter((r) => r.modifier === "").sort(byRecency)[0];
}

export interface Coverage {
  codesBilled: number;
  codesWithRate: number;
  /** Codes billed with no contracted rate on file — the gap that makes the basis partial. */
  uncovered: string[];
}

/**
 * How much of what was billed the contract table can actually speak to.
 *
 * Reported because a contract basis covering 12 of 80 billed codes will find
 * few underpayments and read as a clean bill of health. The silence is about
 * the table, not about the payer.
 */
export function rateCoverage(rates: ContractRate[], billed: Array<{ payer: string; code: string; serviceDate: string }>): Coverage {
  const seen = new Set<string>();
  // Count uncovered by the SAME payer|code pair key as `seen`; only the display
  // list is by bare code. Mixing a pair-keyed `seen` with a code-keyed
  // `uncovered` made codesWithRate overstate coverage whenever one code was
  // uncovered for two payers (2 pairs, 1 code → reported "1 of 2 covered" when 0
  // were) — the exact false clean-bill the count exists to prevent.
  const uncoveredPairs = new Set<string>();
  const uncoveredCodes = new Set<string>();
  for (const line of billed) {
    const id = `${payerKey(line.payer)}|${line.code.toUpperCase()}`;
    seen.add(id);
    if (!rateFor(rates, { payer: line.payer, code: line.code, serviceDate: line.serviceDate })) {
      uncoveredPairs.add(id);
      uncoveredCodes.add(line.code.toUpperCase());
    }
  }
  return { codesBilled: seen.size, codesWithRate: seen.size - uncoveredPairs.size, uncovered: [...uncoveredCodes].sort() };
}

export function renderCoverage(coverage: Coverage): string {
  if (coverage.codesBilled === 0) return "";
  if (coverage.uncovered.length === 0) {
    return `Every billed code has a contracted rate on file for its date of service.`;
  }
  return [
    `Contract coverage: ${coverage.codesWithRate} of ${coverage.codesBilled} billed payer/code pair(s) have a rate on file for the date of service.`,
    `No rate for: ${coverage.uncovered.slice(0, 25).join(", ")}${coverage.uncovered.length > 25 ? ` … and ${coverage.uncovered.length - 25} more` : ""}.`,
    "Those lines were not checked at all. A contract basis that covers a fraction of what you bill will report few underpayments — that is a statement about the table, not about the payer.",
  ].join("\n");
}
