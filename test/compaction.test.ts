import { describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../src/providers/types.js";
import { compactHistory, extractFacts, planCompaction, renderSummary } from "../src/agent/compaction.js";

// What compaction has to preserve is not "the gist". It is the handful of facts
// a billing conversation refers back to for the rest of its life: which claim,
// which payer, which codes, what was already run, and what already failed.
// Everything here tests one of those.

const user = (t: string): NormalizedMessage => ({ role: "user", content: [{ type: "text", text: t }] });
const asst = (t: string): NormalizedMessage => ({ role: "assistant", content: [{ type: "text", text: t }] });
const call = (id: string, name: string, input: unknown): NormalizedMessage => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input }],
});
const result = (id: string, content: string, isError = false): NormalizedMessage => ({
  role: "user",
  content: [{ type: "tool_result", toolUseId: id, content, isError }],
});

/** A session long enough to force a cut, with a real early fact to lose. */
function longSession(): NormalizedMessage[] {
  return [
    user("Claim CLM-1042 for payer Aetna denied with CARC 97. Diagnosis E11.9, procedure 99214."),
    call("t1", "claim_scrub", { claim_id: "CLM-1042" }),
    result("t1", "2 findings: modifier 25 missing on 99214; POS 11 inconsistent with telehealth context"),
    asst("The scrubber flagged a missing modifier 25."),
    call("t2", "era_parse_835", { file: "remit.835" }),
    result("t2", "1 claim, paid 180.00 of 225.00, PR 45.00"),
    call("t3", "claim_submit", { claim_id: "CLM-1042" }),
    result("t3", "REFUSED: approval was declined by the operator", true),
    ...Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? user("z".repeat(3000)) : asst("w".repeat(3000)))),
    user("What should I do next?"),
  ];
}

describe("planCompaction", () => {
  it("does nothing when the history already fits", () => {
    const msgs = [user("hi"), asst("hello")];
    const plan = planCompaction(msgs, 10_000);
    expect(plan.noop).toBe(true);
    expect(plan.dropped).toEqual([]);
  });

  it("leaves headroom rather than cutting to exactly the budget", () => {
    const msgs = longSession();
    const budget = 4000;
    const plan = planCompaction(msgs, budget);
    expect(plan.noop).toBe(false);
    // Cutting to exactly the limit means the next round compacts again
    // immediately, and a session ends up spending most of its tokens
    // summarising itself.
    const keptChars = plan.keep.reduce(
      (n, m) => n + m.content.reduce((k, b) => k + JSON.stringify(b).length, 0),
      0,
    );
    expect(keptChars / 4).toBeLessThan(budget);
  });

  it("refuses to cut when no safe boundary exists rather than breaking the pairing", () => {
    // One oversized tool exchange and nothing else. There is no plain user
    // message to cut at, so the only options are keep it whole or hand the
    // provider an orphaned tool_use — which fails the request outright instead
    // of shortening it.
    const msgs: NormalizedMessage[] = [
      user("go"),
      call("t1", "x", {}),
      result("t1", "r".repeat(80_000)),
    ];
    const plan = planCompaction(msgs, 100);
    expect(plan.noop).toBe(true);
    expect(plan.keep).toHaveLength(3);
  });
});

describe("extractFacts", () => {
  const facts = extractFacts(longSession());

  it("names every tool that ran, with its outcome", () => {
    const names = facts.tools.map((t) => t.name);
    expect(names).toContain("claim_scrub");
    expect(names).toContain("era_parse_835");
    expect(facts.tools.find((t) => t.name === "claim_scrub")?.lastResult).toContain("modifier 25");
  });

  it("keeps FAILURES separate from successes", () => {
    // A model that does not know a submit was already refused will cheerfully
    // suggest submitting. "We ran claim_submit" is not the same fact as "the
    // submit was declined".
    expect(facts.failures.join(" ")).toMatch(/claim_submit/);
    expect(facts.failures.join(" ")).toMatch(/declined/i);
  });

  it("carries the identifiers the rest of the session refers back to", () => {
    expect(facts.claimIds).toContain("CLM-1042");
    expect(facts.cptCodes).toContain("99214");
    expect(facts.icd10Codes).toContain("E11.9");
    expect(facts.carcCodes).toContain("97");
  });

  it("keeps the opening ask, which is usually what the session is about", () => {
    expect(facts.opening).toContain("CLM-1042");
  });

  it("counts repeated calls rather than listing them twice", () => {
    const repeated = extractFacts([
      call("a", "npi_lookup", {}),
      result("a", "ok"),
      call("b", "npi_lookup", {}),
      result("b", "ok"),
    ]);
    expect(repeated.tools).toHaveLength(1);
    expect(repeated.tools[0].calls).toBe(2);
  });
});

describe("renderSummary", () => {
  const text = renderSummary(extractFacts(longSession()));

  it("labels itself as a record, not as a new request", () => {
    // A summary that reads like a user message gets answered instead of used.
    expect(text).toMatch(/not a new request/i);
  });

  it("marks failed calls in a way that cannot be skimmed past", () => {
    expect(text).toMatch(/do not assume these succeeded/i);
  });

  it("tells the model to ask rather than reconstruct what was dropped", () => {
    // The alternative behaviour — inventing the missing detail — is the one
    // thing worse than losing it.
    expect(text).toMatch(/ask, rather than reconstructing/i);
  });
});

describe("compactHistory", () => {
  it("puts the summary first and keeps the most recent turns verbatim", () => {
    const msgs = longSession();
    const out = compactHistory(msgs, 4000);
    expect(out.droppedCount).toBeGreaterThan(0);
    expect(out.messages[0].role).toBe("user");
    expect(String((out.messages[0].content[0] as { text: string }).text)).toContain("CLM-1042");
    expect(out.messages.at(-1)).toEqual(msgs.at(-1));
  });

  it("replays PRIOR summaries so a twice-compacted session keeps its first hour", () => {
    // Without this, the second compaction folds the first summary away with
    // everything else and the loss is total but invisible.
    const out = compactHistory(longSession(), 4000, ["[earlier] the patient is Medicare secondary"]);
    const head = String((out.messages[0].content[0] as { text: string }).text);
    expect(head).toContain("Medicare secondary");
    expect(head).toContain("CLM-1042");
    // The newly written summary is only the new one — prior summaries are
    // replayed, not re-saved, or the table would grow quadratically.
    expect(out.summary).not.toContain("Medicare secondary");
  });

  it("still surfaces prior summaries when nothing needed compacting this round", () => {
    const out = compactHistory([user("hi")], 10_000, ["[earlier] claim CLM-9 was appealed"]);
    expect(String((out.messages[0].content[0] as { text: string }).text)).toContain("CLM-9");
    expect(out.summary).toBe("");
    expect(out.droppedCount).toBe(0);
  });

  it("does not invent a summary when there is nothing to summarise", () => {
    const out = compactHistory([user("hi"), asst("hello")], 10_000);
    expect(out.summary).toBe("");
    expect(out.facts).toBeNull();
    expect(out.messages).toHaveLength(2);
  });
});
