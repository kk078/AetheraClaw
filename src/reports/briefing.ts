import { computeArAging, computeDenialSummary, type StoredClaim, type StoredEra } from "./aggregate.js";
import type { KpiSet } from "./kpi.js";
import {
  daysBetweenYmd,
  filingStatus,
  resolveWindow,
  type FilingWindow,
} from "../tools/healthcare/prediction/timely-filing.js";
import { speakableSummary, toSpeakable } from "../speech/speakable.js";

// ── The two-minute morning briefing ──────────────────────────────────────────
// Every input here already exists somewhere in this system: the KPIs, the AR
// aging, the filing windows, the denials that landed overnight. What did not
// exist was anything that put them in one order — the order of what is lost if
// nobody looks today.
//
// Three rules do most of the work, and each is here because the obvious version
// of this feature gets it wrong:
//
//  1. Order by loss, not by category. A briefing organised as "KPIs, then AR,
//     then denials" leads with a rate that moved a point and buries the three
//     claims whose filing window closes on Thursday. The window closing is the
//     only item on the list that becomes unrecoverable by being ignored, so it
//     goes first, always.
//
//  2. A figure that cannot be computed is a GAP, never a zero. computeExecutiveKpis
//     already refuses to invent numbers and says why in its `note`; those notes
//     are surfaced here as gaps. Saying "net collection rate: zero percent" to
//     somebody at 8am because no remittances are loaded is a lie told in a
//     confident voice, and it is the exact failure this module is built around.
//
//  3. Nothing urgent means say so and stop. A briefing that manufactures three
//     bullet points out of a quiet Tuesday teaches its listener that the
//     briefing is noise, and the one morning it matters they will not be
//     listening.

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function plural(n: number, word: string, suffix = "s"): string {
  return `${n} ${word}${n === 1 ? "" : suffix}`;
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function msToYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * YYYYMMDD → YYYY-MM-DD.
 *
 * Not cosmetic: the speech renderer recognises the dashed form and says
 * "June third, twenty twenty six", while a bare 20260603 is read by every
 * engine as a twenty-million-something number. A deadline nobody can write down
 * is not a deadline.
 */
function ymdToIso(ymd: string): string {
  return /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : ymd;
}

/** How near a filing deadline has to be to count as the critical band. */
export const FILING_JEOPARDY_DAYS = 30;

/** Roughly two minutes of speech at a normal reading pace. */
export const SPOKEN_MAX_CHARS = 1800;

/** Per-item ceiling, so one verbose item cannot eat the whole two minutes. */
export const SPOKEN_ITEM_MAX_CHARS = 400;

/** MGMA's better-performer band for days in A/R sits around here. */
export const DAYS_IN_AR_TARGET = 40;

/** Below this, first-pass payment is a rework problem worth a person's morning. */
export const FIRST_PASS_TARGET = 90;

/** Net collection below this is money being left on the table, not noise. */
export const NCR_TARGET = 95;

/** A remittance newer than this counts as "what changed since yesterday". */
export const CHANGED_WITHIN_DAYS = 1;

export interface BriefingInput {
  kpis: KpiSet;
  claims: StoredClaim[];
  eras: StoredEra[];
  filingWindows: Record<string, unknown>;
  now: number;
  policyChanges?: Array<{ code: string; title: string; url: string }>;
}

export interface BriefingItem {
  urgency: "critical" | "attention" | "informational";
  headline: string;
  detail: string;
  count?: number;
  amount?: number;
  deadlineDays?: number;
}

export interface Briefing {
  items: BriefingItem[];
  spoken: string;
  written: string;
  asOf: number;
  gaps: string[];
}

export interface BriefingOptions {
  /** How near a filing deadline must be to count as jeopardy. Default 30 days. */
  jeopardyDays?: number;
  /** Ceiling on the spoken briefing. Default 1,800 characters. */
  maxSpokenChars?: number;
  /** How far back a remittance still counts as new. Default 1 day. */
  changedWithinDays?: number;
}

/**
 * Urgency ranks, spelled out rather than relying on the alphabetical accident
 * that "attention" < "critical" < "informational" — which would put the money
 * that is about to disappear second.
 */
export const URGENCY_RANK: Record<BriefingItem["urgency"], number> = {
  critical: 0,
  attention: 1,
  informational: 2,
};

/**
 * Order by what is lost if the item is ignored.
 *
 * Urgency first, then deadline proximity, then money. Deadline before money is
 * the whole point: $400 that stops being collectable on Thursday outranks
 * $40,000 that will still be collectable next month, because next month the
 * second one is still there and the first one is not.
 *
 * Items with no deadline sort after items that have one within the same band,
 * and the final comparison is on the headline so the order is total — two runs
 * over the same data must not produce two different briefings.
 */
export function orderItems(items: BriefingItem[]): BriefingItem[] {
  return [...items].sort((a, b) => {
    const rank = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
    if (rank !== 0) return rank;
    const ad = a.deadlineDays ?? Number.POSITIVE_INFINITY;
    const bd = b.deadlineDays ?? Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    const am = a.amount ?? 0;
    const bm = b.amount ?? 0;
    if (am !== bm) return bm - am;
    const ac = a.count ?? 0;
    const bc = b.count ?? 0;
    if (ac !== bc) return bc - ac;
    return a.headline < b.headline ? -1 : a.headline > b.headline ? 1 : 0;
  });
}

/**
 * Accept only entries that actually describe a window.
 *
 * The input type is deliberately `unknown`-valued so the pure function does not
 * depend on how the caller stored its payer policies; a malformed row is
 * dropped here rather than throwing halfway through a briefing.
 */
function windowTable(raw: Record<string, unknown>): Record<string, FilingWindow> {
  const table: Record<string, FilingWindow> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!value || typeof value !== "object") continue;
    const w = value as Partial<FilingWindow>;
    if (typeof w.days === "number" || typeof w.calendarYears === "number") {
      table[key] = {
        payerKey: typeof w.payerKey === "string" ? w.payerKey : key,
        label: typeof w.label === "string" ? w.label : key,
        days: w.days,
        calendarYears: w.calendarYears,
        note: typeof w.note === "string" ? w.note : "",
      };
    }
  }
  return table;
}

interface FilingRow {
  claimId: string;
  payer: string;
  charge: number;
  deadline: string;
  daysRemaining: number;
}

/** Strip anything that would be read out character by character. */
function stripUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/\S+/gi, "").replace(/\bwww\.\S+/gi, "").replace(/\s{2,}/g, " ").trim();
}

/** The spoken form of one item: headline first, so the number leads. */
function spokenItem(item: BriefingItem): string {
  return toSpeakable(stripUrls(`${item.headline}. ${item.detail}`), { maxChars: SPOKEN_ITEM_MAX_CHARS }).text;
}

function factsLine(item: BriefingItem): string {
  const bits: string[] = [];
  if (item.count !== undefined) bits.push(`count ${item.count}`);
  if (item.amount !== undefined) bits.push(money(item.amount));
  if (item.deadlineDays !== undefined) {
    bits.push(
      item.deadlineDays < 0
        ? `${plural(-item.deadlineDays, "day")} past the nearest deadline`
        : `nearest deadline in ${plural(item.deadlineDays, "day")}`,
    );
  }
  return bits.join(" · ");
}

/**
 * The console rendering, built from the same items the spoken version reads.
 *
 * `written` on a Briefing is exactly this function's output, so the two can
 * never drift: there is one list, rendered twice.
 */
export function renderBriefing(b: Briefing): string {
  const lines: string[] = [`Daily briefing — ${new Date(b.asOf).toISOString().slice(0, 10)}`];

  if (b.items.length === 0) {
    lines.push("", QUIET_LINE);
  } else {
    const critical = b.items.filter((i) => i.urgency === "critical").length;
    lines.push(
      `${plural(b.items.length, "item")}, ${critical} critical. Ordered by what is lost if it is ignored, not by category.`,
      "",
    );
    b.items.forEach((item, i) => {
      lines.push(`${i + 1}. [${item.urgency.toUpperCase()}] ${item.headline}`);
      lines.push(`   ${item.detail}`);
      const facts = factsLine(item);
      if (facts) lines.push(`   ${facts}`);
      lines.push("");
    });
  }

  if (b.gaps.length > 0) {
    lines.push(
      "",
      "GAPS — figures that could not be computed. None of these is a zero:",
      ...b.gaps.map((g) => `  - ${g}`),
      "",
      "A missing figure is reported as missing. A zero here would read as 'we collected nothing', which is a different and much worse statement than 'there is nothing to compute it from'.",
    );
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

const QUIET_LINE =
  "Nothing needs a person this morning. No filing window is closing, nothing is past its deadline, and no figure is off target.";

/**
 * Compose the briefing.
 *
 * Everything is derived from the inputs and nothing is fetched, so the same
 * inputs always produce the same briefing — including the order, which is what
 * makes it possible to say "the second item" out loud and be understood.
 */
export function buildBriefing(input: BriefingInput, opts: BriefingOptions = {}): Briefing {
  const jeopardyDays = opts.jeopardyDays ?? FILING_JEOPARDY_DAYS;
  const maxSpoken = opts.maxSpokenChars ?? SPOKEN_MAX_CHARS;
  const changedWithinDays = opts.changedWithinDays ?? CHANGED_WITHIN_DAYS;
  const now = input.now;
  const asOf = msToYmd(now);

  const items: BriefingItem[] = [];
  const gaps: string[] = [];
  const gapLabels: string[] = [];
  const gap = (label: string, why: string) => {
    gaps.push(`${label}: ${why}`);
    gapLabels.push(label);
  };

  // ── Rule 2: nulls become gaps, never zeros ─────────────────────────────────
  // The notes come straight from the KPI module, which already knows why it
  // refused to produce each figure. Rewriting them here would let the reason
  // drift away from the rule that produced it.
  const { daysInAr, cleanClaim, netCollection } = input.kpis;
  const NO_REASON = "Not computable from what is loaded. Reported as a gap rather than as zero.";
  if (daysInAr.days === null) gap("Days in A/R", daysInAr.note || NO_REASON);
  if (cleanClaim.acceptanceRate === null) gap("Front-end acceptance rate", cleanClaim.note || NO_REASON);
  if (cleanClaim.firstPassPaymentRate === null) gap("First-pass payment rate", cleanClaim.note || NO_REASON);
  if (netCollection.rate === null) gap("Net collection rate", netCollection.note || NO_REASON);

  // ── Rule 3: timely filing is the critical band ─────────────────────────────
  // Only claims with no remittance against them are at risk; computeArAging
  // already resolved that question, and resolving it a second way here is how
  // two reports come to disagree about what is outstanding.
  const aging = computeArAging(input.claims, input.eras, now);
  const table = windowTable(input.filingWindows);
  const expired: FilingRow[] = [];
  const closing: FilingRow[] = [];
  let noServiceDate = 0;
  let noWindow = 0;

  for (const row of aging.rows) {
    if (!row.serviceDate) {
      noServiceDate++;
      continue;
    }
    if (!resolveWindow(row.payer, table)) {
      noWindow++;
      continue;
    }
    const status = filingStatus(row.payer, row.serviceDate, { table, asOf });
    if ("error" in status) {
      noWindow++;
      continue;
    }
    const filing: FilingRow = {
      claimId: row.claimId,
      payer: row.payer,
      charge: row.charge,
      deadline: status.deadline,
      daysRemaining: status.daysRemaining,
    };
    if (status.expired) expired.push(filing);
    else if (status.daysRemaining <= jeopardyDays) closing.push(filing);
  }

  const sumCharges = (rows: FilingRow[]) => round2(rows.reduce((s, r) => s + r.charge, 0));
  // The earliest deadline in the group is the one that decides how urgent the
  // group is — an average would let nine comfortable claims hide the tenth.
  const nearestDeadline = (rows: FilingRow[]) => rows.map((r) => r.deadline).sort()[0];

  if (closing.length > 0) {
    const deadline = nearestDeadline(closing);
    const days = daysBetweenYmd(asOf, deadline);
    items.push({
      urgency: "critical",
      headline: `${plural(closing.length, "claim")} inside the final stretch of the filing window`,
      detail: `${money(sumCharges(closing))} stops being collectable if these are not filed. The nearest deadline is ${ymdToIso(deadline)}, ${plural(days, "day")} away. Work these before anything else on this list.`,
      count: closing.length,
      amount: sumCharges(closing),
      deadlineDays: days,
    });
  }

  if (expired.length > 0) {
    const deadline = nearestDeadline(expired);
    const days = daysBetweenYmd(asOf, deadline);
    items.push({
      urgency: "critical",
      headline: `${plural(expired.length, "claim")} past the filing deadline`,
      detail: `${money(sumCharges(expired))} is already outside the window; the oldest closed ${ymdToIso(deadline)}. It is recoverable only with proof the claim was filed in time, so pull the acceptance reports today or write it off deliberately rather than by accident.`,
      count: expired.length,
      amount: sumCharges(expired),
      deadlineDays: days,
    });
  }

  if (noWindow > 0) {
    gap(
      "Filing windows",
      `${plural(noWindow, "outstanding claim")} could not be checked because the payer has no filing window on file. A claim with no window is not being watched at all — add it with timely_filing_set.`,
    );
  }
  if (noServiceDate > 0) {
    gap(
      "Filing windows",
      `${plural(noServiceDate, "outstanding claim")} carries no date of service, so its filing clock cannot be started.`,
    );
  }

  // ── What changed overnight ─────────────────────────────────────────────────
  const changedSince = now - changedWithinDays * 86_400_000;
  const recentEras = input.eras.filter((e) => e.receivedAt > changedSince && e.receivedAt <= now);
  if (recentEras.length > 0) {
    const denials = computeDenialSummary(recentEras);
    const deniedAmount = round2(denials.byPayer.reduce((s, p) => s + p.amount, 0));
    if (denials.deniedLines > 0) {
      const top = denials.byCarc[0];
      items.push({
        urgency: "attention",
        headline: `${plural(denials.deniedLines, "denied line")} arrived on ${plural(recentEras.length, "new remittance")}`,
        detail: `${money(deniedAmount)} of charges came back unpaid.${top ? ` The largest reason is CARC ${top.carc}, ${top.description}.` : ""} Denials have their own clock; the appeal window starts the day the remittance is dated.`,
        count: denials.deniedLines,
        amount: deniedAmount,
      });
    }
  }

  // ── Aged receivable ────────────────────────────────────────────────────────
  const agedAmount = round2(aging.byBucket["91-120"].amount + aging.byBucket["120+"].amount);
  const agedCount = aging.byBucket["91-120"].count + aging.byBucket["120+"].count;
  if (agedAmount > 0) {
    items.push({
      urgency: "attention",
      headline: `${plural(agedCount, "claim")} outstanding more than 90 days`,
      detail: `${money(agedAmount)} of accounts receivable is over 90 days old. Check it against the filing windows before working anything newer; past the window it stops being recoverable at all.`,
      count: agedCount,
      amount: agedAmount,
    });
  }

  // ── KPIs, only when they are both computable and off target ────────────────
  // A KPI that is computable and healthy is not news, and reading it out every
  // morning is how the whole briefing becomes background noise.
  if (daysInAr.days !== null && daysInAr.days > DAYS_IN_AR_TARGET) {
    items.push({
      urgency: "attention",
      headline: `Days in accounts receivable is ${daysInAr.days}, above the ${DAYS_IN_AR_TARGET} day target`,
      detail: `${money(daysInAr.totalAr)} is outstanding against ${money(daysInAr.averageDailyCharges)} of charges a day, averaged over ${plural(daysInAr.chargeWindowDays, "day")}.`,
      amount: daysInAr.totalAr,
    });
  }
  if (cleanClaim.firstPassPaymentRate !== null && cleanClaim.firstPassPaymentRate < FIRST_PASS_TARGET) {
    items.push({
      urgency: "attention",
      headline: `First-pass payment is ${cleanClaim.firstPassPaymentRate.toFixed(1)} percent, below the ${FIRST_PASS_TARGET} percent target`,
      detail: `${cleanClaim.paidFirstPass} of ${plural(cleanClaim.adjudicated, "adjudicated claim")} came back paid without a denial. Front-end acceptance is measured separately, because a coding problem and an enrolment problem do not look alike and a blended number hides which one this is.`,
      count: cleanClaim.adjudicated,
    });
  }
  if (netCollection.rate !== null && netCollection.rate < NCR_TARGET) {
    items.push({
      urgency: "attention",
      headline: `Net collection is ${netCollection.rate.toFixed(1)} percent, below the ${NCR_TARGET} percent target`,
      detail: `${money(netCollection.payments)} collected of ${money(netCollection.collectable)} that was ever collectable, over ${plural(netCollection.claimsMeasured, "settled claim")}.`,
      count: netCollection.claimsMeasured,
      amount: round2(netCollection.collectable - netCollection.payments),
    });
  }

  for (const change of input.policyChanges ?? []) {
    items.push({
      urgency: "informational",
      headline: `Policy change: ${change.title}`,
      // The URL goes last and unlabelled: the speech renderer drops it, and a
      // label left behind ("Source:") is a word the listener hears trailing off
      // into nothing.
      detail: `Affects ${change.code}. ${change.url}`,
    });
  }

  const ordered = orderItems(items);

  // ── Rule 2 again, in the spoken channel ────────────────────────────────────
  // Gaps are named, never valued. The listener hears which figures are missing
  // and is sent to the written briefing for the reason, which is longer than
  // anybody can hold in their head at eight in the morning.
  const uniqueGapLabels = [...new Set(gapLabels)];
  const gapSentence =
    uniqueGapLabels.length > 0
      ? `${plural(uniqueGapLabels.length, "figure")} could not be computed: ${uniqueGapLabels.join(", ")}. Those are gaps, not zeros. The written briefing says why.`
      : "";

  const critical = ordered.filter((i) => i.urgency === "critical").length;
  const leadSource =
    ordered.length === 0
      ? QUIET_LINE
      : `${plural(ordered.length, "item")} this morning${critical > 0 ? `, ${critical} critical` : ""}.`;
  const lead = speakableSummary(leadSource, 240);

  const parts = ordered.map(spokenItem).filter(Boolean);
  const tail = (n: number) =>
    `${plural(n, "further item")} ${n === 1 ? "was" : "were"} not read out. The written briefing has all of them.`;

  // Whole items only. A spoken briefing cut mid-item has no ellipsis to warn
  // the listener — they hear a confident sentence that simply stops, and the
  // half of it they did not hear is the half with the deadline in it.
  let spoken = [lead, gapSentence ? toSpeakable(gapSentence, { maxChars: 600 }).text : ""].filter(Boolean).join(" ");
  let read = 0;
  for (let i = 0; i < parts.length; i++) {
    const remainingAfter = parts.length - (i + 1);
    const reserve = remainingAfter > 0 ? toSpeakable(tail(remainingAfter), { maxChars: 300 }).text.length + 1 : 0;
    if (spoken.length + 1 + parts[i].length + reserve > maxSpoken) break;
    spoken = `${spoken} ${parts[i]}`;
    read++;
  }
  if (read < parts.length) {
    spoken = `${spoken} ${toSpeakable(tail(parts.length - read), { maxChars: 300 }).text}`;
  }

  const briefing: Briefing = { items: ordered, spoken: spoken.trim(), written: "", asOf: now, gaps };
  briefing.written = renderBriefing(briefing);
  return briefing;
}
