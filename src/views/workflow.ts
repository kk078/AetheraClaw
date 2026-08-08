import { VERDICT_LABELS, type CardSummary, type VerdictLevel } from "./verdict.js";

// ── Grouping a turn's tool calls into one card ───────────────────────────────
// The console rendered one card per tool call, in order. A single question like
// "scrub this claim and check the E/M level" therefore produced a vertical
// stack of six boxes, three of which were the model looking things up in its own
// catalogue. That is a debug log with rounded corners.
//
// A turn is one thing the user asked for, so a turn is one card. Inside it,
// plumbing collapses into the telemetry drawer and the domain tools become
// sections.
//
// The RULES live here rather than in the browser, for the reason the whole view
// layer exists: deciding that a call is plumbing, or that a group holds at HOLD
// rather than CLEAR, is a judgement. A judgement made in views.js cannot be
// tested and drifts from the engine that produced it.

/**
 * Calls that are the model finding its way around, not work the user asked for.
 *
 * `tool_invoke` is here because it is a WRAPPER — its card would say
 * "tool_invoke" above a result produced by something else entirely. The inner
 * tool is what happened, and that is what gets the section.
 */
export const PLUMBING_TOOLS: ReadonlySet<string> = new Set(["tool_search", "tool_describe", "tool_invoke"]);

export function isPlumbing(toolName: string): boolean {
  return PLUMBING_TOOLS.has(toolName);
}

/**
 * Severity order. HOLD outranks everything because it is the only one that says
 * do not submit.
 *
 * `preview` sits between clear and review: a dry run is not a problem found, it
 * is a change not yet made — and a card that shows a database preview in green
 * reads as "done".
 */
export const VERDICT_RANK: Record<VerdictLevel, number> = {
  clear: 0,
  preview: 1,
  review: 2,
  hold: 3,
};

/** The verdict a group carries: the worst of its parts, or none if it has none. */
export function worstVerdict(levels: Array<VerdictLevel | undefined>): VerdictLevel | undefined {
  const present = levels.filter((l): l is VerdictLevel => Boolean(l));
  if (present.length === 0) return undefined;
  return present.reduce((worst, l) => (VERDICT_RANK[l] > VERDICT_RANK[worst] ? l : worst));
}

/** Verdicts that assert nothing is wrong. They may not be claimed on partial evidence. */
const REASSURING: ReadonlySet<VerdictLevel> = new Set<VerdictLevel>(["clear", "preview"]);

/**
 * The badge a whole run group carries, which is NOT simply the worst of it.
 *
 * The rule is asymmetric, and the asymmetry is the point.
 *
 *   REVIEW and HOLD propagate from any one section. They say something is
 *   wrong, and a group holding one bad section is a group somebody has to look
 *   at. Surfacing it from a subset under-claims at worst.
 *
 *   CLEAR and DRY RUN require EVERY section to carry a verdict. They say
 *   nothing is wrong, or nothing happened — statements about the whole group —
 *   and a section with no verdict is a section whose outcome is unknown.
 *
 * This exists because of a real screenshot: a turn that built two 837P claims
 * and then ran the batch preview came out headed DRY RUN. Two claims had been
 * written to the database. Only the preview carried a verdict, so worst-of
 * found DRY RUN and painted the whole turn "nothing happened" — the exact
 * failure the DRY RUN level was added to prevent, one level up.
 */
export function groupVerdict(levels: Array<VerdictLevel | undefined>): VerdictLevel | undefined {
  const worst = worstVerdict(levels);
  if (!worst) return undefined;
  if (REASSURING.has(worst) && levels.some((l) => !l)) return undefined;
  return worst;
}

export interface GroupSection {
  toolName: string;
  title: string;
  verdict?: VerdictLevel;
  /** Claim id, where the section names one — used to title the group. */
  subject?: string;
}

export interface GroupHeadline {
  title: string;
  verdict?: VerdictLevel;
  /** One line under the title: what ran, and how much of it was plumbing. */
  detail: string;
}

const MAX_TITLE_PARTS = 3;

/**
 * A title for the whole group.
 *
 * Built from what actually ran rather than from the user's prompt: a prompt is
 * what somebody asked for and a card should say what happened, and those differ
 * exactly when it matters.
 */
export function groupHeadline(sections: GroupSection[], plumbingCalls: number): GroupHeadline {
  if (sections.length === 0) {
    return {
      title: plumbingCalls > 0 ? "Catalogue search" : "No tools run",
      detail:
        plumbingCalls > 0
          ? `${plumbingCalls} catalogue call(s) and nothing else — the model looked for a tool and did not run one.`
          : "The model answered without running anything.",
    };
  }

  // Every section about the same claim titles the group with it. Mixed subjects
  // get no subject rather than the first one, which would be a claim id
  // attached to work done on a different claim.
  const subjects = [...new Set(sections.map((s) => s.subject).filter(Boolean))];
  const subject = subjects.length === 1 ? subjects[0] : undefined;

  const names = [...new Set(sections.map((s) => s.title))];
  const shown = names.slice(0, MAX_TITLE_PARTS).join(" · ");
  const more = names.length > MAX_TITLE_PARTS ? ` +${names.length - MAX_TITLE_PARTS} more` : "";

  const counted = `${sections.length} tool${sections.length === 1 ? "" : "s"}`;
  const hidden = plumbingCalls > 0 ? `, ${plumbingCalls} catalogue call(s) collapsed` : "";

  return {
    title: `${shown}${more}${subject ? ` — ${subject}` : ""}`,
    verdict: groupVerdict(sections.map((s) => s.verdict)),
    detail: `${counted}${hidden}.`,
  };
}

/**
 * Tools whose result is a PREVIEW: computed, shown, and not applied.
 *
 * Named explicitly rather than matched on "preview" in the name, because the
 * consequence of getting it wrong runs one way. A tool wrongly called a preview
 * would show a real database write in a colour that says nothing happened.
 *
 * Every name here was checked against its `execute` for a write. `code_suggest`
 * was on this list and has been removed: it reads like a proposal, and it
 * INSERTs a pending row into the review queue. A row somebody has to action is
 * not nothing happening.
 */
export const PREVIEW_TOOLS: ReadonlySet<string> = new Set([
  "ops_batch_heal_preview",
  "claim_autoheal",
  "appeal_triage",
  "credit_balance_detect",
  "credit_balance_recoupments",
  "swarm_plan",
  "simulate_scenario",
  "cash_forecast",
]);

export function isPreview(toolName: string): boolean {
  return PREVIEW_TOOLS.has(toolName);
}

/** The sentence a preview card leads with, so the badge is never the only signal. */
export const PREVIEW_BECAUSE = "Nothing has been applied. This is a computed preview of what would happen.";

/**
 * Re-badge a preview tool's card from CLEAR to DRY RUN.
 *
 * Only CLEAR is promoted. A preview that came back REVIEW or HOLD found
 * something, and softening that to "dry run" would bury a real finding under a
 * label about process — the failure this level exists to prevent, running the
 * other way.
 */
export function previewCard(card: CardSummary, toolName: string): CardSummary {
  if (!isPreview(toolName) || card.verdict !== "clear") return card;
  return {
    ...card,
    verdict: "preview",
    verdictLabel: VERDICT_LABELS.preview,
    because: card.because ? `${PREVIEW_BECAUSE} ${card.because}` : PREVIEW_BECAUSE,
  };
}
