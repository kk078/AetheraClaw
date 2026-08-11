import type { ScrubFinding } from "../finding.js";

// ── The first live submission ────────────────────────────────────────────────
//
// This is the one action in the product that cannot be undone by deploying a
// fix. Everything else — a wrong verdict, a bad estimate, a lost document — is
// recoverable. A submitted 837 is a claim at a payer, and the only things that
// change it afterwards are a void (frequency 8) or a replacement (frequency 7),
// both of which are new filings that a human has to reason about.
//
// So the gate is built on one belief: THE CAP HAS TO BE IN CODE. A checklist
// that says "only submit one claim to start" is a checklist somebody deviates
// from at 4pm on a Friday when the first one worked and the queue is long. A
// counter that refuses the second submission is not.
//
// WHAT THIS IS NOT. It is not a safety proof. Passing every check here means
// the obvious mistakes have been ruled out, not that the claim is correct — the
// payer is the only thing that decides that. The report says so in those words,
// because a green checklist is exactly the sort of thing that gets quoted as
// approval later.
//
// Pure. Facts in, verdict out; the caller does the I/O and the counting.

export type GateLevel = "block" | "warn" | "ok";

export interface FirstSubmissionCheck {
  id: string;
  level: GateLevel;
  message: string;
  /** What to do about it. Empty when there is nothing to do. */
  fix: string;
}

export interface FirstSubmissionInput {
  /** From getConnector — which network this deployment is actually pointed at. */
  connectorName: string;
  environment: "sandbox" | "production";
  /** From the config. "never" means nothing would ask before filing. */
  approvalPolicy: string;
  /** How many live submissions this deployment has already made. */
  priorLiveSubmissions: number;
  /** The ceiling for the supervised period. */
  liveSubmissionCap: number;
  /** Scrub findings for the claim about to go. */
  scrubFindings: ScrubFinding[];
  /** Total billed on the claim, in dollars. */
  chargeAmount: number;
  /** Days left in the payer's filing window, or null when unknown. */
  filingDaysLeft: number | null;
  /** Whether eligibility was checked for THIS patient and came back identified. */
  eligibilityVerified: boolean;
  /** Whether a named person is supervising. Empty means nobody is. */
  supervisor: string;
  /** Checks that could not run because a dataset is absent. */
  checksNotRun: string[];
  /** Whether the built 837 has been read by a person, segment by segment. */
  dryRunReviewed: boolean;
}

export interface FirstSubmissionReport {
  checks: FirstSubmissionCheck[];
  /** True when at least one check blocks. Nothing may be sent. */
  blocked: boolean;
  /** How many live submissions remain in the supervised window after this one. */
  remainingAfter: number;
  summary: string;
}

/**
 * The lowest-risk claim is the right first claim.
 *
 * The instinct is to pick a big complicated claim to "test it properly". That is
 * backwards: a first submission is a test of the PIPE, not of the claim, and a
 * complicated claim adds ways to fail that tell you nothing about whether the
 * connection works. A small, clean, well-covered claim with a long filing window
 * isolates the variable being tested — and if it goes wrong, it goes wrong for
 * a small amount of money on a claim there is time to refile.
 */
export const IDEAL_FIRST_CLAIM = {
  maxCharge: 500,
  minFilingDaysLeft: 60,
  description:
    "Small dollar value, no scrub errors or warnings, eligibility already confirmed for this patient, and at " +
    "least two months left in the filing window. A first submission tests the PIPE, not the claim — a complex " +
    "claim adds ways to fail that say nothing about whether the connection works.",
};

export function evaluateFirstSubmission(input: FirstSubmissionInput): FirstSubmissionReport {
  const checks: FirstSubmissionCheck[] = [];
  const add = (id: string, level: GateLevel, message: string, fix = "") =>
    checks.push({ id, level, message, fix });

  // ── The cap. First, because it is the reason this gate exists ─────────────
  if (input.priorLiveSubmissions >= input.liveSubmissionCap) {
    add(
      "cap",
      "block",
      `The supervised window allows ${input.liveSubmissionCap} live submission(s) and ${input.priorLiveSubmissions} ` +
        "have been made. Nothing further goes out until somebody raises the cap deliberately.",
      "Confirm the earlier submissions were ACCEPTED (277CA) and PAID (835) before raising it. A submission that " +
        "was accepted is not the same as a claim that adjudicated.",
    );
  } else {
    add(
      "cap",
      "ok",
      `Submission ${input.priorLiveSubmissions + 1} of ${input.liveSubmissionCap} in the supervised window.`,
    );
  }

  // ── Is this even a live path ──────────────────────────────────────────────
  if (input.environment !== "production") {
    add(
      "environment",
      "warn",
      `The connector is in ${input.environment}. Nothing sent will reach a payer, which is fine for a rehearsal ` +
        "and means this run proves nothing about the live path.",
    );
  } else {
    add("environment", "ok", `Connector "${input.connectorName}" is in PRODUCTION. This reaches a real payer.`);
  }
  if (input.connectorName === "mock") {
    add(
      "connector",
      "warn",
      "The mock connector is selected, so this is a rehearsal. Every result will be stamped simulated and must not " +
        "be recorded as a filing.",
    );
  }

  // ── Nobody unattended ─────────────────────────────────────────────────────
  if (input.supervisor.trim() === "") {
    add(
      "supervisor",
      "block",
      "No supervising person is named. The whole point of the supervised window is that somebody is watching this " +
        "one go out and can act on what comes back.",
      "Name the person who is watching. It goes in the record.",
    );
  } else {
    add("supervisor", "ok", `Supervised by ${input.supervisor.trim()}.`);
  }

  if (input.approvalPolicy === "never") {
    add(
      "approval",
      "block",
      'approvalPolicy is "never", so nothing would ask before filing. A first live submission with no approval ' +
        "prompt is an unattended one however many people are in the room.",
      'Set approvalPolicy to "always" for the supervised window.',
    );
  } else {
    add("approval", "ok", `approvalPolicy is "${input.approvalPolicy}" — the submit path will ask.`);
  }

  // ── The claim itself ──────────────────────────────────────────────────────
  const errors = input.scrubFindings.filter((f) => f.severity === "error");
  const warnings = input.scrubFindings.filter((f) => f.severity === "warning");
  if (errors.length > 0) {
    add(
      "scrub",
      "block",
      `${errors.length} scrub error(s): ${errors.map((e) => e.rule).join(", ")}. These do not adjudicate — the claim ` +
        "rejects or denies as submitted.",
      "Fix them. A first submission that fails on something the scrubber already caught teaches nothing about the " +
        "connection.",
    );
  } else if (warnings.length > 0) {
    add(
      "scrub",
      "warn",
      `${warnings.length} scrub warning(s): ${warnings.map((w) => w.rule).join(", ")}. Defensible, but a first ` +
        "submission is the wrong place to find out whether this payer agrees.",
    );
  } else {
    add("scrub", "ok", "The scrubber found nothing.");
  }

  if (input.checksNotRun.length > 0) {
    // BLOCKS, and it did not always. A "clear" that silently skipped the NCCI
    // check is worse than no check, because it converts an absence of
    // information into a statement of safety — and the check immediately above
    // has just printed "The scrubber found nothing", which is the sentence a
    // person carries into the decision.
    //
    // A warning was the wrong level for THIS gate specifically. Everywhere else
    // in the product, missing reference data degrades an answer somebody can
    // weigh. Here the next step files a claim at a payer, and the doc's own
    // criterion for a first claim is a scrub with no errors AND NO WARNINGS —
    // so a warning that is routinely present is one that gets read as scenery.
    //
    // It is also the cheapest block on this list to clear: `orion data refresh`
    // fetches public CMS files. Nothing about it asks anyone to accept risk.
    add(
      "blind-spots",
      "block",
      `${input.checksNotRun.join(", ")} could not run, so those checks did NOT pass — they did not happen. ` +
        "The scrub above is clean only in the sense that nothing looked.",
      "Run `orion data refresh` and re-check. These are public CMS files, and this is the last moment installing them is free.",
    );
  }

  if (input.chargeAmount > IDEAL_FIRST_CLAIM.maxCharge) {
    add(
      "amount",
      "warn",
      `$${input.chargeAmount.toFixed(2)} is more than the $${IDEAL_FIRST_CLAIM.maxCharge} suggested for a first ` +
        "claim. Not a rule — but if this one goes wrong, it goes wrong for that much.",
      "Prefer a small claim. " + IDEAL_FIRST_CLAIM.description,
    );
  } else {
    add("amount", "ok", `$${input.chargeAmount.toFixed(2)} — small enough that a mistake is affordable.`);
  }

  if (input.filingDaysLeft === null) {
    add(
      "filing-window",
      "warn",
      "The filing window is unknown for this claim, so there is no way to say whether a refile would still be in time.",
      "Record the date of service and the payer's filing limit.",
    );
  } else if (input.filingDaysLeft <= 0) {
    add(
      "filing-window",
      "block",
      `The filing window has already closed (${input.filingDaysLeft} days). This claim will be denied on the ` +
        "deadline whatever else is true, so it proves nothing about the connection.",
      "Pick a different claim.",
    );
  } else if (input.filingDaysLeft < IDEAL_FIRST_CLAIM.minFilingDaysLeft) {
    add(
      "filing-window",
      "warn",
      `${input.filingDaysLeft} day(s) left to file. If this submission goes wrong there may not be room to correct ` +
        "and refile.",
      `Prefer a claim with at least ${IDEAL_FIRST_CLAIM.minFilingDaysLeft} days left.`,
    );
  } else {
    add("filing-window", "ok", `${input.filingDaysLeft} days left to file — room to correct and refile if needed.`);
  }

  if (!input.eligibilityVerified) {
    add(
      "eligibility",
      "warn",
      "Eligibility has not been confirmed for this patient. The two commonest rejections (AAA 71 and 72) are " +
        "demographic, and eligibility is the cheap way to find them before an 837 does.",
      "Run eligibility first. It is a read and costs nothing.",
    );
  } else {
    add("eligibility", "ok", "Eligibility confirmed for this patient.");
  }

  if (!input.dryRunReviewed) {
    add(
      "dry-run",
      "block",
      "Nobody has read the built 837. The dry run is the last moment the claim is still yours — after this it is a " +
        "claim at a payer.",
      "Read the segments. Check the billing NPI, the member id, the dates and the charges against what you believe " +
        "you are billing.",
    );
  } else {
    add("dry-run", "ok", "The built 837 has been read segment by segment.");
  }

  const blocked = checks.some((c) => c.level === "block");
  const remainingAfter = Math.max(0, input.liveSubmissionCap - input.priorLiveSubmissions - (blocked ? 0 : 1));

  return {
    checks,
    blocked,
    remainingAfter,
    summary: blocked
      ? "BLOCKED. Nothing may be submitted until the blocking items are resolved."
      : "Nothing blocking. That means the obvious mistakes have been ruled out — it does NOT mean the claim is " +
        "correct. Only the payer decides that.",
  };
}

export function renderFirstSubmission(report: FirstSubmissionReport): string {
  const mark: Record<GateLevel, string> = { block: "BLOCK", warn: " warn", ok: "   ok" };
  const lines = ["First live submission — supervised gate", ""];
  for (const c of report.checks) {
    lines.push(`${mark[c.level]}  ${c.id.padEnd(14)} ${c.message}`);
    if (c.fix) lines.push(`         ${" ".repeat(14)} → ${c.fix}`);
  }
  lines.push("", report.summary);
  if (!report.blocked) {
    lines.push(`After this one, ${report.remainingAfter} submission(s) remain in the supervised window.`);
    lines.push("", AFTER_SUBMISSION);
  }
  return lines.join("\n");
}

/**
 * What to do afterwards — and the thing nobody wants to hear.
 *
 * There is NO ROLLBACK. This is written out in full at the bottom of every
 * passing gate, because the moment it is needed is the moment nobody has time
 * to look it up, and the instinct at that moment — send it again — is the
 * harmful one.
 */
export const AFTER_SUBMISSION = [
  "AFTER IT GOES OUT",
  "",
  "  There is no rollback. A submitted 837 is a claim at a payer. The only things that change it are a VOID",
  "  (frequency code 8) or a REPLACEMENT (frequency code 7), and both are new filings a person has to reason about.",
  "",
  "  1. WAIT for the 277CA acknowledgement. Accepted means the clearinghouse and payer took it — not that it will pay.",
  "  2. If nothing arrives, CHECK STATUS (276/277). Do not resend. A timeout does not tell you whether the payer",
  "     received it, and a duplicate claim is treated as fraud-adjacent and surfaces as a takeback months later.",
  "  3. Record the acknowledgement as filing proof only when it actually arrives. A receipt from a clearinghouse is",
  "     not proof of filing at the payer.",
  "  4. If it was WRONG: void or replace it, referencing the payer's claim number. Do not file a corrected copy as",
  "     a new original — that is the duplicate.",
  "  5. Do not raise the cap until this claim has been acknowledged AND adjudicated. Accepted is not paid.",
].join("\n");
