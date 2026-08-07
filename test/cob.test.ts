import { describe, expect, it } from "vitest";
import { parse277ca, summarizeAck, STATUS_CATEGORIES } from "../src/tools/healthcare/x12/277ca.js";
import { determineCobOrder, earlierInCalendarYear, MSP_TYPE_CODES } from "../src/tools/healthcare/cob.js";
import { buildSecondary837, findPrimaryClaim, validateCobBalance } from "../src/tools/healthcare/x12/837-cob.js";
import { baseProcedureCode, parseX12 } from "../src/tools/healthcare/x12/segments.js";
import type { ClaimInput } from "../src/tools/healthcare/x12/837.js";

const rules = (findings: Array<{ rule: string }>) => findings.map((f) => f.rule);

// ── X12 helpers ──────────────────────────────────────────────────────────────

describe("procedure composite parsing", () => {
  it("strips the qualifier and modifiers", () => {
    expect(baseProcedureCode("HC:99214:25")).toBe("99214");
    expect(baseProcedureCode("99214:25")).toBe("99214");
    expect(baseProcedureCode("99213")).toBe("99213");
  });
  it("survives an empty composite", () => {
    expect(baseProcedureCode("")).toBe("");
  });
});

// ── 277CA ────────────────────────────────────────────────────────────────────

const ACK = [
  "ISA*00*          *00*          *ZZ*PAYERID        *ZZ*SUBMITTERID    *250601*1200*^*00501*000000001*0*T*:~",
  "GS*HN*PAYERID*SUBMITTERID*20250601*1200*1*X*005010X214~",
  "ST*277*0001~",
  "BHT*0085*08*277CA*20250601*1200*TH~",
  "HL*1**20*1~",
  "NM1*PR*2*ACME HEALTH PLAN*****46*PAYERID~",
  "HL*2*1*21*1~",
  "NM1*41*2*BILLING SERVICE*****46*SUBMITTERID~",
  "TRN*1*BATCH-001~",
  "STC*A1:19:PR*20250601*WQ*500~",
  "QTY*90*1~",
  "QTY*AA*2~",
  "HL*3*2*19*1~",
  "NM1*85*2*TEST CLINIC*****XX*1234567893~",
  "HL*4*3*22*0~",
  "NM1*IL*1*DOE*JANE****MI*TESTMEM001~",
  "TRN*2*CLM-ACCEPT~",
  "STC*A2:20*20250601*WQ*150~",
  "REF*1K*PAYERCLAIM99~",
  "DTP*472*D8*20250515~",
  "HL*5*3*22*0~",
  "NM1*IL*1*ROE*JOHN****MI*TESTMEM002~",
  "TRN*2*CLM-REJECT~",
  // STC12 (free-form message) sits eight separators past STC04.
  "STC*A3:21:85*20250601*U*200********Billing provider NPI not on file~",
  "DTP*472*D8*20250516~",
  "HL*6*3*22*0~",
  "NM1*IL*1*POE*SAM****MI*TESTMEM003~",
  "TRN*2*CLM-LINE-REJECT~",
  "STC*A7:562:82*20250601*U*90~",
  "SVC*HC:99213*90~",
  "STC*A7:255*20250601*U*90~",
  "SE*29*0001~",
  "GE*1*1~",
  "IEA*1*000000001~",
].join("\n");

describe("277CA acknowledgment parsing", () => {
  const ack = parse277ca(ACK);

  it("identifies the payer, submitter, and provider", () => {
    expect(ack.payer).toBe("ACME HEALTH PLAN");
    expect(ack.submitter).toBe("BILLING SERVICE");
    expect(ack.provider).toBe("TEST CLINIC");
  });

  it("reads batch accepted and rejected counts", () => {
    expect(ack.acceptedCount).toBe(1);
    expect(ack.rejectedCount).toBe(2);
  });

  it("separates accepted from rejected claims", () => {
    expect(ack.claims).toHaveLength(3);
    expect(ack.claims.filter((c) => c.accepted).map((c) => c.claimId)).toEqual(["CLM-ACCEPT"]);
    expect(ack.claims.filter((c) => !c.accepted).map((c) => c.claimId)).toEqual(["CLM-REJECT", "CLM-LINE-REJECT"]);
  });

  it("captures the payer claim number on an accepted claim", () => {
    expect(ack.claims[0].payerClaimNumber).toBe("PAYERCLAIM99");
    expect(ack.claims[0].charged).toBe(150);
    expect(ack.claims[0].serviceDate).toBe("20250515");
  });

  it("decodes the category, status, and responsible entity on a rejection", () => {
    const rejected = ack.claims[1];
    const status = rejected.statuses[0];
    expect(status.category).toBe("A3");
    expect(status.accepted).toBe(false);
    expect(status.statusCode).toBe("21");
    expect(status.statusDesc).toMatch(/Missing or invalid/);
    expect(status.entity).toBe("85");
    expect(status.entityDesc).toBe("Billing provider");
    expect(status.fix).toBeTruthy();
  });

  it("keeps the payer's free-form message", () => {
    expect(ack.claims[1].freeText).toBe("Billing provider NPI not on file");
  });

  it("attaches line-level statuses to their service line", () => {
    const claim = ack.claims[2];
    expect(claim.lines).toHaveLength(1);
    expect(claim.lines[0].procedure).toBe("99213");
    expect(claim.lines[0].statuses[0].statusCode).toBe("255");
    expect(claim.accepted).toBe(false);
  });

  it("records batch-level status separately from claims", () => {
    expect(ack.batchStatuses).toHaveLength(1);
    expect(ack.batchStatuses[0].category).toBe("A1");
  });

  it("treats every pending and finalized category as accepted, rejections as not", () => {
    for (const code of ["A1", "A2", "P1", "F1", "F2"]) expect(STATUS_CATEGORIES[code].accepted).toBe(true);
    for (const code of ["A3", "A6", "A7", "A8"]) expect(STATUS_CATEGORIES[code].accepted).toBe(false);
  });

  it("says plainly that rejections cannot be appealed", () => {
    const summary = summarizeAck(ack);
    expect(summary).toMatch(/never adjudicated/);
    expect(summary).toMatch(/timely-filing clock is still running/);
    expect(summary).toMatch(/Correct and resubmit/);
  });

  it("degrades gracefully on an unknown status code", () => {
    const unknown = parse277ca(ACK.replace("A3:21:85", "A3:99999:85"));
    expect(unknown.claims[1].statuses[0].statusDesc).toMatch(/not in bundled dataset/);
  });
});

// ── COB order ────────────────────────────────────────────────────────────────

describe("birthday rule comparison", () => {
  it("compares month and day only", () => {
    expect(earlierInCalendarYear("0301", "0715")).toBe("a");
    expect(earlierInCalendarYear("1120", "0402")).toBe("b");
    expect(earlierInCalendarYear("0615", "0615")).toBe("tie");
  });
});

describe("Medicare Secondary Payer determination", () => {
  it("makes the group health plan primary for working aged at a large employer", () => {
    const d = determineCobOrder({
      medicareEntitled: true,
      medicareReason: "age",
      hasGroupHealthPlan: true,
      coverageThrough: "own_current_employment",
      employerSize: 50,
    });
    expect(d.medicareIsPrimary).toBe(false);
    expect(d.mspTypeCode).toBe("12");
    expect(d.order[0].payer).toMatch(/Group health plan/);
  });

  it("makes Medicare primary for working aged at a small employer", () => {
    const d = determineCobOrder({
      medicareEntitled: true,
      medicareReason: "age",
      hasGroupHealthPlan: true,
      coverageThrough: "own_current_employment",
      employerSize: 12,
    });
    expect(d.medicareIsPrimary).toBe(true);
    expect(d.mspTypeCode).toBeUndefined();
    expect(d.order[0].payer).toBe("Medicare");
  });

  it("uses the 100-employee threshold for disability, not 20", () => {
    const big = determineCobOrder({
      medicareEntitled: true,
      medicareReason: "disability",
      hasGroupHealthPlan: true,
      coverageThrough: "family_member_current_employment",
      employerSize: 150,
    });
    expect(big.mspTypeCode).toBe("43");
    expect(big.medicareIsPrimary).toBe(false);

    const small = determineCobOrder({
      medicareEntitled: true,
      medicareReason: "disability",
      hasGroupHealthPlan: true,
      coverageThrough: "family_member_current_employment",
      employerSize: 50, // above the working-aged threshold but below disability's
    });
    expect(small.medicareIsPrimary).toBe(true);
  });

  it("asks for employer size rather than guessing when it is the deciding fact", () => {
    const d = determineCobOrder({
      medicareEntitled: true,
      medicareReason: "age",
      hasGroupHealthPlan: true,
      coverageThrough: "own_current_employment",
    });
    expect(d.warnings.join(" ")).toMatch(/Employer size not supplied/);
  });

  it("makes the GHP primary during the ESRD coordination period regardless of employer size", () => {
    const d = determineCobOrder({
      medicareEntitled: true,
      medicareReason: "esrd",
      hasGroupHealthPlan: true,
      coverageThrough: "retiree_or_cobra",
      employerSize: 5,
      esrdMonthsElapsed: 12,
    });
    expect(d.mspTypeCode).toBe("13");
    expect(d.medicareIsPrimary).toBe(false);
  });

  it("flips to Medicare once the ESRD coordination period ends", () => {
    const d = determineCobOrder({
      medicareEntitled: true,
      medicareReason: "esrd",
      hasGroupHealthPlan: true,
      esrdMonthsElapsed: 31,
    });
    expect(d.medicareIsPrimary).toBe(true);
  });

  it("makes Medicare primary over retiree and COBRA coverage", () => {
    const d = determineCobOrder({
      medicareEntitled: true,
      medicareReason: "age",
      hasGroupHealthPlan: true,
      coverageThrough: "retiree_or_cobra",
      employerSize: 5000,
    });
    expect(d.medicareIsPrimary).toBe(true);
  });

  it("puts workers' comp ahead of Medicare for related care", () => {
    const d = determineCobOrder({
      medicareEntitled: true,
      medicareReason: "age",
      injuryRelated: "workers_comp",
      claimRelatedToInjury: true,
    });
    expect(d.mspTypeCode).toBe("15");
    expect(d.order[0].payer).toMatch(/Workers/);
  });

  it("does not apply injury coverage to an unrelated claim", () => {
    const d = determineCobOrder({
      medicareEntitled: true,
      medicareReason: "age",
      injuryRelated: "auto_no_fault",
      claimRelatedToInjury: false,
    });
    expect(d.medicareIsPrimary).toBe(true);
    expect(d.notes.join(" ")).toMatch(/not related to the injury/);
  });

  it("asks whether the claim is injury-related when that is unstated", () => {
    const d = determineCobOrder({
      medicareEntitled: true,
      injuryRelated: "liability",
    });
    expect(d.warnings.join(" ")).toMatch(/related to the injury/);
  });

  it("maps every emitted MSP type code to a known SBR05 value", () => {
    for (const code of ["12", "13", "14", "15", "41", "42", "43", "47"]) {
      expect(MSP_TYPE_CODES[code]).toBeTruthy();
    }
  });
});

describe("commercial coordination", () => {
  it("applies the birthday rule to a dependent child", () => {
    const d = determineCobOrder({
      medicareEntitled: false,
      patientIsDependentChild: true,
      parentABirthdayMmdd: "0310",
      parentBBirthdayMmdd: "0901",
    });
    expect(d.order[0].payer).toMatch(/Parent A/);
    expect(d.order[0].rationale).toMatch(/Birthday rule/);
  });

  it("lets a court decree override the birthday rule", () => {
    const d = determineCobOrder({
      medicareEntitled: false,
      patientIsDependentChild: true,
      parentsSeparated: true,
      courtDecreeAssignsTo: "parent_b",
      parentABirthdayMmdd: "0101",
      parentBBirthdayMmdd: "1231",
    });
    expect(d.order[0].payer).toMatch(/Parent B/);
    expect(d.order[0].rationale).toMatch(/court decree/i);
  });

  it("falls back to the custodial parent when there is no decree", () => {
    const d = determineCobOrder({
      medicareEntitled: false,
      patientIsDependentChild: true,
      parentsSeparated: true,
      custodialParent: "parent_a",
    });
    expect(d.order[0].payer).toMatch(/custodial parent/);
  });

  it("breaks a shared-birthday tie by length of coverage", () => {
    const d = determineCobOrder({
      medicareEntitled: false,
      patientIsDependentChild: true,
      parentABirthdayMmdd: "0615",
      parentBBirthdayMmdd: "0615",
    });
    expect(d.order[0].payer).toMatch(/covered the child longer/);
  });

  it("puts a patient's own coverage ahead of dependent coverage", () => {
    const d = determineCobOrder({ medicareEntitled: false, coverageThrough: "own_current_employment" });
    expect(d.order[0].payer).toMatch(/own plan/);
  });

  it("says it cannot decide rather than guessing", () => {
    const d = determineCobOrder({ medicareEntitled: false });
    expect(d.order).toHaveLength(0);
    expect(d.warnings.join(" ")).toMatch(/Not enough information/);
  });
});

// ── Secondary claim generation ───────────────────────────────────────────────

const claim: ClaimInput = {
  claim_id: "SEC-1",
  payer_name: "PRIMARY PLAN",
  payer_id: "P1",
  billing_provider_npi: "1234567893",
  billing_provider_name: "TEST CLINIC",
  subscriber_id: "PRIMEM1",
  patient_last: "DOE",
  patient_first: "JANE",
  patient_dob: "19700101",
  patient_sex: "F",
  diagnoses: ["E11.65"],
  service_lines: [
    { cpt_hcpcs: "99214", modifiers: ["25"], charge: 150, units: 1, dx_pointers: [1], service_date: "20250601", place_of_service: "11" },
  ],
};

const balancedEra = [
  "ISA*00*          *00*          *ZZ*PAYERID        *ZZ*PROVIDERID     *250601*1200*^*00501*000000001*0*T*:~",
  "GS*HP*PAYERID*PROVIDERID*20250601*1200*1*X*005010X221A1~",
  "ST*835*0001~",
  "BPR*I*95.50*C*ACH~",
  "N1*PR*PRIMARY PLAN~",
  "N1*PE*TEST CLINIC~",
  "CLP*SEC-1*1*150.00*95.50*20.00*12*PCN1~",
  "SVC*HC:99214:25*150.00*95.50**1~",
  "CAS*CO*45*34.50~",
  "CAS*PR*2*20.00~",
  "SE*10*0001~",
  "GE*1*1~",
  "IEA*1*000000001~",
].join("\n");

describe("COB balance validation", () => {
  it("accepts an adjudication where charge = paid + adjustments", () => {
    const primary = findPrimaryClaim(balancedEra, "SEC-1")!;
    const findings = validateCobBalance(claim, primary);
    expect(rules(findings)).toEqual(["cob-balanced"]);
  });

  it("rejects a line that does not balance", () => {
    // Adjustments total only $10 against a $54.50 gap.
    const unbalanced = balancedEra.replace("CAS*CO*45*34.50~\nCAS*PR*2*20.00~", "CAS*CO*45*10.00~");
    const primary = findPrimaryClaim(unbalanced, "SEC-1")!;
    const findings = validateCobBalance(claim, primary);
    expect(rules(findings)).toContain("cob-line-out-of-balance");
    expect(findings.find((f) => f.rule === "cob-line-out-of-balance")!.message).toMatch(/off by \$44\.50/);
  });

  it("flags a line the primary never adjudicated", () => {
    const twoLines: ClaimInput = {
      ...claim,
      service_lines: [
        claim.service_lines[0],
        { cpt_hcpcs: "36415", charge: 10, units: 1, dx_pointers: [1], service_date: "20250601", place_of_service: "11" },
      ],
    };
    const primary = findPrimaryClaim(balancedEra, "SEC-1")!;
    expect(rules(validateCobBalance(twoLines, primary))).toContain("cob-line-unmatched");
  });

  it("rejects a charge that differs from what the primary adjudicated", () => {
    const cheaper: ClaimInput = { ...claim, service_lines: [{ ...claim.service_lines[0], charge: 120 }] };
    const primary = findPrimaryClaim(balancedEra, "SEC-1")!;
    const findings = validateCobBalance(cheaper, primary);
    expect(rules(findings)).toContain("cob-charge-mismatch");
    // SV1 carries the billed charge while SVD/CAS carry the primary's numbers,
    // so a mismatch emits a line that cannot balance — it must block the build.
    expect(findings.find((f) => f.rule === "cob-charge-mismatch")!.severity).toBe("error");
  });

  it("notes when the primary denied rather than paid", () => {
    const denied = balancedEra
      .replace("CLP*SEC-1*1*150.00*95.50*20.00*12*PCN1~", "CLP*SEC-1*4*150.00*0.00*0.00*12*PCN1~")
      .replace("SVC*HC:99214:25*150.00*95.50**1~", "SVC*HC:99214:25*150.00*0.00**1~")
      .replace("CAS*CO*45*34.50~\nCAS*PR*2*20.00~", "CAS*CO*50*150.00~");
    const primary = findPrimaryClaim(denied, "SEC-1")!;
    expect(rules(validateCobBalance(claim, primary))).toContain("cob-primary-denied");
  });

  it("returns null for a claim absent from the remittance", () => {
    expect(findPrimaryClaim(balancedEra, "NOPE")).toBeNull();
  });
});

describe("secondary 837 generation", () => {
  const primary = findPrimaryClaim(balancedEra, "SEC-1")!;
  const edi = buildSecondary837(claim, primary, {
    secondary: { name: "MEDICARE B", id: "MCR", subscriberId: "1EG4TE5MK73", filingIndicator: "MB", mspTypeCode: "12" },
    primaryPayerName: "PRIMARY PLAN",
    primaryPayerId: "P1",
    adjudicationDate: "20250615",
  });
  const segments = parseX12(edi);
  const find = (id: string) => segments.filter((s) => s.id === id);

  it("produces a parseable interchange", () => {
    expect(segments[0].id).toBe("ISA");
    expect(segments[segments.length - 1].id).toBe("IEA");
  });

  it("marks the destination payer as secondary and carries the MSP type code", () => {
    const sbrs = find("SBR");
    expect(sbrs[0].elements[0]).toBe("S");
    expect(sbrs[0].elements[4]).toBe("12"); // SBR05 insurance type
    expect(sbrs[0].elements[8]).toBe("MB"); // SBR09 filing indicator
  });

  it("includes a 2320 loop describing the primary payer's adjudication", () => {
    const sbrs = find("SBR");
    expect(sbrs).toHaveLength(2);
    expect(sbrs[1].elements[0]).toBe("P");
    const amt = find("AMT").find((s) => s.elements[0] === "D");
    expect(amt?.elements[1]).toBe("95.50");
    expect(find("OI")).toHaveLength(1);
  });

  it("carries the line adjudication in an SVD segment", () => {
    const svd = find("SVD")[0];
    expect(svd.elements[0]).toBe("P1");
    expect(svd.elements[1]).toBe("95.50");
    expect(svd.elements[2]).toBe("HC:99214:25");
  });

  it("groups the primary's adjustments into one CAS per group code", () => {
    const cas = find("CAS");
    expect(cas).toHaveLength(2);
    expect(cas.map((c) => c.elements[0]).sort()).toEqual(["CO", "PR"]);
    const co = cas.find((c) => c.elements[0] === "CO")!;
    expect(co.elements[1]).toBe("45");
    expect(co.elements[2]).toBe("34.50");
  });

  it("truncates the unused trailing quantity element on CAS", () => {
    // X12 requires trailing empty elements be dropped; a dangling separator
    // ("CAS*CO*45*34.50*~") trips syntax edits at the clearinghouse.
    expect(edi).not.toMatch(/CAS\*[^~]*\*~/);
    for (const c of find("CAS")) expect(c.elements[c.elements.length - 1]).not.toBe("");
  });

  it("stamps the adjudication date on both the claim and the line", () => {
    const dtp573 = find("DTP").filter((s) => s.elements[0] === "573");
    expect(dtp573).toHaveLength(2);
    expect(dtp573[0].elements[2]).toBe("20250615");
  });

  it("names the primary payer in the other-payer loop", () => {
    const payers = find("NM1").filter((s) => s.elements[0] === "PR");
    expect(payers.map((p) => p.elements[2])).toContain("PRIMARY PLAN");
    expect(payers.map((p) => p.elements[2])).toContain("MEDICARE B");
  });

  it("bills the secondary payer's own member ID for the patient", () => {
    const subscribers = find("NM1").filter((s) => s.elements[0] === "IL");
    expect(subscribers[0].elements[8]).toBe("1EG4TE5MK73"); // secondary
    expect(subscribers[1].elements[8]).toBe("PRIMEM1"); // primary, in loop 2330A
  });
});
