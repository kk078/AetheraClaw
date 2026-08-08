import { meatEvidence, type MeatCategory } from "../vbc/suspecting.js";
import { buildQuery, type PhysicianQuery } from "./query.js";

// ── Documentation-native CDI ─────────────────────────────────────────────────
// Read the note as it is written and find the places where the record is less
// specific than the patient. Laterality left open, a condition named without its
// severity, a manifestation not linked to its cause.
//
// Two properties keep this on the right side of the line, and they are the same
// two the suspecting module has:
//
//   IT NEVER PROPOSES THE ANSWER. A finding here is a question about a chart,
//   not a more specific code. Offering "you probably meant the left knee" and
//   collecting a click is a leading query wearing a code suggestion's clothes,
//   and the code that comes out of it is indefensible even when it was right.
//
//   UNSPECIFIED IS OFTEN CORRECT. If the provider does not yet know which side,
//   the unspecified code is the accurate one. So nothing here says the
//   documentation is wrong — it says this is where the record could carry more,
//   if the clinical picture supports more.
//
// Every finding carries the sentence it came from, verbatim and with its offset,
// so a reviewer lands on the exact text rather than on the note.

/** The axis along which documentation can be more specific. */
export type Dimension = "laterality" | "severity" | "acuity" | "type" | "linkage" | "stage" | "episode";

/**
 * The vocabulary of each axis.
 *
 * This is what makes a generated query non-leading by construction: the options
 * enumerate the AXIS, not a guess at the answer. "Left / right / bilateral /
 * unable to determine" is exhaustive and carries no preference. A query built
 * from a guessed diagnosis cannot get that property back by rewording.
 */
export const DIMENSION_OPTIONS: Record<Dimension, string[]> = {
  laterality: ["Left", "Right", "Bilateral"],
  severity: ["Mild", "Moderate", "Severe"],
  acuity: ["Acute", "Chronic", "Acute on chronic"],
  type: ["Type 1", "Type 2", "Drug or chemical induced", "Due to an underlying condition"],
  linkage: ["Due to the condition named above", "Unrelated to it", "Causal relationship not established"],
  stage: ["Stage 1", "Stage 2", "Stage 3", "Stage 4", "Stage 5"],
  episode: ["Initial encounter", "Subsequent encounter", "Sequela"],
};

export interface SpecificityRule {
  id: string;
  /** Phrases whose presence marks the less specific form. */
  triggers: string[];
  dimension: Dimension;
  /** What a coder would need to see, in plain words. */
  needs: string;
  /** Where the unspecified documentation usually lands. */
  unspecifiedCode: string;
  /** True when the specific form changes risk adjustment or coverage. */
  affectsRiskAdjustment: boolean;
  /** Overrides the generic option list when the axis is narrower here. */
  options?: string[];
}

export interface NoteExcerpt {
  /** De-identified reference only. Never a name. */
  patientRef: string;
  /** YYYYMMDD. */
  serviceDate: string;
  text: string;
  source: string;
}

export interface CdiFinding {
  patientRef: string;
  ruleId: string;
  dimension: Dimension;
  needs: string;
  /** The sentence, verbatim. */
  quote: string;
  /** Character offset of the trigger within the note — the provenance link. */
  offset: number;
  source: string;
  serviceDate: string;
  /** Which of Monitor/Evaluate/Assess/Treat the surrounding sentence supports. */
  meat: MeatCategory[];
  affectsRiskAdjustment: boolean;
  unspecifiedCode: string;
  rationale: string;
}

/** The sentence containing `at`, with its start offset. */
function sentenceAt(text: string, at: number): { quote: string; start: number } {
  let start = 0;
  for (const mark of [". ", "? ", "! ", "\n"]) {
    const found = text.lastIndexOf(mark, at);
    if (found >= 0 && found + mark.length > start) start = found + mark.length;
  }
  let end = text.length;
  for (const mark of [".", "?", "!", "\n"]) {
    const found = text.indexOf(mark, at);
    if (found >= 0 && found + 1 < end) end = found + 1;
  }
  return { quote: text.slice(start, end).trim(), start };
}

/**
 * Find the specificity gaps in one note.
 *
 * A trigger appearing twice in a note is reported once per sentence, not once
 * per note: two different sentences naming an unlateralised condition are two
 * places a reviewer has to look, and collapsing them hides one.
 */
export function analyzeNote(note: NoteExcerpt, rules: SpecificityRule[]): CdiFinding[] {
  const findings: CdiFinding[] = [];
  const lowered = note.text.toLowerCase();
  const seen = new Set<string>();

  for (const rule of rules) {
    for (const trigger of rule.triggers) {
      const needle = trigger.toLowerCase();
      let at = lowered.indexOf(needle);
      while (at >= 0) {
        const { quote, start } = sentenceAt(note.text, at);
        const key = `${rule.id}|${start}`;
        if (!seen.has(key) && quote.length > 0) {
          seen.add(key);
          findings.push({
            patientRef: note.patientRef,
            ruleId: rule.id,
            dimension: rule.dimension,
            needs: rule.needs,
            quote,
            offset: at,
            source: note.source,
            serviceDate: note.serviceDate,
            meat: meatEvidence(quote),
            affectsRiskAdjustment: rule.affectsRiskAdjustment,
            unspecifiedCode: rule.unspecifiedCode,
            rationale: `The note records "${trigger}" without ${rule.needs}. As written this codes to ${rule.unspecifiedCode}.`,
          });
        }
        at = lowered.indexOf(needle, at + needle.length);
      }
    }
  }

  return findings;
}

/**
 * Order findings by whether clarifying them changes anything.
 *
 * A gap that moves risk adjustment or coverage outranks one that only makes the
 * chart tidier, and a sentence with MEAT evidence behind it outranks a bare
 * mention — a provider asked to clarify a condition nobody addressed will
 * rightly ignore the query, and a CDI programme that sends those loses the
 * attention it needs for the ones that matter.
 */
export function rankFindings(findings: CdiFinding[]): CdiFinding[] {
  return [...findings].sort((a, b) => {
    if (a.affectsRiskAdjustment !== b.affectsRiskAdjustment) return a.affectsRiskAdjustment ? -1 : 1;
    if (a.meat.length !== b.meat.length) return b.meat.length - a.meat.length;
    return a.quote.localeCompare(b.quote);
  });
}

/**
 * Turn a finding into a query.
 *
 * The options come from the axis, never from the finding. That is the whole
 * reason this can be generated at all: an exhaustive, neutral option set is
 * non-leading by construction, while a generated query offering the answer the
 * tool thinks is right would be leading no matter how it were phrased.
 */
export function queryFor(finding: CdiFinding, author: string, rule?: SpecificityRule): PhysicianQuery | string {
  const options = rule?.options ?? DIMENSION_OPTIONS[finding.dimension];
  return buildQuery({
    patientRef: finding.patientRef,
    format: "multiple_choice",
    question: `The record above documents this condition without ${finding.needs}. If the clinical picture supports it, which applies?`,
    clinicalIndicators: [finding.quote],
    options,
    author,
  });
}

export interface CdiSummary {
  findings: CdiFinding[];
  /** Findings that move risk adjustment or coverage. */
  material: CdiFinding[];
  notes: string[];
}

export function summarize(findings: CdiFinding[]): CdiSummary {
  const ranked = rankFindings(findings);
  const material = ranked.filter((f) => f.affectsRiskAdjustment);
  const notes: string[] = [];

  if (ranked.length === 0) {
    notes.push("No specificity gaps matched. That is not the same as a complete note — it means nothing in the rule set fired.");
  }
  const mentionOnly = ranked.filter((f) => f.meat.length === 0);
  if (mentionOnly.length > 0) {
    notes.push(
      `${mentionOnly.length} finding(s) come from sentences with no monitoring, evaluation, assessment or treatment behind them. A query about a condition nobody addressed is one a provider is right to ignore, and sending those costs the attention the real ones need.`,
    );
  }
  notes.push(
    "Every finding is a question about the chart, not a code. Unspecified is frequently the correct answer — if the provider does not yet know which side, the unspecified code is the accurate one.",
  );
  return { findings: ranked, material, notes };
}

export function renderFindings(summary: CdiSummary): string {
  if (summary.findings.length === 0) return summary.notes.join("\n");

  const lines = [
    `${summary.findings.length} specificity gap(s), ${summary.material.length} of which change risk adjustment or coverage.`,
    "",
  ];
  for (const f of summary.findings) {
    lines.push(
      `  [${f.dimension}]${f.affectsRiskAdjustment ? " *" : ""} ${f.needs} — ${f.source} ${f.serviceDate}, offset ${f.offset}`,
      `      "${f.quote}"`,
      `      ${f.rationale}${f.meat.length > 0 ? `  (MEAT: ${f.meat.join(", ")})` : "  (no MEAT evidence in this sentence)"}`,
    );
  }
  lines.push("", ...summary.notes.map((n) => `  ${n}`));
  return lines.join("\n");
}
