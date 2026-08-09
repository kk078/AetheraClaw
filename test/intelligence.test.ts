import { describe, expect, it } from "vitest";
import {
  ASSISTANT_SURGEON_RATE,
  CO_SURGEON_RATE,
  MEDICARE_BENEFIT_RATE,
  NPP_RATE,
  SEQUESTRATION_CARC,
  SEQUESTRATION_RATE,
  estimateAllowed,
  isFacilitySetting,
  modifierAdjustments,
  practiceExpenseRvu,
  renderEstimate,
  totalAdjustedRvu,
  type RvuRow,
} from "../src/tools/healthcare/intelligence/fee-schedule.js";
import {
  baselineKey,
  collectPaidLines,
  deriveAllowed,
  detectRateDrift,
  detectVariance,
  median,
  payerBaselines,
  renderVariance,
  type PaidLine,
} from "../src/tools/healthcare/intelligence/variance.js";
import { checkMueEdits, checkPtpEdits, ptpModifierIndicator } from "../src/tools/healthcare/intelligence/ncci.js";
import { CARC } from "../src/tools/healthcare/denial-codes.js";
import type { Era, EraServiceLine } from "../src/tools/healthcare/x12/835.js";

const rules = (findings: Array<{ rule: string }>) => findings.map((f) => f.rule);

// ── Fee schedule ─────────────────────────────────────────────────────────────

// 99213-like values: work 1.30, non-facility PE 1.10, facility PE 0.50, MP 0.09.
const ROW: RvuRow = { work: 1.3, pe: 1.1, facilityPe: 0.5, mp: 0.09 };
const CF = 32.35;

describe("MPFS payment formula", () => {
  it("sums each RVU component against its own GPCI", () => {
    const gpci = { work: 1.05, pe: 1.2, mp: 0.8 };
    expect(totalAdjustedRvu(ROW, false, gpci)).toBeCloseTo(1.3 * 1.05 + 1.1 * 1.2 + 0.09 * 0.8, 6);
  });

  it("uses national GPCIs of 1.0 by default", () => {
    expect(totalAdjustedRvu(ROW, false)).toBeCloseTo(1.3 + 1.1 + 0.09, 6);
  });

  it("swaps in the facility practice expense in a facility setting", () => {
    expect(practiceExpenseRvu(ROW, false)).toBe(1.1);
    expect(practiceExpenseRvu(ROW, true)).toBe(0.5);
  });

  it("falls back to the non-facility PE when no facility value is installed", () => {
    expect(practiceExpenseRvu({ work: 1, pe: 2, mp: 0.1 }, true)).toBe(2);
  });

  it("classifies places of service", () => {
    expect(isFacilitySetting("11")).toBe(false); // office
    expect(isFacilitySetting("22")).toBe(true); // hospital outpatient
    expect(isFacilitySetting("21")).toBe(true); // inpatient
    expect(isFacilitySetting("24")).toBe(true); // ASC
  });

  it("pays less for the same code in a facility", () => {
    const office = estimateAllowed({ code: "99213", row: ROW, placeOfService: "11", conversionFactor: CF });
    const hospital = estimateAllowed({ code: "99213", row: ROW, placeOfService: "22", conversionFactor: CF });
    expect(office.allowed).toBeGreaterThan(hospital.allowed);
    expect(office.allowed).toBeCloseTo((1.3 + 1.1 + 0.09) * CF, 2);
    expect(hospital.allowed).toBeCloseTo((1.3 + 0.5 + 0.09) * CF, 2);
  });

  it("multiplies by units", () => {
    const one = estimateAllowed({ code: "X", row: ROW, units: 1, conversionFactor: CF });
    const three = estimateAllowed({ code: "X", row: ROW, units: 3, conversionFactor: CF });
    expect(three.allowed).toBeCloseTo(one.allowed * 3, 2);
  });

  it("splits the allowed amount 80/20 between Medicare and the patient", () => {
    const e = estimateAllowed({ code: "X", row: ROW, conversionFactor: CF, applySequestration: false });
    expect(e.patientResponsibility).toBeCloseTo(e.allowed * (1 - MEDICARE_BENEFIT_RATE), 2);
    expect(e.medicarePayment).toBeCloseTo(e.allowed * MEDICARE_BENEFIT_RATE, 2);
  });

  it("takes sequestration off the Medicare share only, never the patient's", () => {
    const plain = estimateAllowed({ code: "X", row: ROW, conversionFactor: CF, applySequestration: false });
    const seq = estimateAllowed({ code: "X", row: ROW, conversionFactor: CF, applySequestration: true });
    expect(seq.allowed).toBe(plain.allowed);
    expect(seq.patientResponsibility).toBe(plain.patientResponsibility);
    expect(seq.sequestration).toBeCloseTo(plain.medicarePayment * SEQUESTRATION_RATE, 2);
    expect(seq.medicarePayment).toBeCloseTo(plain.medicarePayment * (1 - SEQUESTRATION_RATE), 2);
  });
});

describe("modifier payment rules", () => {
  const surgical: RvuRow = {
    work: 10,
    pe: 8,
    mp: 2,
    bilateral: "1",
    multipleProcedure: "2",
    assistantSurgery: "2",
    coSurgery: "2",
  };

  it("pays 150% for a bilateral procedure whose indicator allows it", () => {
    const r = modifierAdjustments(surgical, { modifiers: ["50"] });
    expect(r.steps.map((s) => s.factor)).toEqual([1.5]);
    expect(r.warnings).toEqual([]);
  });

  it("pays 100% of each side for bilateral indicator 3", () => {
    const r = modifierAdjustments({ ...surgical, bilateral: "3" }, { modifiers: ["50"] });
    expect(r.steps[0].factor).toBe(2);
  });

  it("warns that modifier 50 buys nothing when the RVUs already include both sides", () => {
    const r = modifierAdjustments({ ...surgical, bilateral: "2" }, { modifiers: ["50"] });
    expect(r.steps).toEqual([]);
    expect(r.warnings[0]).toMatch(/already represent the bilateral procedure/);
  });

  it("warns that the bilateral adjustment does not apply to indicator 0", () => {
    const r = modifierAdjustments({ ...surgical, bilateral: "0" }, { modifiers: ["50"] });
    expect(r.steps).toEqual([]);
    expect(r.warnings[0]).toMatch(/does not apply to this code/);
  });

  it("assumes no bilateral adjustment when the indicator is missing, and says so", () => {
    const r = modifierAdjustments({ work: 1, pe: 1, mp: 0 }, { modifiers: ["50"] });
    expect(r.steps).toEqual([]);
    expect(r.warnings[0]).toMatch(/not in the installed data/);
  });

  it("pays an assistant at surgery 16% of the surgeon's amount", () => {
    const r = modifierAdjustments(surgical, { modifiers: ["80"] });
    expect(r.steps.map((s) => s.factor)).toEqual([ASSISTANT_SURGEON_RATE]);
  });

  it("refuses an assistant on a procedure with a statutory restriction", () => {
    const r = modifierAdjustments({ ...surgical, assistantSurgery: "1" }, { modifiers: ["80"] });
    expect(r.notPayable).toMatch(/statutory payment restriction/);
    expect(r.steps).toEqual([]);
  });

  it("compounds modifier AS to 85% of the 16% assistant rate", () => {
    const r = modifierAdjustments(surgical, { modifiers: ["AS"] });
    const product = r.steps.reduce((f, s) => f * s.factor, 1);
    expect(product).toBeCloseTo(ASSISTANT_SURGEON_RATE * NPP_RATE, 6);
    expect(product).toBeCloseTo(0.136, 6);
  });

  it("pays each co-surgeon 62.5% of the global amount", () => {
    const r = modifierAdjustments(surgical, { modifiers: ["62"] });
    expect(r.steps.map((s) => s.factor)).toEqual([CO_SURGEON_RATE]);
  });

  it("refuses co-surgeons where the indicator forbids them", () => {
    const r = modifierAdjustments({ ...surgical, coSurgery: "0" }, { modifiers: ["62"] });
    expect(r.notPayable).toMatch(/not permitted/);
  });

  it("leaves the highest-valued procedure unreduced", () => {
    expect(modifierAdjustments(surgical, { modifiers: [], multipleProcedureRank: 1 }).steps).toEqual([]);
  });

  it("halves subsequent procedures under the standard indicator", () => {
    const r = modifierAdjustments(surgical, { modifiers: [], multipleProcedureRank: 2 });
    expect(r.steps.map((s) => s.factor)).toEqual([0.5]);
  });

  it("declines to model endoscopy families rather than guessing", () => {
    const r = modifierAdjustments({ ...surgical, multipleProcedure: "3" }, { modifiers: [], multipleProcedureRank: 2 });
    expect(r.steps).toEqual([]);
    expect(r.warnings[0]).toMatch(/endoscopy rules/);
  });

  it("applies no reduction where the indicator says none applies", () => {
    const r = modifierAdjustments({ ...surgical, multipleProcedure: "0" }, { modifiers: [], multipleProcedureRank: 3 });
    expect(r.steps).toEqual([]);
    expect(r.warnings[0]).toMatch(/no multiple-procedure reduction/);
  });

  it("pays a PA or NP billing independently 85%", () => {
    const r = modifierAdjustments(surgical, { modifiers: [], renderedByNpp: true });
    expect(r.steps.map((s) => s.factor)).toEqual([NPP_RATE]);
  });

  it("does not double-count the 85% when modifier AS already carried it", () => {
    const r = modifierAdjustments(surgical, { modifiers: ["AS"], renderedByNpp: true });
    expect(r.steps.filter((s) => s.factor === NPP_RATE)).toHaveLength(1);
  });

  it("compounds bilateral and multiple-procedure reductions in order", () => {
    const e = estimateAllowed({
      code: "S",
      row: surgical,
      conversionFactor: CF,
      modifiers: ["50"],
      multipleProcedureRank: 2,
      applySequestration: false,
    });
    expect(e.allowed).toBeCloseTo(20 * CF * 1.5 * 0.5, 2);
  });

  it("zeroes the estimate and explains when a modifier makes the service unpayable", () => {
    const e = estimateAllowed({ code: "S", row: { ...surgical, assistantSurgery: "1" }, modifiers: ["82"] });
    expect(e.allowed).toBe(0);
    expect(e.medicarePayment).toBe(0);
    expect(renderEstimate(e)).toMatch(/NOT PAYABLE/);
  });

  it("shows the sequestration CARC in the rendered estimate", () => {
    const e = estimateAllowed({ code: "X", row: ROW, conversionFactor: CF, applySequestration: true });
    expect(renderEstimate(e)).toMatch(/CARC 253/);
  });
});

// ── Variance ─────────────────────────────────────────────────────────────────

const line = (over: Partial<EraServiceLine> = {}): EraServiceLine => ({
  procedure: "HC:99213",
  charged: 150,
  paid: 76.4,
  units: 1,
  adjustments: [
    { group: "CO", carc: "45", amount: 50 },
    { group: "PR", carc: "2", amount: 22 },
    { group: "CO", carc: "253", amount: 1.6 },
  ],
  rarcs: [],
  ...over,
});

describe("recovering the allowed amount from a remittance", () => {
  it("adds paid, patient responsibility and sequestration", () => {
    const d = deriveAllowed(line());
    expect(d.allowed).toBeCloseTo(76.4 + 22 + 1.6, 2);
    expect(d.allowed).toBe(100);
  });

  it("does not leave sequestration in the contractual write-off", () => {
    // Treating CARC 253 as contractual would report allowed as 98.40 and make
    // every Medicare line look underpaid by about 1.6%.
    const d = deriveAllowed(line());
    expect(d.sequestration).toBe(1.6);
    expect(d.contractual).toBe(50);
  });

  it("confirms the line balances against the charge", () => {
    expect(deriveAllowed(line()).balanced).toBe(true);
    expect(deriveAllowed(line({ charged: 200 })).balanced).toBe(false);
  });

  it("divides by units so multi-unit lines compare to single-unit ones", () => {
    const d = deriveAllowed(line({ units: 4 }));
    expect(d.allowedPerUnit).toBe(25);
  });

  it("treats zero units as one rather than dividing by zero", () => {
    expect(Number.isFinite(deriveAllowed(line({ units: 0 })).allowedPerUnit)).toBe(true);
  });

  it("sums several patient-responsibility adjustments", () => {
    const d = deriveAllowed(
      line({
        paid: 0,
        adjustments: [
          { group: "PR", carc: "1", amount: 60 },
          { group: "PR", carc: "2", amount: 20 },
          { group: "CO", carc: "45", amount: 70 },
        ],
      }),
    );
    expect(d.patientResponsibility).toBe(80);
    expect(d.allowed).toBe(80);
  });
});

const era = (payer: string, lines: EraServiceLine[], statusCode = "1"): Era =>
  ({
    payer,
    payee: "CLINIC",
    checkOrEftAmount: 0,
    claims: [
      {
        claimId: "C1",
        statusCode,
        charged: 150,
        paid: 76.4,
        patientResponsibility: 22,
        payerControlNumber: "PCN",
        lines,
      },
    ],
  }) as Era;

describe("collecting adjudicated lines", () => {
  it("strips the qualifier and keeps the modifiers", () => {
    const [l] = collectPaidLines([{ era: era("ACME", [line({ procedure: "HC:99214:25" })]), receivedAt: 1 }]);
    expect(l.code).toBe("99214");
    expect(l.modifiers).toEqual(["25"]);
  });

  it("skips the synthetic claim-level line", () => {
    const lines = collectPaidLines([
      { era: era("ACME", [line({ procedure: "(claim level)" }), line()]), receivedAt: 1 },
    ]);
    expect(lines).toHaveLength(1);
  });

  it("marks lines from a denied claim", () => {
    const [l] = collectPaidLines([{ era: era("ACME", [line()], "4"), receivedAt: 1 }]);
    expect(l.denied).toBe(true);
  });
});

const paid = (payer: string, code: string, allowedPerUnit: number, receivedAt = 1, denied = false): PaidLine => ({
  payer,
  claimId: `C-${code}-${receivedAt}-${allowedPerUnit}`,
  code,
  modifiers: [],
  receivedAt,
  denied,
  derived: {
    charged: 200,
    paid: allowedPerUnit * 0.8,
    patientResponsibility: allowedPerUnit * 0.2,
    sequestration: 0,
    contractual: 200 - allowedPerUnit,
    allowed: allowedPerUnit,
    allowedPerUnit,
    units: 1,
    balanced: true,
  },
});

describe("payer baselines", () => {
  it("takes the median of a payer's allowed amounts per code", () => {
    const b = payerBaselines([
      paid("ACME", "99213", 100),
      paid("ACME", "99213", 102),
      paid("ACME", "99213", 98),
    ]);
    expect(b.get(baselineKey("ACME", "99213"))?.median).toBe(100);
    expect(b.get(baselineKey("ACME", "99213"))?.n).toBe(3);
  });

  it("keeps payers separate", () => {
    const b = payerBaselines([paid("ACME", "99213", 100), paid("BETA", "99213", 60)]);
    expect(b.get(baselineKey("ACME", "99213"))?.median).toBe(100);
    expect(b.get(baselineKey("BETA", "99213"))?.median).toBe(60);
  });

  it("excludes denials, which would otherwise drag the established rate to zero", () => {
    const b = payerBaselines([
      paid("ACME", "99213", 100),
      paid("ACME", "99213", 100),
      paid("ACME", "99213", 0, 1, true),
    ]);
    expect(b.get(baselineKey("ACME", "99213"))?.median).toBe(100);
    expect(b.get(baselineKey("ACME", "99213"))?.n).toBe(2);
  });

  it("averages the middle two for an even sample", () => {
    expect(median([10, 20, 30, 40])).toBe(25);
    expect(median([])).toBe(0);
  });
});

describe("underpayment detection", () => {
  const history = [
    paid("ACME", "99213", 100),
    paid("ACME", "99213", 100),
    paid("ACME", "99213", 100),
    paid("ACME", "99213", 80),
  ];

  it("flags a line below the payer's own established rate", () => {
    const f = detectVariance(history, { basis: "payer_history", baselines: payerBaselines(history) });
    expect(f).toHaveLength(1);
    expect(f[0].code).toBe("99213");
    expect(f[0].shortfall).toBe(20);
    expect(f[0].pctBelow).toBe(20);
    expect(f[0].severity).toBe("error");
  });

  it("will not build a baseline from too few observations", () => {
    const thin = [paid("ACME", "99213", 100), paid("ACME", "99213", 40)];
    expect(detectVariance(thin, { basis: "payer_history", baselines: payerBaselines(thin), minSample: 3 })).toEqual([]);
  });

  it("ignores shortfalls inside the tolerance", () => {
    const near = [...history.slice(0, 3), paid("ACME", "99213", 99)];
    const f = detectVariance(near, { basis: "payer_history", baselines: payerBaselines(near), tolerancePct: 0.02 });
    expect(f).toEqual([]);
  });

  it("ignores shortfalls below the dollar floor", () => {
    const f = detectVariance(history, {
      basis: "payer_history",
      baselines: payerBaselines(history),
      minDollars: 100,
    });
    expect(f).toEqual([]);
  });

  it("never reports an overpayment as a shortfall", () => {
    const over = [...history.slice(0, 3), paid("ACME", "99213", 140)];
    expect(detectVariance(over, { basis: "payer_history", baselines: payerBaselines(over) })).toEqual([]);
  });

  it("skips denied lines, which are a denial problem and not a pricing one", () => {
    const withDenial = [...history.slice(0, 3), paid("ACME", "99213", 0, 1, true)];
    expect(detectVariance(withDenial, { basis: "payer_history", baselines: payerBaselines(withDenial) })).toEqual([]);
  });

  it("compares against the fee schedule when given one", () => {
    const f = detectVariance([paid("ACME", "99213", 80)], {
      basis: "fee_schedule",
      expectedByCode: new Map([["99213", 100]]),
    });
    expect(f).toHaveLength(1);
    expect(f[0].expectedPerUnit).toBe(100);
    expect(f[0].message).toMatch(/Medicare fee schedule/);
  });

  it("skips codes with no fee-schedule entry rather than assuming zero", () => {
    expect(detectVariance([paid("ACME", "99999", 80)], { basis: "fee_schedule", expectedByCode: new Map() })).toEqual([]);
  });

  it("multiplies the shortfall by units", () => {
    const l = paid("ACME", "99213", 80);
    l.derived.units = 4;
    const f = detectVariance([l], { basis: "fee_schedule", expectedByCode: new Map([["99213", 100]]) });
    expect(f[0].shortfall).toBe(80);
  });

  it("grades a shortfall under 10% as a warning", () => {
    const f = detectVariance([paid("ACME", "99213", 95)], {
      basis: "fee_schedule",
      expectedByCode: new Map([["99213", 100]]),
    });
    expect(f[0].severity).toBe("warning");
  });

  it("orders by dollars and totals them per payer", () => {
    const f = detectVariance([paid("ACME", "99213", 50), paid("BETA", "99214", 90)], {
      basis: "fee_schedule",
      expectedByCode: new Map([
        ["99213", 100],
        ["99214", 100],
      ]),
    });
    expect(f.map((x) => x.payer)).toEqual(["ACME", "BETA"]);
    const out = renderVariance(f, { linesExamined: 2, basis: "fee_schedule" });
    expect(out).toMatch(/\$60\.00 total/);
    expect(out).toMatch(/ACME: 1 line\(s\), \$50\.00/);
  });

  it("says plainly when nothing is underpaid", () => {
    expect(renderVariance([], { linesExamined: 12, basis: "payer_history" })).toMatch(/No underpayments found/);
  });

  it("a baseline spanning a reprice makes every newer line read as underpaid", () => {
    // Not a bug in the detector but a limit of the median: it sits between the
    // old and new rates. The tool cross-checks against rate drift and says so,
    // because a reprice is renegotiated, not disputed claim by claim.
    const repriced = [
      ...[1, 2, 3, 4].map((i) => paid("ACME", "99213", 100, i)),
      ...[5, 6, 7, 8].map((i) => paid("ACME", "99213", 80, i)),
    ];
    const findings = detectVariance(repriced, { basis: "payer_history", baselines: payerBaselines(repriced) });
    expect(findings).toHaveLength(4);
    expect(findings[0].expectedPerUnit).toBe(90); // midpoint of two regimes, not a real rate
    expect(detectRateDrift(repriced)).toHaveLength(1);
  });
});

describe("CARC 253", () => {
  it("is in the bundled dataset, since it is on nearly every Medicare remittance", () => {
    expect(CARC[SEQUESTRATION_CARC]).toBeDefined();
    expect(CARC[SEQUESTRATION_CARC].desc).toMatch(/Sequestration/i);
  });

  it("tells the reader it is not a write-off to chase", () => {
    expect(CARC[SEQUESTRATION_CARC].action).toMatch(/add it back/i);
  });
});

describe("rate drift", () => {
  it("detects a payer repricing a code downward", () => {
    const lines = [
      paid("ACME", "99213", 100, 1),
      paid("ACME", "99213", 100, 2),
      paid("ACME", "99213", 100, 3),
      paid("ACME", "99213", 80, 4),
      paid("ACME", "99213", 80, 5),
      paid("ACME", "99213", 80, 6),
    ];
    const [d] = detectRateDrift(lines);
    expect(d.earlierMedian).toBe(100);
    expect(d.laterMedian).toBe(80);
    expect(d.changePct).toBe(-20);
    expect(d.message).toMatch(/is a reprice, not noise/);
  });

  it("orders by remittance date, not insertion order", () => {
    const lines = [
      paid("ACME", "99213", 80, 6),
      paid("ACME", "99213", 100, 2),
      paid("ACME", "99213", 80, 5),
      paid("ACME", "99213", 100, 1),
      paid("ACME", "99213", 80, 4),
      paid("ACME", "99213", 100, 3),
    ];
    const [d] = detectRateDrift(lines);
    expect(d.earlierMedian).toBe(100);
    expect(d.laterMedian).toBe(80);
  });

  it("ignores a rate that went up", () => {
    const lines = [1, 2, 3].map((i) => paid("ACME", "99213", 80, i)).concat([4, 5, 6].map((i) => paid("ACME", "99213", 100, i)));
    expect(detectRateDrift(lines)).toEqual([]);
  });

  it("ignores a drop inside the threshold", () => {
    const lines = [1, 2, 3].map((i) => paid("ACME", "99213", 100, i)).concat([4, 5, 6].map((i) => paid("ACME", "99213", 98, i)));
    expect(detectRateDrift(lines, { thresholdPct: 0.05 })).toEqual([]);
  });

  it("stays silent without enough history on each side", () => {
    const lines = [paid("ACME", "99213", 100, 1), paid("ACME", "99213", 50, 2)];
    expect(detectRateDrift(lines, { minPerHalf: 3 })).toEqual([]);
  });

  it("does not mix payers or codes together", () => {
    const lines = [
      ...[1, 2, 3].map((i) => paid("ACME", "99213", 100, i)),
      ...[4, 5, 6].map((i) => paid("BETA", "99214", 50, i)),
    ];
    expect(detectRateDrift(lines)).toEqual([]);
  });
});

// ── NCCI ─────────────────────────────────────────────────────────────────────

describe("NCCI procedure-to-procedure edits", () => {
  const lines = (mods: string[] = []) => [
    { cpt_hcpcs: "11042", units: 1 },
    { cpt_hcpcs: "97597", units: 1, modifiers: mods },
  ];
  const edit = { column1: "11042", column2: "97597" };

  it("reads the published indicator in preference to the legacy boolean", () => {
    expect(ptpModifierIndicator({ ...edit, modifierIndicator: "0", modifierAllowed: true })).toBe("0");
    expect(ptpModifierIndicator({ ...edit, modifierAllowed: false })).toBe("0");
    expect(ptpModifierIndicator(edit)).toBe("1");
  });

  it("says a modifier cannot help when the indicator is 0", () => {
    const f = checkPtpEdits([{ ...edit, modifierIndicator: "0" }], lines());
    expect(rules(f)).toEqual(["ncci-ptp-no-bypass"]);
    expect(f[0].message).toMatch(/no modifier can unbundle this pair/);
  });

  it("still refuses the pair when indicator 0 is billed with modifier 59", () => {
    const f = checkPtpEdits([{ ...edit, modifierIndicator: "0" }], lines(["59"]));
    expect(rules(f)).toEqual(["ncci-ptp-no-bypass"]);
    expect(f[0].message).toMatch(/does not help here/);
  });

  it("suggests a distinct-service modifier when the indicator permits one", () => {
    const f = checkPtpEdits([{ ...edit, modifierIndicator: "1" }], lines());
    expect(rules(f)).toEqual(["ncci-ptp"]);
    expect(f[0].message).toMatch(/XE\/XP\/XS\/XU/);
    expect(f[0].message).toMatch(/unless the record supports it/);
  });

  it("notes an accepted bypass rather than staying silent about it", () => {
    const f = checkPtpEdits([{ ...edit, modifierIndicator: "1" }], lines(["XU"]));
    expect(rules(f)).toEqual(["ncci-ptp-bypassed"]);
    expect(f[0].severity).toBe("info");
    expect(f[0].message).toMatch(/draws audit attention/);
  });

  it("ignores deleted edits", () => {
    expect(checkPtpEdits([{ ...edit, modifierIndicator: "9" }], lines())).toEqual([]);
  });

  it("ignores an edit whose pair is not both on the claim", () => {
    expect(checkPtpEdits([edit], [{ cpt_hcpcs: "11042", units: 1 }])).toEqual([]);
  });
});

describe("medically unlikely edits", () => {
  const lines = [{ cpt_hcpcs: "J1885", units: 8 }];

  it("accepts the legacy bare-number table", () => {
    const f = checkMueEdits({ J1885: 4 }, lines);
    expect(rules(f)).toEqual(["mue"]);
    expect(f[0].message).toMatch(/8 units against a limit of 4/);
  });

  it("says an MAI 2 edit is absolute and not worth appealing", () => {
    const f = checkMueEdits({ J1885: { units: 4, mai: "2" } }, lines);
    expect(rules(f)).toEqual(["mue-absolute"]);
    expect(f[0].message).toMatch(/cannot be bypassed, split across lines, or won on appeal/);
  });

  it("says an MAI 3 edit is appealable with records", () => {
    const f = checkMueEdits({ J1885: { units: 4, mai: "3" } }, lines);
    expect(rules(f)).toEqual(["mue-clinical"]);
    expect(f[0].message).toMatch(/appealable with records/);
  });

  it("says an MAI 1 edit may be split across lines", () => {
    const f = checkMueEdits({ J1885: { units: 4, mai: "1" } }, lines);
    expect(rules(f)).toEqual(["mue-line"]);
    expect(f[0].message).toMatch(/separate lines/);
  });

  it("stays silent at or under the limit", () => {
    expect(checkMueEdits({ J1885: 8 }, lines)).toEqual([]);
    expect(checkMueEdits({ J1885: { units: 8, mai: "2" } }, lines)).toEqual([]);
  });

  it("ignores codes absent from the table", () => {
    expect(checkMueEdits({ OTHER: 1 }, lines)).toEqual([]);
  });
});
