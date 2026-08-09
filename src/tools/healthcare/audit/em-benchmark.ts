import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configDir } from "../../../config/config.js";
import { defineTool } from "../../registry.js";
import { loadEras } from "../analytics.js";
import type { MemoryStore } from "../../../memory/store.js";
import type { Era } from "../x12/835.js";
import { baseProcedureCode } from "../x12/segments.js";

// ── E/M utilization benchmarking ─────────────────────────────────────────────
// Payers and the OIG both look at how a practice's E/M levels are distributed
// against peers: a curve skewed toward 99214/99215 is the single most common
// trigger for a probe. This computes the practice's own curve, compares it to a
// benchmark when one is installed, and — because we now record both submitted
// claims and paid remittances — reports the downcoding rate, which says whether
// payers are actually disagreeing with the levels billed.

export const NEW_PATIENT_CODES = ["99202", "99203", "99204", "99205"] as const;
export const ESTABLISHED_PATIENT_CODES = ["99211", "99212", "99213", "99214", "99215"] as const;
const ALL_EM = new Set<string>([...NEW_PATIENT_CODES, ...ESTABLISHED_PATIENT_CODES]);

/** Minimum sample before an outlier flag means anything. */
export const MIN_SAMPLE_FOR_OUTLIER = 30;
/** Percentage points above benchmark that trip the flag. */
export const OUTLIER_THRESHOLD_PP = 10;

export interface SubmittedClaimRecord {
  claimId: string;
  renderingProviderNpi?: string;
  serviceDate?: string;
  codes: string[];
}

export interface EmLevelStat {
  code: string;
  level: number;
  count: number;
  pct: number;
  benchmarkPct?: number;
  deviationPp?: number;
  outlier: boolean;
}

export interface EmFamilyStat {
  family: "new" | "established";
  total: number;
  levels: EmLevelStat[];
  weightedAverageLevel: number;
  highLevelConcentrationPct: number; // share at levels 4-5
}

export interface EmDistribution {
  families: EmFamilyStat[];
  totalEmServices: number;
  byProvider: Array<{ npi: string; total: number; weightedAverageLevel: number }>;
  downcoding: { compared: number; downcoded: number; upcoded: number; ratePct: number } | null;
}

/** Base procedure code: ERA lines store the SVC composite with modifiers ("99214:25"). */
export const baseCode = baseProcedureCode;

export function emLevel(code: string): number {
  return Number(code.slice(-1));
}

export function familyOf(code: string): "new" | "established" | null {
  if ((NEW_PATIENT_CODES as readonly string[]).includes(code)) return "new";
  if ((ESTABLISHED_PATIENT_CODES as readonly string[]).includes(code)) return "established";
  return null;
}

/** Paid E/M codes per claim, skipping the synthetic "(claim level)" adjustment lines. */
export function paidEmCodesByClaim(eras: Array<{ era: Era }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { era } of eras) {
    for (const claim of era.claims) {
      for (const line of claim.lines) {
        if (line.procedure === "(claim level)") continue;
        const code = baseCode(line.procedure);
        if (!ALL_EM.has(code)) continue;
        out.set(claim.claimId, [...(out.get(claim.claimId) ?? []), code]);
      }
    }
  }
  return out;
}

function buildFamily(
  family: "new" | "established",
  codes: readonly string[],
  counts: Map<string, number>,
  benchmark: Record<string, number> | undefined,
): EmFamilyStat {
  const total = codes.reduce((sum, c) => sum + (counts.get(c) ?? 0), 0);
  const levels: EmLevelStat[] = codes.map((code) => {
    const count = counts.get(code) ?? 0;
    const pct = total === 0 ? 0 : (count / total) * 100;
    const benchmarkPct = benchmark?.[code];
    const deviationPp = benchmarkPct === undefined ? undefined : pct - benchmarkPct;
    return {
      code,
      level: emLevel(code),
      count,
      pct,
      benchmarkPct,
      deviationPp,
      outlier:
        deviationPp !== undefined && deviationPp >= OUTLIER_THRESHOLD_PP && total >= MIN_SAMPLE_FOR_OUTLIER,
    };
  });
  const weighted = total === 0 ? 0 : levels.reduce((sum, l) => sum + l.level * l.count, 0) / total;
  const high = total === 0 ? 0 : (levels.filter((l) => l.level >= 4).reduce((s, l) => s + l.count, 0) / total) * 100;
  return { family, total, levels, weightedAverageLevel: weighted, highLevelConcentrationPct: high };
}

export function computeEmDistribution(
  submitted: SubmittedClaimRecord[],
  eras: Array<{ era: Era }>,
  benchmark?: Record<string, number>,
): EmDistribution {
  const paidByClaim = paidEmCodesByClaim(eras);

  // Prefer submitted claims when present (they carry provider and service date);
  // otherwise fall back to what the remittances show was paid.
  const counts = new Map<string, number>();
  const providerTotals = new Map<string, { total: number; levelSum: number }>();
  const useSubmitted = submitted.length > 0;

  if (useSubmitted) {
    for (const claim of submitted) {
      for (const raw of claim.codes) {
        const code = baseCode(raw);
        if (!ALL_EM.has(code)) continue;
        counts.set(code, (counts.get(code) ?? 0) + 1);
        if (claim.renderingProviderNpi) {
          const slot = providerTotals.get(claim.renderingProviderNpi) ?? { total: 0, levelSum: 0 };
          slot.total += 1;
          slot.levelSum += emLevel(code);
          providerTotals.set(claim.renderingProviderNpi, slot);
        }
      }
    }
  } else {
    for (const codes of paidByClaim.values()) {
      for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }

  // Downcoding: same claim, submitted level vs paid level within the same family.
  let compared = 0;
  let downcoded = 0;
  let upcoded = 0;
  for (const claim of submitted) {
    const paid = paidByClaim.get(claim.claimId);
    if (!paid) continue;
    for (const raw of claim.codes) {
      const code = baseCode(raw);
      const fam = familyOf(code);
      if (!fam) continue;
      const match = paid.find((p) => familyOf(p) === fam);
      if (!match) continue;
      compared++;
      if (emLevel(match) < emLevel(code)) downcoded++;
      else if (emLevel(match) > emLevel(code)) upcoded++;
    }
  }

  return {
    families: [
      buildFamily("new", NEW_PATIENT_CODES, counts, benchmark),
      buildFamily("established", ESTABLISHED_PATIENT_CODES, counts, benchmark),
    ],
    totalEmServices: [...counts.values()].reduce((a, b) => a + b, 0),
    byProvider: [...providerTotals.entries()]
      .map(([npi, v]) => ({ npi, total: v.total, weightedAverageLevel: v.levelSum / v.total }))
      .sort((a, b) => b.weightedAverageLevel - a.weightedAverageLevel),
    downcoding: compared === 0 ? null : { compared, downcoded, upcoded, ratePct: (downcoded / compared) * 100 },
  };
}

export function renderDistribution(dist: EmDistribution, benchmarkSource: string): string {
  if (dist.totalEmServices === 0) {
    return "No E/M services found. Record claims with claim_build_837p and parse remittances with era_parse_835 to build a distribution.";
  }
  const out: string[] = [`E/M utilization — ${dist.totalEmServices} service(s). Benchmark: ${benchmarkSource}`];

  for (const fam of dist.families) {
    if (fam.total === 0) continue;
    out.push("", `${fam.family === "new" ? "New" : "Established"} patient (n=${fam.total}):`);
    for (const l of fam.levels) {
      const bench =
        l.benchmarkPct === undefined
          ? ""
          : `  vs benchmark ${l.benchmarkPct.toFixed(1)}% (${l.deviationPp! >= 0 ? "+" : ""}${l.deviationPp!.toFixed(1)} pp)`;
      out.push(`  ${l.code}  ${String(l.count).padStart(5)}  ${l.pct.toFixed(1).padStart(5)}%${bench}${l.outlier ? "  ** OUTLIER **" : ""}`);
    }
    out.push(
      `  Weighted average level: ${fam.weightedAverageLevel.toFixed(2)} · level 4-5 concentration: ${fam.highLevelConcentrationPct.toFixed(1)}%`,
    );
    if (fam.total < MIN_SAMPLE_FOR_OUTLIER) {
      out.push(`  (n < ${MIN_SAMPLE_FOR_OUTLIER} — too few services to call an outlier; shape shown for information only)`);
    }
  }

  if (dist.byProvider.length > 1) {
    out.push("", "By rendering provider (highest average level first):");
    for (const p of dist.byProvider) {
      out.push(`  ${p.npi}  n=${p.total}  avg level ${p.weightedAverageLevel.toFixed(2)}`);
    }
    out.push("  Wide spread between providers in the same specialty is itself an audit trigger — review the outliers' documentation.");
  }

  if (dist.downcoding) {
    const d = dist.downcoding;
    out.push(
      "",
      `Submitted vs paid: ${d.compared} comparable service(s), ${d.downcoded} downcoded by the payer (${d.ratePct.toFixed(1)}%), ${d.upcoded} paid at a higher level.`,
      d.ratePct > 10
        ? "  A downcoding rate this high means payers are disagreeing with the levels billed — review documentation before it becomes a probe."
        : "  Downcoding rate is within a normal range.",
    );
  }

  const anyOutlier = dist.families.some((f) => f.levels.some((l) => l.outlier));
  out.push(
    "",
    anyOutlier
      ? "At least one level exceeds benchmark by a wide margin. This is not proof of miscoding — high acuity can justify a skewed curve — but it is what a payer's data mining flags, so make sure the documentation supports it."
      : "No level exceeds the benchmark threshold.",
  );
  return out.join("\n");
}

function loadBenchmarkFile(): Record<string, number> | null {
  const p = path.join(configDir(), "data", "em-benchmark.json");
  try {
    return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, number>) : null;
  } catch {
    return null;
  }
}

interface ClaimRow {
  claim_json: string;
}

export function loadSubmittedClaims(store: MemoryStore): SubmittedClaimRecord[] {
  const rows = store.db.prepare("SELECT claim_json FROM claims ORDER BY created_at ASC").all() as ClaimRow[];
  const out: SubmittedClaimRecord[] = [];
  for (const r of rows) {
    try {
      const c = JSON.parse(r.claim_json) as {
        claim_id: string;
        rendering_provider_npi?: string;
        billing_provider_npi?: string;
        service_lines?: Array<{ cpt_hcpcs: string; service_date?: string }>;
      };
      out.push({
        claimId: c.claim_id,
        renderingProviderNpi: c.rendering_provider_npi ?? c.billing_provider_npi,
        serviceDate: c.service_lines?.[0]?.service_date,
        codes: (c.service_lines ?? []).map((l) => l.cpt_hcpcs),
      });
    } catch {
      // Skip unparseable rows rather than failing the whole report.
    }
  }
  return out;
}

export const emBenchmarkTool = defineTool({
  name: "em_benchmark",
  description:
    "Analyze this practice's E/M level distribution (99202-99215) against a peer benchmark — the bell-curve analysis payers and the OIG use to select audit targets. Reports per-level shares, weighted average level, level 4-5 concentration, per-provider variance, and how often payers downcoded what was billed. Works without benchmark data (internal shape only); install ~/.aetheraclaw/data/em-benchmark.json from the CMS 'Medicare Physician & Other Practitioners' public use file, or pass a benchmark inline, for peer comparison.",
  schema: z.object({
    benchmark: z
      .record(z.number())
      .optional()
      .describe('Inline benchmark percentages by code, e.g. {"99213": 38.2, "99214": 41.5}'),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "store service unavailable", isError: true };

    const benchmark = input.benchmark ?? loadBenchmarkFile() ?? undefined;
    const source = input.benchmark
      ? "supplied inline"
      : benchmark
        ? "~/.aetheraclaw/data/em-benchmark.json"
        : "none installed — internal analysis only (no peer comparison)";

    const submitted = loadSubmittedClaims(store);
    const eras = loadEras(store);
    const dist = computeEmDistribution(submitted, eras, benchmark);

    const provenance =
      submitted.length > 0
        ? `Source: ${submitted.length} recorded claim(s) (submitted levels, with provider attribution) + ${eras.length} remittance(s).`
        : `Source: ${eras.length} remittance(s) only — paid levels, no provider attribution and no service dates. Record claims with claim_build_837p for a richer breakdown.`;

    return { content: `${provenance}\n\n${renderDistribution(dist, source)}` };
  },
});
