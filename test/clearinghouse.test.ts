import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseStediEligibility, StediConnector } from "../src/tools/healthcare/clearinghouse/stedi.js";
import { summariseEligibility } from "../src/tools/healthcare/clearinghouse/types.js";
import { MockConnector } from "../src/tools/healthcare/clearinghouse/mock.js";
import { getConnector } from "../src/tools/healthcare/clearinghouse/index.js";

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

// ── The mock connector ───────────────────────────────────────────────────────
// This is the ONLY rehearsal that exists for claim submission. Stedi's sandbox
// plan covers eligibility and nothing else; status, submission and ERA unlock
// on the production plan, which sends real claims to real payers. Whatever
// confidence anyone has in the 837 path before the first live submission comes
// from these tests.

describe("MockConnector", () => {
  const mock = new MockConnector();
  const elig = (memberId: string) => ({
    payerId: "60054", providerNpi: "1999999984", providerName: "ACME",
    subscriberMemberId: memberId, subscriberFirstName: "John", subscriberLastName: "Doe",
    subscriberDateOfBirth: "19800101",
  });

  it("marks EVERY result simulated", async () => {
    // Consumers check this before writing anything to a claim record. A mock
    // that claimed otherwise would put an invented payer answer into the audit
    // trail, which is the one thing x12/276.ts has always refused to allow.
    expect((await mock.checkEligibility(elig("ANY"))).meta.simulated).toBe(true);
    expect((await mock.checkClaimStatus({ payerId: "1", providerNpi: "1", claimControlNumber: "C1", subscriberMemberId: "M", totalChargeAmount: "100", serviceDateFrom: "20250101" })).meta.simulated).toBe(true);
    expect((await mock.submitClaim("ISA*00*")).meta.simulated).toBe(true);
  });

  it("is deterministic — the same input always gives the same answer", async () => {
    // A random mock makes a test that fails one run in twenty and a demo that
    // cannot be rehearsed.
    const a = await mock.submitClaim("ISA*00*claim-one");
    const b = await mock.submitClaim("ISA*00*claim-one");
    expect(a.receiptId).toBe(b.receiptId);
    expect(a.accepted).toBe(b.accepted);
  });

  it("can be made to show a not-found and an inactive on demand", async () => {
    // A rehearsal that can only show success teaches nobody what a rejection
    // looks like, and the rejection is what a biller spends the day on.
    const notFound = await mock.checkEligibility(elig("MOCK_NOT_FOUND"));
    expect(notFound.identified).toBe(false);
    expect(notFound.summary).toMatch(/could not identify/i);

    const inactive = await mock.checkEligibility(elig("MOCK_INACTIVE"));
    // The other half of the distinction: FOUND, and not covered.
    expect(inactive.identified).toBe(true);
    expect(inactive.summary).toMatch(/no active coverage/i);
    expect(inactive.summary).not.toMatch(/could not identify/i);
  });

  it("returns active coverage with cost-share for an ordinary member", async () => {
    const out = await mock.checkEligibility(elig("MEMBER123"));
    expect(out.identified).toBe(true);
    expect(out.summary).toMatch(/Active coverage confirmed/i);
    expect(out.benefits.map((b) => b.name)).toContain("Co-Payment");
  });

  it("gives the SAME receipt for the same claim submitted twice", async () => {
    // A property the real connector cannot have, and the reason it is here:
    // duplicate submission is the unrecoverable failure submitClaim documents,
    // so the rehearsal makes it VISIBLE rather than producing two receipts for
    // one claim.
    const first = await mock.submitClaim("ISA*837*duplicate-me");
    const second = await mock.submitClaim("ISA*837*duplicate-me");
    expect(first.receiptId).toBe(second.receiptId);
  });

  it("has a clearinghouse-level rejection path that files nothing", async () => {
    // Rejection before the payer ever sees it — real, common, and the case
    // people forget. Nothing may record a filing proof for it.
    const outcomes = await Promise.all(
      Array.from({ length: 40 }, (_, i) => mock.submitClaim(`ISA*837*claim-${i}`)),
    );
    const rejected = outcomes.filter((o) => !o.accepted);
    expect(rejected.length).toBeGreaterThan(0);
    for (const r of rejected) {
      expect(r.receiptId).toBe("");
      expect(r.message).toMatch(/not forwarded|Nothing was filed/i);
    }
  });

  it("never calls an accepted mock submission proof of filing", async () => {
    const ok = (await Promise.all(Array.from({ length: 20 }, (_, i) => mock.submitClaim(`ISA*ok-${i}`)))).find((o) => o.accepted)!;
    expect(ok.message).toMatch(/not proof of filing/i);
  });

  it("returns NO remittances rather than inventing payments", async () => {
    // A fabricated 835 would put invented amounts through the posting path and
    // into the KPIs, indistinguishable from money that actually arrived.
    expect(await mock.pollRemittances(new Date(0))).toEqual([]);
  });

  it("produces a mixture of claim statuses, including not-found", async () => {
    const statuses = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        mock.checkClaimStatus({ payerId: "1", providerNpi: "1", claimControlNumber: `CLM-${i}`, subscriberMemberId: "M", totalChargeAmount: "100", serviceDateFrom: "20250101" }),
      ),
    );
    expect(statuses.some((s) => !s.found)).toBe(true);
    expect(statuses.some((s) => s.found && s.statusCategory === "F")).toBe(true);
    expect(statuses.some((s) => s.found && s.statusCategory === "A")).toBe(true);
  });
});

describe("getConnector", () => {
  const cfg = (healthcare: Record<string, unknown>) =>
    ({ healthcare: { clearinghouse: "mock", clearinghouseEnv: "sandbox", ...healthcare } }) as never;

  it("defaults to mock", () => {
    const c = getConnector(cfg({}));
    expect(c.connector.name).toBe("mock");
    expect(c.note).toMatch(/nothing leaves this machine/i);
  });

  it("falls back to mock — loudly — when stedi is configured with no key", () => {
    const prev = process.env.ORION_STEDI_API_KEY;
    delete process.env.ORION_STEDI_API_KEY;
    delete process.env.STEDI_API_KEY;
    const c = getConnector(cfg({ clearinghouse: "stedi" }));
    expect(c.connector.name).toBe("mock");
    // A deployment that believes it is talking to a clearinghouse and is not
    // will file nothing and notice in a month.
    expect(c.note).toMatch(/STEDI_API_KEY is not set/);
    if (prev !== undefined) process.env.ORION_STEDI_API_KEY = prev;
  });

  it("falls back to mock for an unknown connector name", () => {
    expect(getConnector(cfg({ clearinghouse: "acme-clearing" })).connector.name).toBe("mock");
  });

  it("shouts when production is selected", () => {
    process.env.STEDI_API_KEY = "test_key";
    const c = getConnector(cfg({ clearinghouse: "stedi", clearinghouseEnv: "production" }));
    expect(c.note).toMatch(/REAL PAYERS/);
    delete process.env.STEDI_API_KEY;
  });
});

describe("summariseEligibility — the 'Inactive' trap", () => {
  it("does NOT read a terminated plan as active coverage", () => {
    // "Inactive" contains "active". A naive /active/i test read a TERMINATED
    // plan as confirmed coverage — the worst wrong answer available here: a
    // biller tells the patient they are covered, bills a claim guaranteed to
    // deny, and has said something false at the desk.
    const s = summariseEligibility(
      true,
      [{ code: "6", name: "Inactive", serviceTypeCodes: ["30"], amount: "", percent: "", network: "", message: "Coverage terminated" }],
      [],
    );
    expect(s).toMatch(/no active coverage/i);
    expect(s).not.toMatch(/Active coverage confirmed/i);
  });

  it("still recognises real active coverage", () => {
    const s = summariseEligibility(true, [{ code: "1", name: "Active Coverage", serviceTypeCodes: ["30"], amount: "", percent: "", network: "Y", message: "" }], []);
    expect(s).toMatch(/Active coverage confirmed/i);
  });
});

describe("a REAL successful 271 — the other half of the contract", () => {
  // Captured live from Stedi's sandbox: UnitedHealthcare, member UHC123456,
  // Jane Doe, 01/01/1971. Thirty-eight benefit lines and no AAA segment.
  //
  // Without this fixture the parser was only ever proved against rejections,
  // and a mapping that handles every failure and mangles the success is a
  // perfectly ordinary bug.
  const active = () => fixture("271-active-coverage.json");

  it("reads it as identified, with no rejections", () => {
    const out = parseStediEligibility(active(), "sandbox");
    expect(out.identified).toBe(true);
    expect(out.rejections).toEqual([]);
    expect(out.payerName).toMatch(/UNITEDHEALTHCARE/i);
  });

  it("says active coverage is confirmed", () => {
    expect(parseStediEligibility(active(), "sandbox").summary).toMatch(/Active coverage confirmed/i);
  });

  it("carries the cost-share lines a biller needs", () => {
    const out = parseStediEligibility(active(), "sandbox");
    const names = out.benefits.map((b) => b.name);
    expect(names).toContain("Active Coverage");
    expect(names.some((n) => /deductible/i.test(n))).toBe(true);
    expect(names.some((n) => /out of pocket/i.test(n))).toBe(true);
    // Amounts must survive the mapping — they are what the patient is told at
    // the desk.
    expect(out.benefits.some((b) => b.amount !== "")).toBe(true);
  });

  it("keeps every benefit line rather than collapsing the plan", () => {
    // A 271 carries one line per service type and coverage level. Deduplicating
    // or flattening them loses the distinction between an individual and a
    // family deductible, which is the number people get wrong.
    expect(parseStediEligibility(active(), "sandbox").benefits.length).toBeGreaterThan(10);
  });
});
