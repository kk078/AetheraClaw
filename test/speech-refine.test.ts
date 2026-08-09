import { describe, expect, it } from "vitest";
import { refineTranscript } from "../src/speech/refine.js";
import type { CodeUniverse } from "../src/speech/snap.js";

const universe = (cpt: string[] = [], hcpcs: string[] = [], icd10: string[] = []): CodeUniverse => ({
  cpt: new Set(cpt),
  hcpcs: new Set(hcpcs),
  icd10: new Set(icd10),
});

describe("transcript refinement", () => {
  it("passes ordinary speech through untouched", () => {
    const r = refineTranscript("what is a clearinghouse rejection", { universe: universe() });
    expect(r.text).toBe("what is a clearinghouse rejection");
    expect(r.blocked).toBe(false);
    expect(r.ask).toBeUndefined();
    expect(r.why).toBeUndefined();
  });

  it("turns a dictated code into a canonical one before anything validates it", () => {
    // The order matters: validation runs on "99213", not on the words. If
    // normalization ran after snapping there would be nothing code-shaped for
    // the validator to check and every dictated code would be unverified.
    const r = refineTranscript("scrub CPT nine nine two one three", { universe: universe(["99213"]) });
    expect(r.text).toContain("99213");
    expect(r.snaps.some((s) => s.result.status === "exact")).toBe(true);
  });

  it("gates an identifier BEFORE normalization can rewrite the digits it looks for", () => {
    // This is the ordering bug the pipeline exists to prevent. Normalizing
    // first can rewrite digit runs, and a rewritten SSN no longer matches the
    // pattern that would have caught it.
    const r = refineTranscript("the member's social is 123-45-6789", { universe: universe() });
    expect(r.text).not.toContain("123-45-6789");
    expect(r.gate.signals.some((s) => s.kind === "ssn")).toBe(true);
    expect(r.why).toBeTruthy();
  });

  it("blocks entirely under the refuse policy, and returns no text at all", () => {
    const r = refineTranscript("the member's social is 123-45-6789", { policy: "refuse", universe: universe() });
    expect(r.blocked).toBe(true);
    expect(r.text).toBe("");
    expect(r.why).toBeTruthy();
  });

  it("corrects a code that is one character from a real one, and says it did", () => {
    const r = refineTranscript("check 99214", { universe: universe(["99213"]) });
    expect(r.text).toContain("99213");
    expect(r.why).toBeTruthy();
    expect(r.ask).toBeUndefined();
  });

  it("ASKS rather than picking when a heard code is equally close to two real ones", () => {
    // The load-bearing rule. Silently choosing either one produces a claim that
    // is wrong in a way no reviewer can see; asking costs one round trip.
    const r = refineTranscript("check 99214", { universe: universe(["99213", "99215"]) });
    expect(r.ask).toBeTruthy();
    expect(r.blocked).toBe(false);
    // And the heard token survives verbatim — neither candidate was substituted.
    expect(r.text).toContain("99214");
  });

  it("leaves a code alone when it already exists", () => {
    const r = refineTranscript("check 99213", { universe: universe(["99213", "99214"]) });
    expect(r.text).toContain("99213");
    expect(r.why).toBeUndefined();
    expect(r.ask).toBeUndefined();
  });

  it("never snaps across code sets", () => {
    // A HCPCS candidate must not be able to come back as a CPT code, whatever
    // the edit distance says.
    const r = refineTranscript("check J1885", { universe: universe(["11885"], []) });
    expect(r.text).toContain("J1885");
    expect(r.snaps.every((s) => s.result.status !== "snapped")).toBe(true);
  });

  it("skips validation rather than failing when no code table is installed", () => {
    const r = refineTranscript("check 99214", {});
    expect(r.text).toContain("99214");
    expect(r.blocked).toBe(false);
    expect(r.snaps).toEqual([]);
  });

  it("does not treat an ordinary number as a code", () => {
    const r = refineTranscript("we billed 3 units on 2 claims", { universe: universe(["99213"]) });
    expect(r.text).toBe("we billed 3 units on 2 claims");
    expect(r.snaps).toEqual([]);
  });

  it("says the audio already left the machine when the engine sent it away", () => {
    // Redacting the transcript does not un-disclose audio that a vendor already
    // has. The wording has to be honest about that or the gate reads as
    // protection it cannot provide.
    const browser = refineTranscript("social 123-45-6789", { engine: "browser", universe: universe() });
    const local = refineTranscript("social 123-45-6789", { engine: "local", universe: universe() });
    expect(browser.why).toBeTruthy();
    expect(local.why).toBeTruthy();
    expect(browser.why).not.toBe(local.why);
  });

  it("handles several codes in one utterance independently", () => {
    const r = refineTranscript("compare 99214 and J1885", { universe: universe(["99213"], ["J1885"]) });
    expect(r.text).toContain("99213");
    expect(r.text).toContain("J1885");
    expect(r.snaps).toHaveLength(2);
  });

  it("returns an empty-but-safe result for empty input", () => {
    const r = refineTranscript("", { universe: universe(["99213"]) });
    expect(r.blocked).toBe(false);
    expect(r.text).toBe("");
  });
});
