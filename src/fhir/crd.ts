// ── Coverage Requirements Discovery ──────────────────────────────────────────
// The question CRD answers is "does this need prior authorization", asked while
// the order is still being written rather than after the claim is denied. Da
// Vinci does it over CDS Hooks: the EHR fires a hook when an order is drafted
// and the payer's service answers with cards.
//
// A practice with no payer hook endpoint is not stuck, which is the point of
// keeping the local rule table here. Most of the value in CRD is knowing which
// codes a given payer requires authorization for, and that is a list the
// practice can maintain from its own denials — every CARC 197 is the payer
// telling you a code needed authorization it did not get.

export type PaRequirement = "required" | "not_required" | "unknown" | "conditional";

export interface PaRule {
  payer: string;
  code: string;
  requirement: PaRequirement;
  /** When conditional: the circumstance that decides it. */
  condition: string;
  /** Where this came from — a payer policy, a hook response, or a denial. */
  source: string;
  updatedAt: number;
}

export interface CrdRequest {
  payer: string;
  code: string;
  /** Place of service, since authorization often turns on setting. */
  placeOfService: string;
  urgent: boolean;
}

export interface CrdVerdict {
  requirement: PaRequirement;
  reason: string;
  rule: PaRule | null;
  /** What to do next, given the answer. */
  action: string;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeCode(code: string): string {
  return code.replace(/[.\s]/g, "").toUpperCase();
}

/**
 * Answer from the local rule table.
 *
 * Unknown is a real answer and is kept distinct from not_required. A practice
 * that has never seen a denial for a code has no evidence the code is exempt —
 * it may simply never have billed it — and collapsing the two is how a service
 * gets rendered without authorization and denied under CARC 197.
 */
export function checkRequirement(request: CrdRequest, rules: PaRule[]): CrdVerdict {
  const code = normalizeCode(request.code);
  const payer = normalize(request.payer);
  const rule =
    rules.find((r) => normalizeCode(r.code) === code && normalize(r.payer) === payer) ??
    rules.find((r) => normalizeCode(r.code) === code && !r.payer) ??
    null;

  if (!rule) {
    return {
      requirement: "unknown",
      reason: `Nothing on record for ${code} with ${request.payer}. That is not the same as "no authorization needed" — it may just be a code this practice has not billed them before.`,
      rule: null,
      action:
        "Check the payer's policy or run the CRD hook before the service. A service rendered without an authorization it turned out to need denies under CARC 197, and that denial is not appealable on the merits.",
    };
  }

  if (rule.requirement === "conditional") {
    return {
      requirement: "conditional",
      reason: `${rule.code} needs authorization from ${rule.payer || "any payer"} in some circumstances: ${rule.condition}`,
      rule,
      action: "Decide which side of that condition this order falls on before it is scheduled, not after.",
    };
  }

  if (rule.requirement === "required") {
    return {
      requirement: "required",
      reason: `${rule.code} requires prior authorization from ${rule.payer || "any payer"}. Recorded from: ${rule.source}.`,
      rule,
      action: request.urgent
        ? "Submit as expedited. The payer owes a decision within 72 hours of receipt."
        : "Submit now. The payer owes a decision within seven calendar days, so an order scheduled inside a week is already tight.",
    };
  }

  return {
    requirement: "not_required",
    reason: `${rule.code} does not require authorization from ${rule.payer || "any payer"}. Recorded from: ${rule.source}.`,
    rule,
    action: "Proceed. Re-check if the payer publishes a policy update — these lists change without notice.",
  };
}

/**
 * Learn a rule from a denial.
 *
 * CARC 197 is the payer stating, on the record, that the service needed an
 * authorization it did not have. That is the most reliable source of a PA list
 * a practice can get, and it costs one claim to learn each entry.
 */
export const PA_DENIAL_CARCS = ["197", "198", "15"];

export function ruleFromDenial(payer: string, code: string, carc: string, now: number): PaRule | null {
  if (!PA_DENIAL_CARCS.includes(carc)) return null;
  return {
    payer,
    code: normalizeCode(code),
    requirement: "required",
    condition: "",
    source: `denial CARC ${carc}`,
    updatedAt: now,
  };
}

// ── CDS Hooks ────────────────────────────────────────────────────────────────

export interface CdsHookRequest {
  hook: string;
  hookInstance: string;
  context: Record<string, unknown>;
  extension?: Record<string, unknown>;
}

/**
 * Build the CDS Hooks request a payer's CRD service expects.
 *
 * Kept as a pure builder so the shape can be asserted without a payer endpoint.
 * `order-sign` is the hook that matters: `order-select` fires while the
 * clinician is still choosing and produces noise, while order-sign fires once
 * on a decision that has been made.
 */
export function buildCrdHook(request: {
  hookInstance: string;
  patientRef: string;
  userRef: string;
  orderResource: Record<string, unknown>;
}): CdsHookRequest {
  return {
    hook: "order-sign",
    hookInstance: request.hookInstance,
    context: {
      userId: request.userRef,
      patientId: request.patientRef,
      draftOrders: { resourceType: "Bundle", type: "collection", entry: [{ resource: request.orderResource }] },
    },
  };
}

export interface CdsCard {
  summary?: string;
  detail?: string;
  indicator?: string;
  links?: Array<{ label?: string; url?: string; type?: string }>;
  extension?: Record<string, unknown>;
}

export interface CrdResponse {
  requirement: PaRequirement;
  /** A DTR launch link, when the payer offers a questionnaire. */
  dtrLaunchUrl: string;
  cards: string[];
  warnings: string[];
}

/**
 * The words a payer uses for this, and the words it uses to negate them.
 *
 * Kept as one shared alternation because the failure mode of hand-writing each
 * phrasing separately is that the negative list ends up shorter than the
 * positive one. "This service does not require prior authorization" is about the
 * most common way a payer says no, and matching only "no prior authorization"
 * misses it — which reads as unknown at best, and as required at worst.
 */
const AUTH_TERM = "(?:prior[\\s-]?auth\\w*|pre[\\s-]?auth\\w*|precert\\w*|authorization)";

/** Checked FIRST, so a negation is never read as the positive statement inside it. */
const NOT_REQUIRED_RE = new RegExp(
  `(?:\\b(?:no|not|never|without|waive[ds]?|exempt from)\\b(?:\\W+\\w+){0,3}?\\W+${AUTH_TERM})` +
    `|(?:${AUTH_TERM}(?:\\W+\\w+){0,3}?\\W+(?:not required|not needed|is waived))`,
  "i",
);

const REQUIRED_RE = new RegExp(
  `(?:\\b(?:require[sd]?|need[s]?|must obtain|obtain)\\b\\W+(?:\\w+\\W+){0,2}?${AUTH_TERM})` +
    `|(?:${AUTH_TERM}(?:\\W+\\w+){0,2}?\\W+(?:is required|required|is needed|needed|mandatory))`,
  "i",
);

/**
 * Read the payer's cards.
 *
 * The cards are free text written by the payer, so this reads them for the two
 * things that are actionable — whether authorization is required, and whether a
 * DTR questionnaire is offered — and passes the rest through verbatim rather
 * than paraphrasing. A summary of a coverage statement is not a coverage
 * statement.
 */
export function readCrdCards(cards: CdsCard[]): CrdResponse {
  const warnings: string[] = [];
  const texts = cards.map((c) => [c.summary, c.detail].filter(Boolean).join(" — "));
  const joined = texts.join(" ");

  let requirement: PaRequirement = "unknown";
  if (NOT_REQUIRED_RE.test(joined)) requirement = "not_required";
  else if (REQUIRED_RE.test(joined)) requirement = "required";

  const launch = cards
    .flatMap((c) => c.links ?? [])
    .find((l) => l.type === "smart" || /questionnaire|dtr/i.test(l.label ?? ""));

  if (cards.length === 0) {
    warnings.push(
      "The service returned no cards. That means it had nothing to say, not that authorization is unnecessary — treat it as unknown.",
    );
  }
  if (requirement === "unknown" && cards.length > 0) {
    warnings.push(
      "The cards did not state plainly whether authorization is required. Read them below rather than assuming; a summary of a coverage statement is not a coverage statement.",
    );
  }

  return { requirement, dtrLaunchUrl: launch?.url ?? "", cards: texts, warnings };
}

export function renderCrd(verdict: CrdVerdict): string {
  const label: Record<PaRequirement, string> = {
    required: "PRIOR AUTHORIZATION REQUIRED",
    not_required: "No authorization required",
    conditional: "CONDITIONAL — depends on the circumstance",
    unknown: "UNKNOWN",
  };
  return [`${label[verdict.requirement]}`, verdict.reason, "", verdict.action].join("\n");
}
