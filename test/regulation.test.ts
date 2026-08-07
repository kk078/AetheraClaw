import { describe, expect, it } from "vitest";
import {
  codeMatches,
  diagnosisMatches,
  evaluateRules,
  normalizeCode,
  payerKey,
  renderRule,
  sourceIsUsable,
  type PolicyRule,
} from "../src/compliance/rule-dsl.js";
import { compilePolicy, renderCompileResult } from "../src/compliance/reg-compiler.js";
import {
  CMS_ONE_SIDED_90_Z,
  HIGH_ERROR_RATE_THRESHOLD,
  MIN_SAMPLE_FOR_EXTRAPOLATION,
  PRIORITY_AREAS,
  auditSample,
  drawSample,
  extrapolate,
  renderReport,
  seedFrom,
  wilsonInterval,
  type SampledClaim,
} from "../src/compliance/sentinel.js";
import {
  GENESIS_HASH,
  entryHash,
  hashPayload,
  nextEntry,
  renderVerify,
  verifyChain,
  type Anchor,
  type ChainEntry,
} from "../src/audit/chain.js";
import type { ClaimInput } from "../src/tools/healthcare/x12/837.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function rule(over: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: "r1",
    kind: "requires_diagnosis",
    codes: ["95250"],
    diagnoses: ["E11.65"],
    modifiers: [],
    placesOfService: [],
    maxUnits: 0,
    period: "claim",
    severity: "error",
    message: "Covered only for the listed diagnoses.",
    payer: "",
    status: "active",
    source: {
      document: "LCD L33822",
      citation: "Group 1",
      quote: "This service is covered only for the ICD-10-CM codes listed in Group 1.",
      effective: "20260101",
      url: "",
    },
    ...over,
  };
}

function claim(over: Partial<ClaimInput> = {}): ClaimInput {
  return {
    claim_id: "TEST-1",
    payer_name: "Medicare",
    payer_id: "00123",
    billing_provider_npi: "1234567893",
    billing_provider_name: "Test Clinic",
    subscriber_id: "SYN000",
    patient_last: "Test",
    patient_first: "Pat",
    patient_dob: "19700101",
    patient_sex: "U",
    diagnoses: ["E11.65"],
    service_lines: [
      {
        cpt_hcpcs: "95250",
        modifiers: [],
        charge: 150,
        units: 1,
        dx_pointers: [1],
        service_date: "20260301",
        place_of_service: "11",
      },
    ],
    ...over,
  } as ClaimInput;
}

const rules = (r: PolicyRule[], c: ClaimInput, opts = {}) => evaluateRules(c, r, opts);

// ── Code and diagnosis matching ──────────────────────────────────────────────

describe("code matching", () => {
  it("normalizes away decimals and case", () => {
    expect(normalizeCode("e11.65")).toBe("E1165");
  });

  it("matches exactly unless the rule asks for a prefix", () => {
    expect(codeMatches(["97110"], "97110")).toBe(true);
    // Without the marker a rule must not widen itself as code sets gain digits.
    expect(codeMatches(["97110"], "971100")).toBe(false);
    expect(codeMatches(["9711*"], "97110")).toBe(true);
    expect(codeMatches(["9711*"], "97112")).toBe(true);
    expect(codeMatches(["9711*"], "97210")).toBe(false);
  });
});

describe("diagnosis matching", () => {
  it("lets a listed category cover its children", () => {
    expect(diagnosisMatches(["M17"], "M17.11")).toBe(true);
    expect(diagnosisMatches(["E11.65"], "E11.65")).toBe(true);
  });

  it("does not let a claim code widen a listed code", () => {
    // A policy listing M17.11 does not cover M17.12; matching the other way
    // round would make it, and would quietly pass uncovered claims.
    expect(diagnosisMatches(["M17.11"], "M17.12")).toBe(false);
    expect(diagnosisMatches(["M17.11"], "M17")).toBe(false);
  });

  it("ignores the decimal on either side", () => {
    expect(diagnosisMatches(["E1165"], "E11.65")).toBe(true);
  });
});

// ── Rule evaluation ──────────────────────────────────────────────────────────

describe("requires_diagnosis", () => {
  it("passes when the line points at a covered diagnosis", () => {
    expect(rules([rule()], claim())).toEqual([]);
  });

  it("fires when the line points only at uncovered diagnoses", () => {
    const found = rules([rule()], claim({ diagnoses: ["I10"] }));
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe("policy-requires-diagnosis");
    expect(found[0].message).toContain("I10");
  });

  it("checks the diagnoses the LINE points at, not every diagnosis on the claim", () => {
    // The covered code is on the claim but the line does not point at it. A
    // claim-level check would pass this; the payer will not.
    const c = claim({
      diagnoses: ["I10", "E11.65"],
      service_lines: [{ ...claim().service_lines[0], dx_pointers: [1] }],
    });
    expect(rules([rule()], c)).toHaveLength(1);
    // Pointing at the covered one instead passes.
    const ok = { ...c, service_lines: [{ ...c.service_lines[0], dx_pointers: [2] }] };
    expect(rules([rule()], ok)).toEqual([]);
  });

  it("says coverage cannot be established when a line points at nothing", () => {
    const c = claim({ service_lines: [{ ...claim().service_lines[0], dx_pointers: [] }] });
    expect(rules([rule()], c)[0].message).toContain("points at no diagnosis");
  });

  it("ignores lines the rule does not govern", () => {
    expect(rules([rule({ codes: ["99213"] })], claim({ diagnoses: ["I10"] }))).toEqual([]);
  });
});

describe("excluded_diagnosis", () => {
  it("fires when an excluded diagnosis is pointed at", () => {
    const found = rules([rule({ kind: "excluded_diagnosis", diagnoses: ["Z00"] })], claim({ diagnoses: ["Z00.00"] }));
    expect(found[0].rule).toBe("policy-excluded-diagnosis");
  });
});

describe("modifier rules", () => {
  it("requires one of the listed modifiers", () => {
    const found = rules([rule({ kind: "requires_modifier", modifiers: ["KX"] })], claim());
    expect(found[0].message).toContain("no modifiers");
    const withMod = claim({ service_lines: [{ ...claim().service_lines[0], modifiers: ["KX"] }] });
    expect(rules([rule({ kind: "requires_modifier", modifiers: ["KX"] })], withMod)).toEqual([]);
  });

  it("is case-insensitive about the modifier", () => {
    const c = claim({ service_lines: [{ ...claim().service_lines[0], modifiers: ["kx"] }] });
    expect(rules([rule({ kind: "requires_modifier", modifiers: ["KX"] })], c)).toEqual([]);
  });

  it("catches a prohibited modifier", () => {
    const c = claim({ service_lines: [{ ...claim().service_lines[0], modifiers: ["59"] }] });
    const found = rules([rule({ kind: "prohibited_modifier", modifiers: ["59"] })], c);
    expect(found[0].rule).toBe("policy-prohibited-modifier");
  });
});

describe("place of service", () => {
  it("fires outside the allowed list and pads single digits", () => {
    const c = claim({ service_lines: [{ ...claim().service_lines[0], place_of_service: "2" }] });
    expect(rules([rule({ kind: "place_of_service", placesOfService: ["11"] })], c)).toHaveLength(1);
    expect(rules([rule({ kind: "place_of_service", placesOfService: ["02"] })], c)).toEqual([]);
  });
});

describe("not_covered", () => {
  it("names the ABN timing, which is the part that gets missed", () => {
    const found = rules([rule({ kind: "not_covered" })], claim());
    expect(found[0].message).toContain("before the service");
  });
});

describe("frequency limits", () => {
  const freq = (over: Partial<PolicyRule> = {}) =>
    rule({ kind: "frequency_limit", codes: ["97110"], maxUnits: 2, period: "day", ...over });

  const withUnits = (units: number, date = "20260301") =>
    claim({
      service_lines: [{ ...claim().service_lines[0], cpt_hcpcs: "97110", units, service_date: date }],
    });

  it("sums units within a day", () => {
    expect(rules([freq()], withUnits(2))).toEqual([]);
    expect(rules([freq()], withUnits(3))[0].message).toContain("above the policy limit of 2");
  });

  it("keeps separate days separate", () => {
    const c = claim({
      service_lines: [
        { ...claim().service_lines[0], cpt_hcpcs: "97110", units: 2, service_date: "20260301" },
        { ...claim().service_lines[0], cpt_hcpcs: "97110", units: 2, service_date: "20260302" },
      ],
    });
    expect(rules([freq()], c)).toEqual([]);
  });

  it("says outright when an annual limit could not be checked", () => {
    // Reporting nothing would tell a biller the limit is satisfied when it was
    // never looked at — the failure mode that matters here.
    const found = rules([freq({ period: "year", maxUnits: 4 })], withUnits(1));
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe("policy-frequency-unchecked");
    expect(found[0].severity).toBe("info");
  });

  it("checks an annual limit against supplied history", () => {
    const history = [
      { code: "97110", serviceDate: "20260115", units: 2 },
      { code: "97110", serviceDate: "20260210", units: 1 },
    ];
    const r = [freq({ period: "year", maxUnits: 4 })];
    expect(rules(r, withUnits(1), { history })).toEqual([]);
    const found = rules(r, withUnits(2), { history });
    expect(found[0].rule).toBe("policy-frequency");
    expect(found[0].message).toContain("is 5");
  });

  it("does not count history older than the window", () => {
    const history = [{ code: "97110", serviceDate: "20240115", units: 10 }];
    expect(rules([freq({ period: "year", maxUnits: 4 })], withUnits(1), { history })).toEqual([]);
  });

  it("keeps a monthly limit monthly", () => {
    // Widening "1 per month" to "1 per year" would block eleven legitimate
    // services — the compiler used to do exactly that for want of a month period.
    const r = [freq({ period: "month", maxUnits: 1 })];
    const history = [{ code: "97110", serviceDate: "20260115", units: 1 }];
    // A service last month does not spend this month's allowance.
    expect(rules(r, withUnits(1, "20260301"), { history })).toEqual([]);
    // A second one inside the same month does.
    const sameMonth = [{ code: "97110", serviceDate: "20260210", units: 1 }];
    expect(rules(r, withUnits(1, "20260301"), { history: sameMonth })[0].message).toContain("past month");
  });

  it("walks back a month to a real date and treats the boundary as exclusive", () => {
    // 31 March minus a month is 28 February, not 31 February. The window is the
    // month AFTER that: a service exactly a month back is a different month's
    // allowance and does not count against this one.
    const r = [freq({ period: "month", maxUnits: 1 })];
    const onBoundary = [{ code: "97110", serviceDate: "20260228", units: 1 }];
    expect(rules(r, withUnits(1, "20260331"), { history: onBoundary })).toEqual([]);

    const insideWindow = [{ code: "97110", serviceDate: "20260301", units: 1 }];
    expect(rules(r, withUnits(1, "20260331"), { history: insideWindow })[0].rule).toBe("policy-frequency");
  });

  it("counts a lifetime limit against all history", () => {
    const history = [{ code: "97110", serviceDate: "20200115", units: 1 }];
    const found = rules([freq({ period: "lifetime", maxUnits: 1 })], withUnits(1), { history });
    expect(found[0].rule).toBe("policy-frequency");
  });
});

describe("rule gating", () => {
  it("runs only active rules", () => {
    const bad = claim({ diagnoses: ["I10"] });
    for (const status of ["draft", "rejected", "retired"] as const) {
      expect(rules([rule({ status })], bad)).toEqual([]);
    }
    expect(rules([rule({ status: "active" })], bad)).toHaveLength(1);
  });

  it("applies a payer-specific rule only to that payer", () => {
    const bad = claim({ diagnoses: ["I10"] });
    expect(rules([rule({ payer: "aetna" })], bad)).toEqual([]);
    expect(rules([rule({ payer: "medicare" })], bad)).toHaveLength(1);
  });

  it("normalizes payer names the same way on both sides", () => {
    expect(payerKey("BCBS of Texas")).toBe("bcbsoftexas");
    const c = claim({ payer_name: "BCBS of Texas", diagnoses: ["I10"] });
    expect(rules([rule({ payer: payerKey("bcbs of texas") })], c)).toHaveLength(1);
  });

  it("refuses to run a rule that lost its source", () => {
    // A rule nobody can trace to a policy sentence cannot be re-checked when the
    // policy changes, so it is skipped loudly rather than trusted quietly.
    const orphan = rule({ source: { document: "", citation: "", quote: "", effective: "", url: "" } });
    expect(sourceIsUsable(orphan.source)).toBe(false);
    const found = rules([orphan], claim({ diagnoses: ["I10"] }));
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe("policy-rule-unsourced");
  });

  it("skips a rule with a document but no quote", () => {
    const noQuote = rule({ source: { ...rule().source, quote: "  " } });
    expect(rules([noQuote], claim())[0].rule).toBe("policy-rule-unsourced");
  });

  it("cites the source document in what it tells the biller", () => {
    expect(rules([rule()], claim({ diagnoses: ["I10"] }))[0].message).toContain("LCD L33822");
  });
});

describe("renderRule", () => {
  it("prints the source quote, because the quote is the point", () => {
    const text = renderRule(rule());
    expect(text).toContain("LCD L33822");
    expect(text).toContain("covered only for the ICD-10-CM codes");
  });
});

// ── The compiler ─────────────────────────────────────────────────────────────

const SOURCE = { document: "LCD L12345", effective: "20260101", url: "" };
const compile = (text: string) => compilePolicy(text, { source: SOURCE, idPrefix: "t" });

describe("policy compiler", () => {
  it("drafts a not-covered rule from an exclusion", () => {
    const r = compile("CPT 64999 is not covered for this indication.");
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0].kind).toBe("not_covered");
    expect(r.drafts[0].codes).toEqual(["64999"]);
  });

  it("drafts a frequency limit with its period", () => {
    const r = compile("Code 97110 is limited to two times per year.");
    const freq = r.drafts.find((d) => d.kind === "frequency_limit");
    expect(freq?.maxUnits).toBe(2);
    expect(freq?.period).toBe("year");
  });

  it("compiles a monthly limit as monthly, not annually", () => {
    // The stored period and the message the reviewer reads have to agree — a
    // rule that says "per month" and means "per year" is accepted on sight.
    const r = compile("Code 95250 is limited to one time per month.");
    const freq = r.drafts.find((d) => d.kind === "frequency_limit");
    expect(freq?.period).toBe("month");
    expect(freq?.maxUnits).toBe(1);
    expect(freq?.message).toContain("per month");
  });

  it("reads a numeric limit as well as a spelled one", () => {
    const r = compile("Procedure 11042 is limited to 4 times per year.");
    expect(r.drafts.find((d) => d.kind === "frequency_limit")?.maxUnits).toBe(4);
  });

  it("drafts a modifier requirement", () => {
    const r = compile("Code 97530 must be billed with modifier KX when the cap is exceeded.");
    const mod = r.drafts.find((d) => d.kind === "requires_modifier");
    expect(mod?.modifiers).toEqual(["KX"]);
  });

  it("drafts a diagnosis requirement from a medical-necessity list", () => {
    const r = compile("Code 95250 is covered only for the following ICD-10-CM codes that support medical necessity: E11.65, E10.65.");
    const dx = r.drafts.find((d) => d.kind === "requires_diagnosis");
    expect(dx?.codes).toContain("95250");
    expect(dx?.diagnoses).toEqual(expect.arrayContaining(["E11.65", "E10.65"]));
  });

  it("attaches the paragraph each rule came from", () => {
    const text = "Code 64999 is not covered for this indication.";
    expect(compile(text).drafts[0].source.quote).toBe(text);
  });

  it("is deterministic — the same document compiles to the same ids", () => {
    const text = "Code 64999 is not covered.\n\nCode 97110 is limited to two times per year.";
    expect(compile(text).drafts.map((d) => d.id)).toEqual(compile(text).drafts.map((d) => d.id));
  });

  it("drafts everything as a draft, never active", () => {
    const r = compile("Code 64999 is not covered.");
    expect(r.drafts.every((d) => d.status === "draft")).toBe(true);
  });

  it("reports an obligation it could not encode instead of skipping it silently", () => {
    // The dangerous failure: the reviewer accepts what compiled and believes the
    // document is covered, while the paragraph nobody encoded is live exposure.
    const r = compile("The ordering physician must personally review the beneficiary's prior imaging before the study.");
    expect(r.drafts).toHaveLength(0);
    expect(r.unparsed).toHaveLength(1);
    expect(r.unparsed[0].trigger.toLowerCase()).toBe("must");
  });

  it("names what was missing when a matcher recognized the shape but could not fill it", () => {
    const r = compile("This service is not covered when performed for screening purposes.");
    expect(r.drafts).toHaveLength(0);
    expect(r.unparsed[0].missing).toContain("procedure code");
  });

  it("does not report a paragraph as unparsed when it produced a rule", () => {
    expect(compile("Code 64999 is not covered.").unparsed).toEqual([]);
  });

  it("leaves ordinary descriptive prose alone", () => {
    const r = compile("This policy describes coverage for continuous glucose monitoring.");
    expect(r.drafts).toEqual([]);
    expect(r.unparsed).toEqual([]);
  });

  it("restricts drafts to a payer when asked", () => {
    const r = compilePolicy("Code 64999 is not covered.", { source: SOURCE, payer: "aetna", idPrefix: "t" });
    expect(r.drafts[0].payer).toBe("aetna");
  });

  it("tells the reader the drafts are inert and lists what it missed", () => {
    const text = "Code 64999 is not covered.\n\nThe physician must personally supervise the test.";
    const out = renderCompileResult(compile(text), "LCD L12345");
    expect(out).toContain("DRAFT");
    expect(out).toContain("NOT turned into a rule");
  });
});

// ── Sentinel statistics ──────────────────────────────────────────────────────

describe("wilsonInterval", () => {
  it("keeps the interval inside [0,1] at the boundaries", () => {
    // The normal approximation produces a zero-width interval at 0/30 and
    // negative bounds near it, which is where an audit result gets over-read.
    const zero = wilsonInterval(0, 30);
    expect(zero.lower).toBe(0);
    expect(zero.upper).toBeGreaterThan(0);
    expect(zero.upper).toBeLessThan(0.2);

    const all = wilsonInterval(30, 30);
    expect(all.upper).toBe(1);
    expect(all.lower).toBeLessThan(1);
  });

  it("is wide on a small sample and narrows as n grows", () => {
    const small = wilsonInterval(2, 30);
    const large = wilsonInterval(20, 300);
    expect(small.point).toBeCloseTo(large.point, 5);
    expect(small.upper - small.lower).toBeGreaterThan(large.upper - large.lower);
  });

  it("puts 2/30 in a range that makes the point estimate look as thin as it is", () => {
    const i = wilsonInterval(2, 30);
    expect(i.point).toBeCloseTo(0.0667, 3);
    expect(i.lower).toBeLessThan(0.03);
    expect(i.upper).toBeGreaterThan(0.2);
  });

  it("matches the formula worked by hand for 8/25 at z=1.96", () => {
    // centre = (0.32 + 3.8416/50) / 1.153664 = 0.343974
    // half   = (1.96/1.153664) · √(0.32·0.68/25 + 3.8416/2500) = 0.171929
    const i = wilsonInterval(8, 25);
    expect(i.lower).toBeCloseTo(0.172050, 5);
    expect(i.upper).toBeCloseTo(0.515901, 5);
  });

  it("gives a higher lower bound at one-sided 90% than at two-sided 95%", () => {
    // CMS extrapolates from the one-sided 90% lower bound, which is less
    // conservative than a 95% two-sided bound but still favours the provider.
    expect(wilsonInterval(10, 40, CMS_ONE_SIDED_90_Z).lower).toBeGreaterThan(wilsonInterval(10, 40).lower);
  });

  it("handles an empty sample without dividing by zero", () => {
    expect(wilsonInterval(0, 0)).toEqual({ point: 0, lower: 0, upper: 1 });
  });
});

describe("drawSample", () => {
  const population = Array.from({ length: 100 }, (_, i) => ({ id: `c${String(i).padStart(3, "0")}` }));

  it("draws the same claims for the same seed", () => {
    expect(drawSample(population, 10, 42).map((c) => c.id)).toEqual(drawSample(population, 10, 42).map((c) => c.id));
  });

  it("draws different claims for a different seed", () => {
    expect(drawSample(population, 10, 42).map((c) => c.id)).not.toEqual(drawSample(population, 10, 7).map((c) => c.id));
  });

  it("does not repeat a claim", () => {
    const drawn = drawSample(population, 30, 1).map((c) => c.id);
    expect(new Set(drawn).size).toBe(30);
  });

  it("is stable when the population arrives in a different order", () => {
    // Sorting first means an upstream ORDER BY change cannot quietly change
    // which claims a recorded seed selects — which would break reproducibility
    // exactly when someone asks how the sample was drawn.
    const shuffled = [...population].reverse();
    expect(drawSample(shuffled, 10, 42).map((c) => c.id)).toEqual(drawSample(population, 10, 42).map((c) => c.id));
  });

  it("returns everything when asked for more than exists", () => {
    expect(drawSample(population, 500, 1)).toHaveLength(100);
  });

  it("derives a stable seed from a phrase", () => {
    expect(seedFrom("2026-08-01")).toBe(seedFrom("2026-08-01"));
    expect(seedFrom("2026-08-01")).not.toBe(seedFrom("2026-08-02"));
  });
});

describe("extrapolate", () => {
  it("refuses on a sample too small to support a figure", () => {
    const e = extrapolate(500_00, 20, 5, 1000);
    expect(e.available).toBe(false);
    if (!e.available) expect(e.reason).toContain("too small");
  });

  it("refuses when nothing in the sample was wrong, without claiming a zero rate", () => {
    const e = extrapolate(0, 50, 0, 1000);
    expect(e.available).toBe(false);
    if (!e.available) expect(e.reason).toContain("not the same as an error rate of zero");
  });

  it("projects from the conservative bound, below the naive figure", () => {
    const e = extrapolate(1000_00, 50, 10, 500);
    expect(e.available).toBe(true);
    if (!e.available) return;
    // Naive: 20% of 500 claims × $100 average = $10,000. The conservative bound
    // must come in under that, in the provider's favour.
    expect(e.populationLowerCents).toBeLessThan(10_000_00);
    expect(e.populationLowerCents).toBeGreaterThan(0);
    expect(e.note).toContain("statistician");
  });

  it("scales with population size", () => {
    const small = extrapolate(1000_00, 50, 10, 100);
    const large = extrapolate(1000_00, 50, 10, 1000);
    if (!small.available || !large.available) throw new Error("expected both available");
    expect(large.populationLowerCents).toBeCloseTo(small.populationLowerCents * 10, 2);
  });
});

// ── Sentinel priority areas ──────────────────────────────────────────────────

function sampled(over: Partial<ClaimInput>, id = "s1", paidCents = 20000): SampledClaim {
  return { id, claim: claim(over), paidCents };
}

const MINOR = (code: string) => (code === "11042" ? 0 : code === "27447" ? 90 : undefined);

function line(over: Record<string, unknown> = {}) {
  return { ...claim().service_lines[0], ...over } as ClaimInput["service_lines"][number];
}

describe("modifier 25 area", () => {
  const area = PRIORITY_AREAS.find((a) => a.key === "modifier_25")!;

  it("flags an E/M with modifier 25 alongside a minor procedure", () => {
    const c = claim({
      service_lines: [line({ cpt_hcpcs: "99213", modifiers: ["25"] }), line({ cpt_hcpcs: "11042" })],
    });
    const found = area.check(c, { globalDays: MINOR, sample: [] });
    expect(found[0].rule).toBe("sentinel-modifier-25");
  });

  it("flags the missing-modifier direction as an error, since the E/M is bundled", () => {
    const c = claim({ service_lines: [line({ cpt_hcpcs: "99213" }), line({ cpt_hcpcs: "11042" })] });
    const found = area.check(c, { globalDays: MINOR, sample: [] });
    expect(found[0].rule).toBe("sentinel-modifier-25-missing");
    expect(found[0].severity).toBe("error");
  });

  it("leaves a major surgery alone — the rule is about MINOR procedures", () => {
    const c = claim({ service_lines: [line({ cpt_hcpcs: "99213" }), line({ cpt_hcpcs: "27447" })] });
    expect(area.check(c, { globalDays: MINOR, sample: [] })).toEqual([]);
  });

  it("says the claim was not checked when no global-period data is loaded", () => {
    // Silence here would read as "checked and clean" for every practice that
    // never loaded the dataset.
    const c = claim({ service_lines: [line({ cpt_hcpcs: "99213" }), line({ cpt_hcpcs: "11042" })] });
    const found = area.check(c, { sample: [] });
    expect(found.some((f) => f.rule === "sentinel-modifier-25-unknown")).toBe(true);
    expect(found.find((f) => f.rule === "sentinel-modifier-25-unknown")!.message).toContain("NOT checked");
  });

  it("does not fire on an E/M alone", () => {
    const c = claim({ service_lines: [line({ cpt_hcpcs: "99213" })] });
    expect(area.check(c, { globalDays: MINOR, sample: [] })).toEqual([]);
  });

  it("keeps different service dates separate", () => {
    const c = claim({
      service_lines: [
        line({ cpt_hcpcs: "99213", service_date: "20260301" }),
        line({ cpt_hcpcs: "11042", service_date: "20260302" }),
      ],
    });
    expect(area.check(c, { globalDays: MINOR, sample: [] })).toEqual([]);
  });
});

describe("repeat new-patient area", () => {
  const area = PRIORITY_AREAS.find((a) => a.key === "repeat_new_patient")!;

  const visit = (id: string, code: string, date: string, patient = "PT-1") =>
    sampled(
      {
        claim_id: id,
        service_lines: [line({ cpt_hcpcs: code, service_date: date })],
        compliance: { patient_ref: patient },
      },
      id,
    );

  it("catches a new-patient code for a patient seen inside three years", () => {
    const target = visit("A", "99204", "20260301");
    const prior = visit("B", "99213", "20250601");
    const found = area.check(target.claim, { sample: [target, prior] });
    expect(found[0].rule).toBe("sentinel-repeat-new-patient");
    expect(found[0].severity).toBe("error");
  });

  it("allows it when the prior visit is outside the window", () => {
    const target = visit("A", "99204", "20260301");
    const prior = visit("B", "99213", "20220101");
    expect(area.check(target.claim, { sample: [target, prior] })).toEqual([]);
  });

  it("does not count a different patient", () => {
    const target = visit("A", "99204", "20260301", "PT-1");
    const other = visit("B", "99213", "20250601", "PT-2");
    expect(area.check(target.claim, { sample: [target, other] })).toEqual([]);
  });

  it("does not count a later visit as prior", () => {
    const target = visit("A", "99204", "20260301");
    const later = visit("B", "99213", "20260601");
    expect(area.check(target.claim, { sample: [target, later] })).toEqual([]);
  });

  it("stays quiet without a patient reference to join on", () => {
    const c = claim({ service_lines: [line({ cpt_hcpcs: "99204" })] });
    expect(area.check(c, { sample: [] })).toEqual([]);
  });
});

// ── Whole-sample audit ───────────────────────────────────────────────────────

describe("auditSample", () => {
  it("counts a claim as in error only on an error-severity finding", () => {
    // A warning is a thing to look at; an error rate built from warnings would
    // report a clean practice as failing.
    const warnOnly = sampled({
      service_lines: [line({ cpt_hcpcs: "99213", modifiers: ["25"] }), line({ cpt_hcpcs: "11042" })],
    });
    const report = auditSample([warnOnly], 100, 1, { globalDays: MINOR });
    expect(report.audits[0].findings.length).toBeGreaterThan(0);
    expect(report.claimsInError).toBe(0);
  });

  it("counts a claim with a bad NPI as in error", () => {
    const report = auditSample([sampled({ billing_provider_npi: "1234567890" })], 100, 1);
    expect(report.claimsInError).toBe(1);
  });

  it("reports the rate with an interval around it", () => {
    const population = Array.from({ length: 10 }, (_, i) =>
      sampled(i < 2 ? { billing_provider_npi: "1234567890" } : {}, `c${i}`),
    );
    const report = auditSample(population, 100, 1);
    expect(report.claimsInError).toBe(2);
    expect(report.errorRate.point).toBeCloseTo(0.2, 5);
    expect(report.errorRate.lower).toBeLessThan(0.2);
    expect(report.errorRate.upper).toBeGreaterThan(0.4);
  });

  it("flags a high error rate only when the conservative bound reaches 50%", () => {
    const allBad = Array.from({ length: 40 }, (_, i) => sampled({ billing_provider_npi: "1234567890" }, `c${i}`));
    const report = auditSample(allBad, 100, 1);
    expect(report.conservativeLowerBound).toBeGreaterThan(HIGH_ERROR_RATE_THRESHOLD);
    expect(report.highErrorRate).toBe(true);
  });

  it("separates 'measured above 50%' from 'confidently above 50%'", () => {
    // 3 of 5 is 60%, but the bound is nowhere near 50% — reporting that as a
    // high error rate would be a false alarm about the one threshold that
    // actually lets a contractor extrapolate.
    const mixed = Array.from({ length: 5 }, (_, i) =>
      sampled(i < 3 ? { billing_provider_npi: "1234567890" } : {}, `c${i}`),
    );
    const report = auditSample(mixed, 100, 1);
    expect(report.errorRate.point).toBeCloseTo(0.6, 5);
    expect(report.highErrorRate).toBe(false);
    expect(report.highErrorRatePossible).toBe(true);
  });

  it("tallies which priority area the findings came from", () => {
    const c = sampled({ service_lines: [line({ cpt_hcpcs: "99213" }), line({ cpt_hcpcs: "11042" })] });
    const report = auditSample([c], 100, 1, { globalDays: MINOR });
    expect(report.areas.find((a) => a.key === "modifier_25")?.claims).toBe(1);
  });

  it("runs accepted policy rules as part of the audit", () => {
    const report = auditSample([sampled({ diagnoses: ["I10"] })], 100, 1, { rules: [rule()] });
    expect(report.audits[0].findings.some((f) => f.rule === "policy-requires-diagnosis")).toBe(true);
    expect(report.claimsInError).toBe(1);
  });

  it("handles an empty sample", () => {
    const report = auditSample([], 100, 1);
    expect(report.claimsInError).toBe(0);
    expect(report.extrapolation.available).toBe(false);
  });
});

describe("renderReport", () => {
  const badSample = (n: number, bad: number) =>
    Array.from({ length: n }, (_, i) => sampled(i < bad ? { billing_provider_npi: "1234567890" } : {}, `c${i}`));

  it("says the seed can be re-run", () => {
    expect(renderReport(auditSample(badSample(5, 1), 100, 99))).toContain("seed 99");
  });

  it("warns that a small sample is a direction and not a rate", () => {
    expect(renderReport(auditSample(badSample(10, 2), 100, 1))).toContain("direction, not a rate");
  });

  it("explains the 50% threshold when the bound clears it", () => {
    expect(renderReport(auditSample(badSample(40, 40), 100, 1))).toContain("extrapolate");
  });

  it("starts the 60-day clock explicitly when errors were found", () => {
    const text = renderReport(auditSample(badSample(10, 2), 100, 1));
    expect(text).toContain("60 days");
    expect(text).toContain("180 days");
    expect(text).toContain("6 years");
    // Identification no longer waits on quantification — the 2024 revision.
    expect(text).toContain("no longer part of identifying it");
  });

  it("says nothing about clocks on a clean sample", () => {
    expect(renderReport(auditSample(badSample(10, 0), 100, 1))).not.toContain("60 days");
  });

  it("names the minimum sample for an exposure figure", () => {
    expect(MIN_SAMPLE_FOR_EXTRAPOLATION).toBe(30);
    expect(renderReport(auditSample(badSample(10, 2), 100, 1))).toContain("too small");
  });
});

// ── Hash chain ───────────────────────────────────────────────────────────────

function chainOf(n: number): ChainEntry[] {
  const entries: ChainEntry[] = [];
  for (let i = 1; i <= n; i++) {
    entries.push(
      nextEntry(entries[entries.length - 1], {
        kind: "tool_call",
        actor: "tester",
        summary: `entry ${i}`,
        payloadHash: hashPayload({ i }),
        createdAt: 1_700_000_000_000 + i,
      }),
    );
  }
  return entries;
}

describe("chain construction", () => {
  it("starts from a genesis hash", () => {
    expect(chainOf(1)[0].prevHash).toBe(GENESIS_HASH);
    expect(chainOf(1)[0].seq).toBe(1);
  });

  it("links each entry to the one before it", () => {
    const chain = chainOf(3);
    expect(chain[1].prevHash).toBe(chain[0].hash);
    expect(chain[2].prevHash).toBe(chain[1].hash);
  });

  it("hashes over an unambiguous serialization", () => {
    // Two entries whose fields differ only in where a separator falls must not
    // hash alike — the summary is attacker-chosen text.
    const base = { seq: 1, actor: "a", payloadHash: "p", prevHash: GENESIS_HASH, createdAt: 1, kind: "k" };
    expect(entryHash({ ...base, summary: 'x", "y' })).not.toBe(entryHash({ ...base, summary: "x", actor: 'a", "y' }));
  });

  it("hashes the payload rather than storing it", () => {
    expect(hashPayload({ a: 1 })).toHaveLength(64);
    expect(hashPayload({ a: 1 })).toBe(hashPayload({ a: 1 }));
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
  });
});

describe("verifyChain", () => {
  it("passes on an untouched chain", () => {
    const result = verifyChain(chainOf(5));
    expect(result.ok).toBe(true);
    expect(result.entries).toBe(5);
    expect(result.problems).toEqual([]);
  });

  it("passes on an empty chain", () => {
    expect(verifyChain([]).ok).toBe(true);
  });

  it("catches a single character changed in a summary", () => {
    const chain = chainOf(5);
    chain[2] = { ...chain[2], summary: "entry 3 (edited)" };
    const result = verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === "hash_mismatch" && p.seq === 3)).toBe(true);
  });

  it("catches a changed timestamp", () => {
    const chain = chainOf(3);
    chain[1] = { ...chain[1], createdAt: chain[1].createdAt + 60_000 };
    expect(verifyChain(chain).problems.some((p) => p.kind === "hash_mismatch")).toBe(true);
  });

  it("catches a deleted entry as a gap", () => {
    const chain = chainOf(5);
    const result = verifyChain([...chain.slice(0, 2), ...chain.slice(3)]);
    expect(result.problems.some((p) => p.kind === "sequence_gap")).toBe(true);
    expect(result.problems.some((p) => p.kind === "link_broken")).toBe(true);
  });

  it("catches a replaced entry as a broken link", () => {
    const chain = chainOf(4);
    const forged = nextEntry(undefined, {
      kind: "tool_call",
      actor: "tester",
      summary: "forged",
      payloadHash: hashPayload({}),
      createdAt: 1,
    });
    chain[2] = { ...forged, seq: 3 };
    expect(verifyChain(chain).problems.some((p) => p.kind === "link_broken")).toBe(true);
  });

  it("does not silently repair the rest of the chain after a tampered entry", () => {
    // Chaining forward on the recomputed hash would report one problem where
    // there is a rewritten log.
    const chain = chainOf(5);
    chain[1] = { ...chain[1], summary: "changed" };
    const result = verifyChain(chain);
    expect(result.problems.filter((p) => p.kind === "hash_mismatch")).toHaveLength(1);
    expect(result.ok).toBe(false);
  });

  it("reports the head hash", () => {
    const chain = chainOf(3);
    expect(verifyChain(chain).headHash).toBe(chain[2].hash);
    expect(verifyChain([]).headHash).toBe(GENESIS_HASH);
  });
});

describe("anchors", () => {
  const anchorAt = (chain: ChainEntry[], seq: number, publishedTo = "binder"): Anchor => ({
    seq,
    hash: chain[seq - 1].hash,
    publishedTo,
    createdAt: 1,
  });

  it("verifies an anchor that still matches", () => {
    const chain = chainOf(5);
    const result = verifyChain(chain, [anchorAt(chain, 3)]);
    expect(result.ok).toBe(true);
    expect(result.anchorsVerified).toBe(1);
  });

  it("catches a rewrite the chain alone cannot see", () => {
    // Rebuild history from entry 3 with different content. The chain is
    // internally consistent and verifies against itself — only the anchor knows.
    const original = chainOf(5);
    const anchor = anchorAt(original, 4);
    const rewritten = original.slice(0, 2);
    for (let i = 3; i <= 5; i++) {
      rewritten.push(
        nextEntry(rewritten[rewritten.length - 1], {
          kind: "tool_call",
          actor: "tester",
          summary: `rewritten ${i}`,
          payloadHash: hashPayload({ i }),
          createdAt: 1_700_000_000_000 + i,
        }),
      );
    }
    expect(verifyChain(rewritten).ok).toBe(true);
    const withAnchor = verifyChain(rewritten, [anchor]);
    expect(withAnchor.ok).toBe(false);
    expect(withAnchor.problems[0].kind).toBe("anchor_mismatch");
  });

  it("catches a log truncated below an anchor", () => {
    const chain = chainOf(5);
    const anchor = anchorAt(chain, 4);
    const result = verifyChain(chain.slice(0, 2), [anchor]);
    expect(result.problems.some((p) => p.kind === "anchor_missing")).toBe(true);
  });

  it("counts the entries not yet covered by an anchor", () => {
    const chain = chainOf(5);
    expect(verifyChain(chain, [anchorAt(chain, 3)]).unanchoredEntries).toBe(2);
    expect(verifyChain(chain, [anchorAt(chain, 5)]).unanchoredEntries).toBe(0);
  });

  it("treats every entry as unanchored when there are no anchors", () => {
    expect(verifyChain(chainOf(5), []).unanchoredEntries).toBe(5);
  });
});

describe("renderVerify", () => {
  it("says plainly what an unanchored chain does not prove", () => {
    const text = renderVerify(verifyChain(chainOf(3)), 0);
    expect(text).toContain("Chain intact");
    expect(text).toContain("rewrite the whole log consistently");
  });

  it("reports the anchored window when anchors exist", () => {
    const chain = chainOf(5);
    const anchor: Anchor = { seq: 3, hash: chain[2].hash, publishedTo: "binder", createdAt: 1 };
    const text = renderVerify(verifyChain(chain, [anchor]), 1);
    expect(text).toContain("1 of 1 anchor(s) verified");
    expect(text).toContain("2 entr(ies) since that anchor");
  });

  it("does not call history witnessed when the anchor is what failed", () => {
    const chain = chainOf(3);
    const anchor: Anchor = { seq: 2, hash: "deadbeef".repeat(8), publishedTo: "binder", createdAt: 1 };
    const text = renderVerify(verifyChain(chain, [anchor]), 1);
    expect(text).toContain("0 of 1 anchor(s) verified");
    expect(text).not.toContain("is witnessed outside this database");
    expect(text).toContain("changed after the fact");
  });

  it("leads with the failure when verification fails", () => {
    const chain = chainOf(3);
    chain[1] = { ...chain[1], actor: "someone else" };
    expect(renderVerify(verifyChain(chain), 0)).toContain("CHAIN FAILED VERIFICATION");
  });

  it("handles an empty log", () => {
    expect(renderVerify(verifyChain([]), 0)).toContain("empty");
  });
});
