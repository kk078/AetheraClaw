import type { NormalizedMessage } from "../providers/types.js";
import { estimateTokens } from "./context-window.js";

// ── Compaction ───────────────────────────────────────────────────────────────
//
// What this replaces: `truncateToBudget` dropped the oldest turns and left one
// line saying "[Earlier conversation truncated]". In a billing conversation that
// is a specific kind of damage. The claim id, the payer, the denial code and the
// verdict a coder already agreed to are all established EARLY and referred to
// for the rest of the session — "appeal it", "what did the scrubber say", "use
// that same payer". Drop-oldest throws exactly those away and keeps the recent
// chat about them, so the model is left holding pronouns with no referents. It
// then does the worst available thing, which is to answer anyway.
//
// TWO DECISIONS WORTH ARGUING WITH:
//
// 1. THE SUMMARY IS EXTRACTIVE, NOT MODEL-WRITTEN. Asking a model to summarise
//    mid-turn adds a network call inside the agent loop, with its own latency,
//    cost and failure mode — and a failure there would happen precisely when the
//    context is already full, which is the worst moment to add a way to break.
//    An extractive summary is deterministic, testable offline, and cannot
//    hallucinate a claim id that was never discussed. It is less fluent. Fluency
//    is not what is needed from it.
//
// 2. IT RECORDS WHAT WAS DONE, NOT WHAT WAS SAID. Tool calls and their outcomes
//    are the load-bearing part of these sessions. Prose gets summarised to its
//    first sentence; a submitted claim, a parsed remittance and a refused
//    approval are named individually, because "we discussed a claim" is not
//    something anyone can act on.
//
// Nothing here writes to the database or calls a provider — both live in the
// wrapper. These functions take messages and return messages.

/** Identifier shapes worth carrying across a compaction boundary. */
const CLAIM_ID = /\b[A-Z]{2,6}[-_]?\d{3,10}\b/g;
const CPT = /\b\d{5}\b/g;
const ICD10 = /\b[A-TV-Z]\d[0-9A-Z](?:\.[0-9A-Z]{1,4})?\b/g;
const CARC = /\bCARC[- ]?(\d{1,3})\b/gi;

export interface CompactionPlan {
  /** Messages kept verbatim. Always the most recent ones. */
  keep: NormalizedMessage[];
  /** Messages folded into the summary. */
  dropped: NormalizedMessage[];
  /** True when nothing needed to happen. */
  noop: boolean;
}

/**
 * Decide where to cut.
 *
 * Cuts only where the next kept message is a plain user message, so a `tool_use`
 * is never separated from its `tool_result` — a provider rejects that pairing
 * outright, and the failure surfaces as an opaque 400 rather than as anything
 * resembling its cause.
 *
 * `reserve` is the share of the budget left for the summary and the reply. Without
 * it, compaction fills the window to exactly the limit and the next round has to
 * compact again immediately, which produces a session that spends most of its
 * tokens summarising itself.
 */
export function planCompaction(
  messages: NormalizedMessage[],
  tokenBudget: number,
  reserve = 0.15,
): CompactionPlan {
  if (estimateTokens(messages) <= tokenBudget) {
    return { keep: messages, dropped: [], noop: true };
  }
  const target = Math.max(1, Math.floor(tokenBudget * (1 - reserve)));

  let cut = 0;
  const safeCuts: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user" && m.content.every((b) => b.type === "text")) safeCuts.push(i);
  }
  for (const c of safeCuts) {
    if (estimateTokens(messages.slice(c)) <= target) {
      cut = c;
      break;
    }
    cut = c;
  }
  // No safe cut exists — a single turn is over budget on its own. Keeping it
  // whole is right: the alternative is handing the provider a broken tool_use
  // pairing, which fails the request rather than shortening it.
  if (cut === 0) return { keep: messages, dropped: [], noop: true };

  return { keep: messages.slice(cut), dropped: messages.slice(0, cut), noop: false };
}

export interface SessionFacts {
  /** Tools called, in first-use order, with how many times each ran. */
  tools: Array<{ name: string; calls: number; lastResult: string }>;
  claimIds: string[];
  cptCodes: string[];
  icd10Codes: string[];
  carcCodes: string[];
  /** The user's opening ask, which is usually the thing the whole session is about. */
  opening: string;
  /** The last thing the assistant concluded before the cut. */
  lastConclusion: string;
  /** Tool calls that came back as errors. Kept because a retry of a failure is a different act. */
  failures: string[];
}

function uniqueMatches(text: string, pattern: RegExp, cap: number, group = 0): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
    const value = (m[group] ?? m[0]).toUpperCase();
    if (!out.includes(value)) out.push(value);
    if (out.length >= cap) break;
  }
  return out;
}

/** Pull the facts worth keeping out of the messages about to be dropped. */
export function extractFacts(dropped: NormalizedMessage[]): SessionFacts {
  const tools = new Map<string, { name: string; calls: number; lastResult: string }>();
  const failures: string[] = [];
  const nameById = new Map<string, string>();
  let opening = "";
  let lastConclusion = "";
  let prose = "";

  for (const m of dropped) {
    for (const b of m.content) {
      if (b.type === "text") {
        prose += ` ${b.text}`;
        if (m.role === "user" && opening === "") opening = b.text.slice(0, 300).trim();
        if (m.role === "assistant" && b.text.trim() !== "") lastConclusion = b.text.slice(-400).trim();
      } else if (b.type === "tool_use") {
        nameById.set(b.id, b.name);
        prose += ` ${JSON.stringify(b.input)}`;
        const entry = tools.get(b.name) ?? { name: b.name, calls: 0, lastResult: "" };
        entry.calls += 1;
        tools.set(b.name, entry);
      } else if (b.type === "tool_result") {
        const name = nameById.get(b.toolUseId) ?? "";
        prose += ` ${b.content}`;
        const entry = tools.get(name);
        if (entry) entry.lastResult = b.content.slice(0, 200).replace(/\s+/g, " ").trim();
        if (b.isError) {
          // Named, because "we tried and it failed" changes what should happen
          // next. A model that does not know a submit already failed will
          // cheerfully suggest submitting.
          failures.push(`${name || "a tool"}: ${b.content.slice(0, 160).replace(/\s+/g, " ").trim()}`);
        }
      }
    }
  }

  return {
    tools: [...tools.values()],
    claimIds: uniqueMatches(prose, CLAIM_ID, 12),
    cptCodes: uniqueMatches(prose, CPT, 12),
    icd10Codes: uniqueMatches(prose, ICD10, 12),
    carcCodes: uniqueMatches(prose, CARC, 8, 1),
    opening,
    lastConclusion,
    failures: failures.slice(0, 6),
  };
}

/**
 * Render the facts as the text that stands in for the dropped turns.
 *
 * Written in the second person and labelled as a summary, so the model treats it
 * as its own record rather than as something the user said. A summary that reads
 * like a user message gets answered instead of used.
 */
export function renderSummary(facts: SessionFacts): string {
  const lines: string[] = [
    "[Earlier turns in this session, compacted. This is a record of what happened, not a new request.]",
  ];
  if (facts.opening) lines.push(`The session opened with: ${facts.opening}`);
  if (facts.tools.length > 0) {
    lines.push("Tools already run in this session:");
    for (const t of facts.tools) {
      const times = t.calls > 1 ? ` ×${t.calls}` : "";
      lines.push(`  - ${t.name}${times}${t.lastResult ? ` → ${t.lastResult}` : ""}`);
    }
  }
  if (facts.failures.length > 0) {
    lines.push("Calls that FAILED — do not assume these succeeded:");
    for (const f of facts.failures) lines.push(`  - ${f}`);
  }
  const ids: string[] = [];
  if (facts.claimIds.length) ids.push(`claims/accounts ${facts.claimIds.join(", ")}`);
  if (facts.cptCodes.length) ids.push(`procedure codes ${facts.cptCodes.join(", ")}`);
  if (facts.icd10Codes.length) ids.push(`diagnoses ${facts.icd10Codes.join(", ")}`);
  if (facts.carcCodes.length) ids.push(`CARC ${facts.carcCodes.join(", ")}`);
  if (ids.length > 0) lines.push(`Identifiers discussed: ${ids.join("; ")}.`);
  if (facts.lastConclusion) lines.push(`Where it was left: ${facts.lastConclusion}`);
  lines.push(
    "If the user refers to something not in this summary, say the earlier detail is no longer in context and " +
      "ask, rather than reconstructing it.",
  );
  return lines.join("\n");
}

export interface CompactionResult {
  messages: NormalizedMessage[];
  /** The summary text, for persistence. Empty when no compaction happened. */
  summary: string;
  facts: SessionFacts | null;
  droppedCount: number;
}

/**
 * Compact a history to fit, keeping a summary of what was cut.
 *
 * `priorSummaries` are the summaries from earlier compactions of the same
 * session. They are prepended so a long session does not forget its first hour
 * simply because it has been compacted twice — without this, the second
 * compaction drops the first summary along with everything else and the loss is
 * total but invisible.
 */
export function compactHistory(
  messages: NormalizedMessage[],
  tokenBudget: number,
  priorSummaries: string[] = [],
): CompactionResult {
  const plan = planCompaction(messages, tokenBudget);
  if (plan.noop && priorSummaries.length === 0) {
    return { messages, summary: "", facts: null, droppedCount: 0 };
  }

  const facts = plan.dropped.length > 0 ? extractFacts(plan.dropped) : null;
  const summary = facts ? renderSummary(facts) : "";

  const preamble = [...priorSummaries, summary].filter((s) => s.trim() !== "");
  if (preamble.length === 0) return { messages: plan.keep, summary: "", facts, droppedCount: 0 };

  const head: NormalizedMessage = {
    role: "user",
    content: [{ type: "text", text: preamble.join("\n\n") }],
  };
  return {
    messages: [head, ...plan.keep],
    summary,
    facts,
    droppedCount: plan.dropped.length,
  };
}
