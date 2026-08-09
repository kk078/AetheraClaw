import { detectPhi, type PhiSignal } from "../channels/email/classify.js";

// ── What the call was worth ──────────────────────────────────────────────────
// A payer call produces one thing that survives it: the call reference number.
// Everything the representative said is deniable six months later, and it will
// be denied — "we have no record of that call" is the standard answer to an
// appeal that rests on one. The reference number is what turns a conversation
// into evidence.
//
// So the most important output of this module is not the claim status. It is
// noticing that nobody gave a reference number, and saying so while the
// representative is still on the line and can be asked.

export type CallDisposition =
  | "paid"
  | "in_process"
  | "denied"
  | "not_on_file"
  | "needs_records"
  | "reprocessing"
  | "appeal_filed"
  | "unresolved";

export interface CallOutcome {
  /** The payer's call reference. Empty means the call proves nothing. */
  referenceNumber: string;
  /** Who was spoken to. A reference with no name is weaker but still evidence. */
  representative: string;
  disposition: CallDisposition;
  claimNumbers: string[];
  amounts: number[];
  dates: string[];
  /** What was agreed to happen next, in the representative's words. */
  commitments: string[];
  phi: PhiSignal[];
  gaps: string[];
}

/**
 * A reference number is announced with a noun — "call reference NUMBER",
 * "confirmation NUMBER", "ref #". Making that noun optional matched "this call
 * is placed" and "your call is important to us", producing PLACED and IMPORTANT
 * as reference numbers, which is worse than finding none: the call would be
 * filed as provable when it is not.
 */
const REFERENCE_PATTERNS = [
  /\b(?:call|reference|ref|confirmation|tracking|inquiry|document)\s*(?:reference\s*)?(?:number|no\.?|#|id)\s*(?:is|:)?\s*([A-Za-z0-9][A-Za-z0-9-]{4,})\b/gi,
  /\b(?:ref|call)\s*#\s*([A-Za-z0-9][A-Za-z0-9-]{4,})\b/gi,
];

/** A reference carries at least one digit; a bare word is a transcription artefact. */
function looksLikeReference(value: string): boolean {
  return /\d/.test(value);
}

const REP_PATTERNS = [
  /\bmy name is ([A-Z][a-z]+(?: [A-Z]\.?)?)/g,
  /\bthis is ([A-Z][a-z]+)(?:,| speaking| in)/g,
  /\byou(?:'re| are) speaking (?:with|to) ([A-Z][a-z]+)/g,
];

const DISPOSITION_RULES: Array<{ disposition: CallDisposition; phrases: string[] }> = [
  { disposition: "paid", phrases: ["has been paid", "was paid on", "check was issued", "payment was released", "eft was sent"] },
  { disposition: "denied", phrases: ["was denied", "denial code", "we denied", "not payable", "was rejected as"] },
  { disposition: "not_on_file", phrases: ["no record of", "not on file", "we never received", "cannot locate", "not in our system"] },
  { disposition: "needs_records", phrases: ["medical records", "send documentation", "additional information", "records request"] },
  { disposition: "reprocessing", phrases: ["send it back for reprocessing", "reprocess", "adjust the claim", "reopen"] },
  { disposition: "appeal_filed", phrases: ["appeal has been", "appeal was filed", "appeal is pending"] },
  { disposition: "in_process", phrases: ["still processing", "in process", "pending review", "in adjudication", "not finalized"] },
];

const COMMITMENT_PATTERNS = [
  /\b(?:i (?:will|'ll)|we (?:will|'ll)|it (?:will|'ll) be)\b[^.?!]{5,140}[.?!]/gi,
  /\b(?:allow|give it|please allow)\s+\d+\s*(?:business\s*)?(?:days|weeks)[^.?!]{0,80}[.?!]/gi,
];

function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

export function findReference(transcript: string): string {
  for (const pattern of REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(transcript)) !== null) {
      if (match[1] && looksLikeReference(match[1])) return match[1].toUpperCase();
    }
  }
  return "";
}

export function findRepresentative(transcript: string): string {
  for (const pattern of REP_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(transcript);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

export function findDisposition(transcript: string): CallDisposition {
  const lowered = transcript.toLowerCase();
  for (const rule of DISPOSITION_RULES) {
    if (rule.phrases.some((p) => lowered.includes(p))) return rule.disposition;
  }
  return "unresolved";
}

/**
 * Pull the outcome out of a transcript.
 *
 * Deliberately conservative: it reports what it found and names what it did not,
 * because a partially-extracted call read as a complete one is how a practice
 * discovers eight months later that the reference number was never captured.
 */
export function extractOutcome(transcript: string): CallOutcome {
  const referenceNumber = findReference(transcript);
  const representative = findRepresentative(transcript);
  const disposition = findDisposition(transcript);

  const claimNumbers = uniq(transcript.match(/\b[A-Z]{0,3}\d{8,}\b/g) ?? []).slice(0, 10);
  const amounts = uniq(transcript.match(/\$\s?[\d,]+(?:\.\d{2})?/g) ?? [])
    .map((a) => Number(a.replace(/[^0-9.]/g, "")))
    .filter((n) => Number.isFinite(n));
  const dates = uniq(
    transcript.match(/\b(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:\d{2}|\d{4})\b/g) ?? [],
  );

  const commitments: string[] = [];
  for (const pattern of COMMITMENT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of transcript.match(pattern) ?? []) commitments.push(m.trim());
  }

  const gaps: string[] = [];
  if (!referenceNumber) {
    gaps.push(
      "NO CALL REFERENCE NUMBER. Ask for one before hanging up. Without it this call cannot be proved: the standard answer to an appeal resting on a phone conversation is that the payer has no record of it, and that answer is unanswerable without a reference.",
    );
  }
  if (!representative) {
    gaps.push("No representative name captured. A reference number without a name is still evidence, but ask anyway.");
  }
  if (disposition === "unresolved") {
    gaps.push(
      "The claim's status was not stated in terms this could recognise. Before ending the call, get a plain answer: is it paid, denied, pending, or not on file.",
    );
  }
  if (commitments.length === 0 && disposition !== "paid") {
    gaps.push("Nobody committed to doing anything. Ask what happens next and by when, and get that on the reference.");
  }

  return {
    referenceNumber,
    representative,
    disposition,
    claimNumbers,
    amounts,
    dates,
    commitments: uniq(commitments).slice(0, 8),
    phi: detectPhi(transcript),
    gaps,
  };
}

const DISPOSITION_LABEL: Record<CallDisposition, string> = {
  paid: "Paid",
  in_process: "Still processing",
  denied: "Denied",
  not_on_file: "Not on file",
  needs_records: "Records requested",
  reprocessing: "Being reprocessed",
  appeal_filed: "Appeal on file",
  unresolved: "Not established",
};

export function renderOutcome(outcome: CallOutcome): string {
  const lines = [
    `Outcome: ${DISPOSITION_LABEL[outcome.disposition]}`,
    outcome.referenceNumber
      ? `Call reference: ${outcome.referenceNumber}${outcome.representative ? ` (${outcome.representative})` : ""}`
      : "Call reference: NONE CAPTURED",
  ];

  if (outcome.claimNumbers.length) lines.push(`Claims discussed: ${outcome.claimNumbers.join(", ")}`);
  if (outcome.amounts.length) lines.push(`Amounts mentioned: ${outcome.amounts.map((a) => `$${a.toFixed(2)}`).join(", ")}`);
  if (outcome.dates.length) lines.push(`Dates mentioned: ${outcome.dates.join(", ")}`);

  if (outcome.commitments.length) {
    lines.push("", "What they said would happen:");
    for (const c of outcome.commitments) lines.push(`  ${c}`);
    lines.push(
      "These are the representative's words, not a guarantee. A commitment is worth what the reference number makes it worth.",
    );
  }

  if (outcome.gaps.length) {
    lines.push("", "Before hanging up:");
    for (const g of outcome.gaps) lines.push(`  ⚠ ${g}`);
  }

  if (outcome.phi.length > 0) {
    lines.push(
      "",
      `This transcript carries identifier-shaped text (${outcome.phi.map((p) => `${p.count}× ${p.hint}`).join(", ")}). A payer call cannot avoid naming a member, which is precisely why this deployment is not approved for real patient data — run it against the simulator or with synthetic references.`,
    );
  }

  return lines.join("\n");
}
