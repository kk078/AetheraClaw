import type { ClaimScrubView, EmMeterView, MoneyWaterfallView, ToolView } from "./types.js";
import type { Cms1500View } from "./cms1500.js";
import type { AppealLetterView } from "./appeal.js";
import type { BatchHealView } from "./batch-heal.js";

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

/**
 * `preview` is a computed result that has NOT been applied — a dry run, a
 * suggestion, a forecast. It is its own level because green reads as "done":
 * showing a database preview as CLEAR tells somebody the change went through.
 */
export type VerdictLevel = "clear" | "preview" | "review" | "hold";

export interface CardFact {
  label: string;
  value: string;
}

export interface CardSummary {
  /** Human-readable, claim-identified where the view knows the claim. */
  title: string;
  /**
   * What this card is ABOUT — a claim id, where the view has one.
   *
   * Carried as its own field rather than recovered from the title, because the
   * only way to recover it is a regular expression over prose and prose is full
   * of things shaped like claim ids. Run one over "CMS-1500 — CLM-88213" and it
   * answers CMS-1500, which is a form number. A run group that titles itself
   * with the wrong claim is worse than one that titles itself with none.
   */
  subject?: string;
  /** Absent on reports — see the header. */
  verdict?: VerdictLevel;
  verdictLabel?: string;
  /** The single line the verdict rests on. */
  because?: string;
  facts: CardFact[];
}

export const VERDICT_LABELS: Record<VerdictLevel, string> = {
  clear: "CLEAR",
  preview: "DRY RUN",
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
    ...(v.claimId ? { subject: v.claimId } : {}),
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

function cms1500Card(v: Cms1500View): CardSummary {
  const boxed = [
    ...v.header.filter((c) => c.severity !== "clean"),
    ...v.lines.flatMap((l) => l.cells.filter((c) => c.severity !== "clean")),
    ...v.diagnoses.filter((d) => d.severity !== "clean"),
  ];
  const errors = boxed.filter((c) => c.severity === "error").length + v.unattributed.filter((u) => u.severity === "error").length;
  const warnings = boxed.filter((c) => c.severity === "warning").length + v.unattributed.filter((u) => u.severity === "warning").length;
  const verdict: VerdictLevel = v.verdict ?? (errors > 0 ? "hold" : warnings > 0 ? "review" : "clear");

  return {
    title: `CMS-1500 — ${v.claimId || "(no claim id)"}`,
    ...(v.claimId ? { subject: v.claimId } : {}),
    verdict,
    verdictLabel: VERDICT_LABELS[verdict],
    because:
      errors > 0
        ? `${errors} finding(s) at error severity. The boxes carrying them are highlighted on the form.`
        : warnings > 0
          ? `${warnings} warning(s) on the form — billable as it stands, each a thing a payer may ask about.`
          : v.unattributed.length > 0
            ? `Nothing on the form itself. ${v.unattributed.length} finding(s) belong to no box — practice or installation facts rather than claim defects.`
            : "Every check that applies ran, and no box carries a finding.",
    facts: [
      { label: "Billed charge", value: money(v.totalCharge) },
      { label: "Service lines", value: v.lines.length === 0 ? "none" : `${v.lines.length} (boxes 24A–24J)` },
      {
        label: "Boxes flagged",
        // Counted by BOX, not by finding: the form's unit is the field, and two
        // findings in one box is one box a biller has to look at.
        value: boxed.length === 0 ? "none" : [...new Set(boxed.map((c) => ("box" in c ? c.box : `21${c.pointer}`)))].join(", "),
      },
    ],
  };
}

function appealCard(v: AppealLetterView): CardSummary {
  // A letter with unverified citations is HOLD, not review. Sending it is the
  // irreversible step, and the risk is not that the appeal fails — it is that a
  // fabricated policy identifier goes to a federal payer over the practice's
  // name.
  const verdict: VerdictLevel = v.citationWarning?.severity === "error" ? "hold" : v.citationWarning ? "review" : "clear";

  return {
    title: `Appeal — claim ${v.claimId}`,
    ...(v.claimId ? { subject: v.claimId } : {}),
    verdict,
    verdictLabel: VERDICT_LABELS[verdict],
    because:
      v.citationWarning?.text ??
      "Coverage policy is cited and confirmed against the coverage tools. The letter is ready for the billing office to sign.",
    facts: [
      { label: "Payer", value: v.payer || "not stated" },
      { label: "Denial", value: v.carcDescription ? `CARC ${v.carc} — ${v.carcDescription}` : `CARC ${v.carc}` },
      { label: "Editable file", value: v.filePath },
    ],
  };
}

function batchHealCard(v: BatchHealView): CardSummary {
  // REVIEW when a claim needs a person, CLEAR otherwise — and CLEAR is then
  // promoted to DRY RUN by previewCard, because this tool applies nothing. The
  // promotion is not done here: whether a result was applied is a fact about
  // the tool, and this function only ever sees the view.
  const verdict: VerdictLevel = v.needsHuman > 0 ? "review" : "clear";
  const goesOut = v.clean + v.repairable;

  return {
    title: `Batch heal preview — ${v.scope}`,
    verdict,
    verdictLabel: VERDICT_LABELS[verdict],
    because:
      v.needsHuman > 0
        ? `${v.needsHuman} claim(s) need a person. The rest are a repair away, and no repair has been made.`
        : v.total === 0
          ? "No claims in scope, so this is not a statement that the batch is clean."
          : "No claim in this batch needs a decision a person has to make.",
    facts: [
      { label: "In scope", value: v.truncated ? `${v.total} (limit hit — the batch may be larger)` : String(v.total) },
      { label: "Would go out", value: `${goesOut} — ${v.clean} clean, ${v.repairable} after a safe repair` },
      // Excluded rows are shown even at zero. Their absence is the thing that
      // would quietly inflate every other number here.
      { label: "Needs a person", value: v.excluded > 0 ? `${v.needsHuman} (${v.excluded} row(s) unreadable)` : String(v.needsHuman) },
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
    case "cms1500":
      return cms1500Card(view.data as Cms1500View);
    case "appeal_letter":
      return appealCard(view.data as AppealLetterView);
    case "batch_heal":
      return batchHealCard(view.data as BatchHealView);
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
