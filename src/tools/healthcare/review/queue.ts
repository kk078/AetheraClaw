// ── Coding review queue ──────────────────────────────────────────────────────
// Code selection is the coder's and the provider's legal responsibility, so a
// suggested code is a proposal and nothing else until a human decides on it.
// This module is the state machine for that decision, kept deliberately strict:
// a change or a refusal without a stated reason teaches nobody anything and
// answers no auditor, so it is refused rather than recorded empty.

export type SuggestionKind = "diagnosis" | "procedure" | "modifier";
export type SuggestionStatus = "pending" | "accepted" | "edited" | "rejected";
export type ReviewAction = "accept" | "edit" | "reject" | "reopen";

export interface Suggestion {
  id: string;
  claimRef: string;
  kind: SuggestionKind;
  suggestedCode: string;
  suggestedDescription: string;
  rationale: string;
  /** The documentation that supports the suggestion — quoted, not paraphrased. */
  provenance: string;
  confidence: number | null;
  source: string;
  payer: string;
  status: SuggestionStatus;
  finalCode: string;
  reviewer: string;
  reviewReason: string;
  createdAt: number;
  reviewedAt: number | null;
}

export interface ReviewInput {
  action: ReviewAction;
  reviewer: string;
  /** Required for edit and reject. */
  reason?: string;
  /** Required for edit: what the coder used instead. */
  finalCode?: string;
}

export interface ReviewEvent {
  suggestionId: string;
  action: ReviewAction | "suggested";
  fromStatus: string;
  toStatus: string;
  codeBefore: string;
  codeAfter: string;
  reviewer: string;
  reason: string;
}

export interface ReviewOutcome {
  suggestion: Suggestion;
  event: ReviewEvent;
}

export function normalizeCode(code: string): string {
  return code.replace(/\./g, "").trim().toUpperCase();
}

/**
 * Codes are stored normalized so they compare reliably, but a coder reads
 * "I16.0" and not "I160". ICD-10 places its decimal after the three-character
 * category, always; CPT and HCPCS have no decimal at all.
 */
export function displayCode(kind: SuggestionKind, code: string): string {
  const normalized = normalizeCode(code);
  if (kind !== "diagnosis" || normalized.length <= 3 || code.includes(".")) return code.trim().toUpperCase();
  return `${normalized.slice(0, 3)}.${normalized.slice(3)}`;
}

/**
 * Apply a review decision, or explain why it cannot be applied.
 *
 * Returning a string rather than throwing keeps the caller's error path the same
 * shape as every other tool in the project.
 */
export function applyReview(suggestion: Suggestion, input: ReviewInput): ReviewOutcome | string {
  const reviewer = input.reviewer.trim();
  if (!reviewer) return "A reviewer name is required — an unattributed decision is not an audit trail.";

  if (input.action === "reopen") {
    if (suggestion.status === "pending") return `${suggestion.id} is already pending.`;
    if (!input.reason?.trim()) return "Reopening a decided suggestion requires a reason.";
    return {
      suggestion: {
        ...suggestion,
        status: "pending",
        finalCode: "",
        reviewer: "",
        reviewReason: "",
        reviewedAt: null,
      },
      event: {
        suggestionId: suggestion.id,
        action: "reopen",
        fromStatus: suggestion.status,
        toStatus: "pending",
        codeBefore: suggestion.finalCode,
        codeAfter: "",
        reviewer,
        reason: input.reason.trim(),
      },
    };
  }

  if (suggestion.status !== "pending") {
    return `${suggestion.id} was already ${suggestion.status} by ${suggestion.reviewer || "someone"}. Reopen it first if the decision needs to change — decisions are not silently overwritten.`;
  }

  if (input.action === "accept") {
    return {
      suggestion: {
        ...suggestion,
        status: "accepted",
        finalCode: suggestion.suggestedCode,
        reviewer,
        reviewReason: input.reason?.trim() ?? "",
        reviewedAt: Date.now(),
      },
      event: {
        suggestionId: suggestion.id,
        action: "accept",
        fromStatus: "pending",
        toStatus: "accepted",
        codeBefore: suggestion.suggestedCode,
        codeAfter: suggestion.suggestedCode,
        reviewer,
        reason: input.reason?.trim() ?? "",
      },
    };
  }

  const reason = input.reason?.trim() ?? "";
  if (!reason) {
    return input.action === "edit"
      ? "Changing a suggested code requires a reason. It is what teaches the next suggestion and what an auditor will ask for."
      : "Rejecting a suggested code requires a reason. A bare rejection teaches nothing.";
  }

  if (input.action === "reject") {
    return {
      suggestion: {
        ...suggestion,
        status: "rejected",
        finalCode: "",
        reviewer,
        reviewReason: reason,
        reviewedAt: Date.now(),
      },
      event: {
        suggestionId: suggestion.id,
        action: "reject",
        fromStatus: "pending",
        toStatus: "rejected",
        codeBefore: suggestion.suggestedCode,
        codeAfter: "",
        reviewer,
        reason,
      },
    };
  }

  const finalCode = input.finalCode?.trim() ?? "";
  if (!finalCode) return "An edit needs the code you used instead.";
  if (normalizeCode(finalCode) === normalizeCode(suggestion.suggestedCode)) {
    return `${finalCode} is the code that was suggested — accept it rather than recording an edit to itself.`;
  }

  return {
    suggestion: {
      ...suggestion,
      status: "edited",
      finalCode: finalCode.toUpperCase(),
      reviewer,
      reviewReason: reason,
      reviewedAt: Date.now(),
    },
    event: {
      suggestionId: suggestion.id,
      action: "edit",
      fromStatus: "pending",
      toStatus: "edited",
      codeBefore: suggestion.suggestedCode,
      codeAfter: finalCode.toUpperCase(),
      reviewer,
      reason,
    },
  };
}

export interface SourceStats {
  source: string;
  suggested: number;
  accepted: number;
  edited: number;
  rejected: number;
  pending: number;
  /** Share of decided suggestions taken as proposed. */
  acceptRate: number;
  decided: number;
}

/**
 * How much each suggestion source is actually worth.
 *
 * Accept rate is computed over DECIDED suggestions only — counting the pending
 * queue as neither accepted nor rejected would make a source look worse the
 * faster it produced work nobody had reviewed yet.
 */
export function sourceStats(suggestions: Suggestion[]): SourceStats[] {
  const bySource = new Map<string, SourceStats>();
  for (const s of suggestions) {
    const key = s.source || "(unattributed)";
    const slot =
      bySource.get(key) ??
      { source: key, suggested: 0, accepted: 0, edited: 0, rejected: 0, pending: 0, acceptRate: 0, decided: 0 };
    slot.suggested++;
    if (s.status === "accepted") slot.accepted++;
    else if (s.status === "edited") slot.edited++;
    else if (s.status === "rejected") slot.rejected++;
    else slot.pending++;
    bySource.set(key, slot);
  }
  for (const slot of bySource.values()) {
    slot.decided = slot.accepted + slot.edited + slot.rejected;
    slot.acceptRate = slot.decided > 0 ? slot.accepted / slot.decided : 0;
  }
  return [...bySource.values()].sort((a, b) => b.suggested - a.suggested);
}

export function renderQueue(suggestions: Suggestion[], limit = 25): string {
  if (suggestions.length === 0) return "Nothing in the review queue.";
  const lines: string[] = [`${suggestions.length} suggestion(s):`, ""];
  for (const s of suggestions.slice(0, limit)) {
    const decided = s.status === "pending" ? "" : ` → ${s.finalCode || "(none)"} by ${s.reviewer}`;
    lines.push(
      `  ${s.id}  [${s.kind}] ${s.suggestedCode}${decided}  (${s.status})` +
        `${s.confidence !== null ? ` · confidence ${(s.confidence * 100).toFixed(0)}%` : ""}` +
        `${s.claimRef ? ` · claim ${s.claimRef}` : ""}`,
    );
    if (s.suggestedDescription) lines.push(`      ${s.suggestedDescription}`);
    if (s.rationale) lines.push(`      Why: ${s.rationale}`);
    if (s.provenance) lines.push(`      Documentation: "${s.provenance}"`);
    if (s.reviewReason) lines.push(`      Reviewer: ${s.reviewReason}`);
  }
  if (suggestions.length > limit) lines.push(`  … and ${suggestions.length - limit} more.`);
  return lines.join("\n");
}

export function renderSourceStats(stats: SourceStats[]): string {
  if (stats.length === 0) return "No suggestions recorded yet.";
  const lines = ["Suggestion sources, by how often coders take them as proposed:", ""];
  for (const s of stats) {
    lines.push(
      `  ${s.source}: ${s.suggested} suggested · ${s.accepted} accepted, ${s.edited} edited, ${s.rejected} rejected, ${s.pending} pending` +
        (s.decided > 0 ? ` · ${(s.acceptRate * 100).toFixed(0)}% accepted of ${s.decided} decided` : " · none decided yet"),
    );
  }
  lines.push(
    "",
    "A source that is edited or rejected more often than it is accepted is producing work rather than saving it — worth fixing or turning off.",
  );
  return lines.join("\n");
}
