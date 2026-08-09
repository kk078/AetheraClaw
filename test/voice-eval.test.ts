import { describe, expect, it } from "vitest";
import {
  PRONUNCIATION_CASES,
  SPOKEN_CODE_CASES,
  SPOKEN_TOOL_CASES,
  type SpokenCodeCase,
} from "../src/eval/voice-cases.js";
import {
  renderVoiceReport,
  runPronunciationCases,
  runSpokenCodeCases,
  wordErrorRate,
  type VoiceEvalReport,
} from "../src/eval/voice-run.js";
import { CASES } from "../src/eval/cases.js";
import type { CaseResult } from "../src/eval/run.js";
import { normalizeSpokenCodes } from "../src/speech/spoken-codes.js";
import type { CodeUniverse } from "../src/speech/snap.js";
import { buildRegistry } from "../src/tools/build-registry.js";
import { loadConfig } from "../src/config/config.js";

// Entirely offline. No provider is constructed and no model is called: two of
// the three families are pure by design, and the third is exercised here only
// through its scoring and its report, because a test that needed a model would
// be a test nobody runs.
//
// The voice harness measures the voice path. These tests measure the harness —
// a WER that returns a plausible-looking number for the wrong reason, or an
// accuracy that quietly absorbs the false positives, would report a healthy
// figure about nothing at all.

describe("word error rate", () => {
  it("is zero for a perfect match, ignoring case and punctuation", () => {
    expect(wordErrorRate("scrub the claim", "scrub the claim")).toBe(0);
    // A recognizer does not emit punctuation consistently, so scoring it would
    // report a transcription failure every time one engine added a comma.
    expect(wordErrorRate("Bill 99213, then stop.", "bill 99213 then stop")).toBe(0);
  });

  it("is one when nothing was heard at all", () => {
    // Four reference words, four deletions, four over four.
    expect(wordErrorRate("scrub the claim now", "")).toBe(1);
    expect(wordErrorRate("scrub the claim now", "   ")).toBe(1);
  });

  it("counts a single substitution against the reference length", () => {
    // "the cat sat on the mat" / "the cat sat on a mat": one substitution, six
    // reference words.
    expect(wordErrorRate("the cat sat on the mat", "the cat sat on a mat")).toBeCloseTo(1 / 6, 12);
    // The failure this exists to catch, worked by hand: five digits spoken,
    // the last one heard as something else. 1/5.
    expect(wordErrorRate("nine nine two one three", "nine nine two one four")).toBe(0.2);
  });

  it("counts deletions and insertions", () => {
    // One word dropped from five.
    expect(wordErrorRate("nine nine two one three", "nine nine two one")).toBe(0.2);
    // Two words added to three.
    expect(wordErrorRate("scrub the claim", "scrub the claim please now")).toBeCloseTo(2 / 3, 12);
  });

  it("mixes all three edits in one utterance", () => {
    // ref: "check the claim status now"        (5 words)
    // hyp: "check that claim status"           1 substitution + 1 deletion = 2
    expect(wordErrorRate("check the claim status now", "check that claim status")).toBe(0.4);
  });

  it("goes above one rather than clamping", () => {
    // One reference word, four heard: three insertions over one. Clamping this
    // to 1 would make a recognizer that hallucinates a sentence score the same
    // as one that returned nothing.
    expect(wordErrorRate("code", "the code is nine")).toBe(3);
  });

  it("has a stated answer for an empty reference", () => {
    expect(wordErrorRate("", "")).toBe(0);
    expect(wordErrorRate("", "ninety nine two thirteen")).toBe(1);
  });
});

// ── Family 1 ─────────────────────────────────────────────────────────────────

/**
 * A universe built from the cases' own expectations.
 *
 * Synthetic on purpose, exactly as snap.ts intends: the matching rules are
 * tested against a handful of known codes rather than against whatever datasets
 * happen to be installed on the machine running the suite. test/setup.ts points
 * AETHERACLAW_HOME at an empty directory, so the installed universe here would
 * be empty anyway and every case would score as "not installed".
 */
function syntheticUniverse(cases: SpokenCodeCase[] = SPOKEN_CODE_CASES): CodeUniverse {
  const universe: CodeUniverse = { cpt: new Set(), hcpcs: new Set(), icd10: new Set() };
  for (const c of cases) {
    const code = c.expect;
    if (code === null || code.startsWith("-")) continue;
    if (/^\d{5}$/.test(code)) universe.cpt.add(code);
    else if (/^[A-Z]\d{4}$/.test(code)) universe.hcpcs.add(code);
    else if (/^[A-Z]\d[0-9A-Z](?:\.[0-9A-Z]{1,4})?$/.test(code)) universe.icd10.add(code);
  }
  return universe;
}

describe("spoken code cases", () => {
  it("has enough cases, weighted toward the ones that must return nothing", () => {
    expect(SPOKEN_CODE_CASES.length).toBeGreaterThanOrEqual(20);
    const nulls = SPOKEN_CODE_CASES.filter((c) => c.expect === null);
    // Inventing a code is worse than missing one, so the suite is deliberately
    // heavy on utterances that are not codes. A suite that was all dictations
    // would never notice a parser that answers for every sentence.
    expect(nulls.length).toBeGreaterThanOrEqual(8);
    expect(nulls.length / SPOKEN_CODE_CASES.length).toBeGreaterThan(0.2);
  });

  it("covers every family a coder actually dictates", () => {
    const spoken = SPOKEN_CODE_CASES.map((c) => c.spoken.toLowerCase());
    const expects = SPOKEN_CODE_CASES.map((c) => c.expect);
    // digit by digit, and the grouped shorthand
    expect(spoken).toContain("nine nine two one three");
    expect(spoken).toContain("ninety nine two thirteen");
    // an ICD-10 with its decimal, a modifier, a HCPCS letter code
    expect(expects.some((e) => e !== null && e.includes("."))).toBe(true);
    expect(expects.some((e) => e !== null && e.startsWith("-"))).toBe(true);
    expect(expects.some((e) => e !== null && /^[A-Z]\d{4}$/.test(e))).toBe(true);
    // a bare quantity and a year, both of which must be nothing
    expect(SPOKEN_CODE_CASES.find((c) => c.spoken === "five units")?.expect).toBeNull();
    expect(SPOKEN_CODE_CASES.find((c) => c.spoken === "twenty twenty four")?.expect).toBeNull();
  });

  it("has a distinct utterance and a stated reason for every case", () => {
    expect(new Set(SPOKEN_CODE_CASES.map((c) => c.spoken)).size).toBe(SPOKEN_CODE_CASES.length);
    for (const c of SPOKEN_CODE_CASES) {
      expect(c.why.length, c.spoken).toBeGreaterThan(30);
    }
  });

  it("runs against a synthetic universe and hears what the cases say", () => {
    const run = runSpokenCodeCases(syntheticUniverse());
    const failures = run.results.filter((r) => !r.pass);
    // Printed rather than merely counted: if this ever goes red, the message is
    // the finding, and the fix is in the parser and not in the case.
    expect(
      failures.map((f) => `"${f.case.spoken}" heard as ${String(f.got)}, wanted ${String(f.case.expect)}`),
    ).toEqual([]);
    expect(run.accuracy).toBe(1);
    expect(run.falsePositives).toBe(0);
  });

  it("scores the parser alone when no universe is supplied", () => {
    // The universe can only correct a near miss or refuse an ambiguity, so with
    // these cases the two runs must agree. If they ever diverge, one of the
    // expectations is a code that does not exist in its own universe.
    const withUniverse = runSpokenCodeCases(syntheticUniverse());
    const parserOnly = runSpokenCodeCases();
    expect(parserOnly.accuracy).toBe(withUniverse.accuracy);
    expect(parserOnly.falsePositives).toBe(withUniverse.falsePositives);
  });

  it("treats a missing decimal point as the same answer", () => {
    // snap.ts already does: CMS's own order file omits the point and every coder
    // types it, so scoring it would measure a spelling convention.
    const run = runSpokenCodeCases(undefined, [
      { spoken: "E eleven six five", expect: "E11.65", why: "The point is punctuation; the code is the same code either way." },
    ]);
    expect(run.results[0].got).toBe("E1165");
    expect(run.results[0].pass).toBe(true);
  });

  it("counts a false positive separately from accuracy", () => {
    const synthetic: SpokenCodeCase[] = [
      { spoken: "nine nine two one three", expect: "99213", why: "A dictated code that must be heard." },
      { spoken: "the claim was denied", expect: null, why: "Prose, which must produce no code at all." },
      { spoken: "five units", expect: "99213", why: "A deliberate miss: the harness must score this as a failure." },
      { spoken: "ninety nine two thirteen", expect: null, why: "A deliberate false positive: a code returned where none was wanted." },
    ];
    const run = runSpokenCodeCases(undefined, synthetic);

    expect(run.results.map((r) => r.pass)).toEqual([true, true, false, false]);
    // Accuracy is passes over ALL cases: two of four.
    expect(run.accuracy).toBe(0.5);
    expect(run.falsePositives).toBe(1);

    // The load-bearing assertion. If false positives were folded into accuracy —
    // excluded from it, or subtracted out of it — this would read 0.75, and a
    // parser could trade a fabricated code for a recovered one and come out
    // ahead. They are two numbers because they are two different failures.
    expect(run.accuracy).not.toBe(0.75);
    expect(run.accuracy).not.toBe((synthetic.length - run.falsePositives) / synthetic.length);

    // And a plain miss is not a false positive: nothing was invented.
    expect(run.results[2].got).toBeNull();
  });

  it("refuses rather than guesses when two real codes are equally close", () => {
    // "99213" is not installed here, and 99214 and 99215 are both one edit away.
    // Production asks; the harness scores that as no code, not as either of them.
    const universe: CodeUniverse = {
      cpt: new Set(["99214", "99215"]),
      hcpcs: new Set(),
      icd10: new Set(),
    };
    const run = runSpokenCodeCases(universe, [
      { spoken: "nine nine two one three", expect: "99213", why: "Ambiguity must not be resolved by picking one." },
    ]);
    expect(run.results[0].got).toBeNull();
  });
});

// ── Family 3 ─────────────────────────────────────────────────────────────────

describe("pronunciation cases", () => {
  it("every case passes against the real toSpeakable", () => {
    const run = runPronunciationCases();
    const failures = run.results.filter((r) => !r.pass);
    // Rendered as text so a red line names the case, what was said, and what was
    // missing or forbidden. A failure here is a real finding about the speech
    // renderer — the case is what a listener needs, and weakening it to go green
    // would delete the finding and keep the bug.
    expect(
      failures.map(
        (f) =>
          `${JSON.stringify(f.case.markdown)} said ${JSON.stringify(f.spoken)}` +
          (f.missing.length ? ` | missing: ${f.missing.join(", ")}` : "") +
          (f.forbidden.length ? ` | forbidden: ${f.forbidden.join(", ")}` : ""),
      ),
    ).toEqual([]);
    expect(run.passed).toBe(PRONUNCIATION_CASES.length);
  });

  it("covers the four things a listener cannot recover from", () => {
    const all = PRONUNCIATION_CASES;
    // A CPT code spoken as a number.
    expect(all.some((c) => c.markdown.includes("99213") && c.mustNotSay.includes("thousand"))).toBe(true);
    // A table read cell by cell.
    expect(all.some((c) => c.markdown.includes("|") && c.mustNotSay.includes("|"))).toBe(true);
    // A URL spelled out.
    expect(all.some((c) => c.markdown.includes("https://") && c.mustNotSay.includes("http"))).toBe(true);
    // Money and dates.
    expect(all.some((c) => c.markdown.includes("$"))).toBe(true);
    expect(all.some((c) => /\d{4}-\d{2}-\d{2}/.test(c.markdown))).toBe(true);
    for (const c of all) expect(c.why.length, c.markdown).toBeGreaterThan(30);
  });

  it("reports which assertion failed, not just that one did", () => {
    const run = runPronunciationCases([
      {
        markdown: "Bill 99213 for that visit.",
        mustSay: ["ninety nine thousand"],
        mustNotSay: ["nine nine two one three"],
        why: "A deliberately inverted case, so the harness's own reporting is under test.",
      },
    ]);
    expect(run.passed).toBe(0);
    expect(run.results[0].missing).toEqual(["ninety nine thousand"]);
    expect(run.results[0].forbidden).toEqual(["nine nine two one three"]);
    expect(run.results[0].spoken).toContain("nine nine two one three");
  });
});

// ── Family 2 ─────────────────────────────────────────────────────────────────

describe("spoken tool cases", () => {
  it("sends exactly what the voice pipeline would send", () => {
    // refineTranscript step 2 is normalizeSpokenCodes, so this is the text the
    // agent sees for a spoken turn. Both sides are written out literally in the
    // case file rather than computed, so a change in the normalizer fails HERE,
    // on visible data, instead of silently rewriting what is under test.
    for (const c of SPOKEN_TOOL_CASES) {
      expect(normalizeSpokenCodes(c.spoken), c.id).toBe(c.prompt);
    }
  });

  it("can be compared against the typed suite case for case", () => {
    const typed = new Set(CASES.map((c) => c.id));
    const linked = SPOKEN_TOOL_CASES.filter((c) => c.typedId);
    expect(linked.length).toBeGreaterThanOrEqual(1);
    for (const c of linked) {
      expect(typed.has(c.typedId!), `${c.id} claims a typed twin "${c.typedId}" that is not in CASES`).toBe(true);
      // The twin has to expect the same tools, or "typed passed, spoken failed"
      // would be a difference in the expectation rather than in the model.
      const twin = CASES.find((t) => t.id === c.typedId)!;
      expect(new Set(c.expect), c.id).toEqual(new Set(twin.expect));
    }
  });

  it("includes shapes that only exist in speech", () => {
    // Self-correction has no typed equivalent, because a typist backspaces.
    expect(SPOKEN_TOOL_CASES.some((c) => /no wait|i mean/.test(c.spoken))).toBe(true);
    // No punctuation and no capitals: the recognizer does not emit them.
    for (const c of SPOKEN_TOOL_CASES) {
      expect(c.spoken, c.id).not.toMatch(/[?!]/);
    }
  });

  it("names only tools that actually exist", () => {
    // A case expecting a tool that was never built can never pass, and would
    // look like a model failure forever.
    const config = loadConfig();
    const names = new Set(buildRegistry(config, null as never).specs().map((s) => s.name));
    for (const c of SPOKEN_TOOL_CASES) {
      for (const want of c.expect) {
        expect(names.has(want), `${c.id} expects "${want}", which is not a registered tool`).toBe(true);
      }
    }
  });

  it("has unique ids and a stated reason for every case", () => {
    expect(new Set(SPOKEN_TOOL_CASES.map((c) => c.id)).size).toBe(SPOKEN_TOOL_CASES.length);
    for (const c of SPOKEN_TOOL_CASES) {
      expect(c.why.length, c.id).toBeGreaterThan(30);
      expect(c.spoken.length, c.id).toBeGreaterThan(10);
    }
  });
});

// ── Reporting ────────────────────────────────────────────────────────────────

describe("renderVoiceReport", () => {
  const toolCase = SPOKEN_TOOL_CASES.find((c) => c.id === "spoken-prior-auth")!;

  const toolResult = (passed: boolean, reached: string[]): CaseResult => ({
    case: toolCase,
    reached,
    passed,
    ms: 1,
  });

  function report(): VoiceEvalReport {
    const codes = runSpokenCodeCases(undefined, [
      { spoken: "nine nine two one three", expect: "99213", why: "A dictated code that must be heard correctly." },
      { spoken: "J one eight eight five", expect: "J9999", why: "A deliberate miss, so a failing code line can be read." },
      { spoken: "ninety nine two thirteen", expect: null, why: "A deliberate false positive, so that line can be read too." },
    ]);
    const pronunciation = runPronunciationCases([
      {
        markdown: "Bill 99213 for that visit.",
        mustSay: ["ninety nine thousand"],
        mustNotSay: [],
        why: "A deliberately inverted pronunciation case for the report.",
      },
    ]);
    return {
      provider: "ollama",
      model: "gpt-oss:120b",
      codes,
      pronunciation,
      tools: { results: [toolResult(false, ["read_file"])], cases: [toolCase], passed: 0, total: 1 },
    };
  }

  it("prints every family per case, not one blended number", () => {
    const text = renderVoiceReport(report());

    // Codes: the utterance, what was heard, what was wanted, and the reason.
    expect(text).toMatch(/FAIL {2}"J one eight eight five"/);
    expect(text).toMatch(/heard: {2}J1885/);
    expect(text).toMatch(/wanted: J9999/);
    expect(text).toMatch(/deliberate miss/);

    // A false positive is labelled as one, and counted apart from accuracy.
    expect(text).toMatch(/FALSE POSITIVE {2}"ninety nine two thirteen"/);
    expect(text).toMatch(/1 false positive\(s\)/);
    expect(text).toMatch(/different and worse failure than missing one/);

    // Pronunciation: what was actually said, so a failure can be read.
    expect(text).toMatch(/SPOKEN REPLIES {2}0\/1/);
    expect(text).toMatch(/missing: {3}ninety nine thousand/);
    expect(text).toMatch(/nine nine two one three/);

    // Tools: the utterance AND the normalized text that was sent, because the
    // difference between them is a failure mode of its own.
    expect(text).toMatch(/FAIL {2}spoken-prior-auth/);
    expect(text).toMatch(/said: {4}"do we need a prior auth for two seven four four seven under this plan"/);
    expect(text).toMatch(/sent: {4}"do we need a prior auth for 27447 under this plan"/);
    expect(text).toMatch(/reached: read_file/);
    expect(text).toMatch(/typed twin: prior-auth/);

    // And the standing instruction, which is the point of the whole exercise.
    expect(text).toMatch(/tuning the cases to pass measures nothing/);
  });

  it("says so plainly when everything passed", () => {
    const clean: VoiceEvalReport = {
      provider: "anthropic",
      model: "claude",
      codes: runSpokenCodeCases(undefined, [
        { spoken: "nine nine two one three", expect: "99213", why: "One passing code case for the clean report." },
      ]),
      pronunciation: runPronunciationCases([
        {
          markdown: "Bill 99213 for that visit.",
          mustSay: ["nine nine two one three"],
          mustNotSay: ["thousand"],
          why: "One passing pronunciation case for the clean report.",
        },
      ]),
      tools: { results: [toolResult(true, ["pa_requirement_check"])], cases: [toolCase], passed: 1, total: 1 },
    };
    const text = renderVoiceReport(clean);
    expect(text).not.toMatch(/FAIL/);
    expect(text).toMatch(/3\/3 across all three families/);
    expect(text).toMatch(/Nothing was invented/);
  });
});
