import { describe, expect, it } from "vitest";
import {
  applyReview,
  displayCode,
  normalizeCode,
  renderQueue,
  renderSourceStats,
  sourceStats,
  type Suggestion,
} from "../src/tools/healthcare/review/queue.js";
import {
  ESTABLISHED_THRESHOLD,
  deriveCorrection,
  matchCorrections,
  payerKey,
  renderCorrections,
  type Correction,
} from "../src/tools/healthcare/review/corrections.js";

const suggestion = (over: Partial<Suggestion> = {}): Suggestion => ({
  id: "sug_1",
  claimRef: "CLM-1",
  kind: "diagnosis",
  suggestedCode: "E11.65",
  suggestedDescription: "Type 2 diabetes mellitus with hyperglycemia",
  rationale: "Documentation records elevated glucose with a known type 2 diagnosis.",
  provenance: "A1c 9.2, poorly controlled type 2 diabetes",
  confidence: 0.82,
  source: "cdi",
  payer: "ACME Health Plan",
  status: "pending",
  finalCode: "",
  reviewer: "",
  reviewReason: "",
  createdAt: 1,
  reviewedAt: null,
  ...over,
});

const ok = (result: ReturnType<typeof applyReview>) => {
  if (typeof result === "string") throw new Error(`expected success, got: ${result}`);
  return result;
};

// ── Review state machine ─────────────────────────────────────────────────────

describe("review decisions", () => {
  it("accepts a suggestion as its own final code", () => {
    const { suggestion: s, event } = ok(applyReview(suggestion(), { action: "accept", reviewer: "coder-a" }));
    expect(s.status).toBe("accepted");
    expect(s.finalCode).toBe("E11.65");
    expect(s.reviewer).toBe("coder-a");
    expect(event.action).toBe("accept");
    expect(event.toStatus).toBe("accepted");
  });

  it("does not require a reason to accept", () => {
    expect(typeof applyReview(suggestion(), { action: "accept", reviewer: "coder-a" })).not.toBe("string");
  });

  it("refuses an edit with no reason", () => {
    const r = applyReview(suggestion(), { action: "edit", reviewer: "coder-a", finalCode: "E11.9" });
    expect(r).toMatch(/requires a reason/);
    expect(r).toMatch(/teaches the next suggestion/);
  });

  it("refuses a rejection with no reason", () => {
    expect(applyReview(suggestion(), { action: "reject", reviewer: "coder-a" })).toMatch(/teaches nothing/);
  });

  it("refuses a decision with no reviewer", () => {
    expect(applyReview(suggestion(), { action: "accept", reviewer: "  " })).toMatch(/not an audit trail/);
  });

  it("refuses an edit with no replacement code", () => {
    expect(applyReview(suggestion(), { action: "edit", reviewer: "c", reason: "wrong" })).toMatch(
      /needs the code you used instead/,
    );
  });

  it("refuses an edit to the same code", () => {
    expect(
      applyReview(suggestion(), { action: "edit", reviewer: "c", reason: "n/a", finalCode: "e1165" }),
    ).toMatch(/accept it rather than recording an edit to itself/);
  });

  it("records what the coder used instead", () => {
    const { suggestion: s, event } = ok(
      applyReview(suggestion(), {
        action: "edit",
        reviewer: "coder-a",
        reason: "Documentation does not establish hyperglycemia at this visit.",
        finalCode: "E11.9",
      }),
    );
    expect(s.status).toBe("edited");
    expect(s.finalCode).toBe("E11.9");
    expect(event.codeBefore).toBe("E11.65");
    expect(event.codeAfter).toBe("E11.9");
  });

  it("clears the final code on a rejection", () => {
    const { suggestion: s } = ok(
      applyReview(suggestion(), { action: "reject", reviewer: "coder-a", reason: "Not supported by the note." }),
    );
    expect(s.status).toBe("rejected");
    expect(s.finalCode).toBe("");
  });

  it("will not silently overwrite a decision", () => {
    const decided = suggestion({ status: "accepted", reviewer: "coder-a", finalCode: "E11.65" });
    expect(applyReview(decided, { action: "reject", reviewer: "coder-b", reason: "changed my mind" })).toMatch(
      /Reopen it first/,
    );
  });

  it("reopens a decided suggestion with a reason", () => {
    const decided = suggestion({ status: "edited", reviewer: "coder-a", finalCode: "E11.9", reviewReason: "x" });
    const { suggestion: s, event } = ok(
      applyReview(decided, { action: "reopen", reviewer: "lead", reason: "Physician clarified the note." }),
    );
    expect(s.status).toBe("pending");
    expect(s.finalCode).toBe("");
    expect(s.reviewer).toBe("");
    expect(event.fromStatus).toBe("edited");
  });

  it("refuses to reopen without a reason", () => {
    const decided = suggestion({ status: "accepted" });
    expect(applyReview(decided, { action: "reopen", reviewer: "lead" })).toMatch(/requires a reason/);
  });

  it("refuses to reopen something already pending", () => {
    expect(applyReview(suggestion(), { action: "reopen", reviewer: "lead", reason: "x" })).toMatch(/already pending/);
  });

  it("normalizes codes for comparison but keeps the coder's spelling", () => {
    expect(normalizeCode("e11.65")).toBe("E1165");
    const { suggestion: s } = ok(
      applyReview(suggestion(), { action: "edit", reviewer: "c", reason: "r", finalCode: "e11.9" }),
    );
    expect(s.finalCode).toBe("E11.9");
  });
});

describe("suggestion source statistics", () => {
  const mix = [
    suggestion({ id: "1", source: "cdi", status: "accepted" }),
    suggestion({ id: "2", source: "cdi", status: "accepted" }),
    suggestion({ id: "3", source: "cdi", status: "edited" }),
    suggestion({ id: "4", source: "cdi", status: "pending" }),
    suggestion({ id: "5", source: "twin", status: "rejected" }),
    suggestion({ id: "6", source: "twin", status: "rejected" }),
  ];

  it("counts each outcome per source", () => {
    const [cdi] = sourceStats(mix);
    expect(cdi.source).toBe("cdi");
    expect(cdi.suggested).toBe(4);
    expect(cdi.accepted).toBe(2);
    expect(cdi.edited).toBe(1);
    expect(cdi.pending).toBe(1);
  });

  it("computes the accept rate over decided suggestions only", () => {
    // 2 of 3 decided, not 2 of 4 — an unreviewed backlog must not read as failure.
    const [cdi] = sourceStats(mix);
    expect(cdi.decided).toBe(3);
    expect(cdi.acceptRate).toBeCloseTo(2 / 3, 6);
  });

  it("reports zero rather than dividing by nothing when none are decided", () => {
    const [only] = sourceStats([suggestion({ source: "new", status: "pending" })]);
    expect(only.acceptRate).toBe(0);
    expect(renderSourceStats([only])).toMatch(/none decided yet/);
  });

  it("labels suggestions with no source", () => {
    expect(sourceStats([suggestion({ source: "" })])[0].source).toBe("(unattributed)");
  });

  it("says when a source is producing work rather than saving it", () => {
    expect(renderSourceStats(sourceStats(mix))).toMatch(/producing work rather than saving it/);
  });
});

describe("queue rendering", () => {
  it("shows the supporting documentation with the suggestion", () => {
    const out = renderQueue([suggestion()]);
    expect(out).toMatch(/A1c 9\.2/);
    expect(out).toMatch(/confidence 82%/);
  });

  it("shows what a decided suggestion became and who decided", () => {
    const out = renderQueue([
      suggestion({ status: "edited", finalCode: "E11.9", reviewer: "coder-a", reviewReason: "Not documented." }),
    ]);
    expect(out).toMatch(/E11\.65 → E11\.9 by coder-a/);
    expect(out).toMatch(/Not documented\./);
  });

  it("reports an empty queue plainly", () => {
    expect(renderQueue([])).toBe("Nothing in the review queue.");
  });
});

// ── Corrections ──────────────────────────────────────────────────────────────

describe("deriving corrections", () => {
  it("records an edit as a correction", () => {
    const s = suggestion({ status: "edited", finalCode: "E11.9", reviewReason: "Hyperglycemia not documented." });
    expect(deriveCorrection(s)).toEqual({
      kind: "diagnosis",
      suggestedCode: "E1165",
      correctedCode: "E119",
      payerKey: "acmehealthplan",
      reason: "Hyperglycemia not documented.",
    });
  });

  it("records a rejection as a correction with no replacement", () => {
    const s = suggestion({ status: "rejected", reviewReason: "Not supported." });
    expect(deriveCorrection(s)?.correctedCode).toBe("");
  });

  it("learns nothing from an acceptance", () => {
    // An accept confirms the proposal rather than correcting it; recording those
    // alongside corrections would drown the signal in agreement.
    expect(deriveCorrection(suggestion({ status: "accepted", finalCode: "E11.65" }))).toBeNull();
  });

  it("learns nothing from a still-pending suggestion", () => {
    expect(deriveCorrection(suggestion())).toBeNull();
  });

  it("will not record a correction with no stated reason", () => {
    expect(deriveCorrection(suggestion({ status: "edited", finalCode: "E11.9", reviewReason: "  " }))).toBeNull();
  });

  it("normalizes the payer into a key", () => {
    expect(payerKey("ACME Health Plan")).toBe("acmehealthplan");
    expect(payerKey("")).toBe("");
  });
});

const correction = (over: Partial<Correction> = {}): Correction => ({
  id: "corr_1",
  kind: "diagnosis",
  suggestedCode: "E1165",
  correctedCode: "E119",
  payerKey: "",
  reason: "Hyperglycemia not documented.",
  timesSeen: 1,
  lastSeenAt: 10,
  createdAt: 1,
  ...over,
});

describe("recalling corrections", () => {
  it("matches on the code being considered, dotted or not", () => {
    const m = matchCorrections([correction()], { codes: ["E11.65"] });
    expect(m).toHaveLength(1);
  });

  it("ignores corrections for other codes", () => {
    expect(matchCorrections([correction()], { codes: ["I10"] })).toEqual([]);
  });

  it("filters by kind", () => {
    expect(matchCorrections([correction()], { kind: "procedure", codes: ["E11.65"] })).toEqual([]);
  });

  it("does not apply one payer's correction to another", () => {
    const c = correction({ payerKey: "acme" });
    expect(matchCorrections([c], { codes: ["E1165"], payer: "UHC" })).toEqual([]);
    expect(matchCorrections([c], { codes: ["E1165"], payer: "ACME" })).toHaveLength(1);
  });

  it("withholds a payer-specific correction when no payer is being asked about", () => {
    expect(matchCorrections([correction({ payerKey: "acme" })], { codes: ["E1165"] })).toEqual([]);
  });

  it("applies a general correction regardless of payer", () => {
    expect(matchCorrections([correction()], { codes: ["E1165"], payer: "UHC" })).toHaveLength(1);
  });

  it("ranks a payer-specific correction above a general one", () => {
    const general = correction({ id: "general", timesSeen: 9 });
    const specific = correction({ id: "specific", payerKey: "acme", timesSeen: 1 });
    const m = matchCorrections([general, specific], { codes: ["E1165"], payer: "ACME" });
    expect(m.map((c) => c.id)).toEqual(["specific", "general"]);
  });

  it("ranks a repeated correction above a one-off", () => {
    const once = correction({ id: "once", timesSeen: 1 });
    const often = correction({ id: "often", timesSeen: 6 });
    expect(matchCorrections([once, often], { codes: ["E1165"] }).map((c) => c.id)).toEqual(["often", "once"]);
  });

  it("returns everything when no codes are named", () => {
    expect(matchCorrections([correction(), correction({ suggestedCode: "I10" })], {})).toHaveLength(2);
  });
});

describe("rendering corrections", () => {
  it("tells the reader to suggest normally when there is nothing recorded", () => {
    const out = renderCorrections([], { codes: ["E11.65"] });
    expect(out).toMatch(/No recorded corrections for E11\.65/);
    expect(out).toMatch(/Suggest normally/);
  });

  it("shows the substitution and the coder's reason", () => {
    // Stored normalized for matching, displayed the way a coder reads it.
    const out = renderCorrections([correction()], { codes: ["E11.65"] });
    expect(out).toMatch(/E11\.65 → E11\.9/);
    expect(out).toMatch(/Hyperglycemia not documented\./);
  });

  it("describes a rejection differently from a substitution", () => {
    expect(renderCorrections([correction({ correctedCode: "" })], {})).toMatch(/rejected outright/);
  });

  it("marks a repeated correction as established", () => {
    expect(renderCorrections([correction({ timesSeen: ESTABLISHED_THRESHOLD })], {})).toMatch(/established/);
    expect(renderCorrections([correction({ timesSeen: 2 })], {})).toMatch(/repeated/);
    expect(renderCorrections([correction({ timesSeen: 1 })], {})).toMatch(/seen once/);
  });

  it("says whether a correction is payer-specific", () => {
    expect(renderCorrections([correction({ payerKey: "acme" })], { payer: "ACME" })).toMatch(/with this payer/);
    expect(renderCorrections([correction()], {})).toMatch(/across payers/);
  });

  it("says these are past decisions rather than coding rules", () => {
    const out = renderCorrections([correction()], {});
    expect(out).toMatch(/not coding rules/);
    expect(out).toMatch(/say so rather than silently deferring/);
  });
});

describe("code display", () => {
  it("restores the ICD-10 decimal a coder expects to read", () => {
    expect(displayCode("diagnosis", "I160")).toBe("I16.0");
    expect(displayCode("diagnosis", "E1165")).toBe("E11.65");
    expect(displayCode("diagnosis", "N183")).toBe("N18.3");
  });

  it("leaves a three-character category undotted", () => {
    expect(displayCode("diagnosis", "I10")).toBe("I10");
  });

  it("never adds a decimal to a procedure or modifier code", () => {
    expect(displayCode("procedure", "99214")).toBe("99214");
    expect(displayCode("modifier", "25")).toBe("25");
  });

  it("leaves an already-dotted code alone", () => {
    expect(displayCode("diagnosis", "E11.65")).toBe("E11.65");
  });
});
