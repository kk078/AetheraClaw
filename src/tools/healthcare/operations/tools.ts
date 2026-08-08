import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "../../registry.js";
import { confinePath } from "../../path-guard.js";
import { newId } from "../../../shared/ids.js";
import type { MemoryStore } from "../../../memory/store.js";
import { npiLuhnValid } from "../npi.js";
import { loadEras } from "../analytics.js";
import { todayYmd } from "../audit/deadlines.js";
import {
  assessAll,
  billableOn,
  caqhExpiry,
  impliedRevalidationDue,
  renderAlerts,
  type CredentialRecord,
  type EnrollmentKind,
  type EnrollmentStatus,
} from "./credentialing.js";
import {
  checkGfeVariance,
  gfeDeadlineForRequest,
  gfeDeadlineForScheduling,
  renderGfe,
  totalGfe,
  type GfeInput,
} from "./gfe.js";
import { summarize, toCsv, toPostingRows } from "./era-export.js";
import { buildClaimFromSuperbill, type SuperbillInput } from "./superbill.js";

function db(ctx: { services: Record<string, unknown> }) {
  const store = ctx.services.store as MemoryStore | undefined;
  if (!store) throw new Error("store service unavailable");
  return store.db;
}

interface CredentialRow {
  id: string;
  provider_npi: string;
  provider_name: string;
  payer: string;
  kind: string;
  status: string;
  effective_date: string;
  revalidation_due: string;
  caqh_attested_on: string;
  notes: string;
}

function toRecord(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    providerNpi: row.provider_npi,
    providerName: row.provider_name,
    payer: row.payer,
    kind: row.kind as EnrollmentKind,
    status: row.status as EnrollmentStatus,
    effectiveDate: row.effective_date,
    revalidationDue: row.revalidation_due,
    caqhAttestedOn: row.caqh_attested_on,
    notes: row.notes,
  };
}

const KINDS = ["medicare", "medicare_dmepos", "medicaid", "commercial"] as const;
const STATUSES = [
  "not_started",
  "application_submitted",
  "in_review",
  "approved",
  "revalidation_due",
  "deactivated",
  "terminated",
] as const;

export const credentialingTrackTool = defineTool({
  name: "credentialing_track",
  description:
    "Record or update a provider's enrollment with a payer. When no revalidation date is supplied, one is computed from the effective date (five years for Medicare providers and organizations, three for DMEPOS suppliers) so a new enrollment is not left unwatched — the payer's published date always overrides it. CAQH attestations expire every 120 days and are tracked alongside.",
  schema: z.object({
    provider_npi: z.string(),
    provider_name: z.string(),
    payer: z.string(),
    kind: z.enum(KINDS).default("commercial"),
    status: z.enum(STATUSES).default("not_started"),
    effective_date: z.string().regex(/^\d{8}$/).optional().describe("YYYYMMDD the enrollment took effect"),
    revalidation_due: z.string().regex(/^\d{8}$/).optional().describe("The payer's published date, if you have it"),
    caqh_attested_on: z.string().regex(/^\d{8}$/).optional(),
    notes: z.string().optional(),
  }),
  execute: async (input, ctx) => {
    if (!npiLuhnValid(input.provider_npi)) {
      return { content: `${input.provider_npi} fails NPI check-digit validation.`, isError: true };
    }
    const revalidation =
      input.revalidation_due ??
      (input.effective_date ? impliedRevalidationDue(input.effective_date, input.kind) : "");
    const now = Date.now();
    db(ctx)
      .prepare(
        `INSERT INTO credentialing
           (id, provider_npi, provider_name, payer, kind, status, effective_date, revalidation_due, caqh_attested_on, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_npi, payer) DO UPDATE SET
           provider_name = excluded.provider_name,
           kind = excluded.kind,
           status = excluded.status,
           effective_date = excluded.effective_date,
           revalidation_due = excluded.revalidation_due,
           caqh_attested_on = excluded.caqh_attested_on,
           notes = excluded.notes,
           updated_at = excluded.updated_at`,
      )
      .run(
        newId("cred"),
        input.provider_npi,
        input.provider_name,
        input.payer,
        input.kind,
        input.status,
        input.effective_date ?? "",
        revalidation,
        input.caqh_attested_on ?? "",
        input.notes ?? "",
        now,
        now,
      );

    const lines = [`${input.provider_name} / ${input.payer}: ${input.status}.`];
    if (revalidation) {
      lines.push(
        input.revalidation_due
          ? `Revalidation due ${revalidation} (as published by the payer).`
          : `Revalidation due ${revalidation} — computed from the effective date; replace it with the payer's published date when it arrives.`,
      );
    }
    if (input.caqh_attested_on) {
      lines.push(`CAQH attested ${input.caqh_attested_on}, expires ${caqhExpiry(input.caqh_attested_on)}.`);
    }
    return { content: lines.join("\n") };
  },
});

export const credentialingListTool = defineTool({
  name: "credentialing_list",
  description:
    "Show credentialing problems: providers who cannot bill a payer today, revalidations coming due, and expired or expiring CAQH attestations — blocking items first.",
  schema: z.object({
    provider_npi: z.string().optional(),
    payer: z.string().optional(),
    horizon_days: z.number().int().min(1).max(730).default(180),
    as_of: z.string().regex(/^\d{8}$/).optional(),
    all: z.boolean().default(false).describe("List every enrollment, not just the ones needing attention"),
  }),
  execute: async (input, ctx) => {
    const asOf = input.as_of ?? todayYmd();
    const rows = db(ctx).prepare("SELECT * FROM credentialing").all() as CredentialRow[];
    let records = rows.map(toRecord);
    if (input.provider_npi) records = records.filter((r) => r.providerNpi === input.provider_npi);
    if (input.payer) {
      const needle = input.payer.toLowerCase();
      records = records.filter((r) => r.payer.toLowerCase().includes(needle));
    }
    if (records.length === 0) {
      return { content: "No enrollments recorded — add them with credentialing_track." };
    }

    if (input.all) {
      return {
        content: records
          .map(
            (r) =>
              `${r.providerName} (${r.providerNpi}) / ${r.payer} [${r.kind}] — ${r.status}` +
              `${r.effectiveDate ? `, effective ${r.effectiveDate}` : ""}` +
              `${r.revalidationDue ? `, revalidation ${r.revalidationDue}` : ""}` +
              `${r.caqhAttestedOn ? `, CAQH expires ${caqhExpiry(r.caqhAttestedOn)}` : ""}`,
          )
          .join("\n"),
      };
    }

    const alerts = assessAll(records, { asOf, horizonDays: input.horizon_days });
    return { content: renderAlerts(alerts, asOf) };
  },
});

export const credentialingCheckTool = defineTool({
  name: "credentialing_check",
  description:
    "Check whether a provider could bill a payer on a given date of service, before the claim goes out. A service furnished while the provider was not enrolled denies as provider-not-eligible (CARC B7) and is not recoverable on appeal, so this is worth asking first rather than learning from the remittance.",
  schema: z.object({
    provider_npi: z.string(),
    payer: z.string(),
    service_date: z.string().regex(/^\d{8}$/),
  }),
  execute: async (input, ctx) => {
    const rows = db(ctx)
      .prepare("SELECT * FROM credentialing WHERE provider_npi = ?")
      .all(input.provider_npi) as CredentialRow[];
    const needle = input.payer.toLowerCase();
    const row = rows.find((r) => r.payer.toLowerCase().includes(needle));
    if (!row) {
      return {
        content: `No enrollment on file for NPI ${input.provider_npi} with a payer matching "${input.payer}". That is not the same as being unenrolled — it means nothing is being tracked. Record it with credentialing_track.`,
      };
    }
    const verdict = billableOn(toRecord(row), input.service_date);
    return {
      content: verdict.billable
        ? `OK to bill: ${verdict.reason}`
        : `DO NOT BILL: ${verdict.reason} A claim furnished under these conditions denies as provider-not-eligible and cannot be appealed back.`,
    };
  },
});

// ── Charge capture ───────────────────────────────────────────────────────────

export const superbillBuildTool = defineTool({
  name: "superbill_build",
  description:
    "Turn a captured encounter into a clean claim. Each service line names the DIAGNOSIS CODES that support it and the 1-based diagnosis pointers the 837 needs are derived, which removes the step charge capture most often gets wrong. Supply encounter_diagnoses to control the reported order (primary first); without it the order falls out of which line came first. Diagnoses that support no line are reported but flagged. Run claim_scrub on the result before building the 837.",
  schema: z.object({
    claim_id: z.string(),
    payer_name: z.string(),
    payer_id: z.string(),
    billing_provider_npi: z.string(),
    billing_provider_name: z.string(),
    rendering_provider_npi: z.string().optional(),
    subscriber_id: z.string().describe("Use synthetic/test data only"),
    patient_last: z.string(),
    patient_first: z.string(),
    patient_dob: z.string().describe("YYYYMMDD (synthetic/test data only)"),
    patient_sex: z.enum(["M", "F", "U"]).default("U"),
    encounter_diagnoses: z
      .array(z.string())
      .default([])
      .describe("The encounter's diagnoses in the order you want them reported, primary first"),
    lines: z
      .array(
        z.object({
          code: z.string(),
          modifiers: z.array(z.string()).optional(),
          charge: z.number(),
          units: z.number().int().min(1).default(1),
          service_date: z.string().regex(/^\d{8}$/),
          place_of_service: z.string().default("11"),
          diagnoses: z.array(z.string()).describe("ICD-10 codes supporting THIS line, by code not position"),
        }),
      )
      .min(1),
  }),
  execute: async (input) => {
    const superbill: SuperbillInput = {
      encounterDiagnoses: input.encounter_diagnoses,
      claimId: input.claim_id,
      payerName: input.payer_name,
      payerId: input.payer_id,
      billingProviderNpi: input.billing_provider_npi,
      billingProviderName: input.billing_provider_name,
      renderingProviderNpi: input.rendering_provider_npi,
      subscriberId: input.subscriber_id,
      patientLast: input.patient_last,
      patientFirst: input.patient_first,
      patientDob: input.patient_dob,
      patientSex: input.patient_sex,
      lines: input.lines.map((l) => ({
        code: l.code,
        modifiers: l.modifiers,
        charge: l.charge,
        units: l.units,
        serviceDate: l.service_date,
        placeOfService: l.place_of_service,
        diagnoses: l.diagnoses,
      })),
    };
    const result = buildClaimFromSuperbill(superbill);
    const content = [
      ...result.findings.map((f) => `[${f.severity.toUpperCase()}] ${f.rule}: ${f.message}`),
      "",
      result.diagnosisOrder.length
        ? `Diagnosis pointer order: ${result.diagnosisOrder.map((d, i) => `${i + 1}=${d}`).join(", ")}`
        : "",
      "",
      result.claim ? JSON.stringify(result.claim, null, 2) : "Claim NOT assembled — fix the errors above first.",
    ]
      .filter((l) => l !== "")
      .join("\n");
    return { content, isError: result.claim === null };
  },
});

// ── Posting export ───────────────────────────────────────────────────────────

export const eraExportTool = defineTool({
  name: "era_export",
  description:
    "Export parsed remittances as a posting CSV. Each line carries charged, allowed, paid, patient responsibility, contractual write-off and sequestration separately, with the reason codes attached, so it posts without re-deriving anything. Claim-level adjustments are exported as their own rows rather than dropped — those dollars are real and omitting them makes the file fail to reconcile.",
  schema: z.object({
    output_path: z.string().describe("Workspace-relative path for the CSV"),
    payer: z.string().optional().describe("Substring filter on payer name"),
  }),
  assessRisk: (input) => ({ level: "confirm", reason: `write posting CSV to ${input.output_path}` }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore;
    let eras = loadEras(store);
    if (input.payer) {
      const needle = input.payer.toLowerCase();
      eras = eras.filter((e) => e.payer.toLowerCase().includes(needle));
    }
    if (eras.length === 0) {
      return { content: "No remittance data to export — parse 835 files with era_parse_835 first." };
    }
    const rows = toPostingRows(eras);
    const csv = toCsv(rows);
    const p = confinePath(ctx.workspaceRoot, input.output_path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, csv);

    const s = summarize(rows);
    return {
      content: [
        `Wrote ${s.rows} posting row(s) to ${input.output_path}.`,
        `Charged $${s.charged.toFixed(2)} · allowed $${s.allowed.toFixed(2)} · paid $${s.paid.toFixed(2)} · patient responsibility $${s.patientResponsibility.toFixed(2)}.`,
        s.providerAdjustmentRows > 0
          ? `${s.providerAdjustmentRows} provider-level adjustment row(s) netting ${s.providerAdjustmentTotal < 0 ? "-" : ""}$${Math.abs(s.providerAdjustmentTotal).toFixed(2)} are included, so the paid column sums to the deposit rather than to the claims alone. Run era_reconcile to check it against what the payer says it sent.`
          : "",
        s.unbalanced > 0
          ? `${s.unbalanced} row(s) do not balance (charge ≠ paid + adjustments) and are marked NO in the balanced column — reconcile those before posting.`
          : "Every row balances.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});

// ── Good Faith Estimate ──────────────────────────────────────────────────────

export const gfeDeadlineTool = defineTool({
  name: "gfe_deadline",
  description:
    "Compute when a Good Faith Estimate is owed to an uninsured or self-pay patient under the No Surprises Act. The clock runs in BUSINESS days from scheduling, not from the date of service: scheduled 10+ business days out means 3 business days to deliver, 3–9 business days out means 1, and under 3 carries no scheduling trigger at all. A patient request always starts a 3-business-day clock. Federal holidays are not assumed — supply them if they fall in the window.",
  schema: z.object({
    trigger: z.enum(["scheduling", "request"]).default("scheduling"),
    scheduled_on: z.string().regex(/^\d{8}$/).describe("YYYYMMDD the service was scheduled, or the request was made"),
    service_date: z.string().regex(/^\d{8}$/).optional().describe("Required for the scheduling trigger"),
    holidays: z.array(z.string().regex(/^\d{8}$/)).default([]),
  }),
  execute: async (input) => {
    if (input.trigger === "request") {
      const t = gfeDeadlineForRequest(input.scheduled_on, input.holidays);
      return { content: `Estimate due ${t.deadline}. ${t.rule}` };
    }
    if (!input.service_date) {
      return { content: "service_date is required for the scheduling trigger.", isError: true };
    }
    const t = gfeDeadlineForScheduling(input.scheduled_on, input.service_date, input.holidays);
    return {
      content: t.required
        ? `Estimate due ${t.deadline}. ${t.rule}`
        : `No estimate is triggered by scheduling. ${t.rule}`,
    };
  },
});

export const gfeGenerateTool = defineTool({
  name: "gfe_generate",
  description:
    "Draft a Good Faith Estimate document for an uninsured or self-pay patient, itemized by code with the No Surprises Act disclosures — including that a final bill $400 or more above the estimate opens patient-provider dispute resolution. De-identified/test data only; review before giving it to a patient.",
  schema: z.object({
    output_path: z.string().describe("Workspace-relative path for the Markdown document"),
    patient_name: z.string(),
    patient_dob: z.string(),
    primary_service: z.string(),
    service_date: z.string().regex(/^\d{8}$/),
    scheduled_on: z.string().regex(/^\d{8}$/).optional().describe("Adds the delivery deadline to the document"),
    diagnoses: z.array(z.string()).default([]),
    lines: z
      .array(
        z.object({
          code: z.string(),
          description: z.string(),
          quantity: z.number().min(1).default(1),
          unit_charge: z.number().min(0),
        }),
      )
      .min(1),
    provider_name: z.string(),
    provider_npi: z.string(),
    provider_tin: z.string(),
    location: z.string(),
    excluded_providers: z.array(z.string()).default([]),
  }),
  assessRisk: (input) => ({ level: "confirm", reason: `write Good Faith Estimate to ${input.output_path}` }),
  execute: async (input, ctx) => {
    const gfe: GfeInput = {
      patientName: input.patient_name,
      patientDob: input.patient_dob,
      primaryService: input.primary_service,
      serviceDate: input.service_date,
      diagnoses: input.diagnoses,
      lines: input.lines.map((l) => ({
        code: l.code,
        description: l.description,
        quantity: l.quantity,
        unitCharge: l.unit_charge,
      })),
      providerName: input.provider_name,
      providerNpi: input.provider_npi,
      providerTin: input.provider_tin,
      location: input.location,
      excludedProviders: input.excluded_providers,
    };
    const totals = totalGfe(gfe.lines);
    const timing = input.scheduled_on
      ? gfeDeadlineForScheduling(input.scheduled_on, input.service_date)
      : null;
    const doc = renderGfe(gfe, totals, timing && timing.required ? timing : null);

    const p = confinePath(ctx.workspaceRoot, input.output_path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, doc);
    return {
      content: [
        `Wrote Good Faith Estimate to ${input.output_path}: $${totals.total.toFixed(2)} across ${totals.lines.length} item(s).`,
        timing
          ? timing.required
            ? `Delivery deadline ${timing.deadline} — ${timing.rule}`
            : timing.rule
          : "Pass scheduled_on to compute the delivery deadline.",
      ].join("\n"),
    };
  },
});

export const gfeVarianceTool = defineTool({
  name: "gfe_variance_check",
  description:
    "Compare a final bill against the Good Faith Estimate given to the patient and report whether the difference reaches the $400 threshold that lets the patient open patient-provider dispute resolution.",
  schema: z.object({
    estimate_total: z.number().min(0),
    billed_total: z.number().min(0),
  }),
  execute: async (input) => ({
    content: checkGfeVariance(input.estimate_total, input.billed_total).message,
  }),
});
