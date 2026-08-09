// ── Policy citation guard ────────────────────────────────────────────────────
// An appeal letter is a formal submission to a payer, and for Medicare it is a
// submission to the federal government. A fabricated policy citation inside one
// is not an embarrassment — it is a false statement made to obtain payment.
//
// This exists because it happened. Asked to appeal a CARC 96 denial for CPT
// 99215, a model produced a letter citing "CMS NCD 310.2 — Evaluation and
// Management Services". There is no NCD for E/M services; the CMS Coverage API
// returns nothing for that search. The citation was invented, formatted
// convincingly, and written into a letter addressed to Medicare Appeals.
//
// So identifier-shaped citations are detected and the letter is refused unless
// the caller states they were verified. A model that has actually run
// coverage_search_national or coverage_search_local can say so; one that is
// recalling a plausible number cannot do so honestly.

/** Anything shaped like a policy identifier a reader would take as authoritative. */
const IDENTIFIER_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "NCD", pattern: /\bNCD\s*#?\s*\d{2,3}(\.\d+)?\b/i },
  { label: "LCD", pattern: /\bL\d{5,6}\b/ },
  { label: "Article", pattern: /\bA\d{5,6}\b/ },
  { label: "CMS manual/transmittal", pattern: /\bCMS[-\s]?\d{3,4}[-\s]?[A-Z]?\b/i },
  { label: "CFR", pattern: /\b\d{2}\s*CFR\s*§?\s*\d+/i },
];

export interface CitationCheck {
  /** Citations carrying an identifier a reader would rely on. */
  identifierCitations: Array<{ citation: string; kinds: string[] }>;
  ok: boolean;
  refusal: string;
}

/**
 * Decide whether these citations may go into an outbound letter.
 *
 * Free-text clinical reasoning is fine unverified — it is the practice's own
 * assertion about its own patient. A policy identifier is different: it points
 * at a document the reader will look up, and being wrong about it is worse than
 * citing nothing at all, because it invites the reviewer to conclude the whole
 * letter was written by someone who does not know the policy.
 */
export function checkCitations(citations: string[], verified: boolean): CitationCheck {
  const identifierCitations = citations
    .map((citation) => ({
      citation,
      kinds: IDENTIFIER_PATTERNS.filter((p) => p.pattern.test(citation)).map((p) => p.label),
    }))
    .filter((c) => c.kinds.length > 0);

  if (identifierCitations.length === 0 || verified) {
    return { identifierCitations, ok: true, refusal: "" };
  }

  return {
    identifierCitations,
    ok: false,
    refusal: [
      `Not written. ${identifierCitations.length} citation(s) name a policy identifier and citations_verified is false:`,
      ...identifierCitations.map((c) => `  - ${c.citation}  [${c.kinds.join(", ")}]`),
      "",
      "Look each one up with coverage_search_national or coverage_search_local, confirm it exists and says what the letter claims, then set citations_verified: true. If a lookup finds nothing, remove the citation — an appeal citing a policy that does not exist is worse than one citing none, and a Medicare appeal is a statement to the federal government.",
      "",
      "This guard exists because a model once cited \"CMS NCD 310.2 — Evaluation and Management Services\" in an appeal letter. There is no NCD for E/M services.",
    ].join("\n"),
  };
}
