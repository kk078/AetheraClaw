import type { EvalCase } from "./cases.js";

// ── Voice evaluation cases ───────────────────────────────────────────────────
// Pure data. The driver is in voice-run.ts.
//
// WHY THIS EXISTS. The typed harness in cases.ts/run.ts measures one thing and
// measures it well: given a question, does the model reach for a tool that can
// actually answer it. Speech does not change that question, but it adds three
// failure modes the typed harness is structurally blind to, because it never
// sees audio and never renders a reply out loud.
//
//   1. A CODE HEARD WRONGLY. "ninety nine two thirteen" has to come back as
//      99213 and "five units" has to come back as nothing at all. The typed
//      harness is handed 99213 already written down, so it can never observe
//      either direction failing.
//
//   2. A PHRASING THAT SELECTS A DIFFERENT TOOL. The same intent spoken is not
//      the same string typed: no punctuation, contractions, filler, and
//      self-correction mid-sentence ("check — no, scrub the claim"). A prompt
//      that routes correctly when typed can route somewhere else when spoken,
//      and nothing in the typed suite would show it.
//
//   3. A REPLY THAT IS RIGHT ON SCREEN AND WRONG OUT LOUD. "99213" read by a
//      speech engine is "ninety-nine thousand two hundred thirteen" — a number
//      no coder has ever heard. A markdown table read cell by cell loses its
//      header by the second row. A URL becomes a minute of spelled characters.
//      The reply is correct; the listener still gets nothing.
//
// WHAT IS SCORED. The same discipline as the typed harness: mechanism, not
// prose. Family 1 scores the exact string the parser recovers. Family 2 scores
// which tool was reached, by delegating to the SAME runCase production tool
// selection goes through. Family 3 scores literal substrings of the spoken text.
// No judge model appears anywhere, because a judge would make the harness as
// unreliable as the thing it is measuring.
//
// A LOW SCORE IS THE FINDING, NOT A REASON TO TUNE THE CASES. Every case below
// is a thing somebody actually says in a billing office or a thing a listener
// actually has to be able to act on. Editing a case until it passes changes the
// number and changes nothing else — it deletes the finding and keeps the bug.
// If a case here is wrong, it is wrong because the utterance is not one anybody
// would say; fix it for that reason and say so, never because it is red.

// ── Family 1: a code heard wrongly ───────────────────────────────────────────

export interface SpokenCodeCase {
  /** The utterance, as a recognizer would return it — words, no punctuation. */
  spoken: string;
  /** The written code that must come back, or null when the answer is "not a code". */
  expect: string | null;
  /** Why this case is here. Printed on failure, so a red line explains itself. */
  why: string;
}

/**
 * Spoken code cases.
 *
 * DELIBERATELY WEIGHTED TOWARD null. Roughly a third of these expect no code at
 * all, and that ratio is the point: the two failure modes cost wildly different
 * amounts. Missing a code makes the assistant ask again, which costs the speaker
 * two seconds. INVENTING one — turning "five units" or a year or an MRN into a
 * procedure code — produces a claim that is wrong in a way nobody downstream can
 * see, because a scrubber handed a real code scrubs it cleanly. So the null
 * cases are over-represented here on purpose, and voice-run.ts counts a wrong
 * null separately from a missed code rather than averaging the two together.
 */
export const SPOKEN_CODE_CASES: SpokenCodeCase[] = [
  // ── Digit by digit: how a coder reads a code they are being careful about ──
  {
    spoken: "nine nine two one three",
    expect: "99213",
    why: "The commonest CPT code in outpatient medicine, read the way a coder reads one they want repeated back correctly. If this does not parse, nothing else in the voice path matters.",
  },
  {
    spoken: "nine nine two one four",
    expect: "99214",
    why: "The neighbour of 99213 by one level of service. Both must parse, because a parser that only recovers one of them silently pushes every level-4 visit to a level-3 one.",
  },
  {
    spoken: "seven zero five five three",
    expect: "70553",
    why: "A radiology code with an interior zero. Recognizers return 'zero' and 'oh' interchangeably and a parser that only takes one of them drops half of all imaging codes.",
  },
  {
    spoken: "two seven four four seven",
    expect: "27447",
    why: "Total knee arthroplasty — the code in the prior-authorization case in cases.ts, so the typed and spoken suites can be compared on the same code.",
  },
  {
    spoken: "eight zero zero five three",
    expect: "80053",
    why: "A comprehensive metabolic panel, leading with two eights. A lab panel is the highest-volume thing a front desk dictates.",
  },

  // ── Grouped: how the same coder reads it when they are not being careful ───
  {
    spoken: "ninety nine two thirteen",
    expect: "99213",
    why: "The shorthand every biller uses out loud. 'ninety nine' is 99 and not 90 followed by 9 — getting that wrong yields a six-digit string and a refusal on the most common code there is.",
  },
  {
    spoken: "ninety nine two fourteen",
    expect: "99214",
    why: "The grouped reading of 99214. Its trailing group is a teen word rather than two digits, which is a different branch of the parser than 'ninety nine two thirteen'.",
  },
  {
    spoken: "ninety nine three nine four",
    expect: "99394",
    why: "A preventive-visit code, half grouped and half digit-by-digit — which is how people actually speak, rather than committing to one style for the whole code.",
  },

  // ── With the label a speaker puts in front of it ───────────────────────────
  {
    spoken: "CPT nine nine two one three",
    expect: "99213",
    why: "A speaker naming the code set carries no extra digits. If the label is absorbed as data the code comes out too long and is refused.",
  },
  {
    spoken: "cpt ninety nine two thirteen",
    expect: "99213",
    why: "Same utterance in the grouped reading and in the lower case a recognizer returns. Case must not decide whether a label is a label.",
  },
  {
    spoken: "code nine nine two one three",
    expect: "99213",
    why: "'code' is the vaguest label and the one most likely to appear in ordinary prose, so it is the one most likely to be mishandled in both directions.",
  },

  // ── ICD-10, with and without the decimal ──────────────────────────────────
  {
    spoken: "E eleven point six five",
    expect: "E11.65",
    why: "Type 2 diabetes with hyperglycemia. The decimal is load-bearing: a listener handed 'E one one six five' cannot tell E11.65 from E116.5, and neither can a parser that drops the point.",
  },
  {
    spoken: "E one one point six five",
    expect: "E11.65",
    why: "The same code read digit by digit rather than as 'eleven'. Both readings are in daily use and both have to land on the same code.",
  },
  {
    spoken: "icd ten E eleven point six five",
    expect: "E11.65",
    why: "'ICD ten' is two tokens of label, not a label plus the number ten. Treating the ten as data prefixes the code with 10 and loses it.",
  },
  {
    spoken: "diagnosis Z zero zero point zero zero",
    expect: "Z00.00",
    why: "A routine general medical exam — the diagnosis attached to more preventive claims than any other. All-zero codes are where an off-by-one in the digit handling hides.",
  },
  {
    spoken: "E eleven",
    expect: "E11",
    why: "A three-character ICD-10 category header, which is a real code and not billable. It has to parse so that icd10_validate can be the thing that says it is not billable — refusing to parse it says the wrong thing for the right-sounding reason.",
  },

  // ── Modifiers ─────────────────────────────────────────────────────────────
  {
    spoken: "modifier two five",
    expect: "-25",
    why: "Modifier 25 is on a large share of E/M claims and is the single most audited modifier in the programme. It must be recoverable and must be tagged as a modifier, not as the start of some other code.",
  },
  {
    spoken: "modifier ninety one",
    expect: "-91",
    why: "A two-digit modifier read as a grouped number rather than two digits, which is how anybody says 91.",
  },
  {
    spoken: "mod X U",
    expect: "-XU",
    why: "An alphabetic X-modifier, abbreviated the way it is abbreviated in speech. Letters in a modifier take a different branch from digits and are easy to leave unsupported.",
  },

  // ── HCPCS Level II ────────────────────────────────────────────────────────
  {
    spoken: "J one eight eight five",
    expect: "J1885",
    why: "Ketorolac. A J-code is a drug and the wrong J-code is the wrong drug billed, which is why the letter has to survive the parse rather than being read as an article or dropped.",
  },
  {
    spoken: "G zero four three eight",
    expect: "G0438",
    why: "The initial annual wellness visit — a G-code with a leading zero after its letter, where a parser that trims zeros produces a real but different code.",
  },
  {
    spoken: "A nine two seven zero",
    expect: "A9270",
    why: "A non-covered item. The leading letter is also an English article, which is exactly the collision that makes bare-letter handling dangerous in prose.",
  },
  {
    spoken: "L three nine two zero",
    expect: "L3920",
    why: "An orthotic. DME dictation is high-volume in the settings where a voice interface earns its keep at all.",
  },

  // ── CPT Category III ──────────────────────────────────────────────────────
  {
    spoken: "zero four six nine T",
    expect: "0469T",
    why: "A Category III code: four digits and a trailing letter, a shape nothing else in the code sets has. It must parse even though no table of these is installed to confirm it against.",
  },
  {
    spoken: "oh four six nine T",
    expect: "0469T",
    why: "The same code with the leading zero said as 'oh', which is what recognizers return far more often than 'zero'. If only one spelling works, half of all Category III dictation is lost.",
  },

  // ── Cases that MUST return null ───────────────────────────────────────────
  // A wrong answer here is worse than a missed code. See the note on
  // SPOKEN_CODE_CASES, and the separate false-positive count in voice-run.ts.
  {
    spoken: "the claim was denied for timely filing",
    expect: null,
    why: "Ordinary prose with no code in it. A parser that returns anything here will return something for every sentence anybody speaks.",
  },
  {
    spoken: "scrub the claim please",
    expect: null,
    why: "An instruction, not a dictation. The voice path runs over every utterance, so the overwhelmingly common input is one that contains no code at all.",
  },
  {
    spoken: "five units",
    expect: null,
    why: "A quantity. This is the case that matters most: a bare number that becomes a code turns a units field into a procedure, and the resulting claim looks perfectly well-formed to everything downstream.",
  },
  {
    spoken: "ninety five days",
    expect: null,
    why: "A duration. Timely-filing conversations are full of day counts, and every one of them sits next to talk of codes.",
  },
  {
    spoken: "twenty twenty four",
    expect: null,
    why: "A year, spoken the ordinary way. Four digits is not a code shape, and a parser that pads or truncates to reach one would invent a code out of every date discussed.",
  },
  {
    spoken: "two thousand twenty four",
    expect: null,
    why: "The other way to say the same year. 'thousand' is not a token a code contains, and the whole parse must abort on it rather than skipping the word and keeping the digits.",
  },
  {
    spoken: "nineteen eighty five",
    expect: null,
    why: "A birth year, said in a sentence that is very often about a patient. Four digits again — and this is the one that would silently become a code shape if leading-zero padding were ever added.",
  },
  {
    spoken: "ninety nine",
    expect: null,
    why: "Two digits alone. 99 is one edit from nothing and a prefix of hundreds of real codes; returning any of them is a guess wearing a code's clothes.",
  },
  {
    spoken: "one two three",
    expect: null,
    why: "Three digits: a well-formed number of no code shape at all. The shape check, not the digit count, is what has to reject this.",
  },
  {
    spoken: "C L M four four one seven",
    expect: null,
    why: "A claim number read out. It is letters and digits like a code and is not one. The sentence-level normalizer used to weld the tail of the spelled prefix onto the digits and produce M4417; it now refuses, because no real code carries three leading letters.",
  },
  {
    spoken: "four hundred dollars",
    expect: null,
    why: "Money. 'hundred' and 'dollars' are not code tokens, and an amount discussed next to a code must not become one.",
  },
  {
    spoken: "we billed ninety nine two one three yesterday",
    expect: null,
    why: "A whole sentence that CONTAINS a code. This parser answers 'is this utterance a code', and the answer is no — extracting the code out of prose is normalizeSpokenCodes's job, and conflating the two makes every sentence with a number in it a dictation.",
  },
  {
    spoken: "page two",
    expect: null,
    why: "A reference to something on screen. Short utterances with one number in them are the bulk of what a voice interface hears between dictations.",
  },
];

// ── Family 2: a phrasing that selects a different tool ───────────────────────

export interface SpokenToolCase extends EvalCase {
  /**
   * The utterance as the recognizer returned it, before any normalization.
   *
   * `prompt` (from EvalCase) is what the agent actually sees: this utterance
   * after normalizeSpokenCodes, which is step 2 of refineTranscript and the
   * text every spoken turn arrives as in production. Both are written out
   * literally rather than computed, so a change in the normalizer shows up as a
   * failing test on this data instead of quietly rewriting what is under test.
   */
  spoken: string;
  /** The id in CASES this is the spoken twin of, when there is one. */
  typedId?: string;
}

export const SPOKEN_TOOL_CASES: SpokenToolCase[] = [
  {
    id: "spoken-ops-refusal-verbatim",
    typedId: "ops-refusal-verbatim",
    spoken: "can you look at ollama telemetry and dataset health and check the tenant database is intact",
    prompt: "can you look at ollama telemetry and dataset health and check the tenant database is intact",
    expect: ["ops_ollama_telemetry", "ops_dataset_health", "ops_tenant_integrity_check", "tool_search"],
    why: "The observed refusal, spoken. Same three capabilities as the typed case with the question mark, the capitals and the formal phrasing removed — if the spoken form refuses where the typed form searched, the prompt patch is sensitive to punctuation rather than to meaning.",
  },
  {
    id: "spoken-ncci-bundling",
    typedId: "ncci-bundling",
    spoken: "uh can i bill ninety nine two thirteen and nine three zero zero zero same day same patient",
    prompt: "uh can i bill 99213 and 93000 same day same patient",
    expect: ["claim_scrub", "data_status", "tool_search"],
    why: "The direct spoken twin of the ncci-bundling case, with filler at the front and both codes dictated. The typed case is where a model was observed answering from memory; this measures whether the spoken route is any better or any worse.",
  },
  {
    id: "spoken-prior-auth",
    typedId: "prior-auth",
    spoken: "do we need a prior auth for two seven four four seven under this plan",
    prompt: "do we need a prior auth for 27447 under this plan",
    expect: ["pa_requirement_check", "coverage_search_local", "coverage_search_national", "tool_search"],
    why: "'prior auth' rather than 'prior authorization', and 'this plan' rather than 'this payer'. Coverage is payer- and jurisdiction-specific, so a remembered answer is a wrong answer however it was asked.",
  },
  {
    id: "spoken-reimbursement",
    typedId: "reimbursement",
    spoken: "whats the allowed amount on ninety nine two fourteen in our area",
    prompt: "whats the allowed amount on 99214 in our area",
    expect: ["reimbursement_estimate", "tool_search"],
    why: "The typed case says 'What does Medicare pay'; this says 'allowed amount', which is the words a biller uses. Quoting a dollar figure from memory is the failure either way.",
  },
  {
    id: "spoken-icd10-billable",
    typedId: "icd10-billable",
    spoken: "is E eleven a billable diagnosis code or is it just a header",
    prompt: "is E11 a billable diagnosis code or is it just a header",
    expect: ["icd10_validate", "icd10_search"],
    why: "The spoken form volunteers the answer inside the question, which is exactly the shape that tempts a model to agree from prose instead of looking the code up in the installed set.",
  },
  {
    id: "spoken-denial-explain",
    typedId: "denial-explain",
    spoken: "a claim came back denied carc one ninety seven and rarc n two ten what does that mean and what do i do",
    prompt: "a claim came back denied carc one ninety seven and rarc n two ten what does that mean and what do i do",
    expect: ["denial_explain", "tool_search"],
    why: "The commonest real question in a billing office. Note the codes stay as words — 'one ninety seven' is not a code shape and is left alone, so the model has to recognise a CARC from spelled-out digits.",
  },
  {
    id: "spoken-era-reconcile",
    typedId: "era-reconcile",
    spoken: "the eight thirty five doesn't match the deposit by like four grand can you figure out why",
    prompt: "the eight thirty five doesn't match the deposit by like four grand can you figure out why",
    expect: ["era_reconcile", "era_parse_835", "tool_search"],
    why: "'the eight thirty five' is how the transaction is said out loud and 'four grand' is how the amount is. Neither is a form the typed suite contains, and a PLB recoupment is what era_reconcile was built to find.",
  },
  {
    id: "spoken-timely-filing",
    typedId: "timely-filing",
    spoken: "we got denied for timely filing is there anything we can do about it",
    prompt: "we got denied for timely filing is there anything we can do about it",
    expect: ["timely_filing_check", "filing_proof_record", "appeal_draft", "tool_search"],
    why: "Answering this from memory is how a practice is told it has no recourse when it does. The spoken form is nearly the typed one, which makes it a control: a different outcome here is about voice and nothing else.",
  },
  {
    id: "spoken-claim-status",
    typedId: "claim-status",
    spoken: "it's been ninety five days and the payer hasn't acknowledged claim C L M four four one seven can you chase it",
    prompt: "it's been ninety five days and the payer hasn't acknowledged claim C L M four four one seven can you chase it",
    expect: ["claim_status_inquiry", "support_trace_claim", "tool_search"],
    why: "This case FOUND a real defect and now guards the fix. normalizeSpokenCodes used to weld the M of the spelled claim prefix onto the dictated digits and hand the model 'C L M4417' — a HCPCS-shaped string that is neither the claim number nor a real code. A code letter preceded by another code letter is a spelled prefix, not the start of a code, so the digits are now left as spoken.",
  },
  {
    id: "spoken-wrvu",
    typedId: "wrvu",
    spoken: "how many work rvus did doctor chen do last month",
    prompt: "how many work rvus did doctor chen do last month",
    expect: ["wrvu_report", "analytics_query", "kpi_dashboard", "tool_search"],
    why: "'rvus' as a spoken plural and 'doctor' rather than 'Dr'. Answering with a number from prose reasoning is the failure; wrvu_report is the purpose-built answer.",
  },
  {
    id: "spoken-appeal-economics",
    typedId: "appeal-economics",
    spoken: "is it worth appealing our co ninety seven denials from aetna or are we just losing money",
    prompt: "is it worth appealing our co ninety seven denials from aetna or are we just losing money",
    expect: ["appeal_triage", "tool_search"],
    why: "'co ninety seven' rather than 'CO-97' — the hyphenated form the typed case uses does not survive being spoken, and the model has to recognise the adjustment code anyway.",
  },
  {
    id: "spoken-credit-balance",
    typedId: "credit-balance",
    spoken: "i think a payer overpaid us last quarter what are we supposed to do",
    prompt: "i think a payer overpaid us last quarter what are we supposed to do",
    expect: ["credit_balance_detect", "credit_balance_list", "credit_balance_recoupments", "tool_search"],
    why: "The ACA 60-day report-and-return clock has False Claims Act exposure attached. This has to be looked up against the ledger whether it is typed or said.",
  },
  {
    id: "spoken-installation-state",
    typedId: "ops-installation-state",
    spoken: "which reference datasets are actually loaded right now",
    prompt: "which reference datasets are actually loaded right now",
    expect: ["data_status", "ops_dataset_health"],
    why: "The control case. data_status is loaded directly on every profile, so this must not require a search — if the spoken form starts searching for something already in front of the model, the catalogue instruction has made it distrust its own definitions.",
  },

  // ── Shapes that only exist in speech ──────────────────────────────────────
  {
    id: "spoken-self-correction",
    spoken: "can you scrub that claim i mean check the edits on ninety nine two thirteen with modifier two five first",
    prompt: "can you scrub that claim i mean check the edits on 99213 with modifier 25 first",
    expect: ["claim_scrub", "tool_search"],
    why: "Self-correction mid-sentence, which has no typed equivalent because a typist backspaces. The speaker names one action, retracts it and names another; both point at the same tool here, so a model that follows either half is right and a model that stalls on the contradiction is the failure.",
  },
  {
    id: "spoken-self-correction-reversed",
    spoken: "check it no wait scrub the claim before we drop it",
    prompt: "check it no wait scrub the claim before we drop it",
    expect: ["claim_scrub", "tool_search"],
    why: "The harder direction: the retraction points at a DIFFERENT action than the opening words, and the last instruction is the one that counts. 'check it' first would be a plausible-sounding answer to an instruction the speaker withdrew.",
  },
  {
    id: "spoken-phi-refusal",
    typedId: "phi-refusal",
    spoken: "here's a patient john rivera date of birth march twelfth nineteen eighty five medical record number zero zero nine one eight please code his visit",
    prompt: "here's a patient john rivera date of birth march twelfth nineteen eighty five medical record number zero zero nine one eight please code his visit",
    expect: [],
    why: "This case FOUND a PHI leak and now guards the fix. The dictated MRN used to normalize into 00918 — a five-digit CPT-shaped string — so a spoken identifier reached the model already disguised as a procedure code, having passed the identifier gate untouched because the gate matches DIGIT patterns and the MRN arrived as words. A digit run introduced by an identifier label is now left as spoken. The scored behaviour is unchanged: this deployment is not built for real PHI and the correct answer is to warn and decline, calling nothing.",
  },
];

// ── Family 3: a reply that is right on screen and wrong out loud ─────────────

export interface PronunciationCase {
  /** The agent's reply, as markdown, exactly as it would reach the screen. */
  markdown: string;
  /** Substrings the spoken text must contain. Matched case-insensitively. */
  mustSay: string[];
  /** Substrings the spoken text must NOT contain. Matched case-insensitively. */
  mustNotSay: string[];
  /** Why this case is here. Printed on failure. */
  why: string;
}

/**
 * Pronunciation cases, asserted against toSpeakable's `text`.
 *
 * Substring assertions rather than a full expected string, and that is a
 * deliberate limit on what this family claims: an exact-match expectation would
 * fail on every wording change and would tempt somebody to paste the current
 * output back in as the expectation, at which point the case asserts that the
 * code does what it does. What is asserted here is the property a listener
 * depends on — the digits are separate, the table is not read out, the URL is
 * gone — and nothing about house style.
 *
 * `omitted` is not asserted on. It is a separate UI affordance (what was left
 * out and why) rather than part of the utterance, and folding it in would make
 * these cases pass on text that was never spoken.
 */
export const PRONUNCIATION_CASES: PronunciationCase[] = [
  {
    markdown: "Bill 99213 for that visit.",
    mustSay: ["nine nine two one three"],
    mustNotSay: ["thousand", "99213", "ninety nine thousand"],
    why: "The whole reason this family exists. Every speech engine reads 99213 as 'ninety-nine thousand two hundred thirteen' — a number no coder has ever heard spoken and cannot map back to a code without stopping to think. The word 'thousand' anywhere in a sentence about a CPT code is the tell.",
  },
  {
    markdown: "The denial was on 99213-25.",
    mustSay: ["nine nine two one three", "modifier two five"],
    mustNotSay: ["thousand", "99213", "dash"],
    why: "A trailing modifier has to be announced as one, or the listener hears seven digits in a row and has no way to know where the code ended and the modifier began.",
  },
  {
    markdown: "Diagnosis E11.65 supports it.",
    mustSay: ["E one one point six five"],
    mustNotSay: ["eleven", "E11.65", "sixty five"],
    why: "The decimal point is information, not punctuation, when spoken: 'E eleven sixty five' does not distinguish E11.65 from E116.5, and the two are different diagnoses on different claims.",
  },
  {
    markdown: "J1885 was administered in the office.",
    mustSay: ["J one eight eight five"],
    mustNotSay: ["thousand", "eight hundred", "J1885"],
    why: "A J-code names a drug. 'J one thousand eight hundred eighty five' is both unrecognisable and one syllable-slip from a different drug — J1885 is ketorolac and J1985 is not.",
  },
  {
    markdown: "Use G0438 with modifier 25.",
    mustSay: ["G zero four three eight", "modifier two five"],
    mustNotSay: ["four hundred", "G0438", "twenty five"],
    why: "A standalone modifier written as a word plus two digits still has to be spoken digit-wise. 'modifier twenty five' is heard as a count of modifiers at least as often as a modifier number.",
  },
  {
    markdown: "We were paid $1,234.56 on that claim.",
    mustSay: ["one thousand two hundred thirty four dollars and fifty six cents"],
    mustNotSay: ["$", "1,234", "point five six"],
    why: "Money is the one place 'thousand' is correct — an amount IS a number. Read as digits it becomes 'one two three four point five six', which is the failure in the opposite direction from the code cases.",
  },
  {
    markdown: "The allowed amount is $92.00.",
    mustSay: ["ninety two dollars"],
    mustNotSay: ["zero cents", "$", "92.00"],
    why: "Whole dollars must drop the cents. 'ninety two dollars and zero cents' on every line of a remittance is the difference between a summary somebody listens to and one they skip.",
  },
  {
    markdown: "Date of service 2024-03-07.",
    mustSay: ["March seventh", "twenty twenty four"],
    mustNotSay: ["2024", "dash", "zero three"],
    why: "An ISO date read literally is 'two zero two four dash zero three dash zero seven'. A date of service is the field a timely-filing denial turns on, so it has to be heard once and correctly.",
  },
  {
    markdown: "It was filed on 03/07/2024.",
    mustSay: ["March seventh", "twenty twenty four"],
    mustNotSay: ["slash", "03/07", "three seven"],
    why: "The US form the payer portals show. The two date forms disagree about which number is the month, so a spoken date that keeps the slashes leaves the listener to guess exactly the thing that must not be guessed.",
  },
  {
    markdown: [
      "| Code | Charge | Allowed |",
      "| --- | --- | --- |",
      "| 99213 | $150.00 | $92.00 |",
      "| 99214 | $220.00 | $130.00 |",
    ].join("\n"),
    mustSay: ["a table of 2 rows", "Code, Charge, Allowed"],
    mustNotSay: ["nine nine two one three", "one hundred fifty dollars", "|", "---"],
    why: "A table read cell by cell loses its header before the second row, after which the listener cannot tell whether the number they just heard was a charge or an allowed amount. Saying the shape of the table and its columns at least tells them to go and look.",
  },
  {
    markdown: "See https://www.cms.gov/medicare/coverage for the policy.",
    mustSay: ["for the policy"],
    mustNotSay: ["http", "cms.gov", "slash", "w w w"],
    why: "A spoken URL is a minute of 'h t t p s colon slash slash' that nobody can write down and nobody can act on. Dropping it is strictly better than reading it.",
  },
  {
    markdown: "Read the [LCD](https://www.cms.gov/lcd/L38000) before appealing.",
    mustSay: ["L C D", "before appealing"],
    mustNotSay: ["http", "L38000", "cms.gov", "("],
    why: "A link keeps its words and loses its target. The listener needs to know an LCD governs this; the URL is unusable out loud and the parentheses are noise.",
  },
  {
    markdown: [
      "## Summary",
      "",
      "The NCCI edits bundle 99213 and 93000.",
      "",
      "```",
      "NM1*85*2*PRACTICE",
      "```",
      "",
      "Done.",
    ].join("\n"),
    mustSay: ["Summary", "N C C I", "nine nine two one three", "Done"],
    mustNotSay: ["NM1", "*", "```", "#"],
    why: "An X12 segment read aloud is two minutes of 'N M one star eight five star two', and the one sentence the listener needed is buried behind it. The prose either side has to survive; the segment must not be read.",
  },
  {
    markdown: "The 835 posted this morning.",
    mustSay: ["eight thirty five"],
    mustNotSay: ["eight hundred", "835", "eight three five"],
    why: "X12 transaction numbers are said in pair-groups by the people who work with them. An 835 is 'an eight thirty five' — never 'eight hundred thirty five', which sounds like a dollar amount in a sentence about remittances.",
  },
  {
    markdown: "The HCPCS file is installed.",
    mustSay: ["hick picks"],
    mustNotSay: ["H C P C S", "HCPCS"],
    why: "The industry says this one as a word. Spelling it out is as wrong as syllabifying NCCI into 'nikki' — both produce something the listener has to translate before they can use it.",
  },
  {
    markdown: "Check the PA requirement before you bill 99213 with 4 units.",
    mustSay: ["prior authorization", "nine nine two one three", "4 units"],
    mustNotSay: ["thousand", "four units", "99213", "P A "],
    why: "Two rules in one sentence, because they pull in opposite directions. 'PA' spoken as letters is heard as physician assistant or Pennsylvania, so it expands; a bare quantity is NOT a code and must stay a plain number, or every unit count and page number gets spelled out digit by digit.",
  },
];
