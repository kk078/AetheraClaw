import { describe, expect, it } from "vitest";
import { resolveWindow, DEFAULT_FILING_WINDOWS } from "../src/tools/healthcare/prediction/timely-filing.js";
import { compilePolicy } from "../src/compliance/reg-compiler.js";
import { indexHistory, scoreDenialRisk } from "../src/tools/healthcare/prediction/risk.js";
import { CASES } from "../src/eval/cases.js";

describe("timely filing — resolve payers by their real names", () => {
  it("resolves UHC and BCBS by label, not just the abbreviation key", () => {
    expect(resolveWindow("UnitedHealthcare", DEFAULT_FILING_WINDOWS)?.days).toBe(90);
    expect(resolveWindow("Blue Cross Blue Shield of Illinois", DEFAULT_FILING_WINDOWS)?.days).toBe(180);
  });
  it("still lets the more specific window win", () => {
    expect(resolveWindow("Aetna Medicare Advantage", DEFAULT_FILING_WINDOWS)?.days).toBe(365);
  });
});

describe("reg-compiler — a multi-period limit is not silently drafted as single-period", () => {
  it("surfaces 'one per 10 years' as unparsed rather than drafting 1/year", () => {
    const r = compilePolicy("Screening colonoscopy CPT 45378 is limited to one time per 10 years.", {
      source: { document: "x", effective: "2025-01-01", url: "u" },
    });
    expect(r.drafts).toHaveLength(0);
    expect(r.unparsed.length).toBeGreaterThan(0);
  });
  it("still drafts a genuine single-period limit", () => {
    const r = compilePolicy("CPT 99213 is limited to one time per day.", {
      source: { document: "x", effective: "2025-01-01", url: "u" },
    });
    expect(r.drafts.length).toBeGreaterThan(0);
    expect(r.drafts[0].period).toBe("day");
  });
});

describe("denial risk — a paid line with a PA CARC is not an auth denial", () => {
  it("does not subtract a paid CO-197 line from a cell's genuine denials", () => {
    const history = [
      ...Array.from({ length: 3 }, () => ({ payer: "BCBS", code: "J0135", denied: true, carcs: ["50"] })),
      { payer: "BCBS", code: "J0135", denied: false, carcs: ["197"] }, // paid line carrying a PA CARC
      ...Array.from({ length: 20 }, () => ({ payer: "AETNA", code: "X", denied: false, carcs: [] })),
    ];
    const idx = indexHistory(history);
    const withPa = scoreDenialRisk({ payer: "BCBS", codes: ["J0135"], hasPriorAuth: true }, idx);
    const withoutPa = scoreDenialRisk({ payer: "BCBS", codes: ["J0135"], hasPriorAuth: false }, idx);
    // The paid PA line must not create an auth-denial discount: the two estimates
    // for this cell are the same, and no auth factor is rendered.
    expect(withPa.estimatePct).toBe(withoutPa.estimatePct);
  });
});

describe("eval cases — the wRVU case accepts the tool that now exists", () => {
  it("lists wrvu_report among the expected tools", () => {
    const wrvu = CASES.find((c) => c.id === "wrvu");
    expect(wrvu?.expect).toContain("wrvu_report");
  });
});
