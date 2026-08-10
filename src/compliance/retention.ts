// ── How long document content is kept ────────────────────────────────────────
//
// §164.530(j) requires documentation retention; it does NOT require keeping
// clinical content forever, and the minimum necessary standard argues the other
// way. What a practice actually wants is: keep an uploaded EOB long enough to
// work the claim, then stop holding a copy of somebody's chart.
//
// Until now `documents purge` existed as a manual command, which is a retention
// POLICY only in the sense that a fire extinguisher nobody is assigned to is a
// fire plan. This makes it a schedule.
//
// The decision is pure and separate from the deleting, for the usual reason:
// "should this be deleted" is a rule worth arguing with in a test, and
// "delete it" is I/O.

export interface RetentionPolicy {
  /**
   * Days to keep extracted document text. 0 means keep indefinitely, which is
   * the default and every existing install's current behaviour.
   */
  documentDays: number;
}

export interface RetentionDecision {
  /** Whether anything should be deleted at all. */
  enforce: boolean;
  /** Delete documents created at or before this millisecond timestamp. */
  cutoff: number;
  /** One line for the boot log. Empty when nothing is enforced. */
  note: string;
}

/**
 * Turn a policy and a clock into a cut-off.
 *
 * `now` is passed rather than read, so a test can assert the arithmetic instead
 * of asserting that time passes. Every other retention rule in this codebase
 * takes the clock the same way.
 *
 * A zero or negative period is OFF, not "delete everything". That asymmetry is
 * deliberate: the failure mode of misreading this setting must be keeping data
 * too long, which is recoverable, rather than destroying a practice's documents
 * because a config value was blank.
 */
export function retentionDecision(policy: RetentionPolicy, now: number): RetentionDecision {
  const days = Number.isFinite(policy.documentDays) ? policy.documentDays : 0;
  if (days <= 0) {
    return { enforce: false, cutoff: 0, note: "" };
  }
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return {
    enforce: true,
    cutoff,
    note: `Document retention: ${days} day(s). Extracted text older than that is deleted at startup.`,
  };
}

/**
 * The sentence to print after enforcing.
 *
 * Says nothing when nothing was deleted. A daily "removed 0 documents" is noise
 * that trains people to skip the line where the real number will one day be.
 */
export function retentionReport(deleted: number, charactersRemoved: number, days: number): string {
  if (deleted === 0) return "";
  return `Retention: deleted ${deleted} document(s) older than ${days} day(s), removing ${charactersRemoved} characters of extracted text.`;
}
