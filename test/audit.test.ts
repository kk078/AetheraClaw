import { describe, expect, it } from "vitest";
import {
  ADR_RESPONSE_DAYS,
  addDays,
  adrDeadline,
  appealDeadline,
  appealLadder,
  nextCms838Due,
  recoupmentTimeline,
  refundDeadline,
} from "../src/tools/healthcare/audit/deadlines.js";
import { defaultResponseDays } from "../src/tools/healthcare/audit/audit-tracker.js";
import {
  baseCode,
  computeEmDistribution,
  emLevel,
  familyOf,
  paidEmCodesByClaim,
  renderDistribution,
  MIN_SAMPLE_FOR_OUTLIER,
  type SubmittedClaimRecord,
} from "../src/tools/healthcare/audit/em-benchmark.js";
import { detectCreditBalances } from "../src/tools/healthcare/audit/credit-balance.js";
import type { Era, EraClaim, EraServiceLine } from "../src/tools/healthcare/x12/835.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const svc = (over: Partial<EraServiceLine> = {}): EraServiceLine => ({
  procedure: "99213",
  charged: 120,
  paid: 100,
  units: 1,
  adjustments: [],
  rarcs: [],
  ...over,
});

const clp = (over: Partial<EraClaim> = {}): EraClaim => ({
  claimId: "C1",
  statusCode: "1",
  charged: 120,
  paid: 100,
  patientResponsibility: 20,
  payerControlNumber: "PCN1",
  lines: [svc()],
  ...over,
});

const era = (over: Partial<Era> = {}): Era => ({
  payer: "ACME",
  payee: "CLINIC",
  checkOrEftAmount: 100,
  claims: [clp()],
  ...over,
});

const submittedClaim = (over: Partial<SubmittedClaimRecord> = {}): SubmittedClaimRecord => ({
  claimId: "C1",
  renderingProviderNpi: "1234567893",
  serviceDate: "20250601",
  codes: ["99213"],
  ...over,
});

// ── deadline math ────────────────────────────────────────────────────────────

describe("date arithmetic", () => {
  it("adds days across a month boundary", () => {
    expect(addDays("20250601", 45)).toBe("20250716");
  });
  it("adds days across a year boundary", () => {
    expect(addDays("20251215", 30)).toBe("20260114");
  });
  it("handles a leap day correctly", () => {
    expect(addDays("20240228", 1)).toBe("20240229");
    expect(addDays("20240228", 2)).toBe("20240301");
  });
  it("rejects a malformed date", () => {
    expect(() => addDays("2025-06-01", 1)).toThrow(/invalid date/);
  });
});

describe("documentation response deadline", () => {
  it("is 45 days from the request by default", () => {
    const d = adrDeadline("20250601", undefined, "20250601");
    expect(d.dueDate).toBe("20250716");
    expect(d.daysRemaining).toBe(ADR_RESPONSE_DAYS);
    expect(d.overdue).toBe(false);
  });
  it("reports overdue with a negative countdown", () => {
    const d = adrDeadline("20250101", undefined, "20250601");
    expect(d.overdue).toBe(true);
    expect(d.daysRemaining).toBeLessThan(0);
  });
  it("honours a window stated on the notice", () => {
    expect(adrDeadline("20250601", 30, "20250601").dueDate).toBe("20250701");
  });
  it("defaults commercial audits to a shorter window than Medicare contractors", () => {
    expect(defaultResponseDays("RAC")).toBe(45);
    expect(defaultResponseDays("MAC_ADR")).toBe(45);
    expect(defaultResponseDays("commercial")).toBe(30);
  });
});

describe("Medicare appeal ladder", () => {
  it("gives redetermination 120 days from the initial determination", () => {
    const d = appealDeadline(1, "20250601", "20250601");
    expect(d.daysRemaining).toBe(120);
    expect(d.dueDate).toBe("20250929");
    expect(d.label).toMatch(/Redetermination/);
  });
  it("gives reconsideration 180 days", () => {
    expect(appealDeadline(2, "20250601", "20250601").daysRemaining).toBe(180);
  });
  it("gives ALJ, Council, and judicial review 60 days each", () => {
    for (const level of [3, 4, 5] as const) {
      expect(appealDeadline(level, "20250601", "20250601").daysRemaining).toBe(60);
    }
  });
  it("flags a missed appeal window", () => {
    expect(appealDeadline(1, "20240101", "20250601").overdue).toBe(true);
  });
  it("dates only the level whose clock has started", () => {
    const ladder = appealLadder("20250601", 1, "20250601");
    expect(ladder).toHaveLength(5);
    expect(ladder[0].dueDate).toBe("20250929");
    expect(ladder[1].dueDate).toBe("");
    expect(ladder[1].note).toMatch(/clock starts/);
  });
  it("starts the ladder at a later level when earlier ones are decided", () => {
    const ladder = appealLadder("20250601", 3, "20250601");
    expect(ladder).toHaveLength(3);
    expect(ladder[0].label).toMatch(/ALJ/);
  });
});

describe("recoupment timeline (MMA 935)", () => {
  const rc = recoupmentTimeline("20250601", "20250601");
  it("stays recoupment if redetermination is filed by day 30", () => {
    expect(rc.stayByRedetermination.daysRemaining).toBe(30);
    expect(rc.stayByRedetermination.dueDate).toBe("20250701");
  });
  it("starts recoupment on day 41", () => {
    expect(rc.recoupmentBegins.daysRemaining).toBe(41);
    expect(rc.recoupmentBegins.dueDate).toBe("20250712");
  });
  it("explains the second-level 60-day stay", () => {
    expect(rc.stayByReconsiderationNote).toMatch(/day 60/);
    expect(rc.stayByReconsiderationNote).toMatch(/reconsideration/i);
  });
});

describe("ACA report-and-return clock", () => {
  it("runs 60 days from identification, not from payment", () => {
    const d = refundDeadline("20250601", "20250601");
    expect(d.daysRemaining).toBe(60);
    expect(d.dueDate).toBe("20250731");
    expect(d.note).toMatch(/IDENTIFICATION/);
  });
  it("flags overdue balances", () => {
    const d = refundDeadline("20250101", "20250601");
    expect(d.overdue).toBe(true);
  });
  it("is a different rule from the 935 recoupment window", () => {
    // Same number, unrelated clocks — anchored on different dates entirely.
    const refund = refundDeadline("20250601", "20250601");
    const recoup = recoupmentTimeline("20250601", "20250601");
    expect(refund.dueDate).not.toBe(recoup.recoupmentBegins.dueDate);
    expect(refund.label).toMatch(/overpayment/i);
  });
});

describe("CMS-838 quarterly report", () => {
  it("targets 30 days after the current quarter closes", () => {
    const d = nextCms838Due("20250210");
    expect(d.dueDate).toBe("20250430"); // Q1 ends Mar 31
  });
  it("rolls to the next quarter once a deadline passes", () => {
    const d = nextCms838Due("20250501");
    expect(d.dueDate).toBe("20250730"); // Q2 ends Jun 30
  });
  it("carries the Q4 report into January of the following year", () => {
    const d = nextCms838Due("20251231");
    expect(d.dueDate).toBe("20260130");
    expect(d.label).toMatch(/2025-12-31/);
  });
  it("moves to the next year's Q1 once the Q4 deadline passes", () => {
    const d = nextCms838Due("20260201");
    expect(d.dueDate).toBe("20260430");
    expect(d.label).toMatch(/2026-03-31/);
  });
});

// ── E/M benchmarking ─────────────────────────────────────────────────────────

describe("E/M code helpers", () => {
  it("strips modifiers from the ERA service composite", () => {
    expect(baseCode("99214:25")).toBe("99214");
    expect(baseCode("99213")).toBe("99213");
  });
  it("reads the level from the last digit", () => {
    expect(emLevel("99213")).toBe(3);
    expect(emLevel("99205")).toBe(5);
  });
  it("classifies new vs established families", () => {
    expect(familyOf("99204")).toBe("new");
    expect(familyOf("99214")).toBe("established");
    expect(familyOf("27447")).toBeNull();
  });
});

describe("paid E/M extraction from remittances", () => {
  it("keeps modifier-suffixed codes and skips claim-level adjustment lines", () => {
    const eras = [
      {
        era: era({
          claims: [
            clp({
              claimId: "C9",
              lines: [
                svc({ procedure: "99214:25" }),
                { procedure: "(claim level)", charged: 0, paid: 0, units: 0, adjustments: [], rarcs: [] },
              ],
            }),
          ],
        }),
      },
    ];
    expect(paidEmCodesByClaim(eras).get("C9")).toEqual(["99214"]);
  });
  it("ignores non-E/M procedures", () => {
    const eras = [{ era: era({ claims: [clp({ claimId: "C8", lines: [svc({ procedure: "27447" })] })] }) }];
    expect(paidEmCodesByClaim(eras).has("C8")).toBe(false);
  });
});

describe("E/M distribution", () => {
  const many = (code: string, n: number, npi = "1234567893"): SubmittedClaimRecord[] =>
    Array.from({ length: n }, (_, i) => submittedClaim({ claimId: `${code}-${i}`, codes: [code], renderingProviderNpi: npi }));

  it("computes per-level shares and the weighted average", () => {
    const dist = computeEmDistribution([...many("99213", 50), ...many("99214", 50)], []);
    const est = dist.families.find((f) => f.family === "established")!;
    expect(est.total).toBe(100);
    expect(est.levels.find((l) => l.code === "99213")!.pct).toBe(50);
    expect(est.weightedAverageLevel).toBeCloseTo(3.5, 5);
    expect(est.highLevelConcentrationPct).toBe(50);
  });

  it("flags a level far above benchmark once the sample is large enough", () => {
    const dist = computeEmDistribution(many("99214", 100), [], { "99214": 40, "99213": 40 });
    const l = dist.families.find((f) => f.family === "established")!.levels.find((x) => x.code === "99214")!;
    expect(l.deviationPp).toBeCloseTo(60, 5);
    expect(l.outlier).toBe(true);
  });

  it("withholds the outlier flag on a small sample", () => {
    const n = MIN_SAMPLE_FOR_OUTLIER - 1;
    const dist = computeEmDistribution(many("99214", n), [], { "99214": 40 });
    const l = dist.families.find((f) => f.family === "established")!.levels.find((x) => x.code === "99214")!;
    expect(l.deviationPp).toBeGreaterThan(10);
    expect(l.outlier).toBe(false);
  });

  it("reports no outlier when the curve matches benchmark", () => {
    const dist = computeEmDistribution([...many("99213", 60), ...many("99214", 40)], [], { "99213": 60, "99214": 40 });
    expect(dist.families.every((f) => f.levels.every((l) => !l.outlier))).toBe(true);
  });

  it("breaks down by rendering provider, highest average level first", () => {
    const dist = computeEmDistribution([...many("99215", 10, "NPI_HIGH"), ...many("99212", 10, "NPI_LOW")], []);
    expect(dist.byProvider[0].npi).toBe("NPI_HIGH");
    expect(dist.byProvider[0].weightedAverageLevel).toBe(5);
    expect(dist.byProvider[1].weightedAverageLevel).toBe(2);
  });

  it("falls back to remittance data when no claims are recorded", () => {
    const eras = [{ era: era({ claims: [clp({ claimId: "C1", lines: [svc({ procedure: "99215" })] })] }) }];
    const dist = computeEmDistribution([], eras);
    expect(dist.totalEmServices).toBe(1);
    expect(dist.byProvider).toHaveLength(0);
  });

  it("detects payer downcoding against the submitted level", () => {
    const submitted = [submittedClaim({ claimId: "C1", codes: ["99214"] })];
    const eras = [{ era: era({ claims: [clp({ claimId: "C1", lines: [svc({ procedure: "99213" })] })] }) }];
    const dist = computeEmDistribution(submitted, eras);
    expect(dist.downcoding).toEqual({ compared: 1, downcoded: 1, upcoded: 0, ratePct: 100 });
  });

  it("reports no downcoding when paid matches submitted", () => {
    const submitted = [submittedClaim({ claimId: "C1", codes: ["99213"] })];
    const eras = [{ era: era({ claims: [clp({ claimId: "C1" })] }) }];
    expect(computeEmDistribution(submitted, eras).downcoding).toEqual({
      compared: 1,
      downcoded: 0,
      upcoded: 0,
      ratePct: 0,
    });
  });

  it("leaves downcoding null when nothing is comparable", () => {
    expect(computeEmDistribution([submittedClaim()], []).downcoding).toBeNull();
  });

  it("renders an empty-data message rather than fake numbers", () => {
    expect(renderDistribution(computeEmDistribution([], []), "none")).toMatch(/No E\/M services found/);
  });

  it("says so in the rendered report when the sample is too small to judge", () => {
    const out = renderDistribution(computeEmDistribution(many("99214", 5), [], { "99214": 40 }), "test");
    expect(out).toMatch(new RegExp(`n < ${MIN_SAMPLE_FOR_OUTLIER}`));
  });
});

// ── credit balance detection ─────────────────────────────────────────────────

describe("overpayment detection", () => {
  it("finds a claim paid twice under different payer control numbers", () => {
    const eras = [
      { payer: "ACME", era: era({ claims: [clp({ claimId: "C1", payerControlNumber: "PCN1", paid: 100 })] }) },
      { payer: "ACME", era: era({ claims: [clp({ claimId: "C1", payerControlNumber: "PCN2", paid: 100 })] }) },
    ];
    const found = detectCreditBalances(eras);
    const dup = found.find((c) => c.kind === "duplicate_payment");
    expect(dup).toBeDefined();
    expect(dup!.claimId).toBe("C1");
    expect(dup!.amountCents).toBe(10_000);
  });

  it("treats a re-parsed remittance as a re-parse, not an overpayment", () => {
    // era_parse_835 does not dedupe, so the same file parsed twice must not
    // masquerade as a duplicate payment.
    const same = () => era({ claims: [clp({ claimId: "C1", payerControlNumber: "PCN1", paid: 100 })] });
    const found = detectCreditBalances([
      { payer: "ACME", era: same() },
      { payer: "ACME", era: same() },
    ]);
    expect(found.some((c) => c.kind === "duplicate_payment")).toBe(false);
    const reparse = found.find((c) => c.kind === "likely_reparse");
    expect(reparse).toBeDefined();
    expect(reparse!.detail).toMatch(/parsed more than once/);
    expect(reparse!.amountCents).toBe(0); // a re-parse is not money owed
  });

  it("reports a real duplicate even when one remittance was also re-parsed", () => {
    // Control numbers A, B, A: a genuine second payment AND a re-parse of the
    // first. Collapsing this to "just a re-parse" would hide a real overpayment.
    const payment = (pcn: string) =>
      era({ claims: [clp({ claimId: "C1", payerControlNumber: pcn, paid: 100 })] });
    const found = detectCreditBalances([
      { payer: "ACME", era: payment("PCN-A") },
      { payer: "ACME", era: payment("PCN-B") },
      { payer: "ACME", era: payment("PCN-A") },
    ]);
    const dup = found.find((c) => c.kind === "duplicate_payment");
    expect(dup).toBeDefined();
    expect(dup!.amountCents).toBe(10_000); // one extra payment, not two
    expect(found.some((c) => c.kind === "likely_reparse")).toBe(true);
  });

  it("finds a claim paid more than it was charged", () => {
    const eras = [{ payer: "ACME", era: era({ claims: [clp({ claimId: "C2", charged: 100, paid: 150, lines: [] })] }) }];
    const found = detectCreditBalances(eras);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("paid_over_charged");
    expect(found[0].amountCents).toBe(5_000);
  });

  it("finds a line overpaid even when the claim total nets out", () => {
    const eras = [
      {
        payer: "ACME",
        era: era({
          claims: [
            clp({
              claimId: "C3",
              charged: 200,
              paid: 200,
              lines: [svc({ procedure: "99213", charged: 100, paid: 150 }), svc({ procedure: "99214", charged: 100, paid: 50 })],
            }),
          ],
        }),
      },
    ];
    const found = detectCreditBalances(eras).filter((c) => c.kind === "paid_over_charged");
    expect(found).toHaveLength(1);
    expect(found[0].amountCents).toBe(5_000);
  });

  it("ignores synthetic claim-level adjustment lines", () => {
    const eras = [
      {
        payer: "ACME",
        era: era({
          claims: [
            clp({
              claimId: "C4",
              charged: 100,
              paid: 80,
              lines: [{ procedure: "(claim level)", charged: 0, paid: 0, units: 0, adjustments: [], rarcs: [] }],
            }),
          ],
        }),
      },
    ];
    expect(detectCreditBalances(eras)).toHaveLength(0);
  });

  it("finds nothing in an ordinary correctly-paid remittance", () => {
    expect(detectCreditBalances([{ payer: "ACME", era: era() }])).toHaveLength(0);
  });
});
