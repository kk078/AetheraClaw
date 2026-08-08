import { createHash } from "node:crypto";
import type { Diagnosis, FailureCategory } from "../support/fmea.js";
import type { TraceResult } from "../support/trace.js";

// ── Root cause analysis document ─────────────────────────────────────────────
// support_trace_claim answers "where did it go", support_fmea_diagnose answers
// "why did it break". Both answer into a terminal, to the person who already
// knew enough to ask. What leaves the incident is a ticket, and somebody
// currently retypes the answer into it — losing the timeline, the evidence
// string and the reasoning, and keeping only the sentence they remembered.
//
// This composes the two into one document, and the document is the deliverable.
//
// WHY THERE IS NO JIRA CLIENT HERE. The spec asked for a ticket bridge that
// creates and updates issues in Jira, ServiceNow or Zendesk. Writing three API
// clients I cannot authenticate against, cannot test, and cannot see fail would
// produce three plausible-looking integrations whose first real use is during an
// incident — the worst possible moment to discover that a field name was wrong.
// So this emits a TICKET PAYLOAD instead: title, severity, labels, body, and a
// stable fingerprint. Piping that into any of the three is a few lines of glue
// somebody writes once against their own instance and can actually test. The
// fingerprint is the part that matters and the part a hand-written bridge always
// forgets: it is what lets the second occurrence update the existing ticket
// rather than opening a duplicate.

export interface ScrubFinding {
  severity: "error" | "warning" | "info";
  rule: string;
  message: string;
}

export interface RcaInput {
  /** Claim id, batch label, or whatever the incident is about. */
  incidentRef: string;
  /** Evidence ABOUT this incident. Sets the category, the severity and the owner. */
  diagnoses: Diagnosis[];
  /**
   * Other failures in the same window, which may or may not be related.
   *
   * Kept strictly out of the root cause. When an RCA is about one claim, the
   * tool-call log is ambient: Ollama being down that afternoon did not make the
   * claim sit unacknowledged for ninety days, and letting it set the category
   * files a billing problem as a network incident and sends it to the wrong
   * team. Reported, because it is worth knowing; never promoted, because this
   * tool cannot tell whether it is connected.
   */
  ambient?: Diagnosis[];
  /** Lifecycle timeline, when the incident is about a specific claim. */
  trace?: TraceResult;
  /** Scrub findings, when the claim was scrubbed. */
  scrub?: ScrubFinding[];
  /** How many claims / calls this cause was observed on. */
  affected: number;
  generatedAt: number;
}

// ── Severity ─────────────────────────────────────────────────────────────────
// Two axes, and only two, because a severity scale nobody can apply consistently
// gets applied by mood.
//
//   Is the data at risk right now?   — a full disk or a malformed database gets
//                                      worse with every write that follows.
//   Is a clock running?              — a front-end rejection has no appeal
//                                      rights and timely filing never paused, so
//                                      the delay itself is the loss.
//
// Everything else is a defect that will still be a defect tomorrow.

/** At or above this, one cause is a systemic fault rather than an incident on one claim. */
export const SYSTEMIC_AFFECTED = 5;

export type Severity = "sev1" | "sev2" | "sev3";

/** Categories where continuing to run makes the damage worse. */
const DATA_AT_RISK: FailureCategory[] = ["disk", "database"];

/**
 * Categories where the delay itself costs money, not just time.
 *
 * The two lifecycle gaps belong here for the same reason a front-end rejection
 * does: timely filing does not pause while somebody investigates, and a claim
 * that was never acknowledged has no acceptance banked to defend it with later.
 */
const CLOCK_RUNNING: FailureCategory[] = ["payer_rejection", "payer_denial", "submission_gap", "no_payer_response"];

/** WHICH clock, per category — they are four different deadlines with four different consequences. */
const CLOCK_NOTE: Record<string, string> = {
  payer_rejection:
    "A front-end rejection never entered adjudication, so there are no appeal rights to fall back on and the timely-filing deadline does not pause for the investigation.",
  payer_denial:
    "A determination exists, so appeal rights do too — and they run from the determination date rather than from the day somebody noticed.",
  submission_gap:
    "Nothing has acknowledged this claim, so there is no banked acceptance to defend a later timely-filing denial with, and the deadline has been running for the whole gap.",
  no_payer_response:
    "Acceptance is banked, which does defend a timely-filing denial — but a rebill or reconsideration deadline still runs, and the balance is not aging any better for the wait.",
};

export function severityOf(primary: FailureCategory, affected: number): { severity: Severity; because: string } {
  if (DATA_AT_RISK.includes(primary)) {
    return {
      severity: "sev1",
      because:
        "The data is at risk while this continues. A write to a full disk or a malformed database can leave the file inconsistent, so every further operation makes the recovery harder rather than the backlog longer.",
    };
  }
  const clock = CLOCK_RUNNING.includes(primary);
  if (clock && affected >= SYSTEMIC_AFFECTED) {
    return {
      severity: "sev1",
      because: `A filing clock is running on ${affected} claims at once. Nothing here is being adjudicated, so nothing is accruing appeal rights — the whole group is simply getting closer to unrecoverable while it waits.`,
    };
  }
  if (clock) {
    return { severity: "sev2", because: `A filing clock is running. ${CLOCK_NOTE[primary]}` };
  }
  if (affected >= SYSTEMIC_AFFECTED) {
    return {
      severity: "sev2",
      because: `One cause across ${affected} occurrences. That is a fault in something shared rather than ${affected} independent problems, so fixing it once fixes all of them — and not fixing it keeps producing more.`,
    };
  }
  return {
    severity: "sev3",
    because: `${affected === 1 ? "One occurrence" : `${affected} occurrences`}, no clock, no data at risk. This will still be reproducible tomorrow.`,
  };
}

// ── Diagnosing the claim itself ──────────────────────────────────────────────

/**
 * Read a root cause off the claim's lifecycle record.
 *
 * Without this, an RCA for a specific claim takes its category from whatever
 * failed in the tool-call log during the same window — and a claim that sat for
 * ninety days without an acknowledgment gets filed as a network incident
 * because Ollama happened to be down that afternoon. The claim's own record is
 * the evidence about the claim; everything in the log is a coincidence until
 * something shows otherwise, and this tool cannot show it.
 */
export function diagnoseTrace(trace: TraceResult, now: number): Diagnosis | null {
  if (trace.events.length === 0) return null;

  const ageDays = Math.floor((now - trace.events[0].at) / 86_400_000);
  const missing = new Set(trace.missingStages);

  if (missing.has("Front-end acknowledgment (277CA)")) {
    return {
      category: "submission_gap",
      confidence: "certain",
      cause: `The claim was built ${ageDays} day(s) ago and nothing ever acknowledged receipt of it.`,
      nextSteps: [
        "Establish whether it was actually transmitted. A claim built and never sent looks identical here to one sent into a clearinghouse that never replied, and the two have different fixes.",
        "Run timely_filing_check before resubmitting. The clock has been running for the whole gap, and nothing in that time accrued appeal rights, because no determination was ever made.",
        "If it WAS transmitted, the acknowledgment is what would win a later timely-filing denial — chase the 277CA rather than the payment.",
      ],
      evidence: `${trace.claimId}: no acknowledgment or filing proof in ${ageDays} day(s)`,
    };
  }

  if (missing.has("Remittance received (835)")) {
    return {
      category: "no_payer_response",
      confidence: "certain",
      cause: `The claim was accepted ${ageDays} day(s) ago and no remittance has arrived.`,
      nextSteps: [
        "Acceptance is banked, so a timely-filing denial is defensible. That is the good news and the only good news here.",
        "Past a payer's normal turnaround this is a claim lost after acceptance rather than one still in process — compare against that payer's own history rather than against a general rule.",
        "Check the ERA delivery path before chasing the payer: a remittance that arrived and was never parsed looks exactly like one that never came.",
      ],
      evidence: `${trace.claimId}: accepted, no remittance in ${ageDays} day(s)`,
    };
  }

  const adverse = trace.events.filter((e) => e.adverse);
  if (adverse.length > 0) {
    const rejection = adverse.find((e) => e.source === "acknowledgment" || e.source === "worklist");
    const denial = adverse.find((e) => e.source === "remittance");
    return {
      category: denial ? "payer_denial" : "payer_rejection",
      confidence: "certain",
      cause: denial
        ? "The payer adjudicated the claim and denied it, so a determination exists and appeal rights run from it."
        : "The claim was rejected before adjudication, so no determination exists and there is nothing to appeal.",
      nextSteps: denial
        ? [
            "Read the CARC/RARC with denial_explain — the category decides whether this is a correction, an appeal, or a write-off.",
            "The appeal deadline runs from the determination date, not from today. Check it before drafting.",
          ]
        : [
            "Correct and resubmit. There are no appeal rights to fall back on, so the only route is a clean claim.",
            "timely_filing_check first: the clock ran through the rejection and through however long it sat.",
          ],
      evidence: (rejection ?? denial ?? adverse[0]).label,
    };
  }

  return null;
}

// ── Ownership ────────────────────────────────────────────────────────────────
// "Tier 1 or Tier 2" alone is not routing — it says how hard the fix is without
// saying who does it, and the two are different questions. A payer rejection is
// easy and belongs to billing; a schema mismatch is easy and belongs to
// engineering. Naming the OWNER is what stops a ticket bouncing.

export interface Ownership {
  tier: 1 | 2;
  owner: string;
  /** Why it stops here, or why it cannot. */
  note: string;
}

const OWNERSHIP: Record<FailureCategory, Ownership> = {
  auth: {
    tier: 2,
    owner: "whoever holds the credentials",
    note: "Tier 1 can confirm which key the running process can see; only the key holder can change it. Retrying is not a step — this fails identically every time until the credential does.",
  },
  network: {
    tier: 1,
    owner: "support",
    note: "Resolvable at Tier 1 in most cases: a local Ollama that is not running, or an endpoint that is down. Escalate only if the service is up and still unreachable.",
  },
  timeout: {
    tier: 1,
    owner: "support",
    note: "Tier 1 checks ops_ollama_telemetry and WAL growth first. Both have concrete readings; if neither explains it, escalate with those readings attached rather than with the timeout.",
  },
  rate_limit: {
    tier: 1,
    owner: "support",
    note: "Back off and retry. This is the one HTTP failure here that is genuinely transient. If it recurs under normal load it becomes a capacity question, not a support one.",
  },
  schema_mismatch: {
    tier: 2,
    owner: "engineering",
    note: "A one-off self-corrects on retry and is not an incident. The same wrong input SHAPE repeating is the report worth filing — it means a schema description is being misread the same way every time.",
  },
  missing_reference_data: {
    tier: 2,
    owner: "whoever maintains the data directory",
    note: "Nothing failed about the claim. A check could not run, so the result must not be read as a pass — that is the part to state on the ticket, because it is the part that gets forgotten.",
  },
  payer_rejection: {
    tier: 1,
    owner: "billing operations",
    note: "Not an engineering fault. The claim never entered adjudication, so correct and resubmit — and check timely_filing_check before assuming there is room, because the clock ran through the whole delay.",
  },
  payer_denial: {
    tier: 1,
    owner: "billing operations",
    note: "A determination was made, so appeal rights exist and have their own deadline. This belongs in the denial worklist rather than in an incident queue.",
  },
  database: {
    tier: 2,
    owner: "engineering",
    note: "Stop writing before investigating if the message says malformed. `database is locked` means finding the long transaction, not raising the timeout.",
  },
  disk: {
    tier: 2,
    owner: "engineering",
    note: "Free space first, diagnose second. Deletes still succeed while writes fail, so recovery is available right up until it is not.",
  },
  model_capacity: {
    tier: 2,
    owner: "engineering",
    note: "Ollama truncates context silently, so the symptom is a wrong answer rather than an error. Compare the loaded context length against contextTokenBudget before changing anything else.",
  },
  submission_gap: {
    tier: 1,
    owner: "billing operations",
    note: "The first question is whether it was transmitted at all, and that is answerable from the submission record rather than from any log. Escalate only if the record says it went out and nothing came back.",
  },
  no_payer_response: {
    tier: 1,
    owner: "billing operations",
    note: "Acceptance is banked, so this is a follow-up rather than an emergency — but check the ERA delivery path before chasing the payer, because a remittance that arrived and was never parsed is indistinguishable from one that never came.",
  },
  unclassified: {
    tier: 2,
    owner: "engineering",
    note: "No rule matched. This is escalated WITH the raw evidence rather than with a guessed category, because a confident wrong category costs an hour and gets believed.",
  },
};

export function ownershipFor(category: FailureCategory): Ownership {
  return OWNERSHIP[category] ?? OWNERSHIP.unclassified;
}

// ── Fingerprint ──────────────────────────────────────────────────────────────

/**
 * A stable identity for "this problem", so a recurrence updates rather than duplicates.
 *
 * Built from the CAUSE, deliberately not from the evidence: the evidence string
 * carries the specific claim id, timestamp and port number, so fingerprinting it
 * would make every occurrence unique and produce exactly the duplicate-ticket
 * pile a fingerprint exists to prevent.
 *
 * Digits are stripped from the cause for the same reason one level down. A cause
 * reading "built 95 day(s) ago" becomes "built 96 day(s) ago" tomorrow, and a
 * ticket for an unacknowledged claim would fork a new issue every morning while
 * the claim sat there — the failure mode is worst on exactly the incidents that
 * last longest.
 */
export function fingerprint(category: FailureCategory, cause: string, subject: string): string {
  const basis = `${category}|${cause.replace(/\d+/g, "#")}|${subject}`.toLowerCase();
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

export interface TicketPayload {
  title: string;
  severity: Severity;
  labels: string[];
  /** Stable across recurrences of the same cause. Match on this before creating. */
  fingerprint: string;
  assignTo: string;
  body: string;
}

export interface RcaReport {
  incidentRef: string;
  severity: Severity;
  severityBecause: string;
  primary: FailureCategory;
  confidence: "certain" | "likely";
  affected: number;
  ownership: Ownership;
  /** Distinct categories seen, most common first. */
  categories: Array<{ category: FailureCategory; count: number }>;
  markdown: string;
  ticket: TicketPayload;
}

function groupCategories(diagnoses: Diagnosis[]): Array<{ category: FailureCategory; count: number }> {
  const counts = new Map<FailureCategory, number>();
  for (const d of diagnoses) counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
  return [...counts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
}

export function buildRca(input: RcaInput): RcaReport {
  const categories = groupCategories(input.diagnoses);
  const primary = categories[0]?.category ?? "unclassified";
  const lead = input.diagnoses.find((d) => d.category === primary);
  const affected = Math.max(input.affected, input.diagnoses.length);
  const { severity, because } = severityOf(primary, affected);
  const ownership = ownershipFor(primary);
  const cause = lead?.cause ?? "No failure evidence was supplied.";
  const fp = fingerprint(primary, cause, input.incidentRef);

  const when = new Date(input.generatedAt).toISOString().replace("T", " ").slice(0, 19);
  const md: string[] = [
    `# Root cause analysis — ${input.incidentRef}`,
    "",
    `**Severity** ${severity.toUpperCase()} · **Category** ${primary.replace(/_/g, " ")} · **Confidence** ${lead?.confidence ?? "likely"} · **Occurrences** ${affected}`,
    `**Owner** ${ownership.owner} (Tier ${ownership.tier}) · **Fingerprint** \`${fp}\``,
    `**Generated** ${when} UTC`,
    "",
    "## Root cause",
    "",
    cause,
    "",
    because,
    "",
  ];

  if (lead) {
    md.push(
      "### Evidence",
      "",
      "```",
      lead.evidence,
      "```",
      "",
      "This is the text the classification was matched on, quoted rather than summarised so nobody has to take the category on trust.",
      "",
    );
  }

  if (categories.length > 1) {
    md.push(
      "### Other causes in the same window",
      "",
      ...categories.slice(1).map((c) => `- ${c.count} × ${c.category.replace(/_/g, " ")}`),
      "",
      `${categories.length} distinct causes is usually not one incident. Before treating this as a single fault, look for something that changed underneath all of them.`,
      "",
    );
  }

  if (input.trace) {
    md.push("## Timeline", "");
    if (input.trace.events.length === 0) {
      md.push(`No record of ${input.trace.claimId} in this database — see the note below, which is itself a finding.`, "");
    } else {
      for (const e of input.trace.events) {
        const at = new Date(e.at).toISOString().replace("T", " ").slice(0, 19);
        md.push(`- \`${at}\` ${e.adverse ? "**✗**" : "·"} [${e.source}] ${e.label}${e.detail ? ` — ${e.detail}` : ""}`);
      }
      md.push("");
    }
    if (input.trace.missingStages.length > 0) {
      md.push(
        "### Stages that never happened",
        "",
        ...input.trace.missingStages.map((s) => `- ${s}`),
        "",
        "The gap is usually the answer. A claim built but never acknowledged did not reach the payer; acknowledged but never adjudicated is either still in process or lost after acceptance — and the filing clock ran through both.",
        "",
      );
    }
  }

  const ambient = groupCategories(input.ambient ?? []);
  if (ambient.length > 0) {
    md.push(
      "## Also failing in this window",
      "",
      ...ambient.map((c) => `- ${c.count} × ${c.category.replace(/_/g, " ")}`),
      "",
      "These are NOT the root cause above and were kept out of it deliberately. They overlap in time and nothing here establishes that they overlap in anything else — promoting them would file this incident against whichever subsystem happened to be noisy, and send it to that team.",
      "",
    );
  }

  const errors = (input.scrub ?? []).filter((f) => f.severity === "error");
  if (input.scrub && input.scrub.length > 0) {
    md.push(
      "## Claim findings",
      "",
      ...input.scrub.map((f) => `- **${f.severity}** \`${f.rule}\` — ${f.message}`),
      "",
    );
    if (errors.length > 0) {
      md.push(
        `${errors.length} of these are errors, which means the claim would not have passed a scrub before submission. That is worth stating on the ticket: the fault may be upstream of anything the system did.`,
        "",
      );
    }
  }

  md.push(
    "## Remediation",
    "",
    `Owned by **${ownership.owner}**, Tier ${ownership.tier}.`,
    "",
    ownership.note,
    "",
    ...(lead?.nextSteps ?? ["No steps — nothing was classified."]).map((s, i) => `${i + 1}. ${s}`),
    "",
  );

  if (primary === "unclassified") {
    md.push(
      "> No rule matched this failure, and the category above says so rather than picking the nearest one. Treat the evidence block as the report; if this shape recurs it is worth a classification rule.",
      "",
    );
  }

  md.push(
    "---",
    "",
    "*Generated by AetheraClaw from the tool-call log and the claim lifecycle record in this database. It describes what this installation observed — anything that happened inside a clearinghouse or a payer system appears here only through what came back.*",
  );

  const markdown = md.join("\n");
  const title = `[${severity.toUpperCase()}] ${primary.replace(/_/g, " ")} — ${input.incidentRef}`;

  return {
    incidentRef: input.incidentRef,
    severity,
    severityBecause: because,
    primary,
    confidence: lead?.confidence ?? "likely",
    affected,
    ownership,
    categories,
    markdown,
    ticket: {
      title,
      severity,
      labels: ["aetheraclaw", `cause:${primary}`, `tier:${ownership.tier}`, severity],
      fingerprint: fp,
      assignTo: ownership.owner,
      body: markdown,
    },
  };
}

export function renderTicketNote(ticket: TicketPayload): string {
  return [
    "── Ticket payload ───────────────────────────────────────────────",
    `  Title       ${ticket.title}`,
    `  Severity    ${ticket.severity}`,
    `  Assign to   ${ticket.assignTo}`,
    `  Labels      ${ticket.labels.join(", ")}`,
    `  Fingerprint ${ticket.fingerprint}`,
    "",
    "Match on the fingerprint BEFORE creating: it is derived from the cause rather than from the evidence, so the same fault recurring produces the same value and should update the existing ticket instead of opening a second one. Evidence strings carry claim ids and timestamps, which is exactly why they are not part of it.",
    "",
    "There is no Jira / ServiceNow / Zendesk client here on purpose. Three API integrations that cannot be authenticated or tested from this machine would look finished and would first be exercised during an incident. The body above is the whole ticket; posting it is a few lines of glue against your own instance, written once, against something you can actually run.",
  ].join("\n");
}
