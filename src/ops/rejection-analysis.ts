import { STATUS_CODES } from "../tools/healthcare/x12/277ca.js";
import { proportionsDiffer } from "./drift.js";

// ── Clearinghouse rejection analysis ─────────────────────────────────────────
// ack_parse_277ca reads one acknowledgment. This reads all of them together,
// for one specific purpose: catching an edit change on the day it starts rather
// than the week somebody notices the backlog.
//
// A clearinghouse or payer front end tightens an edit without announcing it, and
// what a practice sees is claims that submitted fine on Tuesday rejecting on
// Wednesday for a status code nobody had seen before. Every one of them is
// recoverable — a front-end rejection never entered adjudication — but only
// while somebody is looking, because timely filing keeps running and there are
// no appeal rights to fall back on.
//
// The same statistical discipline as ops_policy_drift_check: a rate needs a
// denominator, and a spike below a real sample is noise. An alerting tool that
// cries wolf gets muted, and a muted alerter misses the change it exists for.

export interface RejectionObservation {
  payer: string;
  /** 277CA status code, e.g. "21" — missing or invalid information. */
  statusCode: string;
  entity: string;
  at: number;
}

export interface AcceptanceObservation {
  payer: string;
  at: number;
}

/** Below this in a period, a rejection rate is not a rate. */
export const MIN_ACKS_PER_PERIOD = 20;

/** A code that appeared this many times having never appeared before is new, not noisy. */
export const NEW_CODE_THRESHOLD = 5;

export interface RejectionGroup {
  payer: string;
  statusCode: string;
  description: string;
  fix: string;
  count: number;
  entities: string[];
}

export interface EmergingEdit {
  payer: string;
  statusCode: string;
  description: string;
  fix: string;
  before: number;
  after: number;
  /** True when the code is entirely new in the recent half. */
  brandNew: boolean;
}

export interface RejectionAnalysis {
  totalAcks: number;
  rejected: number;
  accepted: number;
  rejectionRate: number | null;
  groups: RejectionGroup[];
  emerging: EmergingEdit[];
  splitAt: number;
  /** Payers with acknowledgments but too few to rate. */
  thin: string[];
}

function describe(code: string): { description: string; fix: string } {
  const known = STATUS_CODES[code];
  return {
    description: known?.desc ?? "status code not in the bundled 277CA dataset",
    fix: known?.fix ?? "Read the acknowledgment — this code is not one the bundled dataset explains, and guessing at it would send the correction in the wrong direction.",
  };
}

export function analyzeRejections(
  rejections: RejectionObservation[],
  acceptances: AcceptanceObservation[],
): RejectionAnalysis {
  const all = [...rejections.map((r) => r.at), ...acceptances.map((a) => a.at)].sort((a, b) => a - b);
  const splitAt = all.length > 0 ? all[Math.floor(all.length / 2)] : 0;

  // Grouping across the whole window: what is being rejected, and for what.
  const grouped = new Map<string, RejectionGroup>();
  for (const r of rejections) {
    const key = `${r.payer}|${r.statusCode}`;
    const d = describe(r.statusCode);
    const slot = grouped.get(key) ?? { payer: r.payer, statusCode: r.statusCode, ...d, count: 0, entities: [] };
    slot.count++;
    if (r.entity && !slot.entities.includes(r.entity)) slot.entities.push(r.entity);
    grouped.set(key, slot);
  }

  // Emerging: a code whose share of this payer's acknowledgments moved, tested
  // against the denominator rather than eyeballed from a count.
  const byPayer = new Map<string, { beforeN: number; afterN: number; codes: Map<string, { before: number; after: number }> }>();
  const bump = (payer: string, at: number, code?: string) => {
    const slot = byPayer.get(payer) ?? { beforeN: 0, afterN: 0, codes: new Map() };
    const recent = at >= splitAt;
    if (recent) slot.afterN++;
    else slot.beforeN++;
    if (code) {
      const c = slot.codes.get(code) ?? { before: 0, after: 0 };
      if (recent) c.after++;
      else c.before++;
      slot.codes.set(code, c);
    }
    byPayer.set(payer, slot);
  };
  for (const a of acceptances) bump(a.payer, a.at);
  for (const r of rejections) bump(r.payer, r.at, r.statusCode);

  const emerging: EmergingEdit[] = [];
  const thin: string[] = [];
  for (const [payer, p] of byPayer) {
    if (p.beforeN < MIN_ACKS_PER_PERIOD || p.afterN < MIN_ACKS_PER_PERIOD) {
      thin.push(`${payer} (${p.beforeN}/${p.afterN})`);
      continue;
    }
    for (const [code, c] of p.codes) {
      // A code that never appeared and now appears repeatedly is the clearest
      // signal there is — no proportion test needed, and applying one would
      // suppress exactly the case this tool exists for.
      const brandNew = c.before === 0 && c.after >= NEW_CODE_THRESHOLD;
      if (!brandNew && !proportionsDiffer(c.before, p.beforeN, c.after, p.afterN)) continue;
      if (c.after <= c.before) continue; // only rises matter here
      emerging.push({ payer, statusCode: code, ...describe(code), before: c.before, after: c.after, brandNew });
    }
  }

  const total = rejections.length + acceptances.length;
  return {
    totalAcks: total,
    rejected: rejections.length,
    accepted: acceptances.length,
    rejectionRate: total >= MIN_ACKS_PER_PERIOD ? rejections.length / total : null,
    groups: [...grouped.values()].sort((a, b) => b.count - a.count),
    emerging: emerging.sort((a, b) => Number(b.brandNew) - Number(a.brandNew) || b.after - a.after),
    splitAt,
    thin,
  };
}

export function renderRejectionAnalysis(a: RejectionAnalysis, limit = 12): string {
  if (a.totalAcks === 0) {
    return "No acknowledgments recorded. This reads 277CA outcomes — acceptances banked to filing_proof and rejections opened as worklist items — so parse acknowledgments with ack_parse_277ca first.";
  }

  const lines = [
    `${a.totalAcks} acknowledgment(s): ${a.accepted} accepted, ${a.rejected} rejected` +
      (a.rejectionRate !== null ? ` (${(a.rejectionRate * 100).toFixed(1)}%)` : " — too few to state a rate"),
  ];

  if (a.emerging.length > 0) {
    lines.push(
      "",
      `EMERGING EDITS — ${a.emerging.length}. A front end tightened something and did not say so:`,
      "",
    );
    for (const e of a.emerging) {
      lines.push(
        `  ${e.payer} · status ${e.statusCode}${e.brandNew ? "  [NEW — never seen before this window]" : `  ${e.before} → ${e.after}`}`,
        `      ${e.description}`,
        `      ${e.fix}`,
      );
    }
    lines.push(
      "",
      "Every one of these is recoverable — a front-end rejection never entered adjudication, so nothing was decided and nothing is being appealed. But there are no appeal rights to fall back on either, and timely filing kept running the whole time. Correct the template or the upstream field once and the whole group clears.",
    );
  }

  if (a.groups.length > 0) {
    lines.push("", "All rejections by payer and reason:", "");
    for (const g of a.groups.slice(0, limit)) {
      lines.push(
        `  ${String(g.count).padStart(5)} × ${g.payer} status ${g.statusCode} — ${g.description}`,
        `          ${g.entities.length > 0 ? `whose data: ${g.entities.join(", ")}` : "entity not stated"}`,
      );
    }
    if (a.groups.length > limit) lines.push(`  … and ${a.groups.length - limit} more group(s).`);
  }

  if (a.thin.length > 0) {
    lines.push(
      "",
      `Not tested for emerging edits: ${a.thin.join(", ")} — fewer than ${MIN_ACKS_PER_PERIOD} acknowledgments in one half. With counts that small a spike is indistinguishable from an ordinary week, and an alerter nobody trusts gets muted, which is how the real change goes unnoticed too.`,
    );
  }

  lines.push(
    "",
    "The split is by acknowledgment COUNT, not by calendar — equal denominators are what give the comparison its power, so 'before' is the older half of the acknowledgments rather than the older half of the month.",
  );
  return lines.join("\n");
}
