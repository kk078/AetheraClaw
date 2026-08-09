import type { Era } from "../x12/835.js";
import { baseProcedureCode } from "../x12/segments.js";

// ── Denial risk ──────────────────────────────────────────────────────────────
// Predicting denials from a practice's own history runs straight into small
// samples: three claims with one denial is not a 33% denial rate, it is three
// claims. Every rate here is therefore shrunk toward the observed base rate by a
// fixed weight of pseudo-observations, so a thin history reports something close
// to the base rate and only a real pattern moves the number.
//
// The evidence levels are nested rather than independent — "this code with this
// payer" is a subset of "this code everywhere" — so they back off into one
// another instead of being summed. Adding them as separate evidence would count
// the same claims twice and read two denials as a near-certainty.
//
// Each factor reports the movement it accounts for in percentage points, and
// those movements sum exactly to (estimate − baseline), so the score can always
// be read as a list of reasons rather than a number to be trusted on faith.

/** Pseudo-observations pulling every rate toward the base rate. */
export const SHRINKAGE_STRENGTH = 10;

/** Below this many observations a factor is described as thin rather than relied on. */
export const THIN_EVIDENCE_THRESHOLD = 8;

/** CARCs that mean the payer required an authorization that was not on the claim. */
export const PRIOR_AUTH_CARCS = new Set(["197", "198", "15", "62"]);

/** CARCs that mean the payer did not consider the service medically necessary. */
export const MEDICAL_NECESSITY_CARCS = new Set(["50", "55", "56", "167"]);

export function logit(p: number): number {
  const clamped = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(clamped / (1 - clamped));
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Empirical-Bayes shrinkage: the observed rate blended with the prior in
 * proportion to how much evidence there is. With strength 10 and a 5% prior,
 * 1 denial in 3 claims reads as 13%, not 33%.
 */
export function shrunkRate(denials: number, n: number, prior: number, strength = SHRINKAGE_STRENGTH): number {
  if (n <= 0) return prior;
  return (denials + strength * prior) / (n + strength);
}

export interface LineOutcome {
  payer: string;
  code: string;
  denied: boolean;
  carcs: string[];
}

/** Flatten remittances into one outcome per adjudicated service line. */
export function collectOutcomes(eras: Array<{ era: Era }>): LineOutcome[] {
  const out: LineOutcome[] = [];
  for (const { era } of eras) {
    for (const claim of era.claims) {
      const claimDenied = claim.statusCode === "4";
      for (const line of claim.lines) {
        if (line.procedure === "(claim level)") continue;
        const carcs = line.adjustments.map((a) => a.carc);
        // A line is "denied" when the claim was denied, or when the line itself
        // was zero-paid against a non-patient-responsibility reason.
        const zeroPaidByPayer =
          line.paid <= 0 && line.adjustments.some((a) => a.group !== "PR" && a.amount > 0);
        out.push({
          payer: era.payer,
          code: baseProcedureCode(line.procedure),
          denied: claimDenied || zeroPaidByPayer,
          carcs,
        });
      }
    }
  }
  return out;
}

export interface Tally {
  n: number;
  denials: number;
}

export interface HistoryIndex {
  base: number;
  overall: Tally;
  byPayerCode: Map<string, Tally>;
  byCode: Map<string, Tally>;
  byPayer: Map<string, Tally>;
  /** Payer|code combinations that have drawn a prior-authorization CARC. */
  priorAuthSeen: Map<string, Tally>;
}

function key(...parts: string[]): string {
  return parts.map((p) => p.trim().toUpperCase()).join("|");
}

function bump(map: Map<string, Tally>, k: string, denied: boolean): void {
  const slot = map.get(k) ?? { n: 0, denials: 0 };
  slot.n++;
  if (denied) slot.denials++;
  map.set(k, slot);
}

export function indexHistory(outcomes: LineOutcome[]): HistoryIndex {
  const index: HistoryIndex = {
    base: 0,
    overall: { n: 0, denials: 0 },
    byPayerCode: new Map(),
    byCode: new Map(),
    byPayer: new Map(),
    priorAuthSeen: new Map(),
  };
  for (const o of outcomes) {
    index.overall.n++;
    if (o.denied) index.overall.denials++;
    bump(index.byPayerCode, key(o.payer, o.code), o.denied);
    bump(index.byCode, key(o.code), o.denied);
    bump(index.byPayer, key(o.payer), o.denied);
    // Only a DENIED line with a prior-auth CARC is a prior-auth denial. A paid
    // line carrying CO-197 on a partially-authorized balance is not — counting it
    // let authDenials (subtracted from the cell's real denials downstream)
    // exceed, or come from a different population than, those denials, pulling the
    // risk estimate wrong and rendering "1 of this payer's N denial(s) … were for
    // a missing authorization" for denials that were not auth-related.
    if (o.denied && o.carcs.some((c) => PRIOR_AUTH_CARCS.has(c))) {
      bump(index.priorAuthSeen, key(o.payer, o.code), true);
    }
  }
  index.base = index.overall.n > 0 ? index.overall.denials / index.overall.n : 0.05;
  return index;
}

export interface RiskFactor {
  label: string;
  /** Change in probability attributable to this factor, in percentage points. */
  points: number;
  n: number;
  thin: boolean;
  detail: string;
}

export interface RiskScore {
  probability: number;
  band: "LOW" | "MODERATE" | "HIGH";
  baseRate: number;
  factors: RiskFactor[];
  historySize: number;
  notes: string[];
}

export interface RiskInput {
  payer: string;
  codes: string[];
  hasPriorAuth?: boolean;
}

/**
 * Score a claim before submission. The returned probability is the model's
 * estimate for the riskiest line on the claim, since a claim is denied if any
 * line fails and averaging would hide the one code causing the problem.
 */
export function scoreDenialRisk(input: RiskInput, index: HistoryIndex): RiskScore {
  const notes: string[] = [];
  const base = index.base;

  if (index.overall.n === 0) {
    return {
      probability: 0.05,
      band: "LOW",
      baseRate: 0.05,
      factors: [],
      historySize: 0,
      notes: [
        "No remittance history yet, so this is a bare default rather than a prediction. Parse 835 files with era_parse_835 and the score starts reflecting how your payers actually behave.",
      ],
    };
  }

  let best: { probability: number; factors: RiskFactor[]; code: string } | null = null;

  for (const rawCode of input.codes) {
    const code = rawCode.trim().toUpperCase();
    const factors: RiskFactor[] = [];

    // These three tallies are NESTED, not independent: "this code with this
    // payer" is a subset of "this code everywhere". Treating them as separate
    // evidence and summing their log-odds counts the same claims two and three
    // times over, which turns two denials into a near-certainty. Instead each
    // broader level supplies the prior for the next narrower one, so the final
    // estimate rests on the most specific evidence available and backs off to
    // broader evidence only as far as it has to.
    const codeTally = index.byCode.get(key(code));
    const payerTally = index.byPayer.get(key(input.payer));
    const cellTally = index.byPayerCode.get(key(input.payer, code));

    const codeRate = shrunkRate(codeTally?.denials ?? 0, codeTally?.n ?? 0, base);
    const payerRate = shrunkRate(payerTally?.denials ?? 0, payerTally?.n ?? 0, base);

    // Blend the two dimensions by how much evidence each carries, then let the
    // specific cell move off that blend.
    const codeN = codeTally?.n ?? 0;
    const payerN = payerTally?.n ?? 0;
    const backoffPrior = codeN + payerN > 0 ? (codeRate * codeN + payerRate * payerN) / (codeN + payerN) : base;
    const cellRate = shrunkRate(cellTally?.denials ?? 0, cellTally?.n ?? 0, backoffPrior);

    // Each factor reports the movement it accounts for, so the points sum
    // exactly to (final − baseline) instead of overlapping.
    const step = (
      label: string,
      from: number,
      to: number,
      tally: Tally | undefined,
      detail: string,
      showTally = true,
    ) => {
      if (!tally || tally.n === 0 || Math.abs(to - from) < 1e-9) return;
      factors.push({
        label,
        points: (to - from) * 100,
        n: tally.n,
        thin: tally.n < THIN_EVIDENCE_THRESHOLD,
        detail: showTally
          ? `${detail} — ${tally.denials}/${tally.n} denied, ${(to * 100).toFixed(1)}% after shrinkage.`
          : `${detail}, leaving ${(to * 100).toFixed(1)}% after shrinkage.`,
      });
    };

    step(`${code} across all payers`, base, codeRate, codeTally, "this code everywhere");
    step(`${input.payer} across all codes`, codeRate, backoffPrior, payerTally, "this payer generally");
    step(`${code} with ${input.payer}`, backoffPrior, cellRate, cellTally, "this payer's history with this code");

    // Authorization is not separate evidence to add on top: the denials that
    // made this cell look risky ARE the authorization denials. Adding a bump for
    // "no auth" would count them a second time. What the flag actually tells us
    // is which way to split the cell — confirming an authorization removes the
    // dominant historical cause, so it LOWERS the estimate; its absence simply
    // leaves the historical rate standing, because that rate already describes
    // claims like this one.
    const paTally = index.priorAuthSeen.get(key(input.payer, code));
    const authDenials = paTally?.n ?? 0;
    let finalRate = cellRate;

    if (authDenials > 0 && cellTally) {
      if (input.hasPriorAuth === true) {
        const residual = Math.max(cellTally.denials - authDenials, 0);
        const residualRate = shrunkRate(residual, cellTally.n, backoffPrior);
        step(
          `Authorization confirmed for ${code}`,
          cellRate,
          residualRate,
          cellTally,
          `${authDenials} of this payer's ${cellTally.denials} denial(s) on this code were for a missing authorization, which does not apply here`,
          false,
        );
        finalRate = residualRate;
      } else if (input.hasPriorAuth === false) {
        notes.push(
          `${authDenials} of the ${cellTally.denials} denial(s) behind this estimate were for a missing authorization, and none is recorded on this claim — the dominant historical cause applies here. Confirm the authorization is on file and that its number is on the claim.`,
        );
      } else {
        notes.push(
          `${input.payer} has denied ${code} for a missing authorization ${authDenials} time(s). Pass has_prior_auth: confirming one on file would lower this estimate materially.`,
        );
      }
    }

    const probability = finalRate;
    if (!best || probability > best.probability) best = { probability, factors, code };
  }

  const probability = Math.min(best?.probability ?? base, 0.97);
  if (input.codes.length > 1 && best) {
    notes.push(`Scored on ${best.code}, the riskiest line — a claim denies if any line fails, so the worst line is what matters.`);
  }
  const thin = (best?.factors ?? []).some((f) => f.thin);
  if (thin) {
    notes.push(
      `Some factors rest on fewer than ${THIN_EVIDENCE_THRESHOLD} observations and are marked thin. They are shrunk toward the ${(base * 100).toFixed(1)}% baseline rather than taken at face value.`,
    );
  }

  return {
    probability,
    band: probability > 0.4 ? "HIGH" : probability > 0.18 ? "MODERATE" : "LOW",
    baseRate: base,
    factors: (best?.factors ?? []).sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
    historySize: index.overall.n,
    notes,
  };
}

export function renderRiskScore(score: RiskScore): string {
  const lines: string[] = [
    `Denial risk: ${score.band} — ${(score.probability * 100).toFixed(0)}% (practice baseline ${(score.baseRate * 100).toFixed(1)}%, from ${score.historySize} adjudicated line(s))`,
  ];
  if (score.factors.length === 0) {
    lines.push("No factor moved the estimate off the baseline.");
  } else {
    lines.push("", "What moved it:");
    for (const f of score.factors) {
      const sign = f.points >= 0 ? "+" : "";
      lines.push(`  ${sign}${f.points.toFixed(1)} pts — ${f.label}${f.thin ? " [thin evidence]" : ""}`);
      lines.push(`      ${f.detail}`);
    }
  }
  if (score.notes.length) {
    lines.push("", ...score.notes.map((n) => `Note: ${n}`));
  }
  return lines.join("\n");
}
