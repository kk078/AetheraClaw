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

  // DISTINCT codes, in first-appearance order: two codes on a claim produce their
  // findings in the order a reader sees the lines, whatever order CMS published
  // the pairs in — and de-duplicated, because the SAME code on two lines (a
  // split-line resubmission) otherwise emitted the identical PTP finding twice.
  const present: string[] = [];
  const seenCode = new Set<string>();
  for (const l of lines) {
    const code = norm(l.cpt_hcpcs);
    if (!seenCode.has(code)) {
      seenCode.add(code);
      present.push(code);
    }
  }

  for (const col1 of present) {
    const row = index.get(col1);
    if (!row) continue;
    for (const col2 of present) {
      if (col2 === col1) continue;
      const indicator = row.get(col2);
      if (indicator === undefined) continue;
      if (indicator === "9") continue; // deleted edit

      // Consider EVERY line carrying col2, not just the first — a distinct-service
      // modifier on a later split line was invisible when only lines.find() was
      // consulted. And the bypass test uses the full published bypass set, not
      // only 59/X{EPSU}: a correctly-coded E/M with modifier 25 (or a global-period
      // 57, or 91 on a repeat lab) against an indicator-1 pair was wrongly reported
      // as an error recommending a 59 it does not need.
      const col2Lines = lines.filter((l) => norm(l.cpt_hcpcs) === col2);
      const bypassed = col2Lines.some((l) => hasAny(l.modifiers, PTP_BYPASS_MODIFIERS));

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

  // MAI 2 and 3 are DATE-OF-SERVICE edits: the limit is on the total units of the
  // code across the whole claim date, and the MAI-2 finding itself says it
  // "cannot be bypassed, split across lines, or won on appeal". Checking each
  // line on its own let two J1885 lines of 3 units each (6 total) pass a limit of
  // 4 — the exact split-across-lines evasion the edit exists to stop. So the
  // date-of-service families are summed per code; MAI 1 is a genuine per-line
  // edit and stays per line.
  const totalByCode = new Map<string, { units: number; lines: number }>();
  for (const line of lines) {
    const code = line.cpt_hcpcs.trim().toUpperCase();
    const acc = totalByCode.get(code) ?? { units: 0, lines: 0 };
    acc.units += line.units;
    acc.lines += 1;
    totalByCode.set(code, acc);
  }

  // Per-line MAI-1 (and untyped) findings, in line order.
  for (const line of lines) {
    const code = line.cpt_hcpcs.trim().toUpperCase();
    const raw = table[code];
    if (raw === undefined) continue;
    const edit = normalizeMue(raw);
    if (edit.mai === "2" || edit.mai === "3") continue; // summed below
    if (line.units <= edit.units) continue;
    out.push(
      finding(
        "error",
        edit.mai === "1" ? "mue-line" : "mue",
        `MUE: ${code} billed with ${line.units} units against a limit of ${edit.units}${edit.mai === "1" ? ". Adjudication indicator 1 — a claim-line edit, so units genuinely furnished across separate sessions may be reported on separate lines with an appropriate modifier" : ""}.`,
      ),
    );
  }

  // Per-code MAI-2/3 findings on the SUMMED units, in first-appearance order.
  const seen = new Set<string>();
  for (const line of lines) {
    const code = line.cpt_hcpcs.trim().toUpperCase();
    if (seen.has(code)) continue;
    seen.add(code);
    const raw = table[code];
    if (raw === undefined) continue;
    const edit = normalizeMue(raw);
    if (edit.mai !== "2" && edit.mai !== "3") continue;
    const total = totalByCode.get(code)!;
    if (total.units <= edit.units) continue;
    const acrossLines = total.lines > 1 ? ` (${total.units} across ${total.lines} lines)` : "";
    if (edit.mai === "2") {
      out.push(
        finding(
          "error",
          "mue-absolute",
          `MUE: ${code} billed with ${total.units} units${acrossLines} against a limit of ${edit.units}. Adjudication indicator 2 — this is an absolute date-of-service limit grounded in policy or anatomy. It cannot be bypassed, split across lines, or won on appeal. Correct the units.`,
        ),
      );
    } else {
      out.push(
        finding(
          "error",
          "mue-clinical",
          `MUE: ${code} billed with ${total.units} units${acrossLines} against a limit of ${edit.units}. Adjudication indicator 3 — a clinical benchmark, so more units can be payable. Expect a denial on submission; it is appealable with records showing the units were furnished and medically necessary.`,
        ),
      );
    }
  }
  return out;
}
