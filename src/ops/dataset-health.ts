import { createHash } from "node:crypto";
import { currentRelease, type CodeSetId } from "../tools/healthcare/updates/release-calendar.js";

// ── Reference dataset health ─────────────────────────────────────────────────
// data_status already answers "is it installed". This answers the operational
// question that follows: is what is installed the edition you are billing under,
// and has it changed since you last looked.
//
// One thing this deliberately does NOT do is check a hash "against authoritative
// sources". CMS publishes no manifest hash for these files, and cms.gov refuses
// automated fetches outright — a tool claiming to verify against upstream would
// be verifying against nothing, and an ops team would take a green check as
// proof the file is genuine when it proves only that a download succeeded.
//
// What a hash is genuinely good for is CHANGE DETECTION between your own
// snapshots: record it after an install, compare on the next sweep, and a file
// that changed without a release having happened is a real finding. Staleness is
// answered separately and honestly, from the published release cadence.

export interface DatasetFacts {
  file: string;
  installed: boolean;
  sizeBytes: number;
  modifiedAt: number;
  sha256: string;
  /** Recorded after the last deliberate install, when one was recorded. */
  knownSha256?: string;
  /** Which code set's cadence governs this file, when one does. */
  codeSet?: CodeSetId;
}

export type HealthSeverity = "critical" | "warning" | "info";

export interface HealthFinding {
  severity: HealthSeverity;
  file: string;
  check: string;
  detail: string;
  remedy: string;
}

/** An empty or near-empty JSON file is a failed download, not a dataset. */
export const MIN_PLAUSIBLE_BYTES = 64;

export function hashOf(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function analyzeDataset(facts: DatasetFacts, asOf: string): HealthFinding[] {
  const out: HealthFinding[] = [];
  const at = (severity: HealthSeverity, check: string, detail: string, remedy: string) =>
    out.push({ severity, file: facts.file, check, detail, remedy });

  if (!facts.installed) {
    at(
      "warning",
      "not-installed",
      "File is absent.",
      "The checks that read it do not run. That is a limit on what can be verified, not a clean result — see data_status for what each absence blocks.",
    );
    return out;
  }

  if (facts.sizeBytes < MIN_PLAUSIBLE_BYTES) {
    at(
      "critical",
      "truncated",
      `Only ${facts.sizeBytes} byte(s).`,
      "This is a failed or interrupted download, not a dataset. The loader parses it, gets an empty object, and every edit silently passes — worse than the file being absent, which at least reports itself.",
    );
  }

  if (facts.knownSha256 && facts.knownSha256 !== facts.sha256) {
    at(
      "warning",
      "changed",
      `Contents changed since the recorded install (${facts.knownSha256.slice(0, 12)}… → ${facts.sha256.slice(0, 12)}…).`,
      "Expected after a deliberate quarterly update — record the new hash. Unexpected otherwise: a reference table that changed without anyone updating it is either a partial write or an edit nobody logged, and both change what the scrubber decides.",
    );
  }

  if (facts.codeSet) {
    const shouldBe = currentRelease(facts.codeSet, asOf);
    const installedOn = new Date(facts.modifiedAt).toISOString().slice(0, 10).replace(/-/g, "");
    if (installedOn < shouldBe) {
      at(
        "warning",
        "stale",
        `File dates to ${installedOn}; the current edition took effect ${shouldBe}.`,
        "Which edition applies is decided by the claim's DATE OF SERVICE, not by today — so an old file is correct for old claims and wrong for new ones. Install the current release before working this quarter's dates.",
      );
    }
  }

  return out;
}

export interface HealthReport {
  checked: number;
  findings: HealthFinding[];
  asOf: string;
}

export function renderHealth(report: HealthReport): string {
  const lines: string[] = [];
  if (report.findings.length === 0) {
    lines.push(`${report.checked} reference dataset(s) checked as of ${report.asOf}: nothing to report.`);
  } else {
    lines.push(`${report.checked} reference dataset(s) checked as of ${report.asOf}, ${report.findings.length} finding(s).`, "");
    for (const sev of ["critical", "warning", "info"] as HealthSeverity[]) {
      const group = report.findings.filter((f) => f.severity === sev);
      if (group.length === 0) continue;
      lines.push(`${sev.toUpperCase()} — ${group.length}`);
      for (const f of group) lines.push(`  ${f.file} · ${f.check}: ${f.detail}`, `      ${f.remedy}`);
      lines.push("");
    }
  }
  lines.push(
    "Hashes here detect CHANGE between your own snapshots. They are not verification against CMS: CMS publishes no manifest hash for these files and refuses automated fetches, so a tool claiming to check upstream would be checking nothing while looking like proof.",
  );
  return lines.join("\n").trimEnd();
}
