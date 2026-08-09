import { speakCode, speakDate, speakMoney } from "./spoken-codes.js";

// ── Turning a written answer into one worth listening to ─────────────────────
// An agent's reply is written for a screen: headings, tables, a fenced X12
// segment, a link to a CMS page. Read aloud verbatim that becomes forty seconds
// of "pound pound Summary", "pipe pipe dash dash dash", and a URL spelled out
// character by character — and the one sentence the listener needed is buried
// somewhere in the middle of it.
//
// Speech has no scrollback. Whatever cannot be understood on the first pass is
// lost, so the rule throughout this file is: say the things a listener can act
// on, and say what was left out rather than reading it badly.

/**
 * How this domain's jargon must be pronounced.
 *
 * Three different treatments, for three different reasons:
 *
 *  - Initialisms are spaced out ("N C C I") because every engine otherwise
 *    tries to syllabify them, and "nikki" is not a thing a biller recognises.
 *  - The ones the industry says as words keep their word ("hick picks" for
 *    HCPCS, "fire" for FHIR). Spelling those out is just as wrong in the other
 *    direction — nobody has ever said "H C P C S" out loud.
 *  - X12 transaction numbers are read in pair-groups, the way the people who
 *    work with them say them: an 835 is "an eight thirty five", never "eight
 *    hundred thirty five" and never "eight three five".
 *
 * A few entries expand instead of spelling, where the letters alone are
 * genuinely ambiguous out loud — see the comments on those lines.
 */
export const SPOKEN_ABBREVIATIONS: Record<string, string> = {
  // Edits and adjudication
  NCCI: "N C C I",
  MUE: "M U E",
  PTP: "P T P",
  CARC: "C A R C",
  RARC: "R A R C",

  // Identifiers
  NPI: "N P I",
  TIN: "T I N",
  MBI: "M B I",

  // Remittance and payment
  EOB: "E O B",
  ERA: "E R A",
  RVU: "R V U",
  wRVU: "work R V U", // the "w" is read as the word it stands for, as coders say it
  MPFS: "M P F S",
  GPCI: "G P C I",

  // Code sets
  HCPCS: "hick picks", // the actual industry pronunciation; spelling it is unrecognisable
  CPT: "C P T",
  ICD: "I C D",

  // Coverage and contractors
  LCD: "L C D",
  NCD: "N C D",
  MAC: "mac", // said as a word — Medicare Administrative Contractor
  RAC: "rack", // likewise, and a "R A C audit" is not a phrase anyone uses
  ABN: "A B N",

  // Coordination of benefits
  COB: "C O B",
  MSP: "M S P",

  // Compliance and setting
  PHI: "P H I",
  DME: "D M E",
  POS: "P O S",
  EM: "evaluation and management",
  "E&M": "evaluation and management",
  "E/M": "evaluation and management",

  // X12 transactions, in pair-groups
  "835": "eight thirty five",
  "837P": "eight thirty seven P",
  "837I": "eight thirty seven I",
  "837": "eight thirty seven",
  "277CA": "two seventy seven C A",
  "277": "two seventy seven",
  "276": "two seventy six",
  "999": "nine ninety nine",
  X12: "X twelve",

  // Operations
  TAT: "T A T",
  AR: "accounts receivable", // "A R" out loud is heard as the letter R
  "A/R": "accounts receivable",
  DSO: "D S O",

  // No Surprises Act and its machinery
  NSA: "No Surprises Act", // spelled out, every listener hears the spy agency
  IDR: "I D R",

  // Prior authorization and the Da Vinci APIs around it
  PA: "prior authorization", // "P A" is physician assistant, or Pennsylvania
  DTR: "D T R",
  CRD: "C R D",
  PAS: "P A S",
  FHIR: "fire", // pronounced "fire" by everyone who implements it
};

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Longest key first, so "837P" wins over "837" and "E&M" over "EM" — JavaScript
 * alternation is leftmost-first, not leftmost-longest, so the ordering here is
 * what makes the nesting come out right.
 */
const ABBREVIATION_KEYS = Object.keys(SPOKEN_ABBREVIATIONS).sort(
  (a, b) => b.length - a.length || (a < b ? -1 : 1),
);

/**
 * Case-sensitive, and bounded on both sides.
 *
 * Case-sensitivity is not a nicety: half these keys are ordinary English words
 * in lower case. Matching case-insensitively turns "a new era" into "a new
 * E R A", "the tin of" into "the T I N of", and every "pa" and "mac" and "cob"
 * in the reply into an acronym. The boundaries are what keep MACRA from
 * becoming "mac RA" and CARCASS from becoming "C A R C ass".
 */
const ABBREVIATION_RE = new RegExp(
  `(?<![A-Za-z0-9$&/.])(?:${ABBREVIATION_KEYS.map(escapeRegExp).join("|")})(?![A-Za-z0-9]|[.,][0-9])`,
  "g",
);

/** Replace RCM jargon with its spoken form, on word boundaries only. */
export function applySpokenAbbreviations(text: string): string {
  return text.replace(ABBREVIATION_RE, (match) => SPOKEN_ABBREVIATIONS[match] ?? match);
}

/**
 * The literals worth re-rendering for speech, in the order they must be tried.
 *
 * Money first, because "$1,234.56" contains a five-digit-looking run and a
 * decimal that the code patterns would happily mangle. Dates next for the same
 * reason. A bare integer is deliberately absent: "5 units" is five units, and
 * a renderer that turned every number into a code would say "five" as a code
 * and, worse, would spell unit counts and page numbers out digit by digit.
 */
const SPEAKABLE_LITERALS = new RegExp(
  [
    String.raw`\$\s?\d[\d,]*(?:\.\d{1,2})?`,
    String.raw`\b\d{4}-\d{2}-\d{2}\b`,
    String.raw`\b\d{1,2}\/\d{1,2}\/\d{4}\b`,
    String.raw`\bmodifiers?\s+-?\d{2}\b`,
    String.raw`(?<![\d.,$])\d{5}-\d{2}(?!\d|[.,]\d)`,
    String.raw`\b[A-TV-Z]\d{2}\.[0-9A-Z]{1,4}\b`,
    String.raw`\b[A-V]\d{4}\b`,
    String.raw`\b\d{4}[A-Z]\b`,
    // The lookahead rejects a decimal ("12345.67" is a figure, not a code) but
    // must still allow the full stop that ends a sentence — an earlier
    // `(?![\d.,])` silently left every code that closed a sentence unspoken.
    String.raw`(?<![\d.,$])\d{5}(?!\d|[.,]\d)`,
  ].join("|"),
  "g",
);

function renderLiteral(match: string): string {
  if (match.startsWith("$")) return speakMoney(match);
  if (/^\d{4}-\d{2}-\d{2}$/.test(match) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(match)) {
    return speakDate(match);
  }
  const modifier = /^modifiers?\s+-?(\d{2})$/i.exec(match);
  if (modifier) return speakCode(`-${modifier[1]}`);
  return speakCode(match);
}

/** Apply the code, money and date renderers to the literals inside a sentence. */
export function expandSpeakableLiterals(text: string): string {
  return text.replace(SPEAKABLE_LITERALS, renderLiteral);
}

// ── Markdown, taken apart ────────────────────────────────────────────────────

const FENCE_RE = /^\s*(`{3,}|~{3,})/;

function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.length > 1;
}

function isSeparatorRow(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s+/g, "")));
}

/**
 * Split a table row on its cell separators.
 *
 * The lookbehind matters: a cell containing an escaped pipe ("CO\|45") is one
 * cell, and splitting on it inflates the column count — the summary then
 * announces four columns for a three-column table, which is the whole of what
 * the listener is being told.
 */
function splitTableRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|\s*$/, "");
  return body
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function stripInlineMarkdown(line: string): string {
  return (
    line
      // Images and links keep their words and lose their target. A spoken URL
      // is a minute of "h t t p s colon slash slash" that nobody can write down.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<https?:\/\/[^>]*>/g, "")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/(?<![A-Za-z0-9_])__([^_]+)__(?![A-Za-z0-9_])/g, "$1")
      .replace(/(?<![A-Za-z0-9_])_([^_]+)_(?![A-Za-z0-9_])/g, "$1")
  );
}

const TERMINAL = /[.!?:;]$/;

function asSentence(line: string): string {
  const trimmed = line.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return TERMINAL.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Cut to length at a sentence end.
 *
 * Cutting mid-sentence is worse in speech than in text: there is no visible
 * ellipsis, so the listener hears a confident statement that simply stops, and
 * a half-read "this claim will not" is heard as the opposite of what it said.
 * Falling back to a word boundary is the floor, never a mid-word cut.
 */
function truncateAtSentence(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0 || text.length <= maxChars) return { text, truncated: false };
  const window = text.slice(0, maxChars);

  const sentence = /^[\s\S]*[.!?](?=\s|$)/.exec(window);
  if (sentence && sentence[0].trim()) return { text: sentence[0].trim(), truncated: true };

  // If the limit happens to fall on whitespace the last word in the window is
  // whole, and dropping it would throw away a word for no reason.
  const onBoundary = /\s/.test(text[maxChars] ?? " ");
  const word = (onBoundary ? window : window.replace(/\s+\S*$/, "")).trim();
  return { text: word || window.trim(), truncated: true };
}

export interface SpeakableOptions {
  /** Hard ceiling on the spoken text. Default 1200 — roughly 90 seconds. */
  maxChars?: number;
  /** Re-render codes, money and dates. Default true. */
  expandCodes?: boolean;
}

export interface SpeakableResult {
  text: string;
  truncated: boolean;
  /** What was dropped rather than read badly, phrased to be spoken as-is. */
  omitted: string[];
}

/**
 * Turn an agent's markdown reply into text a speech engine can read.
 *
 * Code blocks and tables are summarised rather than read. This is the one
 * judgement call in the file and it is not close: an 837P segment read aloud is
 * two minutes of "N M one star eight five star two", and a ten-row table read
 * cell by cell loses its header before the second row — by which point the
 * listener has no idea whether the number they just heard was a charge or an
 * allowed amount. Saying "there is a table of ten rows" at least tells them to
 * go and look.
 */
export function toSpeakable(markdown: string, opts: SpeakableOptions = {}): SpeakableResult {
  const maxChars = opts.maxChars ?? 1200;
  const expandCodes = opts.expandCodes ?? true;
  const omitted: string[] = [];

  if (!markdown || !markdown.trim()) return { text: "", truncated: false, omitted };

  // Trailing blank lines are dropped before anything else: a reply that ends
  // with an unclosed fence and a final newline otherwise reports one more line
  // of code than it actually contains.
  const lines = markdown.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const kept: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const fence = FENCE_RE.exec(lines[i]);
    if (fence) {
      // The closing fence must be at least as long as the opening one, which is
      // what lets a four-backtick block contain a three-backtick one — an agent
      // showing someone how to write a fenced block otherwise ends the outer
      // block at the inner fence and reads the remainder of it aloud.
      const opener = fence[1];
      const closer = new RegExp(`^\\s*${opener[0] === "`" ? "`" : "~"}{${opener.length},}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !closer.test(lines[j])) j += 1;
      const closed = j < lines.length;
      const count = (closed ? j : lines.length) - i - 1;
      omitted.push(`a ${count}-line code block`);
      i = closed ? j + 1 : lines.length;
      continue;
    }

    if (isTableLine(lines[i]) && isTableLine(lines[i + 1] ?? "")) {
      let j = i;
      while (j < lines.length && isTableLine(lines[j])) j += 1;
      const block = lines.slice(i, j);
      const header = splitTableRow(block[0]).filter(Boolean);
      const hasSeparator = block.length > 1 && isSeparatorRow(block[1]);
      const rows = block.length - (hasSeparator ? 2 : 1);
      kept.push(
        header.length
          ? `a table of ${rows} rows, columns: ${header.join(", ")}`
          : `a table of ${rows} rows`,
      );
      i = j;
      continue;
    }

    const raw = lines[i];
    i += 1;

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) continue; // horizontal rule

    let line = raw
      .replace(/^\s*#{1,6}\s*/, "")
      .replace(/^\s*>\s?/, "")
      // A bullet is a sentence break, not a word: dropping the marker and
      // terminating the line is what makes a list sound like a list.
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
    line = stripInlineMarkdown(line);
    const sentence = asSentence(line);
    if (sentence) kept.push(sentence);
  }

  let text = kept.map(asSentence).join(" ").replace(/\s+/g, " ").trim();
  text = applySpokenAbbreviations(text);
  if (expandCodes) text = expandSpeakableLiterals(text);
  text = text.replace(/\s+/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim();
  if (text && !TERMINAL.test(text)) text = `${text}.`;

  const cut = truncateAtSentence(text, maxChars);
  return { text: cut.text, truncated: cut.truncated, omitted };
}

/**
 * A spoken lead-in: the first sentence or two of a long reply.
 *
 * Used to say something immediately while the full answer is still being
 * rendered or read. It goes through the same pipeline, because a lead-in that
 * says "pound pound Findings" is worse than silence.
 */
export function speakableSummary(text: string, limit = 240): string {
  if (!text || !text.trim()) return "";
  const spoken = toSpeakable(text, { maxChars: Math.max(limit * 4, limit) }).text;
  if (!spoken) return "";

  const sentences = spoken.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [spoken];
  let out = sentences[0].trim();
  // A second sentence only if the first was short enough to leave room; a
  // lead-in that runs to the limit is not a lead-in.
  if (sentences[1] && out.length < limit / 2) {
    const pair = `${out} ${sentences[1].trim()}`;
    if (pair.length <= limit) out = pair;
  }
  if (out.length > limit) out = truncateAtSentence(out, limit).text;
  return out;
}
