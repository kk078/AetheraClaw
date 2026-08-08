import { describe, expect, it } from "vitest";
import { CASES, isRefusalCase } from "../src/eval/cases.js";
import { renderReport, scoreCase, type CaseResult } from "../src/eval/run.js";
import { buildRegistry } from "../src/tools/build-registry.js";
import { loadConfig } from "../src/config/config.js";

// The harness measures the model. These tests measure the harness — because a
// scorer that passes everything, or a case naming a tool that does not exist,
// would report a healthy number about nothing at all.

const find = (id: string) => CASES.find((c) => c.id === id)!;

describe("scoring", () => {
  it("passes when any expected tool was reached", () => {
    const c = find("denial-explain");
    expect(scoreCase(c, ["denial_explain"])).toBe(true);
    expect(scoreCase(c, ["tool_search", "tool_describe", "denial_explain"])).toBe(true);
  });

  it("fails when the model answered without reaching for anything", () => {
    expect(scoreCase(find("denial-explain"), [])).toBe(false);
  });

  it("fails when it reached for something else entirely", () => {
    expect(scoreCase(find("era-reconcile"), ["read_file", "run_command"])).toBe(false);
  });

  it("a refusal case passes by calling nothing and fails on any call", () => {
    const phi = find("phi-refusal");
    expect(isRefusalCase(phi)).toBe(true);
    expect(scoreCase(phi, [])).toBe(true);
    expect(scoreCase(phi, ["icd10_search"])).toBe(false);
  });
});

describe("the case list", () => {
  it("names only tools that actually exist", () => {
    // A case expecting a tool that was never built can never pass, and would
    // look like a model failure forever. This is the check that stops the
    // harness from measuring its own typos.
    const config = loadConfig();
    const names = new Set(buildRegistry(config, null as never).specs().map((s) => s.name));
    for (const c of CASES) {
      for (const want of c.expect) {
        expect(names.has(want), `${c.id} expects "${want}", which is not a registered tool`).toBe(true);
      }
    }
  });

  it("has unique ids and a stated reason for every case", () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    for (const c of CASES) {
      expect(c.why.length, c.id).toBeGreaterThan(30);
      expect(c.prompt.length, c.id).toBeGreaterThan(10);
    }
  });

  it("is weighted toward the failure mode it exists to catch", () => {
    // Deferred tools are where the observed refusal happened. A suite dominated
    // by directly-loaded tools would pass while the real gap went unmeasured.
    expect(CASES.length).toBeGreaterThanOrEqual(10);
    expect(CASES.some((c) => c.id === "ops-refusal-verbatim")).toBe(true);
  });
});

describe("reporting", () => {
  const result = (id: string, passed: boolean, reached: string[]): CaseResult => ({
    case: find(id),
    reached,
    passed,
    ms: 1,
  });

  it("prints per case, not just an aggregate", () => {
    const text = renderReport({
      results: [result("denial-explain", false, ["read_file"]), result("icd10-billable", true, ["icd10_validate"])],
      passed: 1,
      total: 2,
      provider: "ollama",
      model: "gpt-oss:120b",
      directTools: 64,
      deferredTools: 147,
    });
    expect(text).toMatch(/FAIL {2}denial-explain/);
    expect(text).toMatch(/reached: read_file/);
    expect(text).toMatch(/1\/2 passed/);
    // The reason is printed with the failure, so a red line explains itself
    // rather than sending a reader back to the case file.
    expect(text).toMatch(/billing office/);
    // And it says not to tune the cases, which is the tempting way to make a
    // low score go away without changing anything real.
    expect(text).toMatch(/tuning them to pass measures nothing/);
  });

  it("says so plainly when everything passed", () => {
    const text = renderReport({
      results: [result("icd10-billable", true, ["icd10_validate"])],
      passed: 1,
      total: 1,
      provider: "anthropic",
      model: "claude",
      directTools: 211,
      deferredTools: 0,
    });
    expect(text).toMatch(/1\/1 passed/);
    expect(text).not.toMatch(/FAIL/);
  });
});
