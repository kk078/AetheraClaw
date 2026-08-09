// ── Research planning ────────────────────────────────────────────────────────
// A single search query is a bad way to answer a billing question. "Does UHC
// cover 99213 via telehealth in 2026?" typed verbatim into a search engine
// returns forum posts, because search engines match documents, not questions.
// The documents that actually answer it are named things — a payer reimbursement
// policy, a CMS transmittal, a fee schedule file — and each is found by a
// different query shape.
//
// So this decomposes the question deterministically, with no model call. That is
// deliberate: a planner that asks a model to invent sub-queries produces a
// different plan every run, which makes a research answer impossible to
// reproduce and impossible to test. Everything here derives from the question's
// own terms, so the same question always yields the same plan.

/** Words that carry no retrieval signal; dropping them is what makes a query specific. */
export const STOPWORDS = new Set([
  "a", "about", "after", "all", "also", "am", "an", "and", "any", "are", "as", "at", "be", "because",
  "been", "before", "being", "between", "both", "but", "by", "can", "cannot", "could", "did", "do",
  "does", "doing", "done", "down", "during", "each", "few", "for", "from", "further", "had", "has",
  "have", "having", "he", "her", "here", "hers", "him", "his", "how", "i", "if", "in", "into", "is",
  "it", "its", "just", "me", "more", "most", "my", "no", "nor", "not", "now", "of", "off", "on",
  "once", "only", "or", "other", "our", "out", "over", "own", "please", "same", "she", "should",
  "so", "some", "still", "such", "than", "that", "the", "their", "them", "then", "there", "these",
  "they", "this", "those", "through", "to", "too", "under", "until", "up", "very", "was", "we",
  "were", "what", "when", "where", "which", "while", "who", "whom", "why", "will", "with", "would",
  "you", "your",
]);

/** Lowercased alphanumeric tokens. Punctuation-insensitive on purpose: it is the basis for dedupe. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Tokens worth searching on: stopwords dropped, one-and-two letter noise dropped, numbers kept. */
export function contentTerms(text: string): string[] {
  return tokenize(text).filter((t) => !STOPWORDS.has(t) && (t.length >= 3 || /^\d+$/.test(t)));
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

// ── Entities that change which document answers the question ─────────────────

const FORM_RE = /\b(?:CMS[-\s]?1500|CMS[-\s]?1450|UB[-\s]?04|837[PID]?|835|834|820|999|275|276|277CA|277|270|271|278)\b/gi;
/** CPT / HCPCS Level I. Five digits, so it cannot collide with a year or a transaction number. */
const CPT_RE = /\b\d{5}\b/g;
/** CPT Category II (F) and III (T), plus the AMA's placeholder U codes. */
const CPT_CAT_RE = /\b\d{4}[FTU]\b/gi;
/** HCPCS Level II: a letter then four digits. */
const HCPCS_RE = /\b[A-V]\d{4}\b/gi;
/**
 * ICD-10-CM. The trailing \b is load-bearing — without it this matches the "J18"
 * inside HCPCS J1885 and reports a diagnosis code the question never contained.
 */
const ICD10_RE = /\b[A-TV-Z]\d[A-Z0-9](?:\.[A-Z0-9]{1,4})?\b/gi;
const YEAR_RE = /\b(?:19|20)\d{2}\b/g;

const PAYERS: Array<{ label: string; pattern: RegExp }> = [
  { label: "UnitedHealthcare", pattern: /\b(?:unitedhealthcare|united\s+healthcare|uhc|optum)\b/gi },
  { label: "Aetna", pattern: /\baetna\b/gi },
  { label: "Cigna", pattern: /\bcigna\b/gi },
  { label: "Anthem", pattern: /\banthem\b/gi },
  { label: "Blue Cross Blue Shield", pattern: /\b(?:blue\s*cross|blue\s*shield|bcbs)\b/gi },
  { label: "Humana", pattern: /\bhumana\b/gi },
  { label: "Centene", pattern: /\bcentene\b/gi },
  { label: "Molina", pattern: /\bmolina\b/gi },
  { label: "TRICARE", pattern: /\btricare\b/gi },
  { label: "Medicare", pattern: /\bmedicare\b/gi },
  { label: "Medicaid", pattern: /\bmedicaid\b/gi },
];

export interface QuestionEntities {
  /** CPT and HCPCS procedure codes. */
  codes: string[];
  /** ICD-10-CM diagnosis codes. */
  diagnoses: string[];
  /** Canonical payer names, in the order they appear. */
  payers: string[];
  years: string[];
  /** X12 transaction sets and paper form numbers, normalized (835, 837P, CMS-1500). */
  forms: string[];
  /** What is left once the entities and stopwords are gone — the topic of the question. */
  keywords: string[];
}

function normalizeForm(raw: string): string {
  const upper = raw.toUpperCase().replace(/\s+/g, "-");
  if (/^CMS-?1500$/.test(upper)) return "CMS-1500";
  if (/^CMS-?1450$/.test(upper)) return "CMS-1450";
  if (/^UB-?04$/.test(upper)) return "UB-04";
  return upper;
}

function matchAll(text: string, re: RegExp): string[] {
  return text.match(re) ?? [];
}

export function extractEntities(question: string): QuestionEntities {
  const text = question ?? "";

  const rawForms = matchAll(text, FORM_RE);
  const forms = uniq(rawForms.map(normalizeForm));
  const years = uniq(matchAll(text, YEAR_RE));
  const codes = uniq([
    ...matchAll(text, CPT_RE),
    ...matchAll(text, CPT_CAT_RE).map((c) => c.toUpperCase()),
    ...matchAll(text, HCPCS_RE).map((c) => c.toUpperCase()),
  ]);
  const diagnoses = uniq(matchAll(text, ICD10_RE).map((c) => c.toUpperCase())).filter(
    (d) => !codes.includes(d),
  );

  const payers: string[] = [];
  const payerTokens: string[] = [];
  for (const { label, pattern } of PAYERS) {
    const hits = matchAll(text, pattern);
    if (hits.length === 0) continue;
    payers.push(label);
    for (const hit of hits) payerTokens.push(...tokenize(hit));
  }

  // The topic is the residue: everything an entity already accounts for is
  // removed so a query built from `keywords` does not repeat the code or the
  // payer that is appended to it separately.
  const consumed = new Set<string>([
    ...payerTokens,
    ...[...rawForms, ...forms, ...years, ...codes, ...diagnoses].flatMap(tokenize),
  ]);
  const keywords = uniq(contentTerms(text).filter((t) => !consumed.has(t)));

  return { codes, diagnoses, payers, years, forms, keywords };
}

// ── Query construction ───────────────────────────────────────────────────────

export interface ResearchPlan {
  subQueries: string[];
  rationale: string;
}

/**
 * Collapse queries that are the same search in a different order.
 *
 * A search engine does not care whether you typed "99213 telehealth coverage" or
 * "coverage telehealth 99213" — it returns the same page and you pay for two
 * fetches. Normalizing to a sorted token set is the cheapest rule that catches
 * it, and it also catches punctuation-only differences.
 */
export function dedupeQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of queries) {
    const query = raw.replace(/\s+/g, " ").trim();
    if (query.length === 0) continue;
    const key = uniq(tokenize(query)).sort().join(" ");
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(query);
  }
  return out;
}

function join(...parts: Array<string | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Query shapes chosen because a search engine actually answers them.
 *
 * Each line names a kind of document rather than restating the question: a code
 * plus a payer plus "coverage policy" finds the payer's policy PDF; a
 * transaction number plus "companion guide" finds the guide; a topic plus a year
 * plus "final rule" finds the Federal Register notice. Ordered most-specific
 * first, because `maxQueries` truncates from the end.
 */
function buildCandidates(e: QuestionEntities, question: string): string[] {
  const topic = e.keywords.slice(0, 6).join(" ");
  const payer = e.payers[0];
  const year = e.years[0];
  const out: string[] = [];

  for (const code of e.codes.slice(0, 3)) {
    out.push(join(code, payer ?? "Medicare", "coverage policy", year));
    out.push(join(code, topic, "billing guidelines"));
  }
  for (const dx of e.diagnoses.slice(0, 2)) {
    out.push(join(dx, "ICD-10", topic, "coverage criteria"));
  }
  for (const form of e.forms.slice(0, 2)) {
    out.push(join(form, topic, "companion guide implementation"));
  }
  if (payer) out.push(join(payer, topic, year, "reimbursement policy update"));
  if (year) out.push(join(topic, year, "final rule change"));
  out.push(join(topic, payer, year));
  out.push(topic);
  // Last resort for a question with no extractable entities at all.
  out.push(question.replace(/[?!.]+\s*$/, "").trim());
  return out;
}

function describePlan(e: QuestionEntities, subQueries: string[], question: string): string {
  const seen: string[] = [];
  if (e.codes.length) seen.push(`procedure code(s) ${e.codes.join(", ")}`);
  if (e.diagnoses.length) seen.push(`diagnosis code(s) ${e.diagnoses.join(", ")}`);
  if (e.payers.length) seen.push(`payer(s) ${e.payers.join(", ")}`);
  if (e.forms.length) seen.push(`transaction/form ${e.forms.join(", ")}`);
  if (e.years.length) seen.push(`year(s) ${e.years.join(", ")}`);

  const lines = [
    seen.length > 0
      ? `Read the question as being about ${seen.join("; ")}.`
      : `No code, payer, form or year was recognizable in "${question.trim()}", so the plan searches the question's own terms.`,
    subQueries.length === 0
      ? "No searchable query could be built from this question."
      : `Searching ${subQueries.length} distinct quer${subQueries.length === 1 ? "y" : "ies"}, each aimed at a different kind of document rather than restating the question:`,
    ...subQueries.map((q, i) => `  ${i + 1}. ${q}`),
  ];
  return lines.join("\n");
}

export function planResearch(question: string, opts: { maxQueries?: number } = {}): ResearchPlan {
  const max = Math.max(1, Math.min(Math.trunc(opts.maxQueries ?? 4), 10));
  const entities = extractEntities(question ?? "");
  const subQueries = dedupeQueries(buildCandidates(entities, question ?? "")).slice(0, max);
  return { subQueries, rationale: describePlan(entities, subQueries, question ?? "") };
}

// ── Policy-watch planning ────────────────────────────────────────────────────

export interface PolicyWatchPlanInput {
  payer?: string;
  codes: string[];
  /** YYYYMMDD; only its year is used to bias the search toward the right bulletin. */
  since?: string;
}

/**
 * The same decomposition aimed at the documents that announce a change, rather
 * than the ones that describe the current state. Bulletins, transmittals and
 * policy-update pages are separately named artifacts; searching for the code
 * alone finds the coding reference instead, which never says what moved.
 */
export function planPolicyWatch(input: PolicyWatchPlanInput, opts: { maxQueries?: number } = {}): ResearchPlan {
  const max = Math.max(1, Math.min(Math.trunc(opts.maxQueries ?? 6), 12));
  const payer = input.payer?.trim() ?? "";
  const codes = uniq(input.codes.map((c) => c.trim().toUpperCase()).filter((c) => c.length > 0));
  const year = input.since && /^\d{4}/.test(input.since) ? input.since.slice(0, 4) : "";

  const out: string[] = [];
  for (const code of codes.slice(0, 4)) {
    out.push(join(payer || "Medicare", code, "reimbursement policy update", year));
    out.push(join(payer || "CMS", code, "policy bulletin effective date"));
  }
  if (!payer) out.push(join("CMS transmittal", codes.slice(0, 3).join(" "), year));
  out.push(join(payer || "Medicare", "provider policy bulletin", year, codes[0]));

  const subQueries = dedupeQueries(out).slice(0, max);
  const rationale = [
    codes.length === 0
      ? "No codes were supplied, so nothing can be matched back to what this practice bills."
      : `Watching ${codes.length} billed code(s): ${codes.join(", ")}.`,
    payer ? `Aimed at ${payer} policy sources.` : "No payer named — aimed at CMS transmittals and bulletins.",
    year ? `Biased toward ${year} and later material.` : "",
    subQueries.length === 0 ? "No searchable query could be built." : `Searching ${subQueries.length} quer${subQueries.length === 1 ? "y" : "ies"}:`,
    ...subQueries.map((q, i) => `  ${i + 1}. ${q}`),
  ].filter((l) => l.length > 0);
  return { subQueries, rationale: rationale.join("\n") };
}
