import { describe, expect, it } from "vitest";
import { distance, matchWake, normalizeHeard, wordTolerance } from "../src/speech/wake.js";

const WAKE = "hey aethera";

describe("wake word matching", () => {
  it("matches the phrase exactly", () => {
    const m = matchWake("hey aethera", WAKE);
    expect(m.matched).toBe(true);
    expect(m.drift).toBe(0);
    expect(m.remainder).toBe("");
  });

  it("returns the request said in the same breath", () => {
    // Making someone say the wake word, wait, then speak is the difference
    // between a feature and a toy.
    const m = matchWake("Hey Aethera, scrub the claim.", WAKE);
    expect(m.matched).toBe(true);
    expect(m.remainder).toBe("scrub the claim");
  });

  it("tolerates the way a recognizer actually mangles a name", () => {
    // With no sentence around it to constrain the language model, a wake phrase
    // comes back mangled far more often than ordinary speech.
    for (const heard of ["hey ethera", "hey aetheria", "hey aethra"]) {
      expect(matchWake(heard, WAKE).matched, heard).toBe(true);
    }
  });

  it("does NOT fire on ordinary conversation", () => {
    // The failure that matters: a microphone opening itself during a
    // consultation because somebody used a similar word.
    for (const heard of ["they gathered the notes", "hen party", "the anaesthesia went well", "her aetiology is unclear"]) {
      expect(matchWake(heard, WAKE).matched, heard).toBe(false);
    }
  });

  it("is anchored to the start, so saying the name in passing does not trigger it", () => {
    expect(matchWake("I asked Aethera about that yesterday", WAKE).matched).toBe(false);
    expect(matchWake("so anyway hey aethera", WAKE).matched).toBe(false);
  });

  it("refuses a wake word too short to be matched safely", () => {
    // At any useful tolerance a one-syllable word collides with ordinary
    // speech; at zero tolerance it never fires. Neither is usable, so it says so.
    const m = matchWake("hey", "hey");
    expect(m.matched).toBe(false);
    expect(m.why).toMatch(/too short/);
  });

  it("says so when no wake word is configured rather than matching everything", () => {
    const m = matchWake("anything at all", "");
    expect(m.matched).toBe(false);
    expect(m.why).toMatch(/no wake word/);
  });

  it("does not match when the utterance is shorter than the phrase", () => {
    expect(matchWake("hey", WAKE).matched).toBe(false);
  });

  it("scales tolerance with word length", () => {
    // One wrong letter in "hey" is a different word; one wrong letter in
    // "aethera" is the same word misheard.
    expect(wordTolerance("hey")).toBe(0);
    expect(wordTolerance("aethera")).toBe(2);
    expect(matchWake("her aethera", WAKE).matched).toBe(false);
  });

  it("caps the total drift across the whole phrase", () => {
    // Every word inside its own tolerance can still add up to a phrase that is
    // not the wake word.
    const loose = matchWake("hey aethxxa", WAKE);
    expect(loose.matched).toBe(true);
    expect(matchWake("hey aethera", WAKE, { maxDrift: 0 }).matched).toBe(true);
    expect(matchWake("hey aethra", WAKE, { maxDrift: 0 }).matched).toBe(false);
  });

  it("normalizes punctuation and case", () => {
    expect(normalizeHeard("  Hey, AETHERA!! ")).toBe("hey aethera");
  });

  it("computes distance and bails out past the cap", () => {
    expect(distance("hey", "hey")).toBe(0);
    expect(distance("aethera", "aethra")).toBe(1);
    expect(distance("aethera", "completelydifferent", 4)).toBeGreaterThan(4);
  });

  it("supports a multi-word wake phrase", () => {
    const m = matchWake("ok claw assistant show me denials", "ok claw assistant");
    expect(m.matched).toBe(true);
    expect(m.remainder).toBe("show me denials");
  });
});
