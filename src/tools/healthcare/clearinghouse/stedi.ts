import type {
  BenefitLine,
  ClaimStatusRequest,
  ClaimStatusResponse,
  ClearinghouseConnector,
  ClearinghouseEnv,
  EligibilityRejection,
  EligibilityRequest,
  EligibilityResponse,
  RemittanceBatch,
  SubmitResponse,
} from "./types.js";
import { summariseEligibility } from "./types.js";

// ── Stedi ────────────────────────────────────────────────────────────────────
//
// Verified against the live sandbox rather than written from documentation.
// What was confirmed by actually calling it:
//
//   - `Authorization: <api-key>` works, and so does `Key <api-key>`.
//     `Bearer <api-key>` is REJECTED with 401 — which is the scheme most people
//     reach for first, so it is worth the sentence.
//   - The response carries `meta.applicationMode`, which is how a caller knows
//     whether it was talking to the test network. That is read rather than
//     inferred from the key prefix, because the key prefix is a convention and
//     the mode is the fact.
//   - A payer that cannot identify the patient answers 200 with an `errors`
//     array of AAA segments, NOT an HTTP error. An integration that only checks
//     the status code reads "Invalid/Missing Subscriber ID" as a successful
//     eligibility check with no benefits — which is the exact confusion
//     EligibilityRejection exists to prevent.
//
// The API key is read from the environment and never from config: a config file
// is committed, shared and pasted into issues.

const DEFAULT_BASE = "https://healthcare.us.stedi.com";
const ELIGIBILITY_PATH = "/2024-04-01/change/medicalnetwork/eligibility/v3";

export interface StediOptions {
  apiKey: string;
  environment: ClearinghouseEnv;
  baseUrl?: string;
  /** Injected so tests can replay a recorded response without a network. */
  fetchImpl?: typeof fetch;
}

interface StediEligibilityBody {
  meta?: { applicationMode?: string; traceId?: string };
  payer?: { name?: string };
  benefitsInformation?: Array<{
    code?: string;
    name?: string;
    serviceTypeCodes?: string[];
    benefitAmount?: string;
    benefitPercent?: string;
    inPlanNetworkIndicator?: string;
    additionalInformation?: Array<{ description?: string }>;
  }>;
  errors?: Array<{ code?: string; description?: string; followupAction?: string; location?: string }>;
  subscriber?: { aaaErrors?: Array<{ code?: string; description?: string; followupAction?: string; location?: string }> };
}

function toRejections(body: StediEligibilityBody): EligibilityRejection[] {
  // Two places carry AAA segments — the top-level `errors` and the subscriber's
  // own `aaaErrors` — and a response can populate either. Reading only one is
  // how a rejection becomes an empty benefits list.
  const raw = [...(body.errors ?? []), ...(body.subscriber?.aaaErrors ?? [])];
  const seen = new Set<string>();
  const out: EligibilityRejection[] = [];
  for (const e of raw) {
    const key = `${e.code}|${e.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      code: String(e.code ?? ""),
      description: String(e.description ?? ""),
      followupAction: String(e.followupAction ?? ""),
      location: String(e.location ?? ""),
    });
  }
  return out;
}

function toBenefits(body: StediEligibilityBody): BenefitLine[] {
  return (body.benefitsInformation ?? []).map((b) => ({
    code: String(b.code ?? ""),
    name: String(b.name ?? ""),
    serviceTypeCodes: b.serviceTypeCodes ?? [],
    amount: String(b.benefitAmount ?? ""),
    percent: String(b.benefitPercent ?? ""),
    network: String(b.inPlanNetworkIndicator ?? ""),
    message: (b.additionalInformation ?? []).map((a) => a.description ?? "").filter(Boolean).join("; "),
  }));
}

/**
 * Turn a Stedi eligibility body into our shape.
 *
 * Exported and PURE so the mapping can be tested against a recorded response
 * with no network and no key — which is what makes the fixtures in
 * test/fixtures/stedi worth keeping.
 */
export function parseStediEligibility(body: StediEligibilityBody, environment: ClearinghouseEnv): EligibilityResponse {
  const rejections = toRejections(body);
  const benefits = toBenefits(body);
  // Identified means the payer matched a member record. A rejection means it
  // did not — and an empty benefits list on its own does NOT mean the patient
  // is uninsured, which is why this is computed from the rejections rather
  // than from benefits.length.
  const identified = rejections.length === 0;
  return {
    meta: {
      connector: "stedi",
      simulated: false,
      // Read from the response, not guessed from the key prefix. The mode is a
      // fact about which network answered; the prefix is a naming convention.
      environment: body.meta?.applicationMode === "production" ? "production" : environment,
      traceId: String(body.meta?.traceId ?? ""),
    },
    identified,
    payerName: String(body.payer?.name ?? ""),
    benefits,
    rejections,
    summary: summariseEligibility(identified, benefits, rejections),
  };
}

export class StediConnector implements ClearinghouseConnector {
  readonly name = "stedi";
  readonly environment: ClearinghouseEnv;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: StediOptions) {
    if (!opts.apiKey) throw new Error("Stedi connector needs an API key. Set STEDI_API_KEY.");
    this.apiKey = opts.apiKey;
    this.environment = opts.environment;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async checkEligibility(req: EligibilityRequest): Promise<EligibilityResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}${ELIGIBILITY_PATH}`, {
      method: "POST",
      headers: {
        // Verified: the raw key. `Bearer` is rejected with 401.
        authorization: this.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        controlNumber: "123456789",
        tradingPartnerServiceId: req.payerId,
        provider: { organizationName: req.providerName, npi: req.providerNpi },
        subscriber: {
          firstName: req.subscriberFirstName,
          lastName: req.subscriberLastName,
          dateOfBirth: req.subscriberDateOfBirth,
          memberId: req.subscriberMemberId,
        },
        encounter: { serviceTypeCodes: req.serviceTypeCodes ?? ["30"] },
      }),
    });

    // An HTTP failure is a failure of the ENQUIRY, and must not be reported as
    // a coverage answer. Throwing is right here: the caller has an approval
    // gate and a retry story for a read, and inventing an EligibilityResponse
    // would put a fabricated verdict where a payer's belongs.
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Stedi eligibility returned HTTP ${res.status}. The enquiry did not reach the payer, so nothing here says anything about coverage. ${text.slice(0, 200)}`,
      );
    }
    return parseStediEligibility((await res.json()) as StediEligibilityBody, this.environment);
  }

  // ── Not implemented, and saying so rather than pretending ─────────────────
  // Claim status, submission and remittance polling on Stedi require payer
  // ENROLMENT, which is an account-level process with each payer and cannot be
  // exercised from a test key alone. Writing them from documentation and
  // shipping them untested would put unverified code on the path that submits
  // claims — the one path where being wrong is not recoverable by deploying a
  // fix.
  //
  // They throw with the reason. A stub that returned a plausible-looking
  // success would be far worse: the caller would record a filing proof for a
  // claim that was never sent.

  async checkClaimStatus(_req: ClaimStatusRequest): Promise<ClaimStatusResponse> {
    throw new Error(
      "Stedi claim status (276/277) is not implemented yet — it needs payer enrolment, which cannot be " +
        'exercised from a test key. Use clearinghouse: "mock" for a simulated answer, and note that a ' +
        "simulated status must never be written onto a claim record.",
    );
  }

  async submitClaim(_x12: string): Promise<SubmitResponse> {
    throw new Error(
      "Stedi claim submission (837) is not implemented yet — it needs payer enrolment. This throws rather " +
        "than returning a plausible receipt, because a fabricated receipt would be recorded as proof of a " +
        "filing that never happened.",
    );
  }

  async pollRemittances(_since: Date): Promise<RemittanceBatch[]> {
    throw new Error(
      "Stedi remittance polling (835) is not implemented yet — it needs payer enrolment and an ERA " +
        "delivery configuration.",
    );
  }
}
