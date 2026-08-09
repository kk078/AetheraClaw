import { describe, expect, it } from "vitest";
import {
  AI_IDENTIFICATION,
  ALL_PARTY_STATES,
  CONTESTED_STATES,
  callVerdict,
  consentRule,
  recordingVerdict,
  renderConsent,
} from "../src/voice/consent.js";
import {
  MIN_MATCH_SCORE,
  STALE_AFTER_MISSES,
  checkDtmf,
  chooseOption,
  normalize,
  phraseScore,
  recordOutcome,
  renderMap,
  type IvrMap,
} from "../src/voice/ivr.js";
import {
  ABANDON_AFTER_MS,
  classifyCall,
  renderState,
  repeatedPhrases,
  summarizeHold,
  type Segment,
} from "../src/voice/call-state.js";
import { extractOutcome, findDisposition, findReference, findRepresentative, renderOutcome } from "../src/voice/extract.js";
import {
  DEMO_TREE,
  SimulatorProvider,
  buildTwilioDial,
  describeTwilioRequest,
  type TwilioRequest,
} from "../src/voice/provider.js";

// ── Recording consent ────────────────────────────────────────────────────────

describe("consent rules", () => {
  it("knows the settled all-party states", () => {
    for (const state of ["CA", "CT", "DE", "FL", "IL", "MD", "MA", "MT", "NH", "OR", "PA", "WA"]) {
      expect(consentRule(state)).toBe("all_party");
    }
    expect(ALL_PARTY_STATES).toHaveLength(12);
  });

  it("treats the contested states as all-party rather than the convenient way", () => {
    // Michigan and Nevada read one way in statute and the other in their courts.
    // "We relied on the more convenient reading" is not a defence.
    expect(CONTESTED_STATES.sort()).toEqual(["MI", "NV"]);
    for (const state of CONTESTED_STATES) {
      expect(recordingVerdict("TX", state, true).requiresAllPartyConsent).toBe(true);
    }
  });

  it("defaults an unlisted state to one-party, matching federal law", () => {
    expect(consentRule("TX")).toBe("one_party");
    expect(consentRule("zz")).toBe("one_party");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(consentRule(" ca ")).toBe("all_party");
  });
});

describe("recordingVerdict", () => {
  it("takes the stricter of the two states on an interstate call", () => {
    // Which state's law governs a call crossing a line has been decided both
    // ways, so the only posture safe in every forum is the stricter end.
    const outbound = recordingVerdict("TX", "CA", true);
    expect(outbound.requiresAllPartyConsent).toBe(true);
    expect(outbound.governingState).toBe("CA");

    const inbound = recordingVerdict("CA", "TX", true);
    expect(inbound.requiresAllPartyConsent).toBe(true);
    expect(inbound.governingState).toBe("CA");
  });

  it("allows one-party recording when neither end is strict", () => {
    const v = recordingVerdict("TX", "NY", true);
    expect(v.allowed).toBe(true);
    expect(v.requiresAllPartyConsent).toBe(false);
  });

  it("refuses to record when either end is unknown", () => {
    // Guessing on a wiretap statute is not a risk worth taking for a claim
    // status call.
    expect(recordingVerdict("", "CA", true).allowed).toBe(false);
    expect(recordingVerdict("TX", "", true).allowed).toBe(false);
    expect(recordingVerdict("TX", "", true).reason).toContain("cannot be worked out");
  });

  it("returns no disclosure when recording was not asked for", () => {
    const v = recordingVerdict("CA", "CA", false);
    expect(v.allowed).toBe(false);
    expect(v.disclosure).toBe("");
  });

  it("always supplies words to say when recording is on", () => {
    for (const [from, to] of [["TX", "NY"], ["TX", "CA"], ["CA", "MA"]]) {
      const v = recordingVerdict(from, to, true);
      expect(v.disclosure.length).toBeGreaterThan(20);
      expect(v.disclosure).toContain("consent");
    }
  });
});

describe("callVerdict", () => {
  it("refuses to call patients and says why", () => {
    // An AI voice is an "artificial voice" under the TCPA per the FCC's
    // February 2024 declaratory ruling.
    const v = callVerdict("patient");
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("TCPA");
    expect(v.reason).toContain("prior express consent");
    expect(v.reason).toContain("patient_letter_draft");
  });

  it("refuses when the kind of line is unknown", () => {
    expect(callVerdict("unknown").allowed).toBe(false);
  });

  it("allows business lines and always identifies the caller as automated", () => {
    for (const target of ["payer", "clearinghouse", "provider_office"] as const) {
      const v = callVerdict(target);
      expect(v.allowed).toBe(true);
      expect(v.identification).toBe(AI_IDENTIFICATION);
      expect(v.identification.toLowerCase()).toContain("automated");
    }
  });
});

describe("renderConsent", () => {
  it("leads with the refusal and says nothing else when a call is not allowed", () => {
    const text = renderConsent(recordingVerdict("TX", "TX", false), callVerdict("patient"));
    expect(text).toContain("Call refused");
    expect(text).not.toContain("Opening line");
  });

  it("says recording stops if the representative declines", () => {
    const text = renderConsent(recordingVerdict("TX", "CA", true), callVerdict("payer"));
    expect(text).toContain("ONLY with the representative's agreement");
    expect(text).toContain("recording stops");
  });
});

// ── IVR navigation ───────────────────────────────────────────────────────────

function map(over: Partial<IvrMap> = {}): IvrMap {
  return {
    payer: "Demo",
    level: "main menu",
    options: [
      { digit: "1", intent: "eligibility", phrases: ["eligibility and benefits", "eligibility"] },
      { digit: "2", intent: "claim status", phrases: ["claim status", "status of a claim"] },
      { digit: "3", intent: "prior authorization", phrases: ["prior authorization"] },
      { digit: "0", intent: "operator", phrases: ["speak with a representative", "representative"] },
    ],
    lastConfirmedAt: 1_700_000_000_000,
    misses: 0,
    ...over,
  };
}

const PROMPT =
  "For eligibility and benefits, press 1. For claim status, press 2. For prior authorization, press 3. To speak with a representative, press 0.";

describe("phraseScore", () => {
  it("requires every word of the phrase, not just one", () => {
    // Substring matching would let "status" alone match claim status,
    // enrollment status and authorization status equally — which is exactly
    // how a call ends up in the wrong department.
    expect(phraseScore("claim status", "for claim status press 2")).toBe(1);
    expect(phraseScore("claim status", "for enrollment status press 4")).toBe(0.5);
  });

  it("ignores punctuation and case", () => {
    expect(phraseScore("Claim Status", "FOR CLAIM STATUS, PRESS 2.")).toBe(1);
  });

  it("scores an empty phrase at zero rather than dividing by zero", () => {
    expect(phraseScore("", "anything")).toBe(0);
    expect(normalize("  Hello,  World! ")).toBe("hello world");
  });
});

describe("chooseOption", () => {
  it("picks the option matching the asked-for intent", () => {
    const d = chooseOption("For claim status press 2", map(), "claim status");
    expect(d.choice?.digit).toBe("2");
  });

  it("refuses rather than guessing when nothing matches", () => {
    // A wrong digit does not fail — it succeeds into the wrong queue.
    const d = chooseOption("Please enter your date of birth followed by the pound key", map());
    expect(d.choice).toBeNull();
    expect(d.advice).toContain("Do not guess");
    expect(d.advice).toContain("0");
  });

  it("refuses to pick from a whole menu when no intent was given", () => {
    // A real IVR reads every option in one breath, so the prompt contains all of
    // them. Choosing one unprompted is guessing at the reason for the call.
    const d = chooseOption(PROMPT, map());
    expect(d.choice).toBeNull();
    expect(d.advice).toContain("Say which one is wanted");
    expect(d.alternatives.length).toBeGreaterThan(1);
  });

  it("refuses when two mapped options both answer to the intent", () => {
    const ambiguous = map({
      options: [
        { digit: "1", intent: "claim status", phrases: ["claim status"] },
        { digit: "2", intent: "claim status inquiry", phrases: ["claim status inquiry"] },
      ],
    });
    const d = chooseOption("for claim status press 1, for claim status inquiry press 2", ambiguous, "claim status");
    expect(d.choice).toBeNull();
    expect(d.advice).toContain("coin flip");
  });

  it("refuses when the map knows no such intent", () => {
    const d = chooseOption(PROMPT, map(), "pharmacy benefits");
    expect(d.choice).toBeNull();
    expect(d.advice).toContain("no option for");
    expect(d.advice).toContain("nearest-sounding");
  });

  it("refuses when the menu no longer offers what the map says it does", () => {
    // The map is not stale yet — it just stopped matching. Pressing the digit
    // that used to be right is the expensive mistake.
    const d = chooseOption("For eligibility, press 1. For pharmacy, press 4.", map(), "claim status");
    expect(d.choice).toBeNull();
    expect(d.advice).toContain("tree has probably changed");
  });

  it("takes the single mapped option a submenu offers, with no intent needed", () => {
    const submenu = map({ options: [{ digit: "1", intent: "claim status", phrases: ["status of a submitted claim"] }] });
    const d = chooseOption("For the status of a submitted claim, press 1.", submenu);
    expect(d.choice?.digit).toBe("1");
  });

  it("refuses outright once the map has gone stale", () => {
    const d = chooseOption(PROMPT, map({ misses: STALE_AFTER_MISSES }), "claim status");
    expect(d.stale).toBe(true);
    expect(d.choice).toBeNull();
    expect(d.advice).toContain("changed");
  });

  it("reports the runners-up so a near miss is visible", () => {
    const d = chooseOption("please enter your member identification number", map());
    expect(d.alternatives.length).toBeGreaterThan(0);
  });

  it("holds the minimum score where a half-match cannot pass", () => {
    expect(MIN_MATCH_SCORE).toBe(0.5);
    // "eligibility and benefits" with only "benefits" heard is 1/3.
    const d = chooseOption("for benefits press 1", map({ options: [map().options[0]] }));
    expect(d.choice).toBeNull();
  });
});

describe("promptMatched", () => {
  // A miss is evidence the payer's TREE changed. A refusal because the caller
  // did not say what they wanted is not — and counting it as one marked a
  // perfectly good map stale after two ordinary calls.
  it("is true for refusals that say nothing about the menu", () => {
    expect(chooseOption(PROMPT, map()).promptMatched).toBe(true);
    expect(chooseOption(PROMPT, map(), "pharmacy benefits").promptMatched).toBe(true);
    expect(chooseOption(PROMPT, map({ misses: STALE_AFTER_MISSES }), "claim status").promptMatched).toBe(true);
  });

  it("is false only when the menu itself stopped matching", () => {
    expect(chooseOption("For pharmacy, press 4.", map(), "claim status").promptMatched).toBe(false);
    expect(chooseOption("Please enter your date of birth.", map()).promptMatched).toBe(false);
  });

  it("is true on a successful navigation", () => {
    expect(chooseOption(PROMPT, map(), "claim status").promptMatched).toBe(true);
  });

  it("does not age a map toward stale across ordinary refusals", () => {
    let m = map();
    for (let i = 0; i < 5; i++) {
      m = recordOutcome(m, chooseOption(PROMPT, m).promptMatched, i);
    }
    expect(m.misses).toBe(0);
    expect(chooseOption(PROMPT, m, "claim status").choice?.digit).toBe("2");
  });
});

describe("recordOutcome", () => {
  it("counts consecutive misses and clears them on a match", () => {
    let m = map();
    m = recordOutcome(m, false, 1);
    m = recordOutcome(m, false, 2);
    expect(m.misses).toBe(2);
    m = recordOutcome(m, true, 3);
    expect(m.misses).toBe(0);
    expect(m.lastConfirmedAt).toBe(3);
  });
});

describe("checkDtmf", () => {
  it("allows a single menu key", () => {
    for (const d of ["0", "5", "9", "*", "#"]) expect(checkDtmf("menu_digit", d).allowed).toBe(true);
  });

  it("rejects a multi-digit string as a menu key", () => {
    expect(checkDtmf("menu_digit", "12").allowed).toBe(false);
  });

  it("refuses to let identifiers be typed from a chat turn", () => {
    // A model-produced member ID can be plausible and belong to somebody else,
    // and an IVR accepts it without comment.
    for (const field of ["member_id", "claim_number", "npi", "tax_id", "date_of_birth"] as const) {
      const v = checkDtmf(field, "123456789");
      expect(v.allowed).toBe(false);
      expect(v.reason).toContain("belong to somebody else");
    }
  });
});

describe("renderMap", () => {
  it("marks a stale map", () => {
    expect(renderMap(map({ misses: STALE_AFTER_MISSES }))).toContain("STALE");
    expect(renderMap(map())).not.toContain("STALE");
  });

  it("says when a map has never been confirmed", () => {
    expect(renderMap(map({ lastConfirmedAt: 0 }))).toContain("never confirmed");
  });
});

// ── Call state ───────────────────────────────────────────────────────────────

const seg = (atMs: number, text: string, music = false): Segment => ({ atMs, text, music });

describe("classifyCall", () => {
  it("reports dialing before anything is heard", () => {
    expect(classifyCall([]).state).toBe("dialing");
  });

  it("recognizes a menu", () => {
    const v = classifyCall([seg(1000, "Please listen carefully as our menu options have changed. For claim status, press 2.")]);
    expect(v.state).toBe("ivr");
  });

  it("recognizes hold from its phrases", () => {
    expect(classifyCall([seg(1000, "All of our representatives are assisting other callers.")]).state).toBe("hold");
  });

  it("tells hold from a person by repetition", () => {
    // The signal that actually separates them: a hold loop says the same
    // sentence in the same words, and a person does not.
    const looped = [
      seg(1000, "We appreciate you holding. A specialist will be with you shortly."),
      seg(60_000, "", true),
      seg(120_000, "We appreciate you holding. A specialist will be with you shortly."),
    ];
    const v = classifyCall(looped);
    expect(v.state).toBe("hold");
    expect(v.reason).toContain("more than once");
    expect(repeatedPhrases(looped)).toHaveLength(1);
  });

  it("recognizes a person and says to speak", () => {
    const v = classifyCall([seg(1000, "Provider services, my name is Dana. How can I help?")]);
    expect(v.state).toBe("human");
    expect(v.shouldSpeak).toBe(true);
  });

  it("checks voicemail before a person, because a greeting sounds like one", () => {
    // "Thank you for calling, this is..." matches a human greeting too. The cost
    // is one-sided: talking to a mailbox discloses a claim to an unattended
    // recording nobody at the practice controls.
    const v = classifyCall([seg(1000, "Thank you for calling. This is the claims desk. Please leave a message after the tone.")]);
    expect(v.state).toBe("voicemail");
    expect(v.shouldSpeak).toBe(false);
    expect(v.reason).toContain("Do not leave claim details");
  });

  it("treats music as hold", () => {
    expect(classifyCall([seg(1000, "", true)]).state).toBe("hold");
  });

  it("guesses a person for unrecognized speech but says it is a guess", () => {
    const v = classifyCall([seg(1000, "Okay, and what was that claim number again?")]);
    expect(v.state).toBe("human");
    expect(v.confidence).toBe("low");
    expect(v.reason).toContain("Ask who is on the line");
  });

  it("does not let an old voicemail phrase override a live conversation", () => {
    const v = classifyCall([
      seg(1000, "Please leave a message after the tone."),
      seg(20_000, "Sorry about that, my name is Dana."),
      seg(30_000, "What is the claim number?"),
      seg(40_000, "Okay, one moment."),
    ]);
    expect(v.state).toBe("human");
  });
});

describe("summarizeHold", () => {
  it("measures from the first thing heard", () => {
    const s = summarizeHold([seg(5000, "hello")], 5000 + 10 * 60_000);
    expect(Math.round(s.totalMs / 60_000)).toBe(10);
    expect(s.worthAbandoning).toBe(false);
  });

  it("flags a wait long enough to be worth abandoning", () => {
    const s = summarizeHold([seg(0, "hold please")], ABANDON_AFTER_MS + 1000);
    expect(s.worthAbandoning).toBe(true);
    expect(renderState(classifyCall([seg(0, "please continue to hold")]), s)).toContain("proves nothing");
  });

  it("reports nothing for an empty call", () => {
    expect(summarizeHold([], 100).totalMs).toBe(0);
  });
});

// ── Outcome extraction ───────────────────────────────────────────────────────

const CALL = `
US: This call is placed by an automated assistant on behalf of the practice.
THEM: Provider services, my name is Dana. Can I get your NPI?
US: What is the status of claim 20260314001?
THEM: That claim was denied on 03/14/2026 for missing prior authorization. The billed amount was $1,240.00.
THEM: I will send it back for reprocessing. Please allow 30 business days.
US: Can I have the call reference number?
THEM: Certainly. Your call reference number is REF-8842197.
`;

describe("extractOutcome", () => {
  it("finds the reference number, which is the point of the call", () => {
    expect(findReference(CALL)).toBe("REF-8842197");
    expect(extractOutcome(CALL).referenceNumber).toBe("REF-8842197");
  });

  it("finds the representative", () => {
    expect(findRepresentative(CALL)).toBe("Dana");
  });

  it("reads the disposition", () => {
    expect(findDisposition(CALL)).toBe("denied");
    expect(findDisposition("The claim is still processing.")).toBe("in_process");
    expect(findDisposition("We have no record of that claim.")).toBe("not_on_file");
    expect(findDisposition("It was paid on the fourteenth, check was issued.")).toBe("paid");
  });

  it("returns unresolved rather than guessing a status", () => {
    expect(findDisposition("Let me look into that for you.")).toBe("unresolved");
  });

  it("captures what they committed to", () => {
    const o = extractOutcome(CALL);
    expect(o.commitments.join(" ")).toContain("reprocessing");
    expect(o.commitments.join(" ")).toContain("30 business days");
  });

  it("pulls out amounts, dates and claim numbers", () => {
    const o = extractOutcome(CALL);
    expect(o.amounts).toContain(1240);
    expect(o.dates).toContain("03/14/2026");
    expect(o.claimNumbers).toContain("20260314001");
  });

  it("shouts when no reference number was given", () => {
    // The single most important failure this module catches: a call with no
    // reference is a call that cannot be proved happened.
    const o = extractOutcome("THEM: My name is Dana. The claim was denied.");
    expect(o.referenceNumber).toBe("");
    expect(o.gaps[0]).toContain("NO CALL REFERENCE NUMBER");
    expect(renderOutcome(o)).toContain("NONE CAPTURED");
  });

  it("says when nobody committed to anything", () => {
    const o = extractOutcome("THEM: My name is Dana. Reference number is ABC123456. The claim was denied.");
    expect(o.gaps.join(" ")).toContain("Nobody committed");
  });

  it("does not ask for a commitment on a paid claim", () => {
    const o = extractOutcome("THEM: Reference number ABC123456. That claim has been paid, check was issued 03/01/2026.");
    expect(o.gaps.join(" ")).not.toContain("Nobody committed");
  });

  it("notices identifier-shaped text in the transcript", () => {
    const o = extractOutcome("THEM: The member is 1EG4-TE5-MK73, reference number ABC123456.");
    expect(o.phi.length).toBeGreaterThan(0);
    expect(renderOutcome(o)).toContain("not approved for real patient data");
  });

  it("handles an empty transcript without throwing", () => {
    const o = extractOutcome("");
    expect(o.disposition).toBe("unresolved");
    expect(o.gaps.length).toBeGreaterThan(0);
  });
});

// ── Simulator ────────────────────────────────────────────────────────────────

describe("SimulatorProvider", () => {
  it("plays the menu on connect", async () => {
    const sim = new SimulatorProvider();
    const { callId } = await sim.dial({ to: "+18005551234", from: "+15125550100", callerState: "TX", calleeState: "TX", record: false });
    const heard = await sim.listen(callId);
    expect(heard[0].text).toContain("menu options have changed");
    expect(classifyCall(heard).state).toBe("ivr");
  });

  it("navigates to the claims submenu and then to a queue", async () => {
    const sim = new SimulatorProvider();
    const { callId } = await sim.dial({ to: "+1", from: "+1", callerState: "TX", calleeState: "TX", record: false });
    await sim.listen(callId);
    await sim.press(callId, "2");
    expect((await sim.listen(callId))[0].text).toContain("claim status");
    await sim.press(callId, "1");
    const queue = await sim.listen(callId);
    expect(queue.some((s) => s.text.includes("next available representative"))).toBe(true);
  });

  it("produces a hold loop that repeats itself", async () => {
    const sim = new SimulatorProvider();
    const { callId } = await sim.dial({ to: "+1", from: "+1", callerState: "TX", calleeState: "TX", record: false });
    await sim.listen(callId);
    await sim.press(callId, "0");
    const heard = await sim.listen(callId);
    expect(repeatedPhrases(heard).length).toBeGreaterThan(0);
  });

  it("reaches a representative who does not volunteer a reference number", async () => {
    const sim = new SimulatorProvider();
    const { callId } = await sim.dial({ to: "+1", from: "+1", callerState: "TX", calleeState: "TX", record: false });
    await sim.listen(callId);
    await sim.press(callId, "0");
    const heard = await sim.listen(callId);
    const transcript = heard.map((s) => s.text).join("\n");
    expect(transcript).toContain("my name is Dana");
    expect(extractOutcome(transcript).referenceNumber).toBe("");
  });

  it("gives a reference number when asked for one", async () => {
    const sim = new SimulatorProvider();
    const { callId } = await sim.dial({ to: "+1", from: "+1", callerState: "TX", calleeState: "TX", record: false });
    await sim.listen(callId);
    await sim.press(callId, "0");
    await sim.listen(callId);
    await sim.say(callId, "Can I have the call reference number please?");
    const heard = await sim.listen(callId);
    expect(extractOutcome(heard.map((s) => s.text).join("\n")).referenceNumber).toBe("REF-8842197");
  });

  it("rejects an invalid selection and replays the menu", async () => {
    const sim = new SimulatorProvider();
    const { callId } = await sim.dial({ to: "+1", from: "+1", callerState: "TX", calleeState: "TX", record: false });
    await sim.listen(callId);
    await sim.press(callId, "7");
    const heard = await sim.listen(callId);
    expect(heard[0].text).toContain("not a valid selection");
  });

  it("is deterministic — the same keys produce the same call", async () => {
    const run = async () => {
      const sim = new SimulatorProvider();
      const { callId } = await sim.dial({ to: "+1", from: "+1", callerState: "TX", calleeState: "TX", record: false });
      const all: string[] = [];
      all.push(...(await sim.listen(callId)).map((s) => s.text));
      await sim.press(callId, "2");
      all.push(...(await sim.listen(callId)).map((s) => s.text));
      return all;
    };
    expect(await run()).toEqual(await run());
  });

  it("navigates the demo tree with the map the tree itself describes", async () => {
    const demoMap: IvrMap = {
      payer: DEMO_TREE.payer,
      level: "main menu",
      options: [
        { digit: "1", intent: "eligibility", phrases: ["eligibility and benefits"] },
        { digit: "2", intent: "claim status", phrases: ["claim status"] },
        { digit: "0", intent: "operator", phrases: ["speak with a representative"] },
      ],
      lastConfirmedAt: 0,
      misses: 0,
    };
    const sim = new SimulatorProvider();
    const { callId } = await sim.dial({ to: "+1", from: "+1", callerState: "TX", calleeState: "TX", record: false });
    const prompt = (await sim.listen(callId))[0].text;
    const decision = chooseOption(prompt, demoMap, "claim status");
    expect(decision.choice?.digit).toBe("2");
  });
});

// ── Twilio request ───────────────────────────────────────────────────────────

const TWILIO = { accountSid: "AC123", authToken: "secret-token", webhookUrl: "https://example.test/twiml" };
const DIAL = { to: "+18005551234", from: "+15125550100", callerState: "TX", calleeState: "CA", record: false };

describe("buildTwilioDial", () => {
  it("refuses without credentials or a webhook", () => {
    expect(buildTwilioDial({ ...TWILIO, accountSid: "" }, DIAL)).toContain("credentials are not configured");
    expect(buildTwilioDial({ ...TWILIO, webhookUrl: "" }, DIAL)).toContain("webhook URL");
  });

  it("refuses a number that is not E.164", () => {
    expect(buildTwilioDial(TWILIO, { ...DIAL, to: "800-555-1234" })).toContain("E.164");
  });

  it("passes Record through explicitly rather than relying on a default", () => {
    // Twilio's default is off; a module that quietly turned it on would enable
    // a wiretap offence in twelve states.
    const off = buildTwilioDial(TWILIO, DIAL) as TwilioRequest;
    expect(new URLSearchParams(off.body).get("Record")).toBe("false");
    const on = buildTwilioDial(TWILIO, { ...DIAL, record: true }) as TwilioRequest;
    expect(new URLSearchParams(on.body).get("Record")).toBe("true");
  });

  it("asks Twilio to detect an answering machine", () => {
    const req = buildTwilioDial(TWILIO, DIAL) as TwilioRequest;
    expect(new URLSearchParams(req.body).get("MachineDetection")).toBe("DetectMessageEnd");
  });

  it("never prints the auth header", () => {
    const req = buildTwilioDial(TWILIO, DIAL) as TwilioRequest;
    expect(req.headers.Authorization).toContain("Basic ");
    const described = describeTwilioRequest(req);
    expect(described).not.toContain("secret-token");
    expect(described).not.toContain(req.headers.Authorization);
    expect(described).toContain("[not shown]");
  });
});
