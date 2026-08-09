import { gateTranscript, type GateDecision, type GatePolicy } from "./transcript-gate.js";
import { normalizeSpokenCodes } from "./spoken-codes.js";
import { describeSnap, snapCode, type CodeUniverse, type SnapResult } from "./snap.js";
import type { SpeechEngine } from "./providers/types.js";

// ── The one pipeline every transcript goes through ───────────────────────────
//
// There are two ways a transcript reaches this system — posted audio the server
// transcribes, and the browser engine recognising in the page — and they must
// not be two different sets of rules. Both call this. Composing it here rather
// than in the route means the ORDER is testable, and the order carries the
// safety property:
//
//   1. Gate first. Everything after this point may be logged, echoed into the
//      composer, or sent to a model, and an identifier must be out before any
//      of that. Normalising first would rewrite the very digits the gate is
//      looking for.
//   2. Normalise spoken codes, so "ninety nine two thirteen" is a code before
//      anything tries to validate it as one.
//   3. Validate against codes that actually exist, and stop rather than guess.

/** A code-shaped token, once normalization has already run. */
const CODE_TOKEN = /\b(?:\d{5}|[A-Z]\d{4}|[A-Z]\d{2}(?:\.\d{1,4})?)\b/g;

export interface RefineOptions {
  policy?: GatePolicy;
  engine?: SpeechEngine;
  /** Absent means code validation is skipped entirely rather than failing everything. */
  universe?: CodeUniverse;
}

export interface RefineResult {
  /** What the caller should use: gated, normalized, and snapped where unambiguous. */
  text: string;
  /** Set when nothing should be sent — the speaker has to resolve something first. */
  ask?: string;
  blocked: boolean;
  /** A sentence for the UI when something happened that the speaker should know about. */
  why?: string;
  gate: GateDecision;
  snaps: Array<{ from: string; result: SnapResult }>;
}

/**
 * Gate, normalize and validate a transcript.
 *
 * Returns `ask` rather than a corrected string when a heard code is equally
 * close to more than one real code. That is the whole point of the validation
 * step: quietly turning 99213 into 99214 produces a claim that is wrong in a
 * way nobody can see, whereas asking costs one round trip.
 */
export function refineTranscript(raw: string, opts: RefineOptions = {}): RefineResult {
  const gate = gateTranscript(raw, { policy: opts.policy, engine: opts.engine });
  if (gate.action === "refuse") {
    return { text: "", blocked: true, why: gate.why, gate, snaps: [] };
  }

  const normalized = normalizeSpokenCodes(gate.text);
  const snaps: Array<{ from: string; result: SnapResult }> = [];

  if (!opts.universe) {
    return {
      text: normalized,
      blocked: false,
      why: gate.action === "redact" ? gate.why : undefined,
      gate,
      snaps,
    };
  }

  const universe = opts.universe;
  const asks: string[] = [];
  CODE_TOKEN.lastIndex = 0;
  const text = normalized.replace(CODE_TOKEN, (token) => {
    const result = snapCode(token, universe);
    snaps.push({ from: token, result });
    if (result.status === "snapped") return result.code;
    // An ambiguous token is left EXACTLY as heard. Substituting either
    // candidate would be the guess this branch exists to refuse, and blanking
    // it would lose what the speaker actually said.
    if (result.status === "ambiguous") asks.push(describeSnap(result));
    return token;
  });

  const corrections = snaps.filter((s) => s.result.status === "snapped");
  const notes: string[] = [];
  if (gate.action === "redact" && gate.why) notes.push(gate.why);
  for (const c of corrections) notes.push(describeSnap(c.result));

  return {
    text,
    ask: asks.length > 0 ? asks.join(" ") : undefined,
    blocked: false,
    why: notes.length > 0 ? notes.join(" ") : undefined,
    gate,
    snaps,
  };
}
