import type { BillingClass, NegotiatedType, RateRecord } from "./ingest.js";

// ── What a published rate is worth ───────────────────────────────────────────
// The files are public, so the temptation is to average what is in them and
// call the result the market rate. Three things make that wrong, and all three
// are silent:
//
//   A "negotiated_rate" of 250 might be $250 or it might be 250% of Medicare.
//   The negotiated_type column says which. Averaging them together produces a
//   number that is neither, and it will look plausible.
//
//   A professional rate and an institutional rate for the same CPT are prices
//   for different things — the physician's work and the facility's. Comparing a
//   practice's professional rate to a hospital's institutional one says nothing.
//
//   Every rate belongs to a specific provider under a specific contract. An
//   academic medical centre's rate is not evidence about what a solo practice
//   should be paid, and a benchmark that mixes them is an argument the other
//   side will take apart in one sentence.
//
// So rates are segregated before they are compared, and a comparison that had to
// mix incomparable things reports that instead of a number.

export interface RateGroup {
  billingCode: string;
  negotiatedType: NegotiatedType;
  billingClass: BillingClass;
  rates: number[];
  sources: string[];
}

/** The key two rates must share before they can sit in the same distribution. */
export function comparabilityKey(rate: RateRecord): string {
  return `${rate.billingCode}|${rate.negotiatedType}|${rate.billingClass}`;
}

/** Types whose value is a dollar amount. The rest are ratios or per-unit prices. */
export const DOLLAR_TYPES: NegotiatedType[] = ["negotiated", "derived", "fee schedule"];

export function isDollarRate(type: NegotiatedType): boolean {
  return DOLLAR_TYPES.includes(type);
}

export function groupRates(rates: RateRecord[]): RateGroup[] {
  const groups = new Map<string, RateGroup>();
  for (const rate of rates) {
    const key = comparabilityKey(rate);
    const group = groups.get(key) ?? {
      billingCode: rate.billingCode,
      negotiatedType: rate.negotiatedType,
      billingClass: rate.billingClass,
      rates: [],
      sources: [],
    };
    group.rates.push(rate.rate);
    if (!group.sources.includes(rate.source)) group.sources.push(rate.source);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Below this, a distribution is a handful of numbers rather than a market.
 *
 * Quoting a 75th percentile computed from four rates in a negotiation invites
 * exactly one question, and there is no good answer to it.
 */
export const MIN_RATES_FOR_BENCHMARK = 8;

export interface Benchmark {
  billingCode: string;
  negotiatedType: NegotiatedType;
  billingClass: BillingClass;
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  sources: number;
  /** True when there are too few rates to call this a distribution. */
  thin: boolean;
  /** Units, so a percentage is never printed with a dollar sign. */
  unit: "dollars" | "percent" | "per diem";
}

function unitFor(type: NegotiatedType): Benchmark["unit"] {
  if (type === "percentage") return "percent";
  if (type === "per diem") return "per diem";
  return "dollars";
}

export function benchmarkGroup(group: RateGroup): Benchmark {
  const sorted = [...group.rates].sort((a, b) => a - b);
  return {
    billingCode: group.billingCode,
    negotiatedType: group.negotiatedType,
    billingClass: group.billingClass,
    n: sorted.length,
    min: sorted[0] ?? 0,
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    max: sorted[sorted.length - 1] ?? 0,
    sources: group.sources.length,
    thin: sorted.length < MIN_RATES_FOR_BENCHMARK,
    unit: unitFor(group.negotiatedType),
  };
}

export function buildBenchmarks(rates: RateRecord[]): Benchmark[] {
  return groupRates(rates)
    .map(benchmarkGroup)
    .sort((a, b) => a.billingCode.localeCompare(b.billingCode) || b.n - a.n);
}

export interface Position {
  billingCode: string;
  /** What this practice is actually paid. */
  ours: number;
  benchmark: Benchmark;
  /** Where our rate sits in the distribution, 0 to 1. */
  percentileRank: number;
  /** Dollars per unit of service between our rate and the median. */
  gapToMedian: number;
  verdict: string;
}

export function percentileRank(value: number, sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const below = sorted.filter((r) => r < value).length;
  const equal = sorted.filter((r) => r === value).length;
  return (below + equal / 2) / sorted.length;
}

/**
 * Where the practice's rate sits.
 *
 * Only ever compared against a benchmark of the same type and billing class —
 * the grouping guarantees it, so a professional rate cannot be measured against
 * a facility distribution by accident.
 */
export function positionAgainst(ours: number, group: RateGroup): Position {
  const benchmark = benchmarkGroup(group);
  const sorted = [...group.rates].sort((a, b) => a - b);
  const rank = percentileRank(ours, sorted);
  const gap = benchmark.median - ours;

  let verdict: string;
  if (benchmark.thin) {
    verdict = `Only ${benchmark.n} comparable rate(s) — not enough to call a market. Quoting a percentile from this in a negotiation invites one question with no good answer.`;
  } else if (rank <= 0.25) {
    verdict = `Bottom quartile. ${gap > 0 ? `The median is ${gap.toFixed(2)} higher per unit.` : ""} This is the strongest case in the set.`;
  } else if (rank >= 0.75) {
    verdict = "Top quartile — already paid above most of the published market for this code. Spend the negotiation elsewhere.";
  } else {
    verdict = "Mid-range. A rate in the middle of the published distribution is a weak argument on its own.";
  }

  return { billingCode: group.billingCode, ours, benchmark, percentileRank: rank, gapToMedian: gap, verdict };
}

function fmt(value: number, unit: Benchmark["unit"]): string {
  if (unit === "percent") return `${value.toFixed(1)}%`;
  if (unit === "per diem") return `${value.toFixed(2)}/day`;
  return `$${value.toFixed(2)}`;
}

export function renderBenchmarks(benchmarks: Benchmark[]): string {
  if (benchmarks.length === 0) return "No rates to benchmark.";

  const lines: string[] = [];
  const dollar = benchmarks.filter((b) => b.unit === "dollars");
  const other = benchmarks.filter((b) => b.unit !== "dollars");

  for (const b of [...dollar, ...other]) {
    lines.push(
      `${b.billingCode}  ${b.billingClass}  ${b.negotiatedType}  n=${b.n}${b.thin ? "  ** thin **" : ""}`,
      `  ${fmt(b.min, b.unit)} — ${fmt(b.p25, b.unit)} — [${fmt(b.median, b.unit)}] — ${fmt(b.p75, b.unit)} — ${fmt(b.max, b.unit)}   across ${b.sources} file(s)`,
    );
  }

  if (other.length > 0) {
    lines.push(
      "",
      "The groups above that are not in dollars are priced as a percentage or per diem and are listed separately on purpose. A negotiated_rate of 250 can mean $250 or 250% of Medicare, and averaging the two produces a number that is neither while looking entirely plausible.",
    );
  }
  if (benchmarks.some((b) => b.thin)) {
    lines.push(
      "",
      `Groups marked thin have fewer than ${MIN_RATES_FOR_BENCHMARK} comparable rates. They are shown because absence is worth seeing, not because they are evidence.`,
    );
  }
  lines.push(
    "",
    "Every rate here belongs to a specific provider under a specific contract. Before taking one into a negotiation, check that the providers behind it are comparable in setting and size — an academic medical centre's rate says nothing about what a solo practice should be paid, and that is the first thing the other side will say.",
  );

  return lines.join("\n");
}
