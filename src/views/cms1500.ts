import type { ClaimInput } from "../tools/healthcare/x12/837.js";
import type { ScrubFinding } from "../tools/healthcare/finding.js";
import { classifyPos } from "../tools/healthcare/pos.js";
import type { LineSeverity } from "./types.js";
import { lineNumberOf } from "./build.js";

// ── CMS-1500 (02/12) ─────────────────────────────────────────────────────────
// The claim as the form a biller has been reading for thirty years, with each
// scrub finding attributed to the BOX it belongs to.
//
// BOX NUMBERS ARE THE REAL ONES OR THERE ARE NONE. A grid with invented box
// numbers is worse than a plain table: a table makes no claim, and a form
// labelled "box 24K" teaches somebody a field that does not exist and will be
// quoted back to a payer. Every number below appears on the actual 02/12 form,
// and fields this system does not hold — box 9 other insured, box 23 prior
// authorisation, box 32 service facility — are simply absent rather than shown
// blank, because a blank box on a form reads as "we checked and it is empty".
//
// ATTRIBUTION IS COMPUTED HERE, ON THE SERVER, for the same reason severity and
// the verdict badge are: it is a domain judgement, it is testable here, and a
// browser re-deriving it would drift from the rule engine that produced the
// finding. The browser paints what it is told.

export interface Cms1500Cell {
  box: string;
  label: string;
  value: string;
  severity: LineSeverity;
  findings: string[];
}

export interface Cms1500Line {
  index: number;
  severity: LineSeverity;
  /** Keyed by box: 24A, 24B, 24D, 24E, 24F, 24G, 24J. */
  cells: Cms1500Cell[];
}

export interface Cms1500Diagnosis {
  /** A–L, as printed in box 21 on the 02/12 form. */
  pointer: string;
  code: string;
  severity: LineSeverity;
  findings: string[];
  /** True when no service line points at this diagnosis. */
  unused: boolean;
}

export interface Cms1500View {
  claimId: string;
  payer: string;
  header: Cms1500Cell[];
  diagnoses: Cms1500Diagnosis[];
  lines: Cms1500Line[];
  totalCharge: number;
  /**
   * Findings that belong to no box on this form.
   *
   * Listed rather than pinned somewhere plausible. A credentialing lapse or a
   * missing NCCI table is a fact about the practice or the installation, and
   * putting it in a box would say the claim is wrong where it is not.
   */
  unattributed: Array<{ severity: LineSeverity; rule: string; message: string }>;
  verdict?: "hold" | "review" | "clear";
}

/** Box 21 uses letters, not numbers. dx_pointers are 1-based; A is 1. */
export const DIAGNOSIS_POINTERS = "ABCDEFGHIJKL".split("");

export function pointerLetter(oneBased: number): string {
  return DIAGNOSIS_POINTERS[oneBased - 1] ?? String(oneBased);
}

/**
 * The letters for box 24E, given how many diagnoses box 21 actually holds.
 *
 * A pointer past the end of the diagnosis list must NOT print as a letter. A
 * claim listing three diagnoses and pointing at 5 rendered as "E" — a perfectly
 * ordinary-looking letter for a row that does not exist, which is the dangling
 * pointer made invisible by the very form meant to expose it. Out-of-range
 * pointers print as the raw number with a question mark, so the eye catches
 * them even before the finding underneath is read.
 */
export function pointerCell(pointers: number[], diagnosisCount: number): string {
  return pointers.map((p) => (p >= 1 && p <= diagnosisCount ? pointerLetter(p) : `${p}?`)).join(" ");
}

/**
 * Which box a rule's finding belongs in.
 *
 * Returns null rather than a guess. Every mapping here is a statement about the
 * paper form, so an unmapped rule going to the unattributed list is correct
 * behaviour and not a gap to be filled with the nearest box.
 */
export function boxForRule(rule: string): string | null {
  if (/^date-/.test(rule) || rule === "global-date-format") return "24A";
  if (/^pos-/.test(rule) || /^telehealth-pos/.test(rule)) return "24B";
  if (rule === "dx-format") return "21";
  if (/^dx-pointer-/.test(rule) || rule === "superbill-unused-diagnosis") return "24E";
  if (rule === "superbill-no-diagnosis") return "21";
  if (/^mue-/.test(rule)) return "24G";
  if (rule === "superbill-zero-charge") return "24F";
  if (rule === "npi-billing") return "33a";
  if (rule === "npi-rendering") return "24J";
  // Everything that is a statement about the procedure or its modifiers lands
  // in 24D, which is where both are printed.
  if (/^modifier-/.test(rule)) return "24D";
  if (/^ncci-ptp/.test(rule)) return "24D";
  if (rule === "duplicate-line") return "24D";
  if (/^telehealth-(modifier|async|audio-only|legacy-gt)/.test(rule)) return "24D";
  if (/^global-(postop|same-day-em|decision-for-surgery|modifier)/.test(rule)) return "24D";
  if (/^split-shared-modifier/.test(rule)) return "24D";
  return null;
}

function worst(a: LineSeverity, b: LineSeverity): LineSeverity {
  const order: LineSeverity[] = ["clean", "info", "warning", "error"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

function toLineSeverity(s: ScrubFinding["severity"]): LineSeverity {
  return s;
}

function cell(box: string, label: string, value: string): Cms1500Cell {
  return { box, label, value, severity: "clean", findings: [] };
}

function ymd(date: string): string {
  return /^\d{8}$/.test(date) ? `${date.slice(4, 6)}/${date.slice(6, 8)}/${date.slice(0, 4)}` : date;
}

export function buildCms1500View(
  claim: ClaimInput,
  findings: ScrubFinding[],
  opts: { verdict?: Cms1500View["verdict"] } = {},
): Cms1500View {
  const header: Cms1500Cell[] = [
    cell("1a", "Insured's ID number", claim.subscriber_id),
    cell("2", "Patient's name", `${claim.patient_last}, ${claim.patient_first}`),
    cell("3", "Patient's birth date / sex", `${ymd(claim.patient_dob)}  ${claim.patient_sex}`),
    cell("26", "Patient's account no.", claim.claim_id),
    cell("33", "Billing provider", claim.billing_provider_name),
    cell("33a", "Billing provider NPI", claim.billing_provider_npi),
  ];

  const pointedAt = new Set<number>();
  for (const line of claim.service_lines) for (const p of line.dx_pointers ?? []) pointedAt.add(p);

  const diagnoses: Cms1500Diagnosis[] = claim.diagnoses.map((code, i) => ({
    pointer: pointerLetter(i + 1),
    code,
    severity: "clean",
    findings: [],
    // Not an error on its own — a diagnosis nothing points at is simply not
    // billed, which the scrubber may or may not flag. Shown so it is visible.
    unused: !pointedAt.has(i + 1),
  }));

  const lines: Cms1500Line[] = claim.service_lines.map((l, i) => {
    const pos = classifyPos(l.place_of_service);
    const modifiers = (l.modifiers ?? []).join(" ");
    return {
      index: i + 1,
      severity: "clean",
      cells: [
        cell("24A", "Date(s) of service", ymd(l.service_date)),
        cell("24B", "Place of service", `${l.place_of_service}${pos.entry ? ` ${pos.entry.name}` : ""}`),
        cell("24D", "Procedures, services or supplies", modifiers ? `${l.cpt_hcpcs}  ${modifiers}` : l.cpt_hcpcs),
        // Letters, as the form prints them. Showing "1, 2" here would be the
        // 837's representation on a paper form that does not use it.
        cell("24E", "Diagnosis pointer", pointerCell(l.dx_pointers ?? [], claim.diagnoses.length)),
        cell("24F", "$ Charges", l.charge.toFixed(2)),
        cell("24G", "Days or units", String(l.units ?? 1)),
        cell("24J", "Rendering provider ID", claim.rendering_provider_npi ?? ""),
      ],
    };
  });

  const unattributed: Cms1500View["unattributed"] = [];

  for (const f of findings) {
    const box = boxForRule(f.rule);
    const severity = toLineSeverity(f.severity);
    if (!box) {
      unattributed.push({ severity, rule: f.rule, message: f.message });
      continue;
    }

    if (box === "21") {
      // Diagnosis-level. Without a specific code named in the message there is
      // no way to say WHICH diagnosis, so it goes above the grid rather than
      // colouring an arbitrary letter.
      const hit = diagnoses.find((d) => f.message.includes(d.code));
      if (hit) {
        hit.findings.push(f.message);
        hit.severity = worst(hit.severity, severity);
      } else {
        unattributed.push({ severity, rule: f.rule, message: f.message });
      }
      continue;
    }

    const lineNo = lineNumberOf(f.message);
    if (box.startsWith("24") && lineNo === undefined) {
      // A line-level box with no line to attach it to. Attaching it to line 1
      // would highlight the wrong row, which on a form reads as an assertion
      // about that specific service.
      unattributed.push({ severity, rule: f.rule, message: f.message });
      continue;
    }

    const target = box.startsWith("24") ? lines[lineNo! - 1] : undefined;
    if (box.startsWith("24")) {
      if (!target) {
        unattributed.push({ severity, rule: f.rule, message: f.message });
        continue;
      }
      const c = target.cells.find((x) => x.box === box);
      if (!c) {
        unattributed.push({ severity, rule: f.rule, message: f.message });
        continue;
      }
      c.findings.push(f.message);
      c.severity = worst(c.severity, severity);
      target.severity = worst(target.severity, severity);
      continue;
    }

    const h = header.find((x) => x.box === box);
    if (!h) {
      unattributed.push({ severity, rule: f.rule, message: f.message });
      continue;
    }
    h.findings.push(f.message);
    h.severity = worst(h.severity, severity);
  }

  return {
    claimId: claim.claim_id,
    payer: claim.payer_name,
    header,
    diagnoses,
    lines,
    totalCharge: Math.round(claim.service_lines.reduce((s, l) => s + l.charge * (l.units ?? 1), 0) * 100) / 100,
    unattributed,
    ...(opts.verdict ? { verdict: opts.verdict } : {}),
  };
}
