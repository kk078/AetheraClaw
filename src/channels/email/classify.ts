// ── Payer correspondence classification ──────────────────────────────────────
// A billing inbox is not a mailbox, it is an unsorted work queue with clocks
// already running inside it. An ADR letter starts a 45-day records deadline the
// moment it is received; an overpayment demand starts a recoupment clock; a
// revalidation notice has a date after which the provider simply cannot bill.
// Reading these as "email" loses all of that, so each message is classified into
// the RCM artifact it actually is and the dates are pulled out with it.

export type CorrespondenceKind =
  | "records_request"
  | "audit_notice"
  | "denial"
  | "appeal_determination"
  | "overpayment_demand"
  | "revalidation"
  | "policy_bulletin"
  | "clearinghouse_rejection"
  | "eft_era_enrollment"
  | "patient_billing"
  | "other";

export interface KindRule {
  kind: CorrespondenceKind;
  /** Higher wins when several rules match. */
  weight: number;
  patterns: RegExp[];
  /** Which tool should take it from here. */
  routeTo: string;
  why: string;
}

/**
 * Ordered by how expensive it is to miss the message, not by how common it is.
 * A misfiled policy bulletin costs nothing; a misfiled ADR costs the claim.
 */
export const KIND_RULES: KindRule[] = [
  {
    kind: "records_request",
    weight: 100,
    patterns: [
      /additional\s+documentation\s+request/i,
      /\bADR\b/,
      /request\s+for\s+(medical\s+)?records/i,
      /submit\s+(the\s+)?(medical\s+)?records/i,
      /documentation\s+request\s+letter/i,
    ],
    routeTo: "audit_track",
    why: "A records request runs a short response clock — commonly 45 days — and missing it denies the claim on the documentation rather than the merits.",
  },
  {
    kind: "audit_notice",
    weight: 95,
    patterns: [
      /\bRAC\b|recovery\s+audit/i,
      /targeted\s+probe\s+and\s+educate|\bTPE\b/i,
      /\bUPIC\b|unified\s+program\s+integrity/i,
      /\bSMRC\b|supplemental\s+medical\s+review/i,
      /\bCERT\b|comprehensive\s+error\s+rate/i,
      /post[-\s]?payment\s+review/i,
    ],
    routeTo: "audit_track",
    why: "A contractor audit has its own response and appeal ladder; tracking it late compresses every deadline behind it.",
  },
  {
    kind: "overpayment_demand",
    weight: 90,
    patterns: [
      /overpayment/i,
      /demand\s+letter/i,
      /recoup(ment|ed|ing)?\b/i,
      /refund\s+(is\s+)?(due|requested|required)/i,
      /amount\s+(due|owed)\s+to\s+(us|the\s+plan|medicare)/i,
    ],
    routeTo: "credit_balance_add",
    why: "Recoupment begins on a fixed day from the demand letter unless a redetermination is filed first, so the letter date matters more than the amount.",
  },
  {
    kind: "appeal_determination",
    weight: 85,
    patterns: [
      /redetermination/i,
      /reconsideration/i,
      /(un)?favorable\s+decision/i,
      /appeal\s+(decision|determination|outcome)/i,
      /administrative\s+law\s+judge|\bALJ\b/i,
    ],
    routeTo: "audit_update",
    why: "A determination starts the clock for the next appeal level. The window is measured from receipt, so the date this arrived is the one that counts.",
  },
  {
    kind: "revalidation",
    weight: 80,
    patterns: [
      /revalidat(e|ion)/i,
      /\bPECOS\b/i,
      /enrollment\s+(renewal|application)\s+(is\s+)?(due|required)/i,
      /billing\s+privileges\s+(will\s+be\s+)?deactivat/i,
    ],
    routeTo: "credentialing_track",
    why: "Missing a revalidation puts a hold on reimbursement or deactivates billing privileges — and claims furnished while deactivated are not recoverable.",
  },
  {
    kind: "clearinghouse_rejection",
    weight: 70,
    patterns: [
      /277CA|claim\s+acknowledg?ement/i,
      /front[-\s]?end\s+reject/i,
      /file\s+(was\s+)?rejected/i,
      /batch\s+(rejection|report)/i,
    ],
    routeTo: "ack_parse_277ca",
    why: "A front-end rejection never entered the payer's system: no appeal rights, no remittance, and timely filing still running.",
  },
  {
    kind: "denial",
    weight: 65,
    patterns: [
      /claim\s+(was\s+)?denied/i,
      /adverse\s+(benefit\s+)?determination/i,
      /not\s+(medically\s+)?necessary/i,
      /\bCARC\b|claim\s+adjustment\s+reason/i,
      /benefits\s+(have\s+been\s+)?denied/i,
    ],
    routeTo: "worklist_add",
    why: "A denial has an appeal window measured from the determination, and the recoverable amount decays as the window closes.",
  },
  {
    kind: "policy_bulletin",
    weight: 40,
    patterns: [
      /\bLCD\b|local\s+coverage\s+determination/i,
      /\bNCD\b|national\s+coverage\s+determination/i,
      /policy\s+(update|bulletin|change)/i,
      /provider\s+(bulletin|newsletter)/i,
      /coverage\s+criteria\s+(change|update)/i,
    ],
    routeTo: "policy_watch",
    why: "Coverage policy changes silently change which claims pay; the effective date is what to record.",
  },
  {
    kind: "eft_era_enrollment",
    weight: 35,
    patterns: [/\bEFT\b|electronic\s+funds\s+transfer/i, /\bERA\b\s+enroll/i, /835\s+enroll/i],
    routeTo: "",
    why: "Payment routing changes affect where money lands. Verify any banking change out of band before acting on it.",
  },
  {
    kind: "patient_billing",
    weight: 20,
    patterns: [
      /my\s+(bill|statement|account)/i,
      /payment\s+plan/i,
      /i\s+(was|were)\s+(billed|charged)/i,
      /dispute\s+(this|my)\s+(bill|charge)/i,
    ],
    routeTo: "",
    why: "Patient correspondence, not payer correspondence. It belongs to patient billing rather than the denial queue.",
  },
];

export interface ExtractedDeadline {
  /** Days from receipt, when the letter states a relative window. */
  days?: number;
  /** YYYYMMDD, when the letter states an absolute date. */
  date?: string;
  quote: string;
}

const RELATIVE_DEADLINE =
  /\bwithin\s+(\d{1,3})\s+(calendar\s+|business\s+)?days?\b|\b(\d{1,3})\s+days?\s+(?:from|of)\s+(?:the\s+)?(?:date|receipt)/gi;

const ABSOLUTE_DEADLINE =
  /\b(?:by|before|no\s+later\s+than|due\s+(?:on|by))\s+((?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:19|20)\d{2})/gi;

function toYmd(usDate: string): string | null {
  const m = usDate.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}${mm.padStart(2, "0")}${dd.padStart(2, "0")}`;
}

/** Windows and dates a letter imposes. Both forms appear, often in the same letter. */
export function extractDeadlines(text: string): ExtractedDeadline[] {
  const out: ExtractedDeadline[] = [];
  for (const m of text.matchAll(RELATIVE_DEADLINE)) {
    const days = Number(m[1] ?? m[3]);
    if (Number.isFinite(days) && days > 0) out.push({ days, quote: m[0].trim() });
  }
  for (const m of text.matchAll(ABSOLUTE_DEADLINE)) {
    const date = toYmd(m[1]);
    if (date) out.push({ date, quote: m[0].trim() });
  }
  return out;
}

/** Dollar amounts, in cents, so a demand letter's figure survives arithmetic intact. */
export function extractAmountsCents(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\$\s?([\d,]+(?:\.\d{2})?)/g)) {
    const value = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(value)) out.push(Math.round(value * 100));
  }
  return out;
}

/** Claim identifiers a payer letter uses to name the claim in question. */
export function extractClaimRefs(text: string): string[] {
  const refs = new Set<string>();
  const labelled =
    /\b(?:claim|ICN|DCN|CCN|control)\s*(?:number|no\.?|#|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{5,24})\b/gi;
  for (const m of text.matchAll(labelled)) refs.add(m[1].toUpperCase());
  return [...refs];
}

// ── PHI detection ────────────────────────────────────────────────────────────
// The patterns and both detectors now live in src/compliance/phi-detect.ts and
// are re-exported here.
//
// They were defined in this file, and twenty-one modules across ingest, speech,
// voice, browser policy and the ingress posture gate import them from the EMAIL
// CLASSIFIER — which is an accident of the order things were built, and a
// strange place for the rule that decides whether a deployment may keep a
// document. Moving the definitions and re-exporting means the correction cost
// no caller a change; the imports can move file by file, or never, and nothing
// breaks either way.
export {
  MBI_PATTERN,
  SSN_PATTERN,
  DOB_PATTERN,
  HICN_PATTERN,
  detectPhi,
  redact,
  type PhiSignal,
} from "../../compliance/phi-detect.js";
import { detectPhi, redact } from "../../compliance/phi-detect.js";
import type { PhiSignal } from "../../compliance/phi-detect.js";

export interface InboundMessage {
  id: string;
  from: string;
  subject: string;
  text: string;
  receivedAt: number;
}

export interface Classification {
  kind: CorrespondenceKind;
  confidence: number;
  matched: string[];
  routeTo: string;
  why: string;
  deadlines: ExtractedDeadline[];
  amountsCents: number[];
  claimRefs: string[];
  phi: PhiSignal[];
}

/**
 * Classify one message. Scoring is by rule weight and how many of a rule's
 * patterns hit, so a letter that says "ADR" once and "records" three times still
 * lands as a records request rather than being dragged elsewhere by volume.
 */
export function classify(message: InboundMessage): Classification {
  const haystack = `${message.subject}\n${message.text}`;
  let best: { rule: KindRule; matched: string[]; score: number } | null = null;

  for (const rule of KIND_RULES) {
    const matched = rule.patterns.filter((p) => p.test(haystack)).map((p) => p.source);
    if (matched.length === 0) continue;
    const score = rule.weight + matched.length;
    if (!best || score > best.score) best = { rule, matched, score };
  }

  const deadlines = extractDeadlines(haystack);
  const amountsCents = extractAmountsCents(haystack);
  const claimRefs = extractClaimRefs(haystack);
  const phi = detectPhi(haystack);

  if (!best) {
    return {
      kind: "other",
      confidence: 0,
      matched: [],
      routeTo: "",
      why: "Nothing in this message matched a known correspondence pattern. Read it before filing it anywhere.",
      deadlines,
      amountsCents,
      claimRefs,
      phi,
    };
  }

  // Confidence rises with corroborating patterns but never reaches certainty:
  // these are keyword rules, and a letter can quote another letter.
  const confidence = Math.min(0.4 + best.matched.length * 0.15, 0.9);
  return {
    kind: best.rule.kind,
    confidence,
    matched: best.matched,
    routeTo: best.rule.routeTo,
    why: best.rule.why,
    deadlines,
    amountsCents,
    claimRefs,
    phi,
  };
}

export function renderClassification(message: InboundMessage, c: Classification): string {
  // Redact the subject when the message carries PHI. detectPhi runs over
  // subject+text, so a message is quarantined precisely when either may hold an
  // identifier — yet the subject was rendered (and stored) raw, leaking an
  // SSN/MBI in a "Records request re SSN 123-45-6789" line straight into the
  // session transcript this deployment is not approved to hold.
  const subject = c.phi.length > 0 ? redact(message.subject) : message.subject;
  const lines: string[] = [
    `${c.kind}${c.confidence > 0 ? ` (${(c.confidence * 100).toFixed(0)}% confidence)` : ""} — from ${message.from}`,
    `Subject: ${subject}`,
    "",
    c.why,
  ];
  if (c.routeTo) lines.push("", `Route it with: ${c.routeTo}`);

  if (c.deadlines.length) {
    lines.push("", "Dates this message imposes:");
    for (const d of c.deadlines) {
      lines.push(
        d.days !== undefined
          ? `  ${d.days} days from receipt — "${d.quote}"`
          : `  ${d.date} — "${d.quote}"`,
      );
    }
    lines.push(
      c.deadlines.some((d) => d.days !== undefined)
        ? "  A relative window runs from RECEIPT, and the postmark is not the receipt date. Confirm against the letter before relying on these."
        : "  Confirm against the letter before relying on these — they are pulled by pattern.",
    );
  }
  if (c.claimRefs.length) lines.push("", `Claim references: ${c.claimRefs.join(", ")}`);
  if (c.amountsCents.length) {
    lines.push("", `Amounts named: ${c.amountsCents.map((cents) => `$${(cents / 100).toFixed(2)}`).join(", ")}`);
  }
  if (c.phi.length) {
    lines.push(
      "",
      "POSSIBLE PHI — this deployment is not approved for real patient data:",
      ...c.phi.map((p) => `  ${p.count}× ${p.hint}`),
      "The message body was withheld. Redaction catches identifier-shaped text only; a name and a diagnosis in prose have no pattern to match, so treat the original as PHI regardless.",
    );
  }
  return lines.join("\n");
}
