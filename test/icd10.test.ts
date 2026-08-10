import { describe, expect, it } from "vitest";
import {
  childrenOf,
  dotCode,
  lookup,
  normalizeCode,
  renderSearch,
  renderValidation,
  search,
  type Icd10Table,
} from "../src/tools/healthcare/icd10-local.js";

// A small fixture rather than the real 98,000-code file: the suite must not
// depend on ~/.orion/data, which is exactly the trap test/setup.ts exists
// to close. Shapes here are lifted verbatim from the CMS FY2026 order file.
const table: Icd10Table = {
  fy: 2026,
  billable: {
    "E11.65": "Type 2 diabetes mellitus with hyperglycemia",
    "E11.9": "Type 2 diabetes mellitus without complications",
    "E11.41": "Type 2 diabetes mellitus with diabetic mononeuropathy",
    "E11.42": "Type 2 diabetes mellitus with diabetic polyneuropathy",
    I10: "Essential (primary) hypertension",
    "J45.909": "Unspecified asthma, uncomplicated",
  },
  headers: {
    E11: "Type 2 diabetes mellitus",
    "E11.6": "Type 2 diabetes mellitus with other specified complications",
    "E11.4": "Type 2 diabetes mellitus with neurological complications",
    J45: "Asthma",
    "J45.9": "Other and unspecified asthma",
  },
};

describe("code normalisation", () => {
  it("puts the decimal after the third character, and not on short codes", () => {
    expect(dotCode("E1165")).toBe("E11.65");
    expect(dotCode("A000")).toBe("A00.0");
    expect(dotCode("I10")).toBe("I10");
  });

  it("treats E1165 and E11.65 as one code", () => {
    expect(normalizeCode("e1165")).toBe("E11.65");
    expect(normalizeCode("E11.65")).toBe("E11.65");
    expect(lookup(table, "e1165")?.code).toBe("E11.65");
  });
});

describe("billable status", () => {
  // The pair named in the plan, and the reason the CMS order file is used
  // rather than an inference: it states this outright.
  it("E11.65 is billable and E11 is not", () => {
    expect(lookup(table, "E11.65")?.billable).toBe(true);
    expect(lookup(table, "E11")?.billable).toBe(false);
  });

  it("says a header will be rejected, and lists what is beneath it", () => {
    const out = renderValidation(table, "E11");
    expect(out).toMatch(/BILLABLE: no/);
    expect(out).toMatch(/rejected as lacking specificity/);
    expect(out).toMatch(/E11\.65/);
  });

  it("does not let silence imply a billable code is the most specific one", () => {
    // E11.4 is a header whose children include billable codes; a billable code
    // with children beneath it must say so rather than reading as final.
    expect(childrenOf(table, "E11.4").map((e) => e.code)).toEqual(["E11.41", "E11.42"]);
    expect(renderValidation(table, "J45.9")).toMatch(/J45\.909/);
  });

  it("counts only strict descendants as children", () => {
    expect(childrenOf(table, "E11.65")).toEqual([]);
    expect(childrenOf(table, "I10")).toEqual([]);
  });
});

describe("invalid codes", () => {
  it("names the closest valid ancestor rather than returning nothing", () => {
    const out = renderValidation(table, "E11.9999");
    expect(out).toMatch(/is NOT a valid ICD-10-CM code/);
    expect(out).toMatch(/E11\.9 /);
  });

  it("says which edition answered, so a stale table cannot pass as current", () => {
    expect(renderValidation(table, "E11.65")).toMatch(/FY2026/);
    expect(renderValidation(table, "ZZ99")).toMatch(/FY2026/);
  });
});

describe("search", () => {
  it("treats a code-shaped query as a code prefix", () => {
    const rows = search(table, "E11.4");
    expect(rows.map((r) => r.code)).toEqual(["E11.4", "E11.41", "E11.42"]);
  });

  it("accepts an undotted prefix", () => {
    expect(search(table, "E114").map((r) => r.code)).toEqual(["E11.4", "E11.41", "E11.42"]);
  });

  it("ranks a full-term match above a partial one", () => {
    // Not a filter: requiring every word returned only Z86.31 for "diabetic foot
    // ulcer", because E11.621 is titled with "diabetes" rather than "diabetic".
    // The code the coder wanted was excluded by a single letter.
    expect(search(table, "diabetes polyneuropathy")[0].code).toBe("E11.42");
    expect(search(table, "diabetes polyneuropathy").length).toBeGreaterThan(1);
  });

  it("puts a billable code ahead of a header that matches equally well", () => {
    // "acute appendicitis" led with three category headers before this: the
    // shortest, most on-point titles in the file and none of them claimable.
    const rows = search(table, "asthma");
    expect(rows[0].code).toBe("J45.909");
    expect(rows[0].billable).toBe(true);
  });

  it("marks a header in the result list rather than presenting it as usable", () => {
    expect(renderSearch(search(table, "E11"), "E11", 2026)).toMatch(/not billable/);
  });

  it("names the local edition on every answer", () => {
    expect(renderSearch(search(table, "asthma"), "asthma", 2026)).toMatch(/Local CMS ICD-10-CM FY2026/);
    expect(renderSearch([], "nonsense", 2026)).toMatch(/FY2026/);
  });

  it("returns nothing for an empty query instead of the whole code set", () => {
    expect(search(table, "   ")).toEqual([]);
  });
});

// ── The converter ────────────────────────────────────────────────────────────
// Fixed-width parsing is the fragile part of this workstream: a layout change at
// CMS produces zero codes, or worse, plausible garbage. These lines are copied
// verbatim from the FY2026 order file, column positions included.
describe("CMS order-file converter", () => {
  const LINES = [
    "00001 A00     0 Cholera                                                      Cholera",
    "00002 A000    1 Cholera due to Vibrio cholerae 01, biovar cholerae           Cholera due to Vibrio cholerae 01, biovar cholerae",
    "04301 E11     0 Type 2 diabetes mellitus                                     Type 2 diabetes mellitus",
    "04413 E1165   1 Type 2 diabetes mellitus with hyperglycemia                  Type 2 diabetes mellitus with hyperglycemia",
    "11580 I10     1 Essential (primary) hypertension                             Essential (primary) hypertension",
  ].join("\r\n");

  it("splits billable codes from headers using CMS's own flag", async () => {
    const { convertIcd10 } = await import("../scripts/fetch-cms-data.mjs");
    const t = convertIcd10(LINES, 2026);
    expect(t.fy).toBe(2026);
    expect(Object.keys(t.billable).sort()).toEqual(["A00.0", "E11.65", "I10"]);
    expect(Object.keys(t.headers).sort()).toEqual(["A00", "E11"]);
  });

  it("keeps the LONG title, not the truncated 60-character short one", async () => {
    const { convertIcd10 } = await import("../scripts/fetch-cms-data.mjs");
    const t = convertIcd10(LINES, 2026);
    expect(t.billable["A00.0"]).toBe("Cholera due to Vibrio cholerae 01, biovar cholerae");
  });

  it("ignores blank and malformed lines rather than inventing codes from them", async () => {
    const { convertIcd10 } = await import("../scripts/fetch-cms-data.mjs");
    const t = convertIcd10(`\n   \n${LINES}\ngarbage`, 2026);
    expect(Object.keys(t.billable)).toHaveLength(3);
  });
});
