import type { CorrespondenceKind } from "./classify.js";

// ── Management reporting from the inbox ──────────────────────────────────────
// Three questions the mailbox can answer that no other table can, each with a
// specific way of being wrong.

export interface CorrespondenceRecord {
  kind: CorrespondenceKind;
  sender: string;
  payer: string;
  claimRefs: string[];
  amountsCents: number[];
  receivedAt: number;
  quarantined: boolean;
  confidence: number;
}

// ── Payer communication latency ──────────────────────────────────────────────

export interface LatencyStat {
  payer: string;
  n: number;
  medianDays: number;
  p90Days: number;
}

/** Below this, a median is one payer's mood rather than its behaviour. */
export const MIN_LATENCY_SAMPLE = 10;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export interface LatencyResult {
  stats: LatencyStat[];
  /** Payers with correspondence but too few matched pairs to report. */
  thin: string[];
  /** Letters naming a claim this database never built. */
  unmatched: number;
}

/**
 * Days from a claim being built to the first correspondence naming it.
 *
 * MEDIAN, not mean. Payer response times have a long tail — one letter that
 * arrived after nine months drags a mean past anything a person would recognise,
 * and the number stops being usable for the thing it is for, which is noticing
 * that a payer got slower.
 *
 * The measurement is honest about what it is: time to the first EMAIL, not to
 * adjudication. A payer that never emails scores nothing here rather than
 * scoring badly, and that is reported as thin rather than hidden.
 */
export function payerLatency(
  correspondence: CorrespondenceRecord[],
  claimBuiltAt: Map<string, number>,
): LatencyResult {
  const firstTouch = new Map<string, { payer: string; at: number }>();
  let unmatched = 0;

  for (const c of correspondence) {
    for (const ref of c.claimRefs) {
      const built = claimBuiltAt.get(ref);
      if (built === undefined) {
        unmatched++;
        continue;
      }
      const existing = firstTouch.get(ref);
      if (!existing || c.receivedAt < existing.at) firstTouch.set(ref, { payer: c.payer || "(unnamed)", at: c.receivedAt });
    }
  }

  const byPayer = new Map<string, number[]>();
  for (const [ref, touch] of firstTouch) {
    const built = claimBuiltAt.get(ref)!;
    const days = Math.max(0, Math.floor((touch.at - built) / 86_400_000));
    byPayer.set(touch.payer, [...(byPayer.get(touch.payer) ?? []), days]);
  }

  const stats: LatencyStat[] = [];
  const thin: string[] = [];
  for (const [payer, days] of byPayer) {
    if (days.length < MIN_LATENCY_SAMPLE) {
      thin.push(`${payer} (${days.length})`);
      continue;
    }
    stats.push({ payer, n: days.length, medianDays: median(days), p90Days: percentile(days, 90) });
  }

  return { stats: stats.sort((a, b) => b.medianDays - a.medianDays), thin, unmatched };
}

// ── Unstructured denial hotspots ─────────────────────────────────────────────

export interface Hotspot {
  payer: string;
  kind: CorrespondenceKind;
  count: number;
  amountCents: number;
}

/**
 * Denials and rejections that arrived by email rather than on an 835.
 *
 * The value here is precisely that these are INVISIBLE to remittance analytics.
 * A practice whose denial rate looks healthy in `analytics_query` while its
 * inbox fills with informal denials has a denial rate that is wrong, and the gap
 * is not discoverable from the 835s by definition — nothing is missing from
 * them, the denials simply never went through them.
 */
export function denialHotspots(correspondence: CorrespondenceRecord[]): Hotspot[] {
  const informal: CorrespondenceKind[] = ["denial", "clearinghouse_rejection"];
  const grouped = new Map<string, Hotspot>();

  for (const c of correspondence) {
    if (!informal.includes(c.kind)) continue;
    const payer = c.payer || c.sender || "(unnamed)";
    const key = `${payer}|${c.kind}`;
    const slot = grouped.get(key) ?? { payer, kind: c.kind, count: 0, amountCents: 0 };
    slot.count++;
    slot.amountCents += c.amountsCents.reduce((a, b) => a + b, 0);
    grouped.set(key, slot);
  }

  return [...grouped.values()].sort((a, b) => b.amountCents - a.amountCents || b.count - a.count);
}

// ── Daily operational briefing ───────────────────────────────────────────────

export interface BriefingInput {
  correspondence: CorrespondenceRecord[];
  /** Urgency counts from the recommendation pass. */
  critical: number;
  high: number;
  /** Letters the classifier could not place confidently. */
  unclassified: number;
  windowHours: number;
}

export interface Briefing {
  ingested: number;
  quarantined: number;
  unclassified: number;
  critical: number;
  high: number;
  reclaimableCents: number;
  hotspots: Hotspot[];
}

export function buildBriefing(input: BriefingInput): Briefing {
  const hotspots = denialHotspots(input.correspondence);
  return {
    ingested: input.correspondence.length,
    quarantined: input.correspondence.filter((c) => c.quarantined).length,
    unclassified: input.unclassified,
    critical: input.critical,
    high: input.high,
    // Only informal denials and rejections. Dollar amounts in a policy bulletin
    // or a revalidation notice are not money anyone can recover, and summing
    // every number in the inbox produces a headline figure that is nonsense.
    reclaimableCents: hotspots.reduce((sum, h) => sum + h.amountCents, 0),
    hotspots,
  };
}

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function renderBriefing(b: Briefing, windowHours: number): string {
  if (b.ingested === 0) {
    return `No operational mail in the last ${windowHours}h. Mail is classified as it is polled, so an empty briefing means nothing arrived — not that nothing needs attention.`;
  }

  const lines = [
    `Operational mail briefing — last ${windowHours}h`,
    "",
    `  Ingested          ${b.ingested}`,
    `  Held (PHI)        ${b.quarantined}${b.quarantined > 0 ? "  — bodies never stored; the facts below came from headers and subjects" : ""}`,
    `  Unplaced          ${b.unclassified}${b.unclassified > 0 ? "  — reported rather than filed into the nearest category" : ""}`,
    "",
    `  CRITICAL          ${b.critical}${b.critical > 0 ? "  — deadline inside a week" : ""}`,
    `  High              ${b.high}`,
  ];

  if (b.hotspots.length > 0) {
    lines.push(
      "",
      `  Informal denials worth ${money(b.reclaimableCents)}, invisible to remittance analytics:`,
      ...b.hotspots.slice(0, 8).map((h) => `    ${money(h.amountCents).padStart(14)}  ${h.count}× ${h.kind.replace(/_/g, " ")} — ${h.payer}`),
      "",
      "  These never went through an 835, so the denial rate in analytics_query is understated by exactly this. The gap is not discoverable from the remittances — nothing is missing from them.",
    );
  }

  if (b.critical > 0) {
    lines.push("", "  The CRITICAL count is the only number here that expires. Everything else keeps until tomorrow.");
  }
  return lines.join("\n");
}

export function renderLatency(result: LatencyResult): string {
  const lines: string[] = [];
  if (result.stats.length === 0 && result.thin.length === 0) {
    lines.push(
      "No correspondence matched to a claim built here, so latency cannot be measured. This compares the date a claim was built against the first email naming it — both halves have to exist.",
    );
    // Deliberately NOT an early return: when nothing matched, the count of
    // letters naming unknown claims is the single most informative fact
    // available, and swallowing it leaves "cannot be measured" looking like an
    // empty mailbox rather than a mailbox full of claims from somewhere else.
  }
  if (result.stats.length > 0) {
    lines.push(
      "Days from claim built to first payer correspondence — median, and the slow tail:",
      "",
      ...result.stats.map((s) => `  ${String(s.medianDays).padStart(4)}d median · ${String(s.p90Days).padStart(4)}d p90  ${s.payer}  (${s.n} claims)`),
      "",
      "Median rather than mean: payer response times have a long tail, and one letter that arrived after nine months drags a mean past anything anyone would recognise — which is exactly when the metric stops being used for the thing it is for.",
    );
  }
  if (result.thin.length > 0) {
    lines.push(
      "",
      `Too few matched claims to report: ${result.thin.join(", ")}. Below ${MIN_LATENCY_SAMPLE} a median is one payer's mood rather than its behaviour.`,
    );
  }
  if (result.unmatched > 0) {
    lines.push(
      "",
      `${result.unmatched} claim reference(s) in correspondence match no claim built here — work done elsewhere, a mis-read id, or another tenant's claim. They are excluded rather than counted as instant responses.`,
    );
  }
  lines.push(
    "",
    "This measures time to the first EMAIL, not to adjudication. A payer that never emails scores nothing here rather than scoring badly.",
  );
  return lines.join("\n");
}
