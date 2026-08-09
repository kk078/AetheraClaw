import { hashPayload } from "../audit/chain.js";

// ── PHI access logging (45 CFR §164.312(b)) ──────────────────────────────────
// The rule requires "hardware, software, and/or procedural mechanisms that
// record and examine activity in information systems that contain or use
// electronic protected health information". Two things follow that are easy to
// get backwards, and the proposed design got both backwards.
//
// FIRST: an access log about PHI must not itself become a PHI store. A log row
// carrying a patient name, an MBI, or a free-text reason quoting the chart is a
// second copy of the record — usually with weaker access control than the first,
// because everyone in compliance can read the logs. So entries here carry a
// RESOURCE REFERENCE and nothing else: no names, no identifiers, no summaries of
// content. What was touched is a pointer; who touched it and when is the
// evidence. If an investigator needs the content they go to the record, through
// an access that is itself logged.
//
// SECOND: reads are the whole point. A log that records writes is a change log.
// §164.312(b) exists because the characteristic HIPAA incident is a person with
// legitimate credentials looking at a record they had no business looking at,
// which leaves no trace at all in a mutation log. READ and EXPORT are the
// entries that matter most, and EXPORT most of all — it is the one action after
// which the organisation no longer controls the copy.
//
// Entries append to the tenant's existing hash chain rather than to a private
// table, so the guarantees already documented in src/audit/chain.ts apply
// unchanged: tamper-evident on its own, tamper-proof only to the extent it is
// anchored outside the database.

export type AccessAction = "read" | "write" | "export" | "print" | "delete" | "amend";

/** Actions after which the organisation no longer controls the copy. */
export const DISCLOSING_ACTIONS: ReadonlySet<AccessAction> = new Set(["export", "print"]);

export type ResourceType = "claim" | "remittance" | "patient_account" | "document" | "worklist_item" | "report" | "appeal";

export interface AccessEvent {
  action: AccessAction;
  resourceType: ResourceType;
  /** A de-identified reference — a claim id, an account ref. Never a name, MBI, SSN or DOB. */
  resourceRef: string;
  actor: string;
  tenantSlug: string;
  /** Source address where one is known. A blank string when the caller is local. */
  sourceAddress: string;
  /** How many records the action touched. A bulk export is a different event from a single read. */
  recordCount: number;
  at: number;
}

/**
 * Identifier shapes that must never appear in a `resourceRef`.
 *
 * Deliberately the same posture as the intake and email paths: detect, refuse,
 * and say so — rather than redact and store, which leaves the surrounding
 * context intact and pretends the problem is handled.
 */
const IDENTIFIER_SHAPES: Array<{ label: string; pattern: RegExp }> = [
  // Dashed or spaced (123-45-6789, 123 45 6789), plus a whole-ref bare
  // nine-digit form: a ref that IS a nine-digit SSN was slipping through, and
  // refusing it is the point. Anchored to the whole ref rather than any
  // nine-digit run so a structured id like "CLM-123456789" is not falsely
  // refused — an embedded run is not evidence of an SSN.
  { label: "SSN", pattern: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/ },
  { label: "SSN", pattern: /^\s*\d{9}\s*$/ },
  // MBI: 11 chars, position 1 a digit 1-9, no S/L/O/I/B/Z anywhere. Medicare
  // cards PRINT it grouped 4-3-4 with hyphens (1EG4-TE5-MK72), so a ref copied
  // straight off a card or a payer letter carries the hyphens; the separators
  // between groups are optional here so both the printed and contiguous forms
  // are caught.
  { label: "Medicare MBI", pattern: /\b[1-9][ACDEFGHJKMNPQRTUVWXY][ACDEFGHJKMNPQRTUVWXY0-9]\d[-\s]?[ACDEFGHJKMNPQRTUVWXY][ACDEFGHJKMNPQRTUVWXY0-9]\d[-\s]?[ACDEFGHJKMNPQRTUVWXY]{2}\d{2}\b/i },
  { label: "legacy HICN", pattern: /\b\d{9}[A-Z]{1,2}\d?\b/ },
  { label: "date of birth", pattern: /\b(?:DOB|D\.O\.B\.|born)\b/i },
  { label: "email address", pattern: /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i },
];

export interface RefCheck {
  ok: boolean;
  found: string[];
}

export function checkResourceRef(ref: string): RefCheck {
  const found = IDENTIFIER_SHAPES.filter((s) => s.pattern.test(ref)).map((s) => s.label);
  return { ok: found.length === 0, found };
}

export interface PreparedEntry {
  kind: string;
  actor: string;
  summary: string;
  payloadHash: string;
  createdAt: number;
}

export type PrepareResult = { ok: true; entry: PreparedEntry } | { ok: false; reason: string };

/**
 * Turn an access event into a chain entry.
 *
 * Pure, and it refuses rather than sanitizes. A caller passing an identifier as
 * a resource reference has a bug at the call site; quietly masking it here would
 * leave that bug in place and let the next one through in a field this function
 * does not inspect.
 */
export function prepareAccessEntry(event: AccessEvent): PrepareResult {
  const check = checkResourceRef(event.resourceRef);
  if (!check.ok) {
    return {
      ok: false,
      reason: `Refusing to log a resource reference containing ${check.found.join(", ")}. An access log must not become a second copy of the record it protects — pass an internal identifier (claim id, account ref), not a patient identifier.`,
    };
  }

  const disclosing = DISCLOSING_ACTIONS.has(event.action);
  const summary = [
    `${event.action.toUpperCase()} ${event.resourceType}:${event.resourceRef}`,
    `tenant=${event.tenantSlug}`,
    `records=${event.recordCount}`,
    event.sourceAddress ? `from=${event.sourceAddress}` : "from=local",
    disclosing ? "DISCLOSING" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    ok: true,
    entry: {
      kind: "phi_access",
      actor: event.actor,
      summary,
      // The payload hash proves the full event was what it says without storing
      // more of it than the summary already shows.
      payloadHash: hashPayload(event),
      createdAt: event.at,
    },
  };
}

export interface AccessReview {
  total: number;
  byAction: Record<string, number>;
  disclosingEvents: number;
  recordsDisclosed: number;
  /** Actors whose export volume stands out. Reported as a question, never as an accusation. */
  bulkExporters: Array<{ actor: string; events: number; records: number }>;
}

/** An export moving at least this many records in one action is worth a human looking at it. */
export const BULK_EXPORT_RECORDS = 100;

/**
 * Summarize access for review.
 *
 * §164.308(a)(1)(ii)(D) requires *regularly reviewing* records of activity, not
 * merely recording them, and an unreviewed log is the common failure — it
 * satisfies an auditor's checklist and catches nothing. This produces the view a
 * reviewer actually needs: what left the building, and who moved unusual volume.
 *
 * The output names people. It is framed as something to ask about rather than
 * something concluded, because the legitimate reasons for a large export — a
 * payer audit response, a year-end close, a data migration — look identical here
 * to the illegitimate ones, and the log cannot tell them apart.
 */
export function reviewAccess(events: AccessEvent[]): AccessReview {
  const byAction: Record<string, number> = {};
  let disclosingEvents = 0;
  let recordsDisclosed = 0;
  const byActor = new Map<string, { events: number; records: number }>();

  for (const e of events) {
    byAction[e.action] = (byAction[e.action] ?? 0) + 1;
    if (!DISCLOSING_ACTIONS.has(e.action)) continue;
    disclosingEvents++;
    recordsDisclosed += e.recordCount;
    const prior = byActor.get(e.actor) ?? { events: 0, records: 0 };
    byActor.set(e.actor, { events: prior.events + 1, records: prior.records + e.recordCount });
  }

  const bulkExporters = [...byActor.entries()]
    .filter(([, v]) => v.records >= BULK_EXPORT_RECORDS)
    .map(([actor, v]) => ({ actor, ...v }))
    .sort((a, b) => b.records - a.records);

  return { total: events.length, byAction, disclosingEvents, recordsDisclosed, bulkExporters };
}

export function renderAccessReview(review: AccessReview, windowLabel: string): string {
  if (review.total === 0) return `No PHI access recorded ${windowLabel}.`;

  const lines = [
    `${review.total} PHI access event(s) ${windowLabel}.`,
    ...Object.entries(review.byAction)
      .sort((a, b) => b[1] - a[1])
      .map(([action, n]) => `  ${action.padEnd(7)} ${n}`),
  ];

  if (review.disclosingEvents === 0) {
    lines.push("", "Nothing was exported or printed. Every access stayed inside the system.");
  } else {
    lines.push(
      "",
      `${review.disclosingEvents} disclosing event(s) moved ${review.recordsDisclosed} record(s) out of the system. These are the ones that matter — after an export the organisation no longer controls the copy.`,
    );
  }

  if (review.bulkExporters.length > 0) {
    lines.push(
      "",
      `Actors moving ${BULK_EXPORT_RECORDS}+ records:`,
      ...review.bulkExporters.map((b) => `  ${b.actor}: ${b.records} record(s) across ${b.events} export(s)`),
      "",
      "This is a question, not a finding. A payer audit response, a year-end close and a data migration all look exactly like this — and so does the thing you are watching for. Ask what each was for and record the answer.",
    );
  }

  lines.push(
    "",
    "Recording activity is only half of §164.308(a)(1)(ii)(D); the rule requires regularly reviewing it. An unreviewed log passes an audit checklist and catches nothing.",
  );
  return lines.join("\n");
}
