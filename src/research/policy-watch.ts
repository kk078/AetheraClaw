// ── Policy → billed codes ────────────────────────────────────────────────────
// A policy feed tells a practice that something changed. It does not tell them
// whether it changed anything they do, and that gap is where the work is: a MAC
// publishes forty revisions a quarter, a practice bills twenty codes, and the
// intersection is usually zero and occasionally the thing that stops payment
// next month.
//
// So this module only ever reports codes it was handed. It never enumerates
// codes it found in the policy text and never suggests a code the practice
// "might" bill — a code that appears in a report gets checked by a human, and a
// code that was invented wastes that check and teaches them to skim the next one.

export type ChangeKind = "coverage" | "pricing" | "edit" | "documentation" | "unclear";

export interface PolicyFinding {
  title: string;
  url: string;
  text: string;
  /** Source tier from credibility.sourceTier; carried through so a match can be weighted. */
  tier: string;
}

export interface CodePolicyMatch {
  code: string;
  url: string;
  title: string;
  /** The sentence-ish window the code was found in, so a reader can judge it without refetching. */
  excerpt: string;
  kind: ChangeKind;
  /** YYYYMMDD, only when the document actually states one. */
  effectiveDate?: string;
}

const EXCERPT_BEFORE = 140;
const EXCERPT_AFTER = 220;
/** How far around a mention to read when deciding what kind of change it is. */
const CLASSIFY_WINDOW = 400;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary matcher for a billed code.
 *
 * The boundary is the whole point. A substring search for "99213" hits inside
 * "992130" and inside "1992135", and a report that says a policy touches 99213
 * because a document happened to contain a longer number is worse than no report
 * — it is a false positive that costs a human ten minutes and their trust.
 * `\b` gets this right for both ends: in "992130" there is no boundary between
 * "3" and "0", and in "A99213" none between "A" and "9".
 */
export function codeMentionRegex(code: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(code)}\\b`, "gi");
}

const KIND_PATTERNS: Array<{ kind: ChangeKind; pattern: RegExp }> = [
  {
    kind: "edit",
    pattern:
      /\b(?:NCCI|correct coding initiative|edit pair|procedure-to-procedure|PTP|MUE|medically unlikely|units of service|bundl\w*|unbundl\w*|mutually exclusive|column (?:one|two|1|2)|modifier (?:indicator|59|XS|XE|XP|XU))\b/gi,
  },
  {
    kind: "pricing",
    pattern:
      /\b(?:fee schedule|reimburse\w*|payment rate|payment amount|allowed amount|conversion factor|RVU|relative value|rate (?:increase|decrease|change|reduction)|pricing|price|paid at|percent of (?:the )?medicare)\b/gi,
  },
  {
    kind: "coverage",
    pattern:
      /\b(?:coverage|covered|non-?covered|not covered|medical necessity|medically necessary|LCD|NCD|local coverage|national coverage|coverage criteria|indications and limitations|prior authorization|precertification|benefit)\b/gi,
  },
  {
    kind: "documentation",
    pattern:
      /\b(?:documentation|document\w* requirement|medical record|chart note|progress note|attestation|signature requirement|supporting document\w*|records must)\b/gi,
  },
];

/** Ties go to the more concrete change: an edit is checkable today, "coverage" is a reading task. */
const KIND_PRIORITY: ChangeKind[] = ["edit", "pricing", "coverage", "documentation"];

export function classifyChange(context: string): ChangeKind {
  const scores = new Map<ChangeKind, number>();
  for (const { kind, pattern } of KIND_PATTERNS) {
    pattern.lastIndex = 0;
    const hits = context.match(pattern)?.length ?? 0;
    if (hits > 0) scores.set(kind, hits);
  }
  if (scores.size === 0) return "unclear";
  let best: ChangeKind = "unclear";
  let bestScore = -1;
  for (const kind of KIND_PRIORITY) {
    const score = scores.get(kind) ?? 0;
    if (score > bestScore) {
      bestScore = score;
      best = kind;
    }
  }
  return bestScore > 0 ? best : "unclear";
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
  jan: "01", feb: "02", mar: "03", apr: "04", jun: "06", jul: "07", aug: "08",
  sep: "09", sept: "09", oct: "10", nov: "11", dec: "12",
};

// Alternation built from the month table, longest first, so "sept" is preferred
// over "sep" and a non-month word can never be taken for a month.
const MONTH_ALT = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

const DATE_FORMS: Array<{ pattern: RegExp; toYmd(m: RegExpExecArray): string }> = [
  {
    pattern: new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+((?:19|20)\\d{2})\\b`, "i"),
    toYmd: (m) => {
      const month = MONTHS[m[1].toLowerCase()];
      return month ? `${m[3]}${month}${m[2].padStart(2, "0")}` : "";
    },
  },
  {
    pattern: new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_ALT})\\.?,?\\s+((?:19|20)\\d{2})\\b`, "i"),
    toYmd: (m) => {
      const month = MONTHS[m[2].toLowerCase()];
      return month ? `${m[3]}${month}${m[1].padStart(2, "0")}` : "";
    },
  },
  {
    pattern: /\b(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})\b/,
    toYmd: (m) => `${m[3]}${m[1].padStart(2, "0")}${m[2].padStart(2, "0")}`,
  },
  {
    pattern: /\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/,
    toYmd: (m) => `${m[1]}${m[2]}${m[3]}`,
  },
];

/**
 * Cue words that make a nearby date an EFFECTIVE date rather than just a date.
 *
 * Policy documents are full of dates — publication, revision, comment deadlines,
 * the date a study was run. Reporting any of them as the effective date tells a
 * practice to change how it bills on the wrong day, so a date is only taken when
 * the document says what it is.
 */
const EFFECTIVE_CUE = /\b(?:effective(?:\s+date)?(?:\s*[:\-])?|takes?\s+effect(?:\s+on)?|will\s+take\s+effect|becomes?\s+effective|in\s+effect(?:\s+as\s+of)?|beginning(?:\s+on)?|starting(?:\s+on)?|as\s+of|implemented\s+on|applies\s+to\s+(?:dates\s+of\s+service\s+on\s+or\s+after|claims\s+with\s+dates\s+of\s+service\s+on\s+or\s+after)|dates?\s+of\s+service\s+on\s+or\s+after)\b/gi;

const CUE_LOOKAHEAD = 80;

export function extractEffectiveDate(text: string): string | undefined {
  const flat = (text ?? "").replace(/\s+/g, " ");
  EFFECTIVE_CUE.lastIndex = 0;
  for (let cue = EFFECTIVE_CUE.exec(flat); cue !== null; cue = EFFECTIVE_CUE.exec(flat)) {
    const tail = flat.slice(cue.index + cue[0].length, cue.index + cue[0].length + CUE_LOOKAHEAD);
    let best = "";
    let bestAt = Number.MAX_SAFE_INTEGER;
    for (const form of DATE_FORMS) {
      const m = form.pattern.exec(tail);
      if (!m || m.index >= bestAt) continue;
      const ymd = form.toYmd(m);
      if (ymd.length === 8) {
        best = ymd;
        bestAt = m.index;
      }
    }
    if (best.length === 8) {
      EFFECTIVE_CUE.lastIndex = 0;
      return best;
    }
  }
  return undefined;
}

function excerptAround(flat: string, at: number, length: number): string {
  const start = Math.max(0, at - EXCERPT_BEFORE);
  const end = Math.min(flat.length, at + length + EXCERPT_AFTER);
  const body = flat.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${body}${end < flat.length ? "…" : ""}`;
}

/** Codes as they are compared: trimmed, uppercased, blanks and duplicates dropped. */
export function normalizeBilledCodes(codes: string[]): string[] {
  return [...new Set((codes ?? []).map((c) => (c ?? "").trim().toUpperCase()).filter((c) => c.length > 0))];
}

/**
 * Every explicit mention of a billed code across the supplied policy text.
 *
 * One entry per code per document — a code mentioned nine times in one policy is
 * one thing to read, not nine — and the first mention wins because policy
 * documents state the change before they restate it in a table.
 */
export function matchPolicyToBilledCodes(findings: PolicyFinding[], billedCodes: string[]): CodePolicyMatch[] {
  const codes = normalizeBilledCodes(billedCodes);
  if (codes.length === 0) return [];

  const out: CodePolicyMatch[] = [];
  for (const finding of findings ?? []) {
    const flat = (finding.text ?? "").replace(/\s+/g, " ");
    const haystack = `${finding.title ?? ""} ${flat}`;
    if (haystack.trim().length === 0) continue;

    for (const code of codes) {
      const re = codeMentionRegex(code);
      const hit = re.exec(flat);
      const inTitle = codeMentionRegex(code).test(finding.title ?? "");
      if (!hit && !inTitle) continue;

      const at = hit ? hit.index : 0;
      const window = flat.slice(
        Math.max(0, at - CLASSIFY_WINDOW),
        Math.min(flat.length, at + code.length + CLASSIFY_WINDOW),
      );
      const context = `${finding.title ?? ""} ${window}`;
      out.push({
        code,
        url: finding.url ?? "",
        title: finding.title ?? "",
        excerpt: hit ? excerptAround(flat, at, code.length) : (finding.title ?? "").trim(),
        kind: classifyChange(context),
        // Look in the mention's own neighbourhood first; a long policy states its
        // effective date once at the top, so fall back to the whole document
        // rather than reporting no date for a document that plainly has one.
        effectiveDate: extractEffectiveDate(context) ?? extractEffectiveDate(`${finding.title ?? ""} ${flat}`),
      });
    }
  }
  return out;
}

/** Matches whose stated effective date is on or after `since` (YYYYMMDD), plus any with no stated date. */
export function filterMatchesSince(matches: CodePolicyMatch[], since?: string): CodePolicyMatch[] {
  if (!since || !/^\d{8}$/.test(since)) return matches;
  return matches.filter((m) => !m.effectiveDate || m.effectiveDate >= since);
}

const KIND_MEANING: Record<ChangeKind, string> = {
  coverage: "whether the service is payable at all — the denial arrives as medical necessity or non-covered",
  pricing: "what it pays — the claim is accepted and the money is different",
  edit: "how it may be combined — the denial arrives as a bundling or units edit",
  documentation: "what must be in the record — survives adjudication and fails on audit",
  unclear: "the document mentions the code but the surrounding language does not say what changed",
};

export function summarizeImpact(matches: CodePolicyMatch[]): string {
  if (matches.length === 0) {
    return "No policy document mentioned any of the codes this practice bills. That is a real answer, not an empty one: nothing found means nothing to act on.";
  }

  const byCode = new Map<string, CodePolicyMatch[]>();
  for (const m of matches) {
    const list = byCode.get(m.code) ?? [];
    list.push(m);
    byCode.set(m.code, list);
  }

  const codes = [...byCode.keys()].sort();
  const lines: string[] = [
    `${matches.length} policy mention(s) of ${codes.length} billed code(s): ${codes.join(", ")}.`,
  ];

  for (const code of codes) {
    const list = byCode.get(code) ?? [];
    const kinds = [...new Set(list.map((m) => m.kind))];
    const dated = list.filter((m) => m.effectiveDate).sort((a, b) => (a.effectiveDate ?? "").localeCompare(b.effectiveDate ?? ""));
    lines.push("");
    lines.push(
      `${code} — ${list.length} document(s); ${kinds.map((k) => `${k} (${KIND_MEANING[k]})`).join("; ")}${
        dated.length > 0 ? `; earliest stated effective date ${dated[0].effectiveDate}` : "; no effective date stated"
      }`,
    );
    for (const m of list) {
      lines.push(`  [${m.kind}]${m.effectiveDate ? ` effective ${m.effectiveDate}` : ""} ${m.title || m.url}`);
      if (m.excerpt.length > 0) lines.push(`      "${m.excerpt}"`);
      if (m.url.length > 0) lines.push(`      ${m.url}`);
    }
  }

  lines.push(
    "",
    "Only codes supplied as billed were searched, so this says nothing about codes the practice does not bill — and a mention is not a ruling. Open the document before changing how anything is coded.",
  );
  return lines.join("\n");
}
