import { describe, expect, it } from "vitest";
import {
  PREVIEW_BECAUSE,
  VERDICT_RANK,
  groupHeadline,
  groupVerdict,
  isPlumbing,
  isPreview,
  previewCard,
  worstVerdict,
  type GroupSection,
} from "../src/views/workflow.js";
import { VERDICT_LABELS, type CardSummary } from "../src/views/verdict.js";

// The console rendered one card per tool call. "Scrub this claim and check the
// E/M level" produced six boxes, three of which were the model looking things
// up in its own catalogue. These rules turn a turn into one card.

describe("plumbing", () => {
  it("treats the catalogue tools as plumbing", () => {
    expect(isPlumbing("tool_search")).toBe(true);
    expect(isPlumbing("tool_describe")).toBe(true);
    expect(isPlumbing("tool_invoke")).toBe(true);
  });

  it("does not treat real work as plumbing", () => {
    for (const t of ["claim_scrub", "era_reconcile", "denial_explain", "wrvu_report"]) {
      expect(isPlumbing(t), t).toBe(false);
    }
  });
});

describe("verdict severity", () => {
  it("ranks HOLD above everything — it is the only one that says do not submit", () => {
    expect(VERDICT_RANK.hold).toBeGreaterThan(VERDICT_RANK.review);
    expect(VERDICT_RANK.review).toBeGreaterThan(VERDICT_RANK.preview);
    expect(VERDICT_RANK.preview).toBeGreaterThan(VERDICT_RANK.clear);
  });

  it("a group carries the worst verdict in it", () => {
    expect(worstVerdict(["clear", "hold", "review"])).toBe("hold");
    expect(worstVerdict(["clear", "review"])).toBe("review");
    expect(worstVerdict(["clear", "clear"])).toBe("clear");
  });

  it("a dry run outranks clear, because green reads as done", () => {
    // Showing a database preview as CLEAR tells somebody the change went
    // through. It did not.
    expect(worstVerdict(["clear", "preview"])).toBe("preview");
  });

  it("has no verdict when nothing carried one", () => {
    expect(worstVerdict([])).toBeUndefined();
    expect(worstVerdict([undefined, undefined])).toBeUndefined();
  });

  it("labels DRY RUN distinctly from CLEAR", () => {
    expect(VERDICT_LABELS.preview).toBe("DRY RUN");
    expect(VERDICT_LABELS.preview).not.toBe(VERDICT_LABELS.clear);
  });
});

describe("previews", () => {
  it("names preview tools explicitly rather than matching on the word", () => {
    // Matching "preview" in a name would miss claim_autoheal and cash_forecast,
    // and the consequence runs one way: a real write shown in a colour that
    // says nothing happened.
    expect(isPreview("claim_autoheal")).toBe(true);
    expect(isPreview("cash_forecast")).toBe(true);
    expect(isPreview("ops_batch_heal_preview")).toBe(true);
    expect(isPreview("claim_build_837p")).toBe(false);
    expect(isPreview("credit_balance_add")).toBe(false);
  });

  it("does not call code_suggest a preview — it writes a row", () => {
    // It reads like a proposal and INSERTs into the review queue. A pending
    // suggestion somebody has to accept or reject is not nothing happening.
    expect(isPreview("code_suggest")).toBe(false);
  });
});

describe("the badge a whole group carries", () => {
  it("propagates an alarming verdict from any one section", () => {
    expect(groupVerdict(["hold", undefined])).toBe("hold");
    expect(groupVerdict([undefined, "review"])).toBe("review");
  });

  it("refuses DRY RUN when a section in the group carries no verdict", () => {
    // The real case: two claim_build_837p calls (no verdict, and they WROTE
    // claims) followed by the batch preview. Worst-of said DRY RUN over a turn
    // that had just put two claims in the database.
    expect(groupVerdict([undefined, undefined, "preview"])).toBeUndefined();
  });

  it("refuses CLEAR on partial evidence, for the same reason", () => {
    expect(groupVerdict(["clear", undefined])).toBeUndefined();
  });

  it("allows a reassuring verdict when every section carries one", () => {
    expect(groupVerdict(["preview", "preview"])).toBe("preview");
    expect(groupVerdict(["clear", "preview"])).toBe("preview");
    expect(groupVerdict(["clear", "clear"])).toBe("clear");
  });

  it("has nothing to say about an empty group", () => {
    expect(groupVerdict([])).toBeUndefined();
  });
});

describe("re-badging a preview", () => {
  const card = (verdict: CardSummary["verdict"], because = "All checks passed."): CardSummary => ({
    title: "Suggested codes",
    verdict,
    verdictLabel: VERDICT_LABELS[verdict!],
    because,
    facts: [],
  });

  it("turns a preview tool's CLEAR into DRY RUN", () => {
    const out = previewCard(card("clear"), "cash_forecast");
    expect(out.verdict).toBe("preview");
    expect(out.verdictLabel).toBe("DRY RUN");
    expect(out.because).toMatch(/^Nothing has been applied\./);
    expect(out.because).toMatch(/All checks passed\.$/);
  });

  it("leaves a tool that really did apply something alone", () => {
    expect(previewCard(card("clear"), "claim_build_837p").verdict).toBe("clear");
  });

  it("does not soften a preview that found something", () => {
    // A dry run returning HOLD found a problem. Re-labelling that as "dry run"
    // buries a claim-level finding under a statement about process.
    expect(previewCard(card("hold"), "claim_autoheal").verdict).toBe("hold");
    expect(previewCard(card("review"), "claim_autoheal").verdict).toBe("review");
  });

  it("still says it when the card had no reason line", () => {
    const bare: CardSummary = { title: "x", verdict: "clear", facts: [] };
    expect(previewCard(bare, "cash_forecast").because).toBe(PREVIEW_BECAUSE);
  });
});

describe("the group headline", () => {
  const s = (title: string, verdict?: GroupSection["verdict"], subject?: string): GroupSection => ({
    toolName: title,
    title,
    ...(verdict ? { verdict } : {}),
    ...(subject ? { subject } : {}),
  });

  it("names what ran and how much was collapsed", () => {
    const h = groupHeadline([s("Claim scrub", "hold"), s("E/M level", "review")], 3);
    expect(h.title).toMatch(/Claim scrub · E\/M level/);
    expect(h.verdict).toBe("hold");
    expect(h.detail).toBe("2 tools, 3 catalogue call(s) collapsed.");
  });

  it("titles with the claim when every section is about the same one", () => {
    const h = groupHeadline([s("Claim scrub", "hold", "CLAIM-1"), s("E/M level", "clear", "CLAIM-1")], 0);
    expect(h.title).toMatch(/— CLAIM-1$/);
  });

  it("drops the subject when sections are about different claims", () => {
    // A claim id attached to work done on a different claim is worse than none.
    const h = groupHeadline([s("Claim scrub", "hold", "CLAIM-1"), s("Claim scrub", "clear", "CLAIM-2")], 0);
    expect(h.title).not.toMatch(/CLAIM-/);
  });

  it("truncates a long list rather than running off the header", () => {
    const h = groupHeadline([s("A"), s("B"), s("C"), s("D"), s("E")], 0);
    expect(h.title).toBe("A · B · C +2 more");
  });

  it("says plainly when the model only searched its catalogue", () => {
    const h = groupHeadline([], 4);
    expect(h.title).toBe("Catalogue search");
    expect(h.detail).toMatch(/did not run one/);
    expect(h.verdict).toBeUndefined();
  });

  it("says plainly when nothing ran at all", () => {
    const h = groupHeadline([], 0);
    expect(h.title).toBe("No tools run");
    expect(h.detail).toMatch(/answered without running anything/);
  });

  it("counts one tool in the singular", () => {
    expect(groupHeadline([s("Claim scrub", "clear")], 0).detail).toBe("1 tool.");
  });
});
