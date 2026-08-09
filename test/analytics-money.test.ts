import { describe, expect, it } from "vitest";
import { detectCreditBalances } from "../src/tools/healthcare/audit/credit-balance.js";
import { collectPaidLines, detectVariance, isLineDenied, payerBaselines } from "../src/tools/healthcare/intelligence/variance.js";
import { computeCleanClaimRate, computeNetCollectionRate } from "../src/reports/kpi.js";
import type { Era, EraClaim } from "../src/tools/healthcare/x12/835.js";

const claim = (over: Partial<EraClaim> & { claimId: string }): EraClaim => ({
  claimId: over.claimId,
  statusCode: over.statusCode ?? "1",
  charged: over.charged ?? 100,
  paid: over.paid ?? 0,
  patientResponsibility: over.patientResponsibility ?? 0,
  payerControlNumber: over.payerControlNumber ?? "PCN",
  lines: over.lines ?? [],
});
const era = (payer: string, claims: EraClaim[]): { payer: string; era: Era } => ({
  payer,
  era: { payer, payee: "", checkOrEftAmount: 0, claims, providerAdjustments: [] },
});

describe("credit balances — COB and reversals", () => {
  const dup = (x: ReturnType<typeof detectCreditBalances>) => x.filter((c) => c.kind === "duplicate_payment").length;

  it("does not flag a primary+secondary COB pair as a duplicate", () => {
    const cob = detectCreditBalances([
      era("ACME", [claim({ claimId: "C1", statusCode: "1", paid: 80, payerControlNumber: "PCNA" })]),
      era("BETA", [claim({ claimId: "C1", statusCode: "2", paid: 20, payerControlNumber: "PCNB" })]),
    ]);
    expect(dup(cob)).toBe(0);
  });

  it("nets a reversal-and-correction instead of reporting a duplicate", () => {
    const rev = detectCreditBalances([
      era("ACME", [claim({ claimId: "C1", statusCode: "1", paid: 100, payerControlNumber: "PCN1" })]),
      era("ACME", [
        claim({ claimId: "C1", statusCode: "22", paid: -100, payerControlNumber: "PCN1" }),
        claim({ claimId: "C1", statusCode: "1", paid: 80, payerControlNumber: "PCN3" }),
      ]),
    ]);
    expect(dup(rev)).toBe(0);
  });

  it("still flags a genuine same-payer double payment", () => {
    const d = detectCreditBalances([
      era("ACME", [claim({ claimId: "C1", statusCode: "1", paid: 100, payerControlNumber: "PCN1" })]),
      era("ACME", [claim({ claimId: "C1", statusCode: "1", paid: 100, payerControlNumber: "PCN2" })]),
    ]);
    expect(dup(d)).toBe(1);
  });
});

describe("payment variance — a line-level denial is not an underpayment", () => {
  const line = (paid: number, adj: Array<{ group: string; carc: string; amount: number }>) => ({
    procedure: "HC:99214",
    charged: 120,
    paid,
    units: 1,
    adjustments: adj,
    rarcs: [],
  });

  it("marks a $0 line with a CO adjustment as denied", () => {
    expect(isLineDenied(line(0, [{ group: "CO", carc: "50", amount: 120 }]))).toBe(true);
    expect(isLineDenied(line(80, [{ group: "CO", carc: "45", amount: 40 }]))).toBe(false);
  });

  it("does not emit an underpayment finding for a denied line on a paid claim", () => {
    const eras = [
      {
        receivedAt: 1000,
        era: {
          payer: "ACME",
          payee: "",
          checkOrEftAmount: 0,
          providerAdjustments: [],
          claims: [
            { claimId: "C1", statusCode: "1", charged: 240, paid: 100, patientResponsibility: 0, payerControlNumber: "P", lines: [line(100, [{ group: "CO", carc: "45", amount: 20 }]), line(0, [{ group: "CO", carc: "50", amount: 120 }])] },
            // baseline paid 99214 lines so the code has a sample
            ...Array.from({ length: 4 }, (_, i) => ({ claimId: `B${i}`, statusCode: "1", charged: 120, paid: 100, patientResponsibility: 0, payerControlNumber: `p${i}`, lines: [line(100, [{ group: "CO", carc: "45", amount: 20 }])] })),
          ],
        },
      },
    ];
    const lines = collectPaidLines(eras as never);
    const findings = detectVariance(lines, { basis: "payer_history", baselines: payerBaselines(lines) });
    // The $0 CO-50 line must NOT appear as an underpayment.
    expect(findings.every((f) => f.claimId !== "C1")).toBe(true);
  });
});

describe("net collection rate — appeal payments count", () => {
  it("counts a denial-then-appeal-payment as collected, not lost", () => {
    const now = Date.UTC(2026, 6, 1);
    const dos = "20250101"; // ~18 months old, well past the 120-day cohort
    const mkClaim = (id: string) => ({
      claimId: id,
      payer: "ACME",
      status: "paid",
      createdAt: now - 400 * 86_400_000,
      claim: { claim_id: id, service_lines: [{ cpt_hcpcs: "99214", charge: 500, units: 1, service_date: dos, place_of_service: "11", dx_pointers: [1] }] },
    });
    const N = 22;
    const claims = Array.from({ length: N }, (_, i) => mkClaim(`C${i}`));
    const denialEra = {
      payer: "ACME",
      receivedAt: now - 380 * 86_400_000,
      era: { payer: "ACME", payee: "", checkOrEftAmount: 0, providerAdjustments: [], claims: claims.map((c) => ({ claimId: c.claimId, statusCode: "4", charged: 500, paid: 0, patientResponsibility: 0, payerControlNumber: "DEN", lines: [] })) },
    };
    const payEra = {
      payer: "ACME",
      receivedAt: now - 300 * 86_400_000,
      era: { payer: "ACME", payee: "", checkOrEftAmount: 0, providerAdjustments: [], claims: claims.map((c) => ({ claimId: c.claimId, statusCode: "1", charged: 500, paid: 500, patientResponsibility: 0, payerControlNumber: "PAY", lines: [] })) },
    };
    const ncr = computeNetCollectionRate(claims as never, [denialEra, payEra] as never, now);
    // Without the fix this was 0; the appeal cash is now counted.
    expect(ncr.rate).toBeGreaterThan(90);
  });
});

describe("clean claim rate — a partial denial is not a clean first pass", () => {
  it("counts a claim with a denied line as not-clean", () => {
    const N = 22;
    const eras = [
      {
        payer: "ACME",
        receivedAt: 1000,
        era: {
          payer: "ACME",
          payee: "",
          checkOrEftAmount: 0,
          providerAdjustments: [],
          claims: Array.from({ length: N }, (_, i) => ({
            claimId: `C${i}`,
            statusCode: "1",
            charged: 200,
            paid: 100,
            patientResponsibility: 0,
            payerControlNumber: "P",
            lines: [
              { procedure: "HC:99213", charged: 100, paid: 100, units: 1, adjustments: [], rarcs: [] },
              { procedure: "HC:99214", charged: 100, paid: 0, units: 1, adjustments: [{ group: "CO", carc: "50", amount: 100 }], rarcs: [] },
            ],
          })),
        },
      },
    ];
    const ccr = computeCleanClaimRate([], eras as never);
    // Every claim has a denied line, so first-pass-clean should be 0%.
    expect(ccr.firstPassPaymentRate).toBe(0);
  });
});
