import { describe, expect, it } from "vitest";
import { envelope, seg, serializeX12, type Segment } from "../src/tools/healthcare/x12/segments.js";
import { parse835, summarizeEra, type Era } from "../src/tools/healthcare/x12/835.js";
import {
  PLB_REASONS,
  checkEffect,
  matchRecoupments,
  reconcileEra,
  renderReconciliation,
  renderRecoupmentMatches,
} from "../src/reports/reconcile.js";
import { isProviderAdjustmentRow, summarize, toPostingRows } from "../src/tools/healthcare/operations/era-export.js";
import { computeNetCollectionRate } from "../src/reports/kpi.js";

// Money in an 835 moves at two levels. Everything here exists because the second
// level — the PLB loop — was not parsed, so a payer recouping money produced a
// smaller cheque with nothing anywhere to explain it.

// Built through the project's own envelope: parseX12 reads the segment
// terminator from character 105, so a hand-rolled short ISA parses as garbage
// and the assertions would be checking nothing.
function era835(body: Segment[]): string {
  return serializeX12(
    envelope({
      senderId: "PAYER",
      receiverId: "CLINIC",
      controlNumber: "1",
      functionalCode: "HP",
      transactionSetId: "835",
      date: "260115",
      time: "1200",
      body,
    }),
  );
}

/** A cheque with one $600 claim and whatever PLB segments are handed in. */
function chequeWith(amount: number, plb: Segment[]): Era {
  return parse835(
    era835([
      seg("BPR", "I", String(amount), "C", "ACH"),
      seg("N1", "PR", "Medicare"),
      seg("N1", "PE", "Example Clinic"),
      seg("CLP", "CLAIM-1", "1", "1000", "600", "100", "MC", "PCN-1"),
      seg("SVC", "HC:99214", "1000", "600", "", "1"),
      seg("CAS", "CO", "45", "300"),
      seg("CAS", "PR", "2", "100"),
      ...plb,
    ]),
  );
}

describe("PLB parsing", () => {
  it("reads reason, reference and amount out of the composite", () => {
    const era = chequeWith(200, [seg("PLB", "1234567890", "20251231", "WO:CLAIM-9", "400")]);
    expect(era.providerAdjustments).toHaveLength(1);
    expect(era.providerAdjustments[0]).toMatchObject({
      providerId: "1234567890",
      fiscalPeriod: "20251231",
      reasonCode: "WO",
      referenceId: "CLAIM-9",
      amount: 400,
    });
  });

  it("reads every pair in a segment, not just the first", () => {
    // A payer recouping four claims in one cheque commonly writes four pairs in
    // one PLB. Reading only the first understates the takeback by three
    // quarters while still producing a plausible number.
    const era = chequeWith(200, [
      seg("PLB", "1234567890", "20251231", "WO:A", "100", "WO:B", "100", "WO:C", "100", "WO:D", "100"),
    ]);
    expect(era.providerAdjustments).toHaveLength(4);
    expect(era.providerAdjustments.map((a) => a.referenceId)).toEqual(["A", "B", "C", "D"]);
  });

  it("survives a PLB with no reference identifier", () => {
    const era = chequeWith(600, [seg("PLB", "1234567890", "20251231", "L3", "0")]);
    expect(era.providerAdjustments[0]).toMatchObject({ reasonCode: "L3", referenceId: "", amount: 0 });
  });
});

describe("the sign convention", () => {
  // The single easiest thing to get backwards here, and the error is invisible
  // because both directions produce a plausible number.
  it("a POSITIVE amount takes money OFF the cheque", () => {
    expect(checkEffect({ providerId: "", fiscalPeriod: "", reasonCode: "WO", referenceId: "", amount: 400 })).toBe(-400);
  });

  it("a NEGATIVE amount ADDS money to the cheque", () => {
    expect(checkEffect({ providerId: "", fiscalPeriod: "", reasonCode: "L6", referenceId: "", amount: -12.5 })).toBe(12.5);
  });
});

describe("reconciliation", () => {
  it("balances a cheque reduced by a takeback", () => {
    const r = reconcileEra(chequeWith(200, [seg("PLB", "P", "20251231", "WO:CLAIM-9", "400")]));
    expect(r.claimsTotal).toBe(600);
    expect(r.adjustmentTotal).toBe(-400);
    expect(r.expectedCheck).toBe(200);
    expect(r.residual).toBe(0);
    expect(r.balanced).toBe(true);
    expect(r.recoupedTotal).toBe(400);
  });

  it("balances a cheque increased by interest owed", () => {
    const r = reconcileEra(chequeWith(612.5, [seg("PLB", "P", "20251231", "L6:CLAIM-1", "-12.50")]));
    expect(r.adjustmentTotal).toBe(12.5);
    expect(r.balanced).toBe(true);
    // Interest is not a takeback and must not be counted as one.
    expect(r.recoupedTotal).toBe(0);
  });

  it("keeps a forwarding balance out of the recouped total", () => {
    // FB is money carried to the NEXT remittance. Treating it as lost
    // understates cash, and it is the classic PLB misread.
    const r = reconcileEra(chequeWith(500, [seg("PLB", "P", "20251231", "FB:CLAIM-1", "100")]));
    expect(r.balanced).toBe(true);
    expect(r.forwardedTotal).toBe(100);
    expect(r.recoupedTotal).toBe(0);
    expect(renderReconciliation(r)).toMatch(/carried, not lost/);
  });

  it("reports a residual with the figure instead of absorbing it", () => {
    const r = reconcileEra(chequeWith(150, [seg("PLB", "P", "20251231", "WO:CLAIM-9", "400")]));
    expect(r.balanced).toBe(false);
    expect(r.residual).toBe(-50);
    const text = renderReconciliation(r);
    expect(text).toMatch(/DOES NOT BALANCE by -\$50\.00/);
    expect(text).toMatch(/withheld without a PLB explaining it/);
    expect(text).toMatch(/reported, not absorbed/);
  });

  it("names the other direction when the payer sent more than it explained", () => {
    const r = reconcileEra(chequeWith(700, []));
    expect(r.residual).toBe(100);
    expect(renderReconciliation(r)).toMatch(/sent MORE/);
  });

  it("tolerates a one-cent rounding gap", () => {
    expect(reconcileEra(chequeWith(600.01, [])).balanced).toBe(true);
    expect(reconcileEra(chequeWith(600.02, [])).balanced).toBe(false);
  });

  it("handles a remittance stored before PLB was parsed", () => {
    // Rows already in a user's database have no providerAdjustments field.
    const legacy = { payer: "Medicare", payee: "Clinic", checkOrEftAmount: 600, claims: [] } as unknown as Era;
    expect(() => reconcileEra(legacy)).not.toThrow();
    expect(reconcileEra(legacy).adjustments).toEqual([]);
  });

  it("classifies WO as a recoupment and FB as forwarding, with the FB warning attached", () => {
    expect(PLB_REASONS.WO.kind).toBe("recoupment");
    expect(PLB_REASONS.FB.kind).toBe("forwarding");
    expect(PLB_REASONS.FB.note).toMatch(/NOT a takeback/);
    expect(PLB_REASONS.L6.kind).toBe("owed-to-provider");
  });
});

describe("parse summary", () => {
  it("names provider-level adjustments rather than leaving them invisible", () => {
    const text = summarizeEra(chequeWith(200, [seg("PLB", "P", "20251231", "WO:CLAIM-9", "400")]));
    expect(text).toMatch(/provider-level adjustment/);
    expect(text).toMatch(/-\$400\.00/);
    expect(text).toMatch(/era_reconcile/);
  });

  it("says nothing when there are none", () => {
    expect(summarizeEra(chequeWith(600, []))).not.toMatch(/provider-level adjustment/);
  });
});

describe("posting export", () => {
  const rows = () => toPostingRows([{ era: chequeWith(200, [seg("PLB", "P", "20251231", "WO:CLAIM-9", "400")]) }]);

  it("emits a signed row so the paid column sums to the deposit", () => {
    const all = rows();
    const plb = all.filter(isProviderAdjustmentRow);
    expect(plb).toHaveLength(1);
    expect(plb[0].paid).toBe(-400);
    expect(plb[0].claimId).toBe("CLAIM-9");
    expect(summarize(all).paid).toBe(200);
    expect(summarize(all).providerAdjustmentTotal).toBe(-400);
  });

  it("marks a PLB row n/a rather than balanced — there is no charge to balance", () => {
    expect(rows().filter(isProviderAdjustmentRow)[0].balanced).toBe("n/a");
    expect(summarize(rows()).unbalanced).toBe(0);
  });
});

describe("net collection rate", () => {
  const claim = (id: string, dos: string) => ({
    claimId: id,
    createdAt: Date.UTC(2025, 0, 1),
    claim: { service_lines: [{ service_date: dos, charge: 1000 }] },
  });
  const now = Date.UTC(2026, 5, 1);

  const COHORT = 24; // above MIN_CLAIMS_FOR_RATE, so a percentage is computed

  const storedEras = (plb: Segment[]) => [
    {
      payer: "Medicare",
      receivedAt: now,
      era: parse835(
        era835([
          seg("BPR", "I", String(COHORT * 600), "C", "ACH"),
          seg("N1", "PR", "Medicare"),
          ...Array.from({ length: COHORT }, (_, i) => [
            seg("CLP", `C${i}`, "1", "1000", "600", "0", "MC", `PCN-${i}`),
            seg("SVC", "HC:99214", "1000", "600", "", "1"),
            seg("CAS", "CO", "45", "400"),
          ]).flat(),
          ...plb,
        ]),
      ),
    },
  ];

  const claims = Array.from({ length: COHORT }, (_, i) => claim(`C${i}`, "20250201")) as never;

  it("nets a recoupment against a cohort claim out of collections", () => {
    const plain = computeNetCollectionRate(claims, storedEras([]) as never, now);
    const clawed = computeNetCollectionRate(claims, storedEras([seg("PLB", "P", "20251231", "WO:C3", "600")]) as never, now);
    expect(plain.payments).toBe(COHORT * 600);
    expect(clawed.payments).toBe(COHORT * 600 - 600);
    expect(clawed.recoupments).toBe(600);
    expect(clawed.rate!).toBeLessThan(plain.rate!);
    expect(clawed.note).toMatch(/netted out of the numerator/);
  });

  it("counts a recoupment against a claim outside the cohort without netting it", () => {
    // Subtracting money from a cohort it was never part of would understate the
    // rate; hiding it entirely would pretend the practice kept cash it gave back.
    const r = computeNetCollectionRate(claims, storedEras([seg("PLB", "P", "20251231", "WO:OLD-CLAIM", "600")]) as never, now);
    expect(r.payments).toBe(COHORT * 600);
    expect(r.recoupments).toBe(0);
    expect(r.unattributedRecoupments).toBe(600);
    expect(r.note).toMatch(/outside this cohort/);
  });

  it("leaves a forwarding balance out of collections entirely", () => {
    const r = computeNetCollectionRate(claims, storedEras([seg("PLB", "P", "20251231", "FB:C3", "600")]) as never, now);
    expect(r.payments).toBe(COHORT * 600);
    expect(r.recoupments).toBe(0);
    expect(r.unattributedRecoupments).toBe(0);
  });
});

describe("credit balance linkage", () => {
  const open = [{ id: "cb_1", claimId: "CLAIM-9", amountCents: 40_000, payer: "Medicare" }];

  it("matches a recoupment to the open balance it settles", () => {
    const r = reconcileEra(chequeWith(200, [seg("PLB", "P", "20251231", "WO:CLAIM-9", "400")]));
    const matches = matchRecoupments([r], open);
    expect(matches).toHaveLength(1);
    expect(matches[0].coversBalance).toBe(true);
    const text = renderRecoupmentMatches(matches);
    expect(text).toMatch(/adjusted_by_payer/);
    expect(text).toMatch(/Nothing has been changed/);
  });

  it("calls a partial recoupment partial rather than settled", () => {
    const r = reconcileEra(chequeWith(500, [seg("PLB", "P", "20251231", "WO:CLAIM-9", "100")]));
    const matches = matchRecoupments([r], open);
    expect(matches[0].coversBalance).toBe(false);
    expect(renderRecoupmentMatches(matches)).toMatch(/PARTIAL — \$300\.00/);
  });

  it("does not treat a forwarding balance as a settled refund", () => {
    const r = reconcileEra(chequeWith(500, [seg("PLB", "P", "20251231", "FB:CLAIM-9", "100")]));
    expect(matchRecoupments([r], open)).toEqual([]);
  });

  it("says the obligation stands when nothing matches", () => {
    expect(renderRecoupmentMatches([])).toMatch(/still owed/);
  });
});
