// ── Medicare Physician Fee Schedule ──────────────────────────────────────────
// The official formula is
//
//   Payment = [(Work RVU × Work GPCI) + (PE RVU × PE GPCI) + (MP RVU × MP GPCI)] × CF
//
// Three things decide the answer beyond the RVUs themselves and are the usual
// source of "why did we get paid less than we expected": which practice-expense
// RVU applies (facility vs non-facility), which modifier payment rules apply,
// and sequestration. All three are modelled here.

/** Percentages below are Medicare payment policy, published in the Claims Processing Manual. */
export const ASSISTANT_SURGEON_RATE = 0.16;
export const CO_SURGEON_RATE = 0.625;
export const BILATERAL_RATE = 1.5;
export const BILATERAL_EACH_SIDE_RATE = 2.0;
export const MULTIPLE_PROCEDURE_SUBSEQUENT_RATE = 0.5;

/** Non-physician practitioners billing under their own NPI are paid 85% of the physician amount. */
export const NPP_RATE = 0.85;

/** BCA sequestration reduces the Medicare PAYMENT by 2% — not the allowed amount, and not the patient's share. */
export const SEQUESTRATION_RATE = 0.02;
/** CARC 253 is how sequestration appears on the remittance. */
export const SEQUESTRATION_CARC = "253";

/** Medicare pays 80% of the allowed amount; the beneficiary owes the other 20%. */
export const MEDICARE_BENEFIT_RATE = 0.8;

/** Fallback conversion factor when no mpfs-cf.json is installed. */
export const DEFAULT_CONVERSION_FACTOR = 32.35;

export interface Gpci {
  work: number;
  pe: number;
  mp: number;
}

/** Unadjusted national values — every GPCI is 1.0 before locality is applied. */
export const NATIONAL_GPCI: Gpci = { work: 1, pe: 1, mp: 1 };

/**
 * A row of the MPFS relative value file. `pe` is the non-facility practice
 * expense RVU (the historical shape of this project's mpfs.json); `facilityPe`
 * is optional so older data files keep working, degraded to non-facility.
 */
export interface RvuRow {
  work: number;
  pe: number;
  facilityPe?: number;
  mp: number;
  /** MPFS payment policy indicators, as published in the same file. */
  bilateral?: string;
  multipleProcedure?: string;
  assistantSurgery?: string;
  coSurgery?: string;
}

/** Places of service Medicare treats as facility settings for practice-expense purposes. */
export const FACILITY_PLACES_OF_SERVICE = new Set([
  "19", "21", "22", "23", "24", "26", "31", "34", "41", "42", "51", "52", "53", "56", "61",
]);

export function isFacilitySetting(placeOfService: string): boolean {
  return FACILITY_PLACES_OF_SERVICE.has(placeOfService.trim());
}

/**
 * Practice expense is the component that moves with setting: in a facility the
 * hospital is paid separately for overhead, so the physician's PE RVU is lower.
 * Billing an office rate for a service performed in a hospital is a common and
 * quietly expensive error in both directions.
 */
export function practiceExpenseRvu(row: RvuRow, facility: boolean): number {
  if (!facility) return row.pe;
  return row.facilityPe ?? row.pe;
}

export function totalAdjustedRvu(row: RvuRow, facility: boolean, gpci: Gpci = NATIONAL_GPCI): number {
  return row.work * gpci.work + practiceExpenseRvu(row, facility) * gpci.pe + row.mp * gpci.mp;
}

export interface AdjustmentStep {
  factor: number;
  label: string;
}

export interface ModifierContext {
  modifiers: string[];
  /** 1 for the highest-valued procedure on the claim, 2 for the next, and so on. */
  multipleProcedureRank?: number;
  /** True when a PA/NP/CNS bills the service under their own NPI. */
  renderedByNpp?: boolean;
}

function has(modifiers: string[], ...wanted: string[]): boolean {
  const set = new Set(modifiers.map((m) => m.trim().toUpperCase()));
  return wanted.some((w) => set.has(w));
}

export interface ModifierResult {
  steps: AdjustmentStep[];
  warnings: string[];
  /** Set when a modifier makes the service not payable at all. */
  notPayable: string | null;
}

/**
 * Translate modifiers into payment factors, checking each against the code's own
 * MPFS policy indicator. The indicators matter: modifier 50 on a code whose
 * bilateral indicator is 0 buys nothing, and an assistant surgeon on a code with
 * assistant indicator 1 is not payable at all no matter how it is billed.
 */
export function modifierAdjustments(row: RvuRow, ctx: ModifierContext): ModifierResult {
  const steps: AdjustmentStep[] = [];
  const warnings: string[] = [];
  let notPayable: string | null = null;
  const mods = ctx.modifiers ?? [];

  // ── Bilateral (modifier 50) ──
  if (has(mods, "50")) {
    const indicator = row.bilateral;
    if (indicator === "1") {
      steps.push({ factor: BILATERAL_RATE, label: "Modifier 50 bilateral: 150% (BILAT SURG indicator 1)" });
    } else if (indicator === "3") {
      steps.push({
        factor: BILATERAL_EACH_SIDE_RATE,
        label: "Modifier 50: 100% of the fee schedule for each side (BILAT SURG indicator 3)",
      });
    } else if (indicator === "2") {
      warnings.push(
        "BILAT SURG indicator 2: the RVUs already represent the bilateral procedure, so modifier 50 does not increase payment. Expect 100% of a single code.",
      );
    } else if (indicator === "0" || indicator === "9") {
      warnings.push(
        `BILAT SURG indicator ${indicator}: the bilateral adjustment does not apply to this code. Expect 100% of a single code regardless of modifier 50.`,
      );
    } else {
      warnings.push(
        "Modifier 50 billed but this code's BILAT SURG indicator is not in the installed data — the 150% adjustment is assumed NOT to apply. Verify against the MPFS file.",
      );
    }
  }

  // ── Assistant at surgery (80, 81, 82, AS) ──
  if (has(mods, "80", "81", "82", "AS")) {
    if (row.assistantSurgery === "1") {
      notPayable =
        "ASST SURG indicator 1: a statutory payment restriction applies to this procedure — an assistant at surgery is not payable, regardless of documentation.";
    } else {
      steps.push({ factor: ASSISTANT_SURGEON_RATE, label: "Assistant at surgery: 16% of the surgeon's amount" });
      if (row.assistantSurgery === "0") {
        warnings.push(
          "ASST SURG indicator 0: payable only with documentation supporting the medical necessity of an assistant. Expect a records request if it is not on file.",
        );
      }
      if (has(mods, "AS")) {
        steps.push({
          factor: NPP_RATE,
          label: "Modifier AS (PA/NP/CNS assistant): 85% of the assistant amount, so 13.6% of the surgeon's fee",
        });
      }
    }
  }

  // ── Co-surgeons (modifier 62) ──
  if (has(mods, "62")) {
    if (row.coSurgery === "0") {
      notPayable = "CO-SURG indicator 0: co-surgeons are not permitted for this procedure.";
    } else {
      steps.push({ factor: CO_SURGEON_RATE, label: "Modifier 62 co-surgery: 62.5% of the global amount, to each surgeon" });
      if (row.coSurgery === "1") {
        warnings.push("CO-SURG indicator 1: permitted, but documentation establishing medical necessity is required.");
      }
    }
  }

  // ── Multiple procedure reduction ──
  const rank = ctx.multipleProcedureRank ?? 1;
  if (rank > 1) {
    if (row.multipleProcedure === "2" || row.multipleProcedure === undefined) {
      steps.push({
        factor: MULTIPLE_PROCEDURE_SUBSEQUENT_RATE,
        label: `Multiple procedure reduction: 50% (procedure ranked ${rank} by value)`,
      });
      if (row.multipleProcedure === undefined) {
        warnings.push(
          "MULT PROC indicator not in the installed data — the standard 100%/50% reduction is assumed. Endoscopy and imaging families use different rules.",
        );
      }
    } else if (row.multipleProcedure === "3") {
      warnings.push(
        "MULT PROC indicator 3: special endoscopy rules apply — the base endoscopy value is subtracted rather than a flat 50% taken. Not modelled; check the MPFS.",
      );
    } else if (row.multipleProcedure === "0" || row.multipleProcedure === "9") {
      warnings.push(`MULT PROC indicator ${row.multipleProcedure}: no multiple-procedure reduction applies to this code.`);
    } else {
      warnings.push(
        `MULT PROC indicator ${row.multipleProcedure}: a component-specific reduction applies that this estimator does not model. Check the MPFS.`,
      );
    }
  }

  // ── Non-physician practitioner billing independently ──
  if (ctx.renderedByNpp && !has(mods, "AS")) {
    steps.push({ factor: NPP_RATE, label: "Billed under a PA/NP/CNS's own NPI: 85% of the physician fee schedule" });
  }

  return { steps, warnings, notPayable };
}

export interface EstimateInput {
  code: string;
  row: RvuRow;
  units?: number;
  placeOfService?: string;
  gpci?: Gpci;
  conversionFactor?: number;
  modifiers?: string[];
  multipleProcedureRank?: number;
  renderedByNpp?: boolean;
  /** Medicare only — commercial payers are not sequestered. */
  applySequestration?: boolean;
}

export interface Estimate {
  code: string;
  facility: boolean;
  adjustedRvu: number;
  conversionFactor: number;
  units: number;
  baseAllowed: number;
  allowed: number;
  steps: AdjustmentStep[];
  medicarePayment: number;
  patientResponsibility: number;
  sequestration: number;
  warnings: string[];
  notPayable: string | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function estimateAllowed(input: EstimateInput): Estimate {
  const units = input.units ?? 1;
  const gpci = input.gpci ?? NATIONAL_GPCI;
  const cf = input.conversionFactor ?? DEFAULT_CONVERSION_FACTOR;
  const facility = isFacilitySetting(input.placeOfService ?? "11");

  const adjustedRvu = totalAdjustedRvu(input.row, facility, gpci);
  const baseAllowed = adjustedRvu * cf * units;

  const { steps, warnings, notPayable } = modifierAdjustments(input.row, {
    modifiers: input.modifiers ?? [],
    multipleProcedureRank: input.multipleProcedureRank,
    renderedByNpp: input.renderedByNpp,
  });

  const allowed = notPayable ? 0 : steps.reduce((amount, s) => amount * s.factor, baseAllowed);

  // Sequestration reduces the Medicare share only. The beneficiary still owes
  // 20% of the full allowed amount, which is why a sequestered line never
  // reconciles if you take 2% off the allowed instead of off the payment.
  const medicareShare = allowed * MEDICARE_BENEFIT_RATE;
  const sequestration = input.applySequestration ? medicareShare * SEQUESTRATION_RATE : 0;

  return {
    code: input.code,
    facility,
    adjustedRvu: round2(adjustedRvu),
    conversionFactor: cf,
    units,
    baseAllowed: round2(baseAllowed),
    allowed: round2(allowed),
    steps,
    medicarePayment: round2(medicareShare - sequestration),
    patientResponsibility: round2(allowed - medicareShare),
    sequestration: round2(sequestration),
    warnings,
    notPayable,
  };
}

export function renderEstimate(e: Estimate): string {
  const lines: string[] = [
    `${e.code} — ${e.facility ? "facility" : "non-facility"} setting, ${e.units} unit(s)`,
    `  Adjusted RVU ${e.adjustedRvu} × CF $${e.conversionFactor} × ${e.units} = $${e.baseAllowed.toFixed(2)} before modifier rules`,
  ];
  for (const s of e.steps) lines.push(`  × ${s.factor} — ${s.label}`);
  if (e.notPayable) {
    lines.push("", `NOT PAYABLE: ${e.notPayable}`);
  } else {
    lines.push(
      "",
      `Expected allowed amount: $${e.allowed.toFixed(2)}`,
      `  Medicare pays $${e.medicarePayment.toFixed(2)}${e.sequestration > 0 ? ` (after $${e.sequestration.toFixed(2)} sequestration, CARC ${SEQUESTRATION_CARC})` : ""}`,
      `  Patient responsibility $${e.patientResponsibility.toFixed(2)} (20% coinsurance, before any unmet deductible)`,
    );
  }
  if (e.warnings.length) {
    lines.push("", "Check:");
    for (const w of e.warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}
