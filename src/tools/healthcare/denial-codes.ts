import { z } from "zod";
import { defineTool } from "../registry.js";

// Compact bundled subset of X12 CARC/RARC codes (publicly published lists) with
// actionable guidance categories. Extend data/carc.json for the full set.
export const CARC: Record<string, { desc: string; category: string; action: string }> = {
  "1": { desc: "Deductible amount", category: "patient-responsibility", action: "Bill patient for deductible" },
  "2": { desc: "Coinsurance amount", category: "patient-responsibility", action: "Bill patient for coinsurance" },
  "3": { desc: "Co-payment amount", category: "patient-responsibility", action: "Bill patient copay" },
  "4": { desc: "Procedure code inconsistent with modifier used", category: "coding", action: "Review modifier usage; correct and resubmit" },
  "5": { desc: "Procedure code/type of bill inconsistent with place of service", category: "coding", action: "Verify POS code matches service location" },
  "11": { desc: "Diagnosis inconsistent with procedure", category: "medical-necessity", action: "Check dx-px linkage and applicable LCD; correct dx pointers" },
  "16": { desc: "Claim lacks information or has submission/billing error", category: "registration", action: "Check remark codes for the missing element; correct and resubmit" },
  "18": { desc: "Exact duplicate claim/service", category: "duplicate", action: "Verify original claim status before any resubmission" },
  "22": { desc: "Care may be covered by another payer per coordination of benefits", category: "cob", action: "Verify COB order; bill correct primary payer" },
  "23": { desc: "Impact of prior payer(s) adjudication", category: "cob", action: "Review primary payer 835; bill secondary correctly" },
  "26": { desc: "Expenses incurred prior to coverage", category: "eligibility", action: "Verify eligibility dates; bill patient or correct payer" },
  "27": { desc: "Expenses incurred after coverage terminated", category: "eligibility", action: "Verify termination date; bill new payer or patient" },
  "29": { desc: "Time limit for filing has expired", category: "timely-filing", action: "Appeal with proof of timely submission if available" },
  "31": { desc: "Patient cannot be identified as our insured", category: "registration", action: "Verify member ID and demographics; correct and resubmit" },
  "45": { desc: "Charge exceeds fee schedule/maximum allowable", category: "contractual", action: "Contractual write-off; verify against expected allowed amount" },
  "253": { desc: "Sequestration — reduction in federal payment", category: "regulatory", action: "Not a denial and not a write-off to chase: a 2% cut to the Medicare payment, applied after the allowed amount is set. It does not reduce the allowed amount or the patient's coinsurance, so add it back when deriving what the payer allowed." },
  "50": { desc: "Not deemed a medical necessity by the payer", category: "medical-necessity", action: "Check NCD/LCD criteria; appeal with documentation" },
  "96": { desc: "Non-covered charge(s)", category: "coverage", action: "Check policy/exclusions; ABN may shift liability to patient (Medicare)" },
  "97": { desc: "Payment included in allowance for another service (bundled)", category: "bundling", action: "Check NCCI edits; modifier may be appropriate if distinct service" },
  "109": { desc: "Claim not covered by this payer/contractor", category: "registration", action: "Submit to correct payer/contractor" },
  "119": { desc: "Benefit maximum reached", category: "coverage", action: "Verify benefit limits; bill patient if applicable" },
  "197": { desc: "Precertification/authorization absent", category: "prior-auth", action: "Obtain retro-auth if possible; appeal with clinical documentation" },
  "204": { desc: "Service not covered under the patient's current benefit plan", category: "coverage", action: "Verify benefits; bill patient with proper notice" },
  "252": { desc: "Attachment/documentation required to adjudicate", category: "documentation", action: "Submit requested documentation" },
};

export const RARC: Record<string, string> = {
  M15: "Separately billed services have been bundled.",
  M20: "Missing/incomplete/invalid HCPCS.",
  M51: "Missing/incomplete/invalid procedure code(s).",
  M76: "Missing/incomplete/invalid diagnosis.",
  M77: "Missing/incomplete/invalid place of service.",
  M79: "Missing/incomplete/invalid charge.",
  N29: "Missing documentation/orders/notes/summary/report.",
  N115: "Decision based on a Local Coverage Determination (LCD).",
  N130: "Consult plan benefit documents for coverage terms.",
  N265: "Missing/incomplete/invalid ordering provider primary identifier.",
  N290: "Missing/incomplete/invalid rendering provider primary identifier.",
  N362: "Number of days/units exceeds acceptable maximum.",
  N386: "Decision based on a National Coverage Determination (NCD).",
  N522: "Duplicate of a claim processed or in process.",
};

export function explainDenial(carc: string, rarcs: string[] = []): string {
  const c = CARC[carc];
  const lines: string[] = [];
  if (c) lines.push(`CARC ${carc}: ${c.desc}\nCategory: ${c.category}\nRecommended action: ${c.action}`);
  else lines.push(`CARC ${carc}: not in bundled dataset — consult the X12 CARC list.`);
  for (const r of rarcs) {
    lines.push(RARC[r] ? `RARC ${r}: ${RARC[r]}` : `RARC ${r}: not in bundled dataset.`);
  }
  return lines.join("\n");
}

export const denialExplainTool = defineTool({
  name: "denial_explain",
  description:
    "Explain a claim adjustment/denial: CARC (claim adjustment reason code) plus optional RARC remark codes, with the denial category and recommended next action.",
  schema: z.object({
    carc: z.string().describe("CARC code, e.g. '197'"),
    rarcs: z.array(z.string()).optional().describe("Optional RARC remark codes, e.g. ['N115']"),
  }),
  execute: async (input) => ({ content: explainDenial(input.carc, input.rarcs ?? []) }),
});
