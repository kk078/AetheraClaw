import { z } from "zod";
import { defineTool } from "../registry.js";

// ── Place of Service code set ────────────────────────────────────────────────
// This table exists because nothing held it, and the gap was filled by
// invention. Asked what POS 22 means, a model in this system answered "Remote
// Telehealth (store-and-forward)". POS 22 is On Campus-Outpatient Hospital —
// the difference decides facility vs non-facility practice expense on every
// line, so the wrong answer moves real money.
//
// A model cannot look up what the system does not know. Adding the guardrail
// without adding the data would only have converted a confident wrong answer
// into a confident refusal. Source: CMS Place of Service Code Set
// (https://www.cms.gov/medicare/coding-billing/place-of-service-codes/code-sets).

export interface PosCode {
  code: string;
  name: string;
  description: string;
  /** Disambiguation shown on lookup but excluded from search — a note saying "this is NOT telehealth" must not make the code a telehealth hit. */
  note?: string;
}

export const POS_CODES: Record<string, PosCode> = Object.fromEntries(
  (
    [
      ["01", "Pharmacy", "A facility or location where drugs and other medically related items and services are sold, dispensed, or otherwise provided directly to patients."],
      ["02", "Telehealth Provided Other than in Patient's Home", "Health services provided through telecommunication technology where the patient is NOT located in their home."],
      ["03", "School", "A facility whose primary purpose is education."],
      ["04", "Homeless Shelter", "A facility or location whose primary purpose is to provide temporary housing to homeless individuals."],
      ["05", "Indian Health Service Free-standing Facility", "IHS facility providing diagnostic, therapeutic and rehabilitation services to American Indians and Alaska Natives who do not require hospitalization."],
      ["06", "Indian Health Service Provider-based Facility", "IHS facility providing physician services to American Indians and Alaska Natives admitted as inpatients or outpatients."],
      ["07", "Tribal 638 Free-standing Facility", "Tribal facility providing services to tribal members who do not require hospitalization."],
      ["08", "Tribal 638 Provider-based Facility", "Tribal facility providing services to tribal members admitted as inpatients or outpatients."],
      ["09", "Prison/Correctional Facility", "A prison, jail, reformatory, work farm, detention center or similar facility for confinement or rehabilitation of offenders."],
      ["10", "Telehealth Provided in Patient's Home", "Health services provided through telecommunication technology where the patient IS located in their home."],
      ["11", "Office", "Location where health professionals routinely provide examination, diagnosis and treatment on an ambulatory basis; excludes hospitals, SNFs and certain other facilities."],
      ["12", "Home", "Location, other than a hospital or other facility, where the patient receives care in a private residence."],
      ["13", "Assisted Living Facility", "Congregate residential facility with self-contained living units and on-site support 24/7."],
      ["14", "Group Home", "A residence with shared living areas where clients receive supervision and social, behavioral or custodial services."],
      ["15", "Mobile Unit", "A facility/unit that moves from place to place equipped to provide preventive, screening, diagnostic and/or treatment services."],
      ["16", "Temporary Lodging", "A short-term accommodation such as a hotel, campground, hostel, cruise ship or resort where the patient receives care."],
      ["17", "Walk-in Retail Health Clinic", "A walk-in health clinic within a retail operation providing preventive and primary care on an ambulatory basis."],
      ["18", "Place of Employment-Worksite", "A location where a health professional provides occupational medical, therapeutic or rehabilitative services."],
      ["19", "Off Campus-Outpatient Hospital", "A portion of an OFF-campus hospital provider-based department providing services to persons who do not require hospitalization."],
      ["20", "Urgent Care Facility", "Location distinct from an ER, office or clinic, to diagnose and treat unscheduled ambulatory patients seeking immediate attention."],
      ["21", "Inpatient Hospital", "A facility, other than psychiatric, primarily providing diagnostic, therapeutic and rehabilitation services to admitted patients."],
      ["22", "On Campus-Outpatient Hospital", "A portion of a hospital's MAIN CAMPUS providing services to persons who do not require hospitalization.", "This is a facility setting, not a telehealth code — telehealth is 02 or 10."],
      ["23", "Emergency Room – Hospital", "A portion of a hospital where emergency diagnosis and treatment of illness or injury is provided."],
      ["24", "Ambulatory Surgical Center", "A freestanding facility, other than a physician's office, where surgical and diagnostic services are provided on an ambulatory basis."],
      ["25", "Birthing Center", "A facility providing a setting for labor, delivery, immediate post-partum care and immediate care of newborns."],
      ["26", "Military Treatment Facility", "A medical facility operated by one or more of the Uniformed Services, or a designated former U.S. Public Health Service facility."],
      ["27", "Outreach Site/Street", "A non-permanent location on the street or found environment where services are provided to unsheltered homeless individuals."],
      ["31", "Skilled Nursing Facility", "A facility primarily providing inpatient skilled nursing care and related services below the level available in a hospital."],
      ["32", "Nursing Facility", "A facility primarily providing skilled nursing care and rehabilitation, or health-related care above the level of custodial care."],
      ["33", "Custodial Care Facility", "A facility providing room, board and personal assistance services on a long-term basis, without a medical component."],
      ["34", "Hospice", "A facility, other than a patient's home, providing palliative and supportive care for terminally ill patients and their families."],
      ["41", "Ambulance - Land", "A land vehicle specifically designed, equipped and staffed for lifesaving and transporting the sick or injured."],
      ["42", "Ambulance – Air or Water", "An air or water vehicle specifically designed, equipped and staffed for lifesaving and transporting the sick or injured."],
      ["49", "Independent Clinic", "A location, not part of a hospital and not described by any other POS code, organized to provide services to outpatients only."],
      ["50", "Federally Qualified Health Center", "A facility in a medically underserved area providing preventive primary medical care under the general direction of a physician."],
      ["51", "Inpatient Psychiatric Facility", "A facility providing inpatient psychiatric services on a 24-hour basis by or under the supervision of a physician."],
      ["52", "Psychiatric Facility-Partial Hospitalization", "A facility providing a planned therapeutic program for patients who do not require full-time hospitalization."],
      ["53", "Community Mental Health Center", "Provides outpatient, emergency, day treatment, screening and consultation services for mental health conditions."],
      ["54", "Intermediate Care Facility/Individuals with Intellectual Disabilities", "A facility providing health-related care above the level of custodial care but below hospital or SNF level."],
      ["55", "Residential Substance Abuse Treatment Facility", "A facility providing substance abuse treatment to live-in residents who do not require acute medical care."],
      ["56", "Psychiatric Residential Treatment Center", "A facility for psychiatric care providing a 24-hour therapeutically planned and professionally staffed group living environment."],
      ["57", "Non-residential Substance Abuse Treatment Facility", "A location providing substance abuse treatment on an ambulatory basis."],
      ["58", "Non-residential Opioid Treatment Facility", "A location providing opioid use disorder treatment on an ambulatory basis, including methadone and other Medication Assisted Treatment."],
      ["60", "Mass Immunization Center", "A location where providers administer pneumococcal and influenza vaccinations, including via roster billing."],
      ["61", "Comprehensive Inpatient Rehabilitation Facility", "A facility providing comprehensive rehabilitation services under physician supervision to inpatients with physical disabilities."],
      ["62", "Comprehensive Outpatient Rehabilitation Facility", "A facility providing comprehensive rehabilitation services under physician supervision to outpatients with physical disabilities."],
      ["65", "End-Stage Renal Disease Treatment Facility", "A facility other than a hospital providing dialysis treatment, maintenance and/or training on an ambulatory or home-care basis."],
      ["66", "Programs of All-Inclusive Care for the Elderly (PACE) Center", "A facility providing comprehensive medical and social services as part of the PACE program."],
      ["71", "Public Health Clinic", "A facility maintained by a State or local health department providing ambulatory primary medical care under physician direction."],
      ["72", "Rural Health Clinic", "A certified facility in a rural medically underserved area providing ambulatory primary medical care under physician direction."],
      ["81", "Independent Laboratory", "A laboratory certified to perform diagnostic and/or clinical tests independent of an institution or a physician's office."],
      ["99", "Other Place of Service", "Other place of service not identified above."],
    ] as Array<[string, string, string, string?]>
  ).map(([code, name, description, note]) => [code, { code, name, description, ...(note ? { note } : {}) }]),
);

/** Code ranges CMS publishes as unassigned — a claim carrying one is a data error, not an unknown code. */
const UNASSIGNED_RANGES: Array<[number, number]> = [
  [28, 30],
  [35, 40],
  [43, 48],
  [59, 59],
  [63, 64],
  [67, 70],
  [73, 80],
  [82, 98],
];

export type PosStatus = "known" | "unassigned" | "invalid";

export function classifyPos(raw: string): { status: PosStatus; code: string; entry?: PosCode } {
  const code = raw.trim().padStart(2, "0");
  const entry = POS_CODES[code];
  if (entry) return { status: "known", code, entry };
  const n = Number(code);
  if (!/^\d{2}$/.test(code) || Number.isNaN(n)) return { status: "invalid", code };
  if (UNASSIGNED_RANGES.some(([lo, hi]) => n >= lo && n <= hi)) return { status: "unassigned", code };
  return { status: "invalid", code };
}

export function searchPos(query: string): PosCode[] {
  // Sorted explicitly: "10" is an array-index-shaped key and "02" is not, so
  // Object.values yields 10, 11, 12 … before 01, 02. A POS list out of numeric
  // order reads as a bug in the data.
  const all = Object.values(POS_CODES).sort((a, b) => a.code.localeCompare(b.code));
  const q = query.trim().toLowerCase();
  if (!q) return all;
  // `note` is deliberately not searched — see PosCode.note.
  return all.filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
}

export function renderPos(result: ReturnType<typeof classifyPos>): string {
  if (result.status === "known") {
    const e = result.entry!;
    return `POS ${e.code} — ${e.name}\n${e.description}${e.note ? `\n${e.note}` : ""}`;
  }
  if (result.status === "unassigned") {
    return `POS ${result.code} is unassigned in the CMS Place of Service code set. A claim carrying it will reject; it does not mean "other" — that is POS 99.`;
  }
  return `"${result.code}" is not a Place of Service code. POS codes are two digits, 01–99. Search by setting instead, e.g. pos_lookup with query "outpatient hospital".`;
}

export const posLookupTool = defineTool({
  name: "pos_lookup",
  description:
    "Look up a CMS Place of Service (POS) code, or search the code set by setting. POS drives facility vs non-facility practice expense on every service line and decides whether telehealth, incident-to and split/shared rules apply, so read it here rather than recalling it — 02 and 10 are the telehealth codes, 22 is On Campus-Outpatient Hospital.",
  schema: z.object({
    code: z.string().optional().describe("Two-digit POS code, e.g. '22'"),
    query: z.string().optional().describe("Setting to search for instead, e.g. 'ambulatory surgical' or 'telehealth'"),
  }),
  execute: async (input) => {
    if (input.code) return { content: renderPos(classifyPos(input.code)) };
    if (input.query !== undefined) {
      const hits = searchPos(input.query);
      if (hits.length === 0) {
        return { content: `No Place of Service code matches "${input.query}".` };
      }
      return { content: hits.map((e) => `POS ${e.code} — ${e.name}\n    ${e.description}`).join("\n") };
    }
    return { content: "Pass a code or a query.", isError: true };
  },
});
