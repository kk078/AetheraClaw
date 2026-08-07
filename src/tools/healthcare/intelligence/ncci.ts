import { finding, type ScrubFinding } from "../finding.js";

// ── NCCI procedure-to-procedure and medically-unlikely edits ─────────────────
// Both edit families reject claims, but they behave very differently on appeal,
// and telling a coder "add a modifier" when the edit cannot be bypassed wastes
// the appeal window. The indicators published alongside the edits are what
// distinguish the cases, so they are modelled rather than flattened to a boolean.

/** Modifiers that may bypass a PTP edit when the indicator permits it. */
export const PTP_BYPASS_MODIFIERS = ["59", "XE", "XP", "XS", "XU", "25", "57", "91", "24", "58", "78", "79"];

/** The distinct-procedural-service family specifically. */
export const DISTINCT_SERVICE_MODIFIERS = ["59", "XE", "XP", "XS", "XU"];

export interface PtpEdit {
  column1: string;
  column2: string;
  /**
   * 0 — no modifier may bypass this edit.
   * 1 — a modifier may bypass it when documentation supports a distinct service.
   * 9 — the edit has been deleted and does not apply.
   */
  modifierIndicator?: string;
  /** Legacy shape from earlier data files. */
  modifierAllowed?: boolean;
}

export interface MueEdit {
  units: number;
  /**
   * 1 — claim line edit; the same code on separate lines may be considered.
   * 2 — date-of-service edit grounded in policy or anatomy; absolute, and denials are not overturned.
   * 3 — date-of-service edit grounded in a clinical benchmark; more units payable with documentation.
   */
  mai?: string;
}

export type MueTable = Record<string, number | MueEdit>;

export function normalizeMue(entry: number | MueEdit): MueEdit {
  return typeof entry === "number" ? { units: entry } : entry;
}

/** Older data files carried a boolean; the published indicator supersedes it. */
export function ptpModifierIndicator(edit: PtpEdit): string {
  if (edit.modifierIndicator !== undefined) return edit.modifierIndicator;
  if (edit.modifierAllowed !== undefined) return edit.modifierAllowed ? "1" : "0";
  return "1";
}

export interface ScrubLine {
  cpt_hcpcs: string;
  units: number;
  modifiers?: string[];
}

function hasAny(modifiers: string[] | undefined, wanted: string[]): boolean {
  const set = new Set((modifiers ?? []).map((m) => m.trim().toUpperCase()));
  return wanted.some((w) => set.has(w));
}

export function checkPtpEdits(edits: PtpEdit[], lines: ScrubLine[]): ScrubFinding[] {
  const out: ScrubFinding[] = [];
  const codes = new Set(lines.map((l) => l.cpt_hcpcs.trim().toUpperCase()));

  for (const edit of edits) {
    const col1 = edit.column1.trim().toUpperCase();
    const col2 = edit.column2.trim().toUpperCase();
    if (!codes.has(col1) || !codes.has(col2)) continue;

    const indicator = ptpModifierIndicator(edit);
    if (indicator === "9") continue; // deleted edit

    const line2 = lines.find((l) => l.cpt_hcpcs.trim().toUpperCase() === col2);
    const bypassed = hasAny(line2?.modifiers, DISTINCT_SERVICE_MODIFIERS);

    if (indicator === "0") {
      out.push(
        finding(
          "error",
          "ncci-ptp-no-bypass",
          `NCCI PTP edit: ${col2} is bundled into ${col1} and the modifier indicator is 0 — no modifier can unbundle this pair. Billing ${col2} separately will deny and the denial will not be overturned. Report ${col1} alone${bypassed ? `; the distinct-service modifier on ${col2} does not help here` : ""}.`,
        ),
      );
      continue;
    }

    if (!bypassed) {
      out.push(
        finding(
          "error",
          "ncci-ptp",
          `NCCI PTP edit: ${col2} is bundled into ${col1}. Modifier indicator 1 — a distinct-service modifier (59, or the more specific XE/XP/XS/XU) may be appropriate if the documentation shows a separate session, site, or encounter. Do not append one to clear the edit unless the record supports it.`,
        ),
      );
    } else {
      out.push(
        finding(
          "info",
          "ncci-ptp-bypassed",
          `NCCI PTP edit between ${col1} and ${col2} is being bypassed by a distinct-service modifier on ${col2}. Permitted by indicator 1, but this pairing draws audit attention — make sure the record documents the separate session, site, or encounter.`,
        ),
      );
    }
  }
  return out;
}

export function checkMueEdits(table: MueTable, lines: ScrubLine[]): ScrubFinding[] {
  const out: ScrubFinding[] = [];
  for (const line of lines) {
    const code = line.cpt_hcpcs.trim().toUpperCase();
    const raw = table[code];
    if (raw === undefined) continue;
    const edit = normalizeMue(raw);
    if (line.units <= edit.units) continue;

    if (edit.mai === "2") {
      out.push(
        finding(
          "error",
          "mue-absolute",
          `MUE: ${code} billed with ${line.units} units against a limit of ${edit.units}. Adjudication indicator 2 — this is an absolute date-of-service limit grounded in policy or anatomy. It cannot be bypassed, split across lines, or won on appeal. Correct the units.`,
        ),
      );
    } else if (edit.mai === "3") {
      out.push(
        finding(
          "error",
          "mue-clinical",
          `MUE: ${code} billed with ${line.units} units against a limit of ${edit.units}. Adjudication indicator 3 — a clinical benchmark, so more units can be payable. Expect a denial on submission; it is appealable with records showing the units were furnished and medically necessary.`,
        ),
      );
    } else {
      out.push(
        finding(
          "error",
          edit.mai === "1" ? "mue-line" : "mue",
          `MUE: ${code} billed with ${line.units} units against a limit of ${edit.units}${edit.mai === "1" ? ". Adjudication indicator 1 — a claim-line edit, so units genuinely furnished across separate sessions may be reported on separate lines with an appropriate modifier" : ""}.`,
        ),
      );
    }
  }
  return out;
}
