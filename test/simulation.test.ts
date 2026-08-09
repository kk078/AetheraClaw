import { describe, expect, it } from "vitest";
import {
  MEDICARE_ELECTRONIC_FLOOR_DAYS,
  MIN_RESOLVED_CLAIMS,
  MIN_RESOLVED_PER_PAYER,
  fitModel,
  indexResolutions,
  paidByDay,
  renderModel,
  samplePaymentDay,
  survivalCurve,
  type Observation,
} from "../src/simulation/model.js";
import {
  BASELINE,
  checkScenario,
  describeScenario,
  futureAdjustment,
  scenario,
} from "../src/simulation/scenarios.js";
import { compare, forecast, renderComparison, renderForecast, sampleRemainingDays } from "../src/simulation/monte-carlo.js";
import {
  PLAN_THRESHOLD_CENTS,
  SMALL_BALANCE_CENTS,
  account,
  draftPatientLetter,
  planOutreach,
  renderOutreach,
  scorePropensity,
} from "../src/simulation/patient-comms.js";
import { fanChartSvg, renderFanChart } from "../src/simulation/chart.js";
import type { StoredClaim, StoredEra } from "../src/reports/aggregate.js";
import type { ClaimInput } from "../src/tools/healthcare/x12/837.js";
import type { Era } from "../src/tools/healthcare/x12/835.js";

// ── Kaplan-Meier ─────────────────────────────────────────────────────────────

const paid = (days: number): Observation => ({ days, resolved: true });
const waiting = (days: number): Observation => ({ days, resolved: false });

describe("survivalCurve", () => {
  it("matches the estimator worked by hand", () => {
    // 5 claims. Payments on days 10, 20, 40; one censored at 30.
    //   day 10: at risk 5, 1 pays → S = 1 - 1/5    = 0.8
    //   day 20: at risk 4, 1 pays → S = 0.8 · 3/4  = 0.6
    //   day 30: 1 censored, no event, at risk → 2
    //   day 40: at risk 2, 1 pays → S = 0.6 · 1/2  = 0.3
    const curve = survivalCurve([paid(10), paid(20), waiting(30), paid(40), waiting(50)]);
    expect(curve.points.map((p) => p.day)).toEqual([10, 20, 40]);
    expect(curve.points[0].survival).toBeCloseTo(0.8, 10);
    expect(curve.points[1].survival).toBeCloseTo(0.6, 10);
    expect(curve.points[2].survival).toBeCloseTo(0.3, 10);
    expect(curve.points[2].atRisk).toBe(2);
  });

  it("reduces the at-risk count for a censored claim without recording an event", () => {
    const curve = survivalCurve([paid(10), waiting(20), paid(30)]);
    // At day 30 only one claim is still at risk — the censored one left at 20.
    expect(curve.points[1].atRisk).toBe(1);
    expect(curve.points[1].survival).toBeCloseTo(0, 10);
  });

  it("counts payments before removing same-day censorings", () => {
    // A claim censored the same day another paid was still at risk when that
    // payment happened. The other order shrinks the denominator and biases the
    // curve downward.
    const curve = survivalCurve([paid(10), waiting(10), paid(20)]);
    expect(curve.points[0].atRisk).toBe(3);
    expect(curve.points[0].survival).toBeCloseTo(2 / 3, 10);
  });

  it("does not let dropped censored claims make the practice look faster", () => {
    // The defect this whole module exists to avoid. Same five claims; the naive
    // fit throws away the two still outstanding and concludes payment is quick.
    const observations = [paid(10), paid(20), paid(40), waiting(60), waiting(70)];
    const honest = survivalCurve(observations);
    const naive = survivalCurve(observations.filter((o) => o.resolved));

    expect(naive.neverPaidRate).toBe(0);
    expect(honest.neverPaidRate).toBeGreaterThan(0);
    // At day 40 the naive curve declares everything collected; the honest one
    // still has 40% of the book outstanding.
    expect(paidByDay(naive, 40)).toBeCloseTo(1, 10);
    expect(paidByDay(honest, 40)).toBeLessThan(0.7);
  });

  it("reports the plateau as the share that never pays", () => {
    const curve = survivalCurve([paid(10), paid(20), waiting(90), waiting(90)]);
    expect(curve.neverPaidRate).toBeCloseTo(0.5, 10);
    expect(curve.censored).toBe(2);
    expect(curve.resolved).toBe(2);
  });

  it("says when the tail is still open", () => {
    // The oldest claim has been outstanding longer than anything has ever taken
    // to pay, so the estimator has nothing to say past that point.
    expect(survivalCurve([paid(10), waiting(200)]).tailIsOpen).toBe(true);
    expect(survivalCurve([waiting(10), paid(200)]).tailIsOpen).toBe(false);
  });

  it("finds the median as the first day survival drops to half", () => {
    expect(survivalCurve([paid(10), paid(20), paid(30), paid(40)]).medianDays).toBe(20);
  });

  it("reports no median when the curve never gets there", () => {
    expect(survivalCurve([paid(10), waiting(90), waiting(90), waiting(90)]).medianDays).toBeNull();
  });

  it("handles an empty and an all-censored sample", () => {
    expect(survivalCurve([]).points).toEqual([]);
    const none = survivalCurve([waiting(10), waiting(20)]);
    expect(none.points).toEqual([]);
    expect(none.neverPaidRate).toBe(1);
  });

  it("ignores impossible observations rather than propagating them", () => {
    expect(survivalCurve([paid(10), paid(Number.NaN), paid(-5)]).observations).toBe(1);
  });
});

describe("paidByDay", () => {
  const curve = survivalCurve([paid(10), paid(20), paid(40), waiting(90)]);

  it("is zero before anything pays and monotonic after", () => {
    expect(paidByDay(curve, 0)).toBe(0);
    expect(paidByDay(curve, 9)).toBe(0);
    let last = 0;
    for (let d = 0; d <= 100; d++) {
      const p = paidByDay(curve, d);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });

  it("steps exactly on an event day", () => {
    expect(paidByDay(curve, 10)).toBeCloseTo(0.25, 10);
    expect(paidByDay(curve, 19)).toBeCloseTo(0.25, 10);
    expect(paidByDay(curve, 20)).toBeCloseTo(0.5, 10);
  });
});

describe("samplePaymentDay", () => {
  const curve = survivalCurve([paid(10), paid(20), paid(30), paid(40)]);

  it("returns a day inside the observed range", () => {
    for (const u of [0.01, 0.3, 0.6, 0.99]) {
      expect([10, 20, 30, 40]).toContain(samplePaymentDay(curve, u));
    }
  });

  it("returns null for the mass that never pays", () => {
    // Half this book never pays, so half the draws must come back as no payment.
    const censored = survivalCurve([paid(10), paid(20), waiting(90), waiting(90)]);
    expect(samplePaymentDay(censored, 0.9)).toBeNull();
    expect(samplePaymentDay(censored, 0.2)).toBe(10);
  });

  it("reproduces the curve's own distribution when sampled", () => {
    const censored = survivalCurve([paid(10), paid(20), waiting(90), waiting(90)]);
    let nulls = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) if (samplePaymentDay(censored, (i + 0.5) / n) === null) nulls++;
    expect(nulls / n).toBeCloseTo(0.5, 1);
  });
});

describe("sampleRemainingDays", () => {
  const fit = {
    payer: "P",
    claims: 0,
    resolved: 0,
    charges: 0,
    collectionRatio: 1,
    denialRate: 0,
    patientShare: 0,
    ownCurve: true,
    warnings: [],
    lag: survivalCurve([paid(10), paid(20), paid(30), paid(40)]),
  };

  it("never puts a payment in the past", () => {
    for (const age of [0, 15, 25, 35]) {
      for (const u of [0.1, 0.5, 0.9]) {
        const remaining = sampleRemainingDays(fit, age, u);
        if (remaining !== null) expect(remaining).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("draws an aged claim from what is left of the curve, not from the start", () => {
    // A claim 25 days old cannot pay on day 10 or 20 — those already didn't
    // happen. Treating it as fresh would forecast the oldest, most doubtful
    // receivables as the ones arriving soonest.
    const samples = [0.05, 0.25, 0.5, 0.75, 0.95].map((u) => sampleRemainingDays(fit, 25, u));
    for (const s of samples) {
      if (s !== null) expect([5, 15]).toContain(s);
    }
  });

  it("pays out immediately when the curve is already exhausted", () => {
    expect(sampleRemainingDays(fit, 100, 0.5)).toBe(0);
  });
});

// ── Fitting ──────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 1);

function ymd(offsetDays: number): string {
  const d = new Date(NOW - offsetDays * DAY);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

function claim(id: string, payer: string, ageDays: number, charge = 200): StoredClaim {
  const input = {
    claim_id: id,
    payer_name: payer,
    payer_id: "001",
    billing_provider_npi: "1234567893",
    billing_provider_name: "Clinic",
    subscriber_id: "SYN",
    patient_last: "T",
    patient_first: "P",
    patient_dob: "19700101",
    patient_sex: "U",
    diagnoses: ["E11.65"],
    service_lines: [
      {
        cpt_hcpcs: "99213",
        modifiers: [],
        charge,
        units: 1,
        dx_pointers: [1],
        service_date: ymd(ageDays),
        place_of_service: "11",
      },
    ],
  } as ClaimInput;
  return { claimId: id, payer, claim: input, createdAt: NOW - ageDays * DAY, status: "submitted" };
}

function era(
  payer: string,
  receivedAgoDays: number,
  claims: Array<{ id: string; charged: number; paid: number; patient?: number; denied?: boolean }>,
): StoredEra {
  const parsed: Era = {
    payer,
    payee: "Clinic",
    checkOrEftAmount: claims.reduce((s, c) => s + c.paid, 0),
    claims: claims.map((c) => ({
      claimId: c.id,
      statusCode: c.denied ? "4" : "1",
      charged: c.charged,
      paid: c.paid,
      patientResponsibility: c.patient ?? 0,
      payerControlNumber: `PC-${c.id}`,
      lines: [
        {
          procedure: "99213",
          charged: c.charged,
          paid: c.paid,
          units: 1,
          adjustments: c.patient ? [{ group: "PR", carc: "1", amount: c.patient }] : [],
        },
      ],
    })),
  };
  return { era: parsed, receivedAt: NOW - receivedAgoDays * DAY, payer };
}

/** n claims for one payer, each paid `lag` days after service. */
function cohort(payer: string, n: number, lag: number, startAge = 200): { claims: StoredClaim[]; eras: StoredEra[] } {
  const claims: StoredClaim[] = [];
  const rows: Array<{ id: string; charged: number; paid: number; patient?: number }> = [];
  for (let i = 0; i < n; i++) {
    const age = startAge - i;
    const id = `${payer}-${i}`;
    claims.push(claim(id, payer, age));
    rows.push({ id, charged: 200, paid: 120, patient: 20 });
  }
  // One ERA per claim so each carries its own received date.
  const eras = rows.map((r, i) => era(payer, startAge - i - lag, [r]));
  return { claims, eras };
}

describe("indexResolutions", () => {
  it("normalizes claim ids the same way the AR report does", () => {
    const index = indexResolutions([era("P", 10, [{ id: " a-1 ", charged: 100, paid: 60 }])]);
    expect(index.has("A-1")).toBe(true);
  });

  it("keeps the earliest remittance when a claim is reprocessed", () => {
    // Taking the later one would inflate every lag on every reprocessed claim.
    const index = indexResolutions([
      era("P", 10, [{ id: "A", charged: 100, paid: 60 }]),
      era("P", 40, [{ id: "A", charged: 100, paid: 80 }]),
    ]);
    expect(index.get("A")!.receivedAt).toBe(NOW - 40 * DAY);
  });

  it("ignores the synthetic claim-level line the 835 parser inserts", () => {
    const stored = era("P", 10, [{ id: "A", charged: 100, paid: 60 }]);
    stored.era.claims[0].lines.push({ procedure: "(claim level)", charged: 0, paid: 0, units: 0, adjustments: [] });
    expect(indexResolutions([stored]).get("A")!.charged).toBe(100);
  });
});

describe("fitModel", () => {
  it("fits collection ratio, denial rate and patient share per payer", () => {
    const { claims, eras } = cohort("Medicare", 20, 25);
    const model = fitModel(claims, eras, NOW);
    const fit = model.payers.find((p) => p.payer === "Medicare")!;
    expect(fit.collectionRatio).toBeCloseTo(0.6, 5);
    expect(fit.denialRate).toBe(0);
    expect(fit.patientShare).toBeCloseTo(20 / 140, 5);
    expect(fit.lag.medianDays).toBe(25);
  });

  it("carries outstanding claims into the fit as censored", () => {
    const { claims, eras } = cohort("Aetna", 15, 20);
    const outstanding = Array.from({ length: 5 }, (_, i) => claim(`Aetna-out-${i}`, "Aetna", 10));
    const model = fitModel([...claims, ...outstanding], eras, NOW);
    const fit = model.payers.find((p) => p.payer === "Aetna")!;
    expect(fit.lag.censored).toBe(5);
    expect(fit.lag.resolved).toBe(15);
    expect(model.inFlight).toHaveLength(5);
  });

  it("falls back to the pooled curve for a payer with too little history, and says so", () => {
    const big = cohort("Medicare", 20, 30);
    const small = cohort("Tiny", 3, 10, 60);
    const model = fitModel([...big.claims, ...small.claims], [...big.eras, ...small.eras], NOW);
    const tiny = model.payers.find((p) => p.payer === "Tiny")!;
    expect(tiny.ownCurve).toBe(false);
    expect(tiny.warnings[0]).toContain("too few");
    expect(tiny.lag).toBe(model.pooled);
    expect(MIN_RESOLVED_PER_PAYER).toBe(12);
  });

  it("refuses to call itself usable below the minimum history", () => {
    const { claims, eras } = cohort("Medicare", 5, 20);
    const model = fitModel(claims, eras, NOW);
    expect(model.usable).toBe(false);
    expect(model.warnings.some((w) => w.includes(String(MIN_RESOLVED_CLAIMS)))).toBe(true);
  });

  it("catches a Medicare curve that pays faster than Medicare can", () => {
    // A clean electronic claim sits on a 13-day payment floor, so payment
    // before day 14 is impossible. Meeting it means the join or the anchor is
    // wrong, and a fast-looking curve is the least helpful way to find out.
    const { claims, eras } = cohort("Medicare", 20, 3);
    const model = fitModel(claims, eras, NOW);
    const fit = model.payers.find((p) => p.payer === "Medicare")!;
    expect(fit.warnings.some((w) => w.includes(String(MEDICARE_ELECTRONIC_FLOOR_DAYS)))).toBe(true);
    expect(fit.warnings.some((w) => w.includes("broken rather than fast"))).toBe(true);
  });

  it("does not raise the floor warning for a payer that pays that fast legitimately", () => {
    const { claims, eras } = cohort("FastCommercial", 20, 3);
    const model = fitModel(claims, eras, NOW);
    expect(model.payers.find((p) => p.payer === "FastCommercial")!.warnings).toEqual([]);
  });

  it("counts denials", () => {
    const claims = Array.from({ length: 4 }, (_, i) => claim(`D-${i}`, "P", 60));
    const eras = [
      era("P", 30, [
        { id: "D-0", charged: 200, paid: 0, denied: true },
        { id: "D-1", charged: 200, paid: 120 },
        { id: "D-2", charged: 200, paid: 120 },
        { id: "D-3", charged: 200, paid: 120 },
      ]),
    ];
    expect(fitModel(claims, eras, NOW).payers[0].denialRate).toBeCloseTo(0.25, 5);
  });

  it("keeps the collection ratio independent of the denial rate", () => {
    // Measuring the ratio over ALL resolved claims bakes the denial rate into
    // it. The simulation then draws denials separately, so they come off twice
    // — a 25% denial rate becomes a 44% haircut and the forecast understates
    // cash by a third. The ratio is therefore "when they pay, they pay this".
    const claims = Array.from({ length: 4 }, (_, i) => claim(`R-${i}`, "P", 60));
    const eras = [
      era("P", 30, [
        { id: "R-0", charged: 200, paid: 0, denied: true },
        { id: "R-1", charged: 200, paid: 120 },
        { id: "R-2", charged: 200, paid: 120 },
        { id: "R-3", charged: 200, paid: 120 },
      ]),
    ];
    const fit = fitModel(claims, eras, NOW).payers[0];
    expect(fit.denialRate).toBeCloseTo(0.25, 5);
    expect(fit.collectionRatio).toBeCloseTo(0.6, 5);
    // Not 0.45, which is what averaging the denied zero into it would give.
    expect(fit.collectionRatio).not.toBeCloseTo(0.45, 2);
    // Ratio × (1 − denial rate) recovers the overall recovery, exactly once.
    expect(fit.collectionRatio * (1 - fit.denialRate)).toBeCloseTo(0.45, 5);
  });

  it("does not let denied claims drag down the patient share either", () => {
    const claims = Array.from({ length: 2 }, (_, i) => claim(`S-${i}`, "P", 60));
    const eras = [
      era("P", 30, [
        { id: "S-0", charged: 200, paid: 0, denied: true },
        { id: "S-1", charged: 200, paid: 120, patient: 40 },
      ]),
    ];
    expect(fitModel(claims, eras, NOW).payers[0].patientShare).toBeCloseTo(40 / 160, 5);
  });

  it("says so when a payer has denied everything, rather than reporting a zero ratio", () => {
    const claims = Array.from({ length: 3 }, (_, i) => claim(`Z-${i}`, "P", 60));
    const eras = [
      era("P", 30, [
        { id: "Z-0", charged: 200, paid: 0, denied: true },
        { id: "Z-1", charged: 200, paid: 0, denied: true },
        { id: "Z-2", charged: 200, paid: 0, denied: true },
      ]),
    ];
    const fit = fitModel(claims, eras, NOW).payers[0];
    expect(fit.denialRate).toBe(1);
    expect(fit.warnings.some((w) => w.includes("Every resolved claim"))).toBe(true);
  });

  it("flags claims with no usable service date instead of quietly re-anchoring them", () => {
    const bad = claim("X", "P", 30);
    bad.claim.service_lines[0].service_date = "";
    const model = fitModel([bad], [], NOW);
    expect(model.warnings.some((w) => w.includes("no usable service date"))).toBe(true);
  });

  it("says the never-collected share is a lower bound while the tail is open", () => {
    const { claims, eras } = cohort("P", 15, 20);
    const ancient = claim("P-ancient", "P", 900);
    const model = fitModel([...claims, ancient], eras, NOW);
    expect(model.pooled.tailIsOpen).toBe(true);
    expect(model.warnings.some((w) => w.includes("lower bound"))).toBe(true);
  });

  it("computes a billing pace from the observed window", () => {
    const { claims, eras } = cohort("P", 30, 20, 200);
    const model = fitModel(claims, eras, NOW);
    expect(model.monthlyCharges).toBeGreaterThan(0);
    expect(model.observedDays).toBeGreaterThan(0);
  });

  it("handles no data at all", () => {
    const model = fitModel([], [], NOW);
    expect(model.usable).toBe(false);
    expect(model.payers).toEqual([]);
    expect(renderModel(model)).toContain("Not enough history");
  });
});

describe("renderModel", () => {
  it("explains that outstanding claims are in the fit", () => {
    const { claims, eras } = cohort("P", 30, 20);
    expect(renderModel(fitModel(claims, eras, NOW))).toContain("censored rather than dropped");
  });
});

// ── Scenarios ────────────────────────────────────────────────────────────────

describe("futureAdjustment", () => {
  it("does nothing before the start day", () => {
    const s = scenario({ kind: "drop_payer", payer: "Aetna", startDay: 30 });
    expect(futureAdjustment(s, "Aetna", 29).volume).toBe(1);
    expect(futureAdjustment(s, "Aetna", 30).volume).toBe(0);
  });

  it("touches only the named payer", () => {
    const s = scenario({ kind: "rate_change", payer: "Aetna", change: -0.1 });
    expect(futureAdjustment(s, "Aetna", 5).rate).toBeCloseTo(0.9, 10);
    expect(futureAdjustment(s, "Medicare", 5).rate).toBe(1);
  });

  it("applies to every payer when none is named", () => {
    const s = scenario({ kind: "rate_change", change: -0.03 });
    expect(futureAdjustment(s, "Anyone", 0).rate).toBeCloseTo(0.97, 10);
  });

  it("ramps a new provider rather than switching them on", () => {
    const s = scenario({ kind: "add_provider", productivity: 0.6, startDay: 0, rampDays: 100 });
    expect(futureAdjustment(s, "P", 0).volume).toBeCloseTo(1, 10);
    expect(futureAdjustment(s, "P", 50).volume).toBeCloseTo(1.3, 10);
    expect(futureAdjustment(s, "P", 100).volume).toBeCloseTo(1.6, 10);
    expect(futureAdjustment(s, "P", 500).volume).toBeCloseTo(1.6, 10);
  });

  it("never produces a negative rate or volume", () => {
    expect(futureAdjustment(scenario({ kind: "rate_change", change: -5 }), "P", 0).rate).toBe(0);
    expect(futureAdjustment(scenario({ kind: "volume_change", change: -5 }), "P", 0).volume).toBe(0);
  });
});

describe("checkScenario", () => {
  const model = (() => {
    const { claims, eras } = cohort("Medicare", 20, 25);
    const outstanding = Array.from({ length: 6 }, (_, i) => claim(`Medicare-out-${i}`, "Medicare", 15, 300));
    return fitModel([...claims, ...outstanding], eras, NOW);
  })();

  it("refuses a scenario against a payer that is not in the history", () => {
    const check = checkScenario(scenario({ kind: "drop_payer", payer: "Nobody" }), model);
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toContain("No payer named");
  });

  it("says the in-flight book survives dropping a payer", () => {
    // The correctness point of the whole scenario layer: claims already
    // submitted still pay out, so the forecast shows a tail running dry rather
    // than a cliff that does not exist.
    const check = checkScenario(scenario({ kind: "drop_payer", payer: "Medicare" }), model);
    expect(check.ok).toBe(true);
    expect(check.notes.join(" ")).toContain("NOT cancelled");
    expect(check.notes.join(" ")).toContain("1800.00");
  });

  it("names the gap between hiring and being paid", () => {
    const check = checkScenario(scenario({ kind: "add_provider", productivity: 0.6, rampDays: 60 }), model);
    expect(check.notes.join(" ")).toContain("cash follows");
  });

  it("rejects a provider at zero productivity and a -100% rate", () => {
    expect(checkScenario(scenario({ kind: "add_provider", productivity: 0 }), model).ok).toBe(false);
    expect(checkScenario(scenario({ kind: "rate_change", change: -1 }), model).ok).toBe(false);
  });

  it("says a rate change does not reach claims already adjudicating", () => {
    const check = checkScenario(scenario({ kind: "rate_change", change: -0.03 }), model);
    expect(check.notes.join(" ")).toContain("already in the book");
  });
});

describe("describeScenario", () => {
  it("reads as a sentence", () => {
    expect(describeScenario(BASELINE)).toContain("nothing changes");
    expect(describeScenario(scenario({ kind: "rate_change", change: -0.03 }))).toContain("-3.0%");
    expect(describeScenario(scenario({ kind: "drop_payer", payer: "Aetna" }))).toContain("Aetna");
  });
});

// ── Monte Carlo ──────────────────────────────────────────────────────────────

function testModel() {
  const a = cohort("Medicare", 25, 25, 300);
  const b = cohort("Aetna", 20, 40, 260);
  const outstanding = [
    ...Array.from({ length: 8 }, (_, i) => claim(`Medicare-out-${i}`, "Medicare", 10, 250)),
    ...Array.from({ length: 6 }, (_, i) => claim(`Aetna-out-${i}`, "Aetna", 20, 250)),
  ];
  return fitModel([...a.claims, ...b.claims, ...outstanding], [...a.eras, ...b.eras], NOW);
}

describe("forecast", () => {
  const model = testModel();

  it("is deterministic for a given seed", () => {
    const a = forecast(model, BASELINE, { seed: 7, paths: 60 });
    const b = forecast(model, BASELINE, { seed: 7, paths: 60 });
    expect(a.total.map((x) => x.p50)).toEqual(b.total.map((x) => x.p50));
  });

  it("changes with the seed", () => {
    const a = forecast(model, BASELINE, { seed: 1, paths: 60 });
    const b = forecast(model, BASELINE, { seed: 2, paths: 60 });
    expect(a.total[a.horizonDays].p50).not.toBe(b.total[b.horizonDays].p50);
  });

  it("keeps the percentiles ordered", () => {
    const f = forecast(model, BASELINE, { seed: 3, paths: 120 });
    for (const b of f.total) {
      expect(b.p10).toBeLessThanOrEqual(b.p50);
      expect(b.p50).toBeLessThanOrEqual(b.p90);
    }
  });

  it("accumulates — cash never goes backwards", () => {
    const f = forecast(model, BASELINE, { seed: 4, paths: 80 });
    for (let d = 1; d <= f.horizonDays; d++) {
      expect(f.total[d].p50).toBeGreaterThanOrEqual(f.total[d - 1].p50 - 1e-9);
    }
  });

  it("widens as the horizon lengthens", () => {
    const f = forecast(model, BASELINE, { seed: 5, paths: 200, horizonDays: 120 });
    const early = f.total[30].p90 - f.total[30].p10;
    const late = f.total[120].p90 - f.total[120].p10;
    expect(late).toBeGreaterThan(early);
  });

  it("produces wider bands with a payer shock than without", () => {
    // Independent sampling is what makes a forecast look confident and be
    // wrong: real cash moves in blocks when a payer stops paying, not claim by
    // claim.
    const withShock = forecast(model, BASELINE, { seed: 6, paths: 300, payerShockSd: 0.15 });
    const independent = forecast(model, BASELINE, { seed: 6, paths: 300, payerShockSd: 0 });
    const h = withShock.horizonDays;
    const spread = (f: typeof withShock) => f.total[h].p90 - f.total[h].p10;
    expect(spread(withShock)).toBeGreaterThan(spread(independent));
  });

  it("warns when the shock is switched off", () => {
    const f = forecast(model, BASELINE, { seed: 1, paths: 50, payerShockSd: 0 });
    expect(f.warnings.some((w) => w.includes("independently"))).toBe(true);
  });

  it("always says the bands are a floor rather than a range", () => {
    const f = forecast(model, BASELINE, { seed: 1, paths: 50 });
    expect(f.warnings.some((w) => w.includes("floor on uncertainty"))).toBe(true);
  });

  it("warns when forecasting past the length of the history", () => {
    const f = forecast(model, BASELINE, { seed: 1, paths: 50, horizonDays: 700 });
    expect(f.warnings.some((w) => w.includes("extrapolation"))).toBe(true);
  });

  it("keeps insurance and patient cash apart", () => {
    const f = forecast(model, BASELINE, { seed: 8, paths: 100 });
    const h = f.horizonDays;
    expect(f.insurance[h].p50).toBeGreaterThan(0);
    expect(f.total[h].p50).toBeGreaterThanOrEqual(f.insurance[h].p50);
    expect(f.patientFitted).toBe(true);
  });

  it("scales the patient line with the assumed collection rate", () => {
    const half = forecast(model, BASELINE, { seed: 9, paths: 100, patientCollectionRate: 0.5 });
    const none = forecast(model, BASELINE, { seed: 9, paths: 100, patientCollectionRate: 0 });
    const h = half.horizonDays;
    expect(none.patient[h].p50).toBe(0);
    expect(half.patient[h].p50).toBeGreaterThan(0);
  });
});

describe("scenario forecasts", () => {
  const model = testModel();
  const opts = { seed: 11, paths: 200, horizonDays: 180 };

  it("leaves in-flight receivables alone when a payer is dropped", () => {
    // Cash from that payer must keep arriving for a while. A model that zeroed
    // them on day one would show a cliff that does not happen.
    const dropped = forecast(model, scenario({ kind: "drop_payer", payer: "Medicare" }), opts);
    const base = forecast(model, BASELINE, opts);
    expect(dropped.total[20].p50).toBeGreaterThan(0);
    expect(dropped.total[20].p50 / base.total[20].p50).toBeGreaterThan(0.5);
    // By the horizon the future work is gone, so it falls well behind baseline.
    expect(dropped.total[180].p50).toBeLessThan(base.total[180].p50 * 0.9);
  });

  it("adds a provider as a ramp, not a step", () => {
    const hired = forecast(model, scenario({ kind: "add_provider", productivity: 1, rampDays: 90 }), opts);
    const base = forecast(model, BASELINE, opts);
    const gain = (d: number) => hired.total[d].p50 - base.total[d].p50;
    // Nothing at first — the charges exist but nobody has paid them yet.
    expect(gain(10)).toBeLessThan(gain(90));
    expect(gain(90)).toBeLessThan(gain(180));
  });

  it("cuts cash when rates are cut", () => {
    const cut = forecast(model, scenario({ kind: "rate_change", change: -0.1 }), opts);
    const base = forecast(model, BASELINE, opts);
    expect(cut.total[180].p50).toBeLessThan(base.total[180].p50);
  });

  it("cuts cash when denials rise", () => {
    const worse = forecast(model, scenario({ kind: "denial_rate_change", change: 0.2 }), opts);
    const base = forecast(model, BASELINE, opts);
    expect(worse.total[180].p50).toBeLessThan(base.total[180].p50);
  });
});

describe("compare", () => {
  const model = testModel();
  const opts = { seed: 13, paths: 150, horizonDays: 180 };

  it("finds when a decision starts to bite", () => {
    const c = compare(forecast(model, BASELINE, opts), forecast(model, scenario({ kind: "drop_payer", payer: "Aetna" }), opts));
    expect(c.deltaAtHorizon).toBeLessThan(0);
    expect(c.divergesAtDay).not.toBeNull();
    expect(c.divergesAtDay!).toBeGreaterThan(0);
  });

  it("says outright when a change does nothing on this horizon", () => {
    const base = forecast(model, BASELINE, { ...opts, horizonDays: 30 });
    const later = forecast(model, scenario({ kind: "drop_payer", payer: "Aetna", startDay: 400 }), { ...opts, horizonDays: 30 });
    const c = compare(base, later);
    expect(c.divergesAtDay).toBeNull();
    expect(renderComparison(c)).toContain("does not change cash on this horizon");
  });
});

describe("renderForecast", () => {
  const model = testModel();

  it("shows a range beside every milestone", () => {
    const text = renderForecast(forecast(model, BASELINE, { seed: 1, paths: 80 }));
    expect(text).toContain("P10 / P50 / P90");
    expect(text).toContain("range");
  });

  it("splits the money already billed from the money not yet earned", () => {
    expect(renderForecast(forecast(model, BASELINE, { seed: 1, paths: 80 }))).toContain("already submitted");
  });
});

// ── Patient balances ─────────────────────────────────────────────────────────

describe("scorePropensity", () => {
  it("rates an account that has paid before higher than one that has not", () => {
    const payer = scorePropensity(account({ patientRef: "A", balanceCents: 10000, priorPayments: 3 }));
    const never = scorePropensity(account({ patientRef: "B", balanceCents: 10000 }));
    expect(payer.score).toBeGreaterThan(never.score);
  });

  it("moves monotonically with each input", () => {
    const base = { patientRef: "A", balanceCents: 10000 };
    const score = (over: Record<string, unknown>) => scorePropensity(account({ ...base, ...over })).score;
    expect(score({ priorPayments: 4 })).toBeGreaterThan(score({ priorPayments: 1 }));
    expect(score({ brokenPlans: 2 })).toBeLessThan(score({ brokenPlans: 0 }));
    expect(score({ balanceAgeDays: 200 })).toBeLessThan(score({ balanceAgeDays: 10 }));
  });

  it("stays inside 0 and 1 at the extremes", () => {
    const worst = scorePropensity(
      account({ patientRef: "W", balanceCents: 900000, balanceAgeDays: 900, brokenPlans: 9, statementsSent: 9 }),
    );
    const best = scorePropensity(account({ patientRef: "B", balanceCents: 5000, priorPayments: 20 }));
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(best.score).toBeLessThanOrEqual(1);
  });

  it("explains every factor it used", () => {
    const s = scorePropensity(account({ patientRef: "A", balanceCents: 10000, priorPayments: 2, brokenPlans: 1 }));
    expect(s.factors.length).toBeGreaterThan(1);
    for (const f of s.factors) expect(f.why.length).toBeGreaterThan(20);
  });
});

describe("outreach routing", () => {
  it("holds anything insurance has not finished with, whatever the score", () => {
    // The one rule that overrides everything: that balance is not the patient's
    // yet, and billing it bills them for money the payer may owe.
    const s = scorePropensity(
      account({ patientRef: "A", balanceCents: 50000, insuranceAdjudicated: false, priorPayments: 10 }),
    );
    expect(s.action).toBe("hold_insurance_pending");
    expect(s.reason).toContain("not the patient's balance yet");
  });

  it("writes off a balance too small to chase", () => {
    const s = scorePropensity(account({ patientRef: "A", balanceCents: SMALL_BALANCE_CENTS - 1 }));
    expect(s.action).toBe("small_balance_write_off");
  });

  it("screens a large unscreened balance before demanding it", () => {
    const s = scorePropensity(account({ patientRef: "A", balanceCents: PLAN_THRESHOLD_CENTS + 1 }));
    expect(s.action).toBe("financial_assistance_screening");
  });

  it("offers a plan rather than escalating a low score", () => {
    // A large balance from someone who has never paid is the profile of a
    // person who cannot pay, and reading it as "escalate" gets the answer
    // backwards.
    const s = scorePropensity(
      account({ patientRef: "A", balanceCents: 20000, balanceAgeDays: 200, statementsSent: 4, brokenPlans: 1 }),
    );
    expect(s.score).toBeLessThan(0.45);
    expect(s.action).toBe("payment_plan_offer");
  });

  it("sends an ordinary statement to a reliable account", () => {
    const s = scorePropensity(account({ patientRef: "A", balanceCents: 12000, priorPayments: 3 }));
    expect(s.action).toBe("statement");
  });

  it("leaves an active plan alone", () => {
    expect(scorePropensity(account({ patientRef: "A", balanceCents: 30000, onPaymentPlan: true })).action).toBe(
      "already_on_plan",
    );
  });
});

describe("planOutreach", () => {
  const accounts = [
    account({ patientRef: "P1", balanceCents: 60000 }),
    account({ patientRef: "P2", balanceCents: 15000, insuranceAdjudicated: false }),
    account({ patientRef: "P3", balanceCents: 1000 }),
    account({ patientRef: "P4", balanceCents: 12000, priorPayments: 4 }),
  ];

  it("groups by what to do and totals the money held back", () => {
    const plan = planOutreach(accounts);
    expect(plan.totalBalanceCents).toBe(88000);
    expect(plan.heldForInsuranceCents).toBe(15000);
    expect(plan.byAction.map((a) => a.action)).toContain("financial_assistance_screening");
  });

  it("says why money is being held", () => {
    expect(renderOutreach(planOutreach(accounts))).toContain("not the patients' to owe yet");
  });

  it("states that nothing about who the patient is went into the scores", () => {
    expect(renderOutreach(planOutreach(accounts))).toContain("Nothing about who the patient is");
  });
});

describe("draftPatientLetter", () => {
  const opts = {
    practiceName: "Riverbend Clinic",
    serviceDescription: "An office visit",
    serviceDate: "1 March 2026",
    insurancePaidCents: 8000,
    adjustmentCents: 4000,
    contact: "Call 555-0100, weekdays 9-5.",
  };

  it("says what insurance did and what is left", () => {
    const acct = account({ patientRef: "P1", balanceCents: 12000, priorPayments: 2 });
    const letter = draftPatientLetter(acct, scorePropensity(acct), opts);
    expect(letter).toContain("$80.00");
    expect(letter).toContain("$120.00");
    expect(letter).toContain("not something you owe");
  });

  it("offers a plan when paying at once is unlikely", () => {
    const acct = account({ patientRef: "P1", balanceCents: 60000, financialAssistanceScreened: true });
    const letter = draftPatientLetter(acct, scorePropensity(acct), opts);
    expect(letter).toContain("pay this over time");
    expect(letter).toContain("no interest");
  });

  it("tells the patient assistance exists when nobody has checked", () => {
    const acct = account({ patientRef: "P1", balanceCents: 60000 });
    const letter = draftPatientLetter(acct, scorePropensity(acct), opts);
    expect(letter).toContain("may not have to pay all of this");
    expect(letter).toContain("does not affect your care");
  });

  it("always names the route to dispute it", () => {
    const acct = account({ patientRef: "P1", balanceCents: 12000, priorPayments: 5 });
    const letter = draftPatientLetter(acct, scorePropensity(acct), opts);
    expect(letter).toContain("If this looks wrong");
    expect(letter).toContain("appeal");
  });

  it("keeps its paragraph breaks", () => {
    // The blank lines between a heading and its text are the Markdown, not
    // filler. Filtering empty strings the way the rest of this project filters
    // optional lines collapses the letter into one unreadable block.
    const acct = account({ patientRef: "P1", balanceCents: 12000, priorPayments: 2 });
    const letter = draftPatientLetter(acct, scorePropensity(acct), opts);
    expect(letter).toContain("## What this is for\n\n");
    expect(letter).toContain("\n\n**Your share is");
    expect(letter.split("\n").filter((l) => l === "").length).toBeGreaterThan(8);
  });

  it("puts a currency symbol on every amount it prints", () => {
    const acct = account({ patientRef: "P1", balanceCents: 60000 });
    const letter = draftPatientLetter(acct, scorePropensity(acct), opts);
    for (const amount of letter.match(/(?<![$\d.])\d[\d,]*\.\d{2}/g) ?? []) {
      throw new Error(`amount without a currency symbol: ${amount}`);
    }
    expect(letter).toContain("$600.00");
  });

  it("stays a draft", () => {
    const acct = account({ patientRef: "P1", balanceCents: 12000 });
    expect(draftPatientLetter(acct, scorePropensity(acct), opts)).toContain("Draft — not sent");
  });

  it("carries no threat and no invented deadline", () => {
    const acct = account({ patientRef: "P1", balanceCents: 60000 });
    const letter = draftPatientLetter(acct, scorePropensity(acct), opts).toLowerCase();
    for (const word of ["collection agency", "credit report", "legal action", "final notice", "immediately"]) {
      expect(letter).not.toContain(word);
    }
  });
});

// ── Chart ────────────────────────────────────────────────────────────────────

describe("fan chart", () => {
  const model = testModel();
  const f = forecast(model, BASELINE, { seed: 1, paths: 60, horizonDays: 90 });

  it("draws the band as a closed polygon", () => {
    const svg = fanChartSvg(f);
    expect(svg).toContain("<polygon");
    expect(svg).toContain('class="band"');
    expect(svg).toContain('class="median"');
  });

  it("produces finite coordinates", () => {
    expect(fanChartSvg(f)).not.toMatch(/NaN|Infinity/);
  });

  it("survives a forecast that is entirely zero", () => {
    const empty = forecast(fitModel([], [], NOW), BASELINE, { seed: 1, paths: 10 });
    expect(fanChartSvg(empty)).not.toMatch(/NaN|Infinity/);
  });

  it("writes a self-contained page with no external requests", () => {
    const html = renderFanChart(f, model);
    expect(html).toContain("<!doctype html>");
    expect(html).not.toMatch(/<script|https?:\/\//);
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("says the band is the finding", () => {
    expect(renderFanChart(f, model)).toContain("band is the finding");
  });

  it("escapes text rather than pasting it into the markup", () => {
    const nasty = { ...f, scenario: { ...f.scenario, label: '<img src=x onerror="alert(1)">' } };
    const html = renderFanChart(nasty, model);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
