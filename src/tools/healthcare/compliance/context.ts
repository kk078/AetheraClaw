import { z } from "zod";

// Optional compliance metadata carried alongside a claim. These facts are not on
// the 837 wire format itself — they describe HOW the service was delivered and
// supervised, which is what incident-to, split/shared, telehealth, and global-period
// rules turn on. The agent gathers them conversationally or from documentation.

export const PriorProcedureSchema = z.object({
  code: z.string().describe("Procedure code previously performed (starts a global period)"),
  date: z.string().describe("YYYYMMDD date the prior procedure was performed"),
  global_days: z
    .number()
    .int()
    .optional()
    .describe("Global period in days (0, 10, or 90). Looked up from local MPFS data when omitted."),
  surgeon_npi: z.string().optional(),
});

export const ComplianceContextSchema = z.object({
  rendering_provider_type: z
    .enum(["physician", "npp"])
    .optional()
    .describe("Who actually performed the service: physician, or non-physician practitioner (NP/PA/CNS)"),
  billed_under_physician_npi: z
    .boolean()
    .optional()
    .describe("True when an NPP's service is billed under the physician's NPI (incident-to or split/shared)"),
  physician_on_site: z
    .boolean()
    .optional()
    .describe("Was a physician of the group physically present in the office suite during the service?"),
  is_new_patient: z.boolean().optional(),
  is_new_problem: z.boolean().optional().describe("Is this a new problem, or a change to the established plan of care?"),
  setting: z
    .enum(["office", "facility"])
    .optional()
    .describe("office = physician office/clinic; facility = hospital inpatient/outpatient/ED"),
  physician_performed_substantive_portion: z
    .boolean()
    .optional()
    .describe("Split/shared: did the physician perform the substantive portion (more than half the time, or the MDM)?"),
  telehealth: z.boolean().optional().describe("Was the service delivered via telehealth?"),
  telehealth_modality: z.enum(["audio_video", "audio_only", "asynchronous"]).optional(),
  patient_at_home: z.boolean().optional().describe("Telehealth: was the patient in their home (POS 10) or another site (POS 02)?"),
  prior_procedures: z
    .array(PriorProcedureSchema)
    .optional()
    .describe("Procedures previously performed on this patient that may still be in a global period"),
  patient_ref: z
    .string()
    .optional()
    .describe("De-identified patient reference — pulls recorded procedure history for global-period checks"),
});

export type ComplianceContext = z.infer<typeof ComplianceContextSchema>;
export type PriorProcedure = z.infer<typeof PriorProcedureSchema>;
