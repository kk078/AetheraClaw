import { describe, expect, it } from "vitest";
import {
  STATUS_CATEGORY_276,
  build276,
  categoryInfo,
  parse277,
  readStatus,
  renderStatus,
  type ClaimStatusRequest,
} from "../src/tools/healthcare/x12/276.js";
import { envelope, seg, serializeX12, type Segment } from "../src/tools/healthcare/x12/segments.js";
import {
  CLUSTER_SIZE,
  MIN_APPEAL_SAMPLE,
  overturnRate,
  renderTriage,
  triageAppeals,
  type AppealCandidate,
  type DenialOutcome,
} from "../src/tools/healthcare/appeal-economics.js";

const req = (over: Partial<ClaimStatusRequest> = {}): ClaimStatusRequest => ({
  payerId: "60054",
  payerName: "Aetna",
  providerNpi: "1234567893",
  providerName: "Test Clinic",
  subscriberId: "SYNTH-1",
  patientLast: "Test",
  patientFirst: "Pat",
  claimId: "PCN-0184",
  serviceDateFrom: "20260115",
  ...over,
});

describe("276 build", () => {
  it("carries the claim id as both the trace number and the reference", () => {
    // The payer matches on these; a 276 without them returns "no record" for a
    // claim that is sitting right there.
    const edi = build276(req());
    expect(edi).toMatch(/TRN\*1\*PCN-0184/);
    expect(edi).toMatch(/REF\*1K\*PCN-0184/);
  });

  it("sends a date RANGE only when one was given", () => {
    expect(build276(req())).toMatch(/DTP\*232\*D8\*20260115/);
    expect(build276(req({ serviceDateTo: "20260117" }))).toMatch(/DTP\*232\*RD8\*20260115-20260117/);
  });

  it("uses the claim status functional code, not the claim one", () => {
    expect(build276(req())).toMatch(/GS\*HR\*/);
  });
});

describe("277 parse and read", () => {
  // Built through the project's own envelope rather than hand-written: parseX12
  // reads the segment terminator from character 105, which is only correct when
  // the ISA is a real fixed-length ISA. A short hand-rolled fixture parses as
  // garbage and would have made these tests assert against nothing.
  const wrap = (stc: string, extra: Segment[] = []) =>
    serializeX12(
      envelope({
        senderId: "SENDER",
        receiverId: "RECEIVER",
        controlNumber: "1",
        functionalCode: "HN",
        transactionSetId: "277",
        date: "260115",
        time: "1200",
        body: [
          seg("NM1", "PR", "2", "Aetna"),
          seg("TRN", "2", "PCN-0184"),
          seg("STC", stc, "20260115"),
          seg("REF", "1K", "PAYER-99"),
          ...extra,
        ],
      }),
    );

  it("reads the category and status out of the composite", () => {
    const r = parse277(wrap("P1:20"));
    expect(r.statuses[0].category).toBe("P1");
    expect(r.statuses[0].statusCode).toBe("20");
    expect(r.statuses[0].payerClaimNumber).toBe("PAYER-99");
    expect(r.empty).toBe(false);
  });

  it("takes the FIRST claim-level status, not the last", () => {
    // Payers repeat STC with supplementary codes; letting a later one win
    // replaces the decision with a footnote.
    const r = parse277(wrap("F4:65", [seg("STC", "P1:20", "20260116")]));
    expect(r.statuses[0].category).toBe("F4");
  });

  it("attaches a line status to the line, not to the claim", () => {
    const r = parse277(wrap("P1:20", [seg("SVC", "HC:99214", "225"), seg("STC", "F4:65", "20260115")]));
    expect(r.statuses[0].category).toBe("P1");
    expect(r.statuses[0].lines[0].procedure).toBe("99214");
    expect(r.statuses[0].lines[0].category).toBe("F4");
  });

  it("flags NO RECORD as not-in-adjudication rather than as pending", () => {
    // The whole point of the transaction. A payer that has never heard of the
    // claim is not "processing" it.
    for (const cat of ["D0", "A4", "A7"]) {
      const r = readStatus(parse277(wrap(`${cat}:20`)).statuses[0], "20260115", Date.UTC(2026, 5, 1));
      expect(r.notInAdjudication, cat).toBe(true);
      expect(r.settled, cat).toBe(true);
    }
    const pending = readStatus(parse277(wrap("P1:20")).statuses[0], "20260115", Date.UTC(2026, 5, 1));
    expect(pending.notInAdjudication).toBe(false);
    expect(pending.settled).toBe(false);
  });

  it("computes age from the service date", () => {
    const r = readStatus(parse277(wrap("P1:20")).statuses[0], "20260115", Date.UTC(2026, 0, 25));
    expect(r.ageDays).toBe(10);
  });

  it("says a resubmission is needed, and that filing has been running", () => {
    const readings = [readStatus(parse277(wrap("D0:20")).statuses[0], "20260115", Date.UTC(2026, 5, 1))];
    const out = renderStatus(readings, "Aetna", false);
    expect(out).toMatch(/NOT in adjudication/);
    expect(out).toMatch(/no appeal rights/);
    expect(out).toMatch(/timely_filing_check/);
  });

  it("warns that pending is a status, not a protection", () => {
    const out = renderStatus([readStatus(parse277(wrap("P1:20")).statuses[0], "20260115", Date.now())], "Aetna", false);
    expect(out).toMatch(/Pending is a status, not a protection/);
  });

  it("singles out P3 — the payer is waiting on YOU", () => {
    const out = renderStatus([readStatus(parse277(wrap("P3:20")).statuses[0], "20260115", Date.now())], "Aetna", false);
    expect(out).toMatch(/pending on INFORMATION FROM YOU/);
  });

  it("labels a simulated response on every run", () => {
    const out = renderStatus([readStatus(parse277(wrap("P1:20")).statuses[0], "20260115", Date.now())], "Aetna", true);
    expect(out).toMatch(/SIMULATED RESPONSE/);
  });

  it("distinguishes an unusable answer from 'no record'", () => {
    expect(renderStatus([], "Aetna", false)).toMatch(/not the same as 'no record'/);
  });

  it("declines to explain a category it does not know", () => {
    expect(categoryInfo("ZZ").desc).toMatch(/not in the bundled table/);
    expect(Object.keys(STATUS_CATEGORY_276).length).toBeGreaterThan(15);
  });
});

describe("appeal economics", () => {
  const cand = (over: Partial<AppealCandidate> = {}): AppealCandidate => ({
    id: "w1",
    claimId: "C-1",
    payer: "Aetna",
    carc: "97",
    amountCents: 50_000,
    daysToDeadline: 60,
    ...over,
  });
  const outcomes = (n: number, wins: number, over: Partial<DenialOutcome> = {}): DenialOutcome[] =>
    Array.from({ length: n }, (_, i) => ({ payer: "Aetna", carc: "97", appealed: true, overturned: i < wins, ...over }));

  it("REFUSES to state a rate below the sample floor", () => {
    // An invented win rate would send recoverable money to a write-off pile
    // with a number attached to make it look considered.
    const e = overturnRate(outcomes(MIN_APPEAL_SAMPLE - 1, 5), "Aetna", "97");
    expect(e.rate).toBeNull();
    expect(e.basis).toBe("none");
  });

  it("counts APPEALS FILED, not denials received", () => {
    // Counting never-appealed denials as losses drives every rate to zero and
    // produces a tool that recommends never appealing — self-fulfilling.
    const history = [...outcomes(20, 15), ...Array.from({ length: 500 }, () => ({ payer: "Aetna", carc: "97", appealed: false, overturned: false }))];
    const e = overturnRate(history, "Aetna", "97");
    expect(e.n).toBe(20);
    expect(e.rate).toBeCloseTo(0.75, 5);
  });

  it("backs off payer×CARC → CARC → practice, naming the level each time", () => {
    const otherPayer = outcomes(20, 10, { payer: "Cigna" });
    const e = overturnRate(otherPayer, "Aetna", "97");
    expect(e.basis).toBe("carc");
    expect(e.explain).toMatch(/across all payers/);

    const otherCode = outcomes(20, 10, { payer: "Cigna", carc: "45" });
    expect(overturnRate(otherCode, "Aetna", "97").basis).toBe("practice");
  });

  it("ranks by expected recovery, not by balance", () => {
    // The whole thesis: a big denial nobody wins is worth less than a small one
    // they usually win.
    const history = [...outcomes(20, 2), ...outcomes(20, 18, { carc: "45" })];
    const t = triageAppeals(
      [cand({ claimId: "BIG", carc: "97", amountCents: 400_000 }), cand({ claimId: "SMALL", carc: "45", amountCents: 60_000 })],
      history,
    );
    expect(t.assessments[0].candidate.claimId).toBe("SMALL");
  });

  it("gates on the deadline before any arithmetic", () => {
    const t = triageAppeals([cand({ amountCents: 999_999, daysToDeadline: -1 })], outcomes(20, 18));
    expect(t.assessments[0].recommendation).toBe("deadline_passed");
    expect(t.assessments[0].expectedCents).toBe(0);
  });

  it("treats an UNKNOWN deadline as unknown, not as plenty of time", () => {
    const t = triageAppeals([cand({ daysToDeadline: null })], outcomes(20, 18));
    expect(t.assessments[0].recommendation).not.toBe("deadline_passed");
  });

  it("NEVER recommends a write-off, even below the cost of the work", () => {
    const t = triageAppeals([cand({ amountCents: 100 })], outcomes(20, 2));
    expect(t.assessments[0].recommendation).toBe("below_cost_check_cluster");
    expect(t.assessments[0].why).toMatch(/does not recommend write-offs/);
    expect(renderTriage(t)).not.toMatch(/write (this|it) off/i);
  });

  it("surfaces a cluster of small denials rather than burying them", () => {
    // Forty $60 denials sharing one CARC are one upstream fault, and a ranking
    // by per-claim value would put them last.
    const many = Array.from({ length: CLUSTER_SIZE + 3 }, (_, i) => cand({ id: `w${i}`, claimId: `C-${i}`, amountCents: 6_000 }));
    const t = triageAppeals(many, outcomes(20, 2));
    expect(t.clusters).toHaveLength(1);
    expect(t.clusters[0].count).toBe(CLUSTER_SIZE + 3);
    expect(t.assessments[0].why).toMatch(/part of a cluster/);
    expect(renderTriage(t)).toMatch(/upstream fault/);
  });

  it("marks a recommendation built on a fallback level as thin", () => {
    const t = triageAppeals([cand()], outcomes(20, 18, { payer: "Cigna" }));
    expect(t.assessments[0].recommendation).toBe("appeal_thin_evidence");
    expect(t.assessments[0].why).toMatch(/rather than from this payer's own record/);
  });

  it("says nothing at all when there is no history", () => {
    const t = triageAppeals([cand()], []);
    expect(t.assessments[0].recommendation).toBe("no_recommendation");
    expect(t.assessments[0].expectedCents).toBeNull();
    expect(renderTriage(t)).toMatch(/NO RECOMMENDATION/);
  });

  it("makes the cost of an appeal visible, because it decides the ranking", () => {
    expect(renderTriage(triageAppeals([cand()], outcomes(20, 18)))).toMatch(/an input, not an estimate/);
  });
});
