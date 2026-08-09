import { describe, expect, it } from "vitest";
import {
  accessActionForEngine,
  accessEventForTranscript,
  describeGate,
  gateTranscript,
  transcriptWasDisclosed,
} from "../src/speech/transcript-gate.js";
import { NARRATION_VERBS, PLUMBING_TOOLS, narrateTool, shouldNarrate } from "../src/speech/narrate.js";
import { applySpokenAbbreviations } from "../src/speech/speakable.js";
import { DISCLOSING_ACTIONS, prepareAccessEntry } from "../src/tenancy/access-log.js";
import type { SpeechEngine } from "../src/speech/providers/types.js";

// The two identifiers a person actually reads out loud off a card. Both are
// synthetic: the MBI uses the restricted alphabet the real ones use, and the
// SSN is in the 123-45-6789 form every test data set uses precisely because it
// was never issued.
const SPOKEN_SSN = "123-45-6789";
const SPOKEN_MBI = "1EG4-TE5-MK73";
const WITH_IDENTIFIERS = `pull up the claim for member ${SPOKEN_MBI}, social ${SPOKEN_SSN}`;
const ORDINARY = "what is the status of the claim we sent to Aetna last Tuesday";

// ── The gate ─────────────────────────────────────────────────────────────────

describe("gateTranscript", () => {
  it("leaves an ordinary utterance completely alone", () => {
    // The common case has to be free, or the gate gets switched off.
    const d = gateTranscript(ORDINARY);
    expect(d.action).toBe("pass");
    expect(d.text).toBe(ORDINARY);
    expect(d.original).toBe(ORDINARY);
    expect(d.signals).toEqual([]);
    expect(d.loggable).toBe(false);
  });

  it("redacts a spoken SSN and MBI under the default policy", () => {
    const d = gateTranscript(WITH_IDENTIFIERS);
    expect(d.action).toBe("redact");
    expect(d.text).not.toContain(SPOKEN_SSN);
    expect(d.text).not.toContain(SPOKEN_MBI);
    expect(d.text).toContain("[REDACTED-SSN]");
    expect(d.text).toContain("[REDACTED-MBI]");
    // The question itself survives — a gate that destroys the request makes the
    // speaker say the whole thing again, identifier and all.
    expect(d.text).toContain("pull up the claim");
    expect(d.signals.map((s) => s.kind).sort()).toEqual(["mbi", "ssn"]);
    expect(d.loggable).toBe(true);
  });

  it("keeps the original for the caller to log and drop, never to send", () => {
    const d = gateTranscript(WITH_IDENTIFIERS);
    expect(d.original).toBe(WITH_IDENTIFIERS);
    expect(d.original).not.toBe(d.text);
  });

  it("refuses outright under the refuse policy, and says what to say instead", () => {
    const d = gateTranscript(WITH_IDENTIFIERS, { policy: "refuse" });
    expect(d.action).toBe("refuse");
    expect(d.text).toBe("");
    expect(d.why).toMatch(/claim number instead of the member ID/i);
    expect(d.signals.length).toBeGreaterThan(0);
    expect(d.loggable).toBe(true);
  });

  it("still reports signals when the gate is switched off", () => {
    const d = gateTranscript(WITH_IDENTIFIERS, { policy: "off" });
    expect(d.action).toBe("pass");
    expect(d.text).toBe(WITH_IDENTIFIERS);
    expect(d.signals.map((s) => s.kind).sort()).toEqual(["mbi", "ssn"]);
    // Off disables the action, not the eyes: the console can still warn and the
    // access is still recorded.
    expect(d.why).toMatch(/gate disabled/i);
    expect(d.loggable).toBe(true);
  });

  it("catches a labelled date of birth spoken in a sentence", () => {
    const d = gateTranscript("the DOB: 4/3/1951 on that account");
    expect(d.signals.map((s) => s.kind)).toContain("dob");
    expect(d.text).toContain("[REDACTED-DOB]");
  });
});

// ── The point of the whole thing: honest wording per engine ──────────────────

describe("gateTranscript engine honesty", () => {
  const engines: SpeechEngine[] = ["browser", "local", "cloud"];

  it("makes the same decision whatever the engine", () => {
    const actions = engines.map((engine) => gateTranscript(WITH_IDENTIFIERS, { engine }).action);
    expect(new Set(actions)).toEqual(new Set(["redact"]));
  });

  for (const engine of ["browser", "cloud"] as const) {
    it(`says the audio had already left under the ${engine} engine`, () => {
      const d = gateTranscript(WITH_IDENTIFIERS, { engine });
      // Recognition happened somewhere else, so the identifier was disclosed
      // before this code ran. Redacting the transcript does not undo that, and
      // the wording must not suggest it does.
      expect(d.why).toMatch(/already sent/i);
      expect(d.why).toMatch(/has been disclosed/i);
      expect(d.why).toMatch(/does not undo that/i);
      expect(d.why).not.toMatch(/did not leave/i);
      expect(transcriptWasDisclosed(engine)).toBe(true);
    });
  }

  it("says the identifier was actually stopped under the local engine", () => {
    const d = gateTranscript(WITH_IDENTIFIERS, { engine: "local" });
    expect(d.why).toMatch(/did not leave/i);
    expect(d.why).not.toMatch(/already sent/i);
    expect(transcriptWasDisclosed("local")).toBe(false);
  });

  it("defaults to the local wording only when no engine is named", () => {
    expect(gateTranscript(WITH_IDENTIFIERS).why).toMatch(/did not leave/i);
  });

  it("maps browser and cloud onto a disclosing access action", () => {
    expect(accessActionForEngine("local")).toBe("read");
    expect(accessActionForEngine("browser")).toBe("export");
    expect(accessActionForEngine("cloud")).toBe("export");
    expect(DISCLOSING_ACTIONS.has(accessActionForEngine("cloud"))).toBe(true);
    expect(DISCLOSING_ACTIONS.has(accessActionForEngine("local"))).toBe(false);
  });
});

// ── §164.312(b) event ────────────────────────────────────────────────────────

describe("accessEventForTranscript", () => {
  const ctx = { sessionId: "sess-7", actor: "biller@example.com", tenantSlug: "northside" };

  it("returns null when there was nothing to record", () => {
    const d = gateTranscript(ORDINARY);
    expect(accessEventForTranscript(d, ctx)).toBeNull();
  });

  it("builds an event the existing chain preparer accepts", () => {
    const d = gateTranscript(WITH_IDENTIFIERS, { engine: "local" });
    const event = accessEventForTranscript(d, { ...ctx, engine: "local", at: 1_700_000_000_000 });
    expect(event).not.toBeNull();
    expect(event).toMatchObject({
      action: "read",
      resourceType: "document",
      resourceRef: "voice-transcript:sess-7",
      actor: "biller@example.com",
      tenantSlug: "northside",
      recordCount: 1,
      at: 1_700_000_000_000,
    });

    const prepared = prepareAccessEntry(event!);
    expect(prepared.ok).toBe(true);
  });

  it("records a cloud transcript as a disclosure", () => {
    const d = gateTranscript(WITH_IDENTIFIERS, { engine: "cloud" });
    const event = accessEventForTranscript(d, { ...ctx, engine: "cloud" })!;
    expect(event.action).toBe("export");
    expect(DISCLOSING_ACTIONS.has(event.action)).toBe(true);
  });

  it("never carries the spoken identifier into the log entry", () => {
    // The whole reason the access log takes a reference and not content.
    const d = gateTranscript(WITH_IDENTIFIERS);
    const event = accessEventForTranscript(d, ctx)!;
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(SPOKEN_SSN);
    expect(serialized).not.toContain(SPOKEN_MBI);
  });

  it("drops the session id from the reference rather than logging an identifier-shaped one", () => {
    const d = gateTranscript(WITH_IDENTIFIERS);
    const event = accessEventForTranscript(d, { sessionId: "123456789AB", actor: "biller" })!;
    expect(event.resourceRef).toBe("voice-transcript");
    expect(prepareAccessEntry(event).ok).toBe(true);
  });

  it("records the access even when the gate itself is off", () => {
    const d = gateTranscript(WITH_IDENTIFIERS, { policy: "off" });
    expect(accessEventForTranscript(d, ctx)).not.toBeNull();
  });
});

describe("describeGate", () => {
  it("says nothing alarming about an ordinary utterance", () => {
    expect(describeGate(gateTranscript(ORDINARY))).toMatch(/^Transcript clear/);
  });

  it("names the kinds it redacted", () => {
    const line = describeGate(gateTranscript(WITH_IDENTIFIERS));
    expect(line).toMatch(/^Redacted/);
    expect(line).toContain("SSN");
    expect(line).toContain("MBI");
  });

  it("marks a refusal as blocked", () => {
    expect(describeGate(gateTranscript(WITH_IDENTIFIERS, { policy: "refuse" }))).toMatch(/^Blocked/);
  });

  it("is one line", () => {
    for (const policy of ["redact", "refuse", "off"] as const) {
      expect(describeGate(gateTranscript(WITH_IDENTIFIERS, { policy }))).not.toContain("\n");
    }
  });
});

// ── Narration ────────────────────────────────────────────────────────────────

describe("narrateTool", () => {
  it("announces every mapped prefix with its own verb", () => {
    for (const [prefix, verb] of Object.entries(NARRATION_VERBS)) {
      const clause = narrateTool(`${prefix}example`);
      expect(clause).toBe(applySpokenAbbreviations(verb));
      expect(clause).not.toContain("_");
    }
  });

  it("uses the family verb, not the individual tool's", () => {
    expect(narrateTool("claim_scrub")).toBe("checking the claim");
    expect(narrateTool("claim_autoheal")).toBe("checking the claim");
    expect(narrateTool("appeal_draft")).toBe("working the appeal");
    expect(narrateTool("worklist_prioritize")).toBe("working the worklist");
    expect(narrateTool("eligibility_check")).toBe("checking eligibility");
  });

  it("spells initialisms rather than letting the synthesiser guess", () => {
    // "npi" said as a word is "en-pie", "hcpcs" is "hick picks" and nothing
    // else, and an 835 is an eight thirty five.
    expect(narrateTool("npi_validate")).toBe("checking the N P I");
    expect(narrateTool("hcpcs_lookup")).toBe("looking up the hick picks code");
    expect(narrateTool("era_parse_835")).toBe("reading the remittance, eight thirty five");
    expect(narrateTool("claim_build_837p")).toBe("checking the claim, eight thirty seven P");
    expect(narrateTool("ncci_edit_lookup")).toContain("N C C I");
  });

  it("keeps only the domain detail worth hearing", () => {
    // "build" adds nothing the verb has not said; "837P" does.
    expect(narrateTool("claim_build_secondary")).toBe("checking the claim");
  });

  it("degrades honestly on a name it does not know", () => {
    expect(narrateTool("frobnicate_widget")).toBe("running frobnicate widget");
    expect(narrateTool("submit_something")).toMatch(/^running /);
    expect(narrateTool("")).toBe("working on it");
  });

  it("is always a present participle", () => {
    const names = [...Object.keys(NARRATION_VERBS).map((p) => `${p}example`), "frobnicate_widget"];
    for (const name of names) expect(narrateTool(name)).toMatch(/^[a-z]+ing\b|^looking up\b|^running\b|^working on it$/);
  });

  it("never reads an argument aloud", () => {
    // This goes to a speaker in a room. A tool input can carry a member ID, a
    // patient name, a date of birth — so the input is not consulted at all.
    const input = { memberId: SPOKEN_MBI, ssn: SPOKEN_SSN, patient: "Dolores Abernathy" };
    for (const name of ["claim_scrub", "era_parse_835", "frobnicate_widget", "portal_fill"]) {
      const clause = narrateTool(name, input);
      expect(clause).not.toContain(SPOKEN_SSN);
      expect(clause).not.toContain(SPOKEN_MBI);
      expect(clause).not.toContain("Abernathy");
      expect(clause).toBe(narrateTool(name));
    }
  });

  it("stays short enough to speak over the work", () => {
    for (const prefix of Object.keys(NARRATION_VERBS)) {
      expect(narrateTool(`${prefix}example`).length).toBeLessThanOrEqual(48);
    }
  });
});

describe("shouldNarrate", () => {
  it("says nothing about the tool-search machinery", () => {
    for (const name of PLUMBING_TOOLS) expect(shouldNarrate(name)).toBe(false);
  });

  it("narrates work the listener asked for", () => {
    expect(shouldNarrate("claim_scrub")).toBe(true);
    expect(shouldNarrate("era_parse_835")).toBe(true);
    expect(shouldNarrate("frobnicate_widget")).toBe(true);
  });

  it("can be asked for the plumbing anyway", () => {
    expect(shouldNarrate("tool_search", { plumbing: true })).toBe(true);
  });

  it("says nothing about a nameless call", () => {
    expect(shouldNarrate("")).toBe(false);
  });
});
