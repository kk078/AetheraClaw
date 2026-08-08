// ── Structured tool views ────────────────────────────────────────────────────
// Until now every tool returned one thing: a string. That string had to serve
// two audiences at once — the model, which reads it as context, and the person,
// who reads it in the transcript. Prose is right for the first and wrong for the
// second: a coder working two hundred lines a day cannot scan bullet points for
// the one line missing a modifier, and a manager cannot see an underpayment in a
// sentence.
//
// So a tool may now return a VIEW alongside its text. Three properties matter:
//
//   The text is unchanged. The model still gets exactly the string it got
//   before, so no tool's behaviour in the agent loop changes and no prompt has
//   to be rewritten.
//
//   The view never enters the model's context. It is stored in its own table
//   and streamed to the UI directly. A rendered claim form would be thousands of
//   tokens of JSON the model already has in prose form — paying for it twice
//   would be the whole cost of this feature with none of the benefit.
//
//   The payloads are built by pure functions here, not assembled in the UI.
//   Deciding that a finding is an error rather than a warning is a domain
//   judgement, and it belongs next to the rules that made it — not in a
//   browser, where it cannot be tested and will drift from the engine.

import type { CardSummary } from "./verdict.js";

export type ViewKind = "claim_scrub" | "money_waterfall" | "em_meter" | "kpi_tiles" | "cms1500" | "appeal_letter";

export interface ToolView {
  kind: ViewKind;
  data: unknown;
  /**
   * Headline verdict and facts for the console card. Attached on the way out
   * (see verdict.ts) rather than built by each tool, and deliberately computed
   * on the server: a badge is trusted more than the prose beneath it, so a
   * green CLEAR derived by pattern-matching text in a browser would be a wrong
   * answer delivered with more confidence than the right one.
   */
  card?: CardSummary;
}

// ── claim_scrub ──────────────────────────────────────────────────────────────

export type LineSeverity = "error" | "warning" | "info" | "clean";

export interface ClaimLineView {
  index: number;
  code: string;
  modifiers: string[];
  units: number;
  charge: number;
  serviceDate: string;
  pos: string;
  posName: string;
  dxPointers: number[];
  severity: LineSeverity;
  findings: ClaimFindingView[];
}

export interface ClaimFindingView {
  severity: LineSeverity;
  rule: string;
  message: string;
  /**
   * A repair the system is willing to apply on its own.
   *
   * Present ONLY for corrections that write down what the claim already said —
   * a date reformatted, a place of service padded. Anything requiring a fact the
   * claim does not contain carries a `question` instead, and the UI must not
   * offer a button for it. A one-click "accept fix" on a POS/telehealth mismatch
   * would put a false statement on a Medicare claim with a single click, which
   * is precisely the failure claim_autoheal exists to prevent.
   */
  fix?: { from: string; to: string; describe: string };
  /** What a human has to establish. Renders as a prompt, never as a button. */
  question?: string;
}

export interface ClaimScrubView {
  claimId: string;
  payer: string;
  totalCharge: number;
  lines: ClaimLineView[];
  /** Findings that belong to the claim rather than to one line. */
  claimFindings: ClaimFindingView[];
  counts: Record<LineSeverity, number>;
  /** Checks that could not run. Rendered above the verdict, never below it. */
  blindSpots: string[];
  verdict?: "hold" | "review" | "clear";
}

// ── money_waterfall ──────────────────────────────────────────────────────────

export interface WaterfallStep {
  label: string;
  /** Signed: negative steps are reductions. */
  amount: number;
  kind: "start" | "reduction" | "recovery" | "end";
  note: string;
}

export interface MoneyWaterfallView {
  title: string;
  steps: WaterfallStep[];
  /** The number a manager acts on. Null when it could not be computed — never zero as a stand-in. */
  reclaimable: number | null;
  reclaimableLabel: string;
  /** Why `reclaimable` is null, or what the figure does and does not include. */
  caveat: string;
}

// ── em_meter ─────────────────────────────────────────────────────────────────

export interface EmMeterView {
  ladder: string[];
  billedCode: string;
  supportedCode: string;
  direction: "supported" | "above_documentation" | "below_documentation";
  distance: number;
  severity: "error" | "warning" | "info";
  /** Element-by-element, so the meter is explainable rather than a verdict. */
  elements: Array<{ label: string; level: string }>;
  message: string;
  remedy: string;
}

// ── kpi_tiles ────────────────────────────────────────────────────────────────

export interface KpiTileView {
  label: string;
  /** Null renders as "not computable" — never as 0, which reads as a measurement. */
  value: number | null;
  unit: "days" | "percent" | "dollars";
  /** 0–1 for ring-style tiles; omitted when the metric has no natural ceiling. */
  fraction?: number;
  detail: string;
  note: string;
}

export interface KpiTilesView {
  tiles: KpiTileView[];
}

/** Narrow a tool's view payload for a renderer without an unchecked cast. */
export function isView<K extends ViewKind>(view: ToolView | undefined, kind: K): view is ToolView & { kind: K } {
  return view?.kind === kind;
}
