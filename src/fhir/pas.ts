import { PA_API_COMPLIANCE_DATE, X12_278_ENFORCEMENT_NOTE } from "./pa-clock.js";

// ── Prior Authorization Support ──────────────────────────────────────────────
// PAS submits the request as a FHIR Bundle to Claim/$submit, with `use` set to
// "preauthorization" — the same Claim resource that carries a billed claim,
// asking rather than telling.
//
// Underneath, most payers still translate it to X12 278 and translate the answer
// back. That matters when a request comes back rejected for something that is
// not in the FHIR resource at all: the failure happened in a transaction the
// practice never saw.

export interface PasService {
  code: string;
  codeSystem: string;
  quantity: number;
  /** YYYY-MM-DD the service is expected. */
  startDate: string;
  endDate: string;
  diagnosisRefs: number[];
}

export interface PasRequest {
  /** De-identified reference, never a name. */
  patientRef: string;
  payer: string;
  requestingProviderNpi: string;
  /** The facility or practitioner who will perform it. */
  performingProviderNpi: string;
  diagnoses: string[];
  services: PasService[];
  urgent: boolean;
  /** QuestionnaireResponse ids gathered from DTR, when the payer asked for one. */
  questionnaireResponses: string[];
}

export interface PasValidation {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

/**
 * Catch what a payer will reject, before it costs a round trip.
 *
 * Diagnosis pointers get the same treatment as on a claim, and for the same
 * reason: a service that points at nothing has no stated indication, and a
 * request with no indication is denied for medical necessity rather than
 * returned as malformed — which looks like a clinical answer and is not.
 */
export function validatePas(request: PasRequest): PasValidation {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (!/^\d{10}$/.test(request.requestingProviderNpi)) problems.push("Requesting provider NPI must be ten digits.");
  if (!/^\d{10}$/.test(request.performingProviderNpi)) problems.push("Performing provider NPI must be ten digits.");
  if (request.diagnoses.length === 0) problems.push("At least one diagnosis is required.");
  if (request.services.length === 0) problems.push("At least one requested service is required.");

  request.services.forEach((service, i) => {
    const n = i + 1;
    if (service.quantity <= 0) problems.push(`Service ${n} (${service.code}) has a non-positive quantity.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(service.startDate)) {
      problems.push(`Service ${n} start date must be YYYY-MM-DD.`);
    }
    if (service.endDate && service.endDate < service.startDate) {
      problems.push(`Service ${n} ends before it starts.`);
    }
    if (service.diagnosisRefs.length === 0) {
      problems.push(
        `Service ${n} (${service.code}) points at no diagnosis. A request with no stated indication comes back denied for medical necessity, which reads as a clinical answer and is not one.`,
      );
    }
    for (const ref of service.diagnosisRefs) {
      if (ref < 1 || ref > request.diagnoses.length) {
        problems.push(`Service ${n} points at diagnosis ${ref}, but only ${request.diagnoses.length} are listed.`);
      }
    }
  });

  if (request.urgent) {
    warnings.push(
      "Marked expedited. That obliges the payer to decide within 72 hours, and it is a clinical assertion that the standard timeframe would seriously jeopardise the patient — not a way to move up a queue.",
    );
  }
  if (request.questionnaireResponses.length === 0) {
    warnings.push(
      "No questionnaire response attached. If the payer's CRD response offered a DTR questionnaire, a request without it is usually pended for information rather than decided.",
    );
  }

  return { ok: problems.length === 0, problems, warnings };
}

/**
 * Build the PAS Bundle.
 *
 * `use: "preauthorization"` is the field that makes this a request rather than
 * a bill — the same Claim resource carries both, and the one word is the whole
 * difference.
 */
export function buildPasBundle(request: PasRequest, requestId: string): Record<string, unknown> | string {
  const validation = validatePas(request);
  if (!validation.ok) {
    return `Not built: ${validation.problems.join(" ")}`;
  }

  const claim = {
    resourceType: "Claim",
    id: requestId,
    status: "active",
    // The word that makes this an authorization request rather than a bill.
    use: "preauthorization",
    type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/claim-type", code: "professional" }] },
    priority: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/processpriority",
          code: request.urgent ? "stat" : "normal",
        },
      ],
    },
    patient: { reference: `Patient/${request.patientRef}` },
    created: new Date().toISOString(),
    provider: { identifier: { system: "http://hl7.org/fhir/sid/us-npi", value: request.requestingProviderNpi } },
    insurer: { display: request.payer },
    diagnosis: request.diagnoses.map((code, i) => ({
      sequence: i + 1,
      diagnosisCodeableConcept: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code }] },
    })),
    item: request.services.map((service, i) => ({
      sequence: i + 1,
      diagnosisSequence: service.diagnosisRefs,
      productOrService: { coding: [{ system: service.codeSystem, code: service.code }] },
      quantity: { value: service.quantity },
      servicedPeriod: { start: service.startDate, ...(service.endDate ? { end: service.endDate } : {}) },
      ...(request.performingProviderNpi
        ? {
            provider: {
              identifier: { system: "http://hl7.org/fhir/sid/us-npi", value: request.performingProviderNpi },
            },
          }
        : {}),
    })),
    supportingInfo: request.questionnaireResponses.map((id, i) => ({
      sequence: i + 1,
      category: { coding: [{ code: "info" }] },
      valueReference: { reference: `QuestionnaireResponse/${id}` },
    })),
  };

  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [{ resource: claim }],
  };
}

export type PasOutcome = "approved" | "denied" | "pended" | "partial" | "error";

export interface PasResponse {
  outcome: PasOutcome;
  /** The payer's authorization number. Without it, nothing was authorized. */
  authorizationNumber: string;
  /** Per-service dispositions, since a partial approval is common and easy to miss. */
  services: Array<{ code: string; decision: string; reason: string }>;
  /** Free text the payer returned, passed through rather than summarized. */
  disposition: string;
  gaps: string[];
}

interface RawClaimResponse {
  outcome?: string;
  preAuthRef?: string;
  disposition?: string;
  item?: Array<{
    itemSequence?: number;
    adjudication?: Array<{ category?: { coding?: Array<{ code?: string }> }; reason?: { coding?: Array<{ code?: string; display?: string }> } }>;
  }>;
  error?: Array<{ code?: { coding?: Array<{ code?: string; display?: string }> } }>;
}

/**
 * Read the ClaimResponse.
 *
 * A partial approval is the case that gets missed: the outcome says "complete",
 * the authorization number is present, and one of four requested services was
 * quietly refused. Per-service dispositions are read individually for that
 * reason.
 */
export function readPasResponse(raw: RawClaimResponse, requestedCodes: string[]): PasResponse {
  const gaps: string[] = [];
  const services: PasResponse["services"] = [];

  for (const item of raw.item ?? []) {
    const seq = item.itemSequence ?? 0;
    const code = requestedCodes[seq - 1] ?? `item ${seq}`;
    const adjudication = item.adjudication?.[0];
    const decision = adjudication?.category?.coding?.[0]?.code ?? "unstated";
    const reason = adjudication?.reason?.coding?.[0]?.display ?? adjudication?.reason?.coding?.[0]?.code ?? "";
    services.push({ code, decision, reason });
  }

  const denied = services.filter((s) => /denied|rejected|not.?approved/i.test(s.decision));
  const approved = services.filter((s) => /approved|authorized|complete/i.test(s.decision));

  let outcome: PasOutcome;
  if (raw.outcome === "error" || (raw.error ?? []).length > 0) outcome = "error";
  else if (raw.outcome === "queued" || /pend/i.test(raw.disposition ?? "")) outcome = "pended";
  else if (denied.length > 0 && approved.length > 0) outcome = "partial";
  else if (denied.length > 0) outcome = "denied";
  else outcome = "approved";

  if (outcome === "approved" && !raw.preAuthRef) {
    gaps.push(
      "The response reads as approved but carries no authorization number. Nothing is authorized without one — the claim will deny for a missing authorization and the response above will not help.",
    );
  }
  if (outcome === "partial") {
    gaps.push(
      `Partially approved: ${denied.map((s) => s.code).join(", ")} was refused while the rest went through. This is the case that gets missed, because the response says approved and carries a number.`,
    );
  }
  if (services.length < requestedCodes.length) {
    gaps.push(
      `${requestedCodes.length} service(s) were requested and ${services.length} came back adjudicated. Whatever is missing was not decided.`,
    );
  }
  if ((raw.error ?? []).length > 0) {
    gaps.push(
      `The payer returned errors: ${(raw.error ?? []).map((e) => e.code?.coding?.[0]?.display ?? e.code?.coding?.[0]?.code).filter(Boolean).join("; ")}. Most payers translate PAS into X12 278 internally, so an error naming something absent from the FHIR request happened in a transaction never seen here.`,
    );
  }

  return {
    outcome,
    authorizationNumber: raw.preAuthRef ?? "",
    services,
    disposition: raw.disposition ?? "",
    gaps,
  };
}

export function renderPasResponse(response: PasResponse): string {
  const lines = [
    `Outcome: ${response.outcome}`,
    response.authorizationNumber
      ? `Authorization number: ${response.authorizationNumber}`
      : "Authorization number: NONE — nothing is authorized without one.",
  ];
  if (response.disposition) lines.push(`Payer said: ${response.disposition}`);
  if (response.services.length > 0) {
    lines.push("", "Per service:");
    for (const s of response.services) {
      lines.push(`  ${s.code}: ${s.decision}${s.reason ? ` — ${s.reason}` : ""}`);
    }
  }
  if (response.gaps.length > 0) lines.push("", ...response.gaps.map((g) => `⚠ ${g}`));
  lines.push(
    "",
    `The FHIR Prior Authorization API is required from ${PA_API_COMPLIANCE_DATE}. ${X12_278_ENFORCEMENT_NOTE}`,
  );
  return lines.join("\n");
}
