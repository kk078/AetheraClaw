import { describe, expect, it } from "vitest";
import { computeWrvu, narrowTo, renderWrvu, type RvuTable } from "../src/reports/wrvu.js";
import type { StoredClaim } from "../src/reports/aggregate.js";

// Every case here is a way the number gets quietly inflated or quietly cut, and
// both directions matter in a compensation conversation.

const RVU: RvuTable = {
  "99213": { work: 1.3, pe: 1.1, mp: 0.1 },
  "99214": { work: 1.92, pe: 1.5, mp: 0.14 },
  "20610": { work: 0.79, pe: 1.2, mp: 0.09 },
  "71046": { work: 0.22, pe: 2.1, mp: 0.02 },
};

let n = 0;
function claim(opts: {
  rendering?: string;
  billing?: string;
  name?: string;
  lines: Array<{ code: string; date: string; units?: number; modifiers?: string[] }>;
}): StoredClaim {
  const id = `CLM-${++n}`;
  return {
    claimId: id,
    payer: "Medicare",
    createdAt: 0,
    status: "submitted",
    claim: {
      claim_id: id,
      payer_name: "Medicare",
      payer_id: "MC",
      billing_provider_npi: opts.billing ?? "1111111111",
      billing_provider_name: opts.name ?? "Example Clinic",
      ...(opts.rendering ? { rendering_provider_npi: opts.rendering } : {}),
      subscriber_id: "S1",
      patient_last: "Test",
      patient_first: "Synthetic",
      patient_dob: "19800101",
      patient_sex: "U",
      diagnoses: ["E11.9"],
      service_lines: opts.lines.map((l) => ({
        cpt_hcpcs: l.code,
        charge: 100,
        units: l.units ?? 1,
        dx_pointers: [1],
        service_date: l.date,
        place_of_service: "11",
        ...(l.modifiers ? { modifiers: l.modifiers } : {}),
      })),
    },
  } as StoredClaim;
}

describe("work RVU summation", () => {
  it("sums work RVU only, never total", () => {
    const r = computeWrvu([claim({ rendering: "2222222222", lines: [{ code: "99214", date: "20260115" }] })], RVU, "20260101", "20260131");
    // Total RVU would be 1.92 + 1.5 + 0.14 = 3.56, roughly double, and would
    // inflate every compensation figure computed from it.
    expect(r.totalWorkRvu).toBe(1.92);
  });

  it("multiplies by units — a code billed x3 is three times the work", () => {
    const r = computeWrvu([claim({ rendering: "2222222222", lines: [{ code: "20610", date: "20260115", units: 3 }] })], RVU, "20260101", "20260131");
    expect(r.totalWorkRvu).toBe(2.37);
    expect(r.providers[0].units).toBe(3);
  });

  it("filters on the date of SERVICE, not when the claim was entered", () => {
    const claims = [
      claim({ rendering: "2222222222", lines: [{ code: "99214", date: "20251231" }] }),
      claim({ rendering: "2222222222", lines: [{ code: "99214", date: "20260115" }] }),
    ];
    const r = computeWrvu(claims, RVU, "20260101", "20260131");
    expect(r.totalWorkRvu).toBe(1.92);
    expect(r.providers[0].lines).toBe(1);
  });
});

describe("unpriced codes", () => {
  it("excludes and COUNTS them rather than treating them as zero", () => {
    const r = computeWrvu(
      [claim({ rendering: "2222222222", lines: [{ code: "99214", date: "20260115" }, { code: "J1885", date: "20260115" }] })],
      RVU,
      "20260101",
      "20260131",
    );
    expect(r.totalWorkRvu).toBe(1.92);
    expect(r.unpricedLines).toBe(1);
    expect(r.unpricedCodes).toEqual(["J1885"]);
    // Named, so a provider can see WHICH work is missing from their month.
    expect(renderWrvu(r, true)).toMatch(/J1885/);
    expect(renderWrvu(r, true)).toMatch(/floor, not a measurement/);
  });
});

describe("modifiers", () => {
  it("gives a TC line zero work — the technical component is not physician work", () => {
    const r = computeWrvu(
      [claim({ rendering: "2222222222", lines: [{ code: "71046", date: "20260115", modifiers: ["TC"] }] })],
      RVU,
      "20260101",
      "20260131",
    );
    expect(r.totalWorkRvu).toBe(0);
    expect(r.technicalLines).toBe(1);
    expect(r.unpricedLines).toBe(0);
  });

  it("counts a 26 line at full work — the professional component IS the work", () => {
    const r = computeWrvu(
      [claim({ rendering: "2222222222", lines: [{ code: "71046", date: "20260115", modifiers: ["26"] }] })],
      RVU,
      "20260101",
      "20260131",
    );
    expect(r.totalWorkRvu).toBe(0.22);
    expect(r.unadjustedLines).toBe(0);
  });

  it("flags an assistant-surgeon line as unadjusted instead of applying a percentage it does not hold", () => {
    const r = computeWrvu(
      [claim({ rendering: "2222222222", lines: [{ code: "20610", date: "20260115", modifiers: ["80"] }] })],
      RVU,
      "20260101",
      "20260131",
    );
    expect(r.totalWorkRvu).toBe(0.79);
    expect(r.unadjustedLines).toBe(1);
    const text = renderWrvu(r, true);
    expect(text).toMatch(/assistant surgeon/);
    expect(text).toMatch(/upper bound/);
  });
});

describe("attribution", () => {
  it("credits the rendering provider when the claim names one", () => {
    const r = computeWrvu(
      [claim({ billing: "1111111111", rendering: "2222222222", lines: [{ code: "99214", date: "20260115" }] })],
      RVU,
      "20260101",
      "20260131",
    );
    expect(r.providers[0].npi).toBe("2222222222");
    expect(r.providers[0].billingNpiOnly).toBe(false);
  });

  it("says so loudly when everything fell back to the billing NPI", () => {
    // A group practice whose claims name no rendering provider gets ONE row for
    // the whole group. That is not productivity, and presenting it silently
    // under one NPI is worse than not reporting it.
    const r = computeWrvu(
      [claim({ billing: "1111111111", lines: [{ code: "99214", date: "20260115" }] }), claim({ billing: "1111111111", lines: [{ code: "99213", date: "20260115" }] })],
      RVU,
      "20260101",
      "20260131",
    );
    expect(r.providers).toHaveLength(1);
    expect(r.providers[0].billingNpiOnly).toBe(true);
    expect(renderWrvu(r, true)).toMatch(/ATTRIBUTION.*BILLING NPI/s);
  });

  it("counts a claim once per provider even with several lines", () => {
    const r = computeWrvu(
      [claim({ rendering: "2222222222", lines: [{ code: "99214", date: "20260115" }, { code: "20610", date: "20260115" }] })],
      RVU,
      "20260101",
      "20260131",
    );
    expect(r.providers[0].claims).toBe(1);
    expect(r.providers[0].lines).toBe(2);
  });

  it("ranks providers by work RVU", () => {
    const r = computeWrvu(
      [
        claim({ rendering: "AAA", lines: [{ code: "99213", date: "20260115" }] }),
        claim({ rendering: "BBB", lines: [{ code: "99214", date: "20260115" }] }),
      ],
      RVU,
      "20260101",
      "20260131",
    );
    expect(r.providers.map((p) => p.npi)).toEqual(["BBB", "AAA"]);
  });
});

describe("narrowing to one provider", () => {
  const both = () =>
    computeWrvu(
      [
        claim({ rendering: "AAA", lines: [{ code: "99213", date: "20260115" }] }),
        claim({ rendering: "BBB", lines: [{ code: "99214", date: "20260115" }, { code: "J1885", date: "20260115" }] }),
      ],
      RVU,
      "20260101",
      "20260131",
    );

  it("recomputes every total, not just the provider list", () => {
    // Found by running it: filtering the list while keeping the original totals
    // printed a summary of 3.22 above a single row reading 1.30. Two numbers on
    // one screen, one wrong, and nothing to say which.
    const one = narrowTo(both(), "AAA");
    expect(one.providers).toHaveLength(1);
    expect(one.totalWorkRvu).toBe(1.3);
    expect(one.claimsMeasured).toBe(1);
    expect(renderWrvu(one, true)).toMatch(/1\.30 across 1 provider\(s\), 1 claim/);
  });

  it("drops the other provider's unpriced codes from the caveat too", () => {
    expect(both().unpricedCodes).toEqual(["J1885"]);
    expect(narrowTo(both(), "AAA").unpricedCodes).toEqual([]);
    expect(narrowTo(both(), "BBB").unpricedCodes).toEqual(["J1885"]);
  });

  it("returns an empty report for an NPI that billed nothing", () => {
    expect(narrowTo(both(), "ZZZ").providers).toEqual([]);
    expect(renderWrvu(narrowTo(both(), "ZZZ"), true)).toMatch(/No service lines/);
  });
});

describe("rendering", () => {
  it("refuses rather than reporting zero when the fee schedule is not installed", () => {
    const empty = { from: "20260101", to: "20260131", providers: [], totalWorkRvu: 0, claimsMeasured: 0, unpricedLines: 0, unpricedCodes: [], technicalLines: 0, unadjustedLines: 0 };
    const text = renderWrvu(empty, false);
    expect(text).toMatch(/cannot be computed at all/);
    expect(text).toMatch(/different from a provider having no productivity/);
  });

  it("labels the last column as the billing organisation, not the provider", () => {
    // It prints the billing provider NAME against a RENDERING npi, because the
    // 837 carries no name for the rendering provider. Calling that column
    // "provider" reads as an identification and is not one.
    const r = computeWrvu([claim({ rendering: "X", name: "Example Clinic", lines: [{ code: "99214", date: "20260115" }] })], RVU, "20260101", "20260131");
    expect(renderWrvu(r, true)).toMatch(/billed under/);
    expect(renderWrvu(r, true)).toMatch(/only an NPI for the rendering one/);
  });

  it("says the figure is work RVU, on every report", () => {
    const r = computeWrvu([claim({ rendering: "X", lines: [{ code: "99214", date: "20260115" }] })], RVU, "20260101", "20260131");
    expect(renderWrvu(r, true)).toMatch(/not total RVU/);
  });

  it("distinguishes an empty period from a broken one", () => {
    const r = computeWrvu([], RVU, "20260101", "20260131");
    expect(renderWrvu(r, true)).toMatch(/No service lines/);
  });
});
