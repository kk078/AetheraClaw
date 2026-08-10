// ── Talking to a real clearinghouse ──────────────────────────────────────────
//
// This is the seam between ORION's X12 knowledge and a network. Everything
// behind it — 270/271 builders, 835 parsers, the claim scrubber — already
// works and has never sent a byte anywhere. This interface is what changes
// that, and it is the most consequential code in the product, because a
// submitted 837 cannot be recalled by deploying a fix.
//
// THREE RULES THAT DO NOT BEND, whatever connector is behind this:
//
//   1. `mock` is the default and stays the default. An install that upgrades
//      and changes nothing must still be talking to nobody.
//   2. A simulated result is never written onto a claim record as though it
//      came from a payer. src/tools/healthcare/x12/276.ts already documents
//      this; the interface enforces it by making `simulated` a required field
//      of every response, so a caller cannot forget to ask.
//   3. No submit path bypasses the approval gate, in any mode.
//
// The eligibility, status and remittance calls are READS and are safe to
// retry. `submitClaim` is not: retrying a submit that actually succeeded
// creates a duplicate claim, which a payer sees as fraud-adjacent and a
// practice sees as a takeback. Its contract says so explicitly below.

export type ClearinghouseEnv = "sandbox" | "production";

export interface ConnectorMeta {
  /** Which connector answered. Recorded on every result so a stored verdict names its source. */
  connector: string;
  /** Whether this came from a real network call or was made up locally. */
  simulated: boolean;
  environment: ClearinghouseEnv;
  /** The clearinghouse's own trace identifier, for a support ticket. */
  traceId: string;
}

export interface EligibilityRequest {
  /** Payer id in the clearinghouse's namespace, not ours. */
  payerId: string;
  providerNpi: string;
  providerName: string;
  subscriberMemberId: string;
  subscriberFirstName: string;
  subscriberLastName: string;
  /** CCYYMMDD, the X12 form. */
  subscriberDateOfBirth: string;
  /** Service type codes — "30" is the general health benefit enquiry. */
  serviceTypeCodes?: string[];
}

/**
 * One benefit line from the 271.
 *
 * Deliberately thin. The 271 carries far more than this, and pretending to
 * model all of it produces a type that is wrong in a different way for every
 * payer. What a biller needs first is: is there coverage, for what, and what
 * does the patient owe.
 */
export interface BenefitLine {
  /** "Active Coverage", "Co-Payment", "Deductible", … */
  code: string;
  name: string;
  serviceTypeCodes: string[];
  amount: string;
  percent: string;
  network: string;
  message: string;
}

/**
 * Why a 271 came back without benefits.
 *
 * THE DISTINCTION THIS TYPE EXISTS FOR: "the payer could not identify this
 * patient" and "this patient has no coverage" are opposite answers that lead to
 * opposite actions — fix the demographics and retry, versus tell the patient
 * they are uninsured. A 271 with an AAA segment is the first; a 271 with an
 * inactive benefit is the second. Collapsing them into "no coverage found" is
 * the single most damaging simplification available here, and it is the one
 * every naive integration makes.
 */
export interface EligibilityRejection {
  /** The AAA code from the 271 — "72", "58", … */
  code: string;
  /** The payer's own words. */
  description: string;
  followupAction: string;
  /** Which loop it came from, when the clearinghouse says. */
  location: string;
}

export interface EligibilityResponse {
  meta: ConnectorMeta;
  /**
   * Whether the payer ANSWERED about this patient. False means the enquiry
   * failed — see `rejections` — and says nothing at all about coverage.
   */
  identified: boolean;
  payerName: string;
  benefits: BenefitLine[];
  rejections: EligibilityRejection[];
  /** One sentence a biller can act on, computed from the above. */
  summary: string;
}

export interface ClaimStatusRequest {
  payerId: string;
  providerNpi: string;
  claimControlNumber: string;
  subscriberMemberId: string;
  totalChargeAmount: string;
  serviceDateFrom: string;
}

export interface ClaimStatusResponse {
  meta: ConnectorMeta;
  found: boolean;
  /** The payer's status category and code, unmodified. */
  statusCategory: string;
  statusCode: string;
  description: string;
  rejections: EligibilityRejection[];
}

export interface SubmitResponse {
  meta: ConnectorMeta;
  accepted: boolean;
  /** The clearinghouse's receipt. This is the thing to keep — it is the proof of filing. */
  receiptId: string;
  message: string;
}

export interface RemittanceBatch {
  meta: ConnectorMeta;
  /** Raw 835 text, to be parsed by the existing parser rather than a second one. */
  x12: string;
  receivedAt: number;
}

export interface ClearinghouseConnector {
  readonly name: string;
  readonly environment: ClearinghouseEnv;

  checkEligibility(req: EligibilityRequest): Promise<EligibilityResponse>;
  checkClaimStatus(req: ClaimStatusRequest): Promise<ClaimStatusResponse>;

  /**
   * Send an 837.
   *
   * NOT IDEMPOTENT AND NOT RETRYABLE by the caller. A retry of a submit that
   * actually succeeded creates a duplicate claim — which a payer treats as
   * fraud-adjacent and a practice discovers as a takeback months later. If this
   * throws, the correct next step is to CHECK STATUS, not to send again.
   */
  submitClaim(x12: string): Promise<SubmitResponse>;

  pollRemittances(since: Date): Promise<RemittanceBatch[]>;
}

/**
 * Summarise a 271 for a human, from the parts that decide the action.
 *
 * Pure, and shared by every connector so the mock and the real one cannot drift
 * into describing the same response differently — which would make the mock
 * useless as a rehearsal for the real thing.
 */
export function summariseEligibility(
  identified: boolean,
  benefits: BenefitLine[],
  rejections: EligibilityRejection[],
): string {
  if (!identified) {
    const first = rejections[0];
    return first
      ? `The payer could not identify this patient: ${first.description}. ${first.followupAction || "Correct the details and resubmit."} ` +
          "This is not a statement about coverage — it means the enquiry did not reach a member record."
      : "The payer did not identify this patient, and gave no reason. Nothing here says whether coverage exists.";
  }
  const active = benefits.filter((b) => /active/i.test(b.code) || /active/i.test(b.name));
  if (active.length === 0) {
    return "The payer identified this patient and returned no active coverage for the service types asked about.";
  }
  const cost = benefits.filter((b) => /co-?payment|co-?insurance|deductible/i.test(b.name));
  const costNote = cost.length > 0 ? ` ${cost.length} cost-share line(s) returned.` : "";
  return `Active coverage confirmed by the payer.${costNote}`;
}
