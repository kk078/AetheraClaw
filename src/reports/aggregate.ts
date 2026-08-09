import type { Era } from "../tools/healthcare/x12/835.js";
import type { ClaimInput } from "../tools/healthcare/x12/837.js";
import { collectPaidLines, deriveAllowed } from "../tools/healthcare/intelligence/variance.js";
import { CARC } from "../tools/healthcare/denial-codes.js";

// ── Practice reporting ───────────────────────────────────────────────────────
// The three numbers a practice actually runs on: what has been billed, what is
// still outstanding and how old it is, and why claims are being denied. All of
// it comes from data the rest of the system already stores, so a report is an
// aggregation rather than a separate bookkeeping exercise.

/** Standard accounts-receivable aging buckets, in days. */
export const AGING_BUCKETS = [30, 60, 90, 120] as const;
export const AGING_LABELS = ["0-30", "31-60", "61-90", "91-120", "120+"] as const;
export type AgingLabel = (typeof AGING_LABELS)[number];

export function bucketFor(ageDays: number): AgingLabel {
  if (ageDays <= 30) return "0-30";
  if (ageDays <= 60) return "31-60";
  if (ageDays <= 90) return "61-90";
  if (ageDays <= 120) return "91-120";
  return "120+";
}

export interface StoredClaim {
  claimId: string;
  payer: string;
  claim: ClaimInput;
  createdAt: number;
  status: string;
}

export interface StoredEra {
  era: Era;
  receivedAt: number;
  payer: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function claimCharge(claim: ClaimInput): number {
  return round2(claim.service_lines.reduce((sum, l) => sum + l.charge * (l.units ?? 1), 0));
}

/** The earliest service date on a claim — where the AR clock actually starts. */
export function earliestServiceDate(claim: ClaimInput): string {
  return claim.service_lines
    .map((l) => l.service_date)
    .filter(Boolean)
    .sort()[0] ?? "";
}

function ymdToMs(ymd: string): number | null {
  if (!/^\d{8}$/.test(ymd)) return null;
  return Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
}

export interface ArRow {
  claimId: string;
  payer: string;
  charge: number;
  serviceDate: string;
  ageDays: number;
  bucket: AgingLabel;
  status: string;
}

export interface ArAging {
  rows: ArRow[];
  byBucket: Record<AgingLabel, { count: number; amount: number }>;
  byPayer: Array<{ payer: string; count: number; amount: number; oldestDays: number }>;
  total: number;
  /** Weighted average age of outstanding dollars. */
  averageAgeDays: number;
  adjudicated: number;
}

/**
 * What is still outstanding, and how old.
 *
 * A claim counts as resolved once a remittance names it — including a denial.
 * A denied claim is no longer accounts receivable: it is a denial to work, and
 * leaving it in AR double-counts it against the denial report.
 *
 * Age runs from the date of SERVICE rather than the date the claim was built,
 * because that is what a payer's filing clock and every AR benchmark measure.
 */
export function computeArAging(claims: StoredClaim[], eras: StoredEra[], now: number): ArAging {
  const adjudicatedIds = new Set<string>();
  for (const { era } of eras) {
    for (const claim of era.claims) adjudicatedIds.add(claim.claimId.trim().toUpperCase());
  }

  const rows: ArRow[] = [];
  for (const stored of claims) {
    if (adjudicatedIds.has(stored.claimId.trim().toUpperCase())) continue;
    const serviceDate = earliestServiceDate(stored.claim);
    const startMs = ymdToMs(serviceDate) ?? stored.createdAt;
    const ageDays = Math.max(0, Math.floor((now - startMs) / 86_400_000));
    rows.push({
      claimId: stored.claimId,
      payer: stored.payer || stored.claim.payer_name || "(unknown)",
      charge: claimCharge(stored.claim),
      serviceDate,
      ageDays,
      bucket: bucketFor(ageDays),
      status: stored.status,
    });
  }

  const byBucket = Object.fromEntries(AGING_LABELS.map((l) => [l, { count: 0, amount: 0 }])) as ArAging["byBucket"];
  const payers = new Map<string, { count: number; amount: number; oldestDays: number }>();
  for (const row of rows) {
    byBucket[row.bucket].count++;
    byBucket[row.bucket].amount = round2(byBucket[row.bucket].amount + row.charge);
    const slot = payers.get(row.payer) ?? { count: 0, amount: 0, oldestDays: 0 };
    slot.count++;
    slot.amount = round2(slot.amount + row.charge);
    slot.oldestDays = Math.max(slot.oldestDays, row.ageDays);
    payers.set(row.payer, slot);
  }

  const total = round2(rows.reduce((sum, r) => sum + r.charge, 0));
  const weighted = rows.reduce((sum, r) => sum + r.charge * r.ageDays, 0);

  return {
    rows: rows.sort((a, b) => b.ageDays - a.ageDays),
    byBucket,
    byPayer: [...payers.entries()]
      .map(([payer, v]) => ({ payer, ...v }))
      .sort((a, b) => b.amount - a.amount),
    total,
    averageAgeDays: total > 0 ? Math.round(weighted / total) : 0,
    adjudicated: adjudicatedIds.size,
  };
}

export interface DenialRow {
  carc: string;
  description: string;
  category: string;
  count: number;
  amount: number;
}

export interface DenialSummary {
  lines: number;
  deniedLines: number;
  denialRate: number;
  charged: number;
  paid: number;
  byCarc: DenialRow[];
  byPayer: Array<{ payer: string; lines: number; denied: number; rate: number; amount: number }>;
}

/**
 * Why claims are being denied, by dollars rather than by count.
 *
 * Counting occurrences makes small repetitive edits look like the biggest
 * problem; ranking by the money behind each reason points at the one worth
 * fixing first. Patient-responsibility adjustments are excluded — a deductible
 * is not a denial, and including it would swamp everything else.
 */
export function computeDenialSummary(eras: StoredEra[]): DenialSummary {
  const paidLines = collectPaidLines(eras.map((e) => ({ era: e.era, receivedAt: e.receivedAt })));
  const byCarc = new Map<string, { count: number; amount: number }>();
  const byPayer = new Map<string, { lines: number; denied: number; amount: number }>();

  let charged = 0;
  let paid = 0;
  let deniedLines = 0;

  for (const { era } of eras) {
    for (const claim of era.claims) {
      for (const line of claim.lines) {
        if (line.procedure === "(claim level)") continue;
        const derived = deriveAllowed(line);
        charged += derived.charged;
        paid += derived.paid;
        const denied = claim.statusCode === "4" || (derived.paid <= 0 && derived.contractual > 0);
        if (denied) deniedLines++;

        const payerSlot = byPayer.get(era.payer) ?? { lines: 0, denied: 0, amount: 0 };
        payerSlot.lines++;
        if (denied) {
          payerSlot.denied++;
          payerSlot.amount = round2(payerSlot.amount + derived.charged);
        }
        byPayer.set(era.payer, payerSlot);

        for (const a of line.adjustments) {
          // PR is the patient's share, not a denial reason.
          if (a.group === "PR") continue;
          const slot = byCarc.get(a.carc) ?? { count: 0, amount: 0 };
          slot.count++;
          slot.amount = round2(slot.amount + a.amount);
          byCarc.set(a.carc, slot);
        }
      }
    }
  }

  return {
    lines: paidLines.length,
    deniedLines,
    denialRate: paidLines.length > 0 ? deniedLines / paidLines.length : 0,
    charged: round2(charged),
    paid: round2(paid),
    byCarc: [...byCarc.entries()]
      .map(([carc, v]) => ({
        carc,
        description: CARC[carc]?.desc ?? "(not in the bundled dataset)",
        category: CARC[carc]?.category ?? "unknown",
        ...v,
      }))
      .sort((a, b) => b.amount - a.amount),
    byPayer: [...byPayer.entries()]
      .map(([payer, v]) => ({
        payer: payer || "(unknown)",
        lines: v.lines,
        denied: v.denied,
        rate: v.lines > 0 ? v.denied / v.lines : 0,
        amount: v.amount,
      }))
      .sort((a, b) => b.amount - a.amount),
  };
}

export interface ProductionRow {
  period: string;
  claims: number;
  charges: number;
  lines: number;
}

export interface Production {
  rows: ProductionRow[];
  totalClaims: number;
  totalCharges: number;
  byProcedure: Array<{ code: string; count: number; charges: number }>;
}

/** Charges billed per month, from the date of service. */
export function computeProduction(claims: StoredClaim[]): Production {
  const byPeriod = new Map<string, ProductionRow>();
  const byProcedure = new Map<string, { count: number; charges: number }>();

  for (const stored of claims) {
    const service = earliestServiceDate(stored.claim);
    const period = service ? `${service.slice(0, 4)}-${service.slice(4, 6)}` : "(no service date)";
    const row = byPeriod.get(period) ?? { period, claims: 0, charges: 0, lines: 0 };
    row.claims++;
    row.charges = round2(row.charges + claimCharge(stored.claim));
    row.lines += stored.claim.service_lines.length;
    byPeriod.set(period, row);

    for (const line of stored.claim.service_lines) {
      const code = line.cpt_hcpcs.trim().toUpperCase();
      const slot = byProcedure.get(code) ?? { count: 0, charges: 0 };
      slot.count += line.units ?? 1;
      slot.charges = round2(slot.charges + line.charge * (line.units ?? 1));
      byProcedure.set(code, slot);
    }
  }

  const rows = [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
  return {
    rows,
    totalClaims: rows.reduce((s, r) => s + r.claims, 0),
    totalCharges: round2(rows.reduce((s, r) => s + r.charges, 0)),
    byProcedure: [...byProcedure.entries()]
      .map(([code, v]) => ({ code, ...v }))
      .sort((a, b) => b.charges - a.charges),
  };
}

export interface PracticeReport {
  generatedAt: number;
  ar: ArAging;
  denials: DenialSummary;
  production: Production;
}

export function buildReport(claims: StoredClaim[], eras: StoredEra[], now: number): PracticeReport {
  return {
    generatedAt: now,
    ar: computeArAging(claims, eras, now),
    denials: computeDenialSummary(eras),
    production: computeProduction(claims),
  };
}
