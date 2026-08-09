import type { PolicyRule, RuleKind, RuleSource } from "./rule-dsl.js";

// ── Policy prose → draft rules ───────────────────────────────────────────────
// This reads a coverage document and drafts scrub rules from the sentences that
// state obligations. It is a drafting aid and nothing more: every rule it
// produces is a DRAFT, reviewed by a person before it can affect a claim.
//
// Two things make that framing more than a disclaimer.
//
// A rule carries the sentence it came from, verbatim. The reviewer is not being
// asked "does this rule look right" — they are being shown the policy text and
// the rule side by side, which is a question a coder can actually answer.
//
// And the compiler reports the obligations it could NOT turn into rules. A
// silent skip is the dangerous failure: the reviewer accepts nine rules and
// believes the document is covered, when the tenth paragraph — the one with the
// frequency limit written in prose the patterns did not match — is now an
// unrecorded exposure. Unparsed obligations are returned alongside the drafts
// and counted in the summary.

export interface DraftRule extends PolicyRule {
  /** Why the compiler thinks this is a rule — shown to the reviewer, not stored as policy. */
  basis: string;
}

export interface UnparsedObligation {
  /** The paragraph that clearly states a requirement the compiler could not encode. */
  text: string;
  /** What tipped it off — the phrase that reads as an obligation. */
  trigger: string;
  /** What is missing before it could become a rule. */
  missing: string;
}

export interface CompileResult {
  drafts: DraftRule[];
  unparsed: UnparsedObligation[];
  /** Paragraphs examined. */
  paragraphs: number;
}

export interface CompileOptions {
  source: Omit<RuleSource, "quote" | "citation"> & { citation?: string };
  /** Restrict every drafted rule to one payer. "" drafts them for all payers. */
  payer?: string;
  /** Deterministic id prefix so the same document compiles to the same ids. */
  idPrefix?: string;
}

const CPT_HCPCS = /\b(?:\d{5}|[A-VX]\d{4})\b/g;
const ICD10 = /\b[A-TV-Z]\d[0-9A-Z](?:\.[0-9A-Z]{1,4})?\b/g;

/** Words that turn a sentence from description into requirement. */
const OBLIGATION = /\b(must|shall|require[sd]?|only|not covered|non-?covered|limited to|no more than|may not|will be denied|is denied|considered not medically necessary|does not cover)\b/i;

/**
 * Codes that look like codes but are almost always something else in policy
 * prose: years, dollar amounts already stripped, and the LCD/NCD numbers
 * themselves. Left in, they produce rules about codes that do not exist.
 */
function plausibleProcedureCodes(text: string): string[] {
  const found = new Set<string>();
  for (const raw of text.match(CPT_HCPCS) ?? []) {
    // A bare five-digit number in the 19xx/20xx range inside a date context is a year.
    if (/^(19|20)\d{3}$/.test(raw) && /\b(19|20)\d{2}\b/.test(text)) continue;
    found.add(raw.toUpperCase());
  }
  return [...found];
}

function plausibleDiagnoses(text: string): string[] {
  return [...new Set((text.match(ICD10) ?? []).map((d) => d.toUpperCase()))];
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n|\r\n\s*\r\n/)
    .flatMap((block) => (block.length > 600 ? block.split(/(?<=[.:])\s+(?=[A-Z])/) : [block]))
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
}

interface Matcher {
  kind: RuleKind;
  test: RegExp;
  severity: PolicyRule["severity"];
  /** Extra fields, or null when the paragraph names an obligation it cannot fill. */
  build: (p: string, codes: string[], dx: string[]) => Partial<PolicyRule> | null;
  needs: string;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
};

function readCount(word: string): number {
  const lowered = word.toLowerCase();
  return NUMBER_WORDS[lowered] ?? Number(word);
}

const MATCHERS: Matcher[] = [
  {
    kind: "not_covered",
    test: /\b(is|are) (?:not covered|non-?covered|considered not medically necessary)|does not cover|will be denied\b/i,
    severity: "error",
    needs: "a procedure code the exclusion applies to",
    build: (_p, codes) => (codes.length === 0 ? null : { codes, message: "The policy states this service is not covered." }),
  },
  {
    kind: "frequency_limit",
    test: /\b(?:limited to|no more than|maximum of|not exceed|once)\s+(\w+)\s*(?:times?\s*)?(?:per|every|in a|in any)?\s*(\d*)\s*(day|days|month|months|year|years|lifetime|calendar year|12 months|beneficiary lifetime)?\b/i,
    severity: "warning",
    needs: "both a numeric limit and the period it applies to",
    build: (p, codes) => {
      if (codes.length === 0) return null;
      const m = p.match(
        /\b(?:limited to|no more than|maximum of|not exceed|once)\s+(\w+)?\s*(?:times?\s*)?(?:per|every|in a|in any|within)?\s*(\d*)\s*(day|days|month|months|year|years|lifetime|calendar year)?/i,
      );
      if (!m) return null;
      const count = m[1] ? readCount(m[1]) : 1;
      const unitWord = (m[3] ?? "").toLowerCase();
      if (!Number.isFinite(count) || count <= 0) return null;
      // The interval multiplier ("per 10 years") was captured but never read, so
      // "one per 10 years" drafted as 1-per-year — a rule 10× more permissive than
      // the policy. The DSL period is a single day/month/year/lifetime, so a
      // multi-period limit is genuinely unencodable: return null and let it be
      // surfaced as an UnparsedObligation rather than silently drafted wrong.
      const interval = m[2] ? Number(m[2]) : 1;
      if (Number.isFinite(interval) && interval > 1) return null;
      const period: PolicyRule["period"] | null = /lifetime/.test(unitWord)
        ? "lifetime"
        : /year/.test(unitWord)
          ? "year"
          : /month/.test(unitWord)
            ? "month"
            : /day/.test(unitWord)
              ? "day"
              : null;
      if (!period) return null;
      return {
        codes,
        maxUnits: count,
        period,
        message: `The policy limits this to ${count} per ${unitWord || period}.`,
      };
    },
  },
  {
    kind: "requires_modifier",
    test: /\b(?:must|should) be (?:billed|reported|submitted) with modifier|append(?:ed)? modifier|require[sd]? modifier\b/i,
    severity: "error",
    needs: "the modifier itself, spelled out",
    build: (p, codes) => {
      const mods = [...new Set((p.match(/\bmodifier\s+([A-Z0-9]{2})\b/gi) ?? []).map((m) => m.split(/\s+/)[1].toUpperCase()))];
      if (codes.length === 0 || mods.length === 0) return null;
      return { codes, modifiers: mods, message: `The policy requires modifier ${mods.join(" or ")} on this code.` };
    },
  },
  {
    kind: "place_of_service",
    test: /\bplace of service\b/i,
    severity: "warning",
    needs: "the allowed place-of-service code(s)",
    build: (p, codes) => {
      const pos = [...new Set((p.match(/\bplace of service (?:code )?(\d{2})\b/gi) ?? []).map((m) => m.slice(-2)))];
      if (codes.length === 0 || pos.length === 0) return null;
      if (!/\bonly|must|shall\b/i.test(p)) return null;
      return { codes, placesOfService: pos, message: `The policy allows this only at place of service ${pos.join(", ")}.` };
    },
  },
  {
    kind: "requires_diagnosis",
    test: /\b(?:support medical necessity|covered (?:only )?(?:for|when)|indications?(?: and limitations)?|diagnos[ei]s codes? that support)\b/i,
    severity: "error",
    needs: "both a procedure code and the diagnosis codes that support it",
    build: (_p, codes, dx) =>
      codes.length === 0 || dx.length === 0
        ? null
        : { codes, diagnoses: dx, message: "The policy covers this only for the diagnoses it lists." },
  },
  {
    kind: "requires_documentation",
    test: /\b(?:medical record|documentation|chart) (?:must|shall|should) (?:contain|include|support|document)\b/i,
    severity: "info",
    needs: "a procedure code the requirement attaches to",
    build: (p, codes) =>
      codes.length === 0 ? null : { codes, message: `The record has to support this: ${p.slice(0, 240)}` },
  },
];

const EMPTY_RULE: Omit<PolicyRule, "id" | "kind" | "severity" | "message" | "source"> = {
  codes: [],
  diagnoses: [],
  modifiers: [],
  placesOfService: [],
  maxUnits: 0,
  period: "claim",
  payer: "",
  status: "draft",
};

/**
 * Compile policy text into draft rules.
 *
 * Deterministic: the same document produces the same rules with the same ids,
 * so re-importing a revised policy diffs cleanly against what was accepted last
 * time instead of duplicating it.
 */
export function compilePolicy(text: string, options: CompileOptions): CompileResult {
  const paragraphs = splitParagraphs(text);
  const drafts: DraftRule[] = [];
  const unparsed: UnparsedObligation[] = [];
  let seq = 0;

  for (const paragraph of paragraphs) {
    const codes = plausibleProcedureCodes(paragraph);
    const dx = plausibleDiagnoses(paragraph);
    let matchedHere = false;
    const shortfalls: Array<{ trigger: string; missing: string }> = [];

    for (const matcher of MATCHERS) {
      if (!matcher.test.test(paragraph)) continue;
      const built = matcher.build(paragraph, codes, dx);
      if (!built) {
        shortfalls.push({ trigger: matcher.kind, missing: matcher.needs });
        continue;
      }
      matchedHere = true;
      seq++;
      drafts.push({
        ...EMPTY_RULE,
        ...built,
        id: `${options.idPrefix ?? "rule"}-${String(seq).padStart(3, "0")}`,
        kind: matcher.kind,
        severity: matcher.severity,
        message: built.message ?? "",
        payer: options.payer ?? "",
        status: "draft",
        source: {
          document: options.source.document,
          citation: options.source.citation ?? "",
          quote: paragraph.slice(0, 600),
          effective: options.source.effective,
          url: options.source.url,
        },
        basis: `Matched on "${matcher.kind}" language${codes.length ? ` with code(s) ${codes.join(", ")}` : ""}.`,
      });
    }

    // A paragraph that plainly states an obligation but produced no rule is the
    // case worth surfacing. Reporting only the successes would let a reviewer
    // believe the document was fully translated.
    if (!matchedHere && OBLIGATION.test(paragraph)) {
      const trigger = paragraph.match(OBLIGATION)?.[0] ?? "obligation";
      unparsed.push({
        text: paragraph.slice(0, 400),
        trigger,
        missing:
          shortfalls.length > 0
            ? shortfalls.map((s) => `${s.trigger} needs ${s.missing}`).join("; ")
            : "no rule shape in the DSL matches this requirement",
      });
    }
  }

  return { drafts, unparsed, paragraphs: paragraphs.length };
}

export function renderCompileResult(result: CompileResult, documentName: string): string {
  const lines = [
    `Compiled ${documentName}: ${result.paragraphs} paragraph(s) read, ${result.drafts.length} draft rule(s), ${result.unparsed.length} obligation(s) not encoded.`,
    "",
    "Every rule below is a DRAFT. None of them affects a claim until a person accepts it.",
  ];

  if (result.drafts.length > 0) {
    lines.push("", "Drafted:");
    for (const d of result.drafts) {
      lines.push(
        "",
        `  ${d.id}  ${d.kind}  [${d.severity}]`,
        `    codes: ${d.codes.join(", ")}`,
        d.diagnoses.length ? `    diagnoses: ${d.diagnoses.slice(0, 20).join(", ")}${d.diagnoses.length > 20 ? ` … (${d.diagnoses.length} total)` : ""}` : "",
        d.modifiers.length ? `    modifiers: ${d.modifiers.join(", ")}` : "",
        d.placesOfService.length ? `    place of service: ${d.placesOfService.join(", ")}` : "",
        d.kind === "frequency_limit" ? `    limit: ${d.maxUnits} per ${d.period}` : "",
        `    ${d.basis}`,
        `    from: "${d.source.quote.slice(0, 200)}${d.source.quote.length > 200 ? "…" : ""}"`,
      );
    }
  }

  if (result.unparsed.length > 0) {
    lines.push(
      "",
      `Stated as a requirement but NOT turned into a rule — ${result.unparsed.length}:`,
      "These are the parts of the policy this practice is not checking. Read them.",
    );
    for (const u of result.unparsed.slice(0, 25)) {
      lines.push("", `  (${u.trigger}) ${u.text}`, `    why: ${u.missing}`);
    }
    if (result.unparsed.length > 25) lines.push("", `  … and ${result.unparsed.length - 25} more.`);
  }

  return lines.filter((l) => l !== "").join("\n");
}
