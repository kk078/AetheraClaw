import type { CodeSetId } from "./updates/release-calendar.js";
import { CODE_SETS, assessStaleness, currentRelease } from "./updates/release-calendar.js";
import type { DatasetStatus } from "./datasets.js";

// ── Is the installed reference data still the right data ─────────────────────
//
// `data_status` answers "is the file there". That is half the question, and the
// less dangerous half. A practice with every file installed and last quarter's
// NCCI edits gets confident, specific, wrong answers about bundling — and finds
// out through denials three weeks later.
//
// THE DISTINCTION THIS MODULE IS BUILT AROUND: when a file landed on disk is not
// the same fact as which edition it contains. A file downloaded this morning can
// carry last quarter's release. A file copied from a colleague's laptop last
// week can be perfectly current.
//
// So mtime is used for exactly one inference, the only one it can support:
//
//   downloaded BEFORE the current release took effect  →  PROVABLY STALE.
//   downloaded after                                   →  UNKNOWN, not "current".
//
// The second verdict is the one that matters, and it is deliberately not
// "current". Calling an undated file current would convert an absence of
// information into a statement of safety — the same failure `evaluateGate`
// refuses to make about a skipped NCCI check, for the same reason.
//
// Every function here takes `asOf` as a string. Nothing calls the clock, so a
// test can put the machine in any quarter without touching the system time.

export type LifecycleVerdict = "missing" | "stale" | "unknown-edition" | "current";

export interface DatasetLifecycle {
  file: string;
  purpose: string;
  installed: boolean;
  /** Which published release cadence governs this file, when one does. */
  codeSet: CodeSetId | null;
  /** The edition the FILE ITSELF declares. Empty when it declares none. */
  declaredEdition: string;
  /** YYYYMMDD the file landed on disk, or "" when it is not installed. */
  installedOn: string;
  /** The release currently in effect for this file's code set. */
  currentRelease: string;
  verdict: LifecycleVerdict;
  /** How many published releases have taken effect since the declared edition. */
  missedReleases: number;
  message: string;
}

/** Which release cadence governs each dataset file. */
const FILE_CODE_SETS: Record<string, CodeSetId> = {
  "ncci-ptp.json": "ncci",
  "mue.json": "ncci",
  "icd10.json": "icd10cm",
  "hcpcs.json": "hcpcs",
  "mpfs.json": "mpfs",
  "mpfs-cf.json": "mpfs",
  "gpci.json": "mpfs",
};

/**
 * A dataset status plus what the caller could learn about the file on disk.
 *
 * Split out as an input rather than read here so this module does no I/O and the
 * whole thing is testable from literals.
 */
export interface DatasetProbe {
  status: DatasetStatus;
  /** YYYYMMDD from the file's mtime, or "" when absent. */
  installedOn: string;
  /**
   * The edition the file declares, normalised to the YYYYMMDD its release took
   * effect — e.g. an ICD-10-CM table stamped FY2026 declares 20251001. Empty
   * when the file carries no edition at all, which is most of them.
   */
  declaredEffective: string;
}

/** Turn an ICD-10-CM fiscal year into the date its release took effect. */
export function fiscalYearToEffective(fy: number): string {
  // FY2026 runs from 1 October 2025. Getting this backwards would report every
  // current table as a year stale.
  return `${fy - 1}1001`;
}

export function assessDataset(probe: DatasetProbe, asOf: string): DatasetLifecycle {
  const { status, installedOn, declaredEffective } = probe;
  const codeSet = FILE_CODE_SETS[status.file] ?? null;
  const current = codeSet ? currentRelease(codeSet, asOf) : "";
  const base = {
    file: status.file,
    purpose: status.purpose,
    installed: status.installed,
    codeSet,
    declaredEdition: declaredEffective,
    installedOn,
    currentRelease: current,
    missedReleases: 0,
  };

  if (!status.installed) {
    return {
      ...base,
      verdict: "missing",
      message: `${status.file} is not installed. ${status.absentMeans}`,
    };
  }
  if (!codeSet) {
    return { ...base, verdict: "unknown-edition", message: `${status.file} is installed. No release cadence is known for it.` };
  }

  // Best case: the file says what it is. Believe the file over the filesystem.
  if (declaredEffective) {
    const s = assessStaleness(codeSet, declaredEffective, asOf);
    return {
      ...base,
      missedReleases: s.missedReleases,
      verdict: s.stale ? "stale" : "current",
      message: s.message,
    };
  }

  // No declared edition. The only sound inference left is the negative one.
  if (installedOn && installedOn < current) {
    return {
      ...base,
      verdict: "stale",
      missedReleases: 1,
      message:
        `${status.file} was installed on ${installedOn}, before the ${CODE_SETS[codeSet].label} release effective ` +
        `${current}. It cannot contain that release. Re-fetch it.`,
    };
  }
  return {
    ...base,
    verdict: "unknown-edition",
    message:
      `${status.file} carries no edition stamp, and it landed on disk on ${installedOn || "an unknown date"} — after the ` +
      `current ${CODE_SETS[codeSet].label} release (${current}), so it is not provably out of date. That is NOT the same ` +
      "as current: a file downloaded today can hold last quarter's data. Re-fetch if you did not download it yourself.",
  };
}

// ── What each job actually needs ─────────────────────────────────────────────
//
// Required means: without this file, a tool in this profile gives a WRONG answer
// rather than a smaller one. Optional means it degrades and says so.
//
// The list is short on purpose. Marking everything required makes the warning
// unreadable, and an unread warning is the same as no warning.

export interface ProfileDataNeed {
  profile: string;
  required: string[];
  optional: string[];
  /** What goes wrong when a required file is absent, in one sentence per profile. */
  because: string;
}

export const PROFILE_DATA_NEEDS: ProfileDataNeed[] = [
  {
    profile: "coding",
    required: ["icd10.json"],
    optional: ["hcpcs.json", "ncci-ptp.json", "mue.json"],
    because:
      "Without the ICD-10-CM code set, icd10_validate falls back to a network API that does not name its edition — so a " +
      "code retired last October validates as fine.",
  },
  {
    profile: "claims",
    required: ["ncci-ptp.json", "mue.json", "icd10.json"],
    optional: ["hcpcs.json", "mpfs.json"],
    because:
      "The scrubber reports 'no bundling edit found' the same way whether it checked and found nothing or could not check " +
      "at all. On the claims profile that sentence goes out attached to a claim.",
  },
  {
    profile: "denials",
    required: ["ncci-ptp.json"],
    optional: ["mue.json", "icd10.json"],
    because: "Explaining a bundling denial without the edit table means explaining it from memory.",
  },
  {
    profile: "revenue",
    required: ["mpfs.json", "mpfs-cf.json"],
    optional: ["gpci.json"],
    because:
      "reimbursement_estimate refuses without RVUs and a conversion factor, so every money question on this profile " +
      "returns a refusal instead of a number.",
  },
  { profile: "operations", required: [], optional: ["icd10.json", "ncci-ptp.json"], because: "" },
  { profile: "ops", required: [], optional: [], because: "" },
  { profile: "all", required: [], optional: [], because: "" },
];

export interface ReadinessReport {
  profile: string;
  /** Required files that are absent. The reason to warn at all. */
  missingRequired: DatasetLifecycle[];
  /** Installed files that have provably fallen behind a published release. */
  stale: DatasetLifecycle[];
  /** Installed, governed by a cadence, and carrying no edition stamp. */
  unknownEdition: DatasetLifecycle[];
  because: string;
  /** True when a required file is missing OR an installed one is provably stale. */
  warn: boolean;
}

export function assessReadiness(
  lifecycles: DatasetLifecycle[],
  profile: string,
): ReadinessReport {
  const need = PROFILE_DATA_NEEDS.find((p) => p.profile === profile);
  const required = new Set(need?.required ?? []);
  const missingRequired = lifecycles.filter((l) => required.has(l.file) && !l.installed);
  const stale = lifecycles.filter((l) => l.verdict === "stale");
  const unknownEdition = lifecycles.filter((l) => l.verdict === "unknown-edition" && l.codeSet !== null);
  return {
    profile,
    missingRequired,
    stale,
    unknownEdition,
    because: need?.because ?? "",
    // Deliberately NOT warning on unknown-edition. It is the common state of a
    // correct install, and a warning that fires every single boot is one people
    // learn to scroll past — which costs the warnings that matter.
    warn: missingRequired.length > 0 || stale.length > 0,
  };
}

/** One or two lines for the startup banner. Empty when there is nothing to say. */
export function renderStartupWarning(report: ReadinessReport): string {
  if (!report.warn) return "";
  const lines: string[] = [];
  if (report.missingRequired.length > 0) {
    lines.push(
      `Reference data: ${report.missingRequired.map((l) => l.file).join(", ")} missing for the "${report.profile}" profile.`,
    );
    if (report.because) lines.push(`  ${report.because}`);
  }
  for (const s of report.stale) lines.push(`  STALE: ${s.message}`);
  lines.push("  Run `orion data refresh` to fetch the current public CMS files.");
  return lines.join("\n");
}

export function renderReadiness(report: ReadinessReport, lifecycles: DatasetLifecycle[]): string {
  const order: Record<LifecycleVerdict, number> = { missing: 0, stale: 1, "unknown-edition": 2, current: 3 };
  const label: Record<LifecycleVerdict, string> = {
    missing: "MISSING  ",
    stale: "STALE    ",
    "unknown-edition": "undated  ",
    current: "current  ",
  };
  const lines = [`Reference data readiness for the "${report.profile}" profile:`, ""];
  for (const l of [...lifecycles].sort((a, b) => order[a.verdict] - order[b.verdict])) {
    lines.push(`${label[l.verdict]}${l.file.padEnd(15)} ${l.purpose}`);
  }
  lines.push("");
  if (report.missingRequired.length > 0) {
    lines.push(`REQUIRED and missing: ${report.missingRequired.map((l) => l.file).join(", ")}`);
    if (report.because) lines.push(report.because);
    lines.push("");
  }
  for (const s of report.stale) lines.push(s.message);
  if (report.unknownEdition.length > 0) {
    lines.push(
      "",
      `${report.unknownEdition.length} file(s) carry no edition stamp. They are not reported as current, because a file ` +
        "downloaded today can hold last quarter's data — and reporting them as current would turn not knowing into a " +
        "statement of safety.",
    );
  }
  if (!report.warn && report.unknownEdition.length === 0) lines.push("Nothing missing, nothing provably stale.");
  return lines.join("\n");
}
