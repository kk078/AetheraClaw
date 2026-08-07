import type { Era } from "../x12/835.js";
import { baseProcedureCode, procedureModifiers } from "../x12/segments.js";
import { deriveAllowed } from "../intelligence/variance.js";

// ── Posting export ───────────────────────────────────────────────────────────
// Parsed remittances into a flat file a practice management or accounting system
// can post from. The allowed amount is recovered with the same function the
// variance engine uses, so a line never posts against one number and gets
// analysed against another.

export interface PostingRow {
  payer: string;
  claimId: string;
  payerClaimNumber: string;
  procedure: string;
  modifiers: string;
  units: number;
  charged: number;
  allowed: number;
  paid: number;
  patientResponsibility: number;
  contractual: number;
  sequestration: number;
  carcs: string;
  rarcs: string;
  claimStatus: string;
  balanced: string;
}

export const POSTING_COLUMNS: Array<keyof PostingRow> = [
  "payer",
  "claimId",
  "payerClaimNumber",
  "procedure",
  "modifiers",
  "units",
  "charged",
  "allowed",
  "paid",
  "patientResponsibility",
  "contractual",
  "sequestration",
  "carcs",
  "rarcs",
  "claimStatus",
  "balanced",
];

const CLAIM_STATUS: Record<string, string> = {
  "1": "paid-primary",
  "2": "paid-secondary",
  "3": "paid-tertiary",
  "4": "denied",
  "19": "processed-primary-forwarded",
  "22": "reversal",
  "23": "not-our-claim-forwarded",
};

export function toPostingRows(eras: Array<{ era: Era }>): PostingRow[] {
  const rows: PostingRow[] = [];
  for (const { era } of eras) {
    for (const claim of era.claims) {
      for (const line of claim.lines) {
        // parse835 records claim-level adjustments as a synthetic line. It is
        // kept here rather than dropped, because those dollars are real and a
        // posting file that silently omits them will not reconcile.
        const isClaimLevel = line.procedure === "(claim level)";
        const derived = deriveAllowed(line);
        rows.push({
          payer: era.payer,
          claimId: claim.claimId,
          payerClaimNumber: claim.payerControlNumber,
          procedure: isClaimLevel ? "(claim level)" : baseProcedureCode(line.procedure),
          modifiers: isClaimLevel ? "" : procedureModifiers(line.procedure).join(" "),
          units: derived.units,
          charged: derived.charged,
          allowed: derived.allowed,
          paid: derived.paid,
          patientResponsibility: derived.patientResponsibility,
          contractual: derived.contractual,
          sequestration: derived.sequestration,
          carcs: line.adjustments.map((a) => `${a.group}-${a.carc}`).join(" "),
          rarcs: line.rarcs.join(" "),
          claimStatus: CLAIM_STATUS[claim.statusCode] ?? claim.statusCode,
          balanced: derived.balanced ? "yes" : "NO",
        });
      }
    }
  }
  return rows;
}

/** RFC 4180 quoting — payer names contain commas often enough to matter. */
export function csvEscape(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: PostingRow[], columns: Array<keyof PostingRow> = POSTING_COLUMNS): string {
  const header = columns.join(",");
  const body = rows.map((row) => columns.map((c) => csvEscape(row[c])).join(","));
  return [header, ...body].join("\n");
}

export interface PostingSummary {
  rows: number;
  charged: number;
  allowed: number;
  paid: number;
  patientResponsibility: number;
  unbalanced: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function summarize(rows: PostingRow[]): PostingSummary {
  return {
    rows: rows.length,
    charged: round2(rows.reduce((s, r) => s + r.charged, 0)),
    allowed: round2(rows.reduce((s, r) => s + r.allowed, 0)),
    paid: round2(rows.reduce((s, r) => s + r.paid, 0)),
    patientResponsibility: round2(rows.reduce((s, r) => s + r.patientResponsibility, 0)),
    unbalanced: rows.filter((r) => r.balanced === "NO").length,
  };
}
