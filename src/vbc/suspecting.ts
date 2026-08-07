import type { HccModel } from "./hcc.js";

// ── Suspecting ───────────────────────────────────────────────────────────────
// An algorithm that reads documentation and proposes diagnoses is the single
// most scrutinised thing in value-based care, and reasonably so: it is the exact
// mechanism behind the risk-adjustment fraud cases the Department of Justice has
// been bringing for a decade.
//
// So this module is built with one structural property that the usual product is
// not, and it is not a setting:
//
//   IT LOOKS BOTH WAYS. Every run reports conditions that are documented but not
//   coded AND conditions that are coded but not documented. A tool that only
//   ever suggests adding codes is an upcoding engine no matter what its
//   documentation says, because the only direction it can move a risk score is
//   up. Reporting both is what makes it a review rather than a ratchet.
//
// The second property follows from the first: nothing here codes anything. Every
// output is a proposal carrying the sentence it came from, routed to the same
// review queue as every other suggested code, where a coder accepts or rejects
// it with a reason. A suspect condition is a question about a chart.

/**
 * Whether CMS may extrapolate a RADV audit's findings across a whole contract
 * is, as of this writing, unsettled: the rule permitting it was vacated by a
 * federal district court in September 2025 and CMS appealed in November 2025.
 *
 * Encoded as unsettled on purpose. Assuming extrapolation is dead invites
 * sloppiness; assuming it is alive overstates a live legal question. What does
 * not depend on the outcome is that a condition without documentation behind it
 * is an overpayment either way.
 */
export const RADV_EXTRAPOLATION_STATUS =
  "Whether RADV findings can be extrapolated across a contract is unsettled — the rule allowing it was vacated in September 2025 and is under appeal. Do not plan around either answer. A condition with no documentation behind it is repayable whichever way that lands.";

/** Monitor, Evaluate, Assess/Address, Treat — the convention auditors read a note against. */
export type MeatCategory = "monitor" | "evaluate" | "assess" | "treat";

const MEAT_MARKERS: Record<MeatCategory, string[]> = {
  monitor: ["monitoring", "monitor", "stable on", "well controlled", "worsening", "improving", "following", "trend"],
  evaluate: ["reviewed", "labs show", "a1c", "results", "examined", "exam reveals", "imaging", "test showed"],
  assess: ["assessment", "diagnosis of", "impression", "diagnosed with", "consistent with", "secondary to"],
  treat: ["prescribed", "continue", "started on", "increased", "titrated", "referred", "treatment", "medication", "mg daily"],
};

/** Which of the four an excerpt actually supports. */
export function meatEvidence(text: string): MeatCategory[] {
  const lowered = text.toLowerCase();
  return (Object.keys(MEAT_MARKERS) as MeatCategory[]).filter((category) =>
    MEAT_MARKERS[category].some((marker) => lowered.includes(marker)),
  );
}

/**
 * Phrases in a note that suggest a condition, and the code a coder might
 * consider. Supplied as data so the practice can see and edit every rule.
 */
export interface SuspectRule {
  hcc: string;
  phrases: string[];
  suggestedCode: string;
}

export interface DocumentationExcerpt {
  patientRef: string;
  /** YYYYMMDD of the encounter. */
  serviceDate: string;
  text: string;
  source: string;
}

export interface SuspectInput {
  documentation: DocumentationExcerpt[];
  /** HCCs already coded for this patient in the year under review. */
  codedHccs: string[];
  rules: SuspectRule[];
  model: HccModel;
}

export interface AddCandidate {
  patientRef: string;
  hcc: string;
  label: string;
  coefficient: number;
  suggestedCode: string;
  /** The sentence, quoted rather than paraphrased. */
  quote: string;
  source: string;
  serviceDate: string;
  meat: MeatCategory[];
  /** True when the note mentions it but does not support coding it. */
  mentionOnly: boolean;
}

export interface UnsupportedCode {
  patientRef: string;
  hcc: string;
  label: string;
  coefficient: number;
  reason: string;
}

export interface SuspectReview {
  add: AddCandidate[];
  /** Documented so weakly it is a mention rather than a diagnosis. */
  mentions: AddCandidate[];
  unsupported: UnsupportedCode[];
  /** Net RAF movement if every proposal here were accepted. Can be negative. */
  netRaf: number;
  warnings: string[];
}

function excerptFor(text: string, phrase: string): string {
  const lowered = text.toLowerCase();
  const at = lowered.indexOf(phrase.toLowerCase());
  if (at < 0) return text.slice(0, 200);
  const start = Math.max(0, text.lastIndexOf(".", at) + 1);
  const end = text.indexOf(".", at + phrase.length);
  return text.slice(start, end < 0 ? Math.min(text.length, at + 200) : end + 1).trim();
}

/**
 * Review a patient's documentation against what was coded, in both directions.
 *
 * The two lists are produced by the same pass on purpose. Splitting them into
 * separate tools would let a practice run only the profitable one, which is
 * precisely the failure mode the symmetry exists to prevent.
 */
export function reviewConditions(input: SuspectInput): SuspectReview {
  const { documentation, codedHccs, rules, model } = input;
  const coded = new Set(codedHccs);
  const add: AddCandidate[] = [];
  const mentions: AddCandidate[] = [];
  const supported = new Set<string>();
  const warnings: string[] = [];

  for (const rule of rules) {
    const def = model.definitions[rule.hcc];
    if (!def) {
      warnings.push(`Rule for ${rule.hcc} was skipped — the model has no such category.`);
      continue;
    }

    // Every excerpt that mentions the condition, not just the first.
    //
    // Taking the first match made the verdict depend on the order the notes
    // happened to arrive in: an intake form listing "history of COPD" ahead of
    // the progress note that assesses and treats it produced "mentioned, do not
    // code" — telling a coder to drop a condition the record supports. The
    // strongest evidence in the chart is what the chart says.
    const candidates: AddCandidate[] = [];
    for (const excerpt of documentation) {
      const phrase = rule.phrases.find((p) => excerpt.text.toLowerCase().includes(p.toLowerCase()));
      if (!phrase) continue;

      supported.add(rule.hcc);
      if (coded.has(rule.hcc)) continue;

      const quote = excerptFor(excerpt.text, phrase);
      const meat = meatEvidence(quote);
      candidates.push({
        patientRef: excerpt.patientRef,
        hcc: rule.hcc,
        label: def.label,
        coefficient: def.coefficient,
        suggestedCode: rule.suggestedCode,
        quote,
        source: excerpt.source,
        serviceDate: excerpt.serviceDate,
        meat,
        mentionOnly: meat.length === 0,
      });
    }
    if (candidates.length === 0) continue;

    // Most MEAT categories wins; the later encounter breaks a tie, since a
    // condition addressed twice is best evidenced by the more recent note.
    const best = candidates.sort(
      (a, b) => b.meat.length - a.meat.length || b.serviceDate.localeCompare(a.serviceDate),
    )[0];
    (best.mentionOnly ? mentions : add).push(best);
  }

  const unsupported: UnsupportedCode[] = [];
  for (const hcc of coded) {
    if (supported.has(hcc)) continue;
    const def = model.definitions[hcc];
    if (!def) continue;
    unsupported.push({
      patientRef: documentation[0]?.patientRef ?? "",
      hcc,
      label: def.label,
      coefficient: def.coefficient,
      reason:
        "Coded this year, but nothing in the documentation supplied supports it. Either the note is not here, or the code is not supported — and only one of those is fixable by finding more paperwork.",
    });
  }

  const netRaf =
    add.reduce((s, c) => s + c.coefficient, 0) - unsupported.reduce((s, c) => s + c.coefficient, 0);

  if (add.length > 0 && unsupported.length === 0 && documentation.length > 0) {
    warnings.push(
      "Every proposal in this run raises the score. That may simply be true, but it is also what an upcoding tool looks like from the outside — check that the documentation searched actually covers the conditions already coded, or the unsupported side of this review is empty because nothing was looked at rather than because nothing was wrong.",
    );
  }

  return { add, mentions, unsupported, netRaf: Math.round(netRaf * 1000) / 1000, warnings };
}

const MEAT_LABEL: Record<MeatCategory, string> = {
  monitor: "Monitored",
  evaluate: "Evaluated",
  assess: "Assessed",
  treat: "Treated",
};

export function renderSuspects(review: SuspectReview): string {
  const lines: string[] = [];

  lines.push(
    `Documentation review — ${review.add.length} to consider adding, ${review.unsupported.length} coded without support, ${review.mentions.length} mentioned but not codeable.`,
    `Net movement if everything here were accepted: ${review.netRaf >= 0 ? "+" : ""}${review.netRaf.toFixed(3)} RAF.`,
  );

  if (review.add.length > 0) {
    lines.push("", "Documented and not coded — take these to the chart:");
    for (const c of review.add) {
      lines.push(
        "",
        `  ${c.hcc} ${c.label}  (+${c.coefficient.toFixed(3)})  consider ${c.suggestedCode}`,
        `    ${c.serviceDate} · ${c.source} · supports: ${c.meat.map((m) => MEAT_LABEL[m]).join(", ")}`,
        `    "${c.quote}"`,
      );
    }
  }

  if (review.mentions.length > 0) {
    lines.push(
      "",
      "Mentioned but not supported — do NOT code these:",
      "A condition named in a history or a problem list, with nothing in the note monitoring, evaluating, assessing or treating it, is a mention. Coding from it is the specific thing a RADV audit removes.",
    );
    for (const c of review.mentions) {
      lines.push(`  ${c.hcc} ${c.label} — "${c.quote.slice(0, 120)}"`);
    }
  }

  if (review.unsupported.length > 0) {
    lines.push("", "Coded this year with no supporting documentation found:");
    for (const c of review.unsupported) {
      lines.push(`  ${c.hcc} ${c.label}  (−${c.coefficient.toFixed(3)})`, `    ${c.reason}`);
    }
  } else if (review.add.length > 0) {
    lines.push("", "Nothing was found coded-without-support in this run.");
  }

  if (review.warnings.length > 0) lines.push("", ...review.warnings.map((w) => `⚠ ${w}`));

  lines.push(
    "",
    "None of this is a code. Every line above is a proposal for a coder to accept or reject with a reason, through the ordinary review queue — code selection is theirs, and a suspect condition is a question about a chart rather than an answer.",
    RADV_EXTRAPOLATION_STATUS,
  );

  return lines.join("\n");
}
