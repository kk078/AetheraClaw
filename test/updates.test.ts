import { describe, expect, it } from "vitest";
import {
  CODE_SETS,
  assessStaleness,
  currentRelease,
  editionLabel,
  fiscalYearOf,
  nextRelease,
  upcomingReleases,
} from "../src/tools/healthcare/updates/release-calendar.js";
import {
  assessCodeImpact,
  collectCodeUsage,
  diffCodeSets,
  normalizeCode,
  parentPrefixes,
  renderImpactReport,
  type CodeSnapshot,
  type CodeUsage,
} from "../src/tools/healthcare/updates/code-diff.js";
import {
  classifyPolicyChange,
  filterPolicyChanges,
  parseWhatsNewLocal,
  parseWhatsNewNational,
  renderPolicyChanges,
  toYmd,
  type PolicyChange,
} from "../src/tools/healthcare/updates/policy-watch.js";
import type { ClaimInput } from "../src/tools/healthcare/x12/837.js";
import type { Era } from "../src/tools/healthcare/x12/835.js";

const kinds = (impacts: Array<{ kind: string }>) => impacts.map((i) => i.kind);

// ── Release calendar ─────────────────────────────────────────────────────────

describe("code-set release calendar", () => {
  it("names the ICD-10 fiscal year for the year its October release runs into", () => {
    expect(fiscalYearOf("20260807")).toBe(2026);
    expect(fiscalYearOf("20260930")).toBe(2026);
    expect(fiscalYearOf("20261001")).toBe(2027);
    expect(fiscalYearOf("20261231")).toBe(2027);
  });

  it("labels fiscal-year sets FY and calendar-year sets CY", () => {
    expect(editionLabel("icd10cm", "20261001")).toBe("FY2027");
    expect(editionLabel("hcpcs", "20260701")).toBe("CY2026");
  });

  it("finds the next ICD-10 release across the April and October cadence", () => {
    expect(nextRelease("icd10cm", "20260807")).toBe("20261001");
    expect(nextRelease("icd10cm", "20261115")).toBe("20270401");
    expect(nextRelease("icd10cm", "20260401")).toBe("20261001");
  });

  it("treats a release effective today as already in force", () => {
    expect(currentRelease("icd10cm", "20261001")).toBe("20261001");
    expect(nextRelease("icd10cm", "20261001")).toBe("20270401");
  });

  it("rolls the next release into the following year from December", () => {
    expect(nextRelease("ncci", "20261215")).toBe("20270101");
    expect(nextRelease("cpt", "20260102")).toBe("20270101");
  });

  it("separates HCPCS drug cadence from the non-drug cadence", () => {
    // Non-drug items move in January and July; drugs and biologicals every quarter.
    expect(nextRelease("hcpcs", "20260501")).toBe("20260701");
    expect(nextRelease("hcpcs_drug", "20260501")).toBe("20260701");
    expect(nextRelease("hcpcs", "20260801")).toBe("20270101");
    expect(nextRelease("hcpcs_drug", "20260801")).toBe("20261001");
  });

  it("lists upcoming releases in date order within the horizon", () => {
    const up = upcomingReleases("20260901", 45);
    expect(up.length).toBeGreaterThan(0);
    expect(up.every((r) => r.effective > "20260901" && r.effective <= "20261016")).toBe(true);
    const dates = up.map((r) => r.effective);
    expect([...dates].sort()).toEqual(dates);
    // October 1 is a quadruple release: ICD-10-CM, ICD-10-PCS, NCCI, HCPCS drugs.
    expect(up.filter((r) => r.effective === "20261001").length).toBe(4);
  });

  it("excludes releases outside the horizon", () => {
    expect(upcomingReleases("20260807", 10)).toEqual([]);
  });

  it("reports the day count to a release", () => {
    const [first] = upcomingReleases("20260921", 30).filter((r) => r.setId === "icd10cm");
    expect(first.effective).toBe("20261001");
    expect(first.daysAway).toBe(10);
  });

  it("counts how many releases an installed edition has missed", () => {
    // FY2026 installed, evaluated after both the FY2027 and the following April release.
    const s = assessStaleness("icd10cm", "20251001", "20270501");
    expect(s.stale).toBe(true);
    expect(s.missedReleases).toBe(3); // 20260401, 20261001, 20270401
    expect(s.current).toBe("20270401");
    expect(s.message).toMatch(/reject on codes that no longer exist/);
  });

  it("calls an installed edition current when nothing has superseded it", () => {
    const s = assessStaleness("icd10cm", "20261001", "20261115");
    expect(s.stale).toBe(false);
    expect(s.missedReleases).toBe(0);
    expect(s.message).toMatch(/is current as of/);
  });

  it("does not count the installed release itself as missed", () => {
    expect(assessStaleness("ncci", "20260701", "20260701").missedReleases).toBe(0);
  });

  it("marks only ICD-10 sets as hierarchical", () => {
    expect(CODE_SETS.icd10cm.hierarchical).toBe(true);
    expect(CODE_SETS.icd10pcs.hierarchical).toBe(true);
    expect(CODE_SETS.hcpcs.hierarchical).toBe(false);
    expect(CODE_SETS.cpt.hierarchical).toBe(false);
  });

  it("says the date of service decides which edition applies", () => {
    expect(CODE_SETS.icd10cm.note).toMatch(/DATE OF SERVICE/);
  });
});

// ── Diffing ──────────────────────────────────────────────────────────────────

const snapshot = (codes: Record<string, string>, over: Partial<CodeSnapshot> = {}): CodeSnapshot => ({
  label: "test",
  effective: "20261001",
  codes,
  ...over,
});

describe("code-set diffing", () => {
  it("normalizes away dots and case so one code is one code", () => {
    expect(normalizeCode("E11.65")).toBe("E1165");
    expect(normalizeCode(" e1165 ")).toBe("E1165");
    expect(normalizeCode("99213")).toBe("99213");
  });

  it("matches a dotted code against an undotted one", () => {
    const d = diffCodeSets(snapshot({ "E11.65": "Type 2 diabetes with hyperglycemia" }), snapshot({ E1165: "Type 2 diabetes with hyperglycemia" }));
    expect(d.added).toEqual([]);
    expect(d.deleted).toEqual([]);
    expect(d.revised).toEqual([]);
  });

  it("separates additions, deletions, and rewordings", () => {
    const d = diffCodeSets(
      snapshot({ A01: "old alpha", B02: "beta", C03: "gamma" }),
      snapshot({ A01: "new alpha", B02: "beta", D04: "delta" }),
    );
    expect(d.added.map((a) => a.code)).toEqual(["D04"]);
    expect(d.deleted.map((a) => a.code)).toEqual(["C03"]);
    expect(d.revised).toEqual([{ code: "A01", from: "old alpha", to: "new alpha" }]);
    expect(d.previousCount).toBe(3);
    expect(d.nextCount).toBe(3);
  });

  it("does not treat whitespace or case changes as rewordings", () => {
    const d = diffCodeSets(snapshot({ A01: "Chronic  kidney disease" }), snapshot({ A01: "chronic kidney disease " }));
    expect(d.revised).toEqual([]);
  });

  it("indexes every proper prefix down to the three-character category", () => {
    const p = parentPrefixes(["E1165"]);
    expect([...p].sort()).toEqual(["E11", "E116"]);
    expect(p.has("E1165")).toBe(false); // a code is not its own parent
  });

  it("ignores prefixes shorter than a category", () => {
    expect(parentPrefixes(["A01"]).size).toBe(0);
  });
});

// ── Usage collection ─────────────────────────────────────────────────────────

const claim = (over: Partial<ClaimInput> = {}): ClaimInput =>
  ({
    claim_id: "C1",
    payer_name: "PAYER",
    payer_id: "P1",
    billing_provider_npi: "1234567893",
    billing_provider_name: "CLINIC",
    subscriber_id: "M1",
    patient_last: "DOE",
    patient_first: "JANE",
    patient_dob: "19700101",
    patient_sex: "F",
    diagnoses: ["E11.65"],
    service_lines: [
      { cpt_hcpcs: "99214", charge: 200, units: 1, dx_pointers: [1], service_date: "20260515", place_of_service: "11" },
    ],
    ...over,
  }) as ClaimInput;

const era = (lines: Array<{ procedure: string }>): Era =>
  ({
    payer: "PAYER",
    payee: "CLINIC",
    paymentAmount: 100,
    claims: [
      {
        claimId: "C1",
        statusCode: "1",
        charged: 200,
        paid: 100,
        patientResponsibility: 0,
        payerControlNumber: "PCN",
        lines: lines.map((l) => ({ ...l, charged: 200, paid: 100, units: 1, adjustments: [] })),
      },
    ],
  }) as unknown as Era;

describe("practice code usage", () => {
  it("collects diagnoses and procedures from submitted claims", () => {
    const u = collectCodeUsage([claim()], []);
    expect(u.diagnoses.get("E1165")?.count).toBe(1);
    expect(u.procedures.get("99214")?.count).toBe(1);
  });

  it("stamps the latest date of service on a diagnosis spanning several lines", () => {
    const u = collectCodeUsage(
      [
        claim({
          service_lines: [
            { cpt_hcpcs: "99213", charge: 100, units: 1, dx_pointers: [1], service_date: "20260201", place_of_service: "11" },
            { cpt_hcpcs: "99214", charge: 200, units: 1, dx_pointers: [1], service_date: "20260714", place_of_service: "11" },
          ],
        } as Partial<ClaimInput>),
      ],
      [],
    );
    expect(u.diagnoses.get("E1165")?.lastServiceDate).toBe("20260714");
    expect(u.procedures.get("99213")?.lastServiceDate).toBe("20260201");
  });

  it("accumulates counts across claims", () => {
    const u = collectCodeUsage([claim(), claim({ claim_id: "C2" })], []);
    expect(u.procedures.get("99214")?.count).toBe(2);
  });

  it("strips the modifier composite off remittance procedures", () => {
    const u = collectCodeUsage([], [era([{ procedure: "99214:25" }])]);
    expect(u.procedures.get("99214")?.count).toBe(1);
  });

  it("skips the synthetic claim-level line the 835 parser emits", () => {
    const u = collectCodeUsage([], [era([{ procedure: "(claim level)" }, { procedure: "99213" }])]);
    expect(u.procedures.has("(CLAIM LEVEL)")).toBe(false);
    expect(u.procedures.size).toBe(1);
  });

  it("leaves the service date blank for remittance-only procedures", () => {
    // ERA service lines carry no DTP*472, so a code seen only in a remittance
    // contributes a count without a date.
    const u = collectCodeUsage([], [era([{ procedure: "99215" }])]);
    expect(u.procedures.get("99215")?.lastServiceDate).toBe("");
  });
});

// ── Impact ───────────────────────────────────────────────────────────────────

const usageOf = (...codes: Array<[string, number]>): Map<string, CodeUsage> =>
  new Map(codes.map(([code, count]) => [code, { code, count, lastServiceDate: "20260515" }]));

const opts = (previousCodes: string[] = []) => ({
  setLabel: "ICD-10-CM FY2027",
  effective: "20261001",
  hierarchical: true,
  previousCodes,
});

describe("release impact against billed codes", () => {
  it("raises an error for a deleted code the practice bills", () => {
    const diff = diffCodeSets(snapshot({ E1165: "diabetes w/ hyperglycemia" }), snapshot({}));
    const r = assessCodeImpact(diff, usageOf(["E1165", 42]), opts(["E1165"]));
    expect(kinds(r.impacts)).toEqual(["deleted-in-use"]);
    expect(r.impacts[0].severity).toBe("error");
    expect(r.impacts[0].message).toMatch(/billed it 42 time\(s\)/);
    expect(r.impacts[0].message).toMatch(/date of service on or after 20261001/);
  });

  it("stays silent about deleted codes the practice never billed", () => {
    const diff = diffCodeSets(snapshot({ Z999: "something else" }), snapshot({}));
    const r = assessCodeImpact(diff, usageOf(["E1165", 5]), opts(["Z999"]));
    expect(r.impacts).toEqual([]);
    expect(r.ignored.deleted).toBe(1);
  });

  it("warns when a code the practice bills is reworded", () => {
    const diff = diffCodeSets(snapshot({ E1165: "old wording" }), snapshot({ E1165: "narrower wording" }));
    const r = assessCodeImpact(diff, usageOf(["E1165", 8]), opts(["E1165"]));
    expect(kinds(r.impacts)).toEqual(["revised-in-use"]);
    expect(r.impacts[0].severity).toBe("warning");
    expect(r.impacts[0].message).toMatch(/was "old wording", now "narrower wording"/);
  });

  it("flags a billed code that gained children as a now-unbillable header", () => {
    const diff = diffCodeSets(
      snapshot({ M5451: "Vertebrogenic low back pain" }),
      snapshot({ M5451: "Vertebrogenic low back pain", M54510: "…acute", M54511: "…chronic" }),
    );
    const r = assessCodeImpact(diff, usageOf(["M5451", 120]), opts(["M5451"]));
    expect(kinds(r.impacts)).toEqual(["now-nonbillable"]);
    expect(r.impacts[0].severity).toBe("error");
    expect(r.impacts[0].message).toMatch(/non-billable header/);
    expect(r.impacts[0].message).toMatch(/M54510, M54511/);
  });

  it("does not apply the header rule to flat code sets", () => {
    const diff = diffCodeSets(snapshot({ J1885: "Ketorolac" }), snapshot({ J1885: "Ketorolac", J18851: "variant" }));
    const flat = assessCodeImpact(diff, usageOf(["J1885", 30]), { ...opts(["J1885"]), hierarchical: false });
    expect(flat.impacts).toEqual([]);
  });

  it("reports a family that was already a header as an opportunity, not a break", () => {
    // E116 already had children, so new subcodes do not make it newly unbillable.
    const diff = diffCodeSets(snapshot({ E1169: "other specified" }), snapshot({ E11618: "new subcode" }));
    const r = assessCodeImpact(diff, usageOf(["E116", 12]), opts(["E1165", "E1169"]));
    expect(kinds(r.impacts)).toEqual(["more-specific-available"]);
    expect(r.impacts[0].severity).toBe("info");
  });

  it("does not call a long-standing header newly broken when it keeps its old children", () => {
    // Regression: judging "was this already a header?" from the diff instead of
    // the previous edition reported E116 — never billable, unchanged here — as a
    // breaking change, sending a coder after a problem that does not exist.
    const previous = { E1165: "with hyperglycemia", E1169: "with other complication" };
    const diff = diffCodeSets(snapshot(previous), snapshot({ ...previous, E11618: "with a new complication" }));
    const r = assessCodeImpact(diff, usageOf(["E116", 50]), opts(Object.keys(previous)));
    expect(kinds(r.impacts)).toEqual(["more-specific-available"]);
    expect(r.impacts[0].severity).toBe("info");
  });

  it("orders errors before warnings, then by how often the code is billed", () => {
    const diff = diffCodeSets(
      snapshot({ A100: "gone", A200: "also gone", A300: "old text" }),
      snapshot({ A300: "new text" }),
    );
    const r = assessCodeImpact(diff, usageOf(["A100", 3], ["A200", 90], ["A300", 500]), opts(["A100", "A200", "A300"]));
    expect(r.impacts.map((i) => i.code)).toEqual(["A200", "A100", "A300"]);
    expect(r.impacts.map((i) => i.severity)).toEqual(["error", "error", "warning"]);
  });

  it("counts what it chose not to list", () => {
    const diff = diffCodeSets(snapshot({ X1: "a", X2: "b", X3: "c" }), snapshot({ X1: "a", N1: "new", N2: "new2" }));
    const r = assessCodeImpact(diff, usageOf(["Q99", 1]), opts(["X1", "X2", "X3"]));
    expect(r.ignored.deleted).toBe(2);
    expect(r.ignored.added).toBe(2);
    expect(r.billedCodesChecked).toBe(1);
  });

  it("does not count additions it already reported as unreported", () => {
    // M54510/M54511 are surfaced as M5451's new children, so the footer must not
    // also describe them as additions outside the families the practice bills.
    const diff = diffCodeSets(
      snapshot({ M5451: "Vertebrogenic low back pain" }),
      snapshot({ M5451: "Vertebrogenic low back pain", M54510: "acute", M54511: "chronic", Q9999: "unrelated" }),
    );
    const r = assessCodeImpact(diff, usageOf(["M5451", 7]), opts(["M5451"]));
    expect(diff.added).toHaveLength(3);
    expect(r.ignored.added).toBe(1);
  });

  it("renders a report that states the date-of-service rule", () => {
    const diff = diffCodeSets(snapshot({ E1165: "x" }), snapshot({}));
    const out = renderImpactReport(assessCodeImpact(diff, usageOf(["E1165", 4]), opts(["E1165"])), diff);
    expect(out).toMatch(/BREAKING/);
    expect(out).toMatch(/DATE OF SERVICE, not the submission date/);
    expect(out).toMatch(/has to be split/);
  });

  it("says plainly when nothing the practice bills is affected", () => {
    const diff = diffCodeSets(snapshot({ Z1: "a" }), snapshot({ Z2: "b" }));
    const out = renderImpactReport(assessCodeImpact(diff, usageOf(["E1165", 4]), opts(["E1165"])), diff);
    expect(out).toMatch(/No codes you bill are affected/);
  });
});

// ── Policy watch ─────────────────────────────────────────────────────────────

const NATIONAL = {
  data: [
    {
      document_id: 323,
      document_version: 2,
      document_display_id: "CAG-00444R2",
      document_status: "Open",
      last_updated: "07/30/2026",
      last_updated_sort: "20260730160359",
      document_type: "NCA",
      title: "Autologous Stem Cell Transplantation for Multiple Myeloma",
      whats_new_description: "Posted new tracking sheet and proposed decision memo",
      url: "/data/nca?ncaid=323",
    },
  ],
};

const LOCAL = {
  data: [
    {
      document_id: 56690,
      document_version: 18,
      document_display_id: "A56690",
      document_type: "Article",
      note: "Retired",
      title: "Billing and Coding: MR Guided Focused Ultrasound for Essential Tremor",
      contractor_name_type: "Palmetto GBA\r\n(MAC - Part A, MAC - Part B)",
      updated_on: "07/31/2026",
      updated_on_sort: "20260731230007",
      effective_date: "01/01/2025",
      retirement_date: "07/31/2026",
      url: "https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleid=56690&ver=18",
    },
    {
      document_id: 39000,
      document_version: 3,
      document_display_id: "L39000",
      document_type: "LCD",
      note: "Revised",
      title: "Wound Care",
      contractor_name_type: "Novitas Solutions",
      updated_on: "06/01/2026",
      updated_on_sort: "20260601090000",
      effective_date: "07/15/2026",
      retirement_date: "",
      url: "/view/lcd.aspx?lcdid=39000",
    },
  ],
};

describe("CMS coverage what's-new parsing", () => {
  const national = parseWhatsNewNational(NATIONAL);
  const local = parseWhatsNewLocal(LOCAL);

  it("converts CMS date formats to YYYYMMDD", () => {
    expect(toYmd("07/30/2026")).toBe("20260730");
    expect(toYmd("07/30/2026", "20260730160359")).toBe("20260730");
    expect(toYmd("")).toBe("");
    expect(toYmd(null)).toBe("");
  });

  it("prefers the sort key over the display date", () => {
    expect(toYmd("bogus", "20251115120000")).toBe("20251115");
  });

  it("reads the national feed's own field names", () => {
    expect(national).toHaveLength(1);
    expect(national[0].scope).toBe("national");
    expect(national[0].displayId).toBe("CAG-00444R2");
    expect(national[0].documentType).toBe("NCA");
    expect(national[0].updatedOn).toBe("20260730");
    expect(national[0].changeNote).toMatch(/proposed decision memo/);
  });

  it("absolutizes the relative URLs the national feed returns", () => {
    expect(national[0].url).toBe("https://www.cms.gov/medicare-coverage-database/data/nca?ncaid=323");
  });

  it("leaves already-absolute URLs alone", () => {
    expect(local[0].url).toMatch(/^https:\/\/www\.cms\.gov\/medicare-coverage-database\/view\/article\.aspx/);
  });

  it("flattens the CRLF embedded in MAC contractor names", () => {
    expect(local[0].contractor).toBe("Palmetto GBA (MAC - Part A, MAC - Part B)");
  });

  it("reads local retirement and effective dates", () => {
    expect(local[0].retirementDate).toBe("20260731");
    expect(local[1].effectiveDate).toBe("20260715");
    expect(local[1].retirementDate).toBe("");
  });

  it("degrades to an empty list rather than throwing on an unexpected payload", () => {
    expect(parseWhatsNewLocal({})).toEqual([]);
    expect(parseWhatsNewNational(null)).toEqual([]);
    expect(parseWhatsNewLocal({ data: "nope" })).toEqual([]);
  });
});

describe("policy change filtering", () => {
  const items = parseWhatsNewLocal(LOCAL);

  it("keeps only changes at or after the since date", () => {
    expect(filterPolicyChanges(items, { since: "20260701" }).map((i) => i.displayId)).toEqual(["A56690"]);
    expect(filterPolicyChanges(items, { since: "20260101" })).toHaveLength(2);
  });

  it("filters by contractor substring, case-insensitively", () => {
    expect(filterPolicyChanges(items, { contractor: "novitas" }).map((i) => i.displayId)).toEqual(["L39000"]);
  });

  it("filters by document type", () => {
    expect(filterPolicyChanges(items, { documentTypes: ["LCD"] }).map((i) => i.displayId)).toEqual(["L39000"]);
  });

  it("matches keywords against both title and change note", () => {
    expect(filterPolicyChanges(items, { keywords: ["wound"] }).map((i) => i.displayId)).toEqual(["L39000"]);
    expect(filterPolicyChanges(items, { keywords: ["retired"] }).map((i) => i.displayId)).toEqual(["A56690"]);
  });

  it("returns nothing when no keyword matches", () => {
    expect(filterPolicyChanges(items, { keywords: ["cardiology"] })).toEqual([]);
  });

  it("applies filters together", () => {
    expect(filterPolicyChanges(items, { contractor: "Palmetto", documentTypes: ["LCD"] })).toEqual([]);
  });
});

describe("policy change impact", () => {
  const change = (over: Partial<PolicyChange> = {}): PolicyChange => ({
    scope: "local",
    documentId: "1",
    version: "1",
    displayId: "L1",
    documentType: "LCD",
    title: "Some policy",
    changeNote: "",
    contractor: "MAC",
    updatedOn: "20260601",
    effectiveDate: "",
    retirementDate: "",
    url: "",
    ...over,
  });

  it("treats a retirement as an action item, since nothing announces it on the claim", () => {
    const c = classifyPolicyChange(change({ retirementDate: "20260731", changeNote: "Retired" }));
    expect(c.severity).toBe("warning");
    expect(c.reason).toMatch(/no longer applies/);
    expect(c.reason).toMatch(/20260731/);
  });

  it("detects a retirement from the note even without a retirement date", () => {
    expect(classifyPolicyChange(change({ changeNote: "Article retired by contractor" })).severity).toBe("warning");
  });

  it("flags a new policy as newly-applicable criteria", () => {
    expect(classifyPolicyChange(change({ changeNote: "New LCD posted" })).reason).toMatch(/did not previously exist/);
  });

  it("tells the reader to re-check code lists on a revision", () => {
    expect(classifyPolicyChange(change({ changeNote: "Revised to add codes" })).reason).toMatch(/code lists/);
  });

  it("falls back to informational for an unrecognized note", () => {
    expect(classifyPolicyChange(change({ changeNote: "Posted" })).severity).toBe("info");
  });

  it("renders warnings above informational changes and states the feed's limit", () => {
    const out = renderPolicyChanges(parseWhatsNewLocal(LOCAL), { since: "20260101", total: 2 });
    expect(out).toMatch(/ACT — 2 change\(s\)/);
    expect(out).toMatch(/Palmetto GBA \(MAC - Part A, MAC - Part B\)/);
    expect(out).toMatch(/not code lists/);
    expect(out.indexOf("A56690")).toBeLessThan(out.indexOf("L39000")); // feed order preserved
  });

  it("says so plainly when nothing matched", () => {
    expect(renderPolicyChanges([], { since: "20260101", total: 40 })).toMatch(/No coverage policy changes matched/);
  });
});
