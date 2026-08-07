import { z } from "zod";
import { defineTool } from "../../registry.js";
import { finding, type ScrubFinding } from "../finding.js";
import type { ComplianceContext } from "./context.js";

// ── Incident-to and split/shared billing ─────────────────────────────────────
// When a non-physician practitioner (NP/PA/CNS) performs a service that is billed
// under a physician's NPI, one of two rulesets applies and they are mutually
// exclusive by SETTING:
//   • Office (POS 11): "incident-to" — pays 100% of the fee schedule, but only for
//     an established patient on an established plan of care with a physician of the
//     group physically present in the office suite.
//   • Facility (hospital inpatient/outpatient/ED): "split/shared" — billed by
//     whichever practitioner performed the substantive portion, with modifier FS.
// Getting this wrong is an overpayment exposure, which is why the checks are errors.

const OFFICE_POS = new Set(["11"]);
const FACILITY_POS = new Set(["19", "21", "22", "23", "24", "51", "52", "61"]);
const SPLIT_SHARED_MODIFIER = "FS";

export function inferSetting(placeOfService: string): "office" | "facility" | undefined {
  if (OFFICE_POS.has(placeOfService)) return "office";
  if (FACILITY_POS.has(placeOfService)) return "facility";
  return undefined;
}

export function checkIncidentTo(
  line: { cpt_hcpcs: string; modifiers?: string[]; place_of_service: string },
  lineNumber: number,
  ctx: ComplianceContext | undefined,
): ScrubFinding[] {
  const out: ScrubFinding[] = [];
  const mods = (line.modifiers ?? []).map((m) => m.toUpperCase());
  const L = `Line ${lineNumber} (${line.cpt_hcpcs})`;
  const setting = ctx?.setting ?? inferSetting(line.place_of_service);
  const hasFs = mods.includes(SPLIT_SHARED_MODIFIER);

  // Modifier FS asserts a split/shared visit — only valid in a facility setting.
  if (hasFs && setting === "office") {
    out.push(
      finding(
        "error",
        "split-shared-setting",
        `${L}: modifier FS marks a split/shared visit, which applies in facility settings only. In the office (POS ${line.place_of_service}), incident-to rules apply instead — remove FS.`,
      ),
    );
  }

  if (ctx?.rendering_provider_type !== "npp") {
    if (hasFs && ctx?.rendering_provider_type === "physician") {
      out.push(
        finding(
          "warning",
          "split-shared-no-npp",
          `${L}: modifier FS indicates a visit shared with an NPP, but the service is documented as physician-only. Remove FS if no NPP participated.`,
        ),
      );
    }
    return out;
  }

  // From here: an NPP performed the service.
  if (ctx.billed_under_physician_npi !== true) {
    out.push(
      finding(
        "info",
        "npp-own-npi",
        `${L}: NPP service billed under the NPP's own NPI — reimbursed at 85% of the physician fee schedule. No incident-to or split/shared criteria apply.`,
      ),
    );
    return out;
  }

  if (setting === "facility") {
    // Split/shared
    if (!hasFs) {
      out.push(
        finding(
          "error",
          "split-shared-modifier",
          `${L}: facility visit shared between a physician and an NPP must carry modifier FS.`,
        ),
      );
    }
    if (ctx.physician_performed_substantive_portion === false) {
      out.push(
        finding(
          "error",
          "split-shared-substantive",
          `${L}: the NPP performed the substantive portion, so the visit must be billed under the NPP's NPI (85%), not the physician's. Billing it under the physician is an overpayment.`,
        ),
      );
    } else if (ctx.physician_performed_substantive_portion === undefined) {
      out.push(
        finding(
          "warning",
          "split-shared-undocumented",
          `${L}: split/shared visit billed under the physician — documentation must show the physician performed the substantive portion (more than half the total time, or the medical decision making).`,
        ),
      );
    }
    return out;
  }

  if (setting === "office") {
    // Incident-to
    if (ctx.is_new_patient === true) {
      out.push(
        finding(
          "error",
          "incident-to-new-patient",
          `${L}: incident-to does not apply to a new patient — the physician must perform the initial visit and establish the plan of care. Bill under the NPP's NPI at 85%.`,
        ),
      );
    }
    if (ctx.is_new_problem === true) {
      out.push(
        finding(
          "error",
          "incident-to-new-problem",
          `${L}: incident-to requires an established plan of care. A new problem addressed by the NPP must be billed under the NPP's own NPI at 85%.`,
        ),
      );
    }
    if (ctx.physician_on_site === false) {
      out.push(
        finding(
          "error",
          "incident-to-supervision",
          `${L}: incident-to requires direct supervision — a physician of the group physically present in the office suite. Bill under the NPP's NPI at 85%.`,
        ),
      );
    } else if (ctx.physician_on_site === undefined) {
      out.push(
        finding(
          "warning",
          "incident-to-supervision-undocumented",
          `${L}: incident-to billing claimed — documentation must record which physician was present in the office suite during the service.`,
        ),
      );
    }
    if (ctx.is_new_patient === false && ctx.is_new_problem === false && ctx.physician_on_site === true) {
      out.push(
        finding(
          "info",
          "incident-to-ok",
          `${L}: incident-to criteria met (established patient, established plan of care, direct supervision) — payable at 100% under the physician's NPI.`,
        ),
      );
    }
    return out;
  }

  out.push(
    finding(
      "warning",
      "incident-to-setting-unknown",
      `${L}: an NPP service is billed under a physician's NPI, but POS ${line.place_of_service} maps to neither a clear office nor facility setting. Incident-to (office) and split/shared (facility) have different requirements — confirm the setting.`,
    ),
  );
  return out;
}

export const incidentToCheckTool = defineTool({
  name: "incident_to_check",
  description:
    "Check whether an NPP (NP/PA/CNS) service billed under a physician's NPI satisfies incident-to (office) or split/shared (facility) requirements, and whether it should instead be billed under the NPP's own NPI at 85%.",
  schema: z.object({
    procedure_code: z.string(),
    place_of_service: z.string(),
    modifiers: z.array(z.string()).default([]),
    rendering_provider_type: z.enum(["physician", "npp"]).default("npp"),
    billed_under_physician_npi: z.boolean().default(true),
    setting: z.enum(["office", "facility"]).optional().describe("Inferred from POS when omitted"),
    physician_on_site: z.boolean().optional().describe("Office/incident-to: physician present in the office suite"),
    is_new_patient: z.boolean().optional(),
    is_new_problem: z.boolean().optional(),
    physician_performed_substantive_portion: z.boolean().optional().describe("Facility/split-shared"),
  }),
  execute: async (input) => {
    const findings = checkIncidentTo(
      { cpt_hcpcs: input.procedure_code, modifiers: input.modifiers, place_of_service: input.place_of_service },
      1,
      {
        rendering_provider_type: input.rendering_provider_type,
        billed_under_physician_npi: input.billed_under_physician_npi,
        setting: input.setting,
        physician_on_site: input.physician_on_site,
        is_new_patient: input.is_new_patient,
        is_new_problem: input.is_new_problem,
        physician_performed_substantive_portion: input.physician_performed_substantive_portion,
      },
    );
    if (findings.length === 0) return { content: "No incident-to or split/shared findings for this service." };
    return { content: findings.map((f) => `[${f.severity.toUpperCase()}] ${f.rule}: ${f.message}`).join("\n") };
  },
});
