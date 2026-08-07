import type { ClaimInput } from "../x12/837.js";
import type { Era } from "../x12/835.js";
import { baseProcedureCode } from "../x12/segments.js";

// ── Code-set diffing ─────────────────────────────────────────────────────────
// A release diff on its own is noise: a typical October ICD-10-CM update adds
// several hundred codes, and none of them matter unless the practice bills in
// that neighbourhood. What matters is the intersection of the diff with the
// codes this practice actually submits, which is why every function here takes
// usage alongside the diff.

/** Codes are compared without dots or case: "E11.65", "e1165" and "E1165" are one code. */
export function normalizeCode(code: string): string {
  return code.replace(/\./g, "").trim().toUpperCase();
}

/** Descriptions differing only in case or whitespace are not revisions. */
function normalizeDescription(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export interface CodeSnapshot {
  label: string;
  /** YYYYMMDD the edition takes effect. */
  effective: string;
  /** code → description, in whatever spelling the source file uses. */
  codes: Record<string, string>;
}

export interface AddedOrDeleted {
  code: string;
  description: string;
}

export interface Revision {
  code: string;
  from: string;
  to: string;
}

export interface CodeSetDiff {
  added: AddedOrDeleted[];
  deleted: AddedOrDeleted[];
  revised: Revision[];
  previousCount: number;
  nextCount: number;
}

export function diffCodeSets(previous: CodeSnapshot, next: CodeSnapshot): CodeSetDiff {
  const prev = new Map<string, string>();
  for (const [code, desc] of Object.entries(previous.codes)) prev.set(normalizeCode(code), desc);
  const cur = new Map<string, string>();
  for (const [code, desc] of Object.entries(next.codes)) cur.set(normalizeCode(code), desc);

  const added: AddedOrDeleted[] = [];
  const deleted: AddedOrDeleted[] = [];
  const revised: Revision[] = [];

  for (const [code, desc] of cur) {
    const before = prev.get(code);
    if (before === undefined) added.push({ code, description: desc });
    else if (normalizeDescription(before) !== normalizeDescription(desc)) revised.push({ code, from: before, to: desc });
  }
  for (const [code, desc] of prev) {
    if (!cur.has(code)) deleted.push({ code, description: desc });
  }

  const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code);
  return {
    added: added.sort(byCode),
    deleted: deleted.sort(byCode),
    revised: revised.sort(byCode),
    previousCount: prev.size,
    nextCount: cur.size,
  };
}

/**
 * The set of codes that are a proper prefix of some other code in the set.
 *
 * In ICD-10 a code is billable only when nothing sits below it. When an October
 * release gives an existing code children, that code silently stops being
 * billable — it is one of the most common ways a practice's established codes
 * start rejecting on October 1 without anything about the practice changing.
 */
export function parentPrefixes(codes: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const raw of codes) {
    const code = normalizeCode(raw);
    // ICD-10-CM categories start at three characters; shorter prefixes are not codes.
    for (let len = 3; len < code.length; len++) out.add(code.slice(0, len));
  }
  return out;
}

// ── Usage: what this practice actually bills ─────────────────────────────────

export interface CodeUsage {
  code: string;
  count: number;
  /** Latest YYYYMMDD date of service seen for this code, "" when unknown. */
  lastServiceDate: string;
}

export interface PracticeUsage {
  diagnoses: Map<string, CodeUsage>;
  procedures: Map<string, CodeUsage>;
}

function bump(map: Map<string, CodeUsage>, rawCode: string, serviceDate: string): void {
  const code = normalizeCode(rawCode);
  if (!code) return;
  const slot = map.get(code) ?? { code, count: 0, lastServiceDate: "" };
  slot.count++;
  if (serviceDate > slot.lastServiceDate) slot.lastServiceDate = serviceDate;
  map.set(code, slot);
}

/**
 * Build usage from both directions of the claim lifecycle: claims record what
 * was submitted (with diagnoses and dates of service), remittances record what
 * was adjudicated. Remittance lines carry no service date, so procedure usage
 * drawn from an ERA contributes counts without dates.
 */
export function collectCodeUsage(claims: ClaimInput[], eras: Era[]): PracticeUsage {
  const diagnoses = new Map<string, CodeUsage>();
  const procedures = new Map<string, CodeUsage>();

  for (const claim of claims) {
    const latest = claim.service_lines.reduce((max, l) => (l.service_date > max ? l.service_date : max), "");
    for (const dx of claim.diagnoses) bump(diagnoses, dx, latest);
    for (const line of claim.service_lines) bump(procedures, line.cpt_hcpcs, line.service_date);
  }
  for (const era of eras) {
    for (const claim of era.claims) {
      for (const line of claim.lines) {
        // parse835 records claim-level adjustments as a synthetic line.
        if (line.procedure === "(claim level)") continue;
        bump(procedures, baseProcedureCode(line.procedure), "");
      }
    }
  }
  return { diagnoses, procedures };
}

// ── Impact: the diff, intersected with usage ─────────────────────────────────

export type ImpactKind =
  | "deleted-in-use"
  | "now-nonbillable"
  | "revised-in-use"
  | "more-specific-available";

export interface CodeImpact {
  severity: "error" | "warning" | "info";
  kind: ImpactKind;
  code: string;
  usageCount: number;
  message: string;
}

export interface ImpactReport {
  effective: string;
  setLabel: string;
  impacts: CodeImpact[];
  /** Diff entries that touched no billed code — counted, never listed. */
  ignored: { added: number; deleted: number; revised: number };
  billedCodesChecked: number;
}

export interface ImpactOptions {
  setLabel: string;
  effective: string;
  /** ICD-10 sets are hierarchical: gaining a child makes a code non-billable. */
  hierarchical: boolean;
  /**
   * Every code in the PREVIOUS edition. Required to tell a code that just became
   * a header from one that always was one — the diff alone cannot distinguish
   * them, and guessing from it reports codes as newly-broken when they were
   * never billable in the first place.
   */
  previousCodes: Iterable<string>;
}

export function assessCodeImpact(
  diff: CodeSetDiff,
  usage: Map<string, CodeUsage>,
  opts: ImpactOptions,
): ImpactReport {
  const impacts: CodeImpact[] = [];
  const ignored = { added: 0, deleted: 0, revised: 0 };

  for (const d of diff.deleted) {
    const used = usage.get(d.code);
    if (!used) {
      ignored.deleted++;
      continue;
    }
    impacts.push({
      severity: "error",
      kind: "deleted-in-use",
      code: d.code,
      usageCount: used.count,
      message: `${d.code} ("${d.description}") is deleted effective ${opts.effective}, and you have billed it ${used.count} time(s)${used.lastServiceDate ? `, most recently for DOS ${used.lastServiceDate}` : ""}. Claims with a date of service on or after ${opts.effective} must use a replacement code; claims for earlier dates keep the old code.`,
    });
  }

  for (const r of diff.revised) {
    const used = usage.get(r.code);
    if (!used) {
      ignored.revised++;
      continue;
    }
    impacts.push({
      severity: "warning",
      kind: "revised-in-use",
      code: r.code,
      usageCount: used.count,
      message: `${r.code} was reworded effective ${opts.effective} (was "${r.from}", now "${r.to}") and you bill it ${used.count} time(s). Confirm it still describes what you are using it for — a narrowed description is a coding change even though the code did not move.`,
    });
  }

  // Codes that gained children in the new edition. Additions surfaced this way
  // are reported, so they must not also be counted as unreported below.
  const reportedAdditions = new Set<string>();
  if (opts.hierarchical) {
    const wasParent = parentPrefixes(opts.previousCodes);
    for (const [code, used] of usage) {
      const children = diff.added.filter((a) => a.code.startsWith(code) && a.code.length > code.length);
      if (children.length === 0) continue;
      for (const child of children) reportedAdditions.add(child.code);
      // A code that already had children was already a non-billable header, so
      // new subcodes under it are an opportunity, not a break.
      const alreadyParent = wasParent.has(code);
      impacts.push({
        severity: alreadyParent ? "info" : "error",
        kind: alreadyParent ? "more-specific-available" : "now-nonbillable",
        code,
        usageCount: used.count,
        message: alreadyParent
          ? `${code} gained ${children.length} new subcode(s) effective ${opts.effective} (${children.slice(0, 4).map((c) => c.code).join(", ")}${children.length > 4 ? ", …" : ""}). You bill in this family ${used.count} time(s) — a more specific code may now exist.`
          : `${code} gained ${children.length} child code(s) effective ${opts.effective} (${children.slice(0, 4).map((c) => c.code).join(", ")}${children.length > 4 ? ", …" : ""}), which makes ${code} itself a non-billable header. You have billed it ${used.count} time(s); every claim with a date of service on or after ${opts.effective} must use one of the new, more specific codes.`,
      });
    }
  }

  ignored.added = diff.added.length - reportedAdditions.size;

  const rank = { error: 0, warning: 1, info: 2 } as const;
  impacts.sort((a, b) => rank[a.severity] - rank[b.severity] || b.usageCount - a.usageCount || a.code.localeCompare(b.code));

  return {
    effective: opts.effective,
    setLabel: opts.setLabel,
    impacts,
    ignored,
    billedCodesChecked: usage.size,
  };
}

export function renderImpactReport(report: ImpactReport, diff: CodeSetDiff): string {
  const lines: string[] = [
    `${report.setLabel} — release effective ${report.effective}`,
    `Code set: ${diff.previousCount} → ${diff.nextCount} codes (+${diff.added.length} added, −${diff.deleted.length} deleted, ~${diff.revised.length} reworded)`,
    `Checked against ${report.billedCodesChecked} code(s) this practice has billed.`,
    "",
  ];

  if (report.impacts.length === 0) {
    lines.push("No codes you bill are affected by this release.");
  } else {
    const errors = report.impacts.filter((i) => i.severity === "error");
    const warnings = report.impacts.filter((i) => i.severity === "warning");
    const infos = report.impacts.filter((i) => i.severity === "info");
    if (errors.length) {
      lines.push(`BREAKING — ${errors.length} code(s) you bill stop working on ${report.effective}:`);
      for (const i of errors) lines.push(`  ${i.message}`);
      lines.push("");
    }
    if (warnings.length) {
      lines.push(`REVIEW — ${warnings.length} code(s) you bill changed meaning:`);
      for (const i of warnings) lines.push(`  ${i.message}`);
      lines.push("");
    }
    if (infos.length) {
      lines.push(`OPPORTUNITY — ${infos.length} family/families gained more specific codes:`);
      for (const i of infos) lines.push(`  ${i.message}`);
      lines.push("");
    }
  }

  lines.push(
    `Not reported: ${report.ignored.deleted} deleted and ${report.ignored.revised} reworded code(s) you have never billed, plus ${report.ignored.added} additions outside the families you bill.`,
    "",
    "Which edition applies is decided by the DATE OF SERVICE, not the submission date. A claim spanning the effective date has to be split so each service date carries the code set in force that day.",
  );
  return lines.join("\n");
}
