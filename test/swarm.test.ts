import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_STAGES,
  STAGES,
  TRANSITIONS,
  findTransition,
  isCheckpoint,
  mayAutomate,
  transitionsFrom,
  type Stage,
  type SwarmMode,
} from "../src/swarm/stages.js";
import {
  DEFAULT_LIMITS,
  clusterFailures,
  failureSignature,
  planDispatch,
  renderPlan,
  type BlackboardItem,
} from "../src/swarm/dispatch.js";

const MODES: SwarmMode[] = ["off", "assist", "autopilot-with-checkpoints"];

function item(over: Partial<BlackboardItem> = {}): BlackboardItem {
  return {
    id: "bb_1",
    claimRef: "CLM-1",
    payer: "Medicare",
    stage: "captured",
    attempts: 0,
    lastError: "",
    amountCents: 25000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

// ── The pipeline itself ──────────────────────────────────────────────────────

describe("stage table", () => {
  it("gives every stage a spec keyed by its own name", () => {
    for (const [key, spec] of Object.entries(STAGES)) expect(spec.stage).toBe(key);
  });

  it("only names stages that exist on either end of a transition", () => {
    for (const t of TRANSITIONS) {
      expect(STAGES[t.from]).toBeDefined();
      expect(STAGES[t.to]).toBeDefined();
    }
  });

  it("leaves no non-terminal stage without somewhere to go", () => {
    for (const [stage, spec] of Object.entries(STAGES) as [Stage, (typeof STAGES)[Stage]][]) {
      if (spec.terminal) expect(transitionsFrom(stage)).toHaveLength(0);
      else expect(transitionsFrom(stage).length).toBeGreaterThan(0);
    }
  });

  it("reaches every stage from captured", () => {
    const seen = new Set<Stage>(["captured"]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const t of TRANSITIONS) {
        if (seen.has(t.from) && !seen.has(t.to)) {
          seen.add(t.to);
          changed = true;
        }
      }
    }
    expect([...Object.keys(STAGES)].filter((s) => !seen.has(s as Stage))).toEqual([]);
  });

  it("finds a transition only in the direction it is declared", () => {
    expect(findTransition("captured", "coding")).toBeDefined();
    expect(findTransition("coding", "captured")).toBeUndefined();
    expect(findTransition("captured", "paid")).toBeUndefined();
  });
});

describe("human checkpoints", () => {
  it("never lets a person-required transition be automated, in any mode", () => {
    for (const t of TRANSITIONS.filter((x) => x.requiresHuman)) {
      for (const mode of MODES) expect(mayAutomate(t, mode)).toBe(false);
    }
  });

  it("stops for a person on every move that sends something out or moves money", () => {
    const required = TRANSITIONS.filter((t) => t.requiresHuman).map((t) => `${t.from}->${t.to}`);
    // Submitting a claim and sending an appeal leave the practice under the
    // practice's name; writing off or abandoning a denial gives up money.
    expect(required).toContain("ready_to_submit->submitted");
    expect(required).toContain("appeal_drafted->submitted");
    expect(required).toContain("denied->closed");
    expect(required).toContain("appeal_drafted->closed");
    // Code selection is the coder's legal responsibility, not the swarm's.
    expect(required).toContain("coding->coded");
  });

  it("counts a stage as a checkpoint only when every way out needs a person", () => {
    // Every exit needs a person.
    expect(isCheckpoint("ready_to_submit")).toBe(true);
    expect(isCheckpoint("coding")).toBe(true);
    // denied -> appeal_drafted does not, so the stage as a whole is not a stop.
    expect(isCheckpoint("denied")).toBe(false);
    // Terminal stages have no exits at all — vacuously "every" would be true,
    // which would report Paid as something waiting on a person.
    expect(isCheckpoint("paid")).toBe(false);
    expect(isCheckpoint("closed")).toBe(false);
    expect(CHECKPOINT_STAGES).not.toContain("paid");
  });

  it("advertises exactly the stages that are checkpoints", () => {
    const computed = (Object.keys(STAGES) as Stage[]).filter(isCheckpoint);
    expect(CHECKPOINT_STAGES).toEqual(computed);
    expect(CHECKPOINT_STAGES.length).toBeGreaterThan(0);
  });
});

describe("mayAutomate", () => {
  const ordinary = findTransition("captured", "coding")!;

  it("takes nothing when the swarm is off", () => {
    expect(mayAutomate(ordinary, "off")).toBe(false);
  });

  it("names but does not take in assist mode", () => {
    expect(mayAutomate(ordinary, "assist")).toBe(false);
  });

  it("takes ordinary steps in autopilot", () => {
    expect(mayAutomate(ordinary, "autopilot-with-checkpoints")).toBe(true);
  });
});

// ── Failure clustering ───────────────────────────────────────────────────────

describe("failureSignature", () => {
  it("treats the same failure on different claims as one shape", () => {
    expect(failureSignature("Claim CLM-10231 rejected: payer id missing")).toBe(
      failureSignature("Claim CLM-99887 rejected: payer id missing"),
    );
  });

  it("does not collapse genuinely different failures", () => {
    expect(failureSignature("payer id missing")).not.toBe(failureSignature("taxonomy code missing"));
  });

  it("ignores dollar amounts, dates and bare numbers", () => {
    expect(failureSignature("underpaid by $1,204.50 on 20260401")).toBe(
      failureSignature("underpaid by $87.00 on 20251117"),
    );
    expect(failureSignature("line 3 unbalanced")).toBe(failureSignature("line 11 unbalanced"));
  });

  it("ignores case and runs of whitespace", () => {
    expect(failureSignature("  Payer   ID  MISSING ")).toBe(failureSignature("payer id missing"));
  });

  it("bounds the signature so one enormous error cannot dominate", () => {
    expect(failureSignature("x".repeat(500)).length).toBeLessThanOrEqual(160);
  });
});

describe("clusterFailures", () => {
  it("ignores items that have not failed", () => {
    expect(clusterFailures([item(), item({ claimRef: "CLM-2", lastError: "   " })])).toEqual([]);
  });

  it("counts distinct claims, not retries of one claim", () => {
    // One claim retried is one problem. Counting attempts would halt a whole
    // run because a single stubborn claim was tried three times.
    const clusters = clusterFailures([
      item({ id: "a", claimRef: "CLM-1", lastError: "payer id missing" }),
      item({ id: "b", claimRef: "CLM-1", lastError: "payer id missing" }),
      item({ id: "c", claimRef: "CLM-1", lastError: "payer id missing" }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(1);
    expect(clusters[0].claimRefs).toEqual(["CLM-1"]);
  });

  it("groups the same failure across different claims", () => {
    const clusters = clusterFailures([
      item({ claimRef: "CLM-1", lastError: "Claim CLM-1 rejected: taxonomy missing" }),
      item({ claimRef: "CLM-2", lastError: "Claim CLM-2 rejected: taxonomy missing" }),
      item({ claimRef: "CLM-3", lastError: "something else entirely" }),
    ]);
    expect(clusters[0].count).toBe(2);
    expect(clusters[0].claimRefs).toEqual(["CLM-1", "CLM-2"]);
  });

  it("puts the widest cluster first", () => {
    const clusters = clusterFailures([
      item({ claimRef: "CLM-1", lastError: "rare thing" }),
      item({ claimRef: "CLM-2", lastError: "common thing" }),
      item({ claimRef: "CLM-3", lastError: "common thing" }),
    ]);
    expect(clusters.map((c) => c.count)).toEqual([2, 1]);
  });
});

// ── Dispatch planning ────────────────────────────────────────────────────────

const AUTO: SwarmMode = "autopilot-with-checkpoints";

describe("planDispatch", () => {
  it("advances ordinary work in autopilot", () => {
    const plan = planDispatch([item({ stage: "captured" })], AUTO);
    expect(plan.halted).toBe(false);
    expect(plan.automatable).toHaveLength(1);
    expect(plan.automatable[0].role).toBe("coder");
    expect(plan.automatable[0].tool).toBe("superbill_build");
  });

  it("routes a checkpoint stage to a person even in autopilot", () => {
    const plan = planDispatch([item({ stage: "ready_to_submit" })], AUTO);
    expect(plan.automatable).toHaveLength(0);
    expect(plan.needingHuman).toHaveLength(1);
    expect(plan.planned[0].decision).toBe("needs_human");
    expect(plan.planned[0].role).toBe("human");
  });

  it("distinguishes work blocked by mode from work waiting on a person", () => {
    const board = [item({ claimRef: "CLM-1", stage: "captured" }), item({ claimRef: "CLM-2", stage: "coding" })];
    for (const mode of ["off", "assist"] as SwarmMode[]) {
      const plan = planDispatch(board, mode);
      const decisions = Object.fromEntries(plan.planned.map((p) => [p.item.claimRef, p.decision]));
      // Turning the swarm off does not turn a coder's decision into a mode problem.
      expect(decisions["CLM-1"]).toBe("blocked_by_mode");
      expect(decisions["CLM-2"]).toBe("needs_human");
      expect(plan.automatable).toHaveLength(0);
    }
  });

  it("advances nothing at all when the swarm is off", () => {
    const board = (Object.keys(STAGES) as Stage[]).map((stage, i) =>
      item({ id: `bb_${i}`, claimRef: `CLM-${i}`, stage }),
    );
    expect(planDispatch(board, "off").automatable).toHaveLength(0);
    expect(planDispatch(board, "assist").automatable).toHaveLength(0);
    expect(planDispatch(board, AUTO).automatable.length).toBeGreaterThan(0);
  });

  it("leaves terminal claims alone", () => {
    const plan = planDispatch([item({ stage: "paid" }), item({ claimRef: "CLM-2", stage: "closed" })], AUTO);
    expect(plan.planned.map((p) => p.decision)).toEqual(["terminal", "terminal"]);
    expect(plan.automatable).toHaveLength(0);
    expect(plan.needingHuman).toHaveLength(0);
  });

  it("parks a claim that has hit the attempt limit rather than trying again", () => {
    const plan = planDispatch(
      [item({ stage: "coded", attempts: DEFAULT_LIMITS.maxAttemptsPerItem, lastError: "scrub crashed" })],
      AUTO,
    );
    expect(plan.planned[0].decision).toBe("parked_max_attempts");
    expect(plan.planned[0].role).toBe("human");
    expect(plan.planned[0].reason).toContain("scrub crashed");
    expect(plan.parked).toHaveLength(1);
    // Parked work is waiting on a person, so it must not read as merely idle.
    expect(plan.needingHuman).toHaveLength(1);
  });

  it("still advances a claim one attempt short of the limit", () => {
    const plan = planDispatch(
      [item({ stage: "coded", attempts: DEFAULT_LIMITS.maxAttemptsPerItem - 1, lastError: "transient" })],
      AUTO,
    );
    expect(plan.planned[0].decision).toBe("automate");
  });

  it("halts the whole run when several claims fail the same way", () => {
    const board = ["CLM-1", "CLM-2", "CLM-3"].map((claimRef, i) =>
      item({ id: `bb_${i}`, claimRef, stage: "coded", lastError: `Claim ${claimRef} rejected: payer id missing` }),
    );
    const plan = planDispatch(board, AUTO);
    expect(plan.halted).toBe(true);
    expect(plan.automatable).toHaveLength(0);
    // Nothing is planned either: the halt happens before any decision is made,
    // so a caller cannot walk the plan and advance items anyway.
    expect(plan.planned).toHaveLength(0);
    expect(plan.haltReason).toContain("CLM-1");
    expect(plan.haltReason).toContain("3 different claims");
  });

  it("does not halt on one claim that has failed repeatedly", () => {
    const board = [
      item({ id: "a", claimRef: "CLM-1", stage: "coded", attempts: 2, lastError: "payer id missing" }),
      item({ id: "b", claimRef: "CLM-2", stage: "coded", lastError: "unrelated" }),
    ];
    expect(planDispatch(board, AUTO).halted).toBe(false);
  });

  it("halts regardless of mode, since the plan is what gets shown either way", () => {
    const board = ["CLM-1", "CLM-2", "CLM-3"].map((claimRef, i) =>
      item({ id: `bb_${i}`, claimRef, stage: "coded", lastError: "payer id missing" }),
    );
    for (const mode of MODES) expect(planDispatch(board, mode).halted).toBe(true);
  });

  it("works the oldest claims first so nothing starves", () => {
    const board = [
      item({ id: "a", claimRef: "NEW", updatedAt: 3000 }),
      item({ id: "b", claimRef: "OLD", updatedAt: 1000 }),
      item({ id: "c", claimRef: "MID", updatedAt: 2000 }),
    ];
    expect(planDispatch(board, AUTO).planned.map((p) => p.item.claimRef)).toEqual(["OLD", "MID", "NEW"]);
  });

  it("reports the claims beyond the run limit instead of dropping them", () => {
    const board = Array.from({ length: 5 }, (_, i) =>
      item({ id: `bb_${i}`, claimRef: `CLM-${i}`, updatedAt: 1000 + i }),
    );
    const plan = planDispatch(board, AUTO, { ...DEFAULT_LIMITS, maxItems: 2 });
    expect(plan.automatable).toHaveLength(2);
    // A queue that quietly stops at the cap looks exactly like a queue that finished.
    expect(plan.planned).toHaveLength(5);
    expect(plan.planned.filter((p) => p.decision === "over_item_limit")).toHaveLength(3);
  });

  it("does not spend the run limit on claims it was never going to touch", () => {
    // Terminal and checkpoint claims are decided before the cap is consulted,
    // so a board full of paid claims still leaves room for real work.
    const board = [
      ...Array.from({ length: 10 }, (_, i) =>
        item({ id: `p${i}`, claimRef: `PAID-${i}`, stage: "paid" as Stage, updatedAt: 1000 + i }),
      ),
      item({ id: "w", claimRef: "WORK", stage: "captured", updatedAt: 2000 }),
    ];
    const plan = planDispatch(board, AUTO, { ...DEFAULT_LIMITS, maxItems: 2 });
    expect(plan.automatable.map((p) => p.item.claimRef)).toEqual(["WORK"]);
  });

  it("plans an empty board without complaint", () => {
    const plan = planDispatch([], AUTO);
    expect(plan.halted).toBe(false);
    expect(plan.planned).toEqual([]);
  });
});

// ── Rendering ────────────────────────────────────────────────────────────────

describe("renderPlan", () => {
  it("says only why it halted, and nothing about what it would have done", () => {
    const board = ["CLM-1", "CLM-2", "CLM-3"].map((claimRef, i) =>
      item({ id: `bb_${i}`, claimRef, lastError: "payer id missing" }),
    );
    const text = renderPlan(planDispatch(board, AUTO));
    expect(text).toContain("Halted before doing anything");
    expect(text).not.toContain("Would advance");
  });

  it("shows stage totals in dollars", () => {
    const text = renderPlan(planDispatch([item({ stage: "coded", amountCents: 123_45 })], AUTO));
    expect(text).toContain("$123.45");
    expect(text).toContain("Coded");
  });

  it("names the parked claims explicitly", () => {
    const text = renderPlan(
      planDispatch([item({ claimRef: "CLM-STUCK", stage: "coded", attempts: 3, lastError: "boom" })], AUTO),
    );
    expect(text).toContain("Parked after repeated failures");
    expect(text).toContain("CLM-STUCK");
  });

  it("says outright when nothing can move on its own", () => {
    expect(renderPlan(planDispatch([item({ stage: "ready_to_submit" })], AUTO))).toContain(
      "Nothing advances on its own",
    );
  });

  it("explains the mode when the mode is what is holding work back", () => {
    expect(renderPlan(planDispatch([item({ stage: "captured" })], "assist"))).toContain("assist mode");
    expect(renderPlan(planDispatch([item({ stage: "captured" })], "off"))).toContain("if the swarm were enabled");
  });

  it("tells the reader the overflow claims are still there", () => {
    const board = Array.from({ length: 4 }, (_, i) => item({ id: `bb_${i}`, claimRef: `CLM-${i}`, updatedAt: 1000 + i }));
    const text = renderPlan(planDispatch(board, AUTO, { ...DEFAULT_LIMITS, maxItems: 2 }), {
      ...DEFAULT_LIMITS,
      maxItems: 2,
    });
    expect(text).toContain("beyond this run's limit of 2");
    expect(text).toContain("run again");
  });

  it("handles an empty board", () => {
    expect(renderPlan(planDispatch([], AUTO))).toBe("Nothing on the board.");
  });
});
