import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseStediEligibility, StediConnector } from "../src/tools/healthcare/clearinghouse/stedi.js";
import { summariseEligibility } from "../src/tools/healthcare/clearinghouse/types.js";

// The fixtures are REAL responses from Stedi's sandbox, captured live and then
// scrubbed of the account's submitter and trace ids. They are here because the
// distinction they encode is the one every naive integration gets wrong:
//
//   a 271 with an AAA segment  = the payer could not identify this patient
//   a 271 with no benefits     = the payer identified them and found no coverage
//
// Those lead to opposite actions — fix the demographics and retry, versus tell
// the patient they are uninsured — and both arrive as HTTP 200.

const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "stedi", name), "utf8"));

describe("parseStediEligibility — against real recorded sandbox responses", () => {
  it("reads an AAA rejection as NOT IDENTIFIED, not as 'no coverage'", () => {
    const out = parseStediEligibility(fixture("271-aaa-invalid-member.json"), "sandbox");
    expect(out.identified).toBe(false);
    expect(out.rejections.length).toBeGreaterThan(0);
    expect(out.rejections[0].description).toMatch(/Invalid\/Missing Subscriber/i);
    // The sentence a biller reads must not imply anything about coverage.
    expect(out.summary).toMatch(/could not identify/i);
    expect(out.summary).toMatch(/not a statement about coverage/i);
  });

  it("carries the payer's own words and follow-up action through", () => {
    const out = parseStediEligibility(fixture("271-aaa-invalid-member.json"), "sandbox");
    expect(out.payerName).toBe("AETNA INC");
    expect(out.rejections[0].followupAction).toMatch(/Correct and Resubmit/i);
  });

  it("distinguishes a DOB mismatch from an unknown member", () => {
    // Both are AAA rejections and both mean "retry with better data", but the
    // fix is different: one is the date, the other is the id.
    const out = parseStediEligibility(fixture("271-aaa-dob-mismatch.json"), "sandbox");
    expect(out.identified).toBe(false);
    expect(out.rejections[0].description).toMatch(/Birth Date/i);
    expect(out.payerName).toMatch(/UNITEDHEALTHCARE/i);
  });

  it("never reports a rejected enquiry as simulated", () => {
    // A real payer rejection is a real answer. Marking it simulated would let
    // it be filtered out of exactly the reports that need it.
    const out = parseStediEligibility(fixture("271-aaa-invalid-member.json"), "sandbox");
    expect(out.meta.simulated).toBe(false);
    expect(out.meta.connector).toBe("stedi");
  });

  it("takes the environment from the RESPONSE, not the key prefix", () => {
    // applicationMode is a fact about which network answered; a key prefix is a
    // naming convention that can be wrong.
    expect(parseStediEligibility({ meta: { applicationMode: "test" } }, "production").meta.environment).toBe("production");
    expect(parseStediEligibility({ meta: { applicationMode: "production" } }, "sandbox").meta.environment).toBe("production");
  });

  it("deduplicates AAA segments that appear in both places", () => {
    // Stedi puts them in top-level `errors` AND in `subscriber.aaaErrors`, and
    // a response can populate both with the same segment.
    const body = {
      errors: [{ code: "72", description: "Invalid/Missing Subscriber/Insured ID" }],
      subscriber: { aaaErrors: [{ code: "72", description: "Invalid/Missing Subscriber/Insured ID" }] },
    };
    expect(parseStediEligibility(body, "sandbox").rejections).toHaveLength(1);
  });
});

describe("summariseEligibility", () => {
  it("says active coverage only when the payer said so", () => {
    const s = summariseEligibility(true, [{ code: "1", name: "Active Coverage", serviceTypeCodes: ["30"], amount: "", percent: "", network: "Y", message: "" }], []);
    expect(s).toMatch(/Active coverage confirmed/i);
  });

  it("does not turn an identified-but-uncovered patient into a rejection", () => {
    const s = summariseEligibility(true, [], []);
    expect(s).toMatch(/identified this patient and returned no active coverage/i);
    expect(s).not.toMatch(/could not identify/i);
  });

  it("says plainly when a rejection carried no reason", () => {
    expect(summariseEligibility(false, [], [])).toMatch(/gave no reason/i);
  });
});

describe("StediConnector", () => {
  it("refuses to construct without a key", () => {
    expect(() => new StediConnector({ apiKey: "", environment: "sandbox" })).toThrow(/API key/i);
  });

  it("sends the raw key, not a Bearer token", async () => {
    // Verified against the live sandbox: `Bearer <key>` is rejected with 401.
    let seen: Record<string, string> = {};
    const c = new StediConnector({
      apiKey: "test_key",
      environment: "sandbox",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen = init.headers as Record<string, string>;
        return { ok: true, json: async () => ({ meta: { applicationMode: "test" } }) } as Response;
      }) as unknown as typeof fetch,
    });
    await c.checkEligibility({
      payerId: "60054", providerNpi: "1999999984", providerName: "ACME",
      subscriberMemberId: "X", subscriberFirstName: "Jane", subscriberLastName: "Doe",
      subscriberDateOfBirth: "19700101",
    });
    expect(seen.authorization).toBe("test_key");
    expect(seen.authorization).not.toMatch(/^Bearer/);
  });

  it("THROWS on an HTTP failure rather than inventing a coverage answer", async () => {
    const c = new StediConnector({
      apiKey: "k", environment: "sandbox",
      fetchImpl: (async () => ({ ok: false, status: 503, text: async () => "upstream down" }) as Response) as unknown as typeof fetch,
    });
    await expect(
      c.checkEligibility({
        payerId: "1", providerNpi: "1", providerName: "a", subscriberMemberId: "b",
        subscriberFirstName: "c", subscriberLastName: "d", subscriberDateOfBirth: "19700101",
      }),
    ).rejects.toThrow(/did not reach the payer/i);
  });

  it("refuses submit, status and remittance rather than faking a receipt", async () => {
    // A stub returning a plausible receipt would be recorded as proof of a
    // filing that never happened — worse than an error by a wide margin.
    const c = new StediConnector({ apiKey: "k", environment: "sandbox" });
    await expect(c.submitClaim("ISA*...")).rejects.toThrow(/not implemented yet/i);
    await expect(c.pollRemittances(new Date())).rejects.toThrow(/not implemented yet/i);
  });
});
