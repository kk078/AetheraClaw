import { describe, expect, it } from "vitest";
import { VERDICT_LABELS, summarize, withCard } from "../src/views/verdict.js";
import type { ClaimScrubView, EmMeterView, MoneyWaterfallView, ToolView } from "../src/views/types.js";

const scrub = (over: Partial<ClaimScrubView> = {}): ToolView => ({
  kind: "claim_scrub",
  data: {
    claimId: "PCN-0184",
    payer: "Medicare",
    totalCharge: 430,
    lines: [],
    claimFindings: [],
    counts: { error: 0, warning: 0, info: 0, clean: 2 },
    blindSpots: [],
    ...over,
  } as ClaimScrubView,
});

const em = (over: Partial<EmMeterView> = {}): ToolView => ({
  kind: "em_meter",
  data: {
    ladder: ["99212", "99213", "99214", "99215"],
    billedCode: "99214",
    supportedCode: "99214",
    direction: "supported",
    distance: 0,
    severity: "info",
    elements: [],
    message: "",
    remedy: "",
    ...over,
  } as EmMeterView,
});

describe("card verdicts", () => {
  it("holds a scrub with an error and clears one without", () => {
    expect(summarize(scrub({ counts: { error: 2, warning: 0, info: 0, clean: 0 } }))!.verdict).toBe("hold");
    expect(summarize(scrub())!.verdict).toBe("clear");
  });

  it("treats a warning as REVIEW, not a hold — it is billable as it stands", () => {
    const c = summarize(scrub({ counts: { error: 0, warning: 1, info: 0, clean: 1 } }))!;
    expect(c.verdict).toBe("review");
    expect(c.because).toMatch(/billable as it stands/);
  });

  it("prefers the view's OWN verdict over a derived one", () => {
    // Two verdicts for one scrub is the discrepancy nobody can explain.
    const c = summarize(scrub({ verdict: "review", counts: { error: 0, warning: 0, info: 0, clean: 2 } }))!;
    expect(c.verdict).toBe("review");
  });

  it("says CLEAR is not a statement about the checks that could not run", () => {
    const c = summarize(scrub({ blindSpots: ["NCCI data not installed"] }))!;
    expect(c.verdict).toBe("clear");
    expect(c.because).toMatch(/could NOT run/);
  });

  it("holds an upcoded E/M and only REVIEWS an undercoded one", () => {
    // Holding a claim that is merely under-billed delays cash to fix nothing.
    expect(summarize(em({ direction: "above_documentation", distance: 1 }))!.verdict).toBe("hold");
    expect(summarize(em({ direction: "below_documentation", distance: 1 }))!.verdict).toBe("review");
    expect(summarize(em())!.verdict).toBe("clear");
  });

  it("gives a REPORT facts but no badge", () => {
    // A money waterfall answers "how much", not "should this go out?" — and a
    // CLEAR that means two different things in two places means nothing.
    const w: ToolView = {
      kind: "money_waterfall",
      data: {
        title: "Underpayment",
        steps: [],
        reclaimable: 1250,
        reclaimableLabel: "Reclaimable",
        caveat: "",
      } as MoneyWaterfallView,
    };
    const c = summarize(w)!;
    expect(c.verdict).toBeUndefined();
    expect(c.facts[0].value).toBe("$1,250.00");
  });

  it("renders an uncomputable figure as not computable, never $0.00", () => {
    const w: ToolView = {
      kind: "money_waterfall",
      data: { title: "t", steps: [], reclaimable: null, reclaimableLabel: "Reclaimable", caveat: "" } as MoneyWaterfallView,
    };
    expect(summarize(w)!.facts[0].value).toBe("not computable");
  });

  it("returns null rather than an empty card for a view that has no headline", () => {
    expect(summarize({ kind: "kpi_tiles", data: { tiles: [] } })).toBeNull();
  });

  it("names the claim in the title, so a card is identifiable without expanding it", () => {
    expect(summarize(scrub())!.title).toMatch(/PCN-0184/);
    expect(summarize(scrub({ claimId: "" }))!.title).toMatch(/no claim id/);
  });

  it("carries the charge and payer as facts", () => {
    const c = summarize(scrub())!;
    expect(c.facts.find((f) => f.label === "Billed charge")!.value).toBe("$430.00");
    expect(c.facts.find((f) => f.label === "Payer")!.value).toBe("Medicare");
  });

  it("withCard leaves a view alone when there is nothing to add", () => {
    const bare: ToolView = { kind: "kpi_tiles", data: { tiles: [] } };
    expect(withCard(bare).card).toBeUndefined();
    expect(withCard(scrub()).card?.verdict).toBe("clear");
  });

  it("labels every level", () => {
    expect(VERDICT_LABELS.hold).toBe("HOLD");
    expect(VERDICT_LABELS.review).toBe("REVIEW NEEDED");
    expect(VERDICT_LABELS.clear).toBe("CLEAR");
  });
});
