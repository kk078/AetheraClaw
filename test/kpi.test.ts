import { describe, expect, it } from "vitest";
import {
  DAR_CHARGE_WINDOW_DAYS,
  MIN_CLAIMS_FOR_RATE,
  NCR_SETTLE_DAYS,
  computeCleanClaimRate,
  computeDaysInAr,
  computeNetCollectionRate,
  renderKpis,
  computeExecutiveKpis,
  type AckRecord,
} from "../src/reports/kpi.js";
import { checkRate, payerKey, rateCoverage, rateFor, renderCoverage, type ContractRate } from "../src/tools/healthcare/intelligence/contract.js";
import type { StoredClaim, StoredEra } from "../src/reports/aggregate.js";
import type { ClaimInput } from "../src/tools/healthcare/x12/837.js";
import type { Era } from "../src/tools/healthcare/x12/835.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 1); // 2026-06-01

function ymd(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString().slice(0, 10).replace(/-/g, "");
}

function storedClaim(id: string, charge: number, daysAgo: number): StoredClaim {
  const c: ClaimInput = {
    claim_id: id,
    payer_name: "Medicare",
    payer_id: "MCR",
    billing_provider_npi: "1234567893",
    billing_provider_name: "Clinic",
    subscriber_id: "S1",
    patient_last: "T",
    patient_first: "P",
    patient_dob: "19700101",
    patient_sex: "U",
    diagnoses: ["E11.9"],
    service_lines: [
      { cpt_hcpcs: "99214", charge, units: 1, dx_pointers: [1], service_date: ymd(daysAgo * DAY), place_of_service: "11" },
    ],
  };
  return { claimId: id, payer: "Medicare", claim: c, createdAt: NOW - daysAgo * DAY, status: "submitted" };
}

function storedEra(
  entries: Array<{ id: string; charged: number; paid: number; contractual?: number; denied?: boolean }>,
): StoredEra {
  const era: Era = {
    payer: "Medicare",
    payee: "Clinic",
    checkOrEftAmount: 0,
    claims: entries.map((e) => ({
      claimId: e.id,
      statusCode: e.denied ? "4" : "1",
      charged: e.charged,
      paid: e.paid,
      patientResponsibility: 0,
      payerControlNumber: "P",
      lines: [
        {
          procedure: "99214",
          charged: e.charged,
          paid: e.paid,
          units: 1,
          rarcs: [],
          adjustments: e.contractual ? [{ group: "CO", carc: "45", amount: e.contractual }] : [],
        },
      ],
    })),
  };
  return { era, receivedAt: NOW, payer: "Medicare" };
}

describe("days in A/R", () => {
  it("divides outstanding by average daily charges over the trailing quarter", () => {
    // 91 claims of $100 spanning days 0–90 = $9,100 over a full 90-day window;
    // none adjudicated, so all of it is AR.
    const claims = Array.from({ length: 91 }, (_, i) => storedClaim(`C${i}`, 100, i));
    const r = computeDaysInAr(claims, [], NOW);
    expect(r.chargeWindowDays).toBe(DAR_CHARGE_WINDOW_DAYS);
    // The day-90 claim falls outside the window for charges but stays in AR, so
    // daily charges are $9,000/90 and AR is $9,100 — 91 days, not 90.
    expect(r.averageDailyCharges).toBe(100);
    expect(r.totalAr).toBe(9100);
    expect(r.days).toBe(91);
  });

  it("uses the real history span when shorter than a quarter, and says so", () => {
    // Dividing 30 days of charges by 90 would understate daily volume by two
    // thirds and roughly triple the reported days in AR.
    const claims = Array.from({ length: 30 }, (_, i) => storedClaim(`C${i}`, 100, i));
    const r = computeDaysInAr(claims, [], NOW);
    expect(r.chargeWindowDays).toBeLessThan(DAR_CHARGE_WINDOW_DAYS);
    expect(r.averageDailyCharges).toBeGreaterThan(90);
    expect(r.note).toMatch(/not like-for-like/);
  });

  it("shrinks as claims are adjudicated", () => {
    const claims = Array.from({ length: 90 }, (_, i) => storedClaim(`C${i}`, 100, i));
    const paid = storedEra(claims.slice(0, 45).map((c) => ({ id: c.claimId, charged: 100, paid: 100 })));
    const r = computeDaysInAr(claims, [paid], NOW);
    expect(r.days).toBeLessThan(90);
  });

  it("is undefined rather than zero with no charges", () => {
    const r = computeDaysInAr([], [], NOW);
    expect(r.days).toBeNull();
    expect(r.note).toMatch(/we collect instantly/);
  });
});

describe("clean claim rate — two rates, not one", () => {
  const acks = (n: number, acceptedCount: number): AckRecord[] =>
    Array.from({ length: n }, (_, i) => ({ claimId: `C${i}`, accepted: i < acceptedCount }));

  it("reports acceptance and first-pass payment separately", () => {
    // 24 of 25 accepted up front, but only 15 of 25 paid without a denial: a
    // coding problem a blended number would hide behind a 98% headline.
    const eras = [
      storedEra(
        Array.from({ length: 25 }, (_, i) => ({ id: `C${i}`, charged: 100, paid: i < 15 ? 80 : 0, denied: i >= 15 })),
      ),
    ];
    const r = computeCleanClaimRate(acks(25, 24), eras);
    expect(r.acceptanceRate).toBe(96);
    expect(r.firstPassPaymentRate).toBe(60);
  });

  it("counts only the FIRST outcome per claim", () => {
    // Otherwise fixing a rejection and resubmitting raises the clean claim rate,
    // which rewards exactly the work the metric exists to reduce.
    const records: AckRecord[] = [
      { claimId: "C1", accepted: false },
      { claimId: "C1", accepted: true },
      ...Array.from({ length: 24 }, (_, i) => ({ claimId: `X${i}`, accepted: true })),
    ];
    const r = computeCleanClaimRate(records, []);
    expect(r.acknowledged).toBe(25);
    expect(r.acceptedFirstPass).toBe(24);
  });

  it("normalizes claim ids the way the AR report does", () => {
    const r = computeCleanClaimRate(
      [
        { claimId: " c1 ", accepted: false },
        { claimId: "C1", accepted: true },
      ],
      [],
    );
    expect(r.acknowledged).toBe(1);
  });

  it("withholds a percentage below the sample floor", () => {
    const r = computeCleanClaimRate(acks(5, 5), []);
    expect(r.acceptanceRate).toBeNull();
    expect(r.note).toMatch(new RegExp(`below ${MIN_CLAIMS_FOR_RATE}`));
  });

  it("says acceptance is unmeasurable with no acknowledgments rather than reporting 100%", () => {
    const r = computeCleanClaimRate([], []);
    expect(r.acceptanceRate).toBeNull();
    expect(r.note).toMatch(/ack_parse_277ca/);
  });

  it("does not count a reversal as an adjudication", () => {
    const era = storedEra([{ id: "C1", charged: 100, paid: 100 }]);
    era.era.claims[0].statusCode = "22";
    expect(computeCleanClaimRate([], [era]).adjudicated).toBe(0);
  });
});

describe("net collection rate — settled cohort only", () => {
  const settled = (n: number) =>
    Array.from({ length: n }, (_, i) => storedClaim(`S${i}`, 100, NCR_SETTLE_DAYS + 10 + i));

  it("divides by charges minus contractual, not by charges", () => {
    // $100 charged, $40 written off contractually, $60 collected = 100%, not 60%.
    const claims = settled(25);
    const eras = [storedEra(claims.map((c) => ({ id: c.claimId, charged: 100, paid: 60, contractual: 40 })))];
    const r = computeNetCollectionRate(claims, eras, NOW);
    expect(r.collectable).toBe(1500);
    expect(r.rate).toBe(100);
  });

  it("keeps patient responsibility in the denominator", () => {
    // Excluding it would report a flattering rate for a practice that never
    // chases a patient balance.
    const claims = settled(25);
    const eras = [
      storedEra(claims.map((c) => ({ id: c.claimId, charged: 100, paid: 50, contractual: 20 }))),
    ];
    for (const c of eras[0].era.claims) {
      c.lines[0].adjustments.push({ group: "PR", carc: "1", amount: 30 });
    }
    const r = computeNetCollectionRate(claims, eras, NOW);
    // Collectable is 100-20 = 80, not 100-20-30 = 50.
    expect(r.collectable).toBe(2000);
    expect(r.rate).toBe(62.5);
  });

  it("EXCLUDES claims too recent to have finished paying", () => {
    // The classic error: recent charges are in the denominator, their payments
    // are still in flight, and the rate reads as a disaster.
    const recent = Array.from({ length: 50 }, (_, i) => storedClaim(`R${i}`, 100, 5));
    const claims = [...settled(25), ...recent];
    const eras = [
      storedEra([
        ...claims.slice(0, 25).map((c) => ({ id: c.claimId, charged: 100, paid: 100 })),
        ...recent.map((c) => ({ id: c.claimId, charged: 100, paid: 0 })),
      ]),
    ];
    const r = computeNetCollectionRate(claims, eras, NOW);
    expect(r.claimsMeasured).toBe(25);
    expect(r.rate).toBe(100);
    expect(r.note).toMatch(/old enough to have finished paying/);
  });

  it("refuses rather than reporting a number over an unsettled window", () => {
    const recent = Array.from({ length: 50 }, (_, i) => storedClaim(`R${i}`, 100, 5));
    const eras = [storedEra(recent.map((c) => ({ id: c.claimId, charged: 100, paid: 0 })))];
    const r = computeNetCollectionRate(recent, eras, NOW);
    expect(r.rate).toBeNull();
    expect(r.note).toMatch(/meaninglessly low/);
  });

  it("counts each claim once across duplicate remittances", () => {
    const claims = settled(25);
    const one = storedEra(claims.map((c) => ({ id: c.claimId, charged: 100, paid: 80, contractual: 20 })));
    const r = computeNetCollectionRate(claims, [one, one], NOW);
    expect(r.claimsMeasured).toBe(25);
    expect(r.payments).toBe(2000);
  });
});

describe("KPI rendering", () => {
  it("explains why the two clean claim rates are shown apart", () => {
    const out = renderKpis(computeExecutiveKpis([], [], [], NOW));
    expect(out).toMatch(/two separate rates/);
    expect(out).toMatch(/hides which/);
  });
});

describe("contracted rates", () => {
  const rate = (over: Partial<ContractRate> = {}): ContractRate => ({
    payerKey: payerKey("Aetna"),
    payer: "Aetna",
    code: "99214",
    modifier: "",
    allowed: 120,
    effectiveFrom: "20250101",
    effectiveTo: "",
    source: "PAR agreement Exhibit A",
    ...over,
  });

  it("requires a source, because an untraceable rate cannot support a claim", () => {
    const check = checkRate({ allowed: 120, effectiveFrom: "20250101", effectiveTo: "", code: "99214", source: "" });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/signed schedule/);
  });

  it("requires a well-formed effective date", () => {
    for (const bad of ["2025-01-01", "", "20250199".slice(0, 6)]) {
      const c = checkRate({ allowed: 1, effectiveFrom: bad, effectiveTo: "", code: "X", source: "s" });
      expect(c.ok, bad).toBe(false);
    }
  });

  it("rejects a zero rate as a coverage question rather than a rate", () => {
    const c = checkRate({ allowed: 0, effectiveFrom: "20250101", effectiveTo: "", code: "X", source: "s" });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toMatch(/non-covered/);
  });

  it("rejects an end date before the start", () => {
    const c = checkRate({ allowed: 1, effectiveFrom: "20250601", effectiveTo: "20250101", code: "X", source: "s" });
    expect(c.ok).toBe(false);
  });

  it("selects the rate in force on the DATE OF SERVICE", () => {
    // An amendment is normally why a payment changed; applying the new rate to
    // old claims would report every one of them wrongly.
    const rates = [
      rate({ allowed: 100, effectiveFrom: "20240101", effectiveTo: "20241231" }),
      rate({ allowed: 120, effectiveFrom: "20250101" }),
    ];
    expect(rateFor(rates, { payer: "Aetna", code: "99214", serviceDate: "20240601" })?.allowed).toBe(100);
    expect(rateFor(rates, { payer: "Aetna", code: "99214", serviceDate: "20250601" })?.allowed).toBe(120);
  });

  it("returns nothing when no rate governed that date", () => {
    const rates = [rate({ effectiveFrom: "20250101" })];
    expect(rateFor(rates, { payer: "Aetna", code: "99214", serviceDate: "20240601" })).toBeUndefined();
  });

  it("prefers a modifier-specific rate over the base rate", () => {
    const rates = [rate({ allowed: 120 }), rate({ allowed: 180, modifier: "50" })];
    expect(rateFor(rates, { payer: "Aetna", code: "99214", modifiers: ["50"], serviceDate: "20260101" })?.allowed).toBe(180);
    expect(rateFor(rates, { payer: "Aetna", code: "99214", modifiers: ["25"], serviceDate: "20260101" })?.allowed).toBe(120);
  });

  it("matches payer names only up to case and punctuation", () => {
    const rates = [rate({ payer: "Aetna", payerKey: payerKey("Aetna") })];
    expect(rateFor(rates, { payer: "AETNA", code: "99214", serviceDate: "20260101" })).toBeDefined();
    expect(rateFor(rates, { payer: " aetna ", code: "99214", serviceDate: "20260101" })).toBeDefined();
  });

  it("does NOT fuzzy-match a different payer name onto the same contract", () => {
    // "Aetna" and "Aetna Better Health" are different entities with different
    // fee schedules. A near-match here would apply one contract's rates to
    // another's claims and manufacture underpayments that do not exist.
    const rates = [rate({ payer: "Aetna", payerKey: payerKey("Aetna") })];
    expect(rateFor(rates, { payer: "Aetna Better Health", code: "99214", serviceDate: "20260101" })).toBeUndefined();
    expect(rateFor(rates, { payer: "Aetna, Inc.", code: "99214", serviceDate: "20260101" })).toBeUndefined();
  });

  it("takes the latest amendment when two rates overlap a date", () => {
    const rates = [rate({ allowed: 100, effectiveFrom: "20250101" }), rate({ allowed: 130, effectiveFrom: "20250601" })];
    expect(rateFor(rates, { payer: "Aetna", code: "99214", serviceDate: "20260101" })?.allowed).toBe(130);
  });

  it("reports how much of what was billed the table can speak to", () => {
    // A table covering a fraction of billed codes finds few underpayments and
    // reads as a clean bill of health.
    const coverage = rateCoverage(
      [rate({ code: "99214" })],
      [
        { payer: "Aetna", code: "99214", serviceDate: "20260101" },
        { payer: "Aetna", code: "93000", serviceDate: "20260101" },
      ],
    );
    expect(coverage.codesBilled).toBe(2);
    expect(coverage.codesWithRate).toBe(1);
    expect(coverage.uncovered).toEqual(["93000"]);
    expect(renderCoverage(coverage)).toMatch(/statement about the table, not about the payer/);
  });
});
