import { z } from "zod";
import { defineTool } from "../registry.js";

// ── Coordination of benefits ─────────────────────────────────────────────────
// Billing the wrong payer first is one of the cheapest denials to prevent and
// one of the most expensive to unwind: the primary denies for COB (CARC 22/23),
// the secondary rejects because no primary adjudication is attached, and timely
// filing runs on both while it is sorted out.

/** SBR05 insurance type codes, used when Medicare is the secondary payer. */
export const MSP_TYPE_CODES: Record<string, string> = {
  "12": "Medicare secondary — working aged (65+, group health plan through current employment)",
  "13": "Medicare secondary — ESRD in the 30-month coordination period",
  "14": "Medicare secondary — no-fault insurance, including auto",
  "15": "Medicare secondary — workers' compensation",
  "16": "Medicare secondary — Public Health Service or other federal agency",
  "41": "Medicare secondary — Black Lung",
  "42": "Medicare secondary — Veterans Affairs",
  "43": "Medicare secondary — disability (large group health plan through current employment)",
  "47": "Medicare secondary — liability insurance, including self-insurance",
};

/** Employer-size thresholds that decide whether a group health plan pays before Medicare. */
export const WORKING_AGED_EMPLOYER_THRESHOLD = 20;
export const DISABILITY_EMPLOYER_THRESHOLD = 100;
export const ESRD_COORDINATION_MONTHS = 30;

export interface CobSituation {
  medicareEntitled: boolean;
  medicareReason?: "age" | "disability" | "esrd";
  esrdMonthsElapsed?: number;
  hasGroupHealthPlan?: boolean;
  coverageThrough?: "own_current_employment" | "spouse_current_employment" | "family_member_current_employment" | "retiree_or_cobra" | "none";
  employerSize?: number;
  injuryRelated?: "workers_comp" | "auto_no_fault" | "liability" | "black_lung" | "none";
  claimRelatedToInjury?: boolean;
  vaAuthorizedService?: boolean;
  patientIsDependentChild?: boolean;
  parentsSeparated?: boolean;
  courtDecreeAssignsTo?: "parent_a" | "parent_b";
  custodialParent?: "parent_a" | "parent_b";
  parentABirthdayMmdd?: string;
  parentBBirthdayMmdd?: string;
}

export interface CobPosition {
  position: string;
  payer: string;
  rationale: string;
}

export interface CobDetermination {
  order: CobPosition[];
  mspTypeCode?: string;
  medicareIsPrimary: boolean;
  warnings: string[];
  notes: string[];
}

const ORDINALS = ["Primary", "Secondary", "Tertiary", "Quaternary"];

function order(entries: Array<{ payer: string; rationale: string }>): CobPosition[] {
  return entries.map((e, i) => ({ position: ORDINALS[i] ?? `Payer ${i + 1}`, ...e }));
}

/** Month/day comparison for the birthday rule — the YEAR is deliberately ignored. */
export function earlierInCalendarYear(a: string, b: string): "a" | "b" | "tie" {
  const norm = (s: string) => s.replace(/[^0-9]/g, "").slice(0, 4);
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return "tie";
  return na < nb ? "a" : "b";
}

export function determineCobOrder(s: CobSituation): CobDetermination {
  const warnings: string[] = [];
  const notes: string[] = [];

  // ── Dependent-child coordination between two commercial plans ──────────────
  if (s.patientIsDependentChild && !s.medicareEntitled) {
    if (s.parentsSeparated) {
      if (s.courtDecreeAssignsTo) {
        const first = s.courtDecreeAssignsTo === "parent_a" ? "Parent A" : "Parent B";
        const second = s.courtDecreeAssignsTo === "parent_a" ? "Parent B" : "Parent A";
        return {
          order: order([
            { payer: `${first}'s plan`, rationale: "A court decree assigning responsibility for health coverage overrides every other ordering rule." },
            { payer: `${second}'s plan`, rationale: "Pays after the plan named in the decree." },
          ]),
          medicareIsPrimary: false,
          warnings,
          notes: [...notes, "Keep a copy of the decree — payers routinely request it to honour the assignment."],
        };
      }
      if (s.custodialParent) {
        const first = s.custodialParent === "parent_a" ? "Parent A" : "Parent B";
        const second = s.custodialParent === "parent_a" ? "Parent B" : "Parent A";
        return {
          order: order([
            { payer: `${first}'s plan (custodial parent)`, rationale: "With no court decree, the custodial parent's plan pays first." },
            { payer: `Custodial parent's spouse's plan, then ${second}'s plan`, rationale: "The standard sequence is custodial parent → custodial parent's spouse → non-custodial parent → their spouse." },
          ]),
          medicareIsPrimary: false,
          warnings,
          notes,
        };
      }
      warnings.push("Parents are separated but neither a court decree nor the custodial parent was supplied — ask before billing; guessing produces a COB denial.");
    } else if (s.parentABirthdayMmdd && s.parentBBirthdayMmdd) {
      const which = earlierInCalendarYear(s.parentABirthdayMmdd, s.parentBBirthdayMmdd);
      if (which === "tie") {
        return {
          order: order([
            { payer: "The plan that has covered the child longer", rationale: "Both parents share a birthday (month and day), so the tiebreak is which plan has covered the child longest." },
            { payer: "The other parent's plan", rationale: "Pays second." },
          ]),
          medicareIsPrimary: false,
          warnings,
          notes: [...notes, "The birthday rule compares month and day only — the parents' birth years are irrelevant."],
        };
      }
      const first = which === "a" ? "Parent A" : "Parent B";
      const second = which === "a" ? "Parent B" : "Parent A";
      return {
        order: order([
          {
            payer: `${first}'s plan`,
            rationale: `Birthday rule: ${first}'s birthday (${which === "a" ? s.parentABirthdayMmdd : s.parentBBirthdayMmdd}) falls earlier in the calendar year.`,
          },
          { payer: `${second}'s plan`, rationale: "Pays second under the birthday rule." },
        ]),
        medicareIsPrimary: false,
        warnings,
        notes: [...notes, "The birthday rule compares month and day only — not who is older."],
      };
    } else {
      warnings.push("Dependent child with two plans, but the parents' birthdays were not supplied — the birthday rule needs both to determine the order.");
    }
  }

  // ── Injury-related coverage is primary to Medicare for related care ────────
  if (s.injuryRelated && s.injuryRelated !== "none") {
    const map = {
      workers_comp: { payer: "Workers' compensation", code: "15" },
      auto_no_fault: { payer: "No-fault / auto insurance", code: "14" },
      liability: { payer: "Liability insurance", code: "47" },
      black_lung: { payer: "Federal Black Lung program", code: "41" },
    } as const;
    const m = map[s.injuryRelated];
    if (s.claimRelatedToInjury === false) {
      notes.push(
        `${m.payer} is on file but this claim is not related to the injury, so it does not pay first for these services.`,
      );
    } else {
      if (s.claimRelatedToInjury === undefined) {
        warnings.push(
          `${m.payer} coverage is on file — confirm whether THIS claim is related to the injury. It is primary only for related services.`,
        );
      }
      const entries: Array<{ payer: string; rationale: string }> = [
        { payer: m.payer, rationale: "Primary for services related to the injury or illness it covers." },
      ];
      if (s.medicareEntitled) {
        entries.push({
          payer: "Medicare",
          rationale: `Secondary for related services. Bill with MSP type code ${m.code} in SBR05.`,
        });
      }
      if (s.injuryRelated === "liability") {
        notes.push(
          "For liability specifically, Medicare may pay conditionally if the liability insurer will not pay promptly (generally 120 days) — the conditional payment must then be repaid from the settlement.",
        );
      }
      return { order: order(entries), mspTypeCode: s.medicareEntitled ? m.code : undefined, medicareIsPrimary: false, warnings, notes };
    }
  }

  if (s.vaAuthorizedService && s.medicareEntitled) {
    return {
      order: order([
        { payer: "Veterans Affairs", rationale: "VA pays for services it authorized." },
        { payer: "Medicare", rationale: "Medicare does not pay for VA-authorized services; bill VA. MSP type code 42 applies where a claim is filed." },
      ]),
      mspTypeCode: "42",
      medicareIsPrimary: false,
      warnings,
      notes: [...notes, "VA and Medicare do not coordinate like commercial plans — the service is billed to whichever authorized it, not split."],
    };
  }

  // ── Medicare Secondary Payer: employment-based group health plans ──────────
  if (s.medicareEntitled) {
    const activeEmployment =
      s.coverageThrough === "own_current_employment" ||
      s.coverageThrough === "spouse_current_employment" ||
      s.coverageThrough === "family_member_current_employment";

    if (s.medicareReason === "esrd") {
      const months = s.esrdMonthsElapsed;
      if (s.hasGroupHealthPlan && (months === undefined || months < ESRD_COORDINATION_MONTHS)) {
        if (months === undefined) {
          warnings.push(
            `ESRD coordination period length not supplied — the group health plan is primary for the first ${ESRD_COORDINATION_MONTHS} months, Medicare after. Confirm the month count.`,
          );
        }
        return {
          order: order([
            {
              payer: "Group health plan",
              rationale: `ESRD: the GHP is primary for the first ${ESRD_COORDINATION_MONTHS} months of Medicare eligibility, regardless of employer size and regardless of whether the coverage is active or retiree.`,
            },
            { payer: "Medicare", rationale: "Secondary during the coordination period. Bill with MSP type code 13 in SBR05." },
          ]),
          mspTypeCode: "13",
          medicareIsPrimary: false,
          warnings,
          notes,
        };
      }
      return {
        order: order([
          { payer: "Medicare", rationale: `ESRD: the ${ESRD_COORDINATION_MONTHS}-month coordination period has ended, so Medicare pays first.` },
          ...(s.hasGroupHealthPlan ? [{ payer: "Group health plan", rationale: "Secondary after the coordination period." }] : []),
        ]),
        medicareIsPrimary: true,
        warnings,
        notes,
      };
    }

    if (s.hasGroupHealthPlan && activeEmployment) {
      const threshold = s.medicareReason === "disability" ? DISABILITY_EMPLOYER_THRESHOLD : WORKING_AGED_EMPLOYER_THRESHOLD;
      const code = s.medicareReason === "disability" ? "43" : "12";
      const label = s.medicareReason === "disability" ? "disability" : "working aged";

      if (s.employerSize === undefined) {
        warnings.push(
          `Employer size not supplied — it is the deciding fact here. For ${label}, the group health plan is primary at ${threshold}+ employees and Medicare is primary below that.`,
        );
        return {
          order: order([
            { payer: `Group health plan IF the employer has ${threshold}+ employees, otherwise Medicare`, rationale: "Cannot be determined without the employer size." },
          ]),
          medicareIsPrimary: false,
          warnings,
          notes,
        };
      }

      if (s.employerSize >= threshold) {
        return {
          order: order([
            {
              payer: "Group health plan",
              rationale: `${label === "disability" ? "Disability" : "Working aged"}: coverage is through current employment and the employer has ${s.employerSize} employees (threshold ${threshold}), so the GHP pays first.`,
            },
            { payer: "Medicare", rationale: `Secondary. Bill with MSP type code ${code} in SBR05.` },
          ]),
          mspTypeCode: code,
          medicareIsPrimary: false,
          warnings,
          notes,
        };
      }
      return {
        order: order([
          {
            payer: "Medicare",
            rationale: `${label === "disability" ? "Disability" : "Working aged"}: the employer has ${s.employerSize} employees, below the ${threshold}-employee threshold, so Medicare pays first.`,
          },
          { payer: "Group health plan", rationale: "Secondary." },
        ]),
        medicareIsPrimary: true,
        warnings,
        notes,
      };
    }

    if (s.hasGroupHealthPlan && s.coverageThrough === "retiree_or_cobra") {
      return {
        order: order([
          { payer: "Medicare", rationale: "Retiree and COBRA coverage are not based on current employment, so Medicare pays first." },
          { payer: "Retiree / COBRA plan", rationale: "Secondary." },
        ]),
        medicareIsPrimary: true,
        warnings,
        notes,
      };
    }

    return {
      order: order([{ payer: "Medicare", rationale: "No other coverage identified that pays before Medicare." }]),
      medicareIsPrimary: true,
      warnings,
      notes,
    };
  }

  // ── Commercial only ───────────────────────────────────────────────────────
  if (s.coverageThrough === "own_current_employment") {
    return {
      order: order([
        { payer: "The patient's own plan", rationale: "A plan covering someone as a subscriber pays before a plan covering them as a dependent." },
        { payer: "Coverage as a dependent (if any)", rationale: "Secondary." },
      ]),
      medicareIsPrimary: false,
      warnings,
      notes,
    };
  }
  if (s.coverageThrough === "retiree_or_cobra") {
    return {
      order: order([
        { payer: "Active employee plan", rationale: "Coverage through active employment pays before retiree or COBRA coverage." },
        { payer: "Retiree / COBRA plan", rationale: "Secondary." },
      ]),
      medicareIsPrimary: false,
      warnings,
      notes,
    };
  }

  warnings.push("Not enough information to determine the payer order — supply the patient's coverage sources and, if applicable, Medicare entitlement.");
  return { order: [], medicareIsPrimary: false, warnings, notes };
}

export function renderCob(d: CobDetermination): string {
  const out: string[] = [];
  if (d.order.length) {
    out.push("Payer order:");
    for (const p of d.order) out.push(`  ${p.position}: ${p.payer}\n    ${p.rationale}`);
  }
  if (d.mspTypeCode) {
    out.push("", `MSP type code for SBR05: ${d.mspTypeCode} — ${MSP_TYPE_CODES[d.mspTypeCode]}`);
  }
  if (d.notes.length) out.push("", ...d.notes.map((n) => `Note: ${n}`));
  if (d.warnings.length) out.push("", ...d.warnings.map((w) => `NEEDS CONFIRMATION: ${w}`));
  out.push(
    "",
    "Verify against the payer's own COB record before billing — payers act on what their file says, not on what is true, and a stale COB record on their side is itself a common denial (CARC 22/23).",
  );
  return out.join("\n");
}

export const cobDeterminePrimaryTool = defineTool({
  name: "cob_determine_primary",
  description:
    "Determine which payer is primary and produce the MSP type code for SBR05 when Medicare is secondary. Covers Medicare Secondary Payer rules (working aged, disability, ESRD coordination period, workers' comp, auto/no-fault, liability, Black Lung, VA) and commercial coordination (own coverage before dependent coverage, active before retiree/COBRA, and the birthday rule for dependent children). Says explicitly when a missing fact — usually employer size or which parent's birthday falls first — is what decides the answer.",
  schema: z.object({
    medicare_entitled: z.boolean().default(false),
    medicare_reason: z.enum(["age", "disability", "esrd"]).optional(),
    esrd_months_elapsed: z.number().int().min(0).optional().describe("Months since Medicare eligibility began, for ESRD patients"),
    has_group_health_plan: z.boolean().default(false),
    coverage_through: z
      .enum(["own_current_employment", "spouse_current_employment", "family_member_current_employment", "retiree_or_cobra", "none"])
      .optional(),
    employer_size: z.number().int().min(0).optional().describe("Number of employees — decides working-aged (20+) and disability (100+) cases"),
    injury_related: z.enum(["workers_comp", "auto_no_fault", "liability", "black_lung", "none"]).optional(),
    claim_related_to_injury: z.boolean().optional().describe("Is THIS claim for the injury? Those payers are primary only for related services"),
    va_authorized_service: z.boolean().optional(),
    patient_is_dependent_child: z.boolean().default(false),
    parents_separated: z.boolean().optional(),
    court_decree_assigns_to: z.enum(["parent_a", "parent_b"]).optional(),
    custodial_parent: z.enum(["parent_a", "parent_b"]).optional(),
    parent_a_birthday_mmdd: z.string().optional().describe("MMDD — year is irrelevant to the birthday rule"),
    parent_b_birthday_mmdd: z.string().optional().describe("MMDD"),
  }),
  execute: async (input) => {
    const determination = determineCobOrder({
      medicareEntitled: input.medicare_entitled,
      medicareReason: input.medicare_reason,
      esrdMonthsElapsed: input.esrd_months_elapsed,
      hasGroupHealthPlan: input.has_group_health_plan,
      coverageThrough: input.coverage_through,
      employerSize: input.employer_size,
      injuryRelated: input.injury_related,
      claimRelatedToInjury: input.claim_related_to_injury,
      vaAuthorizedService: input.va_authorized_service,
      patientIsDependentChild: input.patient_is_dependent_child,
      parentsSeparated: input.parents_separated,
      courtDecreeAssignsTo: input.court_decree_assigns_to,
      custodialParent: input.custodial_parent,
      parentABirthdayMmdd: input.parent_a_birthday_mmdd,
      parentBBirthdayMmdd: input.parent_b_birthday_mmdd,
    });
    return { content: renderCob(determination) };
  },
});
