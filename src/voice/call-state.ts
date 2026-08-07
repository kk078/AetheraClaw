// ── What is happening on this call ───────────────────────────────────────────
// A phone call has no events. There is only audio, and everything the agent
// needs to know — has a human picked up, is this still hold music, did it go to
// voicemail — has to be inferred from what the transcriber produces.
//
// Getting hold-versus-human wrong is expensive in both directions. Mistake hold
// for a human and the agent talks to music for four minutes and then finds a
// representative who missed the whole thing. Mistake a human for hold and the
// representative says hello twice, gets nothing, and hangs up — after a
// forty-minute wait.
//
// The signals that actually separate them are not volume or silence. Hold
// REPEATS: the same reassurance every ninety seconds, in the same words. A human
// says something that has never been said before on this call, and usually says
// a name. That is what this classifies on.

export type CallState = "dialing" | "ivr" | "hold" | "human" | "voicemail" | "ended";

export interface Segment {
  /** Milliseconds from the start of the call. */
  atMs: number;
  /** What the transcriber heard. Empty means silence or unintelligible audio. */
  text: string;
  /** True when the audio was music or tone rather than speech. */
  music?: boolean;
}

const HOLD_PHRASES = [
  "please continue to hold",
  "your call is important",
  "all of our representatives are",
  "the next available",
  "thank you for your patience",
  "estimated wait",
  "please stay on the line",
  "calls may be monitored",
];

const IVR_PHRASES = [
  "press 1",
  "press one",
  "for claim status",
  "main menu",
  "please listen carefully",
  "our menu options",
  "para espanol",
  "enter your",
  "using your touch tone",
];

const VOICEMAIL_PHRASES = [
  "leave a message",
  "after the tone",
  "after the beep",
  "is not available",
  "has a voice mailbox",
  "record your message",
  "mailbox is full",
];

const HUMAN_PHRASES = [
  "my name is",
  "this is",
  "speaking",
  "how can i help",
  "how may i help",
  "thank you for calling",
  "who am i speaking",
  "can i get your",
  "may i have your",
];

/** A phrase repeated at least this many times is a loop, not a conversation. */
export const LOOP_THRESHOLD = 2;
/** Silence longer than this, with no speech at all, reads as still waiting. */
export const HOLD_SILENCE_MS = 20_000;

function has(text: string, phrases: string[]): string | null {
  const lowered = text.toLowerCase();
  return phrases.find((p) => lowered.includes(p)) ?? null;
}

/** Phrases said more than once, which is the fingerprint of a hold loop. */
export function repeatedPhrases(segments: Segment[]): string[] {
  const counts = new Map<string, number>();
  for (const s of segments) {
    const key = s.text.toLowerCase().replace(/\s+/g, " ").trim();
    if (key.length < 12) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= LOOP_THRESHOLD).map(([k]) => k);
}

export interface StateVerdict {
  state: CallState;
  confidence: "high" | "low";
  reason: string;
  /** Set when the agent should say something now. */
  shouldSpeak: boolean;
}

/**
 * Classify the call from what has been heard so far.
 *
 * Order matters and is not arbitrary. Voicemail is checked before human because
 * a recorded greeting looks exactly like a person introducing themselves —
 * "thank you for calling, this is..." — and the cost of the confusion is
 * one-sided: talking to a mailbox discloses a claim to an unattended recording
 * nobody at the practice controls.
 */
export function classifyCall(segments: Segment[], nowMs?: number): StateVerdict {
  const heard = segments.filter((s) => s.text.trim().length > 0);
  if (segments.length === 0) {
    return { state: "dialing", confidence: "high", reason: "Nothing heard yet.", shouldSpeak: false };
  }

  const latest = heard[heard.length - 1];
  const elapsed = nowMs ?? segments[segments.length - 1].atMs;

  // Voicemail first — a greeting and a mailbox sound alike, and only one of them
  // is safe to talk to.
  for (const s of heard.slice(-3)) {
    const hit = has(s.text, VOICEMAIL_PHRASES);
    if (hit) {
      return {
        state: "voicemail",
        confidence: "high",
        reason: `"${hit}" — this is a mailbox. Do not leave claim details on it: an unattended recording is a disclosure to whoever eventually plays it, and the practice controls neither. Hang up and try the direct line or call back.`,
        shouldSpeak: false,
      };
    }
  }

  if (!latest) {
    const silentFor = elapsed - segments[segments.length - 1].atMs;
    return {
      state: "hold",
      confidence: silentFor > HOLD_SILENCE_MS ? "high" : "low",
      reason: "Nothing but silence or music so far.",
      shouldSpeak: false,
    };
  }

  const loops = repeatedPhrases(heard);
  if (loops.length > 0 && loops.some((l) => l === latest.text.toLowerCase().replace(/\s+/g, " ").trim())) {
    return {
      state: "hold",
      confidence: "high",
      reason: `"${latest.text.slice(0, 60)}" has been said more than once. Repetition is what separates hold from conversation — a person does not say the same sentence twice in the same words.`,
      shouldSpeak: false,
    };
  }

  const holdHit = has(latest.text, HOLD_PHRASES);
  if (holdHit) {
    return { state: "hold", confidence: "high", reason: `"${holdHit}" — still queued.`, shouldSpeak: false };
  }

  const ivrHit = has(latest.text, IVR_PHRASES);
  if (ivrHit) {
    return {
      state: "ivr",
      confidence: "high",
      reason: `"${ivrHit}" — this is a menu, not a person. Choose a digit from the payer's map, or press 0 if nothing matches.`,
      shouldSpeak: false,
    };
  }

  const humanHit = has(latest.text, HUMAN_PHRASES);
  if (humanHit) {
    return {
      state: "human",
      confidence: "high",
      reason: `"${humanHit}" — somebody has picked up. Identify the call as automated before anything else, and get their name.`,
      shouldSpeak: true,
    };
  }

  if (latest.music) {
    return { state: "hold", confidence: "high", reason: "Music.", shouldSpeak: false };
  }

  // Something was said that is not a menu, not a loop and not a known greeting.
  // Most likely a person, but say so as a guess rather than a finding.
  return {
    state: "human",
    confidence: "low",
    reason: `"${latest.text.slice(0, 60)}" does not match a menu, a hold loop or a mailbox, so it is probably a person — but nothing confirmed it. Ask who is on the line before giving any claim details.`,
    shouldSpeak: true,
  };
}

export interface HoldSummary {
  totalMs: number;
  segments: number;
  /** True when the wait is long enough to be worth abandoning. */
  worthAbandoning: boolean;
}

/** Hold time is a real cost, so it is measured rather than endured. */
export const ABANDON_AFTER_MS = 25 * 60_000;

export function summarizeHold(segments: Segment[], nowMs: number): HoldSummary {
  const first = segments.find((s) => s.text.trim() || s.music);
  const totalMs = first ? Math.max(0, nowMs - first.atMs) : 0;
  return {
    totalMs,
    segments: segments.length,
    worthAbandoning: totalMs >= ABANDON_AFTER_MS,
  };
}

export function renderState(verdict: StateVerdict, hold?: HoldSummary): string {
  const lines = [`State: ${verdict.state} (${verdict.confidence} confidence)`, verdict.reason];
  if (hold && hold.totalMs > 0) {
    lines.push(`On this call ${Math.round(hold.totalMs / 60_000)} minute(s).`);
    if (hold.worthAbandoning) {
      lines.push(
        `Past ${ABANDON_AFTER_MS / 60_000} minutes. A callback or the payer's portal is usually cheaper than the rest of this queue — and if the claim has a filing deadline, an abandoned call with no reference number proves nothing.`,
      );
    }
  }
  return lines.join("\n");
}
