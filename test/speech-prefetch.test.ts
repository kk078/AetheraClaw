import { describe, expect, it } from "vitest";
import { describePrefetch, prefetchCodes } from "../src/speech/prefetch.js";
import type { CodeUniverse } from "../src/speech/snap.js";

const universe: CodeUniverse = {
  cpt: new Set(["99213", "99214"]),
  hcpcs: new Set(["J1885"]),
  icd10: new Set(["E11.65"]),
};

describe("speculative code lookup", () => {
  it("returns a code that certainly exists", () => {
    const hits = prefetchCodes("scrub 99213 for", universe);
    expect(hits).toEqual([{ code: "99213", kind: "cpt" }]);
  });

  it("returns NOTHING for a near miss, however close", () => {
    // The rule this module turns on. Mid-sentence the recognizer is still
    // revising, and showing someone a correction to a code they have not
    // finished saying is worse than showing nothing. Corrections belong to the
    // final transcript, where a human is present to answer.
    expect(prefetchCodes("scrub 99215 for", universe)).toEqual([]);
    expect(prefetchCodes("look up J1985", universe)).toEqual([]);
  });

  it("attaches a description only when the installation has one", () => {
    const withDesc = prefetchCodes("99213", universe, {
      describe: (code) => (code === "99213" ? "Office visit, established patient" : undefined),
    });
    expect(withDesc[0].description).toBe("Office visit, established patient");
    // No describer means no description — never an invented one.
    expect(prefetchCodes("99213", universe)[0].description).toBeUndefined();
  });

  it("finds codes across all three sets, and is case-insensitive", () => {
    const hits = prefetchCodes("compare j1885 with e11.65 and 99214", universe);
    expect(hits.map((h) => h.code).sort()).toEqual(["99214", "E11.65", "J1885"]);
  });

  it("does not repeat a code said twice", () => {
    expect(prefetchCodes("99213 and again 99213", universe)).toHaveLength(1);
  });

  it("ignores ordinary numbers", () => {
    expect(prefetchCodes("we billed 3 units across 2 claims", universe)).toEqual([]);
  });

  it("is bounded, so a long utterance cannot flood the hint line", () => {
    const big: CodeUniverse = { cpt: new Set(), hcpcs: new Set(), icd10: new Set() };
    for (let i = 0; i < 50; i++) big.cpt.add(String(90000 + i));
    const said = Array.from({ length: 50 }, (_, i) => String(90000 + i)).join(" ");
    expect(prefetchCodes(said, big).length).toBeLessThanOrEqual(4);
    expect(prefetchCodes(said, big, { max: 2 })).toHaveLength(2);
  });

  it("renders an empty string when there is nothing to show", () => {
    expect(describePrefetch([])).toBe("");
  });

  it("renders the description when present and names the set when not", () => {
    expect(describePrefetch([{ code: "99213", kind: "cpt", description: "Office visit" }])).toBe("99213 — Office visit");
    expect(describePrefetch([{ code: "J1885", kind: "hcpcs" }])).toBe("J1885 (valid HCPCS)");
  });

  it("survives an empty universe without throwing", () => {
    expect(prefetchCodes("99213", { cpt: new Set(), hcpcs: new Set(), icd10: new Set() })).toEqual([]);
  });
});
