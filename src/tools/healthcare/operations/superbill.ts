import { finding, type ScrubFinding } from "../finding.js";
import type { ClaimInput } from "../x12/837.js";

// ── Charge capture ───────────────────────────────────────────────────────────
// A superbill is how a clinical encounter becomes a claim, and the step that
// goes wrong is always the same one: diagnosis POINTERS. The 837 wants each line
// to reference diagnoses by their 1-based position in the claim's diagnosis
// list, so a human transcribing "this line is for the diabetes" has to know that
// diabetes happens to be third. Here each line names the diagnosis CODES it
// supports and the pointers are derived, which removes the error entirely.

export interface SuperbillLine {
  code: string;
  modifiers?: string[];
  charge: number;
  units?: number;
  serviceDate: string;
  placeOfService?: string;
  /** Diagnosis codes supporting this line, by code rather than by position. */
  diagnoses: string[];
}

export interface SuperbillInput {
  /**
   * The encounter's diagnoses in the order the coder intends them to appear —
   * primary first. Optional: without it the order falls out of which line came
   * first, which is usually right but is an accident rather than a decision.
   */
  encounterDiagnoses?: string[];
  claimId: string;
  payerName: string;
  payerId: string;
  billingProviderNpi: string;
  billingProviderName: string;
  renderingProviderNpi?: string;
  subscriberId: string;
  patientLast: string;
  patientFirst: string;
  patientDob: string;
  patientSex?: "M" | "F" | "U";
  lines: SuperbillLine[];
}

/** ICD-10 codes compare without dots or case, as everywhere else in the project. */
function normalizeDx(code: string): string {
  return code.replace(/\./g, "").trim().toUpperCase();
}

export interface SuperbillResult {
  claim: ClaimInput | null;
  findings: ScrubFinding[];
  /** Diagnosis list in pointer order, as it will appear in the claim. */
  diagnosisOrder: string[];
}

/** The 837 allows at most twelve diagnoses per claim and four pointers per line. */
export const MAX_DIAGNOSES = 12;
export const MAX_POINTERS_PER_LINE = 4;

/**
 * Turn a captured encounter into a claim, deriving diagnosis pointers from the
 * codes each line names. Diagnoses are ordered by first appearance across the
 * lines, so the primary diagnosis is whatever the first line is for — which is
 * what a coder means by ordering them.
 */
export function buildClaimFromSuperbill(input: SuperbillInput): SuperbillResult {
  const findings: ScrubFinding[] = [];
  const order: string[] = [];
  const seen = new Map<string, number>();

  const take = (raw: string) => {
    const key = normalizeDx(raw);
    if (!key || seen.has(key)) return;
    seen.set(key, order.length + 1);
    order.push(raw.trim().toUpperCase());
  };
  // The coder's stated order wins; anything a line names but the encounter list
  // missed is appended rather than dropped.
  for (const raw of input.encounterDiagnoses ?? []) take(raw);
  for (const line of input.lines) {
    for (const raw of line.diagnoses) take(raw);
  }

  if (order.length === 0) {
    findings.push(
      finding("error", "superbill-no-diagnosis", "No diagnosis codes were captured. Every service line must name at least one."),
    );
  }
  if (order.length > MAX_DIAGNOSES) {
    findings.push(
      finding(
        "error",
        "superbill-too-many-diagnoses",
        `${order.length} distinct diagnoses were captured but an 837 claim carries at most ${MAX_DIAGNOSES}. Split the encounter or drop the diagnoses that support no line.`,
      ),
    );
  }
  if (input.lines.length === 0) {
    findings.push(finding("error", "superbill-no-lines", "No service lines were captured."));
  }

  const serviceLines = input.lines.map((line, i) => {
    const n = i + 1;
    const pointers: number[] = [];
    for (const raw of line.diagnoses) {
      const pointer = seen.get(normalizeDx(raw));
      if (pointer === undefined) continue;
      if (!pointers.includes(pointer)) pointers.push(pointer);
    }
    if (pointers.length === 0) {
      findings.push(
        finding(
          "error",
          "superbill-line-unlinked",
          `Line ${n} (${line.code}) names no diagnosis. A service with nothing to justify it denies for medical necessity.`,
        ),
      );
    }
    if (pointers.length > MAX_POINTERS_PER_LINE) {
      findings.push(
        finding(
          "warning",
          "superbill-too-many-pointers",
          `Line ${n} (${line.code}) points at ${pointers.length} diagnoses but an 837 line carries at most ${MAX_POINTERS_PER_LINE}. The first ${MAX_POINTERS_PER_LINE} are kept, in the order captured — confirm the most relevant one is first.`,
        ),
      );
    }
    if (line.charge <= 0) {
      findings.push(finding("error", "superbill-zero-charge", `Line ${n} (${line.code}) has no charge.`));
    }
    return {
      cpt_hcpcs: line.code.trim().toUpperCase(),
      modifiers: line.modifiers,
      charge: line.charge,
      units: line.units ?? 1,
      dx_pointers: pointers.slice(0, MAX_POINTERS_PER_LINE),
      service_date: line.serviceDate,
      place_of_service: line.placeOfService ?? "11",
    };
  });

  const unused = order.filter((dx) => !input.lines.some((l) => l.diagnoses.some((d) => normalizeDx(d) === normalizeDx(dx))));
  for (const dx of unused) {
    findings.push(
      finding("warning", "superbill-unused-diagnosis", `${dx} was captured but supports no service line — it will still be reported on the claim.`),
    );
  }

  const blocking = findings.some((f) => f.severity === "error");
  const claim: ClaimInput | null = blocking
    ? null
    : ({
        claim_id: input.claimId,
        payer_name: input.payerName,
        payer_id: input.payerId,
        billing_provider_npi: input.billingProviderNpi,
        billing_provider_name: input.billingProviderName,
        rendering_provider_npi: input.renderingProviderNpi,
        subscriber_id: input.subscriberId,
        patient_last: input.patientLast,
        patient_first: input.patientFirst,
        patient_dob: input.patientDob,
        patient_sex: input.patientSex ?? "U",
        diagnoses: order.slice(0, MAX_DIAGNOSES),
        service_lines: serviceLines,
      } as ClaimInput);

  if (!blocking) {
    findings.push(
      finding(
        "info",
        "superbill-built",
        `Claim assembled: ${serviceLines.length} line(s), ${order.length} diagnosis(es). Pointers were derived from the codes each line named — run claim_scrub before building the 837.`,
      ),
    );
  }

  return { claim, findings, diagnosisOrder: order };
}
