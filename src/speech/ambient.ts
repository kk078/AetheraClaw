import {
  ALL_PARTY_STATES,
  CONTESTED_STATES,
  consentRule,
  recordingVerdict,
  type ConsentRule,
} from "../voice/consent.js";

// ── A microphone in an exam room ─────────────────────────────────────────────
// Ambient capture is the most valuable thing voice does in healthcare and the
// easiest to get badly wrong. A phone call between a biller and a payer rep is
// two professionals on a business line. This is a patient, half-undressed, in a
// room they cannot leave without ending their appointment, being asked whether
// they mind being recorded by the person who is about to examine them. The
// consent is real only if refusing it is genuinely free, and the software's job
// is to make the record of that refusal-or-agreement exist before anything is
// captured — not to infer it afterwards from the fact that capture happened.
//
// So this file is the DECISION LAYER ONLY. There is no capture here, no I/O, no
// clock, no submission. Three functions and a renderer over plain data:
//
//   ambientVerdict        — may this room be listened to at all, and separately,
//                           may what is heard be kept?
//   segmentEncounter      — cut a transcript that already exists into the parts
//                           of a visit, keeping character offsets so anything
//                           downstream can point at the exact words.
//   draftEncounterCoding  — match a vocabulary the PRACTICE supplied against
//                           those parts, and emit a draft in which every line
//                           carries the span of transcript that produced it.
//
// Three constraints run through all of it, and each one is load-bearing:
//
//   1. CONSENT FAILS CLOSED. `permitted: true` is only ever produced by a branch
//      that affirmatively grants it. There is no default-allow, no fallback
//      allow, and no path where an unrecognised input lands on "yes". The state
//      rule itself is not restated here — voice/consent.ts already models it,
//      and a second copy of a wiretap table is a second copy that drifts.
//
//   2. THE OUTPUT IS A DRAFT FOR A HUMAN CODER. Not codes, not a claim. Every
//      suggestion carries the transcript span behind it, in the CDI module's
//      discipline: a finding with no quote is not a finding. A suggestion whose
//      span cannot be produced is dropped rather than shown, because a code with
//      nothing behind it is exactly the one a coder waves through.
//
//   3. RETENTION IS A SEPARATE DECISION FROM CAPTURE. Permission to listen is
//      not permission to keep. Listening produces a draft and ends; keeping
//      produces a discoverable record of a clinical encounter that will outlive
//      the visit, the doctor and the practice's backup policy. The two are
//      decided separately and reported separately, and the second one is
//      strictly harder to pass than the first.
//
// What this file cannot do is worth stating, because the failure mode of a gate
// is that people trust it past its edge. It does not know whether the patient
// was actually asked; it knows only what the caller recorded. It does not know
// whether the room's microphone was already on. And it has no medical knowledge
// whatsoever — see draftEncounterCoding.

// ── Consent ──────────────────────────────────────────────────────────────────

export interface AmbientConsent {
  /** USPS code for where the encounter physically happens. */
  state: string;
  parties: Array<{ role: "provider" | "patient" | "other"; acknowledged: boolean }>;
  /** Whether the parties were told what the capture is FOR, not merely that it exists. */
  purposeStated: boolean;
  /** Whether the caller wants the transcript kept after the draft is produced. */
  retainTranscript: boolean;
}

export interface AmbientVerdict {
  permitted: boolean;
  reasons: string[];
  rule: ConsentRule;
  retention: "not-retained" | "retained";
  /** What has to be said out loud in the room before capture starts. */
  mustSay?: string;
}

/**
 * The sentence, for the room.
 *
 * Not the phone disclosure from voice/consent.ts, and deliberately not a
 * reworded version of it. That one is addressed to a payer representative on a
 * business line who can hang up. This one is addressed to a patient who cannot,
 * so it has to carry the part that makes the consent real: that saying no is
 * free. A disclosure which announces recording without offering a way out is a
 * notification, and a notification is not consent in any of the twelve states
 * that require consent.
 */
export const ROOM_DISCLOSURE =
  "Before we start: I use a computer assistant that listens to this visit and writes a first draft of my notes from it. It is recording what we say in this room. If you would rather it did not, say so now and I will switch it off — that will not change your care or how long we have, and I will write the note myself.";

/**
 * Jurisdictions this module will accept.
 *
 * voice/consent.ts lists only the stricter states, because everywhere else falls
 * through to the federal one-party rule — the right default for a table about
 * rules. It is the wrong default for a table about VALIDITY: `consentRule("ZZ")`
 * returns "one_party", which would quietly turn a typo, a country code or an
 * empty field into permission to record a patient. So membership is checked here
 * first, and the rule is only asked for once the place is known to be real.
 */
export const US_JURISDICTIONS: ReadonlySet<string> = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC", "PR", "VI", "GU", "AS", "MP",
]);

function roleList(parties: AmbientConsent["parties"]): string {
  const roles = parties.map((p) => p.role);
  return roles.length > 0 ? roles.join(", ") : "none";
}

/**
 * May this room be listened to, and separately, may the transcript be kept?
 *
 * The state rule is delegated: `recordingVerdict(state, state, true)` is asked
 * the same question voice/consent.ts already answers, with both ends set to the
 * room because everyone is in it. What is added here is the part a phone call
 * does not have — a list of the people present and whether each of them actually
 * said yes — and that is the part an exam room turns on.
 *
 * Note the shape of the function rather than the rules in it. `granted` starts
 * false, is set true only inside a branch that has checked something, and is
 * ANDed with an empty refusal list at the end. There is no `return permitted:
 * true` that can be reached by falling off the end of a condition.
 */
export function ambientVerdict(consent: AmbientConsent): AmbientVerdict {
  const raw = typeof consent?.state === "string" ? consent.state.trim() : "";
  const state = raw.toUpperCase();
  const known = US_JURISDICTIONS.has(state);

  // An unknown jurisdiction is reported as all_party. Not because we know that
  // it is — we know nothing about it, which is the point — but because `rule`
  // has to carry a value and the only value that cannot be acted on unsafely is
  // the strictest one. A reader who sees "one_party" next to a refusal will
  // eventually act on the "one_party".
  const rule: ConsentRule = known ? consentRule(state) : "all_party";
  const everyPartyRequired = rule === "all_party" || rule === "contested";
  const mustSay = everyPartyRequired ? ROOM_DISCLOSURE : undefined;

  const parties = Array.isArray(consent?.parties) ? consent.parties : [];
  const unacknowledged = parties.filter((p) => !p.acknowledged);
  const acknowledgedCount = parties.length - unacknowledged.length;
  const everyPartyAcknowledged = parties.length > 0 && unacknowledged.length === 0;

  const refusals: string[] = [];
  const grants: string[] = [];

  if (!raw) {
    refusals.push(
      "No state was given. Where the microphone physically is decides which wiretap statute applies, and there is no safe guess: in twelve states recording this room without everyone's agreement is a crime rather than a compliance finding.",
    );
  } else if (!known) {
    refusals.push(
      `"${raw}" is not a US jurisdiction this module recognises. Rather than fall through to the federal one-party rule — which is what an unrecognised code would otherwise silently do — capture is refused until the location is known.`,
    );
  } else {
    // Delegated, not restated. If voice/consent.ts refuses the underlying
    // recording question for a reason of its own, that reason is carried
    // through verbatim rather than paraphrased into a second vocabulary.
    const recording = recordingVerdict(state, state, true);
    if (!recording.allowed) refusals.push(recording.reason);
  }

  if (parties.length === 0) {
    refusals.push(
      "No parties were recorded as present. An empty party list is not a room with nobody in it; it is a room nobody wrote down, and consent that was never written down cannot be shown to have been given.",
    );
  } else if (!parties.some((p) => p.role === "patient")) {
    refusals.push(
      `No patient is listed among the parties (${roleList(parties)}). The person being examined is the one whose visit this is, and a consent record that does not account for them is not a consent record for this encounter.`,
    );
  }

  if (!consent?.purposeStated) {
    refusals.push(
      "The purpose of the capture was not stated to the room. Agreement to an unstated purpose is not agreement to anything — the patient who nods at \"we record visits\" has not agreed to a transcript being mined for billing codes, and that is what this pipeline does with it.",
    );
  }

  let granted = false;
  if (refusals.length === 0) {
    if (everyPartyRequired) {
      if (everyPartyAcknowledged) {
        granted = true;
        grants.push(
          rule === "all_party"
            ? `${state} is one of the ${ALL_PARTY_STATES.length} all-party consent states, and all ${parties.length} parties present (${roleList(parties)}) are recorded as having agreed after being told. That is the only basis on which this is permitted.`
            : `${state} is one of the ${CONTESTED_STATES.length} states whose statute and courts have read the consent requirement differently, so it is treated as all-party here. All ${parties.length} parties present (${roleList(parties)}) are recorded as having agreed.`,
        );
      } else {
        refusals.push(
          `${state} requires every party to agree, and ${unacknowledged.length} of ${parties.length} have not (${unacknowledged.map((p) => p.role).join(", ")}). This is not a missing checkbox: capturing this room now is a criminal offence in ${state}, and "the visit had already started" is not a defence. Say the disclosure, get the answer, and ask again.`,
        );
      }
    } else if (acknowledgedCount > 0) {
      granted = true;
      grants.push(
        `${state} follows the federal one-party rule, and ${acknowledgedCount} of ${parties.length} parties present (${roleList(parties)}) is recorded as having agreed. Note that this module still required a recorded acknowledgement rather than treating the clinician's own presence as the consenting party — legally sufficient, but an unwritten consent is one nobody can produce later.`,
      );
    } else {
      refusals.push(
        `${state} follows the one-party rule, so a single party's agreement would be enough — but not one of the ${parties.length} parties present is recorded as having agreed. One-party consent means one party said yes, not that nobody said no.`,
      );
    }
  }

  const permitted = granted && refusals.length === 0;

  // ── Retention: the second question, asked separately ──────────────────────
  // The bar here is the all-party bar regardless of what the state requires,
  // because keeping is a different act from listening. A transcript that is
  // drafted from and dropped exists for minutes inside the practice. A retained
  // one is a verbatim record of a clinical conversation that will be sitting in
  // a database during the next breach, the next subpoena and the next
  // acquisition — and the patient who agreed to a note being drafted has very
  // often not agreed to that.
  const wantsRetention = consent?.retainTranscript === true;
  const retention: AmbientVerdict["retention"] =
    permitted && wantsRetention && everyPartyAcknowledged ? "retained" : "not-retained";

  const retentionReason = !permitted
    ? "Retention: not retained. Capture was not permitted, so there is nothing lawfully captured to keep."
    : !wantsRetention
      ? "Retention: not retained, which is what was asked for. The transcript supports the draft and then goes; that is the posture with the smallest surface and it should be the default."
      : everyPartyAcknowledged
        ? `Retention: retained. Every party present agreed, which is the bar this module sets for keeping a transcript regardless of what ${state} requires for merely listening.`
        : `Retention: NOT retained, even though capture is permitted and retention was requested. ${unacknowledged.length} of ${parties.length} parties have not agreed, and ${state}'s one-party rule is a rule about listening. Keeping a verbatim record of what the others said is a further act, and this module will not infer agreement to it from agreement to the visit.`;

  const reasons = (permitted ? grants : refusals).slice();
  reasons.push(retentionReason);

  return { permitted, reasons, rule, retention, mustSay };
}

// ── Segmentation ─────────────────────────────────────────────────────────────

export type EncounterSection = "chief_complaint" | "history" | "exam" | "assessment" | "plan" | "other";

export interface EncounterSegment {
  section: EncounterSection;
  text: string;
  /** Character offset into the original transcript, inclusive. */
  start: number;
  /** Character offset into the original transcript, exclusive. */
  end: number;
}

/**
 * The cues clinicians actually speak.
 *
 * Not SOAP headings — nobody says "objective" out loud. These are the phrases
 * that mark a turn in a real visit, and they are here as an inspectable table
 * because a practice will need to add its own and because the whole behaviour of
 * the segmenter is visible in this list rather than buried in a classifier.
 *
 * The list is deliberately short and deliberately literal. A fuzzy segmenter
 * would section more of the transcript, which sounds like an improvement and is
 * the opposite of one: an exam finding filed under "history" is a documentation
 * error with a code hanging off it, and it is worse than the same sentence
 * sitting unsectioned where a coder can see it was never classified.
 */
export const SECTION_CUES: ReadonlyArray<{ section: EncounterSection; cues: readonly string[] }> = [
  {
    section: "chief_complaint",
    cues: ["what brings you in", "what brings you here", "how can I help you today", "what can I do for you today", "what's going on today"],
  },
  {
    section: "history",
    cues: ["how long has this been", "when did this start", "have you had this before", "past medical history", "are you taking any", "any medications", "any allergies", "does anyone in your family"],
  },
  {
    section: "exam",
    cues: ["let's take a look", "let me take a look", "I'm going to examine", "I'm going to listen", "take a deep breath", "does it hurt when", "any tenderness", "on exam"],
  },
  {
    section: "assessment",
    cues: ["my assessment is", "my impression is", "what I think is going on", "I think this is", "the diagnosis is"],
  },
  {
    section: "plan",
    cues: ["the plan is", "I'm going to order", "I'd like to order", "I'm going to prescribe", "let's start you on", "I want you to follow up"],
  },
];

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * A phrase, as a pattern tolerant of the two things transcripts vary in.
 *
 * Whitespace becomes `\s+` so a cue that a recogniser split across a line still
 * matches, and every apostrophe matches its curly twin — engines emit U+2019
 * about half the time, and "let's take a look" failing to match "let’s take a
 * look" would silently drop the exam section of every second encounter.
 */
function phrasePattern(phrase: string): string {
  return phrase
    .trim()
    .split(/\s+/)
    .map((word) => escapeRegExp(word).replace(/['‘’]/g, "['‘’]"))
    .join("\\s+");
}

/**
 * Cut a transcript into the parts of a visit.
 *
 * Segments tile the transcript in order and never overlap, and each one's `text`
 * is exactly `transcript.slice(start, end)` — that identity is what lets a
 * coding suggestion downstream point at a span the reviewer can find in the
 * original. Runs that are entirely whitespace are dropped; nothing else is.
 *
 * Anything before the first cue, and anything in a transcript with no cues at
 * all, is `other`. That is not a failure mode, it is the honest answer: the
 * module recognised nothing there and says so, rather than assigning the
 * nearest section.
 */
export function segmentEncounter(transcript: string): EncounterSegment[] {
  if (typeof transcript !== "string" || transcript.length === 0) return [];

  const found: Array<{ section: EncounterSection; start: number; end: number }> = [];
  for (const { section, cues } of SECTION_CUES) {
    for (const cue of cues) {
      const re = new RegExp(phrasePattern(cue), "gi");
      let match: RegExpExecArray | null;
      while ((match = re.exec(transcript)) !== null) {
        found.push({ section, start: match.index, end: match.index + match[0].length });
        if (match.index === re.lastIndex) re.lastIndex += 1;
      }
    }
  }

  // Earliest first; on a tie the longer cue wins, so "let me take a look" is not
  // shadowed by a shorter overlapping phrase. Anything starting inside an
  // already-accepted cue is a fragment of it, not a new section.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const boundaries: typeof found = [];
  for (const candidate of found) {
    const previous = boundaries[boundaries.length - 1];
    if (previous && candidate.start < previous.end) continue;
    boundaries.push(candidate);
  }

  const segments: EncounterSegment[] = [];
  const add = (section: EncounterSection, start: number, end: number): void => {
    if (end <= start) return;
    const text = transcript.slice(start, end);
    if (!text.trim()) return;
    segments.push({ section, text, start, end });
  };

  add("other", 0, boundaries.length > 0 ? boundaries[0].start : transcript.length);
  for (let i = 0; i < boundaries.length; i += 1) {
    const end = i + 1 < boundaries.length ? boundaries[i + 1].start : transcript.length;
    add(boundaries[i].section, boundaries[i].start, end);
  }
  return segments;
}

// ── The coding draft ─────────────────────────────────────────────────────────

export interface VocabularyEntry {
  term: string;
  /** May be empty, in which case the draft names the term and leaves the code to the coder. */
  code: string;
  kind: "icd10" | "cpt";
}

export interface CodingSuggestion {
  kind: "icd10" | "cpt";
  code?: string;
  term: string;
  section: EncounterSection;
  /** The span of the ORIGINAL transcript that produced this line. Never empty. */
  evidence: { start: number; end: number; text: string };
  confidence: "stated" | "implied";
}

export interface CodingDraft {
  suggestions: CodingSuggestion[];
  /** Mentioned in the room, deliberately not turned into a suggestion, and why. */
  notCoded: string[];
  disclaimer: string;
}

export interface DraftOptions {
  /**
   * The practice's own clinical vocabulary. INJECTED, never built in.
   *
   * This is the single most important line in the file. A term-to-code table
   * shipped inside a billing assistant is an unvalidated coding authority: it
   * would be wrong in ways no one at the practice could see, it would be applied
   * to every patient, and its errors would arrive pre-formatted as suggestions
   * from software. The practice supplies the list, owns it, and can be shown
   * exactly which of its own entries fired and on which words.
   */
  vocabulary?: VocabularyEntry[];
}

export const DRAFT_DISCLAIMER =
  "DRAFT — for a human coder, not a claim and not a code assignment. Every line below is a suggestion produced by matching a vocabulary the practice supplied against words that were actually said, and each one is shown with the exact span of transcript that produced it. Nothing here has been checked against a code set, the ICD-10-CM or CPT guidelines, payer policy, medical necessity, or the signed note. A suggestion is not a diagnosis; an absent suggestion is not an absent diagnosis; and nothing in this module can make any of it billable. A coder reads the encounter and decides.";

/**
 * Words that mean the thing was NOT found.
 *
 * Blunt on purpose. It tests the whole sentence, so "no fever, but her diabetes
 * is worse" pushes both terms to notCoded — a false skip, and the right kind of
 * error to make: it costs a coder one glance at a quoted sentence, while the
 * opposite error puts a diagnosis the patient does not have on a claim in their
 * name. A negation detector tuned for recall would be a research project; this
 * is a gate.
 */
const NEGATION_RE = /\b(?:denies|denied|denying|negative for|ruled out|rules out|resolved|absent|without|family history of|no|not)\b/i;

/**
 * Words that mean the clinician has not decided yet.
 *
 * These do not become "implied" suggestions, they become skips. An uncertain
 * diagnosis is not coded in the outpatient setting at all — ICD-10-CM Official
 * Guidelines Section IV.H says to code the sign or symptom instead — so emitting
 * "possible pneumonia" as a low-confidence suggestion would be offering the
 * coder something the guidelines forbid, dressed as a hedge.
 */
const UNCERTAIN_RE = /\b(?:rule out|r\/o|possible|possibly|probable|probably|suspect|suspected|suspicion|differential|questionable|cannot exclude|concern for|versus|vs)\b/i;

/**
 * Words that mean someone is reporting it rather than the clinician asserting
 * it. These downgrade to "implied" — the mention is real, the assertion is not.
 */
const SOFT_RE = /\b(?:history of|reports|reported|complains of|complaining of|sounds like|looks like|seems|appears|says|thinks)\b/i;

/**
 * The section in which each kind of code is actually asserted.
 *
 * A diagnosis becomes the clinician's until they assess it; before that it is
 * the patient's own word for how they feel, which is a symptom and not a
 * diagnosis. A procedure is asserted where it is done or ordered. Matches
 * outside these sections are still emitted — the coder should see them — but as
 * "implied", never "stated".
 */
const ASSERTED_IN: Record<"icd10" | "cpt", readonly EncounterSection[]> = {
  icd10: ["assessment"],
  cpt: ["plan", "exam"],
};

function termPattern(term: string): RegExp {
  // A trailing plural is allowed; anything else on either side is a different
  // word. Without the boundaries "ear" matches "hearing" and "flu" matches
  // "fluid", and a coder shown "flu" quoted from "no fluid in the ear" stops
  // trusting the tool, correctly.
  return new RegExp(`(?<![A-Za-z0-9])${phrasePattern(term)}s?(?![A-Za-z0-9])`, "gi");
}

/** The sentence containing `at`, trimmed, as offsets into `text`. */
function sentenceBounds(text: string, at: number): { start: number; end: number } {
  let start = 0;
  for (const mark of [". ", "? ", "! ", "\n"]) {
    const found = text.lastIndexOf(mark, at);
    if (found >= 0 && found + mark.length > start) start = found + mark.length;
  }
  let end = text.length;
  for (const mark of [".", "?", "!", "\n"]) {
    const found = text.indexOf(mark, at);
    if (found >= 0 && found + 1 < end) end = found + 1;
  }
  while (start < end && /\s/.test(text[start] ?? "")) start += 1;
  while (end > start && /\s/.test(text[end - 1] ?? "")) end -= 1;
  return { start, end };
}

/**
 * Turn segments into a draft for a coder.
 *
 * The rule that shapes the whole function: a suggestion exists only where a span
 * of transcript exists to justify it. Everything else — a term said in
 * unsectioned conversation, a term the transcript negates, a term the clinician
 * hedged — goes to `notCoded` with the sentence and the reason, so the coder
 * sees what was skipped rather than a shorter list they have no way to question.
 * A skip a coder can overturn is useful; a silent skip is a lie of omission.
 */
export function draftEncounterCoding(segments: EncounterSegment[], opts: DraftOptions = {}): CodingDraft {
  const vocabulary = (opts.vocabulary ?? []).filter(
    (entry): entry is VocabularyEntry => Boolean(entry) && typeof entry.term === "string" && entry.term.trim().length > 0,
  );

  const suggestions: CodingSuggestion[] = [];
  const notCoded: string[] = [];
  const skipped = new Set<string>();
  const emitted = new Set<string>();
  const skip = (line: string): void => {
    if (skipped.has(line)) return;
    skipped.add(line);
    notCoded.push(line);
  };

  if (vocabulary.length === 0) {
    skip(
      "No usable clinical vocabulary was supplied, so nothing in this encounter was matched. An empty draft here means the module is unconfigured, not that the encounter had nothing in it — this module has no medical dictionary of its own and will not acquire one.",
    );
    return { suggestions, notCoded, disclaimer: DRAFT_DISCLAIMER };
  }

  for (const segment of segments) {
    for (const entry of vocabulary) {
      const re = termPattern(entry.term);
      let match: RegExpExecArray | null;
      while ((match = re.exec(segment.text)) !== null) {
        if (match.index === re.lastIndex) re.lastIndex += 1;

        const bounds = sentenceBounds(segment.text, match.index);
        const quote = segment.text.slice(bounds.start, bounds.end);
        if (!quote.trim()) {
          skip(
            `${entry.term} — matched at character ${segment.start + match.index}, but no sentence could be recovered around it, so there is no span to put in front of a coder. Dropped rather than shown unsupported.`,
          );
          continue;
        }

        if (segment.section === "other") {
          skip(
            `${entry.term} — said, but only in unsectioned conversation: "${quote}". Nothing marks whether that was the patient's own word, the clinician's finding, or small talk on the way out, and filing it under a section to make it codeable is exactly how a mis-sectioned finding becomes a documentation error.`,
          );
          continue;
        }
        if (NEGATION_RE.test(quote)) {
          skip(
            `${entry.term} — the transcript records it as absent, resolved, or someone else's: "${quote}". An encounter that documents the absence of a finding is not an encounter that codes it.`,
          );
          continue;
        }
        if (UNCERTAIN_RE.test(quote)) {
          skip(
            `${entry.term} — stated as uncertain: "${quote}". An uncertain diagnosis is not coded in the outpatient setting (ICD-10-CM Official Guidelines, Section IV.H); the coder codes the sign or symptom that is documented instead.`,
          );
          continue;
        }

        const evidence = {
          start: segment.start + bounds.start,
          end: segment.start + bounds.end,
          text: quote,
        };
        const key = `${entry.kind}|${entry.code}|${entry.term}|${evidence.start}`;
        if (emitted.has(key)) continue;
        emitted.add(key);

        const confidence: CodingSuggestion["confidence"] =
          ASSERTED_IN[entry.kind].includes(segment.section) && !SOFT_RE.test(quote) ? "stated" : "implied";

        const suggestion: CodingSuggestion = {
          kind: entry.kind,
          term: entry.term,
          section: segment.section,
          evidence,
          confidence,
        };
        // An entry with no code names the term and leaves the assignment to the
        // coder. That is a better output than a guessed code, and the shape says
        // so rather than filling the field with something plausible.
        if (typeof entry.code === "string" && entry.code.trim()) suggestion.code = entry.code.trim();
        suggestions.push(suggestion);
      }
    }
  }

  // The invariant, enforced at the exit as well as the entrance. Nothing should
  // reach here with an empty span; if the matching logic is ever changed so that
  // something does, it is dropped and reported rather than emitted, because a
  // suggestion with no evidence is precisely the one a reviewer waves through.
  const supported: CodingSuggestion[] = [];
  for (const suggestion of suggestions) {
    if (suggestion.evidence.end > suggestion.evidence.start && suggestion.evidence.text.trim().length > 0) {
      supported.push(suggestion);
      continue;
    }
    skip(
      `${suggestion.term} — a suggestion was built with an empty evidence span and has been dropped. A code with nothing behind it is not a weaker suggestion, it is not a suggestion.`,
    );
  }
  supported.sort((a, b) => a.evidence.start - b.evidence.start || a.term.localeCompare(b.term));

  return { suggestions: supported, notCoded, disclaimer: DRAFT_DISCLAIMER };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * One page for a human: the consent decision first, then the draft.
 *
 * The ordering is the argument. When capture was not permitted, the suggestions
 * are NOT printed — not because they would be wrong, but because printing a
 * useful draft under a refusal is how a refusal gets treated as advisory. If a
 * transcript exists for a room that should not have been captured, the thing to
 * deal with is the recording, not the coding.
 */
export function renderAmbientDraft(draft: CodingDraft, verdict: AmbientVerdict): string {
  const lines: string[] = [];
  lines.push(verdict.permitted ? "Ambient capture: PERMITTED." : "Ambient capture: NOT PERMITTED.");
  for (const reason of verdict.reasons) lines.push(`  ${reason}`);
  lines.push("", `Governing rule: ${verdict.rule.replace("_", "-")}.  Retention: ${verdict.retention}.`);

  if (verdict.mustSay) {
    lines.push("", "Say this in the room, out loud, before anything is captured:", `  "${verdict.mustSay}"`);
  }

  if (!verdict.permitted) {
    lines.push(
      "",
      "No coding draft is shown. Capture was not permitted, so a transcript to draft from should not exist; printing suggestions derived from one would make the recording look retrospectively worthwhile. If a transcript does exist, it is the recording that needs dealing with.",
    );
    return lines.join("\n");
  }

  lines.push("", draft.disclaimer, "");
  if (draft.suggestions.length === 0) {
    lines.push("No suggestion carried a transcript span, so none is shown.");
  }
  for (const s of draft.suggestions) {
    const code = s.code ? `${s.code} — ` : "code to be assigned by the coder — ";
    lines.push(
      `  [${s.kind}] ${code}${s.term}  (${s.section}, ${s.confidence})`,
      `      chars ${s.evidence.start}-${s.evidence.end}: "${s.evidence.text}"`,
    );
  }

  if (draft.notCoded.length > 0) {
    lines.push("", `Mentioned and not coded (${draft.notCoded.length}) — read these, they are where the mistakes are:`);
    for (const line of draft.notCoded) lines.push(`  - ${line}`);
  }

  return lines.join("\n");
}
