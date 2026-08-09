import { describe, expect, it } from "vitest";
import { npiLuhnValid } from "../src/tools/healthcare/npi.js";
import { build837p, type ClaimInput } from "../src/tools/healthcare/x12/837.js";
import { parseX12 } from "../src/tools/healthcare/x12/segments.js";
import { parse835 } from "../src/tools/healthcare/x12/835.js";
import { scrubClaim } from "../src/tools/healthcare/claim-scrub.js";
import { calculateEm } from "../src/tools/healthcare/em-calculator.js";
import { explainDenial } from "../src/tools/healthcare/denial-codes.js";

// 1234567893 is the standard NPPES test NPI (valid Luhn with 80840 prefix).
const VALID_NPI = "1234567893";

describe("NPI Luhn validation", () => {
  it("accepts a valid NPI", () => {
    expect(npiLuhnValid(VALID_NPI)).toBe(true);
  });
  it("rejects a check-digit typo", () => {
    expect(npiLuhnValid("1234567894")).toBe(false);
  });
  it("rejects malformed input", () => {
    expect(npiLuhnValid("12345")).toBe(false);
    expect(npiLuhnValid("abcdefghij")).toBe(false);
  });
});

const testClaim: ClaimInput = {
  claim_id: "TESTCLM001",
  payer_name: "TEST PAYER",
  payer_id: "12345",
  billing_provider_npi: VALID_NPI,
  billing_provider_name: "TEST CLINIC",
  subscriber_id: "TESTMEM001",
  patient_last: "DOE",
  patient_first: "JANE",
  patient_dob: "19700101",
  patient_sex: "F",
  diagnoses: ["E11.65", "I10"],
  service_lines: [
    {
      cpt_hcpcs: "99214",
      modifiers: ["25"],
      charge: 150,
      units: 1,
      dx_pointers: [1, 2],
      service_date: "20250601",
      place_of_service: "11",
    },
  ],
};

describe("X12 837P build → parse round trip", () => {
  it("builds a parseable interchange with envelope and claim data", () => {
    const edi = build837p(testClaim);
    const segments = parseX12(edi);
    const ids = segments.map((s) => s.id);
    expect(ids[0]).toBe("ISA");
    expect(ids).toContain("CLM");
    expect(ids).toContain("SV1");
    expect(ids[ids.length - 1]).toBe("IEA");
    const clm = segments.find((s) => s.id === "CLM");
    expect(clm?.elements[0]).toBe("TESTCLM001");
    expect(clm?.elements[1]).toBe("150.00");
    const hi = segments.find((s) => s.id === "HI");
    expect(hi?.elements[0]).toBe("ABK:E1165");
  });
});

const SAMPLE_835 = [
  "ISA*00*          *00*          *ZZ*PAYERID        *ZZ*PROVIDERID     *250601*1200*^*00501*000000001*0*T*:~",
  "GS*HP*PAYERID*PROVIDERID*20250601*1200*1*X*005010X221A1~",
  "ST*835*0001~",
  "BPR*I*245.50*C*ACH~",
  "N1*PR*ACME HEALTH PLAN~",
  "N1*PE*TEST CLINIC~",
  "CLP*TESTCLM001*1*150.00*95.50*20.00*12*PCN123~",
  "SVC*HC:99214:25*150.00*95.50**1~",
  "CAS*CO*45*34.50~",
  "CAS*PR*3*20.00~",
  "CLP*TESTCLM002*4*200.00*0.00*0.00*12*PCN124~",
  "SVC*HC:95250*200.00*0.00**1~",
  "CAS*CO*50*200.00~",
  "LQ*HE*N115~",
  "SE*12*0001~",
  "GE*1*1~",
  "IEA*1*000000001~",
].join("\n");

describe("X12 835 parsing", () => {
  it("extracts payer, claims, payments, adjustments, and remark codes", () => {
    const era = parse835(SAMPLE_835);
    expect(era.payer).toBe("ACME HEALTH PLAN");
    expect(era.checkOrEftAmount).toBe(245.5);
    expect(era.claims).toHaveLength(2);
    const paid = era.claims[0];
    expect(paid.statusCode).toBe("1");
    expect(paid.paid).toBe(95.5);
    expect(paid.lines[0].adjustments).toEqual([
      { group: "CO", carc: "45", amount: 34.5 },
      { group: "PR", carc: "3", amount: 20 },
    ]);
    const denied = era.claims[1];
    expect(denied.statusCode).toBe("4");
    expect(denied.lines[0].adjustments[0].carc).toBe("50");
    expect(denied.lines[0].rarcs).toContain("N115");
  });
});

describe("claim scrub", () => {
  it("passes a clean claim", () => {
    const findings = scrubClaim(testClaim);
    expect(findings.filter((f) => f.severity === "error")).toHaveLength(0);
  });
  it("catches bad NPI, bad dx format, and dx pointer out of range", () => {
    const bad: ClaimInput = {
      ...testClaim,
      billing_provider_npi: "1234567894",
      diagnoses: ["NOTACODE"],
      service_lines: [{ ...testClaim.service_lines[0], dx_pointers: [3] }],
    };
    const rules = scrubClaim(bad).map((f) => f.rule);
    expect(rules).toContain("npi-billing");
    expect(rules).toContain("dx-format");
    expect(rules).toContain("dx-pointer-range");
  });
  it("flags telehealth POS without modifier", () => {
    const th: ClaimInput = {
      ...testClaim,
      service_lines: [{ ...testClaim.service_lines[0], modifiers: [], place_of_service: "10" }],
    };
    expect(scrubClaim(th).map((f) => f.rule)).toContain("telehealth-modifier");
  });
});

describe("E/M calculator (2021 MDM)", () => {
  const base = {
    problems: { minor_problems: 0, stable_chronic: 0, exacerbated_chronic: 0, acute_uncomplicated: 0, acute_complicated_or_systemic: 0, threat_to_life: false },
    data: { tests_reviewed: 0, tests_ordered: 0, external_notes: 0, independent_historian: false, independent_interpretation: false, discussed_with_external: false },
  };
  it("99214: established, 2 stable chronic + prescription management (moderate/moderate)", () => {
    const result = calculateEm({
      patient_type: "established",
      problems: { ...base.problems, stable_chronic: 2 },
      data: base.data,
      risk: "moderate",
    });
    expect(result.code).toBe("99214");
  });
  it("99212: established, one minor problem, minimal everything", () => {
    const result = calculateEm({
      patient_type: "established",
      problems: { ...base.problems, minor_problems: 1 },
      data: base.data,
      risk: "minimal",
    });
    expect(result.code).toBe("99212");
  });
  it("99205: new patient with threat to life and high risk", () => {
    const result = calculateEm({
      patient_type: "new",
      problems: { ...base.problems, threat_to_life: true },
      data: { ...base.data, tests_reviewed: 2, independent_interpretation: true, discussed_with_external: true },
      risk: "high",
    });
    expect(result.code).toBe("99205");
  });
});

describe("denial explanation", () => {
  it("explains known CARC + RARC with action guidance", () => {
    const out = explainDenial("197", ["N115"]);
    expect(out).toMatch(/authorization/i);
    expect(out).toMatch(/Local Coverage Determination/);
  });
  it("degrades gracefully for unknown codes", () => {
    expect(explainDenial("9999")).toMatch(/not in bundled dataset/);
  });
});
