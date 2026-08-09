import { describe, expect, it } from "vitest";
import * as ambient from "../src/speech/ambient.js";
import {
  DRAFT_DISCLAIMER,
  ROOM_DISCLOSURE,
  SECTION_CUES,
  US_JURISDICTIONS,
  ambientVerdict,
  draftEncounterCoding,
  renderAmbientDraft,
  segmentEncounter,
  type AmbientConsent,
  type EncounterSegment,
  type VocabularyEntry,
} from "../src/speech/ambient.js";
import { CONTESTED_STATES, RECORDING_CONSENT, consentRule } from "../src/voice/consent.js";

// A visit, written the way one is actually spoken: chatter on the way in, a
// cue, an answer, a cue, an exam finding, an assessment, a plan. Offsets are
// never hardcoded below — every assertion about a span is checked against the
// transcript itself, which is the property the whole evidence story rests on.
const TRANSCRIPT = [
  "Morning, sorry about the wait; my wife has diabetes so I know how these appointments run.",
  "So what brings you in today?",
  "My chest has been tight since Saturday.",
  "How long has this been going on?",
  "Four days or so, and there is no fever.",
  "Let's take a look.",
  "There is tenderness over the left costal margin and the chest wall is reproducible.",
  "My assessment is costochondritis.",
  "The plan is ibuprofen and rest.",
  "I'm going to order a chest x-ray today.",
].join(" ");

/**
 * The practice's list, not the module's. Six entries chosen to exercise every
 * branch: one asserted, one never said, one procedure, one negated, one said
 * only in chatter, and one with no code at all.
 */
const VOCABULARY: VocabularyEntry[] = [
  { term: "costochondritis", code: "M94.0", kind: "icd10" },
  { term: "chest pain", code: "R07.9", kind: "icd10" },
  { term: "chest x-ray", code: "71046", kind: "cpt" },
  { term: "fever", code: "R50.9", kind: "icd10" },
  { term: "diabetes", code: "E11.9", kind: "icd10" },
  { term: "tenderness", code: "", kind: "icd10" },
];

function consent(over: Partial<AmbientConsent> = {}): AmbientConsent {
  return {
    state: "TX",
    parties: [
      { role: "provider", acknowledged: true },
      { role: "patient", acknowledged: true },
    ],
    purposeStated: true,
    retainTranscript: false,
    ...over,
  };
}

const BOTH_AGREE: AmbientConsent["parties"] = [
  { role: "provider", acknowledged: true },
  { role: "patient", acknowledged: true },
];
const PATIENT_SILENT: AmbientConsent["parties"] = [
  { role: "provider", acknowledged: true },
  { role: "patient", acknowledged: false },
];

// ── Consent: the part where being wrong is a crime ───────────────────────────

describe("ambientVerdict — the affirmative cases", () => {
  it("permits a one-party state when a party is recorded as having agreed", () => {
    const v = ambientVerdict(consent({ state: "TX", parties: BOTH_AGREE }));
    expect(v.permitted).toBe(true);
    expect(v.rule).toBe("one_party");
    // Delegated, not restated: TX is absent from the consent table precisely
    // because it falls through to the federal rule.
    expect(consentRule("TX")).toBe("one_party");
    expect(RECORDING_CONSENT.TX).toBeUndefined();
    expect(v.reasons.length).toBeGreaterThan(0);
  });

  it("permits an all-party state only when every party has agreed", () => {
    const v = ambientVerdict(consent({ state: "CA", parties: BOTH_AGREE }));
    expect(v.permitted).toBe(true);
    expect(v.rule).toBe("all_party");
    expect(v.mustSay).toBe(ROOM_DISCLOSURE);
  });

  it("permits a contested state when every party has explicitly agreed", () => {
    const v = ambientVerdict(consent({ state: "MI", parties: BOTH_AGREE }));
    expect(v.permitted).toBe(true);
    expect(v.rule).toBe("contested");
    expect(CONTESTED_STATES).toContain("MI");
  });
});

describe("ambientVerdict — consent fails closed", () => {
  it("REFUSES an all-party state when one party has not acknowledged", () => {
    const v = ambientVerdict(consent({ state: "CA", parties: PATIENT_SILENT }));
    expect(v.permitted).toBe(false);
    expect(v.rule).toBe("all_party");
    // The refusal has to say which party and why it is not a paperwork problem.
    expect(v.reasons.join(" ")).toMatch(/patient/);
    expect(v.reasons.join(" ")).toMatch(/criminal offence/i);
  });

  it("refuses a contested state by default, without explicit acknowledgement", () => {
    const v = ambientVerdict(consent({ state: "MI", parties: PATIENT_SILENT }));
    expect(v.permitted).toBe(false);
    expect(v.rule).toBe("contested");
    // Contested means treated as all-party — the convenient reading is not a
    // defence, and that is the consent module's judgement, reused.
    expect(v.mustSay).toBe(ROOM_DISCLOSURE);
  });

  it("refuses an empty state", () => {
    const v = ambientVerdict(consent({ state: "" }));
    expect(v.permitted).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/No state was given/i);
  });

  it("refuses a whitespace-only state rather than trimming it into nothing quietly", () => {
    expect(ambientVerdict(consent({ state: "   " })).permitted).toBe(false);
  });

  it("refuses an unknown jurisdiction instead of falling through to the one-party default", () => {
    const v = ambientVerdict(consent({ state: "ZZ" }));
    expect(v.permitted).toBe(false);
    // consentRule would happily call ZZ one-party. That fallback is right for a
    // rules table and catastrophic for a validity check, so it is not used.
    expect(consentRule("ZZ")).toBe("one_party");
    expect(US_JURISDICTIONS.has("ZZ")).toBe(false);
    // The reported rule is the strictest one, because a field that must carry a
    // value should carry the one nobody can act on unsafely.
    expect(v.rule).toBe("all_party");
  });

  it("refuses when no parties were recorded at all", () => {
    const v = ambientVerdict(consent({ parties: [] }));
    expect(v.permitted).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/never written down/i);
  });

  it("refuses when the patient is not among the parties", () => {
    const v = ambientVerdict(
      consent({ parties: [{ role: "provider", acknowledged: true }, { role: "other", acknowledged: true }] }),
    );
    expect(v.permitted).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/No patient is listed/i);
  });

  it("refuses when the purpose was never stated, even where everyone agreed", () => {
    const v = ambientVerdict(consent({ state: "CA", parties: BOTH_AGREE, purposeStated: false }));
    expect(v.permitted).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/purpose/i);
  });

  it("refuses a one-party state when nobody at all is recorded as having agreed", () => {
    const v = ambientVerdict(
      consent({
        state: "TX",
        parties: [
          { role: "provider", acknowledged: false },
          { role: "patient", acknowledged: false },
        ],
      }),
    );
    expect(v.permitted).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/not that nobody said no/i);
  });

  it("never returns permitted as a default — across the whole input matrix", () => {
    // The point of this test is not the individual cases, it is that no
    // combination of inputs reaches `permitted: true` without every precondition
    // being affirmatively satisfied. A fallback allow anywhere in the function
    // fails here.
    const states = ["", "  ", "ZZ", "XX", "TX", "NY", "CA", "IL", "MI", "NV"];
    const partySets: AmbientConsent["parties"][] = [
      [],
      [{ role: "provider", acknowledged: true }],
      [{ role: "patient", acknowledged: false }],
      [{ role: "patient", acknowledged: true }],
      PATIENT_SILENT,
      BOTH_AGREE,
      [...BOTH_AGREE, { role: "other", acknowledged: false }],
      [...BOTH_AGREE, { role: "other", acknowledged: true }],
    ];
    let permittedCount = 0;
    for (const state of states) {
      for (const parties of partySets) {
        for (const purposeStated of [true, false]) {
          for (const retainTranscript of [true, false]) {
            const v = ambientVerdict({ state, parties, purposeStated, retainTranscript });
            expect(v.reasons.length).toBeGreaterThan(0);
            if (!v.permitted) {
              expect(v.retention).toBe("not-retained");
              continue;
            }
            permittedCount += 1;
            expect(US_JURISDICTIONS.has(state.trim().toUpperCase())).toBe(true);
            expect(purposeStated).toBe(true);
            expect(parties.some((p) => p.role === "patient")).toBe(true);
            expect(parties.some((p) => p.acknowledged)).toBe(true);
            if (v.rule !== "one_party") {
              expect(parties.every((p) => p.acknowledged)).toBe(true);
            }
          }
        }
      }
    }
    // And the matrix does contain permitted cases, so the sweep is not passing
    // by refusing everything.
    expect(permittedCount).toBeGreaterThan(0);
  });
});

describe("ambientVerdict — mustSay", () => {
  it("carries the room disclosure for an all-party state, permitted or not", () => {
    expect(ambientVerdict(consent({ state: "CA", parties: BOTH_AGREE })).mustSay).toBe(ROOM_DISCLOSURE);
    expect(ambientVerdict(consent({ state: "CA", parties: PATIENT_SILENT })).mustSay).toBe(ROOM_DISCLOSURE);
    expect(ambientVerdict(consent({ state: "IL", parties: BOTH_AGREE })).mustSay).toBe(ROOM_DISCLOSURE);
  });

  it("omits it where the law does not require the room to be told", () => {
    expect(ambientVerdict(consent({ state: "TX", parties: BOTH_AGREE })).mustSay).toBeUndefined();
  });

  it("offers a way out, because a notification is not a consent", () => {
    // The one thing this sentence cannot omit: refusing has to be free, and the
    // patient has to be told that it is.
    expect(ROOM_DISCLOSURE).toMatch(/switch it off/i);
    expect(ROOM_DISCLOSURE).toMatch(/will not change your care/i);
    expect(ROOM_DISCLOSURE).toMatch(/recording/i);
  });
});

describe("ambientVerdict — retention is a separate decision", () => {
  it("does not retain when retention was not asked for, even where capture is permitted", () => {
    const v = ambientVerdict(consent({ state: "CA", parties: BOTH_AGREE, retainTranscript: false }));
    expect(v.permitted).toBe(true);
    expect(v.retention).toBe("not-retained");
  });

  it("permits capture but refuses retention when only one party agreed in a one-party state", () => {
    // This is the whole point of the two fields. Listening is lawful here;
    // keeping a verbatim record of what the un-agreeing party said is a further
    // act, and agreement to the first is not agreement to the second.
    const v = ambientVerdict(consent({ state: "TX", parties: PATIENT_SILENT, retainTranscript: true }));
    expect(v.permitted).toBe(true);
    expect(v.retention).toBe("not-retained");
    expect(v.reasons.join(" ")).toMatch(/Retention: NOT retained, even though capture is permitted/);
  });

  it("retains only when retention was asked for and every party agreed", () => {
    expect(ambientVerdict(consent({ state: "TX", parties: BOTH_AGREE, retainTranscript: true })).retention).toBe(
      "retained",
    );
    expect(ambientVerdict(consent({ state: "CA", parties: BOTH_AGREE, retainTranscript: true })).retention).toBe(
      "retained",
    );
  });

  it("never retains when capture was refused", () => {
    const v = ambientVerdict(consent({ state: "CA", parties: PATIENT_SILENT, retainTranscript: true }));
    expect(v.permitted).toBe(false);
    expect(v.retention).toBe("not-retained");
  });

  it("reports the retention decision in words as well as in the field", () => {
    const v = ambientVerdict(consent({ state: "CA", parties: BOTH_AGREE, retainTranscript: true }));
    expect(v.reasons.some((r) => r.startsWith("Retention:"))).toBe(true);
  });
});

// ── Segmentation ─────────────────────────────────────────────────────────────

describe("segmentEncounter", () => {
  const segments = segmentEncounter(TRANSCRIPT);

  it("puts the exam finding in exam", () => {
    const finding = segments.find((s) => s.text.includes("tenderness over the left costal margin"));
    expect(finding).toBeDefined();
    expect(finding!.section).toBe("exam");
  });

  it("puts the opening chatter in other rather than force-fitting it", () => {
    expect(segments[0].section).toBe("other");
    expect(segments[0].text).toContain("sorry about the wait");
    expect(segments[0].start).toBe(0);
  });

  it("finds each spoken cue's section", () => {
    const sectionOf = (needle: string) => segments.find((s) => s.text.includes(needle))?.section;
    expect(sectionOf("what brings you in today")).toBe("chief_complaint");
    expect(sectionOf("How long has this been")).toBe("history");
    expect(sectionOf("My assessment is costochondritis")).toBe("assessment");
    expect(sectionOf("The plan is ibuprofen")).toBe("plan");
    expect(sectionOf("going to order a chest x-ray")).toBe("plan");
  });

  it("keeps offsets that point at the original transcript", () => {
    for (const s of segments) {
      expect(s.text).toBe(TRANSCRIPT.slice(s.start, s.end));
      expect(s.end).toBeGreaterThan(s.start);
    }
  });

  it("returns segments in order and never overlapping", () => {
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i].start).toBeGreaterThanOrEqual(segments[i - 1].end);
    }
  });

  it("leaves a transcript with no cues entirely in other", () => {
    const chat = "So the parking here is impossible and the lift was broken again.";
    const only = segmentEncounter(chat);
    expect(only).toHaveLength(1);
    expect(only[0]).toEqual({ section: "other", text: chat, start: 0, end: chat.length });
  });

  it("matches a cue whichever apostrophe the recogniser emitted", () => {
    const curly = segmentEncounter("Right. Let’s take a look. The ankle is swollen.");
    expect(curly.some((s) => s.section === "exam")).toBe(true);
  });

  it("tolerates a cue broken across a line", () => {
    const wrapped = segmentEncounter("So what brings you\nin today? My knee hurts.");
    expect(wrapped.some((s) => s.section === "chief_complaint")).toBe(true);
  });

  it("returns nothing for an empty transcript", () => {
    expect(segmentEncounter("")).toEqual([]);
  });

  it("exposes the cue table so a practice can see what drives the split", () => {
    const all = SECTION_CUES.flatMap((c) => c.cues);
    for (const spoken of ["what brings you in", "let's take a look", "my assessment is", "the plan is", "I'm going to order"]) {
      expect(all.map((c) => c.toLowerCase())).toContain(spoken.toLowerCase());
    }
  });
});

// ── The draft ────────────────────────────────────────────────────────────────

describe("draftEncounterCoding", () => {
  const segments = segmentEncounter(TRANSCRIPT);
  const draft = draftEncounterCoding(segments, { vocabulary: VOCABULARY });
  const termsSuggested = draft.suggestions.map((s) => s.term);

  it("suggests the assessed diagnosis as stated, with the sentence behind it", () => {
    const s = draft.suggestions.find((x) => x.term === "costochondritis");
    expect(s).toBeDefined();
    expect(s!.code).toBe("M94.0");
    expect(s!.kind).toBe("icd10");
    expect(s!.section).toBe("assessment");
    expect(s!.confidence).toBe("stated");
    expect(s!.evidence.text).toContain("costochondritis");
    expect(TRANSCRIPT.slice(s!.evidence.start, s!.evidence.end)).toBe(s!.evidence.text);
  });

  it("suggests the ordered procedure from the plan", () => {
    const s = draft.suggestions.find((x) => x.term === "chest x-ray");
    expect(s).toBeDefined();
    expect(s!.kind).toBe("cpt");
    expect(s!.code).toBe("71046");
    expect(s!.section).toBe("plan");
    expect(s!.confidence).toBe("stated");
  });

  it("marks a diagnosis term found outside the assessment as implied, not stated", () => {
    // An exam finding is a finding, not the clinician's diagnosis. Reporting it
    // as "stated" would put a coder's confidence behind a claim nobody made.
    const s = draft.suggestions.find((x) => x.term === "tenderness");
    expect(s).toBeDefined();
    expect(s!.section).toBe("exam");
    expect(s!.confidence).toBe("implied");
  });

  it("leaves the code off when the practice's vocabulary supplied none", () => {
    const s = draft.suggestions.find((x) => x.term === "tenderness");
    expect(s!.code).toBeUndefined();
    expect("code" in s!).toBe(false);
  });

  it("emits no suggestion for a vocabulary term that was never said", () => {
    expect(termsSuggested).not.toContain("chest pain");
    // And it is not smuggled into notCoded either — it was not mentioned, so
    // there is nothing to tell the coder about it.
    expect(draft.notCoded.join(" ")).not.toContain("chest pain");
  });

  it("never emits a suggestion without a real evidence span", () => {
    expect(draft.suggestions.length).toBeGreaterThan(0);
    for (const s of draft.suggestions) {
      expect(s.evidence.end).toBeGreaterThan(s.evidence.start);
      expect(s.evidence.text.trim().length).toBeGreaterThan(0);
      expect(s.evidence.text).toBe(TRANSCRIPT.slice(s.evidence.start, s.evidence.end));
      // The span has to contain the words that produced it, or it is pointing
      // somewhere the reviewer will not find the term.
      expect(s.evidence.text.toLowerCase()).toContain(s.term.toLowerCase().split(/\s+/)[0]);
    }
  });

  it("orders suggestions by where they appear in the encounter", () => {
    const starts = draft.suggestions.map((s) => s.evidence.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

describe("draftEncounterCoding — notCoded, so the coder sees what was skipped", () => {
  const segments = segmentEncounter(TRANSCRIPT);
  const draft = draftEncounterCoding(segments, { vocabulary: VOCABULARY });
  const skipped = draft.notCoded.join("\n");

  it("skips a negated finding and says which sentence negated it", () => {
    expect(draft.suggestions.map((s) => s.term)).not.toContain("fever");
    expect(skipped).toMatch(/fever — the transcript records it as absent/);
    expect(skipped).toContain("there is no fever");
  });

  it("skips a term said only in unsectioned conversation", () => {
    expect(draft.suggestions.map((s) => s.term)).not.toContain("diabetes");
    expect(skipped).toMatch(/diabetes — said, but only in unsectioned conversation/);
    expect(skipped).toMatch(/documentation error/);
  });

  it("skips an uncertain diagnosis rather than offering it as low confidence", () => {
    const uncertain = segmentEncounter("My assessment is possible pneumonia, we will see.");
    const d = draftEncounterCoding(uncertain, {
      vocabulary: [{ term: "pneumonia", code: "J18.9", kind: "icd10" }],
    });
    expect(d.suggestions).toHaveLength(0);
    expect(d.notCoded.join(" ")).toMatch(/Section IV\.H/);
  });

  it("downgrades a reported history to implied rather than skipping it", () => {
    const soft = segmentEncounter("My assessment is that her history of asthma is well controlled.");
    const d = draftEncounterCoding(soft, { vocabulary: [{ term: "asthma", code: "J45.909", kind: "icd10" }] });
    expect(d.suggestions).toHaveLength(1);
    expect(d.suggestions[0].confidence).toBe("implied");
  });

  it("says plainly when no vocabulary was supplied, instead of returning a clean empty draft", () => {
    const d = draftEncounterCoding(segments);
    expect(d.suggestions).toEqual([]);
    expect(d.notCoded.join(" ")).toMatch(/unconfigured/);
    expect(d.notCoded.join(" ")).toMatch(/no medical dictionary of its own/);
  });

  it("ignores vocabulary entries with no usable term", () => {
    const d = draftEncounterCoding(segments, {
      vocabulary: [{ term: "   ", code: "M94.0", kind: "icd10" }],
    });
    expect(d.suggestions).toEqual([]);
  });

  it("carries the same disclaimer on every draft it produces", () => {
    expect(draft.disclaimer).toBe(DRAFT_DISCLAIMER);
    expect(draftEncounterCoding([]).disclaimer).toBe(DRAFT_DISCLAIMER);
    expect(DRAFT_DISCLAIMER).toMatch(/DRAFT/);
    expect(DRAFT_DISCLAIMER).toMatch(/human coder/i);
    expect(DRAFT_DISCLAIMER).toMatch(/not a claim/i);
  });
});

// ── Rendering ────────────────────────────────────────────────────────────────

describe("renderAmbientDraft", () => {
  const segments = segmentEncounter(TRANSCRIPT);
  const draft = draftEncounterCoding(segments, { vocabulary: VOCABULARY });

  it("shows the draft under a permitted verdict, with spans and skips", () => {
    const out = renderAmbientDraft(draft, ambientVerdict(consent({ state: "CA", parties: BOTH_AGREE })));
    expect(out).toContain("Ambient capture: PERMITTED.");
    expect(out).toContain(DRAFT_DISCLAIMER);
    expect(out).toContain("M94.0");
    expect(out).toContain("code to be assigned by the coder");
    expect(out).toMatch(/Mentioned and not coded \(\d+\)/);
    expect(out).toContain(ROOM_DISCLOSURE);
  });

  it("withholds the draft entirely under a refusal", () => {
    const refused = ambientVerdict(consent({ state: "CA", parties: PATIENT_SILENT }));
    const out = renderAmbientDraft(draft, refused);
    expect(out).toContain("Ambient capture: NOT PERMITTED.");
    expect(out).toContain("No coding draft is shown");
    // Printing a useful draft under a refusal is how a refusal becomes advisory.
    expect(out).not.toContain("costochondritis");
    expect(out).not.toContain("M94.0");
  });

  it("reports retention separately from permission in the rendered text", () => {
    const out = renderAmbientDraft(
      draft,
      ambientVerdict(consent({ state: "TX", parties: PATIENT_SILENT, retainTranscript: true })),
    );
    expect(out).toContain("Ambient capture: PERMITTED.");
    expect(out).toContain("Retention: not-retained.");
  });
});

// ── The line this module must not cross ──────────────────────────────────────

describe("nothing here can produce a submittable claim", () => {
  const EXPECTED_EXPORTS = [
    "DRAFT_DISCLAIMER",
    "ROOM_DISCLOSURE",
    "SECTION_CUES",
    "US_JURISDICTIONS",
    "ambientVerdict",
    "draftEncounterCoding",
    "renderAmbientDraft",
    "segmentEncounter",
  ];

  it("exports exactly four functions and four inspectable constants", () => {
    expect(Object.keys(ambient).sort()).toEqual(EXPECTED_EXPORTS);
    const functions = EXPECTED_EXPORTS.filter(
      (name) => typeof (ambient as Record<string, unknown>)[name] === "function",
    );
    expect(functions.sort()).toEqual([
      "ambientVerdict",
      "draftEncounterCoding",
      "renderAmbientDraft",
      "segmentEncounter",
    ]);
  });

  it("exports nothing whose name suggests submission, billing or transmission", () => {
    // Whole name-tokens, not substrings: DRAFT_DISCLAIMER contains "claim" and
    // is exactly the opposite of the thing being guarded against.
    const FORBIDDEN = new Set([
      "submit", "submitted", "submission", "bill", "billing", "claim", "claims",
      "send", "post", "transmit", "encode", "charge", "invoice", "x12", "837", "cms1500",
    ]);
    for (const name of Object.keys(ambient)) {
      const tokens = name.split(/[_\W]+|(?<=[a-z0-9])(?=[A-Z])/).map((t) => t.toLowerCase());
      for (const token of tokens) expect(FORBIDDEN.has(token)).toBe(false);
    }
  });

  it("returns nothing claim-shaped from any of its producers", () => {
    // A claim is not a vibe, it is a set of fields. If none of them can appear
    // anywhere in anything this module returns, nothing it returns can be fed to
    // a payer without a human building the claim themselves — which is the point.
    const CLAIM_FIELDS = [
      "claimid", "claimnumber", "controlnumber", "charge", "charges", "chargeamount",
      "billedamount", "allowedamount", "units", "modifier", "modifiers", "payer",
      "payerid", "npi", "tin", "ein", "placeofservice", "pos", "servicelines",
      "serviceline", "subscriber", "memberid", "policynumber", "dateofservice",
      "dos", "renderingprovider", "billingprovider", "diagnosispointer", "cms1500",
      "x12", "837", "submit", "submitted", "status",
    ];
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          keys.add(k.toLowerCase().replace(/[^a-z0-9]/g, ""));
          walk(v);
        }
      }
    };

    const segments: EncounterSegment[] = segmentEncounter(TRANSCRIPT);
    const drafted = draftEncounterCoding(segments, { vocabulary: VOCABULARY });
    walk(ambientVerdict(consent({ state: "CA", parties: BOTH_AGREE, retainTranscript: true })));
    walk(ambientVerdict(consent({ state: "" })));
    walk(segments);
    walk(drafted);

    expect(keys.size).toBeGreaterThan(0);
    for (const field of CLAIM_FIELDS) expect(keys.has(field)).toBe(false);
  });

  it("gives a suggestion no money, no units and no modifier — the fields a claim needs", () => {
    const drafted = draftEncounterCoding(segmentEncounter(TRANSCRIPT), { vocabulary: VOCABULARY });
    for (const s of drafted.suggestions) {
      expect(Object.keys(s).sort()).toEqual(
        s.code
          ? ["code", "confidence", "evidence", "kind", "section", "term"]
          : ["confidence", "evidence", "kind", "section", "term"],
      );
    }
  });

  it("renders to a string, not to a document anything could post", () => {
    const out = renderAmbientDraft(
      draftEncounterCoding(segmentEncounter(TRANSCRIPT), { vocabulary: VOCABULARY }),
      ambientVerdict(consent({ state: "CA", parties: BOTH_AGREE })),
    );
    expect(typeof out).toBe("string");
    expect(out).not.toMatch(/CMS-?1500|837P?|X12|ISA\*|CLM\*/);
    expect(out).not.toMatch(/\$\d/);
  });
});
