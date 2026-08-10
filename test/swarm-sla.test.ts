import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.js";
import { STAGE_SLA, escalate, renderEscalations, slaVerdict, ymdToMs, type BoardItem } from "../src/swarm/sla.js";
import { dwellTimes, loadRuns, recordTransition } from "../src/swarm/runs.js";

// `now` is a literal everywhere. A filing deadline computed against the system
// clock is a test that passes in March and fails in December.

const NOW = Date.UTC(2026, 5, 1); // 1 June 2026
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function item(over: Partial<BoardItem> = {}): BoardItem {
  return {
    id: "b1",
    claimRef: "CLM-1042",
    payer: "Aetna",
    stage: "coding",
    amount: 225,
    attempts: 0,
    lastError: "",
    updatedAt: NOW - HOUR,
    ...over,
  };
}

describe("stage targets", () => {
  it("gives every target a rationale", () => {
    // A target with no reasoning behind it gets tuned to whatever hides the
    // problem the first time somebody finds the dashboard embarrassing.
    for (const s of Object.values(STAGE_SLA)) expect(s!.rationale.length).toBeGreaterThan(30);
  });

  it("gives machine stages tighter targets than human ones", () => {
    // A person has a queue; a function call does not. Four hours in `coded`
    // means the pipeline is not running, and it should not read the same as a
    // coder having a busy Tuesday.
    expect(STAGE_SLA.coded!.targetHours).toBeLessThan(STAGE_SLA.coding!.targetHours);
  });

  it("gives the payer's own stage the longest target", () => {
    expect(STAGE_SLA.submitted!.targetHours).toBeGreaterThan(STAGE_SLA.scrubbing!.targetHours);
  });
});

describe("slaVerdict", () => {
  it("is on time inside the target", () => {
    expect(slaVerdict(item({ updatedAt: NOW - 2 * HOUR }), NOW).status).toBe("on_time");
  });

  it("warns before it breaches, not only after", () => {
    // A two-valued verdict is a rubber stamp: the items worth working today —
    // the ones about to go — read the same as the ones filed this morning.
    const v = slaVerdict(item({ stage: "coding", updatedAt: NOW - 40 * HOUR }), NOW);
    expect(v.status).toBe("at_risk");
  });

  it("breaches past the target and quotes both numbers", () => {
    const v = slaVerdict(item({ stage: "coding", updatedAt: NOW - 60 * HOUR }), NOW);
    expect(v.status).toBe("breached");
    expect(v.reason).toContain("60h");
    expect(v.reason).toContain("48h");
  });

  it("says so plainly when a stage has no target rather than inventing one", () => {
    const v = slaVerdict(item({ stage: "closed", updatedAt: NOW - 5000 * HOUR }), NOW);
    expect(v.status).toBe("on_time");
    expect(v.reason).toMatch(/No service target/);
  });
});

describe("the filing window, which outranks everything internal", () => {
  const filing = (dosDaysAgo: number, over: Partial<BoardItem> = {}) =>
    item({ serviceDate: new Date(NOW - dosDaysAgo * DAY).toISOString().slice(0, 10).replace(/-/g, ""), filingLimitDays: 90, ...over });

  it("counts down the days left to file", () => {
    const v = slaVerdict(filing(60), NOW);
    expect(v.filingDaysLeft).toBe(30);
  });

  it("raises a claim inside two weeks of its deadline even when the stage is fine", () => {
    // The stage clock says one hour. The filing clock says ten days. The second
    // is the one that costs money, and it must win.
    const v = slaVerdict(filing(80, { updatedAt: NOW - HOUR }), NOW);
    expect(v.status).toBe("at_risk");
    expect(v.filingIsBinding).toBe(true);
    expect(v.reason).toMatch(/filing window, not the stage target/);
  });

  it("says a closed window is not appealable on the merits", () => {
    const v = slaVerdict(filing(120), NOW);
    expect(v.status).toBe("breached");
    expect(v.reason).toMatch(/TIMELY FILING WINDOW HAS CLOSED/);
    // The sentence that stops somebody filing it anyway and expecting to win.
    expect(v.reason).toMatch(/not appealable on the merits/);
  });

  it("stops applying the filing clock once the claim is filed", () => {
    const v = slaVerdict(filing(120, { stage: "submitted", updatedAt: NOW - HOUR }), NOW);
    expect(v.filingIsBinding).toBe(false);
    expect(v.status).toBe("on_time");
  });

  it("still applies it to a clearinghouse REJECTION, which was never filed", () => {
    // The trap: a rejection looks like a submission to everyone who did not
    // read the 277CA. The claim never reached the payer and the clock never
    // stopped.
    const v = slaVerdict(filing(85, { stage: "rejected", updatedAt: NOW - HOUR }), NOW);
    expect(v.filingIsBinding).toBe(true);
  });

  it("says nothing about filing when the date of service or the limit is unknown", () => {
    expect(slaVerdict(item({ serviceDate: "20260101" }), NOW).filingDaysLeft).toBeNull();
    expect(slaVerdict(item({ filingLimitDays: 90 }), NOW).filingDaysLeft).toBeNull();
    expect(ymdToMs("not-a-date")).toBeNull();
  });
});

describe("escalation order", () => {
  it("puts money first inside an urgency band, not age", () => {
    // A board sorted by age puts a $40 copay above a $9,000 surgical claim, and
    // whoever works the top of that list is being misled about their morning.
    const small = item({ id: "s", claimRef: "SMALL", amount: 40, stage: "coding", updatedAt: NOW - 200 * HOUR });
    const large = item({ id: "l", claimRef: "LARGE", amount: 9000, stage: "coding", updatedAt: NOW - 60 * HOUR });
    const out = escalate([small, large], NOW);
    expect(out[0].verdict.item.claimRef).toBe("LARGE");
  });

  it("puts a closed filing window above everything else", () => {
    const rich = item({ id: "r", claimRef: "RICH", amount: 50_000, stage: "coding", updatedAt: NOW - 200 * HOUR });
    const doomed = item({
      id: "d", claimRef: "DOOMED", amount: 100, stage: "coding", updatedAt: NOW - HOUR,
      serviceDate: new Date(NOW - 200 * DAY).toISOString().slice(0, 10).replace(/-/g, ""), filingLimitDays: 90,
    });
    // Nothing else on the list is unrecoverable. This one is.
    expect(escalate([rich, doomed], NOW)[0].verdict.item.claimRef).toBe("DOOMED");
  });

  it("raises an item carrying an error even when its stage clock is fine", () => {
    const out = escalate([item({ lastError: "payer portal login failed", attempts: 3, updatedAt: NOW - HOUR })], NOW);
    expect(out).toHaveLength(1);
  });

  it("leaves healthy items off the list entirely", () => {
    expect(escalate([item({ updatedAt: NOW - HOUR })], NOW)).toEqual([]);
    expect(renderEscalations([])).toMatch(/Nothing on the board/);
  });

  it("totals the money and repeats the error where somebody will read it", () => {
    const out = renderEscalations(
      escalate([item({ amount: 1200, lastError: "portal timeout", attempts: 2, updatedAt: NOW - HOUR })], NOW),
    );
    expect(out).toContain("1200.00");
    expect(out).toContain("portal timeout");
  });
});

describe("the run log, and replay safety", () => {
  let dir: string;
  let store: MemoryStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "orion-runs-"));
    store = new MemoryStore(path.join(dir, "t.db"));
  });
  afterEach(() => {
    store.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const req = (over = {}) => ({
    itemId: "b1", claimRef: "CLM-1042", from: "coded" as const, to: "scrubbing" as const,
    actor: "scrubber", automated: true, ...over,
  });

  it("records a legal transition", () => {
    const r = recordTransition(store, req(), NOW);
    expect(r.applied).toBe(true);
    expect(loadRuns(store, "b1")).toHaveLength(1);
  });

  it("does NOTHING on a replay, and says why", () => {
    // The defect this prevents is invisible: apply the same advance twice and a
    // naive implementation moves the claim onwards, so it skips the scrub and
    // still looks like a claim — just further along than it earned.
    expect(recordTransition(store, req(), NOW).applied).toBe(true);
    const second = recordTransition(store, req(), NOW + 5000);
    expect(second.applied).toBe(false);
    expect(second.why).toMatch(/replay/);
    expect(loadRuns(store, "b1")).toHaveLength(1);
  });

  it("allows a genuine second pass when the caller says it is one", () => {
    // Denied, reworked, resubmitted. Legitimate — and it has to be declared
    // rather than guessed, because guessing is how a replay slips through.
    expect(recordTransition(store, req(), NOW).applied).toBe(true);
    expect(recordTransition(store, req({ key: "rework-2" }), NOW + 5000).applied).toBe(true);
    expect(loadRuns(store, "b1")).toHaveLength(2);
  });

  it("refuses a transition the stage machine does not allow", () => {
    const r = recordTransition(store, req({ from: "captured", to: "paid" }), NOW);
    expect(r.applied).toBe(false);
    expect(r.why).toMatch(/does not advance/);
    expect(loadRuns(store, "b1")).toHaveLength(0);
  });

  it("computes where the time actually went", () => {
    // The board's updated_at only knows the CURRENT stage. This answers "where
    // is the time going", which no single row can.
    recordTransition(store, req({ from: "captured", to: "coding" }), NOW);
    recordTransition(store, req({ from: "coding", to: "coded" }), NOW + 10 * HOUR);
    recordTransition(store, req({ from: "coded", to: "scrubbing" }), NOW + 12 * HOUR);
    const d = dwellTimes(loadRuns(store, "b1"));
    expect(d).toEqual([
      { stage: "coding", hours: 10 },
      { stage: "coded", hours: 2 },
    ]);
  });
});
