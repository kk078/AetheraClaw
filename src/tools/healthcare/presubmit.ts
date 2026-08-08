import { calculateEm } from "./em-calculator.js";

// ── Pre-submission gate, and E/M level risk ──────────────────────────────────
// Two things live here. Both are compositions of checks that already existed
// separately, and in both cases the composition is the point: a biller who has
// to run four tools and reconcile four outputs runs one of them.
//
// The E/M half deserves a note, because the proposed design had it backwards in
// a way that matters. It compared a billed code against a level "the clinical
// note supports" and returned invalid when the billed level was higher. That
// direction is right, but it is only half the exposure, and it is the half that
// costs less.
//
//   Billed ABOVE what is documented is UPCODING. It is a False Claims Act
//   exposure, it is what an E/M audit looks for, and every dollar of it is
//   repayable with penalties.
//
//   Billed BELOW what is documented is UNDERCODING. It is not a compliance
//   problem, and it is money the practice earned and did not bill. In an
//   audited population it is also the single most common finding — and a tool
//   that reports only the first direction quietly teaches a practice to
//   downcode defensively, which is how a compliant practice ends up under its
//   own peer benchmark and *invites* the audit it was avoiding.
//
// So both directions are reported, with opposite remedies, and neither is
// presented as an instruction to change the code: the record decides the level,
// and if the level and the record disagree the answer may be that the record is
// incomplete.

export type EmDirection = "supported" | "above_documentation" | "below_documentation";

export interface EmRisk {
  direction: EmDirection;
  billedCode: string;
  supportedCode: string;
  /** Levels apart. 2 is a materially different claim, not a judgement call. */
  distance: number;
  severity: "error" | "warning" | "info";
  message: string;
  remedy: string;
}

const NEW_LADDER = ["99202", "99203", "99204", "99205"];
const ESTABLISHED_LADDER = ["99212", "99213", "99214", "99215"];

export function ladderFor(code: string): string[] | undefined {
  if (NEW_LADDER.includes(code)) return NEW_LADDER;
  if (ESTABLISHED_LADDER.includes(code)) return ESTABLISHED_LADDER;
  return undefined;
}

/**
 * Compare a billed E/M code against the level the documented MDM supports.
 *
 * Deliberately refuses to compare across the new/established boundary: 99204
 * and 99214 are the same MDM level for different patient types, and treating
 * one as "two levels below" the other would be arithmetic on unrelated ladders.
 */
export function assessEmLevel(
  billedCode: string,
  documented: Parameters<typeof calculateEm>[0],
): EmRisk | { error: string } {
  const billed = billedCode.trim();
  const ladder = ladderFor(billed);
  if (!ladder) {
    return {
      error: `${billed} is not an office/outpatient E/M code (99202–99205 new, 99212–99215 established). The 2021 MDM guidelines this scorer implements apply to those only.`,
    };
  }
  const expectedLadder = documented.patient_type === "new" ? NEW_LADDER : ESTABLISHED_LADDER;
  if (ladder !== expectedLadder) {
    return {
      error: `${billed} is a${expectedLadder === NEW_LADDER ? "n established" : " new"}-patient code but the documentation was scored as ${documented.patient_type}. Fix whichever is wrong before comparing — the two ladders are not comparable level for level.`,
    };
  }

  const supported = calculateEm(documented);
  const billedIndex = ladder.indexOf(billed);
  const supportedIndex = ladder.indexOf(supported.code);
  const distance = billedIndex - supportedIndex;

  if (distance === 0) {
    return {
      direction: "supported",
      billedCode: billed,
      supportedCode: supported.code,
      distance: 0,
      severity: "info",
      message: `${billed} matches the level the documented MDM supports (${supported.level}).`,
      remedy: "Nothing to change. This says the code matches the MDM as scored — not that the note is complete.",
    };
  }

  if (distance > 0) {
    return {
      direction: "above_documentation",
      billedCode: billed,
      supportedCode: supported.code,
      distance,
      // One level apart is a defensible disagreement about how MDM was scored.
      // Two is a different claim, and it is the pattern an audit selects on.
      severity: distance >= 2 ? "error" : "warning",
      message: `${billed} is ${distance} level(s) above the ${supported.code} the documented MDM supports (${supported.level}).`,
      remedy:
        "This is the upcoding direction — a False Claims Act exposure and what an E/M audit looks for. Two outcomes are legitimate: the level comes down to match the record, or the record is amended to reflect what was actually done, contemporaneously and by the provider. Changing the code to fit the note is fine; changing the note to fit the code after the fact is not.",
    };
  }

  return {
    direction: "below_documentation",
    billedCode: billed,
    supportedCode: supported.code,
    distance: Math.abs(distance),
    severity: "info",
    message: `${billed} is ${Math.abs(distance)} level(s) below the ${supported.code} the documented MDM supports (${supported.level}).`,
    remedy:
      "This is undercoding — revenue earned and not billed, and the most common finding in an audited population. It is not a compliance problem, but it is not free either: defensive downcoding pulls a practice under its own peer benchmark, which is itself an audit selection criterion. If the record supports the higher level, bill it.",
  };
}

export function renderEmRisk(risk: EmRisk): string {
  return [
    `${risk.severity.toUpperCase()}: ${risk.message}`,
    `  ${risk.remedy}`,
    "  The record decides the level. If the code and the record disagree, the answer may be that the record is incomplete rather than that the code is wrong.",
  ].join("\n");
}

// ── Pre-submission gate ──────────────────────────────────────────────────────

export interface GateInput {
  scrubFindings: Array<{ severity: string; rule: string; message: string }>;
  /** Predicted denial probability 0–1, or null when there is no history to predict from. */
  denialProbability: number | null;
  denialFactors: string[];
  emRisk?: EmRisk;
  /** Named datasets that were not installed, so the corresponding check did not run. */
  checksNotRun: string[];
}

export type GateVerdict = "hold" | "review" | "clear";

export interface GateResult {
  verdict: GateVerdict;
  reasons: string[];
  /** Checks that could not run. Reported at the top, not buried — see below. */
  blindSpots: string[];
}

/** Above this a claim is worth a coder's eyes before it goes out. */
export const DENIAL_REVIEW_THRESHOLD = 0.35;

/**
 * Decide whether a claim should go out.
 *
 * The verdict is deliberately three-valued. A two-valued gate becomes a rubber
 * stamp: everything that is not blocked reads as approved, so the borderline
 * cases — which are the ones worth a human — go out with the clean ones.
 *
 * `clear` is the strongest claim this makes and it is still narrow: it means
 * nothing that was checked failed. When a dataset is missing, the check did not
 * run, and that is reported as a blind spot at the top of the output rather than
 * as a pass. A gate that says "clear" while silently skipping the NCCI check is
 * worse than no gate, because it converts an absence of information into a
 * statement of safety.
 */
export function evaluateGate(input: GateInput): GateResult {
  const reasons: string[] = [];
  let verdict: GateVerdict = "clear";

  const errors = input.scrubFindings.filter((f) => f.severity === "error");
  const warnings = input.scrubFindings.filter((f) => f.severity === "warning");

  if (errors.length > 0) {
    verdict = "hold";
    reasons.push(`${errors.length} scrub error(s): ${errors.map((e) => e.rule).join(", ")}. These do not adjudicate — the claim rejects or denies as submitted.`);
  }

  if (input.emRisk?.direction === "above_documentation") {
    if (input.emRisk.severity === "error") {
      verdict = "hold";
      reasons.push(`E/M billed ${input.emRisk.distance} levels above the documentation. That is not a scoring disagreement, it is a different claim.`);
    } else if (verdict !== "hold") {
      verdict = "review";
      reasons.push("E/M billed one level above the documented MDM — defensible, but a coder should agree before it goes out.");
    }
  }

  if (input.denialProbability !== null && input.denialProbability >= DENIAL_REVIEW_THRESHOLD) {
    if (verdict === "clear") verdict = "review";
    reasons.push(
      `Predicted denial probability ${(input.denialProbability * 100).toFixed(0)}% from this practice's own history${input.denialFactors.length > 0 ? ` — ${input.denialFactors.join("; ")}` : ""}.`,
    );
  }

  if (warnings.length > 0 && verdict === "clear") {
    verdict = "review";
    reasons.push(`${warnings.length} scrub warning(s): ${warnings.map((w) => w.rule).join(", ")}.`);
  }

  if (input.emRisk?.direction === "below_documentation" && verdict === "clear") {
    verdict = "review";
    reasons.push(
      `E/M billed ${input.emRisk.distance} level(s) BELOW what the documentation supports. Not a compliance problem — revenue left on the table.`,
    );
  }

  return { verdict, reasons, blindSpots: input.checksNotRun };
}

export function renderGate(result: GateResult): string {
  const headline: Record<GateVerdict, string> = {
    hold: "HOLD — do not submit as it stands.",
    review: "REVIEW — a coder should look at this before it goes out.",
    clear: "CLEAR — nothing that was checked failed.",
  };

  const lines = [headline[result.verdict], ""];

  if (result.blindSpots.length > 0) {
    // First, not last. A verdict read without knowing what was skipped is a
    // verdict about a different claim.
    lines.push(
      `NOT CHECKED — ${result.blindSpots.length} check(s) could not run:`,
      ...result.blindSpots.map((b) => `  ${b}`),
      result.verdict === "clear"
        ? '"Clear" above means nothing that ran found a problem. It is not a statement about the checks that did not run — install the missing data (see data_status) before treating this as a pass.'
        : "These are in addition to the findings below, not instead of them.",
      "",
    );
  }

  if (result.reasons.length === 0) {
    lines.push("No scrub errors, no scrub warnings, no elevated denial risk, no E/M level mismatch.");
  } else {
    lines.push(...result.reasons.map((r) => `  ${r}`));
  }

  lines.push(
    "",
    "This gate composes checks that each exist on their own — claim_scrub, denial_risk_score, em_calculate. It does not know anything they do not, and none of them read the chart.",
  );
  return lines.join("\n");
}
