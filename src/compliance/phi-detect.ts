// ── Finding protected health information in free text ────────────────────────
//
// This module owns the identifier patterns for the whole product. They used to
// live in src/channels/email/classify.ts, which twenty-one files across ingest,
// speech, voice, browser policy and the posture gate import them from — an
// accident of the order things were built, and a strange place for the rule
// that decides whether a deployment may keep a document. classify.ts now
// re-exports from here, so nothing had to change to correct it.
//
// TWO LEVELS, DELIBERATELY SEPARATE:
//
//   detectPhi()  the four HIGH-CONFIDENCE identifiers. Unchanged, and it must
//                stay unchanged, because the ingress posture gate already
//                refuses documents on its verdict. Widening it would start
//                refusing synthetic demo files that were accepted yesterday.
//
//   scanText()   everything detectPhi finds PLUS medium-confidence signals —
//                a bare date beside the word "patient", a phone number, an
//                email address, a labelled member or record number. These are
//                the shapes that carry PHI in prose, where there is no
//                identifier to match.
//
// The split is what lets production mode be conservative without changing what
// education mode accepts. Nothing here is a substitute for a human deciding
// what a document is: a name and a diagnosis in a sentence are PHI with no
// pattern to catch them, which is why production mode quarantines rather than
// trusting a regex to have seen everything.

/** MBIs use 20 letters — A–Z without S, L, O, I, B or Z, which read too much alike. */
const MBI_LETTER = "[ACDEFGHJKMNPQRTUVWXY]";
const MBI_ALNUM = "[ACDEFGHJKMNPQRTUVWXY0-9]";
export const MBI_PATTERN = new RegExp(
  // Hyphens are optional because the card prints them (1EG4-TE5-MK73) and people
  // read them out that way. Requiring the unbroken form missed the commonest
  // written spelling of the identifier this pattern exists to catch.
  `\\b[1-9]${MBI_LETTER}${MBI_ALNUM}\\d-?${MBI_LETTER}${MBI_ALNUM}\\d-?${MBI_LETTER}${MBI_LETTER}\\d\\d\\b`,
  "g",
);

export const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
export const DOB_PATTERN = /\b(?:DOB|date\s+of\s+birth)\b\s*[:#]?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/gi;
/** The legacy Medicare number: an SSN with a beneficiary suffix. */
export const HICN_PATTERN = /\b\d{9}[A-Z]{1,2}\d?\b/g;

// ── Medium-confidence shapes ─────────────────────────────────────────────────
// Each of these appears constantly in text that is NOT PHI — a payer's phone
// number, a date of service, a billing office email. On their own they mean
// little; in production mode they are worth an operator's glance, which is all
// "possible" asks for.

/** A bare calendar date. Only meaningful near a person-word — see NAME_NEAR. */
const BARE_DATE = /\b\d{1,2}[/-]\d{1,2}[/-](?:19|20)\d{2}\b/g;
/** Words that make a nearby date a birth date rather than a date of service. */
const PERSON_WORD = /\b(?:patient|member|subscriber|beneficiary|insured|enrollee|pt\.?)\b/gi;
/** How close the two have to be. Roughly one line of text. */
const PROXIMITY = 60;

const PHONE_PATTERN = /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
/** A labelled medical record or member number — the label is what makes it a signal. */
const RECORD_NUMBER =
  /\b(?:MRN|medical\s+record(?:\s+(?:number|no\.?|#))?|member\s*(?:id|number|no\.?|#)|policy\s*(?:id|number|no\.?|#))\s*[:#]?\s*[A-Z0-9][A-Z0-9-]{3,}\b/gi;

export type PhiKind = "mbi" | "ssn" | "dob" | "hicn";
export type PhiSoftKind = "name_dob" | "phone" | "email" | "record_number";

export interface PhiSignal {
  kind: PhiKind;
  count: number;
  /** Never the value itself — only enough to find it in the source. */
  hint: string;
}

/**
 * The four identifiers that are PHI on sight.
 *
 * FROZEN BEHAVIOUR. The ingress posture gate refuses documents on this result,
 * so a change here changes what an existing deployment accepts. New detection
 * goes in scanText below.
 */
export function detectPhi(text: string): PhiSignal[] {
  const out: PhiSignal[] = [];
  const check = (kind: PhiKind, pattern: RegExp, hint: string) => {
    const matches = [...text.matchAll(new RegExp(pattern.source, pattern.flags))];
    if (matches.length > 0) out.push({ kind, count: matches.length, hint });
  };
  check("ssn", SSN_PATTERN, "a Social Security number pattern");
  check("mbi", MBI_PATTERN, "a Medicare Beneficiary Identifier pattern");
  check("hicn", HICN_PATTERN, "a legacy Medicare (HICN) pattern");
  check("dob", DOB_PATTERN, "a labelled date of birth");
  return out;
}

/**
 * Replace identifier-shaped text with a marker.
 *
 * This makes a message safe to READ without making it safe to keep: redaction is
 * pattern matching, and a name and a diagnosis in prose are still PHI with no
 * pattern to catch them. The channel quarantines rather than relying on this.
 */
export function redact(text: string): string {
  return text
    .replace(new RegExp(SSN_PATTERN.source, "g"), "[REDACTED-SSN]")
    .replace(new RegExp(MBI_PATTERN.source, "g"), "[REDACTED-MBI]")
    .replace(new RegExp(HICN_PATTERN.source, "g"), "[REDACTED-HICN]")
    .replace(new RegExp(DOB_PATTERN.source, "gi"), "[REDACTED-DOB]");
}

export interface PhiFinding {
  kind: PhiKind | PhiSoftKind;
  count: number;
  /** Describes the shape, never the value. These strings reach logs and the UI. */
  hint: string;
  confidence: "high" | "medium";
}

export interface PhiScan {
  findings: PhiFinding[];
  /**
   * none     nothing matched
   * possible only medium-confidence shapes — worth a human glance
   * likely   at least one identifier that is PHI on sight
   */
  risk: "none" | "possible" | "likely";
}

/** Are a bare date and a person-word close enough to read as a birth date? */
function nameNearDate(text: string): number {
  const dates = [...text.matchAll(new RegExp(BARE_DATE.source, "g"))];
  if (dates.length === 0) return 0;
  const people = [...text.matchAll(new RegExp(PERSON_WORD.source, "gi"))];
  if (people.length === 0) return 0;
  let hits = 0;
  for (const d of dates) {
    const di = d.index ?? 0;
    // A date already captured by DOB_PATTERN is counted there, at high
    // confidence; counting it twice would inflate the finding list and make a
    // single identifier look like two problems.
    if (people.some((p) => Math.abs((p.index ?? 0) - di) <= PROXIMITY)) hits++;
  }
  return hits;
}

/**
 * The full scan, for deciding whether a turn or an upload may proceed.
 *
 * Deliberately eager. A false positive costs an operator one acknowledgment; a
 * false negative writes an identifier into a database that was promised not to
 * hold one, and into a session transcript, and into the next snapshot. Those
 * are not comparable costs, so the threshold is set where the cheap mistake
 * happens more often.
 */
export function scanText(text: string): PhiScan {
  const findings: PhiFinding[] = [];

  for (const s of detectPhi(text)) {
    findings.push({ kind: s.kind, count: s.count, hint: s.hint, confidence: "high" });
  }

  const soft = (kind: PhiSoftKind, count: number, hint: string) => {
    if (count > 0) findings.push({ kind, count, hint, confidence: "medium" });
  };
  // The labelled-DOB pattern already caught its own dates; this is the unlabelled
  // date sitting next to the word "patient", which is the commoner shape in a
  // letter or a note.
  const dobLabelled = [...text.matchAll(new RegExp(DOB_PATTERN.source, "gi"))].length;
  const nearby = Math.max(0, nameNearDate(text) - dobLabelled);
  soft("name_dob", nearby, "a date beside a word naming a person, which reads as a date of birth");
  soft("phone", [...text.matchAll(new RegExp(PHONE_PATTERN.source, "g"))].length, "a telephone number");
  soft("email", [...text.matchAll(new RegExp(EMAIL_PATTERN.source, "g"))].length, "an email address");
  soft(
    "record_number",
    [...text.matchAll(new RegExp(RECORD_NUMBER.source, "gi"))].length,
    "a labelled medical record, member or policy number",
  );

  const risk = findings.some((f) => f.confidence === "high")
    ? "likely"
    : findings.length > 0
      ? "possible"
      : "none";
  return { findings, risk };
}

export type PhiMode = "education" | "production";

export interface PhiVerdict {
  /** Whether the text may proceed to the model and to storage. */
  allow: boolean;
  /** Shown to the operator. Names the shapes found, never the values. */
  why: string;
  /** For the log row. Kinds only — the log must not learn what it refused. */
  kinds: string[];
}

/**
 * What to do about a scan, given the mode.
 *
 * Pure, so the policy can be argued with in a test rather than inferred from a
 * handler. The two modes differ in exactly one place — whether "possible" is
 * enough to stop — and that is the whole of the setting.
 *
 * Neither mode blocks on "none", and both block on "likely". An education
 * deployment that lets a labelled SSN through into a transcript is not
 * educating anyone about anything.
 */
export function phiVerdict(scan: PhiScan, mode: PhiMode): PhiVerdict {
  const kinds = scan.findings.map((f) => f.kind);
  if (scan.risk === "none") return { allow: true, why: "", kinds: [] };

  const list = scan.findings.map((f) => f.hint).join(", ");

  if (scan.risk === "likely") {
    return {
      allow: false,
      kinds,
      why:
        `This message contains ${list}. It was not sent to the model and was not stored — ` +
        "not the text, not an extract, not a hash of it. Re-send it with the identifiers " +
        "removed, or use the document upload path, which records the access properly.",
    };
  }

  // risk === "possible"
  if (mode === "production") {
    return {
      allow: false,
      kinds,
      why:
        `This message contains ${list}, which may identify a patient. This deployment is in ` +
        "production PHI mode, where anything that might be an identifier is refused rather " +
        "than guessed about. Remove it, or attach the source document instead so the access is logged.",
    };
  }
  return { allow: true, why: "", kinds: [] };
}
