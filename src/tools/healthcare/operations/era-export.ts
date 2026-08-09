import type { Era } from "../x12/835.js";
import { baseProcedureCode, procedureModifiers } from "../x12/segments.js";
import { deriveAllowed } from "../intelligence/variance.js";
import { checkEffect, describeReason } from "../../../reports/reconcile.js";

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
          // A claim-level synthetic line has no service, so there is no allowed
          // amount to compute — deriveAllowed's paid+PR+sequestration formula
          // would show a spurious positive allowed on a row with no charge.
          allowed: isClaimLevel ? 0 : derived.allowed,
          paid: derived.paid,
          patientResponsibility: derived.patientResponsibility,
          contractual: derived.contractual,
          sequestration: derived.sequestration,
          carcs: line.adjustments.map((a) => `${a.group}-${a.carc}`).join(" "),
          rarcs: line.rarcs.join(" "),
          claimStatus: CLAIM_STATUS[claim.statusCode] ?? claim.statusCode,
          // A claim-level row (charge 0, an adjustment amount) cannot satisfy
          // charge = paid + adjustments by construction — same as a PLB row. "n/a"
          // rather than "NO" so era_export does not send the operator hunting to
          // reconcile a row that was never a balance check.
          balanced: isClaimLevel ? "n/a" : derived.balanced ? "yes" : "NO",
        });
      }
    }

    // Provider-level adjustments are not claim rows, and leaving them out is
    // what stopped this file balancing to the deposit. A payer recouping $4,000
    // from a claim paid in March sends a smaller cheque with a PLB explaining
    // it; without these rows the posting file sums to more than the money that
    // actually arrived, and the difference has nowhere to go.
    //
    // The `paid` column carries the SIGNED effect on the cheque — negative for a
    // takeback — so summing the column gives the deposit. Nothing else on the
    // row is populated, because a PLB has no charge, no allowed amount and no
    // procedure to attribute them to.
    for (const adj of era.providerAdjustments ?? []) {
      const reason = describeReason(adj.reasonCode);
      rows.push({
        payer: era.payer,
        claimId: adj.referenceId,
        payerClaimNumber: "",
        procedure: `(provider adjustment ${adj.reasonCode})`,
        modifiers: "",
        units: 0,
        charged: 0,
        allowed: 0,
        paid: round2(checkEffect(adj)),
        patientResponsibility: 0,
        contractual: 0,
        sequestration: 0,
        carcs: "",
        rarcs: "",
        claimStatus: reason.kind,
        // Not a balance check — there is no charge to balance against. "n/a"
        // rather than "yes" so a reader counting balanced rows is not told a
        // PLB row was verified when nothing about it was.
        balanced: "n/a",
      });
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
  /** Provider-level adjustment rows, and their net effect on the deposit. */
  providerAdjustmentRows: number;
  providerAdjustmentTotal: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function isProviderAdjustmentRow(row: PostingRow): boolean {
  return row.procedure.startsWith("(provider adjustment ");
}

export function summarize(rows: PostingRow[]): PostingSummary {
  const plb = rows.filter(isProviderAdjustmentRow);
  return {
    rows: rows.length,
    charged: round2(rows.reduce((s, r) => s + r.charged, 0)),
    allowed: round2(rows.reduce((s, r) => s + r.allowed, 0)),
    // Includes the signed PLB rows, so this figure IS the deposit rather than
    // the sum of what the claims said.
    paid: round2(rows.reduce((s, r) => s + r.paid, 0)),
    patientResponsibility: round2(rows.reduce((s, r) => s + r.patientResponsibility, 0)),
    unbalanced: rows.filter((r) => r.balanced === "NO").length,
    providerAdjustmentRows: plb.length,
    providerAdjustmentTotal: round2(plb.reduce((s, r) => s + r.paid, 0)),
  };
}
