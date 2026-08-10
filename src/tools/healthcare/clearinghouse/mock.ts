import { createHash } from "node:crypto";
import type {
  ClaimStatusRequest,
  ClaimStatusResponse,
  ClearinghouseConnector,
  ClearinghouseEnv,
  EligibilityRequest,
  EligibilityResponse,
  RemittanceBatch,
  SubmitResponse,
} from "./types.js";
import { summariseEligibility } from "./types.js";

// ── The mock clearinghouse ───────────────────────────────────────────────────
//
// The DEFAULT connector, and it stays the default. An install that upgrades and
// changes nothing must still be talking to nobody.
//
// This exists for three jobs, and the third is the one that shapes it:
//
//   1. `npm test` must never touch a payer network.
//   2. A demonstration needs a claim lifecycle that completes.
//   3. IT IS THE ONLY REHEARSAL AVAILABLE for claim submission. Stedi's sandbox
//      plan covers eligibility and nothing else — status, submission and ERA
//      unlock only on the production plan, which by their own wording means
//      sending real claims to real payers. There is no test network for the
//      837 path. Whatever confidence anyone has in that code before the first
//      live submission comes from here.
//
// So this is written as a rehearsal rather than a stub: deterministic, with the
// unhappy paths present, and with every result stamped `simulated: true` so it
// cannot be mistaken for a payer's answer downstream.
//
// DETERMINISTIC, NOT RANDOM. A mock that returns a random outcome makes a test
// that fails one run in twenty and a demonstration that cannot be rehearsed.
// Outcomes are derived from a hash of the input, so the same claim always gets
// the same answer and a specific scenario can be summoned on demand.

/** Stable 0–99 from any string. The whole source of variation here. */
function bucket(seed: string): number {
  return createHash("sha256").update(seed).digest()[0] % 100;
}

/**
 * Member IDs that force a specific outcome.
 *
 * A rehearsal is only useful if the unhappy paths can be reached on purpose. A
 * demo that can only show success teaches nobody what a rejection looks like,
 * and the rejection is the case a biller spends their day on.
 */
const SCENARIOS: Record<string, "not-found" | "inactive" | "active"> = {
  MOCK_NOT_FOUND: "not-found",
  MOCK_INACTIVE: "inactive",
};

export class MockConnector implements ClearinghouseConnector {
  readonly name = "mock";
  readonly environment: ClearinghouseEnv = "sandbox";

  private meta(traceId: string) {
    return {
      connector: this.name,
      // Never negotiable. Every consumer of a clearinghouse result checks this
      // before it writes anything to a claim record, and a mock that claimed
      // otherwise would put an invented payer answer into the audit trail.
      simulated: true as const,
      environment: this.environment,
      traceId,
    };
  }

  async checkEligibility(req: EligibilityRequest): Promise<EligibilityResponse> {
    const scenario = SCENARIOS[req.subscriberMemberId] ?? "active";
    const trace = `mock-elig-${bucket(req.subscriberMemberId + req.payerId)}`;

    if (scenario === "not-found") {
      const rejections = [
        {
          code: "72",
          description: "Invalid/Missing Subscriber/Insured ID",
          followupAction: "Please Correct and Resubmit",
          location: "Loop 2100C",
        },
      ];
      return {
        meta: this.meta(trace),
        identified: false,
        payerName: "MOCK PAYER",
        benefits: [],
        rejections,
        summary: summariseEligibility(false, [], rejections),
      };
    }

    if (scenario === "inactive") {
      // Identified, and NOT covered. The other half of the distinction the real
      // connector exists to preserve — a payer that found the patient and has
      // no active plan for them. Collapsing this with "not found" is the
      // mistake; the mock has to be able to show both or it cannot rehearse it.
      const benefits = [
        {
          code: "6",
          name: "Inactive",
          serviceTypeCodes: req.serviceTypeCodes ?? ["30"],
          amount: "",
          percent: "",
          network: "",
          message: "Coverage terminated",
        },
      ];
      return {
        meta: this.meta(trace),
        identified: true,
        payerName: "MOCK PAYER",
        benefits,
        rejections: [],
        summary: summariseEligibility(true, benefits, []),
      };
    }

    const benefits = [
      { code: "1", name: "Active Coverage", serviceTypeCodes: req.serviceTypeCodes ?? ["30"], amount: "", percent: "", network: "Y", message: "" },
      { code: "B", name: "Co-Payment", serviceTypeCodes: ["30"], amount: "25.00", percent: "", network: "Y", message: "Office visit" },
      { code: "C", name: "Deductible", serviceTypeCodes: ["30"], amount: "1500.00", percent: "", network: "Y", message: "Calendar year" },
    ];
    return {
      meta: this.meta(trace),
      identified: true,
      payerName: "MOCK PAYER",
      benefits,
      rejections: [],
      summary: summariseEligibility(true, benefits, []),
    };
  }

  async checkClaimStatus(req: ClaimStatusRequest): Promise<ClaimStatusResponse> {
    // Three outcomes across the buckets, so a worklist of mock claims shows a
    // realistic mixture rather than a wall of one status.
    const b = bucket(req.claimControlNumber);
    if (b < 15) {
      return {
        meta: this.meta(`mock-status-${b}`),
        found: false,
        statusCategory: "",
        statusCode: "",
        description: "",
        rejections: [
          {
            code: "35",
            description: "Claim/Encounter not found",
            followupAction: "Please Correct and Resubmit",
            location: "Loop 2200D",
          },
        ],
      };
    }
    const finalised = b >= 60;
    return {
      meta: this.meta(`mock-status-${b}`),
      found: true,
      statusCategory: finalised ? "F" : "A",
      statusCode: finalised ? "1" : "0",
      description: finalised
        ? "Finalized — payment has been made or is scheduled"
        : "Acknowledged — the claim has been received and is in process",
      rejections: [],
    };
  }

  /**
   * Pretend to send an 837.
   *
   * The receipt id is derived from the CONTENT, which gives the mock a property
   * the real connector cannot have: submitting the same claim twice returns the
   * same receipt. That makes duplicate submission visible in a rehearsal — the
   * failure mode the real submitClaim documents as unrecoverable — instead of
   * quietly producing two different receipts for one claim.
   */
  async submitClaim(x12: string): Promise<SubmitResponse> {
    const digest = createHash("sha256").update(x12).digest("hex").slice(0, 12);
    const b = bucket(x12);
    if (b < 10) {
      // A clearinghouse-level rejection, before the payer ever sees it. Real,
      // common, and the case people forget: the claim was NOT filed, so nothing
      // may record a filing proof for it.
      return {
        meta: this.meta(`mock-submit-${digest}`),
        accepted: false,
        receiptId: "",
        message:
          "SIMULATED rejection at the clearinghouse: the 837 failed structural validation and was not " +
          "forwarded to the payer. Nothing was filed.",
      };
    }
    return {
      meta: this.meta(`mock-submit-${digest}`),
      accepted: true,
      receiptId: `MOCK-${digest}`,
      message:
        "SIMULATED acceptance. This receipt is not proof of filing and must never be recorded as one — " +
        "no payer has seen this claim.",
    };
  }

  /**
   * No remittances, ever.
   *
   * Returning an invented 835 would put fabricated payment amounts through the
   * posting path and into the KPIs, where they are indistinguishable from money
   * that actually arrived. A demonstration that needs remittances has
   * `scripts/seed-synthetic.mjs`, which seeds them explicitly and is understood
   * to be synthetic.
   */
  async pollRemittances(_since: Date): Promise<RemittanceBatch[]> {
    return [];
  }
}
