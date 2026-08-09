import type { ClaimInput } from "../tools/healthcare/x12/837.js";
import type { StoredClaim } from "./aggregate.js";

// ── Work RVU productivity ────────────────────────────────────────────────────
// Newly computable: the MPFS relative value file is installed, and it was not
// before. Nothing in this system reported provider productivity at all.
//
// WORK RVU ONLY, NEVER TOTAL. Compensation formulae are written against work
// RVU. Total RVU is work + practice expense + malpractice and runs to roughly
// twice the figure, so quoting it inflates every number in a compensation
// conversation while looking entirely plausible.

export interface RvuRow {
  work: number;
  pe?: number;
  facilityPe?: number;
  mp?: number;
}

export type RvuTable = Record<string, RvuRow>;

/**
 * Modifiers that change how much of the global work belongs to this provider.
 *
 * These are NOT applied. Each carries a real multiplier — an assistant surgeon
 * is paid a fraction of the work, co-surgeons split it, a surgical-care-only
 * split divides the global package — and applying them needs payer-specific
 * percentages this system does not hold. So the lines are counted and named,
 * and the report says the figure for them is unadjusted. A silently unadjusted
 * multiplier is an overstatement nobody can see; a named one is a caveat
 * somebody can act on.
 */
export const WORK_MODIFYING_MODIFIERS: Record<string, string> = {
  "80": "assistant surgeon",
  "81": "minimum assistant surgeon",
  "82": "assistant surgeon (no resident available)",
  AS: "assistant at surgery (PA/NP/CNS)",
  "62": "two surgeons",
  "66": "surgical team",
  "50": "bilateral procedure",
  "52": "reduced services",
  "53": "discontinued procedure",
  "54": "surgical care only",
  "55": "postoperative management only",
  "56": "preoperative management only",
};

/** Technical component: equipment and staff, no physician work at all. */
export const TECHNICAL_COMPONENT = "TC";

export interface ProviderWrvu {
  /** Rendering NPI where the claim names one, billing NPI otherwise. */
  npi: string;
  /**
   * The ORGANISATION the work was billed under, not the provider's own name.
   *
   * The 837 carries a name for the billing provider and only an NPI for the
   * rendering one, so there is no individual name to print here. Labelling this
   * column "provider" put the clinic's name against a rendering NPI, which reads
   * as an identification and is not one.
   */
  billedUnder: string;
  /** True when every line was attributed by billing NPI because no rendering NPI was given. */
  billingNpiOnly: boolean;
  workRvu: number;
  claims: number;
  lines: number;
  units: number;
  /** Lines whose code is absent from the fee schedule: excluded from workRvu, never zeroed. */
  unpricedLines: number;
  unpricedCodes: string[];
  /** Lines carrying TC — real work for somebody, but not physician work. */
  technicalLines: number;
  /** Lines whose modifiers change the share of work, included here unadjusted. */
  unadjustedLines: number;
  unadjustedModifiers: string[];
}

export interface WrvuReport {
  from: string;
  to: string;
  providers: ProviderWrvu[];
  totalWorkRvu: number;
  claimsMeasured: number;
  unpricedLines: number;
  unpricedCodes: string[];
  technicalLines: number;
  unadjustedLines: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function inRange(ymd: string, from: string, to: string): boolean {
  return ymd >= from && ymd <= to;
}

interface Bucket extends ProviderWrvu {
  claimIds: Set<string>;
  unpriced: Set<string>;
  modifiers: Set<string>;
  hasRendering: boolean;
}

function bucketFor(map: Map<string, Bucket>, npi: string, billedUnder: string): Bucket {
  const existing = map.get(npi);
  if (existing) return existing;
  const fresh: Bucket = {
    npi,
    billedUnder,
    billingNpiOnly: true,
    workRvu: 0,
    claims: 0,
    lines: 0,
    units: 0,
    unpricedLines: 0,
    unpricedCodes: [],
    technicalLines: 0,
    unadjustedLines: 0,
    unadjustedModifiers: [],
    claimIds: new Set(),
    unpriced: new Set(),
    modifiers: new Set(),
    hasRendering: false,
  };
  map.set(npi, fresh);
  return fresh;
}

/** Codes are billed with and without a decimal and in either case; the fee schedule is upper-case and bare. */
function normalizeProcedure(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Work RVUs by provider over a date range.
 *
 * Filtered on the LINE's date of service, not on when the claim was created:
 * productivity belongs to the month the work was done, and a claim entered late
 * would otherwise land in the wrong period and quietly move RVUs between them.
 */
export function computeWrvu(claims: StoredClaim[], rvu: RvuTable, from: string, to: string): WrvuReport {
  const buckets = new Map<string, Bucket>();

  for (const stored of claims) {
    const claim: ClaimInput = stored.claim;
    const npi = (claim.rendering_provider_npi ?? "").trim() || claim.billing_provider_npi.trim();
    if (!npi) continue;
    const bucket = bucketFor(buckets, npi, claim.billing_provider_name);
    if (claim.rendering_provider_npi?.trim()) bucket.hasRendering = true;

    for (const line of claim.service_lines) {
      if (!inRange(line.service_date, from, to)) continue;
      bucket.claimIds.add(stored.claimId);
      bucket.lines++;
      // A code billed x3 is three times the work. Missing this understates every
      // procedural specialty and nothing else, which makes it hard to notice.
      const units = line.units ?? 1;
      bucket.units += units;

      const modifiers = (line.modifiers ?? []).map((m) => m.trim().toUpperCase());
      if (modifiers.includes(TECHNICAL_COMPONENT)) {
        // No physician work at all. Charging the global work RVU here would
        // credit a radiologist for the scanner.
        bucket.technicalLines++;
        continue;
      }

      const row = rvu[normalizeProcedure(line.cpt_hcpcs)];
      if (!row || typeof row.work !== "number") {
        // EXCLUDED AND COUNTED, never treated as zero. Unpriced codes are real
        // work — a silent zero understates a provider's month and looks exactly
        // like a quiet one.
        bucket.unpricedLines++;
        bucket.unpriced.add(normalizeProcedure(line.cpt_hcpcs));
        continue;
      }

      const modifying = modifiers.filter((m) => m in WORK_MODIFYING_MODIFIERS);
      if (modifying.length > 0) {
        bucket.unadjustedLines++;
        for (const m of modifying) bucket.modifiers.add(m);
      }
      bucket.workRvu += row.work * units;
    }
  }

  const providers: ProviderWrvu[] = [...buckets.values()]
    .filter((b) => b.lines > 0)
    .map((b) => ({
      npi: b.npi,
      billedUnder: b.billedUnder,
      billingNpiOnly: !b.hasRendering,
      workRvu: round2(b.workRvu),
      claims: b.claimIds.size,
      lines: b.lines,
      units: b.units,
      unpricedLines: b.unpricedLines,
      unpricedCodes: [...b.unpriced].sort(),
      technicalLines: b.technicalLines,
      unadjustedLines: b.unadjustedLines,
      unadjustedModifiers: [...b.modifiers].sort(),
    }))
    .sort((a, b) => b.workRvu - a.workRvu || a.npi.localeCompare(b.npi));

  return totalsFor(providers, from, to);
}

/**
 * Derive a report's totals from whatever set of providers it holds.
 *
 * Split out because filtering to one NPI in the tool wrapper left the header
 * totals untouched: the summary line read "27.44 across 1 provider" above a
 * single row showing 21.91. Two numbers on one screen, one of them wrong, and
 * nothing to say which.
 */
export function totalsFor(providers: ProviderWrvu[], from: string, to: string): WrvuReport {
  const allUnpriced = new Set<string>();
  for (const p of providers) for (const c of p.unpricedCodes) allUnpriced.add(c);
  return {
    from,
    to,
    providers,
    totalWorkRvu: round2(providers.reduce((s, p) => s + p.workRvu, 0)),
    claimsMeasured: providers.reduce((s, p) => s + p.claims, 0),
    unpricedLines: providers.reduce((s, p) => s + p.unpricedLines, 0),
    unpricedCodes: [...allUnpriced].sort(),
    technicalLines: providers.reduce((s, p) => s + p.technicalLines, 0),
    unadjustedLines: providers.reduce((s, p) => s + p.unadjustedLines, 0),
  };
}

/** Narrow a report to one provider, recomputing every derived total. */
export function narrowTo(report: WrvuReport, npi: string): WrvuReport {
  return totalsFor(report.providers.filter((p) => p.npi === npi), report.from, report.to);
}

function ymd(date: string): string {
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

export function renderWrvu(report: WrvuReport, rvuInstalled: boolean): string {
  if (!rvuInstalled) {
    return "The Medicare fee schedule (mpfs.json) is not installed, so work RVUs cannot be computed at all. That is different from a provider having no productivity. Install it with `node scripts/fetch-cms-data.mjs --only=mpfs`.";
  }
  if (report.providers.length === 0) {
    return `No service lines with a date of service between ${ymd(report.from)} and ${ymd(report.to)}.`;
  }

  const out = [
    `Work RVUs, ${ymd(report.from)} to ${ymd(report.to)} — ${report.totalWorkRvu.toFixed(2)} across ${report.providers.length} provider(s), ${report.claimsMeasured} claim(s).`,
    "",
    `${"NPI".padEnd(12)} ${"wRVU".padStart(9)} ${"claims".padStart(7)} ${"lines".padStart(6)} ${"units".padStart(6)}  billed under`,
  ];
  for (const p of report.providers) {
    out.push(
      `${p.npi.padEnd(12)} ${p.workRvu.toFixed(2).padStart(9)} ${String(p.claims).padStart(7)} ${String(p.lines).padStart(6)} ${String(p.units).padStart(6)}  ${p.billedUnder}`,
    );
  }

  out.push(
    "",
    "Work RVU only — not total RVU. Compensation formulae use work RVU; total is roughly double and would inflate every figure here.",
    "The last column is the billing organisation, not the provider's name: an 837 carries a name for the billing provider and only an NPI for the rendering one.",
  );

  if (report.providers.some((p) => p.billingNpiOnly)) {
    // A group practice whose claims carry no rendering NPI gets one row for the
    // whole group. That is not a productivity report, and saying so beats
    // presenting the group total under one doctor's name.
    const names = report.providers.filter((p) => p.billingNpiOnly).map((p) => p.npi);
    out.push(
      "",
      `ATTRIBUTION: ${names.join(", ")} attributed by BILLING NPI — those claims name no rendering provider. In a group practice that credits every provider's work to one NPI.`,
    );
  }

  if (report.unpricedLines > 0) {
    out.push(
      "",
      `${report.unpricedLines} line(s) carry codes absent from the fee schedule and are EXCLUDED, not counted as zero: ${report.unpricedCodes.slice(0, 12).join(", ")}${report.unpricedCodes.length > 12 ? ` (+${report.unpricedCodes.length - 12} more)` : ""}.`,
      "That work happened. The totals above are therefore a floor, not a measurement.",
    );
  }

  if (report.technicalLines > 0) {
    out.push("", `${report.technicalLines} line(s) billed with TC contribute nothing: the technical component carries no physician work.`);
  }

  if (report.unadjustedLines > 0) {
    const mods = [...new Set(report.providers.flatMap((p) => p.unadjustedModifiers))].sort();
    out.push(
      "",
      `${report.unadjustedLines} line(s) carry modifiers that change the share of work owed to this provider (${mods.map((m) => `${m} ${WORK_MODIFYING_MODIFIERS[m]}`).join("; ")}).`,
      "They are included at the FULL global work RVU. The correct percentages are payer-specific and are not held here, so those lines are overstated — treat the figure as an upper bound for the providers involved.",
    );
  }

  return out.join("\n");
}
