import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILING_WINDOWS,
  MEDICARE_EXCEPTION_MONTHS,
  addCalendarYears,
  addDaysYmd,
  filingStatus,
  lastDayOfNthMonthAfter,
  medicareExceptionDeadline,
  payerKey,
  proofGuidance,
  resolveWindow,
  type FilingWindow,
} from "../src/tools/healthcare/prediction/timely-filing.js";
import {
  SHRINKAGE_STRENGTH,
  collectOutcomes,
  indexHistory,
  logit,
  renderRiskScore,
  scoreDenialRisk,
  shrunkRate,
  sigmoid,
  type LineOutcome,
} from "../src/tools/healthcare/prediction/risk.js";
import {
  DEFAULT_RECOVERABILITY,
  MAX_URGENCY,
  RECOVERABILITY_BY_CATEGORY,
  URGENT_WITHIN_DAYS,
  prioritize,
  recoverabilityFor,
  renderQueue,
  urgencyMultiplier,
  type WorkItem,
} from "../src/tools/healthcare/prediction/prioritize.js";
import { CARC } from "../src/tools/healthcare/denial-codes.js";
import type { Era } from "../src/tools/healthcare/x12/835.js";

// A category-key typo is invisible: the lookup misses, the default is returned,
// and the queue still produces a plausible ordering. This table said
// "authorization" and "timely" where the dataset says "prior-auth" and
// "timely-filing", and had no entry for cob, eligibility, bundling or
// documentation — so CARC 197, the most common denial in the set, was ranked on
// a generic guess while a hand-written entry for it sat one key away.
describe("recoverability table matches the CARC dataset", () => {
  const datasetCategories = [...new Set(Object.values(CARC).map((c) => c.category))].sort();

  it("has an entry for every category the dataset uses", () => {
    const missing = datasetCategories.filter((c) => !(c in RECOVERABILITY_BY_CATEGORY));
    expect(missing).toEqual([]);
  });

  it("has no entry the dataset never produces", () => {
    const unused = Object.keys(RECOVERABILITY_BY_CATEGORY).filter((k) => !datasetCategories.includes(k));
    expect(unused).toEqual([]);
  });

  it("resolves real CARCs to their own entry rather than the default", () => {
    for (const carc of ["197", "45", "1", "96", "16", "22", "50"]) {
      expect(recoverabilityFor(carc), `CARC ${carc}`).not.toBe(DEFAULT_RECOVERABILITY);
    }
  });

  it("still falls back for a code the dataset does not carry", () => {
    expect(recoverabilityFor("ZZZ9")).toBe(DEFAULT_RECOVERABILITY);
    expect(recoverabilityFor(undefined)).toBe(DEFAULT_RECOVERABILITY);
  });
});

// ── Filing dates ─────────────────────────────────────────────────────────────

describe("filing date arithmetic", () => {
  it("adds calendar years rather than 365-day blocks", () => {
    // 2024 is a leap year: +365 days from 2024-03-01 lands on 2025-02-28, which
    // would shortchange the deadline by a day.
    expect(addCalendarYears("20240301", 1)).toBe("20250301");
    expect(addDaysYmd("20240301", 365)).toBe("20250301");
    expect(addCalendarYears("20240101", 1)).toBe("20250101");
    expect(addDaysYmd("20240101", 365)).toBe("20241231");
  });

  it("clamps February 29 to February 28 in a non-leap year", () => {
    expect(addCalendarYears("20240229", 1)).toBe("20250228");
    expect(addCalendarYears("20240229", 4)).toBe("20280229");
  });

  it("finds the last day of the sixth month after the notice month", () => {
    expect(lastDayOfNthMonthAfter("20260315", 6)).toBe("20260930");
    expect(lastDayOfNthMonthAfter("20260101", 6)).toBe("20260731");
    // Crossing a year boundary, landing on a February in a leap year.
    expect(lastDayOfNthMonthAfter("20270831", 6)).toBe("20280229");
  });

  it("ignores the day of the month — the extension runs from the month of notice", () => {
    expect(lastDayOfNthMonthAfter("20260301", 6)).toBe(lastDayOfNthMonthAfter("20260331", 6));
  });

  it("uses the six-month rule for Medicare exceptions", () => {
    expect(MEDICARE_EXCEPTION_MONTHS).toBe(6);
    expect(medicareExceptionDeadline("20260315")).toBe("20260930");
  });
});

describe("payer window resolution", () => {
  it("normalizes payer names to a key", () => {
    expect(payerKey("Medicare Part B")).toBe("medicarepartb");
    expect(payerKey("UHC")).toBe("uhc");
  });

  it("matches a payer name containing a known key", () => {
    expect(resolveWindow("Medicare Part B", DEFAULT_FILING_WINDOWS)?.payerKey).toBe("medicare");
    expect(resolveWindow("Cigna HealthCare of Texas", DEFAULT_FILING_WINDOWS)?.payerKey).toBe("cigna");
  });

  it("prefers the more specific key when both match", () => {
    // "Medicare Advantage" contains "medicare"; the longer key must win.
    expect(resolveWindow("Aetna Medicare Advantage HMO", DEFAULT_FILING_WINDOWS)?.payerKey).toBe("medicare_advantage");
  });

  it("returns null for a payer it does not know", () => {
    expect(resolveWindow("Regional Health Co-op", DEFAULT_FILING_WINDOWS)).toBeNull();
  });

  it("gives Medicare a calendar year and commercial payers day counts", () => {
    expect(DEFAULT_FILING_WINDOWS.medicare.calendarYears).toBe(1);
    expect(DEFAULT_FILING_WINDOWS.medicare.days).toBeUndefined();
    expect(DEFAULT_FILING_WINDOWS.uhc.days).toBe(90);
  });

  it("says Medicaid is state-specific rather than presenting a year as fact", () => {
    expect(DEFAULT_FILING_WINDOWS.medicaid.note).toMatch(/State-specific/i);
  });
});

describe("filing status", () => {
  const on = (asOf: string, payer = "Medicare", dos = "20260101") =>
    filingStatus(payer, dos, { asOf });

  it("counts days remaining against a Medicare calendar year", () => {
    const s = on("20260701");
    expect("error" in s).toBe(false);
    if ("error" in s) return;
    expect(s.deadline).toBe("20270101");
    expect(s.daysRemaining).toBe(184);
    expect(s.expired).toBe(false);
    expect(s.severity).toBe("info");
  });

  it("warns inside the last month", () => {
    const s = on("20261220");
    if ("error" in s) throw new Error("unexpected");
    expect(s.severity).toBe("warning");
    expect(s.message).toMatch(/this window is closing/);
  });

  it("reports an expired window and points at the appeal route", () => {
    const s = on("20270301");
    if ("error" in s) throw new Error("unexpected");
    expect(s.expired).toBe(true);
    expect(s.severity).toBe("error");
    expect(s.message).toMatch(/EXPIRED/);
    expect(s.message).toMatch(/CARC 29/);
  });

  it("treats the deadline day itself as still open", () => {
    const s = on("20270101");
    if ("error" in s) throw new Error("unexpected");
    expect(s.daysRemaining).toBe(0);
    expect(s.expired).toBe(false);
  });

  it("accepts a contract override in place of the table", () => {
    const s = filingStatus("Regional Health Co-op", "20260101", { overrideDays: 45, asOf: "20260101" });
    if ("error" in s) throw new Error("unexpected");
    expect(s.deadline).toBe("20260215");
  });

  it("refuses to guess for an unknown payer", () => {
    const s = filingStatus("Regional Health Co-op", "20260101", { asOf: "20260101" });
    expect("error" in s).toBe(true);
    if (!("error" in s)) return;
    expect(s.error).toMatch(/No filing window on file/);
  });

  it("uses a stored override ahead of the seeded window", () => {
    const table: Record<string, FilingWindow> = {
      ...DEFAULT_FILING_WINDOWS,
      uhc: { payerKey: "uhc", label: "UHC", days: 180, note: "From the 2026 contract." },
    };
    const s = filingStatus("UHC", "20260101", { table, asOf: "20260101" });
    if ("error" in s) throw new Error("unexpected");
    expect(s.deadline).toBe("20260630");
  });
});

describe("proof of timely filing", () => {
  it("distinguishes a submission log from an acceptance report", () => {
    const g = proofGuidance(null, "20270101");
    expect(g).toMatch(/ACCEPTANCE report, not a submission report/);
    expect(g).toMatch(/277CA/);
  });

  it("confirms an acceptance dated inside the window", () => {
    const g = proofGuidance(
      { claimId: "C1", acceptedOn: "20260615", payerClaimNumber: "PCN9", source: "277CA acknowledgment" },
      "20270101",
    );
    expect(g).toMatch(/acknowledged this claim on 20260615/);
    expect(g).toMatch(/your proof of timely filing/);
  });

  it("rejects an acceptance dated after the deadline instead of implying it helps", () => {
    const g = proofGuidance(
      { claimId: "C1", acceptedOn: "20270215", payerClaimNumber: "", source: "277CA acknowledgment" },
      "20270101",
    );
    expect(g).toMatch(/does not establish timely filing/);
    expect(g).toMatch(/424\.44\(b\)/);
  });
});

// ── Risk ─────────────────────────────────────────────────────────────────────

describe("shrinkage", () => {
  it("pulls a thin sample toward the prior instead of trusting it", () => {
    // 1 denial in 3 is not a 33% rate.
    expect(shrunkRate(1, 3, 0.05)).toBeCloseTo((1 + 10 * 0.05) / 13, 6);
    expect(shrunkRate(1, 3, 0.05)).toBeLessThan(0.2);
  });

  it("lets a large sample speak for itself", () => {
    const rate = shrunkRate(300, 1000, 0.05);
    expect(rate).toBeGreaterThan(0.28);
    expect(rate).toBeLessThan(0.3);
  });

  it("returns the prior when there is no evidence at all", () => {
    expect(shrunkRate(0, 0, 0.07)).toBe(0.07);
  });

  it("uses a fixed pseudo-observation weight", () => {
    expect(SHRINKAGE_STRENGTH).toBe(10);
  });

  it("round-trips through logit and sigmoid", () => {
    for (const p of [0.01, 0.2, 0.5, 0.9]) expect(sigmoid(logit(p))).toBeCloseTo(p, 9);
  });

  it("clamps logit at the extremes rather than returning infinity", () => {
    expect(Number.isFinite(logit(0))).toBe(true);
    expect(Number.isFinite(logit(1))).toBe(true);
  });
});

const outcome = (payer: string, code: string, denied: boolean, carcs: string[] = []): LineOutcome => ({
  payer,
  code,
  denied,
  carcs,
});

const repeat = (n: number, make: (i: number) => LineOutcome): LineOutcome[] =>
  Array.from({ length: n }, (_, i) => make(i));

describe("denial risk scoring", () => {
  it("says plainly when there is no history to predict from", () => {
    const s = scoreDenialRisk({ payer: "ACME", codes: ["99213"] }, indexHistory([]));
    expect(s.historySize).toBe(0);
    expect(s.notes[0]).toMatch(/bare default rather than a prediction/);
    expect(s.factors).toEqual([]);
  });

  it("raises the estimate for a code this payer denies often", () => {
    const history = [
      ...repeat(40, () => outcome("ACME", "99213", false)),
      ...repeat(30, () => outcome("ACME", "20610", true)),
      ...repeat(10, () => outcome("ACME", "20610", false)),
    ];
    const index = indexHistory(history);
    const risky = scoreDenialRisk({ payer: "ACME", codes: ["20610"] }, index);
    const safe = scoreDenialRisk({ payer: "ACME", codes: ["99213"] }, index);
    expect(risky.probability).toBeGreaterThan(safe.probability);
    expect(risky.band).toBe("HIGH");
  });

  it("reports each factor's contribution in percentage points", () => {
    const index = indexHistory([
      ...repeat(50, () => outcome("ACME", "99213", false)),
      ...repeat(20, () => outcome("ACME", "20610", true)),
    ]);
    const s = scoreDenialRisk({ payer: "ACME", codes: ["20610"] }, index);
    expect(s.factors.length).toBeGreaterThan(0);
    expect(s.factors[0].points).toBeGreaterThan(0);
    expect(s.factors[0].detail).toMatch(/after shrinkage/);
  });

  it("marks a factor built on few observations as thin", () => {
    const index = indexHistory([
      ...repeat(60, () => outcome("ACME", "99213", false)),
      outcome("ACME", "20610", true),
      outcome("ACME", "20610", true),
    ]);
    const s = scoreDenialRisk({ payer: "ACME", codes: ["20610"] }, index);
    expect(s.factors.some((f) => f.thin)).toBe(true);
    expect(s.notes.join(" ")).toMatch(/thin/);
  });

  it("does not let two denials out of two read as certain denial", () => {
    const index = indexHistory([
      ...repeat(60, () => outcome("ACME", "99213", false)),
      outcome("ACME", "20610", true),
      outcome("ACME", "20610", true),
    ]);
    const s = scoreDenialRisk({ payer: "ACME", codes: ["20610"] }, index);
    expect(s.probability).toBeLessThan(0.35);
  });

  it("does not count nested evidence twice", () => {
    // "20610 with ACME" and "20610 everywhere" are the SAME two claims when
    // there is one payer. Summing their log-odds as independent evidence turned
    // a 19% shrunk rate into 63%; the levels are nested and back off instead.
    const index = indexHistory([
      ...repeat(60, () => outcome("ACME", "99213", false)),
      outcome("ACME", "20610", true),
      outcome("ACME", "20610", true),
    ]);
    const s = scoreDenialRisk({ payer: "ACME", codes: ["20610"] }, index);
    expect(s.probability).toBeCloseTo(shrunkRate(2, 2, s.baseRate), 1);
  });

  it("reports factor contributions that sum to the movement off the baseline", () => {
    const index = indexHistory([
      ...repeat(40, () => outcome("ACME", "99213", false)),
      ...repeat(30, () => outcome("ACME", "20610", true)),
      ...repeat(10, () => outcome("ACME", "20610", false)),
    ]);
    const s = scoreDenialRisk({ payer: "ACME", codes: ["20610"] }, index);
    const summed = s.factors.reduce((total, f) => total + f.points, 0);
    expect(summed).toBeCloseTo((s.probability - s.baseRate) * 100, 6);
  });

  it("scores the riskiest line on a multi-line claim, not the average", () => {
    const index = indexHistory([
      ...repeat(40, () => outcome("ACME", "99213", false)),
      ...repeat(30, () => outcome("ACME", "20610", true)),
      ...repeat(10, () => outcome("ACME", "20610", false)),
    ]);
    const alone = scoreDenialRisk({ payer: "ACME", codes: ["20610"] }, index);
    const together = scoreDenialRisk({ payer: "ACME", codes: ["99213", "20610"] }, index);
    expect(together.probability).toBe(alone.probability);
    expect(together.notes.join(" ")).toMatch(/riskiest line/);
  });

  it("lowers risk when an authorization removes the dominant historical cause", () => {
    const history = [
      ...repeat(40, () => outcome("ACME", "99213", false)),
      ...repeat(6, () => outcome("ACME", "J0135", true, ["197"])),
    ];
    const index = indexHistory(history);
    const withAuth = scoreDenialRisk({ payer: "ACME", codes: ["J0135"], hasPriorAuth: true }, index);
    const without = scoreDenialRisk({ payer: "ACME", codes: ["J0135"], hasPriorAuth: false }, index);
    expect(withAuth.probability).toBeLessThan(without.probability);
    expect(withAuth.factors.some((f) => f.label.match(/Authorization confirmed/))).toBe(true);
  });

  it("does not stack an authorization penalty on denials already in the rate", () => {
    // The six denials that make J0135 look risky ARE the authorization denials.
    // Bumping for "no auth" on top of them counted the same claims twice and
    // pushed a six-observation cell to 96%.
    const index = indexHistory([
      ...repeat(40, () => outcome("ACME", "99213", false)),
      ...repeat(6, () => outcome("ACME", "J0135", true, ["197"])),
    ]);
    const without = scoreDenialRisk({ payer: "ACME", codes: ["J0135"], hasPriorAuth: false }, index);
    const unstated = scoreDenialRisk({ payer: "ACME", codes: ["J0135"] }, index);
    expect(without.probability).toBe(unstated.probability);
    expect(without.probability).toBeLessThan(0.75);
    expect(without.notes.join(" ")).toMatch(/dominant historical cause applies here/);
  });

  it("asks for the authorization status rather than assuming it when unstated", () => {
    const index = indexHistory([
      ...repeat(40, () => outcome("ACME", "99213", false)),
      ...repeat(6, () => outcome("ACME", "J0135", true, ["197"])),
    ]);
    const s = scoreDenialRisk({ payer: "ACME", codes: ["J0135"] }, index);
    expect(s.notes.join(" ")).toMatch(/Pass has_prior_auth/);
  });

  it("keeps the probability below certainty", () => {
    const index = indexHistory(repeat(500, () => outcome("ACME", "20610", true)));
    expect(scoreDenialRisk({ payer: "ACME", codes: ["20610"] }, index).probability).toBeLessThanOrEqual(0.97);
  });

  it("renders the baseline and the factor list", () => {
    const index = indexHistory([
      ...repeat(50, () => outcome("ACME", "99213", false)),
      ...repeat(20, () => outcome("ACME", "20610", true)),
    ]);
    const out = renderRiskScore(scoreDenialRisk({ payer: "ACME", codes: ["20610"] }, index));
    expect(out).toMatch(/practice baseline/);
    expect(out).toMatch(/What moved it:/);
  });
});

const era = (payer: string, statusCode: string, lines: Array<{ procedure: string; paid: number; adjustments: Array<{ group: string; carc: string; amount: number }> }>): { era: Era } => ({
  era: {
    payer,
    payee: "CLINIC",
    checkOrEftAmount: 0,
    claims: [
      {
        claimId: "C1",
        statusCode,
        charged: 100,
        paid: 0,
        patientResponsibility: 0,
        payerControlNumber: "PCN",
        lines: lines.map((l) => ({ ...l, charged: 100, units: 1, rarcs: [] })),
      },
    ],
  } as Era,
});

describe("outcome collection from remittances", () => {
  it("marks every line of a denied claim as denied", () => {
    const o = collectOutcomes([era("ACME", "4", [{ procedure: "HC:99213", paid: 0, adjustments: [] }])]);
    expect(o[0].denied).toBe(true);
  });

  it("marks a zero-paid line denied even when the claim paid overall", () => {
    const o = collectOutcomes([
      era("ACME", "1", [{ procedure: "HC:20610", paid: 0, adjustments: [{ group: "CO", carc: "97", amount: 100 }] }]),
    ]);
    expect(o[0].denied).toBe(true);
  });

  it("does not call a line denied when the patient owes the whole amount", () => {
    // A deductible line pays zero but is not a denial.
    const o = collectOutcomes([
      era("ACME", "1", [{ procedure: "HC:99213", paid: 0, adjustments: [{ group: "PR", carc: "1", amount: 100 }] }]),
    ]);
    expect(o[0].denied).toBe(false);
  });

  it("strips modifiers off the procedure and skips the synthetic claim-level line", () => {
    const o = collectOutcomes([
      era("ACME", "1", [
        { procedure: "(claim level)", paid: 0, adjustments: [] },
        { procedure: "HC:99214:25", paid: 80, adjustments: [] },
      ]),
    ]);
    expect(o).toHaveLength(1);
    expect(o[0].code).toBe("99214");
  });

  it("indexes prior-authorization denials by payer and code", () => {
    const index = indexHistory(
      collectOutcomes([
        era("ACME", "4", [{ procedure: "HC:J0135", paid: 0, adjustments: [{ group: "CO", carc: "197", amount: 100 }] }]),
      ]),
    );
    expect(index.priorAuthSeen.get("ACME|J0135")?.n).toBe(1);
  });
});

// ── Prioritization ───────────────────────────────────────────────────────────

describe("recoverability priors", () => {
  it("rates a registration error as quick and highly recoverable", () => {
    const r = recoverabilityFor("16");
    expect(r.probability).toBeGreaterThan(0.7);
    expect(r.effortHours).toBeLessThan(0.5);
  });

  it("rates a medical-necessity denial as slow and uncertain", () => {
    const r = recoverabilityFor("50");
    expect(r.probability).toBeLessThan(0.5);
    expect(r.effortHours).toBeGreaterThan(1);
  });

  it("says a patient-responsibility line is not an appeal at all", () => {
    expect(recoverabilityFor("2").action).toMatch(/patient's balance/);
  });

  it("routes a timely-filing denial to the proof question", () => {
    expect(recoverabilityFor("29").action).toMatch(/acceptance report, not a submission log/);
  });

  it("falls back rather than guessing for an unknown code", () => {
    expect(recoverabilityFor("99999").action).toMatch(/not in the bundled dataset/);
    expect(recoverabilityFor(undefined).probability).toBeGreaterThan(0);
  });
});

describe("urgency", () => {
  it("stays flat while the deadline is far off", () => {
    expect(urgencyMultiplier(90)).toBe(1);
    expect(urgencyMultiplier(URGENT_WITHIN_DAYS)).toBe(1);
  });

  it("rises as the deadline approaches", () => {
    expect(urgencyMultiplier(7)).toBe(2);
    expect(urgencyMultiplier(2)).toBe(7);
  });

  it("caps rather than running away", () => {
    expect(urgencyMultiplier(1)).toBe(MAX_URGENCY);
    expect(urgencyMultiplier(0)).toBe(MAX_URGENCY);
  });

  it("treats an item with no deadline as not urgent", () => {
    expect(urgencyMultiplier(null)).toBe(1);
  });
});

const NOW = Date.UTC(2026, 7, 7);
const days = (n: number) => NOW + n * 86_400_000;

const work = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: "wl_1",
  kind: "denial",
  title: "Denied claim",
  amountCents: 100_00,
  carc: "16",
  payer: "ACME",
  dueAt: days(60),
  createdAt: NOW,
  ...over,
});

describe("worklist prioritization", () => {
  it("does not let a near deadline outrank a far larger item that will also get worked", () => {
    // Both are ten-minute fixes, so both get done today and taking the $5,000
    // one first costs nothing. Letting urgency win here would thrash on pennies.
    const { queue, atRisk } = prioritize(
      [
        work({ id: "big", amountCents: 500_000, dueAt: days(90) }),
        work({ id: "urgent", amountCents: 5_000, dueAt: days(1) }),
      ],
      { now: NOW },
    );
    expect(queue[0].item.id).toBe("big");
    expect(atRisk).toEqual([]);
  });

  it("breaks a tie in favour of the nearer deadline", () => {
    const { queue } = prioritize(
      [work({ id: "later", dueAt: days(90) }), work({ id: "sooner", dueAt: days(2) })],
      { now: NOW },
    );
    expect(queue[0].item.id).toBe("sooner");
  });

  it("names the items the queue will not reach before they expire", () => {
    // Twelve two-hour appeals ahead of it at four hours a day is six days of
    // work, so a three-day deadline behind them will be missed.
    const ahead = Array.from({ length: 12 }, (_, i) =>
      work({ id: `big${i}`, amountCents: 900_000, carc: "50", dueAt: days(120) }),
    );
    const { atRisk } = prioritize([...ahead, work({ id: "squeezed", amountCents: 1_000, dueAt: days(3) })], {
      now: NOW,
      hoursPerDay: 4,
    });
    expect(atRisk.map((s) => s.item.id)).toEqual(["squeezed"]);
  });

  it("flags nothing when the queue comfortably fits inside every deadline", () => {
    const { atRisk } = prioritize(
      [work({ id: "a", dueAt: days(30) }), work({ id: "b", dueAt: days(30) })],
      { now: NOW, hoursPerDay: 4 },
    );
    expect(atRisk).toEqual([]);
  });

  it("tells the reader to pull at-risk items forward", () => {
    const ahead = Array.from({ length: 12 }, (_, i) =>
      work({ id: `big${i}`, amountCents: 900_000, carc: "50", dueAt: days(120) }),
    );
    const out = renderQueue(
      prioritize([...ahead, work({ id: "squeezed", amountCents: 1_000, dueAt: days(3) })], {
        now: NOW,
        hoursPerDay: 4,
      }),
    );
    expect(out).toMatch(/PULL FORWARD/);
    expect(out).toMatch(/squeezed/);
  });

  it("prefers the larger item when both have the same runway", () => {
    const { queue } = prioritize(
      [work({ id: "small", amountCents: 5_000 }), work({ id: "big", amountCents: 500_000 })],
      { now: NOW },
    );
    expect(queue[0].item.id).toBe("big");
  });

  it("prefers the quick fix over the slow appeal at equal dollars", () => {
    const { queue } = prioritize(
      [
        work({ id: "necessity", carc: "50" }),
        work({ id: "registration", carc: "16" }),
      ],
      { now: NOW },
    );
    expect(queue[0].item.id).toBe("registration");
  });

  it("discounts the face amount by how often that reason is recovered", () => {
    const { queue } = prioritize([work({ amountCents: 100_00, carc: "16" })], { now: NOW });
    expect(queue[0].amount).toBe(100);
    expect(queue[0].expectedRecovery).toBe(85);
  });

  it("pulls expired items out of the queue entirely", () => {
    const { queue, expired } = prioritize(
      [work({ id: "dead", dueAt: days(-5) }), work({ id: "live" })],
      { now: NOW },
    );
    expect(queue.map((s) => s.item.id)).toEqual(["live"]);
    expect(expired.map((s) => s.item.id)).toEqual(["dead"]);
  });

  it("keeps items with no deadline in the queue", () => {
    const { queue, expired } = prioritize([work({ dueAt: null })], { now: NOW });
    expect(queue).toHaveLength(1);
    expect(expired).toHaveLength(0);
    expect(queue[0].daysRemaining).toBeNull();
  });

  it("ranks a contractual adjustment last, since there is nothing to recover", () => {
    const { queue } = prioritize(
      [work({ id: "contractual", carc: "45" }), work({ id: "real", carc: "16" })],
      { now: NOW },
    );
    expect(queue[queue.length - 1].item.id).toBe("contractual");
  });

  it("accepts per-CARC overrides learned from actual outcomes", () => {
    const overrides = new Map([["16", { probability: 0.1, effortHours: 3, action: "Rarely works here." }]]);
    const { queue } = prioritize([work({ carc: "16", amountCents: 100_00 })], { now: NOW, overrides });
    expect(queue[0].expectedRecovery).toBe(10);
    expect(queue[0].action).toBe("Rarely works here.");
  });

  it("totals expected recovery separately from face value", () => {
    const out = renderQueue(
      prioritize([work({ amountCents: 100_00, carc: "16" }), work({ id: "wl_2", amountCents: 100_00, carc: "50" })], {
        now: NOW,
      }),
    );
    expect(out).toMatch(/\$200\.00 denied/);
    expect(out).toMatch(/\$125\.00 expected/);
  });

  it("tells the reader not to work past-deadline items on the merits", () => {
    const out = renderQueue(prioritize([work({ dueAt: days(-5) })], { now: NOW }));
    expect(out).toMatch(/PAST DEADLINE/);
    expect(out).toMatch(/Do not work these on the merits/);
    expect(out).toMatch(/acceptance report as proof/);
  });

  it("marks an item due today rather than burying it", () => {
    const out = renderQueue(prioritize([work({ dueAt: days(0) })], { now: NOW }));
    expect(out).toMatch(/DUE TODAY/);
  });

  it("says the recovery rates are estimates, not measurements", () => {
    expect(renderQueue(prioritize([work()], { now: NOW }))).toMatch(/coarse per-category starting estimates/);
  });

  it("reports an empty worklist plainly", () => {
    expect(renderQueue(prioritize([], { now: NOW }))).toBe("Worklist is empty.");
  });
});
