import { detectPhi, redact, type PhiSignal } from "../channels/email/classify.js";
import {
  DISCLOSING_ACTIONS,
  checkResourceRef,
  type AccessAction,
  type AccessEvent,
} from "../tenancy/access-log.js";
import type { SpeechEngine } from "./providers/types.js";

// ── The identifier gate for spoken input ─────────────────────────────────────
// An uploaded document passes an identifier check before anything reads it. A
// spoken sentence did not: the transcript went straight from the recogniser to
// the turn, so "the member ID is 1EG4-TE5-MK73" reached the model, the session
// transcript and the SQLite file with nothing in between. Voice is in fact the
// likelier path for an identifier to arrive — people read numbers off a card
// out loud, which is precisely what nobody does when attaching a PDF.
//
// So this is the one choke point, and it runs BEFORE the transcript becomes a
// turn. One function, no side effects, no I/O: the caller decides what to do
// with the decision, and a pure decision is the only kind that can be tested
// exhaustively.
//
// What it cannot do is worth stating plainly, because the failure mode of a
// gate is that people trust it past its edge. It matches identifier SHAPES,
// reusing the same four patterns as the email path (SSN, MBI, HICN, labelled
// DOB) rather than inventing a second set that would drift out of step with
// them. A patient's name and their diagnosis, spoken in a sentence, are PHI with
// no shape to match, and this gate will pass them without comment.

/** What the gate decided, and everything a caller needs to act on it. */
export interface GateDecision {
  action: "pass" | "redact" | "refuse";
  /** What may be sent onward. Empty on refuse. */
  text: string;
  /**
   * The transcript as it arrived. Kept so a caller can log-and-drop it — never
   * to send. It holds the identifier by definition.
   */
  original: string;
  signals: PhiSignal[];
  /** Why, in words a person can be shown. */
  why: string;
  /** Whether this access is worth recording under §164.312(b). */
  loggable: boolean;
}

export type GatePolicy = "redact" | "refuse" | "off";

export interface GateOptions {
  /** Default "redact" — the usable posture. "refuse" for a site that wants voice to never carry identifiers. */
  policy?: GatePolicy;
  /** Which engine produced this transcript. Changes the wording, never the decision. */
  engine?: SpeechEngine;
}

/**
 * Where the audio had already gone by the time this function runs.
 *
 * This is the sentence the whole module exists to get right. Redaction happens
 * on the TRANSCRIPT, which is downstream of recognition — and under two of the
 * three engines recognition is somebody else's computer. Chrome ships captured
 * audio to Google; the cloud adapter ships it to OpenAI or Deepgram. By the time
 * a decision is made here, the spoken Social Security number has already been
 * transmitted, and no amount of scrubbing the text un-transmits it.
 *
 * Saying "identifier removed" in that situation would be a lie of exactly the
 * kind a compliance control must not tell, because it is the sentence someone
 * later quotes to explain why the incident was not reported.
 */
const AUDIO_ALREADY_LEFT: Record<SpeechEngine, string> = {
  browser:
    "the audio was already sent to the browser's recognition service before this ran, so the identifier has been disclosed — redacting the transcript does not undo that",
  cloud:
    "the audio was already sent to the cloud speech vendor before this ran, so the identifier has been disclosed — redacting the transcript does not undo that",
  local:
    "the audio was transcribed on this machine, so the identifier did not leave it and this stops it here",
};

function signalSummary(signals: PhiSignal[]): string {
  return signals.map((s) => `${s.count}× ${s.hint}`).join(", ");
}

/**
 * Examine a transcript before it becomes a turn.
 *
 * The no-signal path — which is nearly every utterance — allocates nothing and
 * returns the text by reference. A gate that taxes ordinary speech gets turned
 * off, and a gate that is off protects nothing.
 */
export function gateTranscript(text: string, opts: GateOptions = {}): GateDecision {
  const policy: GatePolicy = opts.policy ?? "redact";
  const engine: SpeechEngine = opts.engine ?? "local";
  const signals = detectPhi(text);

  if (signals.length === 0) {
    return {
      action: "pass",
      text,
      original: text,
      signals,
      why: "No identifier shapes in the transcript. Shape matching only — a name or a diagnosis spoken in a sentence has no pattern to catch.",
      loggable: false,
    };
  }

  const found = signalSummary(signals);
  const disclosure = AUDIO_ALREADY_LEFT[engine];

  // "off" still detects. The operator turned off the ACTION, not the eyes: the
  // console can still warn, and the access is still recorded, because a
  // redaction policy and an access log are different controls and collapsing
  // them means switching one off silently switches off the other.
  if (policy === "off") {
    return {
      action: "pass",
      text,
      original: text,
      signals,
      why: `Gate disabled — ${found} passed through to the model unchanged, and ${disclosure}.`,
      loggable: true,
    };
  }

  if (policy === "refuse") {
    return {
      action: "refuse",
      text: "",
      original: text,
      signals,
      // The instruction matters as much as the refusal. A speaker who is told
      // "no" and not told what else to say will simply repeat the identifier
      // more slowly.
      why: `Not sending that — ${found}. Say the claim number instead of the member ID, or type the identifier rather than speaking it. Note that ${disclosure}.`,
      loggable: true,
    };
  }

  return {
    action: "redact",
    text: redact(text),
    original: text,
    why: `Redacted before the transcript became a turn — ${found}. Note that ${disclosure}.`,
    signals,
    loggable: true,
  };
}

/**
 * A §164.312(b) event for a transcript that carried an identifier.
 *
 * Reuses the tenancy access-log shape rather than inventing a speech-shaped log
 * beside it: two log formats means two review queries, and the one nobody wrote
 * the query for is the one the incident is in.
 *
 * The action is chosen by where the audio went, which is what
 * DISCLOSING_ACTIONS already means. Local recognition is a read — the identifier
 * stayed inside. Browser and cloud recognition are an export: the audio left the
 * organisation's control before this code ran, and that is the definition the
 * access review is built around.
 */
export function accessEventForTranscript(
  decision: GateDecision,
  ctx: { sessionId: string; actor: string; tenantSlug?: string; sourceAddress?: string; engine?: SpeechEngine; at?: number },
): AccessEvent | null {
  if (!decision.loggable) return null;

  const action = accessActionForEngine(ctx.engine ?? "local");

  // The reference is a pointer, never content — the log must not become a
  // second copy of the thing it protects. A session id is generated by us, but
  // it is checked anyway: this function is called with whatever the gateway
  // holds, and a ref that happens to look like an identifier is refused by
  // prepareAccessEntry downstream, which would drop the entry entirely. Falling
  // back to a bare label keeps the event.
  const candidate = `voice-transcript:${ctx.sessionId}`;
  const resourceRef = checkResourceRef(candidate).ok ? candidate : "voice-transcript";

  return {
    action,
    resourceType: "document",
    resourceRef,
    actor: ctx.actor,
    tenantSlug: ctx.tenantSlug ?? "",
    sourceAddress: ctx.sourceAddress ?? "",
    // One utterance, one record. Counting the signals instead would report a
    // sentence naming an SSN twice as two records disclosed, which inflates
    // every bulk-export figure the review is built on.
    recordCount: 1,
    at: ctx.at ?? Date.now(),
  };
}

/**
 * Local recognition is a read; browser and cloud recognition are an export.
 *
 * Exported so the mapping is inspectable rather than buried in a ternary — it
 * is the judgement the whole log entry rests on.
 */
export function accessActionForEngine(engine: SpeechEngine): AccessAction {
  return engine === "local" ? "read" : "export";
}

/** True when the transcript's own audio has already been disclosed to a third party. */
export function transcriptWasDisclosed(engine: SpeechEngine): boolean {
  return DISCLOSING_ACTIONS.has(accessActionForEngine(engine));
}

/** One line for the UI, next to the transcript it is about. */
export function describeGate(decision: GateDecision): string {
  const kinds = decision.signals.map((s) => s.kind.toUpperCase()).join(", ");
  switch (decision.action) {
    case "pass":
      return decision.signals.length === 0
        ? "Transcript clear — no identifier shapes."
        : `Gate off — ${kinds} sent through unchanged. ${decision.why}`;
    case "redact":
      return `Redacted ${kinds} from the transcript. ${decision.why}`;
    case "refuse":
      return `Blocked — the transcript named ${kinds}. ${decision.why}`;
  }
}
