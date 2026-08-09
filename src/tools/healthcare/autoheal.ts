import { z } from "zod";
import { defineTool } from "../registry.js";
import { ClaimSchema, type ClaimInput } from "./x12/837.js";
import { classifyPos } from "./pos.js";

// ── Automatic claim repair, and its limits ───────────────────────────────────
// Resubmitting a corrected claim without a human looking at it is the highest-
// leverage automation in a billing system and the easiest one to get badly
// wrong, because the failure is silent: the claim goes out, it pays, and
// nobody discovers for two years that the system has been asserting facts the
// record does not support.
//
// So the engine splits every candidate repair into two kinds, and the split is
// the whole design:
//
//   SAFE — the claim contradicts itself or contradicts a format rule, and there
//   is exactly one value that resolves it. Fixing it asserts nothing new about
//   what happened; it only writes down what the claim already said.
//
//   REVIEW — resolving it requires a fact the claim does not contain. These are
//   reported with the question that has to be answered, and they are NEVER
//   applied, no matter how obvious the answer looks.
//
// The proposed rule "update POS 11 to 02/10 when a telehealth modifier is
// present" is the second kind, and it is worth being explicit about why, because
// it looks like the first. Place of service is a factual assertion about where
// the service was furnished. When POS and the modifier disagree, the claim
// contains two contradictory statements and NOTHING IN IT SAYS WHICH ONE IS
// WRONG — the modifier may be the error. Rewriting POS to agree with the
// modifier resolves the contradiction by inventing a fact, and if the visit was
// actually in the office, the automated system has just made a false statement
// on a Medicare claim. The choice between 02 and 10 makes it worse: they are
// distinguished by where the PATIENT was, which the claim does not record at
// all, so even a caller who knew telehealth occurred cannot pick between them
// from claim data.

export type RepairKind = "safe" | "review";

export interface Repair {
  kind: RepairKind;
  rule: string;
  /** Line index, or undefined for a claim-level repair. */
  line?: number;
  detail: string;
  /** Present on safe repairs: what it was, what it becomes. */
  from?: string;
  to?: string;
  /** Present on review repairs: what a human has to establish. */
  question?: string;
}

export interface AutohealResult {
  claim: ClaimInput;
  applied: Repair[];
  needsReview: Repair[];
}

const TELEHEALTH_MODIFIERS = new Set(["95", "93", "GT", "GQ", "FQ", "FR"]);
const TELEHEALTH_POS = new Set(["02", "10"]);

/** Dates the 837 carries as YYYYMMDD; anything else is a formatting slip, not a claim about the calendar. */
function normalizeDate(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (/^\d{8}$/.test(trimmed)) return undefined; // already correct
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(trimmed);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  const us = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(trimmed);
  // MM/DD/YYYY is unambiguous only because the 837 has no DD/MM form; a
  // two-digit year would be, so it is deliberately not handled.
  if (us) return `${us[3]}${us[1]}${us[2]}`;
  return undefined;
}

/**
 * Repair what can be repaired; report the rest as questions.
 *
 * Pure: takes a claim, returns a new claim plus both lists. The caller decides
 * whether to persist, and approval still gates the write.
 */
export function autohealClaim(claim: ClaimInput): AutohealResult {
  const applied: Repair[] = [];
  const needsReview: Repair[] = [];
  const next: ClaimInput = { ...claim, service_lines: claim.service_lines.map((l) => ({ ...l })) };

  // ── SAFE: reformat a date that is already unambiguous ──────────────────────
  for (const [i, line] of next.service_lines.entries()) {
    const fixed = normalizeDate(line.service_date);
    if (fixed) {
      applied.push({
        kind: "safe",
        rule: "date-format",
        line: i + 1,
        detail: "Service date reformatted to the YYYYMMDD the 837 requires. The date itself is unchanged.",
        from: line.service_date,
        to: fixed,
      });
      line.service_date = fixed;
    }
  }

  // ── SAFE: pad a place of service the form left as one digit ────────────────
  for (const [i, line] of next.service_lines.entries()) {
    const raw = line.place_of_service.trim();
    if (/^\d$/.test(raw)) {
      const padded = `0${raw}`;
      applied.push({
        kind: "safe",
        rule: "pos-width",
        line: i + 1,
        detail: "Place of service padded to two digits. This changes the representation, not the setting.",
        from: raw,
        to: padded,
      });
      line.place_of_service = padded;
    }
  }

  // ── REVIEW: a place of service that carries no meaning ─────────────────────
  for (const [i, line] of next.service_lines.entries()) {
    const status = classifyPos(line.place_of_service);
    if (status.status === "known") continue;
    needsReview.push({
      kind: "review",
      rule: "pos-unknown",
      line: i + 1,
      detail: `Place of service "${line.place_of_service}" is ${status.status === "unassigned" ? "an unassigned code in the CMS set" : "not a place of service code"}. The claim will reject.`,
      question: "Where was this service actually furnished? Look the setting up with pos_lookup — this cannot be guessed from the rest of the claim.",
    });
  }

  // ── REVIEW: telehealth modifier disagreeing with place of service ──────────
  for (const [i, line] of next.service_lines.entries()) {
    const mods = line.modifiers ?? [];
    const hasTelehealthModifier = mods.some((m) => TELEHEALTH_MODIFIERS.has(m.trim().toUpperCase()));
    const posIsTelehealth = TELEHEALTH_POS.has(line.place_of_service);
    if (hasTelehealthModifier === posIsTelehealth) continue;

    needsReview.push({
      kind: "review",
      rule: "telehealth-mismatch",
      line: i + 1,
      detail: hasTelehealthModifier
        ? `Line carries a telehealth modifier but POS ${line.place_of_service}. The claim states two contradictory things about where the service happened.`
        : `Line is POS ${line.place_of_service} (telehealth) but carries no telehealth modifier.`,
      question: hasTelehealthModifier
        ? "Was this visit furnished by telecommunication, or is the modifier wrong? Nothing on the claim decides it, and if the visit was in the office, changing POS to match the modifier puts a false statement on a Medicare claim. If it WAS telehealth: 10 if the patient was at home, 02 if anywhere else — a fact the claim does not record."
        : "Was this telehealth (add the modifier the payer requires) or was the place of service entered wrongly? Check the encounter, not the claim.",
    });
  }

  // ── REVIEW: diagnosis pointer with nothing behind it ───────────────────────
  for (const [i, line] of next.service_lines.entries()) {
    const dangling = (line.dx_pointers ?? []).filter((p) => p > next.diagnoses.length);
    if (dangling.length === 0) continue;
    needsReview.push({
      kind: "review",
      rule: "dx-pointer-dangling",
      line: i + 1,
      detail: `Pointer(s) ${dangling.join(", ")} reference diagnoses beyond the ${next.diagnoses.length} on this claim.`,
      // Dropping the pointer would silently change which diagnosis justifies the
      // service — a medical-necessity assertion, not a formatting fix.
      question: "Which diagnosis supports this line? Dropping the dangling pointer would change what the claim says justified the service, so it is not a formatting repair.",
    });
  }

  return { claim: next, applied, needsReview };
}

export function renderAutoheal(result: AutohealResult): string {
  const { applied, needsReview } = result;
  if (applied.length === 0 && needsReview.length === 0) {
    return "Nothing to repair — no formatting defect and no internal contradiction found. This is not a statement that the claim will pay; run claim_scrub for the rule checks.";
  }

  const lines: string[] = [];
  if (applied.length > 0) {
    lines.push(`${applied.length} repair(s) applied. Each writes down what the claim already said; none asserts anything new:`);
    for (const r of applied) {
      lines.push(`  [${r.rule}]${r.line ? ` line ${r.line}` : ""}  ${r.from} → ${r.to}`, `      ${r.detail}`);
    }
  } else {
    lines.push("No repair could be applied automatically.");
  }

  if (needsReview.length > 0) {
    lines.push(
      "",
      `${needsReview.length} item(s) NOT repaired. Each needs a fact the claim does not contain:`,
    );
    for (const r of needsReview) {
      lines.push(`  [${r.rule}]${r.line ? ` line ${r.line}` : ""}  ${r.detail}`, `      → ${r.question}`);
    }
    lines.push(
      "",
      "These are deliberately left alone. An automated correction that resolves a contradiction by picking one side is inventing a fact, and on a Medicare claim an invented fact is a false statement — the point of auto-repair is to remove typing, not to decide what happened.",
    );
  }
  return lines.join("\n");
}

export const claimAutohealTool = defineTool({
  name: "claim_autoheal",
  description:
    "Repair the formatting and internal-consistency defects in a claim that have exactly one correct answer, and report the rest as questions. A repair is applied only when it writes down what the claim already said; anything needing a fact the claim does not contain — which place of service was true when POS and a telehealth modifier disagree, which diagnosis a dangling pointer meant — is returned unrepaired with the question attached. Run claim_scrub afterwards for the rule checks; this only fixes what can be fixed without deciding what happened.",
  schema: z.object({
    claim: ClaimSchema,
    return_claim: z
      .boolean()
      .default(false)
      .describe("Include the repaired claim JSON in the output, ready to pass to claim_scrub or claim_build_837p"),
  }),
  execute: async (input) => {
    const result = autohealClaim(input.claim as ClaimInput);
    const parts = [renderAutoheal(result)];
    if (input.return_claim && result.applied.length > 0) {
      parts.push("", "Repaired claim:", JSON.stringify(result.claim, null, 2));
    }
    return { content: parts.join("\n") };
  },
});
