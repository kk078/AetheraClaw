// ── Claim lifecycle trace ────────────────────────────────────────────────────
// "Where did this claim go" is the first question of every support call, and
// answering it meant querying six tables by hand and reconciling their notions
// of a claim id. This assembles the timeline.
//
// It is deliberately NOT called a distributed trace, because there is nothing
// distributed to trace: Orion is one Node process over SQLite. There are
// no microservice hops, no tunnel segments and no queue transitions, and a tool
// drawing them would be drawing fiction. What it does have is a real, ordered
// record of everything that touched a claim — build, scrub, submission,
// acknowledgment, remittance, worklist, appeal, audit-chain entry — and that is
// what answers the question.
//
// The one genuinely hard part is that a claim id is written six different ways.
// `computeArAging` normalizes with trim+uppercase; the 835 carries whatever the
// payer echoed; a worklist item stores it inside a JSON blob. Normalizing
// identically everywhere is what makes this a timeline rather than six lists.

export type EventSource =
  | "claim"
  | "remittance"
  | "acknowledgment"
  | "filing_proof"
  | "worklist"
  | "blackboard"
  | "audit_chain"
  | "twin_prediction";

export interface TraceEvent {
  at: number;
  source: EventSource;
  label: string;
  detail: string;
  /** Set when this event represents a failure or a denial. */
  adverse?: boolean;
}

/** The same normalization computeArAging uses — they must agree or the two disagree about reality. */
export function normalizeClaimId(raw: string): string {
  return raw.trim().toUpperCase();
}

export interface TraceResult {
  claimId: string;
  events: TraceEvent[];
  /** Stages with no event at all — the gap is usually the answer. */
  missingStages: string[];
  /** Wall-clock from the first event to the last. */
  spanDays: number | null;
}

/**
 * Stages a claim normally passes through, in order.
 *
 * Reported by ABSENCE rather than presence: a support engineer asking where a
 * claim went is nearly always looking for the step that never happened, and a
 * timeline that only lists what did happen makes them infer the gap. Naming it
 * turns a scan into a read.
 */
const EXPECTED_STAGES: Array<{ key: string; label: string; sources: EventSource[] }> = [
  { key: "built", label: "Claim built and stored", sources: ["claim"] },
  { key: "acknowledged", label: "Front-end acknowledgment (277CA)", sources: ["acknowledgment", "filing_proof"] },
  { key: "adjudicated", label: "Remittance received (835)", sources: ["remittance"] },
];

export function assembleTrace(claimId: string, events: TraceEvent[]): TraceResult {
  const ordered = [...events].sort((a, b) => a.at - b.at || a.source.localeCompare(b.source));
  const present = new Set(ordered.map((e) => e.source));
  const missingStages = EXPECTED_STAGES.filter((s) => !s.sources.some((src) => present.has(src))).map((s) => s.label);

  const spanDays =
    ordered.length >= 2 ? Math.round((ordered[ordered.length - 1].at - ordered[0].at) / 86_400_000) : null;

  return { claimId: normalizeClaimId(claimId), events: ordered, missingStages, spanDays };
}

export function renderTrace(result: TraceResult): string {
  if (result.events.length === 0) {
    return [
      `No record of claim ${result.claimId} anywhere in this database.`,
      "",
      "That is itself a finding: nothing built it, no acknowledgment named it, no remittance mentioned it. Check the claim id (they are normalized to trimmed uppercase here), and check whether the work happened in a different tenant — a claim in another tenant's database is unreachable from this connection by design, not missing.",
    ].join("\n");
  }

  const lines = [
    `Claim ${result.claimId} — ${result.events.length} event(s)${result.spanDays !== null ? ` over ${result.spanDays} day(s)` : ""}`,
    "",
  ];

  for (const e of result.events) {
    const when = new Date(e.at).toISOString().replace("T", " ").slice(0, 19);
    lines.push(`  ${when}  ${e.adverse ? "✗" : "·"} [${e.source}] ${e.label}`);
    if (e.detail) lines.push(`                       ${e.detail}`);
  }

  if (result.missingStages.length > 0) {
    lines.push(
      "",
      `NEVER HAPPENED — ${result.missingStages.length} expected stage(s):`,
      ...result.missingStages.map((s) => `  ${s}`),
      "",
      "The gap is usually the answer. A claim built but never acknowledged did not reach the payer; acknowledged but never adjudicated is either still in process or lost after acceptance, and the filing clock kept running through both.",
    );
  }

  const adverse = result.events.filter((e) => e.adverse);
  if (adverse.length > 0) {
    lines.push("", `${adverse.length} adverse event(s): ${adverse.map((e) => e.label).join("; ")}`);
  }

  lines.push(
    "",
    "This is the record in THIS database, not a distributed trace — Orion is one process over SQLite, so there are no service hops or queue transitions to show. Anything that happened in a clearinghouse or a payer's system is visible here only through what came back.",
  );
  return lines.join("\n");
}
