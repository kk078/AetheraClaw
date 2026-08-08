import { z } from "zod";
import { defineTool } from "../../registry.js";
import { npiLuhnValid } from "../npi.js";
import { ComplianceContextSchema } from "../compliance/context.js";
import { newId } from "../../../shared/ids.js";
import { envelope, seg, serializeX12, type Segment } from "./segments.js";

export const ServiceLineSchema = z.object({
  cpt_hcpcs: z.string().describe("Procedure code (CPT/HCPCS)"),
  modifiers: z.array(z.string()).optional(),
  charge: z.number().describe("Charge amount in dollars"),
  units: z.number().default(1),
  dx_pointers: z.array(z.number().int().min(1).max(12)).describe("1-based pointers into the diagnosis list"),
  service_date: z.string().describe("YYYYMMDD"),
  place_of_service: z.string().default("11").describe("2-digit POS code, e.g. 11 office, 22 on-campus outpatient hospital, 02/10 telehealth"),
})
  // Field names here are the wire names, not the words a person would reach for.
  // Models reliably guess `procedure_code`, `cpt`, `dos` or `pos` instead, and a
  // guessed key is stripped before validation, so the failure surfaces as
  // "required field missing" rather than "you used the wrong name". A literal
  // example costs a few tokens and removes the round trip.
  .describe(
    'One service line. Use these exact keys — e.g. {"cpt_hcpcs":"99214","modifiers":["25"],"charge":225,"units":1,"dx_pointers":[1],"service_date":"20260115","place_of_service":"11"}. Not procedure_code/cpt/dos/pos.',
  );

export const ClaimSchema = z.object({
  claim_id: z.string().describe("Patient control number / internal claim ID"),
  payer_name: z.string(),
  payer_id: z.string().describe("Payer EDI ID"),
  billing_provider_npi: z.string(),
  billing_provider_name: z.string(),
  rendering_provider_npi: z.string().optional(),
  subscriber_id: z.string().describe("Member/subscriber ID (use synthetic/test data only)"),
  patient_last: z.string(),
  patient_first: z.string(),
  patient_dob: z.string().describe("YYYYMMDD (synthetic/test data only)"),
  patient_sex: z.enum(["M", "F", "U"]).default("U"),
  diagnoses: z.array(z.string()).min(1).max(12).describe("ICD-10-CM codes, pointer order"),
  service_lines: z.array(ServiceLineSchema).min(1),
  compliance: ComplianceContextSchema.optional().describe(
    "How the service was delivered and supervised — drives telehealth, global-period, incident-to and split/shared checks in claim_scrub. Not emitted on the 837.",
  ),
});

export type ClaimInput = z.infer<typeof ClaimSchema>;

export function build837p(claim: ClaimInput): string {
  const body: Segment[] = [];
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");

  body.push(seg("BHT", "0019", "00", claim.claim_id, ymd, "0000", "CH"));
  // Submitter/receiver
  body.push(seg("NM1", "41", "2", claim.billing_provider_name, "", "", "", "", "46", claim.billing_provider_npi));
  body.push(seg("NM1", "40", "2", claim.payer_name, "", "", "", "", "46", claim.payer_id));
  // Billing provider hierarchy
  body.push(seg("HL", "1", "", "20", "1"));
  body.push(seg("NM1", "85", "2", claim.billing_provider_name, "", "", "", "", "XX", claim.billing_provider_npi));
  // Subscriber hierarchy
  body.push(seg("HL", "2", "1", "22", "0"));
  body.push(seg("SBR", "P", "18", "", "", "", "", "", "", "CI"));
  body.push(
    seg("NM1", "IL", "1", claim.patient_last, claim.patient_first, "", "", "", "MI", claim.subscriber_id),
  );
  body.push(seg("DMG", "D8", claim.patient_dob, claim.patient_sex));
  body.push(seg("NM1", "PR", "2", claim.payer_name, "", "", "", "", "PI", claim.payer_id));
  // Claim
  const total = claim.service_lines.reduce((sum, l) => sum + l.charge, 0);
  body.push(
    seg("CLM", claim.claim_id, total.toFixed(2), "", "", `${claim.service_lines[0].place_of_service}:B:1`, "Y", "A", "Y", "Y"),
  );
  // Diagnoses (HI segment, ABK = primary ICD-10, ABF = additional)
  body.push(
    seg("HI", ...claim.diagnoses.map((d, i) => `${i === 0 ? "ABK" : "ABF"}:${d.replace(".", "")}`)),
  );
  if (claim.rendering_provider_npi) {
    body.push(seg("NM1", "82", "1", "", "", "", "", "", "XX", claim.rendering_provider_npi));
  }
  // Service lines
  claim.service_lines.forEach((line, i) => {
    body.push(seg("LX", String(i + 1)));
    const proc = ["HC", line.cpt_hcpcs, ...(line.modifiers ?? [])].join(":");
    body.push(
      seg("SV1", proc, line.charge.toFixed(2), "UN", String(line.units), line.place_of_service, "", (line.dx_pointers ?? [1]).join(":")),
    );
    body.push(seg("DTP", "472", "D8", line.service_date));
  });

  const env = envelope({
    senderId: "AETHERACLAW",
    receiverId: claim.payer_id,
    controlNumber: String(Math.abs(hash(claim.claim_id)) % 1_000_000_000),
    functionalCode: "HC",
    transactionSetId: "837",
    date: ymd.slice(2),
    time: "0000",
    body,
  });
  return serializeX12(env);
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export const claimBuild837Tool = defineTool({
  name: "claim_build_837p",
  description:
    "Generate an X12 837P professional claim file from structured claim JSON (de-identified/test data only). Validates NPIs before emitting. Run claim_scrub first.",
  schema: ClaimSchema,
  assessRisk: () => ({ level: "confirm", reason: "generate an 837P claim file" }),
  execute: async (input, ctx) => {
    if (!npiLuhnValid(input.billing_provider_npi))
      return { content: `billing_provider_npi ${input.billing_provider_npi} fails NPI validation`, isError: true };
    if (input.rendering_provider_npi && !npiLuhnValid(input.rendering_provider_npi))
      return { content: `rendering_provider_npi fails NPI validation`, isError: true };

    // Record the submitted claim so utilization analysis (E/M benchmarking) and
    // submitted-vs-paid comparison have the levels billed, with provider
    // attribution and service dates that the 835 never carries. Best-effort:
    // never fail claim generation because persistence did.
    const store = ctx.services.store as { db?: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } } | undefined;
    if (store?.db) {
      try {
        const now = Date.now();
        store.db
          .prepare(
            "INSERT INTO claims (id, payer, claim_json, status, created_at, updated_at) VALUES (?, ?, ?, 'submitted', ?, ?)",
          )
          .run(newId("clm"), input.payer_name, JSON.stringify(input), now, now);
      } catch {
        // Persistence is not worth failing the build over.
      }
    }

    return { content: build837p(input) };
  },
});
