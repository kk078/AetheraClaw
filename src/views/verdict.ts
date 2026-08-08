import type { ClaimScrubView, EmMeterView, MoneyWaterfallView, ToolView } from "./types.js";

// ── Card summaries ───────────────────────────────────────────────────────────
// The console showed a vertical stack of `tool_invoke` boxes tagged done/error.
// "done" is a statement about the process — the tool ran — and it was sitting
// where a biller looks for a statement about the CLAIM. A scrub that found two
// errors and a scrub that found none both said "done".
//
// So a view may now carry a CARD: a verdict badge, the one line it rests on, and
// the two or three facts worth reading without expanding anything.
//
// WHERE THE VERDICT COMES FROM, AND WHY IT IS NOT COMPUTED IN THE BROWSER.
// It would be four lines of JavaScript to look for "error" in the tool's text
// and paint the badge red. That is the same mistake as re-deriving severity in
// the UI, and worse, because a badge is more trusted than the prose under it: a
// green CLEAR on a claim with a dangling diagnosis pointer is a wrong answer
// delivered with more confidence than the right one. Verdicts are computed here,
// from the STRUCTURED view the rule engine produced, and they are tested.
//
// WHICH VIEWS GET A BADGE. Only the ones that answer "should this go out?" —
// a scrub, an E/M level check. A money waterfall and a KPI panel are reports:
// they get facts and no badge, because there is no gate for a badge to describe
// and inventing one would make "CLEAR" mean two different things in two places.

export type VerdictLevel = "clear" | "review" | "hold";

export interface CardFact {
  label: string;
  value: string;
}

export interface CardSummary {
  /** Human-readable, claim-identified where the view knows the claim. */
  title: string;
  /** Absent on reports — see the header. */
  verdict?: VerdictLevel;
  verdictLabel?: string;
  /** The single line the verdict rests on. */
  because?: string;
  facts: CardFact[];
}

export const VERDICT_LABELS: Record<VerdictLevel, string> = {
  clear: "CLEAR",
  review: "REVIEW NEEDED",
  hold: "HOLD",
};

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function scrubCard(v: ClaimScrubView): CardSummary {
  const errors = v.counts.error ?? 0;
  const warnings = v.counts.warning ?? 0;
  const clean = v.counts.clean ?? 0;

  // The view's own verdict wins where the builder set one — it is the same
  // field the renderer already trusts, and two verdicts for one scrub is the
  // discrepancy nobody can explain. Derived only as a fallback.
  const verdict: VerdictLevel = v.verdict ?? (errors > 0 ? "hold" : warnings > 0 ? "review" : "clear");

  const because =
    errors > 0
      ? `${errors} error(s) must be fixed before submission — an error is a finding that cannot be adjudicated as billed.`
      : warnings > 0
        ? `${warnings} warning(s): billable as it stands, but each is a thing a payer may ask about.`
        : v.blindSpots.length > 0
          ? `Nothing that ran found a problem. ${v.blindSpots.length} check(s) could NOT run — see the panel; "clear" is not a statement about those.`
          : "No findings. Every check that applies to this claim ran and passed.";

  return {
    title: `Claim scrub — ${v.claimId || "(no claim id)"}`,
    verdict,
    verdictLabel: VERDICT_LABELS[verdict],
    because,
    facts: [
      { label: "Billed charge", value: money(v.totalCharge) },
      { label: "Payer", value: v.payer || "not stated" },
      {
        label: "Lines",
        value:
          v.lines.length === 0
            ? "none"
            : `${v.lines.length} — ${clean} clean${errors ? `, ${errors} error` : ""}${warnings ? `, ${warnings} warning` : ""}`,
      },
    ],
  };
}

function emCard(v: EmMeterView): CardSummary {
  // Both directions are reportable and only one is a compliance problem.
  // Undercoding is money earned and not billed — REVIEW, not HOLD, because
  // holding a claim that is merely under-billed delays cash to fix nothing.
  const verdict: VerdictLevel =
    v.direction === "supported" ? "clear" : v.direction === "above_documentation" ? "hold" : "review";

  return {
    title: `E/M level — billed ${v.billedCode}`,
    verdict,
    verdictLabel: VERDICT_LABELS[verdict],
    because:
      v.direction === "supported"
        ? "The billed code matches the level the documented MDM supports. That is not a statement that the note is complete."
        : v.direction === "above_documentation"
          ? "Billed above what the documentation supports. This is the direction an E/M audit selects on, and the record decides the level."
          : "Billed below what the documentation supports — revenue earned and not billed. Not a compliance problem, and the more common one.",
    facts: [
      { label: "Billed", value: v.billedCode },
      { label: "Documentation supports", value: v.supportedCode },
      { label: "Distance", value: v.distance === 0 ? "same level" : `${v.distance} level(s)` },
    ],
  };
}

function waterfallCard(v: MoneyWaterfallView): CardSummary {
  return {
    title: v.title,
    facts: [
      {
        label: v.reclaimableLabel || "Reclaimable",
        // Null is "not computable", never $0.00 — a zero here reads as a
        // measurement saying there is nothing to recover.
        value: v.reclaimable === null ? "not computable" : money(v.reclaimable),
      },
      { label: "Steps", value: String(v.steps.length) },
    ],
  };
}

/**
 * The card for a view, or null when the view carries nothing card-worthy.
 *
 * Null rather than a placeholder: a card with a title and no content is worse
 * than no card, because it takes the vertical space that made cards worth doing.
 */
export function summarize(view: ToolView): CardSummary | null {
  switch (view.kind) {
    case "claim_scrub":
      return scrubCard(view.data as ClaimScrubView);
    case "em_meter":
      return emCard(view.data as EmMeterView);
    case "money_waterfall":
      return waterfallCard(view.data as MoneyWaterfallView);
    case "kpi_tiles":
      // The tiles ARE the summary; a card above them would restate them.
      return null;
    default:
      return null;
  }
}

/** Attach the card to a view on its way to the UI and the store. */
export function withCard(view: ToolView): ToolView {
  const card = summarize(view);
  return card ? { ...view, card } : view;
}
