import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_REQUIRED_TOOLS,
  AUTHORIZED_TTL_MS,
  CHALLENGE_TTL_MS,
  LOCKOUT_MS,
  MAX_ATTEMPTS,
  describeAuthState,
  initialAuthState,
  isAuthorized,
  issueChallenge,
  normalizeSpokenResponse,
  requiresAuthorization,
  verifyResponse,
  type AuthState,
} from "../src/speech/authorization.js";

const T0 = 1_700_000_000_000;

/** A deterministic rng: the four draws below become the digits 4, 2, 0, 9. */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

const fixedRng = () => seq([0.47, 0.21, 0.05, 0.93, 0.61, 0.38]);

/** State with a fresh digits challenge outstanding. Nonce is "4209". */
function withDigitsChallenge(now = T0): AuthState {
  return { ...initialAuthState(), challenge: issueChallenge("digits", now, fixedRng()) };
}

/** State with a fresh passphrase challenge outstanding. */
function withPassphraseChallenge(now = T0): AuthState {
  return { ...initialAuthState(), challenge: issueChallenge("passphrase", now, fixedRng()) };
}

describe("which actions need a spoken authorization", () => {
  it("does not ask for one on a plainly read-only tool", () => {
    expect(requiresAuthorization("safe", "icd10_search")).toBe(false);
    expect(requiresAuthorization("safe", "reference_lookup")).toBe(false);
    // Named like something dangerous, assessed safe, and it only reads: the
    // decision follows the risk level, not the scary-sounding name.
    expect(requiresAuthorization("safe", "claim_scrub")).toBe(false);
  });

  it("asks for one on anything the registry assessed above safe", () => {
    expect(requiresAuthorization("confirm", "write_file")).toBe(true);
    // A tool this module has never heard of. The gate is driven off the level,
    // so a tool added next month is covered the day it lands.
    expect(requiresAuthorization("confirm", "some_tool_added_next_month")).toBe(true);
  });

  it("asks for one on a submitting tool the registry assesses as safe", () => {
    // pa_submit defines no assessRisk, so the registry defaults it to "safe" —
    // and it files a prior authorization with the payer. The named set exists
    // for exactly this gap.
    expect(requiresAuthorization("safe", "pa_submit")).toBe(true);
    expect(AUTHORIZATION_REQUIRED_TOOLS.has("pa_submit")).toBe(true);
  });

  it("keeps the named set small, and gives a reason for every entry", () => {
    expect(AUTHORIZATION_REQUIRED_TOOLS.size).toBeLessThanOrEqual(5);
    for (const [, reason] of AUTHORIZATION_REQUIRED_TOOLS) {
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it("fails closed on a risk level it does not recognise", () => {
    // An empty or unknown level means the caller could not tell us the action
    // was harmless. A gate that opens when it does not understand its input is
    // not a gate.
    expect(requiresAuthorization("", "anything")).toBe(true);
    expect(requiresAuthorization("unknown-future-level", "anything")).toBe(true);
  });
});

describe("issuing a challenge", () => {
  it("is deterministic under an injected rng", () => {
    const a = issueChallenge("digits", T0, fixedRng());
    const b = issueChallenge("digits", T0, fixedRng());
    expect(a).toEqual(b);
    expect(a.id).toBe("4209");
  });

  it("phrases the digits challenge for the ear, not for the page", () => {
    const c = issueChallenge("digits", T0, fixedRng());
    // "4209" said as a number is "four thousand two hundred nine", which nobody
    // repeats back correctly. Digit by digit is the only sayable form.
    expect(c.prompt).toContain("four two zero nine");
    expect(c.prompt).not.toContain("thousand");
    expect(c.prompt).toContain("one digit at a time");
  });

  it("says out loud that it checks the phrase and not the voice", () => {
    // The person being prompted is the person most likely to assume this is
    // recognising them. Both prompts have to say otherwise.
    for (const kind of ["passphrase", "digits"] as const) {
      const c = issueChallenge(kind, T0, fixedRng());
      expect(c.prompt).toMatch(/not the voice/);
      expect(c.prompt).toMatch(/anyone who has heard/i);
      expect(c.prompt).not.toMatch(/verif(y|ies|ication) (?:your |the )?(voice|identity)/i);
    }
  });

  it("stamps a short life on the challenge", () => {
    const c = issueChallenge("passphrase", T0, fixedRng());
    expect(c.issuedAt).toBe(T0);
    expect(c.expiresAt).toBe(T0 + CHALLENGE_TTL_MS);
    expect(c.attempts).toBe(0);
    expect(CHALLENGE_TTL_MS).toBeLessThanOrEqual(120_000);
  });
});

describe("normalizing what the recognizer returned", () => {
  it("compares digits spoken as words equal to the digits themselves", () => {
    expect(normalizeSpokenResponse("four seven two")).toBe("472");
    expect(normalizeSpokenResponse("472")).toBe("472");
    expect(normalizeSpokenResponse("four seven two")).toBe(normalizeSpokenResponse("472"));
  });

  it("accepts the grouped reading of a five-digit code as well as the digit-by-digit one", () => {
    // Both readings are in use, and spoken-codes already knows how to undo them.
    expect(normalizeSpokenResponse("four seven two one three")).toBe("47213");
    expect(normalizeSpokenResponse("forty seven two thirteen")).toBe("47213");
  });

  it("drops the casing and punctuation the speaker never chose", () => {
    // The recognizer capitalises the first word and puts a full stop at the end.
    // None of that is a decision the speaker made, so none of it may decide
    // whether they are authorized.
    expect(normalizeSpokenResponse("Open, sesame.")).toBe(normalizeSpokenResponse("open sesame"));
    expect(normalizeSpokenResponse("  OPEN   SESAME  ")).toBe(normalizeSpokenResponse("open sesame"));
    expect(normalizeSpokenResponse("open-sesame")).toBe(normalizeSpokenResponse("open sesame"));
  });

  it("treats a spoken zero said as 'oh' the way a recognizer emits it", () => {
    expect(normalizeSpokenResponse("four oh two")).toBe("402");
  });
});

describe("verifying a response", () => {
  it("authorizes on a correct passphrase and clears the failure count", () => {
    const state: AuthState = { ...withPassphraseChallenge(), failures: 2 };
    const r = verifyResponse(state, "Open, Sesame.", "open sesame", T0 + 1_000);
    expect(r.ok).toBe(true);
    expect(r.state.failures).toBe(0);
    expect(r.state.authorizedUntil).toBe(T0 + 1_000 + AUTHORIZED_TTL_MS);
    expect(isAuthorized(r.state, T0 + 1_000)).toBe(true);
  });

  it("verifies a digits challenge spoken as words", () => {
    const state = withDigitsChallenge();
    // The challenge number said back, then the code, one digit at a time.
    const r = verifyResponse(state, "Four two zero nine, seven three five.", "735", T0 + 500);
    expect(r.ok).toBe(true);
    expect(r.why).toMatch(/did not confirm who said it/i);
  });

  it("rejects the code without the challenge number it was bound to", () => {
    // The echo is the only thing separating a live speaker from a recording of
    // yesterday's authorization being played back into the room.
    const state = withDigitsChallenge();
    const r = verifyResponse(state, "seven three five", "735", T0 + 500);
    expect(r.ok).toBe(false);
  });

  it("retires the challenge on success, so it cannot be answered twice", () => {
    const first = verifyResponse(withPassphraseChallenge(), "open sesame", "open sesame", T0);
    expect(first.ok).toBe(true);
    expect(first.state.challenge).toBeUndefined();
    const second = verifyResponse(first.state, "open sesame", "open sesame", T0 + 1);
    expect(second.ok).toBe(false);
    expect(second.why).toMatch(/no authorization challenge/i);
  });

  it("lets the authorization window lapse", () => {
    const r = verifyResponse(withPassphraseChallenge(), "open sesame", "open sesame", T0);
    expect(isAuthorized(r.state, T0 + AUTHORIZED_TTL_MS - 1)).toBe(true);
    expect(isAuthorized(r.state, T0 + AUTHORIZED_TTL_MS)).toBe(false);
    // Short on purpose: the factor is a phrase that was just said out loud in a
    // room, and the window is how much of the day one overheard utterance buys.
    expect(AUTHORIZED_TTL_MS).toBeLessThanOrEqual(5 * 60_000);
  });

  it("fails an expired challenge and says so, rather than quietly reissuing one", () => {
    const state = withPassphraseChallenge();
    const r = verifyResponse(state, "open sesame", "open sesame", T0 + CHALLENGE_TTL_MS);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/expired/i);
    expect(r.why).toMatch(/not been reissued/i);
    expect(r.state.challenge).toBeUndefined();
    expect(isAuthorized(r.state, T0 + CHALLENGE_TTL_MS)).toBe(false);
    // An expired challenge is not a wrong answer, so it must not move the
    // speaker closer to a lockout.
    expect(r.state.failures).toBe(0);
  });

  it("says there is nothing to answer when no challenge is outstanding", () => {
    const r = verifyResponse(initialAuthState(), "open sesame", "open sesame", T0);
    expect(r.ok).toBe(false);
    expect(r.state.authorizedUntil).toBe(0);
  });

  it("refuses to verify anything when no secret is configured", () => {
    const r = verifyResponse(withPassphraseChallenge(), "", "", T0);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/no authorization phrase is configured/i);
    // A configuration fault is not an attempt, so it must not burn a try.
    expect(r.state.failures).toBe(0);
  });

  it("does not count silence toward the lockout", () => {
    // A fan near the microphone must not be able to lock a coder out of their
    // own afternoon.
    const r = verifyResponse(withPassphraseChallenge(), "   ", "open sesame", T0);
    expect(r.ok).toBe(false);
    expect(r.state.failures).toBe(0);
    expect(r.state.challenge?.attempts).toBe(1);
  });

  it("does not mutate the state it was given", () => {
    const state = withPassphraseChallenge();
    const snapshot = JSON.parse(JSON.stringify(state));
    verifyResponse(state, "wrong", "open sesame", T0);
    verifyResponse(state, "open sesame", "open sesame", T0);
    expect(JSON.parse(JSON.stringify(state))).toEqual(snapshot);
  });
});

describe("the lockout", () => {
  function failUntilLocked(secret = "open sesame"): AuthState {
    let state = withPassphraseChallenge();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const r = verifyResponse(state, `guess number ${i}`, secret, T0 + i);
      expect(r.ok).toBe(false);
      state = r.state;
    }
    return state;
  }

  it("locks after MAX_ATTEMPTS consecutive failures", () => {
    const locked = failUntilLocked();
    expect(locked.failures).toBe(MAX_ATTEMPTS);
    expect(locked.lockedUntil).toBeGreaterThan(T0);
    expect(locked.lockedUntil).toBe(T0 + MAX_ATTEMPTS - 1 + LOCKOUT_MS);
  });

  it("rejects a CORRECT response while locked out", () => {
    // The rule most likely to be implemented wrongly: an implementation that
    // compares first and only consults the lockout in the failure branch will
    // happily authorize here, which makes the lockout a hint that the last
    // guess was wrong rather than a lockout.
    const locked = failUntilLocked();
    const r = verifyResponse(
      { ...locked, challenge: issueChallenge("passphrase", locked.lockedUntil - 1_000, fixedRng()) },
      "open sesame",
      "open sesame",
      locked.lockedUntil - 1_000,
    );
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/locked/i);
    expect(isAuthorized(r.state, locked.lockedUntil - 1_000)).toBe(false);
  });

  it("revokes an authorization that was already open", () => {
    const good = verifyResponse(withPassphraseChallenge(), "open sesame", "open sesame", T0);
    expect(isAuthorized(good.state, T0 + 1_000)).toBe(true);

    let state = good.state;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      state = { ...state, challenge: issueChallenge("passphrase", T0 + 1_000, fixedRng()) };
      state = verifyResponse(state, `guess ${i}`, "open sesame", T0 + 1_000).state;
    }
    expect(state.lockedUntil).toBeGreaterThan(T0);
    expect(state.authorizedUntil).toBe(0);
    expect(isAuthorized(state, T0 + 1_001)).toBe(false);
  });

  it("accepts a correct response again once the lockout has passed", () => {
    const locked = failUntilLocked();
    const after = locked.lockedUntil;
    const state = { ...locked, challenge: issueChallenge("passphrase", after, fixedRng()) };
    const r = verifyResponse(state, "open sesame", "open sesame", after);
    expect(r.ok).toBe(true);
    expect(r.state.lockedUntil).toBe(0);
    expect(r.state.failures).toBe(0);
  });
});

describe("what the module is allowed to say", () => {
  it("never reveals how close an attempt was", () => {
    // A near miss and a total miss must be indistinguishable. A "warm" verdict
    // repeated a few times is a transcript of the secret.
    const secret = "marmalade zeppelin four four one seven";
    const near = verifyResponse(withPassphraseChallenge(), "marmalade zeppelin four four one six", secret, T0);
    const far = verifyResponse(withPassphraseChallenge(), "banana", secret, T0);
    expect(near.ok).toBe(false);
    expect(far.ok).toBe(false);
    expect(near.why).toBe(far.why);
    expect(near.why).not.toMatch(/close|almost|partial|character|length|first|last/i);
  });

  it("tells the speaker what to do next", () => {
    const r = verifyResponse(withPassphraseChallenge(), "banana", "open sesame", T0);
    expect(r.why).toMatch(/say the whole phrase again/i);
    expect(r.why).toMatch(/attempts left/i);
  });

  it("never puts the secret into any string it can produce", () => {
    // The fake secret, and every form of it normalization could produce.
    const secret = "Marmalade-Zeppelin 4417";
    const forbidden = [
      secret,
      secret.toLowerCase(),
      normalizeSpokenResponse(secret),
      "Marmalade",
      "marmalade",
      "Zeppelin",
      "zeppelin",
      "4417",
    ];

    const produced: string[] = [];
    const record = (...values: unknown[]) => {
      for (const v of values) produced.push(typeof v === "string" ? v : JSON.stringify(v));
    };

    // Every challenge string.
    for (const kind of ["passphrase", "digits"] as const) {
      const c = issueChallenge(kind, T0, fixedRng());
      record(c.prompt, c.id, c);
    }

    // Every state description.
    const outstanding = withPassphraseChallenge();
    record(describeAuthState(initialAuthState(), T0));
    record(describeAuthState(outstanding, T0 + 1_000));
    record(describeAuthState(outstanding, T0 + CHALLENGE_TTL_MS + 1));

    // Every failure path, plus the success path, plus the resulting states.
    const paths: Array<{ state: AuthState; spoken: string; at: number }> = [
      { state: initialAuthState(), spoken: secret, at: T0 }, // no challenge
      { state: outstanding, spoken: secret, at: T0 + CHALLENGE_TTL_MS }, // expired
      { state: outstanding, spoken: "   ", at: T0 }, // silence
      { state: outstanding, spoken: "wrong answer", at: T0 }, // mismatch
      { state: outstanding, spoken: secret, at: T0 }, // success
      { state: { ...outstanding, lockedUntil: T0 + LOCKOUT_MS, failures: MAX_ATTEMPTS }, spoken: secret, at: T0 }, // locked
      { state: { ...outstanding, failures: MAX_ATTEMPTS - 1 }, spoken: "wrong", at: T0 }, // lockout begins
      { state: withDigitsChallenge(), spoken: secret, at: T0 }, // digits mismatch
    ];
    for (const p of paths) {
      // Nothing here may throw either — an exception message is a string that
      // escapes into a log, and the only string it would have to work with is
      // the secret.
      const r = verifyResponse(p.state, p.spoken, secret, p.at);
      record(r.why, r.state, describeAuthState(r.state, p.at), describeAuthState(r.state, p.at + AUTHORIZED_TTL_MS + 1));
    }

    expect(produced.length).toBeGreaterThan(20);
    for (const text of produced) {
      for (const needle of forbidden) {
        expect(text).not.toContain(needle);
      }
    }
  });

  it("describes the state without leaking the outstanding challenge's expected answer", () => {
    // For a digits challenge the id is half of the expected answer: a status
    // line that read it out to the room would answer the challenge on the
    // speaker's behalf.
    const state = withDigitsChallenge();
    const line = describeAuthState(state, T0 + 1_000);
    expect(line).toContain("digits");
    expect(line).not.toContain(state.challenge!.id);
    expect(line).not.toContain(state.challenge!.prompt);
  });

  it("never claims to have identified the speaker", () => {
    const strings = [
      issueChallenge("passphrase", T0, fixedRng()).prompt,
      issueChallenge("digits", T0, fixedRng()).prompt,
      verifyResponse(withPassphraseChallenge(), "open sesame", "open sesame", T0).why,
      describeAuthState(
        verifyResponse(withPassphraseChallenge(), "open sesame", "open sesame", T0).state,
        T0 + 1_000,
      ),
    ];
    for (const s of strings) {
      expect(s).not.toMatch(/voiceprint|biometric|speaker verification/i);
      expect(s).not.toMatch(/we know it(?:'|’)s you|identity confirmed/i);
      // "voice match" may only ever appear inside a denial of one.
      if (/voice match/i.test(s)) expect(s).toMatch(/not a voice match/i);
    }
    // And the success message says positively what it did prove.
    const ok = verifyResponse(withPassphraseChallenge(), "open sesame", "open sesame", T0);
    expect(ok.why).toMatch(/knowledge of the authorization phrase/i);
    expect(ok.why).toMatch(/did not confirm who said it/i);
  });
});
