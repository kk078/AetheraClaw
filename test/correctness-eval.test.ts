import { describe, expect, it } from "vitest";
import {
  CORRECTNESS_CASES,
  renderCorrectness,
  runCorrectness,
  scoreCorrectness,
  type CorrectnessCase,
} from "../src/eval/correctness.js";
import type { ScrubFinding } from "../src/tools/healthcare/finding.js";

// This IS the baseline. The routing eval needs a provider and a key, so it
// cannot gate a pull request; this one runs offline and deterministically, so it
// can — and a rule that silently stops firing fails the build instead of being
// discovered by a payer.

describe("scrubber correctness", () => {
  const report = runCorrectness();

  it("passes every case", () => {
    // The failure output is the point: `renderCorrectness` names which rule was
    // missed and which was raised in error, so a red build reads as "the
    // duplicate-line rule stopped firing" rather than as "14/14 became 13/14".
    expect(renderCorrectness(report)).toContain(`${report.total}/${report.total}`);
    expect(report.passed).toBe(report.total);
  });

  it("has no misses", () => {
    // Scored separately from false alarms on purpose. A miss means a claim goes
    // out with a defect the practice was told it did not have.
    expect(report.missed).toBe(0);
  });

  it("has no false alarms", () => {
    expect(report.falseAlarms).toBe(0);
  });

  it("covers enough cases to be worth calling a baseline", () => {
    expect(report.total).toBeGreaterThanOrEqual(12);
  });

  it("includes negative cases, or recall is free", () => {
    // Without `forbid`, a scrubber that raised every rule on every claim would
    // score 100%.
    expect(CORRECTNESS_CASES.filter((c) => c.forbid.length > 0).length).toBeGreaterThanOrEqual(5);
  });

  it("gives every case a stated intent a reviewer can check", () => {
    for (const c of CORRECTNESS_CASES) expect(c.intent.length).toBeGreaterThan(20);
  });
});

describe("scoreCorrectness", () => {
  const c: CorrectnessCase = {
    id: "x",
    intent: "intent long enough to be a sentence",
    claim: CORRECTNESS_CASES[0].claim,
    expect: ["a"],
    forbid: ["b"],
  };
  const f = (rule: string): ScrubFinding => ({ severity: "error", rule, message: "" });

  it("counts a missing expected rule as a miss", () => {
    const s = scoreCorrectness(c, [f("z")]);
    expect(s.missed).toEqual(["a"]);
    expect(s.passed).toBe(false);
  });

  it("counts a forbidden rule as a false alarm", () => {
    const s = scoreCorrectness(c, [f("a"), f("b")]);
    expect(s.falseAlarms).toEqual(["b"]);
    expect(s.passed).toBe(false);
  });

  it("passes when the expected rule fires and the forbidden one does not", () => {
    expect(scoreCorrectness(c, [f("a")]).passed).toBe(true);
  });

  it("does not double-count a rule raised twice", () => {
    // A claim with two bad service lines raises the same rule per line. That is
    // one finding class, not two, and counting it twice would make coverage
    // look better than it is.
    expect(scoreCorrectness(c, [f("a"), f("a")]).actual).toEqual(["a"]);
  });
});
