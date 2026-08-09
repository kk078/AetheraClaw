import { parseSpokenCode } from "../speech/spoken-codes.js";
import { snapCode, type CodeUniverse } from "../speech/snap.js";
import { toSpeakable } from "../speech/speakable.js";
import { isRefusalCase } from "./cases.js";
import { runCase, type CaseResult, type EvalDeps } from "./run.js";
import {
  PRONUNCIATION_CASES,
  SPOKEN_CODE_CASES,
  SPOKEN_TOOL_CASES,
  type PronunciationCase,
  type SpokenCodeCase,
  type SpokenToolCase,
} from "./voice-cases.js";

// ── The voice harness ────────────────────────────────────────────────────────
// Three families, three different things being measured, deliberately NOT
// averaged into one number:
//
//   codes         — what was heard. Pure, offline, no model.
//   pronunciation — what was said back. Pure, offline, no model.
//   tools         — what was reached for. Delegates to runCase, so the spoken
//                   phrasings meet the same selectTools split, the same system
//                   prompt and the same provider cap that production does. If
//                   this file had its own tool-selection path it would be
//                   measuring itself.
//
// A single blended score would let a perfect pronunciation family hide a code
// parser that cannot hear a J-code, and those two failures have nothing to do
// with each other and different people fix them.
//
// A LOW SCORE IS THE FINDING. Same rule as the typed harness: the cases describe
// utterances people actually make and replies listeners actually have to act on,
// so tuning them to pass changes the number and nothing else.

// ── Word error rate ──────────────────────────────────────────────────────────

/**
 * Tokens for WER: lower case, punctuation dropped, apostrophes kept.
 *
 * Punctuation is dropped because a recognizer does not emit it consistently and
 * scoring it would report a transcription failure every time one engine added a
 * comma. Case is dropped for the same reason. Apostrophes are kept, because
 * "doesn't" and "does not" are genuinely a different number of words and a
 * recognizer that expands contractions has changed the transcript.
 */
function werTokens(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Standard word error rate: (substitutions + deletions + insertions) / |reference|.
 *
 * Levenshtein over word tokens, each edit costing one. Not normalised into
 * [0, 1] — WER above 1 is a real and meaningful reading (a hypothesis longer
 * than the reference can accumulate more insertions than the reference has
 * words), and clamping it would make a recognizer that hallucinates a paragraph
 * score the same as one that returns nothing.
 *
 * An empty reference is the one case with no principled answer, because the
 * denominator is zero. It returns 0 against an empty hypothesis and 1 against a
 * non-empty one: "nothing was said and nothing was heard" is not an error, and
 * "nothing was said and something was heard" is entirely an error.
 */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = werTokens(reference);
  const hyp = werTokens(hypothesis);

  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  if (hyp.length === 0) return 1; // every reference word deleted

  // Two rows: plain Levenshtein needs no more, and unlike snap.ts there is no
  // transposition term here — two swapped WORDS are two errors to a listener,
  // where two swapped digits inside one code are one mishearing.
  let previous = new Array<number>(hyp.length + 1);
  let current = new Array<number>(hyp.length + 1);
  for (let j = 0; j <= hyp.length; j++) previous[j] = j;

  for (let i = 1; i <= ref.length; i++) {
    current[0] = i;
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1, // deletion
        current[j - 1] + 1, // insertion
        previous[j - 1] + cost, // substitution
      );
    }
    const spent = previous;
    previous = current;
    current = spent;
  }

  return previous[hyp.length] / ref.length;
}

// ── Family 1: codes ──────────────────────────────────────────────────────────

export interface SpokenCodeResult {
  case: SpokenCodeCase;
  got: string | null;
  pass: boolean;
}

export interface SpokenCodeRun {
  results: SpokenCodeResult[];
  /** Passes over all cases. Includes the null cases — see falsePositives. */
  accuracy: number;
  /**
   * Cases expecting null that returned a code.
   *
   * Reported SEPARATELY and never folded into accuracy, because the two failure
   * modes are not the same size. A missed code makes the assistant ask again. An
   * invented one produces a claim that is wrong in a way nothing downstream can
   * see — a scrubber handed a real code scrubs it cleanly, whichever code the
   * speaker actually said. One number that averages the two lets a parser trade
   * a fabricated code for a recovered one and come out ahead.
   */
  falsePositives: number;
}

/**
 * The decimal point is punctuation, not information, when comparing what was
 * heard against what was expected.
 *
 * snap.ts already treats it that way — CMS's own order file omits it and every
 * coder types it — so "E1165" and "E11.65" are the same answer here. Anything
 * else would score the dataset's spelling conventions rather than the hearing.
 */
function sameCode(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a.toUpperCase().replace(/\./g, "") === b.toUpperCase().replace(/\./g, "");
}

/**
 * What the pipeline hears for one utterance.
 *
 * Without a universe this is the parser alone. With one, the parsed code is
 * additionally checked against the codes that exist, which is what production
 * does — and the three interesting branches are commented where they are.
 */
function heardCode(spoken: string, universe?: CodeUniverse): string | null {
  const parsed = parseSpokenCode(spoken);
  if (parsed === null || !universe) return parsed;

  // A modifier has no table to be validated against — snapCode would report it
  // as an unknown shape, which would turn every modifier case into a miss and
  // say nothing about whether the modifier was heard.
  if (parsed.startsWith("-")) return parsed;

  const snap = snapCode(parsed, universe);
  switch (snap.status) {
    case "exact":
    case "snapped":
      return snap.code;
    case "ambiguous":
      // Two real codes equally close to what was heard. Production refuses and
      // asks; scoring a guess here would reward the behaviour snap.ts exists to
      // prevent.
      return null;
    case "unknown":
      // The universe could not confirm it. That is a statement about which
      // datasets are installed, not about whether the utterance was heard
      // correctly, so the parse stands and the case is scored on the parse.
      return parsed;
  }
}

export function runSpokenCodeCases(
  universe?: CodeUniverse,
  cases: SpokenCodeCase[] = SPOKEN_CODE_CASES,
): SpokenCodeRun {
  const results: SpokenCodeResult[] = cases.map((c) => {
    const got = heardCode(c.spoken, universe);
    return { case: c, got, pass: sameCode(got, c.expect) };
  });

  const passed = results.filter((r) => r.pass).length;
  return {
    results,
    accuracy: results.length === 0 ? 0 : passed / results.length,
    falsePositives: results.filter((r) => r.case.expect === null && r.got !== null).length,
  };
}

// ── Family 3: pronunciation ──────────────────────────────────────────────────

export interface PronunciationResult {
  case: PronunciationCase;
  pass: boolean;
  /** mustSay entries that did not appear. */
  missing: string[];
  /** mustNotSay entries that did appear. */
  forbidden: string[];
  /** The spoken text, kept so a failure can be read rather than guessed at. */
  spoken: string;
}

export interface PronunciationRun {
  results: PronunciationResult[];
  passed: number;
}

export function runPronunciationCases(cases: PronunciationCase[] = PRONUNCIATION_CASES): PronunciationRun {
  const results: PronunciationResult[] = cases.map((c) => {
    const spoken = toSpeakable(c.markdown).text;
    const haystack = spoken.toLowerCase();
    const missing = c.mustSay.filter((s) => !haystack.includes(s.toLowerCase()));
    const forbidden = c.mustNotSay.filter((s) => haystack.includes(s.toLowerCase()));
    return { case: c, spoken, missing, forbidden, pass: missing.length === 0 && forbidden.length === 0 };
  });
  return { results, passed: results.filter((r) => r.pass).length };
}

// ── All three ────────────────────────────────────────────────────────────────

export interface VoiceEvalOptions {
  /** Codes that exist. Absent means the code family scores the parser alone. */
  universe?: CodeUniverse;
  codeCases?: SpokenCodeCase[];
  pronunciationCases?: PronunciationCase[];
  toolCases?: SpokenToolCase[];
  /** Called as each spoken tool case finishes, since those are the slow ones. */
  onCase?: (r: CaseResult) => void;
}

export interface VoiceEvalReport {
  provider: string;
  model: string;
  codes: SpokenCodeRun;
  pronunciation: PronunciationRun;
  tools: {
    results: CaseResult[];
    cases: SpokenToolCase[];
    passed: number;
    total: number;
  };
}

/**
 * Run all three families.
 *
 * The two pure families run first and are never skipped on a provider error:
 * they need no model, and knowing that the code parser is healthy is exactly
 * what makes a tool-selection failure interpretable rather than ambiguous.
 */
export async function runVoiceEval(deps: EvalDeps, opts: VoiceEvalOptions = {}): Promise<VoiceEvalReport> {
  const codes = runSpokenCodeCases(opts.universe, opts.codeCases);
  const pronunciation = runPronunciationCases(opts.pronunciationCases);

  const toolCases = opts.toolCases ?? SPOKEN_TOOL_CASES;
  const results: CaseResult[] = [];
  // Serial, for the same reason runEval is: a rate-limited provider turning
  // concurrent requests into 429s would score as capability failures.
  for (const c of toolCases) {
    const r = await runCase(deps, c);
    results.push(r);
    opts.onCase?.(r);
  }

  return {
    provider: deps.provider.name,
    model: deps.provider.model,
    codes,
    pronunciation,
    tools: {
      results,
      cases: toolCases,
      passed: results.filter((r) => r.passed).length,
      total: results.length,
    },
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

function excerpt(text: string, limit = 64): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * Per case, like renderReport, and for the same reason: an aggregate hides WHICH
 * capability is unreachable, and an unreachable capability is the whole point of
 * running this at all. "82%" is not an answer to "can it hear a J-code".
 */
export function renderVoiceReport(report: VoiceEvalReport): string {
  const out: string[] = ["", `${report.provider} / ${report.model} — voice evaluation.`, ""];

  // ── Codes ──────────────────────────────────────────────────────────────────
  const codeFailures = report.codes.results.filter((r) => !r.pass);
  out.push(`CODES  ${report.codes.results.length - codeFailures.length}/${report.codes.results.length} heard correctly.`);
  for (const r of codeFailures) {
    const invented = r.case.expect === null && r.got !== null;
    out.push(
      `  ${invented ? "FALSE POSITIVE" : "FAIL"}  "${r.case.spoken}"`,
      `      heard:  ${r.got === null ? "(not a code)" : r.got}`,
      `      wanted: ${r.case.expect === null ? "(not a code)" : r.case.expect}`,
      `      why:    ${r.case.why}`,
    );
  }
  out.push(
    `  ${report.codes.falsePositives} false positive(s) — a code returned where the utterance was not one.`,
    report.codes.falsePositives === 0
      ? "  Nothing was invented. That is the number that matters most here."
      : "  Counted separately from accuracy on purpose: inventing a code is a different and worse failure than missing one.",
    "",
  );

  // ── Pronunciation ──────────────────────────────────────────────────────────
  const sayFailures = report.pronunciation.results.filter((r) => !r.pass);
  out.push(`SPOKEN REPLIES  ${report.pronunciation.passed}/${report.pronunciation.results.length} readable out loud.`);
  for (const r of sayFailures) {
    out.push(
      `  FAIL  "${excerpt(r.case.markdown)}"`,
      `      said:      "${excerpt(r.spoken, 120)}"`,
      ...(r.missing.length > 0 ? [`      missing:   ${r.missing.join(" | ")}`] : []),
      ...(r.forbidden.length > 0 ? [`      forbidden: ${r.forbidden.join(" | ")}`] : []),
      `      why:       ${r.case.why}`,
    );
  }
  out.push("");

  // ── Tools ──────────────────────────────────────────────────────────────────
  out.push(`SPOKEN TOOL SELECTION  ${report.tools.passed}/${report.tools.total} reached a tool that can answer.`);
  // A run where the provider fell over is NOT a capability measurement, and
  // printing a score for it invites exactly the wrong conclusion — a
  // rate-limited run once read as "the prompt change made it worse". Errors are
  // counted and called out before the score is interpreted.
  const errored = report.tools.results.filter((r) => r.error).length;
  if (errored > 0) {
    out.push(
      `  ${errored} of ${report.tools.total} case(s) ERRORED — the provider failed, so this score measures availability, not capability.`,
      "  Fix the provider and re-run before drawing any conclusion from the number above.",
    );
  }
  for (const r of report.tools.results.filter((x) => !x.passed)) {
    const spec = report.tools.cases.find((c) => c.id === r.case.id);
    out.push(
      `  FAIL  ${r.case.id}`,
      ...(spec ? [`      said:    "${spec.spoken}"`] : []),
      `      sent:    "${r.case.prompt}"`,
      `      reached: ${r.reached.length > 0 ? r.reached.join(" → ") : "(no tool called)"}`,
      `      wanted:  ${isRefusalCase(r.case) ? "no tool call at all" : r.case.expect.join(" | ")}`,
      // An errored case reaches no tool and scores false, which on a REFUSAL
      // case is indistinguishable from the correct answer — it prints "(no tool
      // called)" against "wanted: no tool call at all" and is still marked
      // failed. Without this line the reader concludes the scoring is broken, or
      // worse, that the model refused when the provider actually fell over.
      ...(r.error ? [`      ERROR:   ${r.error} — the provider failed; this is not a behavioural result`] : []),
      ...(spec?.typedId ? [`      typed twin: ${spec.typedId} — compare against the same id in the typed report.`] : []),
      `      why:     ${r.case.why}`,
      ...(r.error ? [`      error:   ${r.error}`] : []),
    );
  }

  const total =
    report.codes.results.length + report.pronunciation.results.length + report.tools.total;
  const passed =
    report.codes.results.filter((r) => r.pass).length + report.pronunciation.passed + report.tools.passed;
  out.push(
    "",
    `${passed}/${total} across all three families.`,
    passed === total
      ? "Every code was heard, every reply was sayable, and every spoken question reached a tool that can answer it."
      : "A low score is the finding — these are utterances people make and replies listeners must act on, so tuning the cases to pass measures nothing.",
  );

  return out.join("\n");
}
