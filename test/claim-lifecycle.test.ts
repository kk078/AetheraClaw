import { describe, expect, it } from "vitest";
import { MockConnector } from "../src/tools/healthcare/clearinghouse/index.js";
import { build837p, type ClaimInput } from "../src/tools/healthcare/x12/837.js";
import { scrubClaim } from "../src/tools/healthcare/claim-scrub.js";
import { evaluateGate, renderGate } from "../src/tools/healthcare/presubmit.js";
import { parse835 } from "../src/tools/healthcare/x12/835.js";

// ── A claim from eligibility to posted payment ───────────────────────────────
//
// Every stage here already has its own unit tests. What none of them cover is
// the HANDOFF: whether the thing one stage produces is the thing the next stage
// can actually consume. Those seams are where an integration breaks in a way no
// unit test notices — the scrubber passes, the builder builds, the connector
// accepts, and the claim still goes out wrong because the charge the payer saw
// is not the charge the coder entered.
//
// So the assertions here are deliberately about VALUES CROSSING BOUNDARIES
// rather than about any one function's behaviour. The mock connector is the
// only network involved; nothing in this file can reach a payer.

const CLAIM: ClaimInput = {
  claim_id: "LC-0001",
  payer_name: "MOCK PAYER",
  payer_id: "87726",
  billing_provider_npi: "1999999984",
  billing_provider_name: "LIFECYCLE CLINIC",
  subscriber_id: "SYN000111",
  patient_last: "TESTPATIENT",
  patient_first: "ALEX",
  patient_dob: "19800215",
  patient_sex: "U",
  diagnoses: ["E11.9"],
  service_lines: [
    {
      cpt_hcpcs: "99214",
      modifiers: [],
      charge: 225,
      units: 1,
      dx_pointers: [1],
      service_date: "20260115",
      place_of_service: "11",
    },
  ],
};

const ELIGIBILITY = {
  payerId: "87726",
  providerNpi: "1999999984",
  providerName: "LIFECYCLE CLINIC",
  subscriberMemberId: "SYN000111",
  subscriberFirstName: "ALEX",
  subscriberLastName: "TESTPATIENT",
  subscriberDateOfBirth: "19800215",
};

/** An 835 paying the claim above: 225 charged, 180 allowed, 45 to the patient. */
const REMITTANCE = [
  "ISA*00*          *00*          *ZZ*PAYER          *ZZ*RECEIVER       *260115*1200*^*00501*000000001*0*P*:~",
  "GS*HP*PAYER*RECEIVER*20260115*1200*1*X*005010X221A1~",
  "ST*835*0001~",
  "BPR*I*180.00*C*ACH*CCP*01*999999999*DA*123456*1512345678**01*999988880*DA*98765*20260120~",
  "TRN*1*LC0001*1512345678~",
  "CLP*LC-0001*1*225.00*180.00*45.00*12*ABC123*11~",
  "NM1*QC*1*TESTPATIENT*ALEX****MI*SYN000111~",
  "SVC*HC:99214*225.00*180.00**1~",
  "CAS*PR*1*45.00~",
  "SE*8*0001~",
  "GE*1*1~",
  "IEA*1*000000001~",
].join("");

describe("a claim from eligibility to posted payment", () => {
  it("carries the same patient through eligibility, scrub and the 837", async () => {
    const eligibility = await new MockConnector().checkEligibility(ELIGIBILITY);
    expect(eligibility.identified).toBe(true);

    const findings = scrubClaim(CLAIM);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);

    // The point of the assertion: the member id the payer confirmed is the
    // member id on the wire. A claim billed under a different id than the one
    // eligibility was checked for denies, and the eligibility check is then
    // worse than useless because it produced false confidence.
    const x12 = build837p(CLAIM);
    expect(x12).toContain(ELIGIBILITY.subscriberMemberId);
    expect(x12).toContain("99214");
    expect(x12).toContain("E119");
  });

  it("does not let a gate say CLEAR while checks were skipped", () => {
    const gate = evaluateGate({
      scrubFindings: scrubClaim(CLAIM),
      denialProbability: null,
      denialFactors: [],
      checksNotRun: ["ncci", "mue"],
    });
    // "clear" is allowed — nothing that ran failed. What is NOT allowed is for
    // the skipped checks to disappear, because that converts an absence of
    // information into a statement of safety.
    expect(gate.blindSpots).toEqual(["ncci", "mue"]);
    expect(renderGate(gate)).toContain("ncci");
  });

  it("submits, gets a status, and never calls the receipt proof of filing", async () => {
    const mock = new MockConnector();
    const receipt = await mock.submitClaim(build837p(CLAIM));
    expect(receipt.accepted).toBe(true);
    expect(receipt.meta.simulated).toBe(true);
    expect(receipt.message).toMatch(/not proof of filing/i);

    const status = await mock.checkClaimStatus({
      payerId: CLAIM.payer_id,
      providerNpi: CLAIM.billing_provider_npi,
      claimControlNumber: CLAIM.claim_id,
      subscriberMemberId: CLAIM.subscriber_id,
      totalChargeAmount: "225",
      serviceDateFrom: "20260115",
    });
    expect(status.meta.simulated).toBe(true);
  });

  it("posts the remittance against the claim it was built for", () => {
    const era = parse835(REMITTANCE);
    const claim = era.claims[0];
    expect(claim?.claimId).toBe(CLAIM.claim_id);

    // The charge submitted and the charge adjudicated must be the same number.
    // When they are not, the claim on the wire was not the claim in the system,
    // and every downstream KPI is computed against a fiction.
    const submitted = CLAIM.service_lines.reduce((n, l) => n + l.charge, 0);
    expect(claim?.charged).toBe(submitted);

    expect(claim?.paid).toBe(180);
    expect(claim?.patientResponsibility).toBe(45);
    // Charged, paid and patient responsibility reconcile. A parser that netted
    // them would lose the write-off, which is the number a contract analysis
    // depends on.
    expect((claim?.charged ?? 0) - (claim?.paid ?? 0)).toBe(45);
    // The adjustment keeps its GROUP. PR-45 is billable to the patient; CO-45
    // is a contractual write-off that may not be. Same amount, opposite action.
    expect(claim?.lines[0]?.adjustments[0]).toMatchObject({ group: "PR", amount: 45 });
  });
});

describe("the lifecycles that do not end in payment", () => {
  it("stops at eligibility when the payer cannot identify the patient", async () => {
    const r = await new MockConnector().checkEligibility({
      ...ELIGIBILITY,
      subscriberMemberId: "MOCK_NOT_FOUND",
    });
    expect(r.identified).toBe(false);
    // The next action is to fix the demographics, not to tell the patient they
    // are uninsured. The summary must not support the second reading.
    expect(r.summary).not.toMatch(/no active coverage|uninsured/i);
    expect(r.summary).toMatch(/not a statement about coverage/i);
  });

  it("stops at eligibility when the plan has terminated", async () => {
    const r = await new MockConnector().checkEligibility({
      ...ELIGIBILITY,
      subscriberMemberId: "MOCK_INACTIVE",
    });
    // Identified — the payer found them — and NOT covered. The opposite
    // conclusion from the case above, reached through the same call.
    expect(r.identified).toBe(true);
    expect(r.summary).not.toMatch(/Active coverage confirmed/);
    expect(r.summary).toMatch(/no active coverage/i);
  });

  it("records no filing when the clearinghouse rejects before the payer sees it", async () => {
    const mock = new MockConnector();
    let rejected: Awaited<ReturnType<MockConnector["submitClaim"]>> | null = null;
    for (let i = 0; i < 400 && !rejected; i++) {
      const r = await mock.submitClaim(build837p({ ...CLAIM, claim_id: `LC-R${i}` }));
      if (!r.accepted) rejected = r;
    }
    expect(rejected).not.toBeNull();
    // No receipt at all, rather than a receipt with accepted:false. A caller
    // that stores `receiptId` without reading `accepted` must end up with
    // nothing, not with a filing proof for a claim that was never sent.
    expect(rejected?.receiptId).toBe("");
    expect(rejected?.message).toMatch(/Nothing was filed/i);
  });

  it("gives the same receipt for a claim submitted twice", async () => {
    const mock = new MockConnector();
    const x12 = build837p(CLAIM);
    const first = await mock.submitClaim(x12);
    const second = await mock.submitClaim(x12);
    // A property the real connector cannot have, and the reason it is here:
    // duplicate submission is the failure submitClaim documents as
    // unrecoverable, so a rehearsal has to make it visible.
    expect(second.receiptId).toBe(first.receiptId);

    const different = await mock.submitClaim(build837p({ ...CLAIM, claim_id: "LC-0002" }));
    expect(different.receiptId).not.toBe(first.receiptId);
  });
});
