import { z } from "zod";
import { defineTool } from "../../registry.js";
import { finding, type ScrubFinding } from "../finding.js";
import { npiLuhnValid } from "../npi.js";
import { MSP_TYPE_CODES } from "../cob.js";
import { ClaimSchema, type ClaimInput } from "./837.js";
import { parse835, type EraAdjustment, type EraClaim, type EraServiceLine } from "./835.js";
import { baseProcedureCode, envelope, seg, serializeX12, type Segment } from "./segments.js";

// ── Secondary claims (837 with COB loops) ────────────────────────────────────
// A secondary claim is the original claim plus proof of what the primary did
// with it. The primary's adjudication rides in loop 2320 (claim level) and loop
// 2430 (line level); without it the secondary payer has no basis to calculate
// its liability and rejects the claim outright.

const CENT = 0.005; // tolerance for float comparison of money

/**
 * Every service line must satisfy: charge = paid + sum(adjustments).
 * Secondary payers enforce this arithmetic strictly — an out-of-balance line is
 * the single most common reason a secondary claim is rejected up front
 * (277CA status 400), and it is entirely preventable before submission.
 */
export function validateCobBalance(claim: ClaimInput, primary: EraClaim): ScrubFinding[] {
  const out: ScrubFinding[] = [];
  const paidLines = primary.lines.filter((l) => l.procedure !== "(claim level)");

  for (const [i, line] of claim.service_lines.entries()) {
    const n = i + 1;
    const code = baseProcedureCode(line.cpt_hcpcs);
    const match = paidLines.find((l) => baseProcedureCode(l.procedure) === code);
    if (!match) {
      out.push(
        finding(
          "error",
          "cob-line-unmatched",
          `Line ${n} (${line.cpt_hcpcs}) has no matching line in the primary's remittance. Every line billed to the secondary must carry the primary's adjudication for that line.`,
        ),
      );
      continue;
    }
    const adjustments = match.adjustments.reduce((sum, a) => sum + a.amount, 0);
    const balance = match.charged - (match.paid + adjustments);
    if (Math.abs(balance) > CENT) {
      out.push(
        finding(
          "error",
          "cob-line-out-of-balance",
          `Line ${n} (${code}) does not balance: charged $${match.charged.toFixed(2)} but paid $${match.paid.toFixed(2)} + adjustments $${adjustments.toFixed(2)} = $${(match.paid + adjustments).toFixed(2)} (off by $${Math.abs(balance).toFixed(2)}). The secondary payer will reject this — reconcile against the remittance before submitting.`,
        ),
      );
    }
    if (Math.abs(match.charged - line.charge) > CENT) {
      // Not cosmetic: SV1 carries the billed charge while SVD/CAS carry the
      // primary's numbers, so a mismatch emits a line that cannot balance.
      out.push(
        finding(
          "error",
          "cob-charge-mismatch",
          `Line ${n} (${code}) was billed at $${line.charge.toFixed(2)} but the primary adjudicated $${match.charged.toFixed(2)}. Bill the secondary the same charge the primary saw — otherwise SV1 will not balance against the SVD and CAS segments carrying the primary's adjudication.`,
        ),
      );
    }
  }

  const claimAdjustments = primary.lines.flatMap((l) => l.adjustments).reduce((s, a) => s + a.amount, 0);
  const claimBalance = primary.charged - (primary.paid + claimAdjustments);
  if (primary.charged > 0 && Math.abs(claimBalance) > CENT) {
    out.push(
      finding(
        "warning",
        "cob-claim-out-of-balance",
        `Claim level does not balance: charged $${primary.charged.toFixed(2)} vs paid $${primary.paid.toFixed(2)} + adjustments $${claimAdjustments.toFixed(2)}. Check for adjustments the remittance reported at claim level rather than per line.`,
      ),
    );
  }

  if (primary.paid <= 0 && primary.statusCode === "4") {
    out.push(
      finding(
        "info",
        "cob-primary-denied",
        "The primary denied this claim rather than paying it. A secondary claim is still appropriate, but confirm the secondary accepts a denied-primary claim rather than requiring the denial be appealed first.",
      ),
    );
  }
  if (out.length === 0) {
    out.push(finding("info", "cob-balanced", "Primary adjudication balances at every line — the claim is ready for the secondary payer."));
  }
  return out;
}

/** One CAS segment per adjustment group code, carrying up to six reason/amount pairs. */
function casSegments(adjustments: EraAdjustment[]): Segment[] {
  const byGroup = new Map<string, EraAdjustment[]>();
  for (const a of adjustments) byGroup.set(a.group, [...(byGroup.get(a.group) ?? []), a]);
  const out: Segment[] = [];
  for (const [group, list] of byGroup) {
    for (let i = 0; i < list.length; i += 6) {
      const chunk = list.slice(i, i + 6);
      // Each adjustment is a reason/amount/quantity triplet. The quantity is
      // rarely used; X12 requires trailing empty elements be truncated, so the
      // final one is dropped rather than emitted as a dangling separator.
      const elements = chunk.flatMap((a) => [a.carc, a.amount.toFixed(2), ""]);
      while (elements.length > 0 && elements[elements.length - 1] === "") elements.pop();
      out.push(seg("CAS", group, ...elements));
    }
  }
  return out;
}

export interface SecondaryPayerInfo {
  name: string;
  id: string;
  subscriberId: string;
  filingIndicator: string;
  mspTypeCode?: string;
}

export function buildSecondary837(
  claim: ClaimInput,
  primary: EraClaim,
  opts: {
    secondary: SecondaryPayerInfo;
    primaryPayerName: string;
    primaryPayerId: string;
    adjudicationDate: string;
  },
): string {
  const body: Segment[] = [];
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const paidLines = primary.lines.filter((l) => l.procedure !== "(claim level)");

  body.push(seg("BHT", "0019", "00", claim.claim_id, ymd, "0000", "CH"));
  body.push(seg("NM1", "41", "2", claim.billing_provider_name, "", "", "", "", "46", claim.billing_provider_npi));
  body.push(seg("NM1", "40", "2", opts.secondary.name, "", "", "", "", "46", opts.secondary.id));

  // Billing provider hierarchy
  body.push(seg("HL", "1", "", "20", "1"));
  body.push(seg("NM1", "85", "2", claim.billing_provider_name, "", "", "", "", "XX", claim.billing_provider_npi));

  // Subscriber hierarchy — this claim is going to the SECONDARY payer.
  body.push(seg("HL", "2", "1", "22", "0"));
  body.push(seg("SBR", "S", "18", "", "", opts.secondary.mspTypeCode ?? "", "", "", "", opts.secondary.filingIndicator));
  body.push(seg("NM1", "IL", "1", claim.patient_last, claim.patient_first, "", "", "", "MI", opts.secondary.subscriberId));
  body.push(seg("DMG", "D8", claim.patient_dob, claim.patient_sex));
  body.push(seg("NM1", "PR", "2", opts.secondary.name, "", "", "", "", "PI", opts.secondary.id));

  const total = claim.service_lines.reduce((sum, l) => sum + l.charge, 0);
  body.push(
    seg("CLM", claim.claim_id, total.toFixed(2), "", "", `${claim.service_lines[0].place_of_service}:B:1`, "Y", "A", "Y", "Y"),
  );
  body.push(seg("HI", ...claim.diagnoses.map((d, i) => `${i === 0 ? "ABK" : "ABF"}:${d.replace(".", "")}`)));

  // ── Loop 2320: what the PRIMARY payer did ───────────────────────────────
  body.push(seg("SBR", "P", "18", "", "", "", "", "", "", "CI"));
  const claimLevelAdjustments = primary.lines
    .filter((l) => l.procedure === "(claim level)")
    .flatMap((l) => l.adjustments);
  body.push(...casSegments(claimLevelAdjustments));
  body.push(seg("AMT", "D", primary.paid.toFixed(2)));
  body.push(seg("OI", "", "", "Y", "", "", "Y"));
  // 2330A / 2330B — the other subscriber and the other payer
  body.push(seg("NM1", "IL", "1", claim.patient_last, claim.patient_first, "", "", "", "MI", claim.subscriber_id));
  body.push(seg("NM1", "PR", "2", opts.primaryPayerName, "", "", "", "", "PI", opts.primaryPayerId));
  body.push(seg("DTP", "573", "D8", opts.adjudicationDate));

  // ── Service lines, each with loop 2430 line adjudication ────────────────
  claim.service_lines.forEach((line, i) => {
    const code = baseProcedureCode(line.cpt_hcpcs);
    const proc = ["HC", line.cpt_hcpcs, ...(line.modifiers ?? [])].join(":");
    body.push(seg("LX", String(i + 1)));
    body.push(
      seg("SV1", proc, line.charge.toFixed(2), "UN", String(line.units), line.place_of_service, "", (line.dx_pointers ?? [1]).join(":")),
    );
    body.push(seg("DTP", "472", "D8", line.service_date));

    const match = paidLines.find((l) => baseProcedureCode(l.procedure) === code);
    if (match) {
      body.push(seg("SVD", opts.primaryPayerId, match.paid.toFixed(2), proc, "", String(match.units || line.units)));
      body.push(...casSegments(match.adjustments));
      body.push(seg("DTP", "573", "D8", opts.adjudicationDate));
    }
  });

  return serializeX12(
    envelope({
      senderId: "AETHERACLAW",
      receiverId: opts.secondary.id,
      controlNumber: String(Math.abs(hashString(claim.claim_id + "S")) % 1_000_000_000),
      functionalCode: "HC",
      transactionSetId: "837",
      date: ymd.slice(2),
      time: "0000",
      body,
    }),
  );
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Pick the claim being coordinated out of a parsed remittance. */
export function findPrimaryClaim(eraText: string, claimId: string): EraClaim | null {
  const era = parse835(eraText);
  return era.claims.find((c) => c.claimId === claimId) ?? null;
}

export const claimBuildSecondaryTool = defineTool({
  name: "claim_build_secondary",
  description:
    "Generate a secondary 837 claim carrying the primary payer's adjudication in the COB loops (2320 claim level, 2430 line level: SVD, CAS, AMT, DTP*573). Pass the primary's raw 835 and the adjudication is extracted from it rather than re-keyed. Validates the balance rule first — every line must satisfy charge = paid + adjustments, or the secondary payer rejects the claim. When Medicare is the secondary payer, supply the MSP type code from cob_determine_primary. De-identified/test data only.",
  schema: z.object({
    claim: ClaimSchema.describe("The original claim as billed to the primary"),
    primary_era_text: z.string().describe("Raw 835 remittance from the primary payer"),
    primary_claim_id: z.string().optional().describe("Claim ID within the 835; defaults to the claim's own ID"),
    primary_payer_name: z.string(),
    primary_payer_id: z.string(),
    adjudication_date: z.string().describe("YYYYMMDD the primary adjudicated (the remittance/check date)"),
    secondary_payer_name: z.string(),
    secondary_payer_id: z.string(),
    secondary_subscriber_id: z.string().describe("Member ID with the SECONDARY payer (test data only)"),
    secondary_filing_indicator: z.string().default("CI").describe("SBR09 claim filing indicator, e.g. MB for Medicare Part B, CI commercial, BL Blue Cross"),
    msp_type_code: z.string().optional().describe("SBR05 insurance type code when Medicare is secondary, e.g. 12 working aged"),
    skip_balance_check: z.boolean().default(false).describe("Emit the claim even when the balance check fails (not recommended)"),
  }),
  assessRisk: () => ({ level: "confirm", reason: "generate a secondary 837 claim file" }),
  execute: async (input) => {
    const claimId = input.primary_claim_id ?? input.claim.claim_id;
    const primary = findPrimaryClaim(input.primary_era_text, claimId);
    if (!primary) {
      return {
        content: `Claim ${claimId} was not found in the supplied 835. Check the claim ID against the remittance (CLP01) before building the secondary.`,
        isError: true,
      };
    }
    if (!npiLuhnValid(input.claim.billing_provider_npi)) {
      return { content: `billing_provider_npi ${input.claim.billing_provider_npi} fails NPI validation`, isError: true };
    }
    if (input.msp_type_code && !MSP_TYPE_CODES[input.msp_type_code]) {
      return {
        content: `msp_type_code "${input.msp_type_code}" is not a recognized SBR05 insurance type code. Valid: ${Object.keys(MSP_TYPE_CODES).join(", ")}`,
        isError: true,
      };
    }

    const findings = validateCobBalance(input.claim, primary);
    const errors = findings.filter((f) => f.severity === "error");
    const report = findings.map((f) => `[${f.severity.toUpperCase()}] ${f.rule}: ${f.message}`).join("\n");

    if (errors.length > 0 && !input.skip_balance_check) {
      return {
        content: `${report}\n\nSecondary claim NOT generated — ${errors.length} balance error(s) would cause the secondary payer to reject it. Reconcile against the remittance, or pass skip_balance_check to emit anyway.`,
        isError: true,
      };
    }

    const edi = buildSecondary837(input.claim, primary, {
      secondary: {
        name: input.secondary_payer_name,
        id: input.secondary_payer_id,
        subscriberId: input.secondary_subscriber_id,
        filingIndicator: input.secondary_filing_indicator,
        mspTypeCode: input.msp_type_code,
      },
      primaryPayerName: input.primary_payer_name,
      primaryPayerId: input.primary_payer_id,
      adjudicationDate: input.adjudication_date,
    });

    const header = input.msp_type_code
      ? `MSP type ${input.msp_type_code} (${MSP_TYPE_CODES[input.msp_type_code]}) carried in SBR05.`
      : "";
    return { content: [report, header, "", edi].filter(Boolean).join("\n") };
  },
});

export const cobBalanceCheckTool = defineTool({
  name: "cob_balance_check",
  description:
    "Check whether a primary payer's adjudication balances line by line (charge = paid + adjustments) before building a secondary claim. Out-of-balance lines are the most common cause of secondary-claim rejection and are fully preventable.",
  schema: z.object({
    claim: ClaimSchema,
    primary_era_text: z.string(),
    primary_claim_id: z.string().optional(),
  }),
  execute: async (input) => {
    const claimId = input.primary_claim_id ?? input.claim.claim_id;
    const primary = findPrimaryClaim(input.primary_era_text, claimId);
    if (!primary) return { content: `Claim ${claimId} not found in the supplied 835.`, isError: true };
    const findings = validateCobBalance(input.claim, primary);
    const errors = findings.filter((f) => f.severity === "error").length;
    return {
      content: [
        ...findings.map((f) => `[${f.severity.toUpperCase()}] ${f.rule}: ${f.message}`),
        "",
        errors === 0 ? "Ready to bill the secondary payer." : `${errors} error(s) must be resolved before the secondary claim will be accepted.`,
      ].join("\n"),
    };
  },
});

export type { EraServiceLine };
