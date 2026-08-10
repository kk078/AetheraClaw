import { describe, expect, it } from "vitest";
import { routeTools, scoreTools } from "../src/agent/tool-router.js";
import { selectTools } from "../src/tools/profiles.js";
import type { ToolSpec } from "../src/providers/types.js";

// The failure this exists to stop, stated once: a model asked about CARC 197
// that was not given denial_explain does not say "I am missing a tool". It
// answers from memory — fluently, confidently, and from exactly the recall this
// product replaces. The deferral is invisible to the user AND to the model's
// own sense of certainty, so the only defence is giving it the right tools.

const spec = (name: string, description = ""): ToolSpec => ({
  name,
  description,
  inputSchema: { type: "object", properties: {} },
});

const CATALOGUE: ToolSpec[] = [
  spec("denial_explain", "Resolve a CARC or RARC code and give the remediation path."),
  spec("appeal_draft", "Draft an appeal letter for a denied claim."),
  spec("era_parse_835", "Parse an 835 remittance advice."),
  spec("ncci_check", "Check a code pair against the NCCI edit tables."),
  spec("em_calculate", "Compute the evaluation and management level from documentation."),
  spec("wrvu_report", "Work RVU productivity by rendering provider."),
  spec("forecast_cash", "Project cash collections forward."),
  spec("icd10_lookup", "Look up an ICD-10-CM diagnosis code."),
  spec("filing_deadline_check", "Whether a claim is still inside its timely filing window."),
  spec("portal_login", "Sign in to a payer portal."),
  spec("worklist_next", "The next item to work, prioritised."),
  spec("audit_verify", "Verify the tamper-evident audit chain."),
  // The catalogue tools. With these loaded, overflow is DEFERRED — still
  // reachable through tool_search. Without them the same overflow is genuinely
  // DROPPED, and profiles.ts says so loudly. The deployed registry always has
  // them, so the tests use the deployed shape.
  spec("tool_search", "Search every tool, including the ones not loaded this turn."),
  spec("tool_invoke", "Call a tool that was not loaded directly."),
];

describe("scoreTools", () => {
  it("puts the denial tools first for a denial question", () => {
    const ranked = scoreTools("I got CARC 197 on a claim. What is it and what do I do?", CATALOGUE);
    expect(ranked[0].name).toMatch(/denial|appeal/);
    expect(ranked.slice(0, 3).map((r) => r.name)).toContain("denial_explain");
  });

  it("bridges the vocabulary gap — 'timely filing' finds filing_deadline_check", () => {
    // A biller says "timely filing"; the tool is called filing_deadline_check.
    // Without the domain hints, lexical matching finds neither word in the
    // other, which is the whole reason that table exists.
    const ranked = scoreTools("Is this claim past the deadline for timely filing?", CATALOGUE);
    expect(ranked[0].name).toBe("filing_deadline_check");
  });

  it("ranks by what was asked, not by registration order", () => {
    const remit = scoreTools("Post this 835 remittance and tell me the allowed amount", CATALOGUE);
    const coding = scoreTools("What E/M level does this documentation support?", CATALOGUE);
    expect(remit[0].name).toBe("era_parse_835");
    expect(coding[0].name).toBe("em_calculate");
    // The same catalogue, two questions, two different answers — which is the
    // entire point.
    expect(remit[0].name).not.toBe(coding[0].name);
  });

  it("is deterministic, including the tiebreak", () => {
    // Two identical questions must get identical capability. Sorting by score
    // alone leaves equal-scoring tools in registry order, which reintroduces
    // the arbitrariness this function removes.
    const a = scoreTools("hello there", CATALOGUE).map((t) => t.name);
    const b = scoreTools("hello there", CATALOGUE).map((t) => t.name);
    expect(a).toEqual(b);
  });

  it("scores nothing for a message with no signal", () => {
    expect(scoreTools("hello", CATALOGUE).every((t) => t.score === 0)).toBe(true);
  });
});

describe("routeTools", () => {
  it("promotes nothing when the message carries no signal", () => {
    // Loading ten unrelated tools because somebody said "hello" spends the
    // budget on noise; the base set already covers the general case.
    expect(routeTools(CATALOGUE, { message: "hello" })).toEqual([]);
  });

  it("puts pinned tools first, ahead of anything scored", () => {
    const out = routeTools(CATALOGUE, { message: "CARC 197 denial", pinned: ["audit_verify"] });
    expect(out[0]).toBe("audit_verify");
    expect(out).toContain("denial_explain");
  });

  it("ignores a pin for a tool that does not exist", () => {
    // A stale pin from an older session must not occupy a slot that a real
    // tool could have used.
    expect(routeTools(CATALOGUE, { message: "denial", pinned: ["no_such_tool"] })).not.toContain("no_such_tool");
  });

  it("never lists the same tool twice", () => {
    const out = routeTools(CATALOGUE, { message: "denial appeal", pinned: ["denial_explain"] });
    expect(new Set(out).size).toBe(out.length);
  });

  it("respects take", () => {
    expect(routeTools(CATALOGUE, { message: "denial appeal 835 ncci icd", take: 2 })).toHaveLength(2);
  });
});

describe("selectTools with a hint — the part that reaches the model", () => {
  // A cap small enough to force a choice, which is the situation on the default
  // provider every single turn.
  const CAP = 4;

  it("loads the tools the question needs, and defers the rest", () => {
    const withHint = selectTools(CATALOGUE, "all", "ollama", CAP, {
      hint: "I got CARC 197 on a claim, what do I do?",
    });
    const names = withHint.specs.map((s) => s.name);
    expect(names).toContain("denial_explain");
    // And the unrelated ones are deferred rather than lost — still reachable
    // through tool_search.
    expect(withHint.deferred.length).toBeGreaterThan(0);
    expect(withHint.droppedByLimit).toEqual([]);
  });

  it("changes what is loaded when the question changes", () => {
    const denial = selectTools(CATALOGUE, "all", "ollama", CAP, { hint: "CARC 197 denial" });
    const coding = selectTools(CATALOGUE, "all", "ollama", CAP, { hint: "What E/M level is supported?" });
    expect(denial.specs.map((s) => s.name)).toContain("denial_explain");
    expect(coding.specs.map((s) => s.name)).toContain("em_calculate");
    expect(denial.specs.map((s) => s.name)).not.toEqual(coding.specs.map((s) => s.name));
  });

  it("behaves exactly as before with no hint", () => {
    // The default path is unchanged, so an install that never passes a hint
    // gets the behaviour it had.
    const a = selectTools(CATALOGUE, "all", "ollama", CAP);
    const b = selectTools(CATALOGUE, "all", "ollama", CAP, {});
    expect(a.specs.map((s) => s.name)).toEqual(b.specs.map((s) => s.name));
  });

  it("never loses a tool — deferred plus loaded is always the whole catalogue", () => {
    // The router RANKS, it does not filter. Anything it does not promote is
    // still reachable; if that ever stopped being true the model would lose
    // capability silently, which is worse than the problem being solved.
    for (const hint of ["CARC 197", "E/M level", "hello", ""]) {
      const sel = selectTools(CATALOGUE, "all", "ollama", CAP, { hint });
      const reachable = new Set([...sel.specs.map((s) => s.name), ...sel.deferred]);
      expect(reachable.size, hint).toBe(CATALOGUE.length);
      // Nothing may be DROPPED: dropped means no route back, and losing
      // capability silently is worse than the problem being solved.
      expect(sel.droppedByLimit, hint).toEqual([]);
    }
  });
});
