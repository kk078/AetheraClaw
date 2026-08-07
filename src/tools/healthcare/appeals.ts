import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "../registry.js";
import { confinePath } from "../path-guard.js";
import { CARC } from "./denial-codes.js";

export const appealDraftTool = defineTool({
  name: "appeal_draft",
  description:
    "Draft a denial appeal letter from denial details and supporting policy citations. Writes a Markdown letter into the workspace for review/editing. Look up applicable NCD/LCD language with the coverage tools first and pass citations in.",
  schema: z.object({
    payer_name: z.string(),
    claim_id: z.string(),
    patient_reference: z.string().describe("De-identified patient reference, e.g. 'Patient A / test data'"),
    service_description: z.string(),
    service_date: z.string(),
    carc: z.string().describe("Denial CARC code"),
    denial_reason_text: z.string().optional(),
    clinical_summary: z.string().describe("De-identified clinical justification for the service"),
    policy_citations: z.array(z.string()).optional().describe("NCD/LCD IDs and quoted policy language supporting coverage"),
    output_path: z.string().default("appeals/appeal.md").describe("Workspace-relative output file"),
  }),
  assessRisk: (input) => ({ level: "confirm", reason: `write appeal letter to ${input.output_path}` }),
  execute: async (input, ctx) => {
    const carcInfo = CARC[input.carc];
    const letter = `# Appeal of Claim Denial — ${input.claim_id}

**To:** ${input.payer_name} — Appeals Department
**Re:** ${input.patient_reference}
**Claim:** ${input.claim_id} · Service date: ${input.service_date}
**Denial reason:** CARC ${input.carc}${carcInfo ? ` — ${carcInfo.desc}` : ""}${input.denial_reason_text ? ` ("${input.denial_reason_text}")` : ""}

To Whom It May Concern:

We are appealing the denial of the above-referenced claim for **${input.service_description}**. We respectfully request reconsideration and payment based on the clinical facts and applicable coverage policy below.

## Clinical justification

${input.clinical_summary}

## Applicable coverage policy

${(input.policy_citations ?? ["(attach applicable NCD/LCD citations)"]).map((c) => `- ${c}`).join("\n")}

## Request

The documentation establishes that the service was reasonable and medically necessary under the cited policy. We request the denial be overturned and the claim processed for payment. Supporting records are available on request.

Sincerely,

_${"{billing office signature block}"}_
`;
    const p = confinePath(ctx.workspaceRoot, input.output_path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, letter);
    return { content: `Appeal letter drafted at ${input.output_path}:\n\n${letter.slice(0, 1500)}` };
  },
});

export const abnGenerateTool = defineTool({
  name: "abn_generate",
  description:
    "Generate an Advance Beneficiary Notice of Noncoverage (ABN, CMS-R-131 content layout) when Medicare is expected to deny a service — shifts liability to the beneficiary if properly executed BEFORE the service. Writes Markdown to the workspace.",
  schema: z.object({
    patient_reference: z.string().describe("De-identified reference / test data"),
    service_description: z.string(),
    reason_medicare_may_not_pay: z.string().describe("e.g. 'Medicare does not pay for this test for your condition (per LCD Lxxxxx)'"),
    estimated_cost: z.number(),
    output_path: z.string().default("abn/abn.md"),
  }),
  assessRisk: (input) => ({ level: "confirm", reason: `write ABN to ${input.output_path}` }),
  execute: async (input, ctx) => {
    const doc = `# Advance Beneficiary Notice of Noncoverage (ABN)
*(Content per Form CMS-R-131 — render onto the official form for actual use)*

**Notifier:** {practice name}
**Patient:** ${input.patient_reference}
**Identification number:** {internal ref — do not use Medicare number}

**NOTE:** If Medicare doesn't pay for **${input.service_description}** below, you may have to pay.

| Item/Service | Reason Medicare May Not Pay | Estimated Cost |
|---|---|---|
| ${input.service_description} | ${input.reason_medicare_may_not_pay} | $${input.estimated_cost.toFixed(2)} |

## Options (patient must choose ONE and sign BEFORE the service)
- **Option 1.** I want the service. I want Medicare billed (official decision; I may appeal). I understand I may be billed if Medicare doesn't pay. *(Bill with modifier GA)*
- **Option 2.** I want the service, but do not bill Medicare. I am responsible for payment. *(Modifier GX/GY context)*
- **Option 3.** I don't want the service.

**Signature:** ______________________  **Date:** ____________
`;
    const p = confinePath(ctx.workspaceRoot, input.output_path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, doc);
    return { content: `ABN drafted at ${input.output_path}. Remember: an ABN is only valid if signed BEFORE the service is furnished; bill with the matching modifier (GA).` };
  },
});
