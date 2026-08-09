// ── Recognition vocabulary ───────────────────────────────────────────────────
// A general speech recognizer has never heard of "Availity", "J1885" or
// "uhcprovider". Handed those, it returns "availability", "J one eight eight
// five" and "you HC provider" — three transcripts that look like speech and
// parse like noise, and the assistant then answers a question nobody asked.
//
// Every engine worth using accepts a hint list, and every one of them gets
// dramatically better with a good one. The practice already has the right list:
// the codes it actually bills, the payers it actually works, the providers it
// actually renders under. This module turns that raw material into the three
// shapes engines take, as pure functions over plain data.
//
// Two rules run through all of it:
//
//   1. Every engine caps the list. So the list has to be RANKED, not merely
//      deduplicated — the cap decides what gets dropped, and a hint list that
//      spends its budget on "claim" and "denied" while dropping "Availity" is
//      worse than no list at all.
//   2. A hint list is sent to a vendor. So a member ID that wandered in from a
//      note field must never survive the trip. That gate is here, at the shape
//      boundary, rather than at each call site — see renderVocabularyPrompt.

import { detectPhi } from "../channels/email/classify.js";

export interface VocabularySource {
  /** Billed procedure/diagnosis/HCPCS codes. Repeat an entry per claim it appears on. */
  codes?: string[];
  /** Payer names as the practice writes them. */
  payers?: string[];
  /** Rendering provider names. */
  providers?: string[];
  /** Anything else worth teaching the recognizer — portal names, local jargon. */
  extra?: string[];
}

export interface VocabularyOptions {
  /** Ranked entries to keep. Applied AFTER ranking, never before. */
  limit?: number;
}

/** Engines cap their hint lists; 100 is under every cap this deployment targets. */
export const DEFAULT_HINT_LIMIT = 100;

/**
 * Longest hint worth carrying.
 *
 * A hint is a token the decoder biases toward. A 200-character string is a
 * sentence, not a token: it can never match as a unit, and it burns prompt
 * budget that a real payer name needed. 64 characters comfortably holds
 * "Blue Cross Blue Shield of Massachusetts" and rejects a pasted address.
 */
export const MAX_HINT_LENGTH = 64;

/**
 * OpenAI's `prompt` field is capped at 224 tokens and Whisper's initial prompt
 * is capped at the same n_text_ctx/2. Past the cap the tail is silently dropped
 * — and which part of the tail is not ours to choose, so we truncate first.
 */
export const PROMPT_TOKEN_BUDGET = 224;

/**
 * How much each source contributes before frequency is counted.
 *
 * Codes and payers are the entries a recognizer gets wrong every single time, so
 * they outrank a provider name (which is at least a plausible English name) and
 * free-text extras (which are whatever someone typed).
 */
const FIELD_WEIGHT: Record<keyof VocabularySource, number> = {
  codes: 4,
  payers: 4,
  providers: 3,
  extra: 2,
};

/** Fixed iteration order — ranking must not depend on object key order. */
const FIELDS: Array<keyof VocabularySource> = ["codes", "payers", "providers", "extra"];

// ── Per-entry admission ──────────────────────────────────────────────────────

/**
 * One hint, one line, single-spaced.
 *
 * Collapsing whitespace is not cosmetic. A hint reaches OpenAI inside a
 * multipart body and reaches whisper.cpp on argv; a CR or LF surviving into
 * either turns a value into a header line or a second argument. Killing all
 * whitespace runs here means no downstream shape has to think about it.
 */
export function normalizeHint(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Can this entry help recognition at all?
 *
 * Each rejection is a hint that measurably hurts: a single character biases the
 * decoder toward emitting that letter everywhere, pure punctuation matches
 * nothing, and an over-long string is a sentence wearing a token's clothes.
 * Every one of them also costs prompt budget a real term needed.
 */
export function isUsableHint(term: string): boolean {
  if (term.length < 2) return false;
  if (term.length > MAX_HINT_LENGTH) return false;
  // No letter and no digit means punctuation or symbols only.
  if (!/[A-Za-z0-9]/.test(term)) return false;
  return true;
}

/**
 * Does this entry look like a patient identifier?
 *
 * Reuses detectPhi rather than growing a second set of patterns, because two
 * sets drift: the MBI pattern learned to accept the hyphenated form the card
 * actually prints, and a copy here would not have. A hint list is disclosed to a
 * vendor verbatim — an SSN or MBI that reaches it is a reportable disclosure
 * caused by a vocabulary feature, which is an absurd way to have one.
 */
export function looksLikePhi(term: string): boolean {
  return detectPhi(term).length > 0;
}

/**
 * Admit a caller's list without reordering it.
 *
 * Order carries meaning by the time a list reaches a vendor shape — it is the
 * ranking, and the engine's cap eats the tail — so this filters and dedupes but
 * never sorts. buildHintVocabulary is what establishes the order in the first
 * place.
 */
export function sanitizeHints(hints: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of hints) {
    if (typeof raw !== "string") continue;
    const term = normalizeHint(raw);
    if (!isUsableHint(term)) continue;
    if (looksLikePhi(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

// ── Ranking ──────────────────────────────────────────────────────────────────

/**
 * How much a term's SHAPE suggests the recognizer will fumble it.
 *
 * "Aetna" and "J1885" are worth budget; "claim" is not — the engine already
 * knows "claim", and spending a slot on it displaces something it doesn't know.
 */
function specificityBonus(term: string): number {
  let bonus = 0;
  // A digit means a code, a policy number or a portal name. No ordinary English
  // word contains one, and these are exactly what comes back as prose.
  if (/\d/.test(term)) bonus += 3;
  // Leading capital: a proper noun, so a name the general model may not hold.
  if (/^[A-Z]/.test(term)) bonus += 1;
  // A capital after the first character: an acronym or brand (UHC, BCBS, eClaims).
  if (/[A-Z]/.test(term.slice(1))) bonus += 1;
  // All lowercase letters and nothing else: a generic word the engine has.
  if (/^[a-z]+$/.test(term)) bonus -= 1;
  return bonus;
}

/**
 * Which of several spellings of the same term to send.
 *
 * Lower is better. A hint list of "aetna" helps less than one of "Aetna": the
 * decoder biases toward the literal string, and the transcript then carries the
 * casing the hint had. Mixed case is the shape a payer name really has, so it
 * wins ties over a shouted or flattened variant.
 */
function casingRank(term: string): number {
  const hasUpper = /[A-Z]/.test(term);
  const hasLower = /[a-z]/.test(term);
  if (hasUpper && hasLower) return 0; // Aetna
  if (hasUpper) return 1; // AETNA
  if (hasLower) return 2; // aetna
  return 3; // no letters at all — "99213"
}

interface Candidate {
  /** Case-insensitive identity. */
  key: string;
  /** Count per exact spelling seen, so the commonest casing can be chosen. */
  forms: Map<string, number>;
  /** Total occurrences across every spelling and every field. */
  count: number;
  /** Best (highest) field weight this term appeared under. */
  weight: number;
}

/**
 * Build the hint list.
 *
 * Frequency is read from repetition in the input: pass a code once per claim it
 * was billed on and the codes the practice lives off rise to the top on their
 * own, with no separate count plumbing. A code billed 400 times and a code
 * billed once are not equally worth a slot, and the cap will take one of them.
 *
 * The ordering is total and independent of input order — score first, then the
 * case-folded term. JavaScript's sort is stable, so leaving ties to fall through
 * to insertion order would mean the same practice produced a different hint list
 * depending on the row order a query happened to return, and a recognition
 * regression that could not be reproduced.
 */
export function buildHintVocabulary(source: VocabularySource, opts: VocabularyOptions = {}): string[] {
  const limit = opts.limit ?? DEFAULT_HINT_LIMIT;
  if (limit <= 0) return [];

  const candidates = new Map<string, Candidate>();

  for (const field of FIELDS) {
    const values = source[field];
    if (!values) continue;
    for (const raw of values) {
      if (typeof raw !== "string") continue;
      const term = normalizeHint(raw);
      if (!isUsableHint(term)) continue;
      // The gate runs per entry rather than over the joined list: joining first
      // would let two innocent neighbours form an identifier-shaped span and
      // take a legitimate code down with them.
      if (looksLikePhi(term)) continue;

      const key = term.toLowerCase();
      const existing = candidates.get(key);
      if (existing) {
        existing.forms.set(term, (existing.forms.get(term) ?? 0) + 1);
        existing.count += 1;
        existing.weight = Math.max(existing.weight, FIELD_WEIGHT[field]);
      } else {
        candidates.set(key, {
          key,
          forms: new Map([[term, 1]]),
          count: 1,
          weight: FIELD_WEIGHT[field],
        });
      }
    }
  }

  const ranked = [...candidates.values()]
    .map((candidate) => {
      const display = pickCasing(candidate.forms);
      return {
        key: candidate.key,
        display,
        // Frequency dominates, which is the point: what the practice bills is
        // what the practice dictates. Shape and source break the many ties
        // among terms seen the same number of times.
        score: candidate.count * 2 + candidate.weight + specificityBonus(display),
      };
    })
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return ranked.slice(0, limit).map((entry) => entry.display);
}

/** Commonest spelling wins; ties go to the most name-shaped, then alphabetically. */
function pickCasing(forms: Map<string, number>): string {
  return [...forms.entries()].sort(
    (a, b) =>
      b[1] - a[1] ||
      casingRank(a[0]) - casingRank(b[0]) ||
      (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  )[0]![0];
}

// ── Vendor shapes ────────────────────────────────────────────────────────────

export type VocabularyStyle = "prompt" | "keyterm" | "grammar";

/** Named once so the truncation arithmetic and the join cannot disagree. */
const SEPARATOR = ", ";

/**
 * Token estimate, deliberately pessimistic.
 *
 * The published rule of thumb is ~4 characters per token for English prose, but
 * a hint list is not prose: "J1885" is three or four tokens, not one, and a
 * payer name full of capitals splits worse than a sentence does. Estimating at
 * 3 characters per token overshoots on prose and lands about right on codes.
 * Overshooting costs a few dropped hints; undershooting means the vendor
 * truncates instead of us, mid-entry, at a point we did not choose.
 */
export function estimateTokens(text: string): number {
  return tokensForLength(text.length);
}

/**
 * The same estimate over a length.
 *
 * Truncation measures the JOINED string rather than summing a per-entry
 * estimate: per-entry ceilings each round up, so summing them drifts several
 * tokens high per hundred entries and quietly drops terms that would have fit.
 * One definition, applied to the thing actually sent.
 */
function tokensForLength(length: number): number {
  if (length <= 0) return 0;
  return Math.ceil(length / 3);
}

/**
 * JSGF tokens are bare words; anything else has to be quoted.
 *
 * The characters that matter are the grammar's own operators — `|` `;` `=` `<`
 * `>` `*` `+` `(` `)` `[` `]` — plus the space in "Blue Cross". An unquoted
 * "Blue Cross & Blue Shield" is not a mangled hint, it is a parse error, and
 * SpeechGrammarList.addFromString throws on the whole grammar, silently costing
 * every other term in the list.
 */
function escapeJsgfToken(term: string): string {
  if (/^[A-Za-z0-9]+$/.test(term)) return term;
  return `"${term.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderVocabularyPrompt(hints: string[], style: "prompt"): string;
export function renderVocabularyPrompt(hints: string[], style: "keyterm"): string[];
export function renderVocabularyPrompt(hints: string[], style: "grammar"): string;
export function renderVocabularyPrompt(hints: string[], style: VocabularyStyle): string | string[];
/**
 * Render a hint list into the shape one engine family takes.
 *
 * This is the last function before a hint list becomes part of a request, so it
 * is where sanitizeHints runs: any caller — a request builder, a route handler,
 * a future engine — gets the identifier gate for free rather than having to
 * remember it. Forgetting it exactly once is a disclosure.
 */
export function renderVocabularyPrompt(hints: string[], style: VocabularyStyle): string | string[] {
  const clean = sanitizeHints(hints);

  if (style === "keyterm") {
    // Deepgram takes one keyterm per term and does its own weighting; no cap to
    // respect and no joining to get wrong.
    return clean;
  }

  if (style === "grammar") {
    // An empty rule ("public <billing> = ;") is not an empty grammar, it is a
    // malformed one, and Chrome throws on it. Nothing is the honest answer.
    if (clean.length === 0) return "";
    const alternatives = clean.map(escapeJsgfToken).join(" | ");
    return `#JSGF V1.0; grammar aetheraclaw; public <billing> = ${alternatives};`;
  }

  // "prompt": one comma-joined string, truncated at an entry boundary.
  //
  // `break`, not `continue`: the list arrives ranked, so stopping keeps a prefix
  // of the ranking. Skipping the over-long entry and squeezing in a later short
  // one would let a rarely-billed code displace a frequently-billed one purely
  // because it was shorter, which is the ranking undone at the last step.
  const kept: string[] = [];
  let length = 0;
  for (const term of clean) {
    const joined = kept.length === 0 ? term.length : length + SEPARATOR.length + term.length;
    if (tokensForLength(joined) > PROMPT_TOKEN_BUDGET) break;
    kept.push(term);
    length = joined;
  }
  return kept.join(SEPARATOR);
}

/**
 * One line for a status report.
 *
 * The number that matters is not how many hints exist but how many survive the
 * prompt cap — a 400-entry vocabulary that renders as 60 terms is working far
 * less well than its size suggests, and this is the only place that says so.
 */
export function describeVocabulary(hints: string[]): string {
  const clean = sanitizeHints(hints);
  if (clean.length === 0) {
    return "vocabulary: none — recognition runs on the engine's general vocabulary, which has no Availity, no J1885 and no payer names.";
  }
  const prompt = renderVocabularyPrompt(clean, "prompt");
  const fitted = prompt.length === 0 ? 0 : prompt.split(SEPARATOR).length;
  const dropped = clean.length - fitted;
  const sample = clean.slice(0, 3).join(SEPARATOR);
  return (
    `vocabulary: ${clean.length} hint${clean.length === 1 ? "" : "s"}, ` +
    `${fitted} fit the ${PROMPT_TOKEN_BUDGET}-token prompt cap (~${estimateTokens(prompt)} tokens` +
    `${dropped > 0 ? `, ${dropped} dropped` : ""}) — e.g. ${sample}`
  );
}
