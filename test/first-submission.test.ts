import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.js";
import {
  AFTER_SUBMISSION,
  IDEAL_FIRST_CLAIM,
  evaluateFirstSubmission,
  renderFirstSubmission,
  type FirstSubmissionInput,
} from "../src/tools/healthcare/clearinghouse/first-submission.js";
import {
  countLiveSubmissions,
  digestOf,
  listLiveSubmissions,
  priorSubmissionOf,
  recordAttempt,
  recordOutcome,
  renderLedger,
} from "../src/tools/healthcare/clearinghouse/live-ledger.js";
import { annotateSegments, diffAgainstBelief, renderDryRun } from "../src/tools/healthcare/clearinghouse/dry-run.js";

const T0 = 1_800_000_000_000;

/** Everything green. Each test spoils exactly one thing, so a failure names its cause. */
function ready(over: Partial<FirstSubmissionInput> = {}): FirstSubmissionInput {
  return {
    connectorName: "stedi",
    environment: "production",
    approvalPolicy: "always",
    priorLiveSubmissions: 0,
    liveSubmissionCap: 1,
    scrubFindings: [],
    chargeAmount: 225,
    filingDaysLeft: 120,
    eligibilityVerified: true,
    supervisor: "Kim R.",
    checksNotRun: [],
    dryRunReviewed: true,
    ...over,
  };
}

describe("the cap", () => {
  it("allows the first submission and says which one it is", () => {
    const r = evaluateFirstSubmission(ready());
    expect(r.blocked).toBe(false);
    expect(r.checks.find((c) => c.id === "cap")?.message).toContain("1 of 1");
  });

  it("BLOCKS once the cap is spent", () => {
    // The whole reason this is code and not a document: a checklist saying
    // "only submit one to start" is one somebody deviates from at 4pm when the
    // first one worked and the queue is long.
    const r = evaluateFirstSubmission(ready({ priorLiveSubmissions: 1 }));
    expect(r.blocked).toBe(true);
    expect(r.checks.find((c) => c.id === "cap")?.level).toBe("block");
  });

  it("says accepted is not paid when it refuses to let the cap rise casually", () => {
    const r = evaluateFirstSubmission(ready({ priorLiveSubmissions: 1 }));
    expect(r.checks.find((c) => c.id === "cap")?.fix).toMatch(/accepted is not the same as a claim that adjudicated/i);
  });

  it("reports what remains after this one", () => {
    expect(evaluateFirstSubmission(ready({ liveSubmissionCap: 3 })).remainingAfter).toBe(2);
  });
});

describe("what blocks a send", () => {
  it("blocks with nobody supervising", () => {
    const r = evaluateFirstSubmission(ready({ supervisor: "  " }));
    expect(r.blocked).toBe(true);
    expect(r.checks.find((c) => c.id === "supervisor")?.message).toMatch(/somebody is watching/);
  });

  it('blocks when approvalPolicy is "never"', () => {
    // An unattended submission however many people are in the room.
    const r = evaluateFirstSubmission(ready({ approvalPolicy: "never" }));
    expect(r.blocked).toBe(true);
  });

  it("blocks on a scrub ERROR, because it teaches nothing about the connection", () => {
    const r = evaluateFirstSubmission(ready({
      scrubFindings: [{ severity: "error", rule: "npi-billing", message: "" }],
    }));
    expect(r.blocked).toBe(true);
    expect(r.checks.find((c) => c.id === "scrub")?.fix).toMatch(/teaches nothing/);
  });

  it("blocks when nobody has read the built 837", () => {
    // The dry run is the last moment the claim is still yours.
    const r = evaluateFirstSubmission(ready({ dryRunReviewed: false }));
    expect(r.blocked).toBe(true);
    expect(r.checks.find((c) => c.id === "dry-run")?.message).toMatch(/last moment/);
  });

  it("blocks a claim whose filing window has already closed", () => {
    const r = evaluateFirstSubmission(ready({ filingDaysLeft: -3 }));
    expect(r.blocked).toBe(true);
  });
});

describe("what warns rather than blocks", () => {
  it("warns on a scrub warning without stopping the run", () => {
    const r = evaluateFirstSubmission(ready({
      scrubFindings: [{ severity: "warning", rule: "modifier-25", message: "" }],
    }));
    expect(r.blocked).toBe(false);
    expect(r.checks.find((c) => c.id === "scrub")?.level).toBe("warn");
  });

  it("BLOCKS on a skipped check, because it did NOT pass — it did not happen", () => {
    // The same failure evaluateGate refuses to make: converting an absence of
    // information into a statement of safety. It was a warning until somebody
    // ran the checklist and watched "The scrubber found nothing" print directly
    // above "ncci-ptp.json, mue.json, icd10.json could not run".
    const r = evaluateFirstSubmission(ready({ checksNotRun: ["NCCI/MUE bundling"] }));
    const check = r.checks.find((c) => c.id === "blind-spots");
    expect(check?.level).toBe("block");
    expect(check?.message).toMatch(/did NOT pass/);
    expect(r.blocked).toBe(true);
  });

  it("clears once the missing data is installed", () => {
    // The block has to be one somebody can actually get past, or it becomes a
    // reason to stop using the gate. `orion data refresh` fetches public files.
    const r = evaluateFirstSubmission(ready({ checksNotRun: [] }));
    expect(r.checks.find((c) => c.id === "blind-spots")).toBeUndefined();
    expect(r.blocked).toBe(false);
  });

  it("says how to clear it, not just that it is blocked", () => {
    const r = evaluateFirstSubmission(ready({ checksNotRun: ["ncci-ptp.json"] }));
    expect(r.checks.find((c) => c.id === "blind-spots")?.fix).toMatch(/orion data refresh/);
  });

  it("warns about a large first claim without forbidding it", () => {
    const r = evaluateFirstSubmission(ready({ chargeAmount: 9000 }));
    expect(r.checks.find((c) => c.id === "amount")?.level).toBe("warn");
    expect(r.blocked).toBe(false);
  });

  it("warns when eligibility was never checked", () => {
    const r = evaluateFirstSubmission(ready({ eligibilityVerified: false }));
    expect(r.checks.find((c) => c.id === "eligibility")?.message).toMatch(/71 and 72/);
  });

  it("warns that a sandbox run proves nothing about the live path", () => {
    const r = evaluateFirstSubmission(ready({ environment: "sandbox" }));
    expect(r.checks.find((c) => c.id === "environment")?.message).toMatch(/proves nothing/);
  });

  it("says the mock connector means a rehearsal", () => {
    const r = evaluateFirstSubmission(ready({ connectorName: "mock" }));
    expect(r.checks.find((c) => c.id === "connector")?.message).toMatch(/rehearsal/);
  });
});

describe("what the report says about itself", () => {
  it("refuses to call a passing gate a safety proof", () => {
    // A green checklist is exactly the sort of thing quoted as approval later.
    expect(evaluateFirstSubmission(ready()).summary).toMatch(/does NOT mean the claim is correct/);
    expect(evaluateFirstSubmission(ready()).summary).toMatch(/Only the payer decides/);
  });

  it("prints the after-submission procedure on a passing gate, not a failing one", () => {
    expect(renderFirstSubmission(evaluateFirstSubmission(ready()))).toContain("AFTER IT GOES OUT");
    expect(renderFirstSubmission(evaluateFirstSubmission(ready({ supervisor: "" })))).not.toContain("AFTER IT GOES OUT");
  });

  it("states plainly that there is no rollback, and what to do instead", () => {
    // The moment it is needed is the moment nobody has time to look it up, and
    // the instinct then — send it again — is the harmful one.
    expect(AFTER_SUBMISSION).toMatch(/There is no rollback/);
    expect(AFTER_SUBMISSION).toMatch(/Do not resend/);
    expect(AFTER_SUBMISSION).toMatch(/frequency code 8/);
    expect(AFTER_SUBMISSION).toMatch(/Accepted is not paid/);
  });

  it("prefers a small claim, and says why", () => {
    expect(IDEAL_FIRST_CLAIM.description).toMatch(/tests the PIPE, not the claim/);
  });
});

describe("the dry run", () => {
  const X12 =
    "ISA*00*          *00*          *ZZ*SUB*ZZ*RCV*260115*1200*^*00501*000000001*0*P*:~" +
    "BHT*0019*00*LC-1*20260115*0000*CH~" +
    "NM1*85*2*CLINIC*****XX*1999999984~" +
    "CLM*LC-1*225***11:B:1*Y*A*Y*Y~" +
    "SV1*HC:99214*225*UN*1***1~" +
    "SE*6*0001~";
  const belief = {
    claimRef: "LC-1",
    billingNpi: "1999999984",
    subscriberId: "SYN000111",
    totalCharge: 225,
    serviceDates: ["20260115"],
    procedureCodes: ["99214"],
  };

  it("explains the segments that actually cause rejections", () => {
    const notes = annotateSegments(X12);
    const nm1 = notes.find((n) => n.segment.startsWith("NM1*85"));
    expect(nm1?.risk).toMatch(/commonest hard rejection/);
    const clm = notes.find((n) => n.segment.startsWith("CLM"));
    expect(clm?.risk).toMatch(/frequency code/);
  });

  it("reads values back OUT of the wire rather than trusting the object", () => {
    // The object is what somebody intended; the string is what the payer
    // receives. When they disagree the string wins.
    const diffs = diffAgainstBelief(X12, { ...belief, billingNpi: "1234567893" });
    expect(diffs.find((d) => d.field === "billing NPI")?.onTheWire).toBe("1999999984");
  });

  it("catches a member id that is nowhere on the claim", () => {
    const d = diffAgainstBelief(X12, belief).find((x) => x.field === "member id");
    expect(d?.note).toMatch(/72/);
  });

  it("catches a total that differs from what the system recorded", () => {
    const d = diffAgainstBelief(X12, { ...belief, subscriberId: "", totalCharge: 300 }).find(
      (x) => x.field === "total charge",
    );
    expect(d?.note).toMatch(/every KPI/i);
  });

  it("catches a service that never made it onto the wire", () => {
    const d = diffAgainstBelief(X12, { ...belief, subscriberId: "", procedureCodes: ["99214", "93000"] });
    expect(d.some((x) => x.field === "procedure 93000")).toBe(true);
  });

  it("finds nothing to report when the wire matches", () => {
    const matching = { ...belief, subscriberId: "" };
    expect(diffAgainstBelief(X12, matching)).toEqual([]);
    expect(renderDryRun(X12, matching, [])).toMatch(/wire matches/);
  });

  it("tells the reader to check against something other than the screen", () => {
    // Checking a rendering against itself proves the rendering is consistent.
    expect(renderDryRun(X12, belief, [])).toMatch(/against something other than this screen/);
  });
});

describe("the ledger", () => {
  let dir: string;
  let store: MemoryStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "orion-live-"));
    store = new MemoryStore(path.join(dir, "t.db"));
  });
  afterEach(() => {
    store.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const attempt = (x12: string, over = {}) =>
    recordAttempt(store, {
      claimRef: "LC-1", payer: "Aetna", connector: "stedi", environment: "production",
      supervisor: "Kim R.", chargeAmount: 225, x12, now: T0, ...over,
    });

  it("counts attempts, not successes", () => {
    // A row written only on success would let a crashed submission be retried
    // past the ceiling — precisely the case the ceiling exists for.
    expect(countLiveSubmissions(store)).toBe(0);
    attempt("ISA*ONE~");
    expect(countLiveSubmissions(store)).toBe(1);
  });

  it("recognises an 837 it has already sent", () => {
    attempt("ISA*ONE~");
    const prior = priorSubmissionOf(store, "ISA*ONE~");
    expect(prior?.claimRef).toBe("LC-1");
    expect(priorSubmissionOf(store, "ISA*DIFFERENT~")).toBeNull();
  });

  it("keeps UNKNOWN as its own outcome, distinct from rejected", () => {
    // A timeout is an absence of information about whether the payer received
    // the claim. Recording it as rejected invites exactly the resend that must
    // not happen.
    const id = attempt("ISA*ONE~");
    recordOutcome(store, id, "unknown", "", "gateway timed out after 30s");
    const out = renderLedger(listLiveSubmissions(store));
    expect(out).toMatch(/UNKNOWN outcome/);
    expect(out).toMatch(/checking STATUS/);
    expect(out).toMatch(/creates a duplicate/i);
  });

  it("makes a duplicate send provable", () => {
    attempt("ISA*ONE~");
    attempt("ISA*ONE~", { claimRef: "LC-1-again" });
    expect(renderLedger(listLiveSubmissions(store))).toMatch(/sent MORE THAN ONCE/);
  });

  it("does not cry duplicate over two different claims", () => {
    attempt("ISA*ONE~");
    attempt("ISA*TWO~", { claimRef: "LC-2" });
    expect(renderLedger(listLiveSubmissions(store))).not.toMatch(/MORE THAN ONCE/);
  });

  it("digests the content, so the same claim hashes the same", () => {
    expect(digestOf("ISA*ONE~")).toBe(digestOf("ISA*ONE~"));
    expect(digestOf("ISA*ONE~")).not.toBe(digestOf("ISA*TWO~"));
  });

  it("says plainly when nothing has ever been sent", () => {
    expect(renderLedger([])).toMatch(/No live submissions/);
  });
});
