import { displayCode, normalizeCode, type Suggestion, type SuggestionKind } from "./queue.js";

// ── Corrections learning store ───────────────────────────────────────────────
// What this practice's coders keep changing. A correction is only worth
// recording when a human overrode a suggestion — accepts teach nothing, because
// they only confirm what was already proposed.
//
// Cache safety: these are recalled through a tool, so they land in user turns.
// The system prompt is byte-stable so provider-side prompt caching works, and
// folding a growing list of practice-specific corrections into it would
// invalidate the cache on every change.

export interface Correction {
  id: string;
  kind: SuggestionKind;
  suggestedCode: string;
  /** Empty when the suggestion was rejected outright rather than replaced. */
  correctedCode: string;
  payerKey: string;
  reason: string;
  timesSeen: number;
  lastSeenAt: number;
  createdAt: number;
}

export function payerKey(payer: string): string {
  return payer.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface CorrectionSeed {
  kind: SuggestionKind;
  suggestedCode: string;
  correctedCode: string;
  payerKey: string;
  reason: string;
}

/**
 * The correction implied by a reviewed suggestion, or null when there is none.
 *
 * An accepted suggestion produces nothing: it confirms the proposal rather than
 * correcting it, and recording accepts alongside corrections would drown the
 * signal in agreement.
 */
export function deriveCorrection(suggestion: Suggestion): CorrectionSeed | null {
  if (suggestion.status !== "edited" && suggestion.status !== "rejected") return null;
  if (!suggestion.reviewReason.trim()) return null;
  return {
    kind: suggestion.kind,
    suggestedCode: normalizeCode(suggestion.suggestedCode),
    correctedCode: suggestion.status === "edited" ? normalizeCode(suggestion.finalCode) : "",
    payerKey: payerKey(suggestion.payer),
    reason: suggestion.reviewReason.trim(),
  };
}

export interface CorrectionQuery {
  kind?: SuggestionKind;
  codes?: string[];
  payer?: string;
}

/**
 * Corrections that bear on a lookup, strongest first.
 *
 * A payer-specific correction outranks a general one for the same code, because
 * "this payer wants it coded differently" is more actionable than "we sometimes
 * change this". Beyond that, corrections seen repeatedly outrank one-offs — a
 * single override may have been a one-time judgement about one chart.
 */
export function matchCorrections(corrections: Correction[], query: CorrectionQuery): Correction[] {
  const wanted = query.codes?.map(normalizeCode).filter(Boolean);
  const key = query.payer ? payerKey(query.payer) : "";

  const matched = corrections.filter((c) => {
    if (query.kind && c.kind !== query.kind) return false;
    if (wanted && wanted.length > 0 && !wanted.includes(c.suggestedCode)) return false;
    // A correction recorded for a specific payer does not generalize to others.
    if (c.payerKey && key && c.payerKey !== key) return false;
    if (c.payerKey && !key) return false;
    return true;
  });

  return matched.sort(
    (a, b) =>
      Number(Boolean(b.payerKey)) - Number(Boolean(a.payerKey)) ||
      b.timesSeen - a.timesSeen ||
      b.lastSeenAt - a.lastSeenAt,
  );
}

/** Corrections seen at least this often are described as an established pattern. */
export const ESTABLISHED_THRESHOLD = 3;

export function renderCorrections(corrections: Correction[], query: CorrectionQuery): string {
  if (corrections.length === 0) {
    const scope = query.codes?.length ? ` for ${query.codes.join(", ")}` : "";
    return `No recorded corrections${scope}${query.payer ? ` with ${query.payer}` : ""}. Suggest normally; the queue will capture anything a coder changes.`;
  }

  const lines: string[] = [
    `${corrections.length} correction(s) this practice's coders have made before — weigh these before suggesting:`,
    "",
  ];
  for (const c of corrections) {
    const strength = c.timesSeen >= ESTABLISHED_THRESHOLD ? "established" : c.timesSeen > 1 ? "repeated" : "seen once";
    const scope = c.payerKey ? ` with this payer` : " across payers";
    const from = displayCode(c.kind, c.suggestedCode);
    lines.push(
      c.correctedCode
        ? `  ${from} → ${displayCode(c.kind, c.correctedCode)} (${c.kind}, ${strength}: ${c.timesSeen}×${scope})`
        : `  ${from} rejected outright (${c.kind}, ${strength}: ${c.timesSeen}×${scope})`,
      `      Coder's reason: ${c.reason}`,
    );
  }
  lines.push(
    "",
    "These are this practice's own past decisions, not coding rules. Follow the documentation and the code set; where they and a past correction disagree, say so rather than silently deferring to either.",
  );
  return lines.join("\n");
}
