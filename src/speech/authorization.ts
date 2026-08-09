import { createHash, timingSafeEqual } from "node:crypto";
import { parseSpokenCode, speakCode, speakNumber } from "./spoken-codes.js";
import type { RiskLevel } from "../tools/types.js";

// ── A spoken authorization challenge. NOT speaker verification. ──────────────
//
// WHAT THIS IS. A knowledge factor, spoken aloud, that gates risky actions. The
// system asks for a phrase (or a code, said digit by digit); the speaker says
// it; this module compares what was said against the configured secret and, on a
// match, opens a short authorization window. That is the whole mechanism.
//
// WHAT THIS IS NOT, AND MUST NEVER BE DESCRIBED AS. It does not verify a voice.
// It does not identify a speaker. It has no acoustic model, no enrolment, no
// voiceprint, no audio of any kind — it never sees audio, only the text a
// recognizer produced. Anyone who overhears the phrase can say it back and this
// module will authorize them, and it cannot tell that it happened. Everything
// this file renders says so out loud, because the roadmap item that led here was
// called "speaker verification", and shipping a phrase check under that name in
// a healthcare system would be a FALSE SECURITY CONTROL: it would let a clinic
// believe risky billing actions were bound to a person when they are bound only
// to a phrase that gets said in a room with other people in it. A control people
// trust past its edge is worse than no control, because no control at least
// leaves the human review in place.
//
// WHY VOICE NEEDS THIS AT ALL. A keyboard is an implicit authentication factor:
// to type, you have to be at the machine. A microphone removes it. Anyone within
// earshot — a patient in the next chair, a visitor, a recording playing back —
// can drive the assistant. So voice needs an explicit factor where the keyboard
// used to be one, and a knowledge factor is the only kind this project can
// honestly build today.
//
// WHAT A REAL BIOMETRIC FACTOR WOULD REQUIRE, so nobody mistakes this for a step
// toward one: a speaker-verification model (an x-vector/ECAPA-style embedder or
// equivalent), an enrolment flow capturing several seconds of each authorized
// person's speech, storage of those embeddings as biometric identifiers — which
// under HIPAA are PHI, and under BIPA/CCPA-style state law carry their own
// consent, notice, retention and deletion duties — a decision threshold tuned
// against measured false-accept/false-reject rates on this population, and
// anti-spoofing (replay and synthesis detection), because a recording of the
// authorized person defeats a naive embedder as easily as an overheard phrase
// defeats this. None of that exists here. This file does not approximate it.
//
// The module is pure: no I/O, no clock, no storage. `now` is passed in and the
// state is handed back, so the policy can be tested exhaustively and the caller
// decides where a session's AuthState lives.

/**
 * An outstanding request for the speaker to say the authorization secret.
 *
 * Carries no copy of the expected answer — the secret is supplied to
 * `verifyResponse` by the caller at comparison time and is never stored on the
 * challenge, never logged with it, and never rendered from it.
 */
export interface AuthChallenge {
  /**
   * Identifies this challenge, and for `kind: "digits"` it IS the short number
   * the prompt reads out — see `issueChallenge`. That number is spoken aloud by
   * design, so it is not a secret; it exists so a response is bound to the one
   * challenge that asked for it rather than to any challenge ever issued.
   */
  id: string;
  kind: "passphrase" | "digits";
  /** What the assistant says. Phrased for the ear, and honest about what it checks. */
  prompt: string;
  issuedAt: number;
  expiresAt: number;
  /** Responses compared against this challenge so far. */
  attempts: number;
}

/** Everything one session knows about its spoken authorization. */
export interface AuthState {
  challenge?: AuthChallenge;
  /** Epoch ms until which risky actions may run without asking again. 0 = never authorized. */
  authorizedUntil: number;
  /** Consecutive failed responses. Reset by success, and by the lockout expiring. */
  failures: number;
  /** Epoch ms until which no response is accepted at all, correct or not. 0 = not locked. */
  lockedUntil: number;
}

// ── The policy, exported so it can be read rather than guessed at ────────────

/**
 * How long a challenge stands before it goes stale.
 *
 * Short, because the window is the window in which an overheard answer is
 * useful. Long enough that someone can finish the sentence they were in the
 * middle of, find the phrase, and say it.
 */
export const CHALLENGE_TTL_MS = 45_000;

/**
 * How long one successful response authorizes for.
 *
 * Deliberately about two minutes rather than a session. The factor being checked
 * is a phrase that was just said out loud in a room; the longer the window, the
 * more of the day is covered by one overheard utterance. Long enough to run the
 * action that prompted it and a directly related follow-up, and no longer.
 */
export const AUTHORIZED_TTL_MS = 120_000;

/** Consecutive failed responses before the lockout. */
export const MAX_ATTEMPTS = 3;

/**
 * How long a lockout lasts.
 *
 * Long enough that guessing a phrase aloud, one guess at a time, is not a
 * strategy; short enough that a person who genuinely misremembered is not locked
 * out of their own afternoon.
 */
export const LOCKOUT_MS = 5 * 60_000;

/** A session that has never been authorized. */
export function initialAuthState(): AuthState {
  return { authorizedUntil: 0, failures: 0, lockedUntil: 0 };
}

// ── Which actions need a spoken authorization ────────────────────────────────

/**
 * The registry's own "nothing at stake" level, imported as a type rather than
 * retyped as a bare string, so that renaming the level in `src/tools/types.ts`
 * breaks this build instead of silently turning the gate off.
 */
const SAFE_LEVEL: RiskLevel = "safe";

/**
 * Tools that need spoken authorization regardless of how they were assessed.
 *
 * Kept SMALL and each entry justified, because a list of names is not a security
 * policy: it protects exactly the tools somebody remembered to add and nothing
 * that arrives next month. The risk level below is the real driver; this map
 * covers the two cases a level alone cannot — a tool the registry assesses as
 * safe that nonetheless reaches a payer, and a tool whose gate must not be
 * removable by a future edit to its `assessRisk`.
 */
export const AUTHORIZATION_REQUIRED_TOOLS: ReadonlyMap<string, string> = new Map([
  // Assessed "safe" (it defines no assessRisk, so the registry's default
  // applies) yet it sends a Da Vinci PAS bundle to a payer and starts the
  // decision clock. There is no local undo for a prior authorization already
  // filed under the practice's NPI.
  ["pa_submit", "submits a prior authorization to the payer"],
  // Assessed "confirm" today. Pinned here anyway because it produces the file
  // that gets transmitted as the claim: a later refactor that downgrades its
  // risk level must not be able to silently drop the spoken gate on claim
  // submission, which is the single action this module exists for.
  ["claim_build_837p", "builds the 837P claim file that gets transmitted"],
  // Assessed "confirm" today, pinned for the same reason: it types into a
  // payer's website under the practice's own credentials, so its effects land
  // outside this system where nothing here can roll them back.
  ["portal_fill", "writes into a payer portal under the practice's login"],
]);

/**
 * Whether an action must be authorized by voice before it runs.
 *
 * Driven off the risk level the tool registry already assesses, not off a list
 * of names: anything the registry did not positively call safe needs the
 * factor. An unrecognised or empty level counts as "not safe" — a gate that
 * opens when it does not understand its input is not a gate.
 *
 * This decides only WHETHER to ask. It says nothing about who answered, because
 * nothing in this module can know that.
 */
export function requiresAuthorization(risk: string, toolName: string): boolean {
  if (AUTHORIZATION_REQUIRED_TOOLS.has(toolName)) return true;
  return String(risk ?? "").trim().toLowerCase() !== SAFE_LEVEL;
}

// ── Issuing a challenge ──────────────────────────────────────────────────────

/** A short number for the ear, drawn from the injected source of randomness. */
function nonceDigits(rng: () => number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const digit = Math.floor(Math.abs(rng()) * 10) % 10;
    out += String(Number.isFinite(digit) ? digit : 0);
  }
  return out;
}

/**
 * Ask the speaker for the authorization secret.
 *
 * `rng` is injected rather than reached for, so a test sees the same challenge
 * twice and the prompt can be asserted on. Nothing here is a cryptographic
 * nonce: the number's job is to bind one response to one challenge inside a
 * 45-second window, not to resist an adversary who can predict Math.random.
 *
 * The two kinds differ in how the shared secret is SAID, not in what is proven:
 *
 *  - "passphrase" — the secret is words, said as words.
 *  - "digits" — the secret is a numeric code, said one digit at a time (a
 *    recognizer hearing "seven three five" run together returns "735" or "seven
 *    thirty five" at random), and the speaker first repeats the short number the
 *    prompt reads out. That echo is the only thing separating a live speaker
 *    from a recording of yesterday's authorization being played back; it proves
 *    the response was produced after this challenge, and nothing about who
 *    produced it.
 *
 * The prompt says out loud that this checks the phrase and not the voice. That
 * sentence is not decoration: the person being prompted is the person most
 * likely to assume otherwise.
 */
export function issueChallenge(
  kind: "passphrase" | "digits",
  now: number,
  rng: () => number = Math.random,
): AuthChallenge {
  const issuedAt = now;
  const expiresAt = now + CHALLENGE_TTL_MS;
  const seconds = speakNumber(Math.round(AUTHORIZED_TTL_MS / 1000));

  if (kind === "digits") {
    const id = nonceDigits(rng, 4);
    return {
      id,
      kind,
      // speakCode, not speakNumber: "4721" said as a number is "four thousand
      // seven hundred twenty one", which nobody repeats back correctly.
      prompt:
        `Say the number ${speakCode(id)}, then your authorization code, one digit at a time. ` +
        `This checks the code, not the voice — anyone who has heard the code can say it. ` +
        `A correct answer authorizes for the next ${seconds} seconds.`,
      issuedAt,
      expiresAt,
      attempts: 0,
    };
  }

  return {
    id: `p${nonceDigits(rng, 6)}`,
    kind,
    prompt:
      `Say your authorization phrase. ` +
      `This checks the phrase, not the voice — anyone who has heard the phrase can say it. ` +
      `A correct answer authorizes for the next ${seconds} seconds.`,
    issuedAt,
    expiresAt,
    attempts: 0,
  };
}

// ── Normalizing and comparing ────────────────────────────────────────────────

/**
 * How each digit is said, taken from spoken-codes rather than retyped.
 *
 * Built by asking `speakCode` how it renders each digit and inverting the
 * answer, so there is exactly one table in this codebase describing how a digit
 * sounds. A second hand-written map would be a second thing to keep in step, and
 * the day it drifted the symptom would be an authorization that stopped
 * accepting a correct answer.
 */
const DIGIT_WORDS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (let d = 0; d <= 9; d++) map.set(speakCode(String(d)), String(d));
  // Recognizers return "oh" for a spoken zero far more often than "zero" —
  // spoken-codes makes the same allowance in its own parser.
  map.set("oh", "0");
  return map;
})();

/**
 * Reduce a spoken response to the form comparisons happen in.
 *
 * A phrase spoken back does not arrive as it was configured. The recognizer
 * capitalises the first word, adds a comma where the speaker paused and a full
 * stop where they stopped, and renders digits as words or numerals depending on
 * the engine and the phrasing. None of that is something the speaker chose, so
 * none of it may decide whether they are authorized.
 *
 * So: case is dropped, everything that is not a letter or a digit is dropped
 * (which also collapses spacing, hyphens and the recognizer's punctuation), and
 * spoken digit words become digits. `parseSpokenCode` gets first refusal on the
 * whole utterance, which buys the grouped readings people actually use for a
 * five-digit code — "forty seven two thirteen" and "four seven two one three"
 * both land on 47213 — without a second number parser existing here.
 *
 * Both sides of every comparison go through this function, so the rule is a
 * property of the comparison rather than an allowance made for one side.
 */
export function normalizeSpokenResponse(text: string): string {
  const raw = String(text ?? "").trim();
  if (!raw) return "";

  // Only accept the code parser's answer when it is pure digits: it can also
  // return an ICD-10 shape with a decimal point or a leading modifier dash, and
  // those are code grammar, not response grammar.
  const asCode = parseSpokenCode(raw);
  if (asCode && /^\d+$/.test(asCode)) return asCode;

  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) => DIGIT_WORDS.get(word) ?? word)
    .join("");
}

/**
 * Compare two normalized responses without leaking how far they agreed.
 *
 * Hashed first, then compared over the two fixed-length digests. A plain `===`
 * on strings returns as soon as it finds a difference, so the time it takes is a
 * function of the shared prefix — which, repeated, is enough to recover a
 * passphrase one character at a time. `timingSafeEqual` alone is not enough
 * either: it THROWS on length mismatch, and the throw is itself an oracle for
 * the length of the secret (and an exception this module has promised never to
 * raise). Digests are always 32 bytes, so neither length nor content reaches the
 * comparison.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

/**
 * What this challenge expects to hear, assembled at comparison time.
 *
 * Never stored on the challenge, never returned, never rendered. For a digits
 * challenge it is the spoken-back number followed by the code; for a passphrase
 * it is the phrase alone.
 */
function expectedResponse(challenge: AuthChallenge, secret: string): string {
  return challenge.kind === "digits" ? `${challenge.id}${secret}` : secret;
}

/** Whole seconds, said the way the assistant will say them. */
function spokenSeconds(ms: number): string {
  return speakNumber(Math.max(0, Math.ceil(ms / 1000)));
}

/**
 * Check a spoken response against the configured secret.
 *
 * Returns a new state rather than mutating the one passed in, so a caller cannot
 * half-apply a failed attempt. The secret is a parameter and not a field:
 * nothing in the returned value, the returned state, or `why` contains it, and
 * this function never throws — an exception message is a string that escapes
 * into a log, and the only string it would have to work with is the secret.
 *
 * A success proves that whoever spoke knows the phrase. It does not prove who
 * spoke, and `why` says so on the way past.
 */
export function verifyResponse(
  state: AuthState,
  spoken: string,
  secret: string,
  now: number,
): { ok: boolean; state: AuthState; why: string } {
  // FIRST, before anything is compared. A lockout that a correct answer can end
  // is not a lockout — it is a hint that the last guess was wrong, handed to
  // whoever is guessing. This ordering is the whole point of the rule, and it is
  // the one an implementation gets wrong by putting the comparison at the top
  // and checking the lockout in the failure branch.
  if (now < state.lockedUntil) {
    return {
      ok: false,
      state: { ...state, challenge: undefined },
      why:
        `Spoken authorization is locked for another ${spokenSeconds(state.lockedUntil - now)} seconds ` +
        `after ${speakNumber(state.failures)} failed responses. Nothing said now will be accepted. ` +
        `Approve this action at the keyboard instead, or wait for the lockout to pass.`,
    };
  }

  const challenge = state.challenge;
  if (!challenge) {
    return {
      ok: false,
      state: { ...state },
      why: "No authorization challenge is outstanding, so there is nothing to answer. Ask for the action again and a challenge will be issued.",
    };
  }

  if (now >= challenge.expiresAt) {
    // Cleared, not replaced. Reissuing here would mean an answer that arrived
    // late got silently measured against a challenge nobody heard, and the
    // speaker would never learn that their timing was the problem.
    return {
      ok: false,
      state: { ...state, challenge: undefined },
      why: "That challenge expired before the answer arrived. It has not been reissued — ask for the action again to get a new one.",
    };
  }

  // A configuration fault, not an attempt: it must not burn one of the three
  // tries, and it must be reported as the operator's problem to fix.
  if (normalizeSpokenResponse(secret) === "") {
    return {
      ok: false,
      state: { ...state },
      why: "No authorization phrase is configured on this installation, so a spoken response cannot be checked at all. Set one before using voice for anything that is not read-only.",
    };
  }

  // Silence is what a noisy room produces, not what a wrong answer looks like.
  // Counting it toward the lockout would let a fan near the microphone lock a
  // coder out of their own afternoon.
  if (normalizeSpokenResponse(spoken) === "") {
    return {
      ok: false,
      state: { ...state, challenge: { ...challenge, attempts: challenge.attempts + 1 } },
      why: "I did not hear a response. Say it again, a little slower.",
    };
  }

  const matched = constantTimeEqual(
    normalizeSpokenResponse(spoken),
    normalizeSpokenResponse(expectedResponse(challenge, secret)),
  );

  if (matched) {
    return {
      ok: true,
      // Failures cleared and the challenge retired: a used challenge must not be
      // answerable twice.
      state: { authorizedUntil: now + AUTHORIZED_TTL_MS, failures: 0, lockedUntil: 0 },
      why:
        `Authorized for the next ${speakNumber(Math.round(AUTHORIZED_TTL_MS / 1000))} seconds. ` +
        `This confirmed knowledge of the authorization phrase. It did not confirm who said it.`,
    };
  }

  const failures = state.failures + 1;

  if (failures >= MAX_ATTEMPTS) {
    return {
      ok: false,
      // Any authorization already open is revoked too. Three wrong answers in a
      // row is the shape of somebody trying phrases, and leaving the window they
      // are trying to reach open through the lockout would defeat it.
      state: { authorizedUntil: 0, failures, lockedUntil: now + LOCKOUT_MS },
      why:
        `That did not match. ${speakNumber(MAX_ATTEMPTS)} responses in a row have now failed, so spoken ` +
        `authorization is locked for ${speakNumber(Math.round(LOCKOUT_MS / 60_000))} minutes. ` +
        `Approve this action at the keyboard instead.`,
    };
  }

  return {
    ok: false,
    state: { ...state, challenge: { ...challenge, attempts: challenge.attempts + 1 }, failures },
    // Says what to do and how many tries are left. It does NOT say which part
    // was wrong, how much matched, or how long the expected answer is — a
    // "close" verdict repeated a few times is a transcript of the secret.
    why:
      `That did not match. Say the whole phrase again from the start. ` +
      `${speakNumber(MAX_ATTEMPTS - failures)} attempts left before a lockout.`,
  };
}

/** Whether risky actions may run right now without asking again. */
export function isAuthorized(state: AuthState, now: number): boolean {
  if (now < state.lockedUntil) return false;
  return now < state.authorizedUntil;
}

/**
 * One line about the authorization state, for a UI badge or a spoken status.
 *
 * Renders no secret, no challenge prompt and no challenge id — for a digits
 * challenge the id is half of the expected answer, and a status line that reads
 * it out to the room would answer the challenge on the speaker's behalf. Times
 * and counts only.
 */
export function describeAuthState(state: AuthState, now: number): string {
  if (now < state.lockedUntil) {
    return `Spoken authorization locked for another ${Math.ceil((state.lockedUntil - now) / 1000)} seconds after ${state.failures} failed responses.`;
  }
  if (now < state.authorizedUntil) {
    return `Authorized by spoken phrase for another ${Math.ceil((state.authorizedUntil - now) / 1000)} seconds — knowledge of the phrase, not a voice match.`;
  }
  const challenge = state.challenge;
  if (challenge && now < challenge.expiresAt) {
    const left = Math.ceil((challenge.expiresAt - now) / 1000);
    return `Not authorized. A ${challenge.kind} challenge is outstanding for another ${left} seconds; ${challenge.attempts} responses so far.`;
  }
  if (challenge) {
    return "Not authorized. The last challenge expired unanswered and was not reissued.";
  }
  return "Not authorized. No spoken challenge is outstanding.";
}
