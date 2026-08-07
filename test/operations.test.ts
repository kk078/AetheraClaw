import { describe, expect, it } from "vitest";
import {
  CAQH_ATTESTATION_DAYS,
  DMEPOS_REVALIDATION_YEARS,
  MEDICARE_REVALIDATION_YEARS,
  NON_BILLABLE_STATUSES,
  assessAll,
  assessCredential,
  billableOn,
  caqhExpiry,
  impliedRevalidationDue,
  renderAlerts,
  revalidationYears,
  type CredentialRecord,
} from "../src/tools/healthcare/operations/credentialing.js";
import {
  GFE_DISPUTE_THRESHOLD,
  addBusinessDays,
  businessDaysBetween,
  checkGfeVariance,
  gfeDeadlineForRequest,
  gfeDeadlineForScheduling,
  renderGfe,
  totalGfe,
} from "../src/tools/healthcare/operations/gfe.js";
import {
  POSTING_COLUMNS,
  csvEscape,
  summarize,
  toCsv,
  toPostingRows,
} from "../src/tools/healthcare/operations/era-export.js";
import {
  MAX_POINTERS_PER_LINE,
  buildClaimFromSuperbill,
  type SuperbillInput,
} from "../src/tools/healthcare/operations/superbill.js";
import type { Era, EraServiceLine } from "../src/tools/healthcare/x12/835.js";

const rules = (findings: Array<{ rule: string }>) => findings.map((f) => f.rule);

// ── Credentialing ────────────────────────────────────────────────────────────

const cred = (over: Partial<CredentialRecord> = {}): CredentialRecord => ({
  id: "cred_1",
  providerNpi: "1234567893",
  providerName: "Dr Smith",
  payer: "Medicare",
  kind: "medicare",
  status: "approved",
  effectiveDate: "20220301",
  revalidationDue: "20270301",
  caqhAttestedOn: "",
  notes: "",
  ...over,
});

describe("revalidation cycles", () => {
  it("gives providers five years and DMEPOS suppliers three", () => {
    expect(revalidationYears("medicare")).toBe(MEDICARE_REVALIDATION_YEARS);
    expect(revalidationYears("commercial")).toBe(5);
    expect(revalidationYears("medicare_dmepos")).toBe(DMEPOS_REVALIDATION_YEARS);
  });

  it("computes the implied due date in calendar years", () => {
    expect(impliedRevalidationDue("20220301", "medicare")).toBe("20270301");
    expect(impliedRevalidationDue("20220301", "medicare_dmepos")).toBe("20250301");
  });

  it("expires a CAQH attestation 120 days out", () => {
    expect(CAQH_ATTESTATION_DAYS).toBe(120);
    expect(caqhExpiry("20260101")).toBe("20260501");
  });
});

describe("credential assessment", () => {
  it("says nothing about a healthy enrollment", () => {
    expect(assessCredential(cred(), { asOf: "20260101" })).toEqual([]);
  });

  it("blocks billing while an application is still in review", () => {
    const a = assessCredential(cred({ status: "in_review" }), { asOf: "20260101" });
    expect(rules(a)).toContain("enrollment-incomplete");
    expect(a[0].severity).toBe("error");
    expect(a[0].message).toMatch(/cannot be appealed away/);
  });

  it("treats a deactivation as a stop-billing event", () => {
    const a = assessCredential(cred({ status: "deactivated" }), { asOf: "20260101" });
    expect(rules(a)).toContain("enrollment-stopped");
    expect(a[0].message).toMatch(/CARC B7/);
    expect(a[0].message).toMatch(/stop billing/);
  });

  it("raises an error once revalidation is past due", () => {
    const a = assessCredential(cred(), { asOf: "20270401" });
    expect(rules(a)).toContain("revalidation-overdue");
    expect(a[0].daysRemaining).toBeLessThan(0);
    expect(a[0].message).toMatch(/hold on reimbursement/);
  });

  it("warns inside sixty days and merely notes it further out", () => {
    const soon = assessCredential(cred(), { asOf: "20270201" });
    expect(soon[0].severity).toBe("warning");
    const later = assessCredential(cred(), { asOf: "20261101" });
    expect(later[0].severity).toBe("info");
  });

  it("stays quiet beyond the horizon", () => {
    expect(assessCredential(cred(), { asOf: "20260101", horizonDays: 30 })).toEqual([]);
  });

  it("flags an expired CAQH attestation as blocking", () => {
    const a = assessCredential(cred({ caqhAttestedOn: "20250101" }), { asOf: "20260101" });
    expect(rules(a)).toContain("caqh-expired");
    expect(a.find((x) => x.rule === "caqh-expired")?.severity).toBe("error");
    expect(a.find((x) => x.rule === "caqh-expired")?.message).toMatch(/found only by looking/);
  });

  it("warns before the CAQH attestation lapses", () => {
    // Attested 20260101, expires 20260501; ten days out.
    const a = assessCredential(cred({ caqhAttestedOn: "20260101" }), { asOf: "20260421" });
    expect(rules(a)).toContain("caqh-due");
  });

  it("ignores CAQH entirely when no attestation is recorded", () => {
    expect(rules(assessCredential(cred({ caqhAttestedOn: "" }), { asOf: "20260101" }))).not.toContain("caqh-expired");
  });

  it("can raise several problems for one enrollment", () => {
    const a = assessCredential(cred({ status: "deactivated", caqhAttestedOn: "20250101" }), { asOf: "20270401" });
    expect(rules(a).sort()).toEqual(["caqh-expired", "enrollment-stopped", "revalidation-overdue"]);
  });

  it("puts blocking problems ahead of future ones across providers", () => {
    const alerts = assessAll(
      [cred({ id: "a", providerName: "Future" }), cred({ id: "b", providerName: "Broken", status: "terminated" })],
      { asOf: "20270201" },
    );
    expect(alerts[0].severity).toBe("error");
  });

  it("separates blocking from upcoming in the rendered report", () => {
    const out = renderAlerts(
      assessAll([cred({ status: "deactivated" }), cred({ id: "c2", payer: "UHC" })], { asOf: "20270201" }),
      "20270201",
    );
    expect(out).toMatch(/BLOCKING/);
    expect(out).toMatch(/SOON/);
    expect(out).toMatch(/published by the payer always override/);
  });

  it("says so plainly when nothing needs attention", () => {
    expect(renderAlerts([], "20260101")).toMatch(/No credentialing problems found/);
  });
});

describe("billable check", () => {
  it("permits billing for an approved enrollment on a covered date", () => {
    expect(billableOn(cred(), "20260515").billable).toBe(true);
  });

  it("refuses a date before the enrollment took effect", () => {
    const v = billableOn(cred(), "20210101");
    expect(v.billable).toBe(false);
    expect(v.reason).toMatch(/precedes the 20220301 enrollment effective date/);
  });

  it("refuses every non-billable status", () => {
    for (const status of NON_BILLABLE_STATUSES) {
      expect(billableOn(cred({ status }), "20260515").billable).toBe(false);
    }
  });
});

// ── Good Faith Estimate ──────────────────────────────────────────────────────

describe("business-day arithmetic", () => {
  it("skips weekends", () => {
    // 2026-08-07 is a Friday.
    expect(addBusinessDays("20260807", 1)).toBe("20260810");
    expect(addBusinessDays("20260807", 3)).toBe("20260812");
  });

  it("skips supplied holidays as well", () => {
    expect(addBusinessDays("20260807", 1, ["20260810"])).toBe("20260811");
  });

  it("counts business days between two dates", () => {
    expect(businessDaysBetween("20260807", "20260810")).toBe(1);
    expect(businessDaysBetween("20260803", "20260807")).toBe(4);
  });

  it("returns zero when the range is empty or inverted", () => {
    expect(businessDaysBetween("20260807", "20260807")).toBe(0);
    expect(businessDaysBetween("20260810", "20260807")).toBe(0);
  });
});

describe("GFE timing", () => {
  it("allows three business days when scheduled ten or more ahead", () => {
    // Monday 2026-08-03, service four weeks out.
    const t = gfeDeadlineForScheduling("20260803", "20260901");
    expect(t.required).toBe(true);
    expect(t.leadBusinessDays).toBeGreaterThanOrEqual(10);
    expect(t.deadline).toBe("20260806");
    expect(t.rule).toMatch(/within 3 business days/);
  });

  it("allows one business day when scheduled three to nine ahead", () => {
    const t = gfeDeadlineForScheduling("20260803", "20260810");
    expect(t.required).toBe(true);
    expect(t.leadBusinessDays).toBe(5);
    expect(t.deadline).toBe("20260804");
    expect(t.rule).toMatch(/within 1 business day/);
  });

  it("triggers nothing when scheduled under three business days out", () => {
    const t = gfeDeadlineForScheduling("20260803", "20260805");
    expect(t.required).toBe(false);
    expect(t.deadline).toBe("");
    expect(t.rule).toMatch(/does not trigger an estimate/);
    expect(t.rule).toMatch(/if the patient asks/i);
  });

  it("uses the boundary correctly at exactly three and exactly ten", () => {
    expect(gfeDeadlineForScheduling("20260803", "20260806").leadBusinessDays).toBe(3);
    expect(gfeDeadlineForScheduling("20260803", "20260806").rule).toMatch(/within 1 business day/);
    expect(gfeDeadlineForScheduling("20260803", "20260817").leadBusinessDays).toBe(10);
    expect(gfeDeadlineForScheduling("20260803", "20260817").rule).toMatch(/within 3 business days/);
  });

  it("starts a three-business-day clock on a patient request", () => {
    const t = gfeDeadlineForRequest("20260803");
    expect(t.required).toBe(true);
    expect(t.deadline).toBe("20260806");
    expect(t.rule).toMatch(/Requested by the patient/);
  });
});

describe("GFE document", () => {
  const gfe = {
    patientName: "Test Patient",
    patientDob: "19800101",
    primaryService: "Knee arthroscopy",
    serviceDate: "20260901",
    diagnoses: ["M17.11"],
    lines: [
      { code: "29881", description: "Arthroscopy, knee, with meniscectomy", quantity: 1, unitCharge: 3200 },
      { code: "01382", description: "Anesthesia for knee arthroscopy", quantity: 1, unitCharge: 750.5 },
    ],
    providerName: "Test Ortho Group",
    providerNpi: "1234567893",
    providerTin: "12-3456789",
    location: "1 Main St, Austin TX",
    excludedProviders: ["Radiology Associates"],
  };

  it("totals line charges by quantity", () => {
    const totals = totalGfe([{ code: "A", description: "d", quantity: 3, unitCharge: 10.5 }]);
    expect(totals.lines[0].total).toBe(31.5);
    expect(totals.total).toBe(31.5);
  });

  it("renders the itemized table and the total", () => {
    const doc = renderGfe(gfe, totalGfe(gfe.lines), null);
    expect(doc).toMatch(/29881/);
    expect(doc).toMatch(/\$3950\.50/);
  });

  it("carries the dispute-threshold disclosure", () => {
    const doc = renderGfe(gfe, totalGfe(gfe.lines), null);
    expect(doc).toMatch(/\$400 or more above/);
    expect(doc).toMatch(/120 calendar days/);
  });

  it("names providers whose charges are excluded", () => {
    expect(renderGfe(gfe, totalGfe(gfe.lines), null)).toMatch(/Radiology Associates/);
  });

  it("includes the delivery deadline when the timing is known", () => {
    const timing = gfeDeadlineForScheduling("20260803", "20260901");
    expect(renderGfe(gfe, totalGfe(gfe.lines), timing)).toMatch(/Estimate due 20260806/);
  });

  it("says it is a drafting aid rather than legal advice", () => {
    expect(renderGfe(gfe, totalGfe(gfe.lines), null)).toMatch(/not legal advice/);
  });
});

describe("GFE variance", () => {
  it("opens dispute resolution at exactly $400 over", () => {
    const v = checkGfeVariance(1000, 1400);
    expect(v.difference).toBe(GFE_DISPUTE_THRESHOLD);
    expect(v.disputable).toBe(true);
    expect(v.message).toMatch(/patient-provider dispute resolution/);
  });

  it("stays under the threshold a dollar below", () => {
    const v = checkGfeVariance(1000, 1399);
    expect(v.disputable).toBe(false);
    expect(v.message).toMatch(/under the \$400 dispute threshold/);
  });

  it("reports a bill at or under the estimate plainly", () => {
    expect(checkGfeVariance(1000, 900).message).toMatch(/at or under the estimate/);
  });
});

// ── Posting export ───────────────────────────────────────────────────────────

const line = (over: Partial<EraServiceLine> = {}): EraServiceLine => ({
  procedure: "HC:99214:25",
  charged: 200,
  paid: 116.4,
  units: 1,
  adjustments: [
    { group: "CO", carc: "45", amount: 60 },
    { group: "PR", carc: "2", amount: 22 },
    { group: "CO", carc: "253", amount: 1.6 },
  ],
  rarcs: ["N620"],
  ...over,
});

const era = (lines: EraServiceLine[], statusCode = "1"): { era: Era } => ({
  era: {
    payer: "ACME HEALTH, PLAN",
    payee: "CLINIC",
    checkOrEftAmount: 116.4,
    claims: [
      {
        claimId: "C1",
        statusCode,
        charged: 200,
        paid: 116.4,
        patientResponsibility: 22,
        payerControlNumber: "PCN9",
        lines,
      },
    ],
  } as Era,
});

describe("posting export", () => {
  it("splits the money into its component buckets", () => {
    const [row] = toPostingRows([era([line()])]);
    expect(row.charged).toBe(200);
    expect(row.allowed).toBe(140);
    expect(row.paid).toBe(116.4);
    expect(row.patientResponsibility).toBe(22);
    expect(row.contractual).toBe(60);
    expect(row.sequestration).toBe(1.6);
  });

  it("separates the procedure from its modifiers", () => {
    const [row] = toPostingRows([era([line()])]);
    expect(row.procedure).toBe("99214");
    expect(row.modifiers).toBe("25");
  });

  it("carries the reason codes and the claim status", () => {
    const [row] = toPostingRows([era([line()])]);
    expect(row.carcs).toBe("CO-45 PR-2 CO-253");
    expect(row.rarcs).toBe("N620");
    expect(row.claimStatus).toBe("paid-primary");
  });

  it("names a denied claim rather than printing its code", () => {
    expect(toPostingRows([era([line()], "4")])[0].claimStatus).toBe("denied");
  });

  it("exports claim-level adjustments rather than dropping the dollars", () => {
    const rows = toPostingRows([
      era([line(), line({ procedure: "(claim level)", charged: 0, paid: 0, adjustments: [{ group: "CO", carc: "253", amount: 5 }], rarcs: [] })]),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1].procedure).toBe("(claim level)");
    expect(rows[1].modifiers).toBe("");
  });

  it("marks a line that does not balance", () => {
    const rows = toPostingRows([era([line({ charged: 500 })])]);
    expect(rows[0].balanced).toBe("NO");
    expect(summarize(rows).unbalanced).toBe(1);
  });

  it("quotes fields containing commas", () => {
    expect(csvEscape("ACME HEALTH, PLAN")).toBe('"ACME HEALTH, PLAN"');
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape(12.5)).toBe("12.5");
  });

  it("writes a header row and one row per line", () => {
    const csv = toCsv(toPostingRows([era([line()])]));
    const rows = csv.split("\n");
    expect(rows[0]).toBe(POSTING_COLUMNS.join(","));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatch(/^"ACME HEALTH, PLAN",C1,PCN9,99214,25/);
  });

  it("totals the export", () => {
    const s = summarize(toPostingRows([era([line()]), era([line()])]));
    expect(s.rows).toBe(2);
    expect(s.charged).toBe(400);
    expect(s.paid).toBe(232.8);
  });
});

// ── Charge capture ───────────────────────────────────────────────────────────

const superbill = (over: Partial<SuperbillInput> = {}): SuperbillInput => ({
  claimId: "SB-1",
  payerName: "ACME",
  payerId: "P1",
  billingProviderNpi: "1234567893",
  billingProviderName: "CLINIC",
  subscriberId: "M1",
  patientLast: "DOE",
  patientFirst: "JANE",
  patientDob: "19700101",
  patientSex: "F",
  lines: [
    { code: "99214", modifiers: ["25"], charge: 200, serviceDate: "20260515", diagnoses: ["E11.65"] },
    { code: "20610", charge: 120, serviceDate: "20260515", diagnoses: ["M17.11"] },
  ],
  ...over,
});

describe("superbill charge capture", () => {
  it("derives diagnosis pointers from the codes each line names", () => {
    const r = buildClaimFromSuperbill(superbill());
    expect(r.claim).not.toBeNull();
    expect(r.claim!.diagnoses).toEqual(["E11.65", "M17.11"]);
    expect(r.claim!.service_lines[0].dx_pointers).toEqual([1]);
    expect(r.claim!.service_lines[1].dx_pointers).toEqual([2]);
  });

  it("lets the coder state the reported order, primary first", () => {
    const r = buildClaimFromSuperbill(superbill({ encounterDiagnoses: ["M17.11", "E11.65"] }));
    expect(r.diagnosisOrder).toEqual(["M17.11", "E11.65"]);
    // Line 1 is the E/M for the diabetes, which is now pointer 2.
    expect(r.claim!.service_lines[0].dx_pointers).toEqual([2]);
    expect(r.claim!.service_lines[1].dx_pointers).toEqual([1]);
  });

  it("appends a diagnosis a line names but the encounter list missed", () => {
    const r = buildClaimFromSuperbill(superbill({ encounterDiagnoses: ["M17.11"] }));
    expect(r.diagnosisOrder).toEqual(["M17.11", "E11.65"]);
  });

  it("flags an encounter diagnosis that supports no line", () => {
    const r = buildClaimFromSuperbill(superbill({ encounterDiagnoses: ["Z00.00"] }));
    expect(rules(r.findings)).toContain("superbill-unused-diagnosis");
    expect(r.claim).not.toBeNull();
    expect(r.claim!.diagnoses).toContain("Z00.00");
  });

  it("orders diagnoses by first appearance, so the first line's is primary", () => {
    const r = buildClaimFromSuperbill(
      superbill({
        lines: [
          { code: "20610", charge: 120, serviceDate: "20260515", diagnoses: ["M17.11"] },
          { code: "99214", charge: 200, serviceDate: "20260515", diagnoses: ["E11.65"] },
        ],
      }),
    );
    expect(r.diagnosisOrder).toEqual(["M17.11", "E11.65"]);
  });

  it("reuses one pointer when two lines share a diagnosis", () => {
    const r = buildClaimFromSuperbill(
      superbill({
        lines: [
          { code: "99214", charge: 200, serviceDate: "20260515", diagnoses: ["E11.65"] },
          { code: "36415", charge: 25, serviceDate: "20260515", diagnoses: ["E11.65"] },
        ],
      }),
    );
    expect(r.claim!.diagnoses).toEqual(["E11.65"]);
    expect(r.claim!.service_lines[1].dx_pointers).toEqual([1]);
  });

  it("matches a dotted diagnosis against an undotted one", () => {
    const r = buildClaimFromSuperbill(
      superbill({
        lines: [
          { code: "99214", charge: 200, serviceDate: "20260515", diagnoses: ["E11.65"] },
          { code: "36415", charge: 25, serviceDate: "20260515", diagnoses: ["E1165"] },
        ],
      }),
    );
    expect(r.diagnosisOrder).toHaveLength(1);
    expect(r.claim!.service_lines[1].dx_pointers).toEqual([1]);
  });

  it("refuses a line with no diagnosis behind it", () => {
    const r = buildClaimFromSuperbill(
      superbill({ lines: [{ code: "99214", charge: 200, serviceDate: "20260515", diagnoses: [] }] }),
    );
    expect(rules(r.findings)).toContain("superbill-line-unlinked");
    expect(r.claim).toBeNull();
  });

  it("refuses a zero charge", () => {
    const r = buildClaimFromSuperbill(
      superbill({ lines: [{ code: "99214", charge: 0, serviceDate: "20260515", diagnoses: ["E11.65"] }] }),
    );
    expect(rules(r.findings)).toContain("superbill-zero-charge");
    expect(r.claim).toBeNull();
  });

  it("refuses more than twelve distinct diagnoses", () => {
    const many = Array.from({ length: 13 }, (_, i) => `Z${String(i).padStart(3, "0")}`);
    const r = buildClaimFromSuperbill(
      superbill({ lines: [{ code: "99214", charge: 200, serviceDate: "20260515", diagnoses: many }] }),
    );
    expect(rules(r.findings)).toContain("superbill-too-many-diagnoses");
    expect(r.claim).toBeNull();
  });

  it("truncates to four pointers per line and says which were kept", () => {
    const r = buildClaimFromSuperbill(
      superbill({
        lines: [
          { code: "99214", charge: 200, serviceDate: "20260515", diagnoses: ["A01", "B02", "C03", "D04", "E05"] },
        ],
      }),
    );
    expect(rules(r.findings)).toContain("superbill-too-many-pointers");
    expect(r.claim!.service_lines[0].dx_pointers).toHaveLength(MAX_POINTERS_PER_LINE);
    expect(r.claim!.service_lines[0].dx_pointers).toEqual([1, 2, 3, 4]);
  });

  it("defaults place of service and units", () => {
    const r = buildClaimFromSuperbill(superbill());
    expect(r.claim!.service_lines[0].place_of_service).toBe("11");
    expect(r.claim!.service_lines[0].units).toBe(1);
  });

  it("confirms what it built", () => {
    const r = buildClaimFromSuperbill(superbill());
    expect(rules(r.findings)).toContain("superbill-built");
    expect(r.findings.find((f) => f.rule === "superbill-built")!.message).toMatch(/run claim_scrub/);
  });
});
