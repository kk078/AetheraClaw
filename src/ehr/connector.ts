// ── The EHR seam ─────────────────────────────────────────────────────────────
//
// D6 in the roadmap: this is a SEAM in v1, not an integration, and the reason
// is worth restating rather than assuming. A real Epic or Cerner connection is
// a procurement exercise — an App Orchard or code listing, a client id issued
// by each hospital, a security review, a go-live window. None of that is
// engineering work, and building against a vendor's documentation without ever
// being able to call it produces code that is confidently wrong in ways nobody
// finds until the first real patient.
//
// So: one interface, and one reference implementation against a PUBLIC server
// that can actually be called. Anything more is scope that cannot be finished
// honestly.
//
// WHAT THIS DELIBERATELY DOES NOT DO:
//
//   No writes. Every method here READS. An EHR is the clinical record of record
//   and a billing system writing into it — even a note, even an encounter
//   status — is a different product with a different approval story. A read-only
//   seam cannot corrupt a chart.
//
//   No patient search by name. `findPatient` takes an MRN or an identifier,
//   never a demographic query. A name search against a hospital's FHIR server
//   returns other people's records, and a billing question never needs that.
//
//   No silent demo data. There is no mock EHR that invents a patient. If no
//   connector is configured the tools say so, because a fabricated chart is
//   worse here than anywhere else in this product: it looks like the source of
//   truth.

export type EhrEnv = "sandbox" | "production";

export interface EhrMeta {
  connector: string;
  environment: EhrEnv;
  /** The server actually called, so a support ticket can name it. */
  baseUrl: string;
  /** Never true in this build — see the header. Present so a caller must ask. */
  simulated: boolean;
}

export interface EhrPatient {
  /** The FHIR resource id, which is the server's, not the practice's. */
  id: string;
  mrn: string;
  familyName: string;
  givenName: string;
  /** CCYYMMDD, converted from FHIR's YYYY-MM-DD. */
  birthDate: string;
  gender: string;
}

export interface EhrCoverage {
  id: string;
  status: string;
  payerName: string;
  subscriberId: string;
  /** "primary" / "secondary" as the server states it, unmodified. */
  order: string;
  planName: string;
}

export interface EhrEncounter {
  id: string;
  status: string;
  /** CCYYMMDD. */
  date: string;
  type: string;
  /** Codes the EHR already has on the encounter, for comparison — NOT for billing. */
  diagnoses: string[];
}

export interface EhrConnector {
  readonly name: string;
  readonly environment: EhrEnv;

  /** By MRN or a system|value identifier. Never by name — see the header. */
  findPatient(identifier: string): Promise<EhrPatient | null>;
  coverages(patientId: string): Promise<EhrCoverage[]>;
  encounters(patientId: string, sinceYmd: string): Promise<EhrEncounter[]>;
}

// ── Parsing, kept pure ───────────────────────────────────────────────────────
// Exported separately from the connector so a recorded Bundle can be replayed in
// a test with no network — the same shape the clearinghouse connector uses, and
// for the same reason: the mapping is where the bugs are, and the mapping is the
// part that can be tested offline.

interface FhirIdentifier { system?: string; value?: string; type?: { coding?: Array<{ code?: string }> } }
interface FhirName { family?: string; given?: string[] }
interface FhirCoding { code?: string; display?: string; system?: string }

/** FHIR dates are YYYY-MM-DD; everything downstream here speaks CCYYMMDD. */
export function fhirDateToYmd(date: string | undefined): string {
  if (!date) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  return m ? `${m[1]}${m[2]}${m[3]}` : "";
}

/**
 * Pick the MRN out of a patient's identifiers.
 *
 * Preference order matters: a Patient carries several identifiers and picking
 * the first would return whatever the server happened to list first — often an
 * internal id that means nothing to the practice. The one labelled MR is the
 * medical record number a human would recognise.
 */
export function pickMrn(identifiers: FhirIdentifier[] | undefined): string {
  const list = identifiers ?? [];
  const byType = list.find((i) => i.type?.coding?.some((c) => c.code === "MR"));
  if (byType?.value) return byType.value;
  const bySystem = list.find((i) => /mrn|medical.?record/i.test(i.system ?? ""));
  if (bySystem?.value) return bySystem.value;
  return list[0]?.value ?? "";
}

export function parsePatient(resource: Record<string, unknown>): EhrPatient {
  const name = ((resource.name as FhirName[] | undefined) ?? [])[0] ?? {};
  return {
    id: String(resource.id ?? ""),
    mrn: pickMrn(resource.identifier as FhirIdentifier[] | undefined),
    familyName: String(name.family ?? ""),
    givenName: (name.given ?? [])[0] ?? "",
    birthDate: fhirDateToYmd(resource.birthDate as string | undefined),
    gender: String(resource.gender ?? ""),
  };
}

export function parseCoverage(resource: Record<string, unknown>): EhrCoverage {
  const payors = (resource.payor as Array<{ display?: string }> | undefined) ?? [];
  const cls = (resource.class as Array<{ type?: { coding?: FhirCoding[] }; name?: string; value?: string }> | undefined) ?? [];
  const plan = cls.find((c) => c.type?.coding?.some((x) => x.code === "plan"));
  return {
    id: String(resource.id ?? ""),
    // Reported as the server states it. An empty status is NOT read as active:
    // an EHR's coverage record is what the front desk typed, and treating a
    // blank as coverage is how a claim goes to a plan that ended in March.
    status: String(resource.status ?? ""),
    payerName: payors[0]?.display ?? "",
    subscriberId: String(resource.subscriberId ?? ""),
    order: String(resource.order ?? ""),
    planName: plan?.name ?? plan?.value ?? "",
  };
}

export function parseEncounter(resource: Record<string, unknown>): EhrEncounter {
  const type = ((resource.type as Array<{ coding?: FhirCoding[]; text?: string }> | undefined) ?? [])[0];
  const period = (resource.period as { start?: string } | undefined) ?? {};
  const diagnoses = ((resource.diagnosis as Array<{ condition?: { display?: string } }> | undefined) ?? [])
    .map((d) => d.condition?.display ?? "")
    .filter(Boolean);
  return {
    id: String(resource.id ?? ""),
    status: String(resource.status ?? ""),
    date: fhirDateToYmd(period.start),
    type: type?.coding?.[0]?.display ?? type?.text ?? "",
    diagnoses,
  };
}

/** Pull resources of one type out of a searchset Bundle. */
export function bundleResources(bundle: unknown, resourceType: string): Array<Record<string, unknown>> {
  const entries = ((bundle as { entry?: Array<{ resource?: Record<string, unknown> }> })?.entry ?? [])
    .map((e) => e.resource)
    .filter((r): r is Record<string, unknown> => !!r);
  // Filtered by type rather than trusted: a Bundle legitimately carries
  // OperationOutcome and included resources alongside the matches, and reading
  // an OperationOutcome as a Patient produces a patient with no name and no
  // birth date — which looks like a data-quality problem rather than a bug.
  return entries.filter((r) => r.resourceType === resourceType);
}

// ── Reconciliation, which is the point of reading at all ─────────────────────

export interface DemographicMismatch {
  field: string;
  ehrValue: string;
  claimValue: string;
  /** Whether this one causes a payer rejection on its own. */
  blocking: boolean;
  note: string;
}

/**
 * Compare what the EHR holds against what a claim says.
 *
 * This is why a billing system reads a chart. AAA code 71 (date of birth
 * mismatch) and 72 (invalid member id) are the two most common eligibility
 * rejections there are, and both are usually a transcription difference between
 * the chart and the claim rather than anything about the patient.
 *
 * Case and punctuation are normalised on names because "O'BRIEN" and "OBrien"
 * are not a mismatch worth a person's time. Birth date and member id are
 * compared exactly, because there is no such thing as a nearly-right one.
 */
export function reconcileDemographics(
  ehr: { patient: EhrPatient; coverages: EhrCoverage[] },
  claim: { patientLast: string; patientFirst: string; patientDob: string; subscriberId: string },
): DemographicMismatch[] {
  const out: DemographicMismatch[] = [];
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, "");

  if (ehr.patient.birthDate && claim.patientDob && ehr.patient.birthDate !== claim.patientDob) {
    out.push({
      field: "birthDate",
      ehrValue: ehr.patient.birthDate,
      claimValue: claim.patientDob,
      blocking: true,
      note: "A date-of-birth difference is AAA rejection code 71 — the payer will not identify the patient, and the enquiry says nothing about coverage.",
    });
  }
  if (ehr.patient.familyName && claim.patientLast && norm(ehr.patient.familyName) !== norm(claim.patientLast)) {
    out.push({
      field: "familyName",
      ehrValue: ehr.patient.familyName,
      claimValue: claim.patientLast,
      blocking: false,
      note: "Surnames differ beyond case and punctuation. Often a marriage or a hyphen the chart has and the claim does not; check which one the PAYER holds, not which is correct.",
    });
  }
  const ids = ehr.coverages.map((c) => c.subscriberId).filter(Boolean);
  if (ids.length > 0 && claim.subscriberId && !ids.includes(claim.subscriberId)) {
    out.push({
      field: "subscriberId",
      ehrValue: ids.join(", "),
      claimValue: claim.subscriberId,
      blocking: true,
      note: "The member id on the claim is not one the chart holds. This is AAA rejection code 72 waiting to happen.",
    });
  }
  return out;
}

export function renderMismatches(mismatches: DemographicMismatch[]): string {
  if (mismatches.length === 0) {
    return "The chart and the claim agree on the patient's identifiers. That is not a statement about coverage — run eligibility for that.";
  }
  const blocking = mismatches.filter((m) => m.blocking);
  const lines = [
    `${mismatches.length} difference(s) between the chart and the claim` +
      (blocking.length > 0 ? `, ${blocking.length} of which will cause a payer rejection` : ""),
    "",
  ];
  for (const m of mismatches) {
    lines.push(`  ${m.blocking ? "BLOCKING" : "check   "} ${m.field}: chart "${m.ehrValue}" vs claim "${m.claimValue}"`);
    lines.push(`      ${m.note}`);
  }
  lines.push(
    "",
    // The sentence that stops somebody "fixing" the chart to match the claim.
    "Neither side is automatically right. The chart is what the practice recorded; the claim is what will be filed; " +
      "the payer's own record is a third thing and is the only one that decides whether a claim adjudicates.",
  );
  return lines.join("\n");
}
