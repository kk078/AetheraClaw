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

/**
 * column1 → column2 → modifier indicator.
 *
 * The real published table is 1.7 million pairs, and the original implementation
 * walked all of them for every claim: ~110 ms per scrub, entirely spent deciding
 * that 1,728,583 edits had nothing to do with the two codes on the claim. Keyed
 * by the column-1 code, the cost becomes proportional to the claim instead of to
 * the national edit table.
 */
export type PtpIndex = Map<string, Map<string, string>>;

/** The compact on-disk shape: the same nesting, so loading is a parse and nothing more. */
export type PtpTable = Record<string, Record<string, string>>;

const norm = (code: string) => code.trim().toUpperCase();

/**
 * Build the lookup from either shape.
 *
 * The array form is what earlier data files carry and what every test passes,
 * so it keeps working — indexing it costs one pass, which is what the old scan
 * cost anyway. Nothing gets slower; the caller that caches the index gets fast.
 */
export function indexPtpEdits(source: PtpEdit[] | PtpTable): PtpIndex {
  const index: PtpIndex = new Map();
  const put = (col1: string, col2: string, indicator: string) => {
    const a = norm(col1);
    const b = norm(col2);
    if (!a || !b) return;
    let row = index.get(a);
    if (!row) index.set(a, (row = new Map()));
    row.set(b, indicator);
  };

  if (Array.isArray(source)) {
    for (const e of source) put(e.column1, e.column2, ptpModifierIndicator(e));
  } else {
    for (const [col1, row] of Object.entries(source)) {
      for (const [col2, indicator] of Object.entries(row)) put(col1, col2, indicator);
    }
  }
  return index;
}

export function checkPtpEdits(source: PtpEdit[] | PtpIndex, lines: ScrubLine[]): ScrubFinding[] {
  const index = source instanceof Map ? source : indexPtpEdits(source);
  const out: ScrubFinding[] = [];

  // Line order, not file order: two codes on a claim always produce their
  // findings in the order a reader sees the lines, whatever order CMS published
  // the pairs in.
  const present = lines.map((l) => norm(l.cpt_hcpcs));

  for (const col1 of present) {
    const row = index.get(col1);
    if (!row) continue;
    for (const col2 of present) {
      if (col2 === col1) continue;
      const indicator = row.get(col2);
      if (indicator === undefined) continue;
      if (indicator === "9") continue; // deleted edit

      const line2 = lines.find((l) => norm(l.cpt_hcpcs) === col2);
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
