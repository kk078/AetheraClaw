import { z } from "zod";
import { defineTool } from "../../registry.js";
import type { MemoryStore } from "../../../memory/store.js";
import type { Config } from "../../../config/config.js";
import { ClaimSchema, build837p } from "../x12/837.js";
import { scrubClaim } from "../claim-scrub.js";
import { ncciDataNotice } from "../datasets.js";
import { getConnector } from "./index.js";
import { evaluateFirstSubmission, renderFirstSubmission } from "./first-submission.js";
import { diffAgainstBelief, renderDryRun } from "./dry-run.js";
import { countLiveSubmissions, listLiveSubmissions, priorSubmissionOf, renderLedger } from "./live-ledger.js";

// The agent-facing surface for the supervised window. Deliberately three
// separate tools rather than one that does everything: the dry run and the gate
// must be runnable WITHOUT anything being sendable, or the safe step and the
// dangerous one share a button.

/** The cap for the supervised window, until somebody raises it deliberately. */
const DEFAULT_LIVE_CAP = 1;

function capFrom(config: Config | undefined): number {
  const raw = (config?.healthcare as { liveSubmissionCap?: number } | undefined)?.liveSubmissionCap;
  return typeof raw === "number" && raw >= 0 ? raw : DEFAULT_LIVE_CAP;
}

export const firstSubmissionDryRunTool = defineTool({
  name: "claim_dry_run",
  description:
    "Render exactly what a payer would receive for this claim, annotated segment by segment, and diff it against " +
    "what this system believes it is billing. Sends NOTHING. Run this before any live submission — it is the last " +
    "moment the claim is still yours, because after a send the only corrections are a void or a replacement.",
  schema: z.object({ claim: ClaimSchema }),
  execute: async (input) => {
    const claim = input.claim;
    const x12 = build837p(claim);
    const belief = {
      claimRef: claim.claim_id,
      billingNpi: claim.billing_provider_npi,
      subscriberId: claim.subscriber_id,
      totalCharge: claim.service_lines.reduce((n, l) => n + l.charge, 0),
      serviceDates: [...new Set(claim.service_lines.map((l) => l.service_date))],
      procedureCodes: claim.service_lines.map((l) => l.cpt_hcpcs),
    };
    return { content: renderDryRun(x12, belief, diffAgainstBelief(x12, belief)) };
  },
});

export const firstSubmissionCheckTool = defineTool({
  name: "claim_first_submission_check",
  description:
    "Run the supervised gate for a live claim submission: the cap, the connector's environment, the approval " +
    "policy, the scrub, the filing window, eligibility, and whether a person has read the built 837. Sends " +
    "NOTHING and decides nothing — it reports what would block. Call it before the first live submission from any " +
    "deployment, and before each one until the supervised window closes.",
  schema: z.object({
    claim: ClaimSchema,
    supervisor: z.string().describe("The person watching this go out. Recorded."),
    dry_run_reviewed: z.boolean().default(false).describe("Has somebody read the output of claim_dry_run, segment by segment?"),
    eligibility_verified: z.boolean().default(false),
    filing_days_left: z.number().int().nullable().default(null),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    const config = ctx.services.config as Config | undefined;
    const choice = config ? getConnector(config) : null;

    const findings = scrubClaim(input.claim);
    // Datasets that are absent make a check NOT RUN, which is not the same as
    // a check that passed. Carried into the gate so it can say so rather than
    // report a clean scrub over a missing NCCI table.
    const notRun = ncciDataNotice() ? ["NCCI/MUE bundling"] : [];

    const report = evaluateFirstSubmission({
      connectorName: choice?.connector.name ?? "none",
      environment: choice?.connector.environment ?? "sandbox",
      approvalPolicy: config?.approvalPolicy ?? "always",
      priorLiveSubmissions: store ? countLiveSubmissions(store) : 0,
      liveSubmissionCap: capFrom(config),
      scrubFindings: findings,
      chargeAmount: input.claim.service_lines.reduce((n, l) => n + l.charge, 0),
      filingDaysLeft: input.filing_days_left,
      eligibilityVerified: input.eligibility_verified,
      supervisor: input.supervisor,
      checksNotRun: notRun,
      dryRunReviewed: input.dry_run_reviewed,
    });

    // A claim already sent is the one thing the gate itself cannot know, and it
    // is the most important thing to say. Checked here, where the store is.
    const prior = store ? priorSubmissionOf(store, build837p(input.claim)) : null;
    const duplicateWarning = prior
      ? [
          "",
          `THIS EXACT CLAIM WAS ALREADY SENT on ${new Date(prior.createdAt).toISOString().slice(0, 10)} ` +
            `(outcome: ${prior.outcome}${prior.receiptId ? `, receipt ${prior.receiptId}` : ""}).`,
          "Sending it again creates a DUPLICATE. If the outcome is unknown, check status (276/277) — do not resend.",
        ].join("\n")
      : "";

    return {
      content: renderFirstSubmission(report) + duplicateWarning,
      isError: report.blocked,
    };
  },
});

export const liveSubmissionLedgerTool = defineTool({
  name: "claim_live_ledger",
  description:
    "Every 837 this deployment has attempted to send to a real payer, with its outcome. Read this before saying " +
    "anything about what has or has not been filed — and before resending anything, because a submission with an " +
    "UNKNOWN outcome may already be sitting at the payer.",
  schema: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "No store attached." };
    return { content: renderLedger(listLiveSubmissions(store, input.limit)) };
  },
});

export const FIRST_SUBMISSION_TOOLS = [
  firstSubmissionDryRunTool,
  firstSubmissionCheckTool,
  liveSubmissionLedgerTool,
];
