// ── Operations that failed or stalled ────────────────────────────────────────
// The spec asked for a dead-letter queue inspector. There is no message queue
// here — one process, one database — so a tool listing "queue messages" would be
// listing nothing while implying a pipeline exists.
//
// What DOES accumulate silently, and is the same operational problem, is work
// that entered the system and stopped moving:
//
//   Mail held at the boundary because it carried identifier-shaped text. This
//   deployment is not approved for PHI and an inbox is where it arrives unasked,
//   so it is held rather than stored — but held mail is invisible until someone
//   looks, and a records request sitting in quarantine has a clock running.
//
//   Scheduled jobs that should have fired and did not. A job whose run_at passed
//   long ago either never re-armed after a restart or is wedged, and either way
//   the reminders it was supposed to send were not sent.
//
//   Claims stalled mid-pipeline on the blackboard, with the attempt counter
//   climbing.
//
//   Worklist items past their deadline, which are no longer work.
//
// Every one of these is a backlog nobody is looking at, which is exactly what a
// DLQ inspector is for. The name says what it is.

export type StalledKind = "quarantined_mail" | "overdue_job" | "stuck_claim" | "expired_worklist";

export interface StalledItem {
  kind: StalledKind;
  id: string;
  label: string;
  /** How long it has been stuck. Null when there is no meaningful clock. */
  ageDays: number | null;
  detail: string;
  /** True when the delay itself causes loss, rather than merely being untidy. */
  losing: boolean;
}

export interface FailedOpsReport {
  items: StalledItem[];
  byKind: Array<{ kind: StalledKind; count: number; losing: number }>;
}

/** A job more than this far past its scheduled time did not simply run late. */
export const OVERDUE_JOB_HOURS = 6;

/** Attempts at one stage beyond this is wedged, not retrying. */
export const STUCK_ATTEMPTS = 3;

export function summarize(items: StalledItem[]): FailedOpsReport {
  const grouped = new Map<StalledKind, { count: number; losing: number }>();
  for (const i of items) {
    const slot = grouped.get(i.kind) ?? { count: 0, losing: 0 };
    slot.count++;
    if (i.losing) slot.losing++;
    grouped.set(i.kind, slot);
  }
  return {
    // Losing items first, then oldest — the ordering a support engineer works in.
    items: [...items].sort((a, b) => Number(b.losing) - Number(a.losing) || (b.ageDays ?? 0) - (a.ageDays ?? 0)),
    byKind: [...grouped.entries()].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.losing - a.losing || b.count - a.count),
  };
}

const KIND_LABELS: Record<StalledKind, string> = {
  quarantined_mail: "Mail held at the PHI boundary",
  overdue_job: "Scheduled jobs that should have fired",
  stuck_claim: "Claims stalled mid-pipeline",
  expired_worklist: "Worklist items past their deadline",
};

export function renderFailedOps(report: FailedOpsReport, limit = 25): string {
  if (report.items.length === 0) {
    return "Nothing stalled: no held mail, no overdue jobs, no wedged claims, no expired worklist items.";
  }

  const losing = report.items.filter((i) => i.losing).length;
  const lines = [
    `${report.items.length} stalled item(s)${losing > 0 ? `, ${losing} of which are losing value while they sit` : ""}.`,
    "",
    ...report.byKind.map((g) => `  ${String(g.count).padStart(4)} × ${KIND_LABELS[g.kind]}${g.losing > 0 ? ` (${g.losing} losing)` : ""}`),
    "",
  ];

  for (const i of report.items.slice(0, limit)) {
    lines.push(
      `  ${i.losing ? "✗" : "·"} [${i.kind}] ${i.label}${i.ageDays !== null ? ` — ${i.ageDays}d` : ""}`,
      `      ${i.detail}`,
    );
  }
  if (report.items.length > limit) lines.push(`  … and ${report.items.length - limit} more.`);

  if (losing > 0) {
    lines.push(
      "",
      "The items marked ✗ are not merely untidy — the delay itself is the loss. A records request in quarantine has an ADR clock running; a worklist item past its deadline is no longer recoverable on the merits.",
    );
  }
  lines.push(
    "",
    "This is not a message-queue DLQ: there is no queue here, just one process over SQLite. It is work that entered the system and stopped moving, which is the same operational problem under an accurate name.",
  );
  return lines.join("\n");
}
