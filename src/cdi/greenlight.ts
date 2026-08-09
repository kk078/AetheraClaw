import type { PaRequirement } from "../fhir/crd.js";

// ── Pre-service clearance ────────────────────────────────────────────────────
// One question, asked before the patient is in the chair: can this be rendered
// today without creating a claim that will not pay, or a bill the patient was
// never warned about.
//
// Four things have to be true and they are usually checked by four different
// people at four different times, which is why the answer is so often wrong.
// Composing them is the easy part. The hard part is refusing to average them:
//
//   UNKNOWN IS NOT A MIDDLING SCORE. A clearance product that maps "we could
//   not determine whether this needs authorization" to 70% has produced a
//   number that reads as mostly fine, and the front desk will render the
//   service. So this fails closed — an unknown on any axis that can stop a
//   claim is a stop, and it is reported as an unknown rather than as a risk.
//
//   A BLOCKER CANNOT BE OUTWEIGHED. There is no percentage here for that
//   reason. Three green checks and a terminated policy is not 75% clear, it is
//   a self-pay visit nobody told the patient about.

/**
 * How long an eligibility verification stays good.
 *
 * Thirty days is the outer bound, and the calendar-month rule below usually
 * bites first: commercial coverage most often terminates at the end of a month,
 * so a verification from the previous month can be perfectly recent in days and
 * still describe a policy that no longer exists.
 */
export const ELIGIBILITY_FRESH_DAYS = 30;

/** Coverage checks age more slowly than eligibility, but policies do change. */
export const COVERAGE_FRESH_DAYS = 180;

export type CoverageStatus = "covered" | "not_covered" | "conditional" | "unknown";
export type Network = "in" | "out" | "unknown";

export interface GreenlightInput {
  /** De-identified reference only. */
  patientRef: string;
  /** YYYYMMDD of the planned service. */
  serviceDate: string;
  code: string;
  payer: string;
  network: Network;
  eligibility: {
    checked: boolean;
    active: boolean;
    /** Epoch ms of the verification. */
    checkedAt: number;
    planName: string;
    copayCents: number;
    deductibleRemainingCents: number;
  };
  priorAuth: {
    requirement: PaRequirement;
    authNumber: string;
    /** YYYYMMDD the authorization stops being good. Empty when not applicable. */
    expiresOn: string;
    checkedAt: number;
  };
  coverage: {
    status: CoverageStatus;
    policy: string;
    checkedAt: number;
  };
  estimate: {
    allowedCents: number;
    source: string;
  };
}

export type Verdict = "go" | "caution" | "stop";

export interface GreenlightResult {
  verdict: Verdict;
  /** Anything that will stop the claim or surprise the patient. */
  blockers: string[];
  /** Real but not disqualifying. */
  cautions: string[];
  /** What the patient should expect to owe, in cents. */
  patientOwesCents: number;
  patientOwesBasis: string;
  notes: string[];
}

const DAY_MS = 86_400_000;

function ymdToUtc(ymd: string): number {
  return Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
}

function ageInDays(checkedAt: number, serviceDate: string): number {
  return Math.floor((ymdToUtc(serviceDate) - checkedAt) / DAY_MS);
}

/** Whether a verification and a service fall in the same calendar month. */
function sameCalendarMonth(checkedAt: number, serviceDate: string): boolean {
  const d = new Date(checkedAt);
  return (
    d.getUTCFullYear() === Number(serviceDate.slice(0, 4)) && d.getUTCMonth() + 1 === Number(serviceDate.slice(4, 6))
  );
}

/**
 * Decide, and say exactly what decided it.
 *
 * The order is deliberate: eligibility first, because a terminated policy makes
 * every other answer irrelevant, and cost last, because a number is the thing
 * people read and the blockers are the thing that matters.
 */
export function greenlight(input: GreenlightInput): GreenlightResult {
  const blockers: string[] = [];
  const cautions: string[] = [];
  const notes: string[] = [];

  // ── Eligibility ──
  if (!input.eligibility.checked) {
    blockers.push(
      "Eligibility has not been verified. Everything below is arithmetic on an assumption — if the policy is not active, none of it describes what happens.",
    );
  } else if (!input.eligibility.active) {
    blockers.push(
      `The policy is not active for ${input.patientRef}. This is a self-pay visit unless another policy is found, and the patient has to be told that before the service rather than on a statement.`,
    );
  } else {
    const age = ageInDays(input.eligibility.checkedAt, input.serviceDate);
    if (age > ELIGIBILITY_FRESH_DAYS) {
      blockers.push(
        `Eligibility was verified ${age} days before the service. Past ${ELIGIBILITY_FRESH_DAYS} days that is a record of what used to be true — re-verify.`,
      );
    } else if (!sameCalendarMonth(input.eligibility.checkedAt, input.serviceDate)) {
      // The rule that catches what the day count misses.
      cautions.push(
        `Eligibility was verified in a different calendar month than the service (${age} day(s) earlier). Commercial coverage usually terminates at month end, so a check from last month can be recent and still describe a policy that has ended.`,
      );
    }
  }

  // ── Prior authorization ──
  switch (input.priorAuth.requirement) {
    case "required":
      if (!input.priorAuth.authNumber) {
        blockers.push(
          `${input.code} requires prior authorization from ${input.payer} and none is on file. A service rendered without one denies under CARC 197, and that denial is not appealable on the merits — the work is simply unpaid.`,
        );
      } else if (input.priorAuth.expiresOn && input.priorAuth.expiresOn < input.serviceDate) {
        blockers.push(
          `Authorization ${input.priorAuth.authNumber} expired on ${input.priorAuth.expiresOn}, before the ${input.serviceDate} service date. An expired authorization denies exactly like no authorization.`,
        );
      }
      break;
    case "unknown":
      blockers.push(
        `Whether ${input.code} needs prior authorization from ${input.payer} is unknown. That is not a small risk to price in — it is the one answer that cannot be worked around after the fact, so it is a stop until somebody checks.`,
      );
      break;
    case "conditional":
      cautions.push(
        `${input.code} needs authorization from ${input.payer} in some circumstances. Decide which side of that this order falls on before it is rendered, not after.`,
      );
      break;
    case "not_required":
      break;
  }

  // ── Coverage ──
  switch (input.coverage.status) {
    case "not_covered":
      blockers.push(
        `${input.code} is not covered${input.coverage.policy ? ` under ${input.coverage.policy}` : ""}. For Medicare this is where an ABN belongs — without one the practice cannot bill the patient for a service it knew would be denied.`,
      );
      break;
    case "unknown":
      cautions.push(
        `Coverage for ${input.code} was not determined. Unlike authorization this can often be argued afterward, but going in blind means no ABN was offered and no estimate is trustworthy.`,
      );
      break;
    case "conditional":
      cautions.push(
        `Coverage for ${input.code} depends on the indication${input.coverage.policy ? ` — see ${input.coverage.policy}` : ""}. Confirm the diagnosis on the order actually meets it.`,
      );
      break;
    case "covered":
      if (ageInDays(input.coverage.checkedAt, input.serviceDate) > COVERAGE_FRESH_DAYS) {
        cautions.push(`The coverage determination is over ${COVERAGE_FRESH_DAYS} days old. Policies change without notice.`);
      }
      break;
  }

  // ── Network ──
  if (input.network === "out") {
    cautions.push(
      "Out of network. If this is a facility-based or ancillary service the No Surprises Act balance-billing protections apply and the patient cannot be balance-billed without valid notice and consent — which has its own timing and cannot be collected at the desk on the day.",
    );
  } else if (input.network === "unknown") {
    cautions.push("Network status is unknown, so whether the patient is protected from balance billing is also unknown.");
  }

  // ── What the patient owes ──
  // The front-desk error this exists to prevent: collecting a copay from a
  // patient who has not met their deductible. Under a deductible the patient
  // owes the allowed amount, which is very often ten times the copay.
  let patientOwesCents: number;
  let patientOwesBasis: string;
  if (!input.eligibility.checked || !input.eligibility.active) {
    patientOwesCents = 0;
    patientOwesBasis = "Not estimated — eligibility is unverified or inactive, so there is no benefit design to compute against.";
  } else if (input.eligibility.deductibleRemainingCents > 0) {
    patientOwesCents = Math.min(input.estimate.allowedCents, input.eligibility.deductibleRemainingCents);
    patientOwesBasis = `Deductible not met ($${(input.eligibility.deductibleRemainingCents / 100).toFixed(2)} remaining), so the patient owes the allowed amount rather than the copay. Collecting the $${(input.eligibility.copayCents / 100).toFixed(2)} copay instead would under-collect by $${((patientOwesCents - input.eligibility.copayCents) / 100).toFixed(2)}.`;
  } else {
    patientOwesCents = input.eligibility.copayCents;
    patientOwesBasis = `Deductible met, so the copay applies. Allowed amount from ${input.estimate.source || "the fee schedule"}.`;
  }

  const verdict: Verdict = blockers.length > 0 ? "stop" : cautions.length > 0 ? "caution" : "go";

  notes.push(
    "There is no percentage here on purpose. A blocker cannot be outweighed by three clean checks — three greens and a terminated policy is not 75% clear, it is a self-pay visit nobody warned the patient about.",
  );
  if (verdict === "go") {
    notes.push("Clear on all four axes as of the checks above. It stays clear only as long as those checks stay fresh.");
  }

  return { verdict, blockers, cautions, patientOwesCents, patientOwesBasis, notes };
}

export function renderGreenlight(input: GreenlightInput, result: GreenlightResult): string {
  const label: Record<Verdict, string> = {
    go: "GO",
    caution: "CAUTION — proceed only after reading these",
    stop: "STOP",
  };
  const lines = [
    `${label[result.verdict]} — ${input.code} for ${input.patientRef} with ${input.payer} on ${input.serviceDate}.`,
    "",
  ];
  if (result.blockers.length > 0) lines.push("Blockers:", ...result.blockers.map((b) => `  ✖ ${b}`), "");
  if (result.cautions.length > 0) lines.push("Cautions:", ...result.cautions.map((c) => `  ! ${c}`), "");
  lines.push(
    `Patient is expected to owe $${(result.patientOwesCents / 100).toFixed(2)}.`,
    `  ${result.patientOwesBasis}`,
    "",
    ...result.notes.map((n) => `  ${n}`),
  );
  return lines.join("\n");
}
