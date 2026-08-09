import { contentTerms } from "./plan.js";
import { DEFAULT_TIER_ORDER, sourceTier, tierRank, type Tier } from "./credibility.js";

// ── Cited synthesis ──────────────────────────────────────────────────────────
// The failure this exists to prevent is specific and it has already happened in
// this project (see healthcare/citations.ts): a model given several fetched
// pages writes a fluent answer in which most sentences come from the pages and
// one comes from its own training, and the reader cannot tell which is which.
// In an appeal letter that sentence is a false statement made to obtain payment.
//
// So the rule here is absolute and it is the reason this module is pure: a claim
// that no supplied source supports is NOT emitted as a claim. It is moved to
// `unsupported`, where it is labelled as something no fetched source says. There
// is no confidence score, no "likely", no partial credit — a citation either
// exists or the sentence does not get to be an answer.

export interface SourceDoc {
  url: string;
  title: string;
  text: string;
}

export interface Claim {
  text: string;
  /** Every source whose text supports this claim, best provenance first. Never empty. */
  sourceUrls: string[];
  /** Best tier among the supporting sources. */
  tier: string;
}

export interface RankedSource {
  url: string;
  title: string;
  tier: Tier;
  score: number;
  why: string;
  /** Characters of readable text actually retrieved. Zero means the fetch degraded. */
  length: number;
}

export interface SynthesisResult {
  claims: Claim[];
  /** Assertions no supplied source supports. Present so they can be shown as NOT answers. */
  unsupported: string[];
  /** Share (0–1) of sub-questions answered by at least one primary- or payer-tier source. */
  coverage: number;
  sources: RankedSource[];
  /** Claims beyond `maxClaims` that were dropped, so the render can say so. */
  truncatedClaims: number;
}

export interface SynthesizeOptions {
  /** Usually `planResearch(...).subQueries`. Defaults to the question itself as one sub-question. */
  subQuestions?: string[];
  maxClaims?: number;
  /** Share of a claim's content terms a source must contain before it counts as support. */
  minSupportRatio?: number;
  /**
   * Assertions the caller wants verified rather than extracted — a model's draft
   * answer, for instance. Each is checked against the sources like any other
   * candidate, and lands in `unsupported` when nothing backs it.
   */
  candidateClaims?: string[];
}

const MIN_CLAIM_CHARS = 40;
const MAX_CLAIM_CHARS = 400;

/** Sentence split that keeps abbreviations and decimals intact enough for billing prose. */
export function splitSentences(text: string): string[] {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=["'(]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Numbers as a reader would check them: codes, dollar amounts, percentages, years.
 *
 * These are extracted separately from words because they are the part of a claim
 * that is falsifiable. "Medicare allows $92.05 for 99213" must not count as
 * supported by a page that discusses 99213 and never states the amount — and on
 * word overlap alone it would.
 */
export function numericTokens(text: string): string[] {
  const found = (text ?? "").match(/\d+(?:[.,]\d+)*/g) ?? [];
  return [...new Set(found.map((n) => n.replace(/,/g, "").replace(/\.0+$/, "")))];
}

function key(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

interface PreparedSource extends RankedSource {
  text: string;
  lower: string;
  terms: Set<string>;
  numbers: Set<string>;
  citable: boolean;
  order: number;
}

function prepare(sources: SourceDoc[]): PreparedSource[] {
  return sources.map((s, order) => {
    const text = s.text ?? "";
    const assessment = sourceTier(s.url);
    return {
      url: (s.url ?? "").trim(),
      title: (s.title ?? "").trim(),
      tier: assessment.tier,
      score: assessment.score,
      why: assessment.why,
      length: text.length,
      text,
      lower: text.toLowerCase().replace(/\s+/g, " "),
      terms: new Set(contentTerms(text)),
      numbers: new Set(numericTokens(text)),
      // A page with no URL cannot be cited, so nothing it says may become a
      // claim — it would be an assertion with a footnote pointing nowhere.
      citable: (s.url ?? "").trim().length > 0,
      order,
    };
  });
}

function supports(source: PreparedSource, claim: string, minRatio: number): boolean {
  if (source.lower.length === 0) return false;
  const flat = key(claim);
  if (flat.length > 0 && key(source.lower).includes(flat)) return true;

  const terms = [...new Set(contentTerms(claim))];
  if (terms.length === 0) return false;
  const hits = terms.filter((t) => source.terms.has(t)).length;
  if (hits < Math.max(1, Math.ceil(terms.length * minRatio))) return false;

  // Every number in the claim must appear. Requiring all of them rather than any
  // is the strict direction on purpose: a wrong dollar figure attached to a real
  // citation is more dangerous than no answer at all.
  const numbers = numericTokens(claim);
  return numbers.every((n) => source.numbers.has(n));
}

function isResponsive(sentence: string, questionTerms: Set<string>): boolean {
  if (sentence.length < MIN_CLAIM_CHARS || sentence.length > MAX_CLAIM_CHARS) return false;
  if (questionTerms.size === 0) return false;
  const terms = new Set(contentTerms(sentence));
  let hits = 0;
  for (const t of questionTerms) if (terms.has(t)) hits++;
  return hits >= Math.min(2, questionTerms.size);
}

export function synthesizeFindings(
  sources: SourceDoc[],
  question: string,
  opts: SynthesizeOptions = {},
): SynthesisResult {
  const maxClaims = Math.max(1, Math.trunc(opts.maxClaims ?? 12));
  const minRatio = Math.min(1, Math.max(0.1, opts.minSupportRatio ?? 0.6));
  const subQuestions = (opts.subQuestions ?? []).filter((q) => q.trim().length > 0);
  const effectiveSubQuestions = subQuestions.length > 0 ? subQuestions : [question];

  const prepared = prepare(sources ?? []);
  const questionTerms = new Set([
    ...contentTerms(question ?? ""),
    ...effectiveSubQuestions.flatMap((q) => contentTerms(q)),
  ]);

  // Candidates in a stable order: sentences in source order, then whatever the
  // caller asked to have verified.
  const candidates: string[] = [];
  const seenCandidate = new Set<string>();
  const addCandidate = (text: string) => {
    const trimmed = text.replace(/\s+/g, " ").trim();
    const k = key(trimmed);
    if (k.length === 0 || seenCandidate.has(k)) return;
    seenCandidate.add(k);
    candidates.push(trimmed);
  };
  for (const source of prepared) {
    for (const sentence of splitSentences(source.text)) {
      if (isResponsive(sentence, questionTerms)) addCandidate(sentence);
    }
  }
  for (const drafted of opts.candidateClaims ?? []) addCandidate(drafted);

  const claims: Claim[] = [];
  const unsupported: string[] = [];
  for (const candidate of candidates) {
    const backing = prepared
      .filter((s) => s.citable && supports(s, candidate, minRatio))
      .sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || b.score - a.score || a.order - b.order);
    if (backing.length === 0) {
      unsupported.push(candidate);
      continue;
    }
    claims.push({ text: candidate, sourceUrls: backing.map((s) => s.url), tier: backing[0].tier });
  }

  claims.sort(
    (a, b) => tierRank(a.tier as Tier) - tierRank(b.tier as Tier) || b.sourceUrls.length - a.sourceUrls.length,
  );
  const kept = claims.slice(0, maxClaims);

  return {
    claims: kept,
    unsupported,
    coverage: computeCoverage(effectiveSubQuestions, prepared),
    sources: prepared
      .map(({ url, title, tier, score, why, length }) => ({ url, title, tier, score, why, length }))
      .sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || b.score - a.score),
    truncatedClaims: claims.length - kept.length,
  };
}

/**
 * Coverage answers "how much of what I set out to find did I actually find in a
 * source that counts". Trade and vendor pages are excluded from the numerator
 * deliberately: a sub-question answered only by a billing blog is a sub-question
 * still open.
 */
function computeCoverage(subQuestions: string[], sources: PreparedSource[]): number {
  if (subQuestions.length === 0) return 0;
  let covered = 0;
  for (const sub of subQuestions) {
    const terms = [...new Set(contentTerms(sub))];
    if (terms.length === 0) continue;
    const need = Math.max(1, Math.ceil(terms.length * 0.5));
    const hit = sources.some((s) => {
      if (!s.citable || (s.tier !== "primary" && s.tier !== "payer")) return false;
      return terms.filter((t) => s.terms.has(t)).length >= need;
    });
    if (hit) covered++;
  }
  return Math.round((covered / subQuestions.length) * 100) / 100;
}

// ── Rendering ────────────────────────────────────────────────────────────────

export function renderCited(result: SynthesisResult): string {
  const lines: string[] = [];

  if (result.claims.length === 0) {
    lines.push("No claim in the retrieved sources could be tied to a source that states it. Nothing below is an answer.");
  } else {
    lines.push(`${result.claims.length} cited finding(s):`, "");
    result.claims.forEach((claim, i) => {
      lines.push(`${i + 1}. ${claim.text}`);
      lines.push(`   [${claim.tier}] ${claim.sourceUrls.join("  ·  ")}`);
    });
    if (result.truncatedClaims > 0) {
      lines.push("", `${result.truncatedClaims} further cited finding(s) were not listed.`);
    }
  }

  if (result.unsupported.length > 0) {
    lines.push(
      "",
      `NOT SUPPORTED — ${result.unsupported.length} statement(s) that no retrieved source backs. Do not repeat these as fact or cite them in a letter:`,
    );
    for (const u of result.unsupported) lines.push(`  - ${u}`);
  }

  lines.push(
    "",
    `Coverage: ${Math.round(result.coverage * 100)}% of sub-questions were answered by a primary- or payer-tier source.`,
  );

  lines.push("", "Sources (best provenance first):");
  if (result.sources.length === 0) {
    lines.push("  (none reached)");
  } else {
    for (const s of result.sources) {
      const label = s.title.length > 0 ? s.title : s.url;
      lines.push(`  [${s.tier}] ${label}`);
      lines.push(`      ${s.url}${s.length === 0 ? "  (no text retrieved)" : ""}`);
    }
  }

  const tiersPresent = new Set(result.sources.map((s) => s.tier));
  if (!tiersPresent.has("primary") && !tiersPresent.has("payer")) {
    lines.push(
      "",
      "No primary or payer source was read, so every finding above is a secondary account of a rule. Confirm against the rule itself before billing or appealing on it.",
    );
  }
  return lines.join("\n");
}

/** Exported for callers that want the tier ordering without importing credibility directly. */
export { DEFAULT_TIER_ORDER };
