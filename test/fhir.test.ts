import { describe, expect, it } from "vitest";
import {
  DECISION_TIMEFRAMES_EFFECTIVE,
  EXPEDITED_DECISION_HOURS,
  STANDARD_DECISION_CALENDAR_DAYS,
  daysUntilApiMandate,
  decisionDeadline,
  renderDeadline,
  renderSettled,
} from "../src/fhir/pa-clock.js";
import {
  buildCrdHook,
  checkRequirement,
  readCrdCards,
  renderCrd,
  ruleFromDenial,
  type PaRule,
} from "../src/fhir/crd.js";
import {
  applyAnswers,
  needsClinician,
  prefill,
  renderPrefill,
  toQuestionnaireResponse,
  type Questionnaire,
} from "../src/fhir/dtr.js";
import { buildPasBundle, readPasResponse, validatePas, type PasRequest } from "../src/fhir/pas.js";
import {
  attest,
  canonicalize,
  fingerprint,
  generateKeypair,
  signingPayload,
  verifyAttestation,
  type ClaimStatement,
} from "../src/a2a/attestation.js";
import {
  applyMessage,
  openNegotiation,
  reconcile,
  summarize,
  type A2AMessage,
  type MessageType,
  type Negotiation,
  type Party,
} from "../src/a2a/negotiate.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

// ── The decision clock ───────────────────────────────────────────────────────

describe("pa-clock", () => {
  const received = Date.UTC(2026, 2, 2, 9, 0); // Mon 2 Mar 2026, 09:00 UTC

  it("gives expedited requests 72 hours measured to the hour, not the end of day three", () => {
    const deadline = decisionDeadline(received, "expedited", received);
    expect(deadline.dueAt).toBe(received + EXPEDITED_DECISION_HOURS * HOUR);
    expect(new Date(deadline.dueAt).toISOString()).toBe("2026-03-05T09:00:00.000Z");

    // The mistake this guards against: treating it as three calendar days and
    // letting the payer have until midnight at the end of the third day.
    const endOfDayThree = Date.UTC(2026, 2, 5, 23, 59, 59);
    expect(deadline.dueAt).toBeLessThan(endOfDayThree);
  });

  it("gives standard requests seven CALENDAR days, weekend included", () => {
    const deadline = decisionDeadline(received, "standard", received);
    expect(deadline.dueAt).toBe(received + STANDARD_DECISION_CALENDAR_DAYS * DAY);
    expect(new Date(deadline.dueAt).toISOString()).toBe("2026-03-09T09:00:00.000Z");
    expect(deadline.notes.join(" ")).toMatch(/CALENDAR days/);
  });

  it("reports lateness in hours and renders it", () => {
    const now = received + 80 * HOUR;
    const deadline = decisionDeadline(received, "expedited", now);
    expect(deadline.late).toBe(true);
    expect(deadline.hoursLate).toBeCloseTo(8, 6);
    expect(deadline.hoursRemaining).toBeCloseTo(-8, 6);
    expect(renderDeadline(deadline)).toMatch(/OVERDUE by 8\.0 hour/);
  });

  it("counts hours remaining while still inside the window", () => {
    const deadline = decisionDeadline(received, "expedited", received + 24 * HOUR);
    expect(deadline.late).toBe(false);
    expect(deadline.hoursLate).toBe(0);
    expect(deadline.hoursRemaining).toBeCloseTo(48, 6);
  });

  it("marks a request predating the rule as uncovered rather than silently applying it", () => {
    const before = Date.UTC(2025, 11, 20, 9, 0);
    const deadline = decisionDeadline(before, "standard", before);
    expect(deadline.covered).toBe(false);
    expect(deadline.notes[0]).toContain(DECISION_TIMEFRAMES_EFFECTIVE);
    expect(deadline.notes[0]).toMatch(/contract or state law governs/);

    expect(decisionDeadline(Date.UTC(2026, 0, 1, 0, 0), "standard", received).covered).toBe(true);
  });

  it("measures a decided request against when it was decided, not against now", () => {
    const decidedAt = received + 80 * HOUR;
    const muchLater = received + 40 * DAY;

    // The same settled request, read forty days later. A live clock would report
    // it as ever more overdue; the settled reading does not move.
    const settled = decisionDeadline(received, "expedited", decidedAt);
    expect(renderSettled(settled)).toBe("Decided 8.0 hour(s) late — it was due 2026-03-05 09:00 UTC.");
    expect(decisionDeadline(received, "expedited", muchLater).hoursLate).toBeCloseTo(40 * 24 - 72, 6);

    const onTime = decisionDeadline(received, "expedited", received + 60 * HOUR);
    expect(renderSettled(onTime)).toMatch(/Decided within the required timeframe, 12\.0 hour\(s\) before/);
  });

  it("counts down to the API compliance date and goes negative past it", () => {
    expect(daysUntilApiMandate(Date.UTC(2026, 11, 2))).toBe(30);
    expect(daysUntilApiMandate(Date.UTC(2027, 0, 1))).toBe(0);
    expect(daysUntilApiMandate(Date.UTC(2027, 0, 31))).toBe(-30);
  });
});

// ── Coverage requirements discovery ──────────────────────────────────────────

describe("crd", () => {
  const rules: PaRule[] = [
    { payer: "Acme Health", code: "97110", requirement: "required", condition: "", source: "denial CARC 197", updatedAt: 1 },
    { payer: "Acme Health", code: "99213", requirement: "not_required", condition: "", source: "payer policy", updatedAt: 1 },
    {
      payer: "Acme Health",
      code: "72148",
      requirement: "conditional",
      condition: "required in an outpatient hospital setting, not in an office",
      source: "payer policy",
      updatedAt: 1,
    },
  ];

  it("keeps unknown distinct from not_required", () => {
    const unknown = checkRequirement({ payer: "Acme Health", code: "20610", placeOfService: "11", urgent: false }, rules);
    expect(unknown.requirement).toBe("unknown");
    expect(unknown.rule).toBeNull();
    expect(unknown.reason).toMatch(/not the same as "no authorization needed"/);

    const notRequired = checkRequirement({ payer: "Acme Health", code: "99213", placeOfService: "11", urgent: false }, rules);
    expect(notRequired.requirement).toBe("not_required");
    expect(notRequired.requirement).not.toBe(unknown.requirement);
  });

  it("matches regardless of payer punctuation and code formatting", () => {
    const verdict = checkRequirement({ payer: "acme  health!", code: " 97110 ", placeOfService: "11", urgent: false }, rules);
    expect(verdict.requirement).toBe("required");
  });

  it("tells an urgent order about the 72-hour clock and a standard one about seven days", () => {
    expect(
      checkRequirement({ payer: "Acme Health", code: "97110", placeOfService: "11", urgent: true }, rules).action,
    ).toMatch(/72 hours/);
    expect(
      checkRequirement({ payer: "Acme Health", code: "97110", placeOfService: "11", urgent: false }, rules).action,
    ).toMatch(/seven calendar days/);
  });

  it("returns the deciding circumstance for a conditional rule", () => {
    const verdict = checkRequirement({ payer: "Acme Health", code: "72148", placeOfService: "22", urgent: false }, rules);
    expect(verdict.requirement).toBe("conditional");
    expect(verdict.reason).toContain("outpatient hospital setting");
    expect(renderCrd(verdict)).toMatch(/CONDITIONAL/);
  });

  it("learns a rule from an authorization denial and only from one", () => {
    const learned = ruleFromDenial("Acme Health", "7 21.48", "197", 500);
    expect(learned).toEqual({
      payer: "Acme Health",
      code: "72148",
      requirement: "required",
      condition: "",
      source: "denial CARC 197",
      updatedAt: 500,
    });
    expect(ruleFromDenial("Acme Health", "72148", "45", 500)).toBeNull();
    expect(ruleFromDenial("Acme Health", "72148", "16", 500)).toBeNull();
  });

  it("fires the CRD hook on order-sign rather than order-select", () => {
    const hook = buildCrdHook({
      hookInstance: "hi-1",
      patientRef: "PT-9",
      userRef: "Practitioner/1",
      orderResource: { resourceType: "ServiceRequest", id: "sr-1" },
    });
    expect(hook.hook).toBe("order-sign");
    expect(hook.context.patientId).toBe("PT-9");
  });

  it("reads payer cards for the two actionable facts and passes the rest through verbatim", () => {
    const response = readCrdCards([
      {
        summary: "Prior authorization is required for this service",
        detail: "Submit through the provider portal with clinical notes.",
        links: [{ label: "Complete DTR questionnaire", url: "https://payer.example/dtr", type: "smart" }],
      },
    ]);
    expect(response.requirement).toBe("required");
    expect(response.dtrLaunchUrl).toBe("https://payer.example/dtr");
    expect(response.cards[0]).toContain("Submit through the provider portal");
  });

  it("treats a silent service as unknown, not as permission", () => {
    const empty = readCrdCards([]);
    expect(empty.requirement).toBe("unknown");
    expect(empty.warnings[0]).toMatch(/not that authorization is unnecessary/);

    const vague = readCrdCards([{ summary: "Coverage varies by plan." }]);
    expect(vague.requirement).toBe("unknown");
    expect(vague.warnings[0]).toMatch(/did not state plainly/);
  });

  // Payers phrase this a dozen ways and the negations are the ones that get
  // missed — "does not require prior authorization" is about the most common way
  // of saying no, and reading it as anything but not_required is a real cost.
  it.each([
    ["This service does not require prior authorization.", "not_required"],
    ["No prior authorization is needed for CPT 99213.", "not_required"],
    ["Prior authorization is not required for this member.", "not_required"],
    ["Authorization is not required.", "not_required"],
    ["This code may be rendered without prior authorization.", "not_required"],
    ["Pre-authorization is not required.", "not_required"],
    ["Prior authorization requirement is waived for in-network providers.", "not_required"],
    ["This service requires prior authorization.", "required"],
    ["Prior authorization is required.", "required"],
    ["Prior auth required before scheduling.", "required"],
    ["Pre-authorization required.", "required"],
    ["This procedure requires pre-auth.", "required"],
    ["You must obtain prior authorization before the date of service.", "required"],
    ["Precertification is required for advanced imaging.", "required"],
    ["Coverage varies by plan.", "unknown"],
    ["Submit through the provider portal with clinical notes.", "unknown"],
    ["Member has no active coverage on the date of service.", "unknown"],
  ])("classifies %j as %s", (summary, expected) => {
    expect(readCrdCards([{ summary }]).requirement).toBe(expected);
  });
});

// ── DTR prefill ──────────────────────────────────────────────────────────────

describe("dtr", () => {
  const questionnaire: Questionnaire = {
    id: "q-1",
    title: "Physical therapy authorization",
    payer: "Acme Health",
    items: [
      { linkId: "dx", text: "Primary diagnosis", type: "string", required: true, source: "claim.primaryDiagnosis" },
      { linkId: "visits", text: "Visits completed to date", type: "integer", required: true, source: "history.visits" },
      { linkId: "site", text: "Treatment site", type: "choice", required: true, source: "claim.site", options: ["left knee", "right knee"] },
      { linkId: "necessity", text: "Explain why this is medically necessary", type: "string", required: true },
      { linkId: "prior", text: "Has the patient failed conservative therapy?", type: "boolean", required: true, source: "history.failedConservative" },
      { linkId: "notes", text: "Additional comments", type: "string", required: false },
    ],
  };

  const context = {
    claim: { primaryDiagnosis: "M17.11", site: "left knee" },
    history: { visits: 6, failedConservative: true },
  };

  it("recognises questions only a person can answer", () => {
    expect(needsClinician("Explain why this is medically necessary")).toBe(true);
    expect(needsClinician("Has the patient failed conservative therapy?")).toBe(true);
    expect(needsClinician("I attest the above is accurate")).toBe(true);
    expect(needsClinician("What is the expected outcome of treatment?")).toBe(true);
    expect(needsClinician("Primary diagnosis")).toBe(false);
    expect(needsClinician("Visits completed to date")).toBe(false);
  });

  it("fills from the record and refuses to invent clinical assertions", () => {
    const result = prefill(questionnaire, context);
    const byId = Object.fromEntries(result.answers.map((a) => [a.linkId, a]));

    expect(byId.dx.value).toBe("M17.11");
    expect(byId.dx.origin).toBe("prefilled");
    expect(byId.dx.provenance).toContain("claim.primaryDiagnosis");
    expect(byId.visits.value).toBe(6);

    // Sourced, and the record HAS the value — but the question asks for a
    // clinical assertion, so the source is not consulted at all.
    expect(byId.prior.origin).toBe("needs_clinician");
    expect(byId.prior.value).toBeNull();
    expect(byId.necessity.origin).toBe("needs_clinician");

    expect(byId.notes.origin).toBe("unanswered");
    expect(byId.notes.provenance).toBe("No mapping to the record.");

    expect(result.complete).toBe(false);
    expect(result.clinicianRequired.map((a) => a.linkId).sort()).toEqual(["necessity", "prior"]);
    expect(result.warnings.join(" ")).toMatch(/nobody typed/);
  });

  it("leaves a choice answer outside the payer's option set blank rather than mapping it to the nearest", () => {
    const result = prefill(questionnaire, {
      ...context,
      claim: { primaryDiagnosis: "M17.11", site: "bilateral knees" },
    });
    const site = result.answers.find((a) => a.linkId === "site")!;
    expect(site.value).toBeNull();
    expect(site.origin).toBe("unanswered");
    expect(site.provenance).toContain("bilateral knees");
    expect(site.provenance).toContain("left knee, right knee");
    expect(result.warnings.join(" ")).toMatch(/would be this tool making a clinical answer/);
  });

  it("names missing required answers instead of looking complete", () => {
    const result = prefill(questionnaire, { history: { visits: 6 } });
    expect(result.missingRequired.map((a) => a.linkId).sort()).toEqual(["dx", "site"]);
    expect(renderPrefill(result)).toMatch(/Not submittable yet/);
  });

  it("will not emit a QuestionnaireResponse from prefill alone", () => {
    const result = prefill(questionnaire, context);
    const emitted = toQuestionnaireResponse(questionnaire, result, "Patient/PT-9", "2026-03-02T09:00:00Z");
    expect(typeof emitted).toBe("string");
    expect(emitted).toMatch(/assertions nobody made/);
  });

  it("records a clinician's answers as theirs, not as machine-filled", () => {
    const result = applyAnswers(prefill(questionnaire, context), {
      necessity: "Persistent pain and functional deficit after six weeks of home exercise.",
      prior: true,
    });
    const necessity = result.answers.find((a) => a.linkId === "necessity")!;
    expect(necessity.origin).toBe("clinician_answered");
    expect(necessity.origin).not.toBe("prefilled");
    expect(necessity.provenance).toBe("Answered by the reviewing clinician.");
    expect(result.clinicianRequired).toHaveLength(0);
    expect(result.complete).toBe(true);

    const emitted = toQuestionnaireResponse(questionnaire, result, "Patient/PT-9", "2026-03-02T09:00:00Z") as Record<
      string,
      unknown
    >;
    expect(emitted.resourceType).toBe("QuestionnaireResponse");
    expect(emitted.status).toBe("completed");
    const items = emitted.item as Array<{ linkId: string; answer: Array<Record<string, unknown>> }>;
    expect(items.find((i) => i.linkId === "visits")!.answer[0]).toEqual({ valueInteger: 6 });
    expect(items.find((i) => i.linkId === "prior")!.answer[0]).toEqual({ valueBoolean: true });
    expect(items.map((i) => i.linkId)).not.toContain("notes");
    expect(renderPrefill(result)).toMatch(/It still needs reading before it is sent/);
  });

  it("types each answer from the questionnaire, not from the JavaScript value", () => {
    const typed: Questionnaire = {
      id: "q-2",
      title: "Typed",
      payer: "Acme Health",
      items: [
        { linkId: "onset", text: "Date of onset", type: "date", required: true, source: "history.onset" },
        { linkId: "freq", text: "Visits per week", type: "decimal", required: true, source: "plan.frequency" },
        { linkId: "count", text: "Visits requested", type: "integer", required: true, source: "plan.count" },
      ],
    };
    // A whole-numbered decimal and a date string are the two cases value-sniffing
    // gets wrong: valueInteger and valueString, both rejected by the payer.
    const result = prefill(typed, { history: { onset: "2026-01-14" }, plan: { frequency: 2.0, count: 12 } });
    expect(result.complete).toBe(true);

    const emitted = toQuestionnaireResponse(typed, result, "Patient/PT-9", "2026-03-02T09:00:00Z") as Record<string, unknown>;
    const items = emitted.item as Array<{ linkId: string; answer: Array<Record<string, unknown>> }>;
    expect(items.find((i) => i.linkId === "onset")!.answer[0]).toEqual({ valueDate: "2026-01-14" });
    expect(items.find((i) => i.linkId === "freq")!.answer[0]).toEqual({ valueDecimal: 2 });
    expect(items.find((i) => i.linkId === "count")!.answer[0]).toEqual({ valueInteger: 12 });
  });
});

// ── PAS ──────────────────────────────────────────────────────────────────────

describe("pas", () => {
  const request: PasRequest = {
    patientRef: "PT-9",
    payer: "Acme Health",
    requestingProviderNpi: "1234567893",
    performingProviderNpi: "1234567893",
    diagnoses: ["M17.11"],
    services: [
      { code: "97110", codeSystem: "http://www.ama-assn.org/go/cpt", quantity: 12, startDate: "2026-03-10", endDate: "2026-05-10", diagnosisRefs: [1] },
    ],
    urgent: false,
    questionnaireResponses: ["qr-1"],
  };

  it("accepts a well-formed request", () => {
    const validation = validatePas(request);
    expect(validation.ok).toBe(true);
    expect(validation.problems).toEqual([]);
    expect(validation.warnings).toEqual([]);
  });

  it("refuses a service that points at no diagnosis, and says why it matters", () => {
    const validation = validatePas({
      ...request,
      services: [{ ...request.services[0], diagnosisRefs: [] }],
    });
    expect(validation.ok).toBe(false);
    expect(validation.problems[0]).toMatch(/denied for medical necessity/);
  });

  it("catches a dangling diagnosis pointer, bad NPIs and inverted dates", () => {
    const validation = validatePas({
      ...request,
      requestingProviderNpi: "12345",
      services: [{ ...request.services[0], startDate: "2026-05-10", endDate: "2026-03-10", diagnosisRefs: [3] }],
    });
    expect(validation.problems.join(" ")).toMatch(/Requesting provider NPI must be ten digits/);
    expect(validation.problems.join(" ")).toMatch(/points at diagnosis 3, but only 1 are listed/);
    expect(validation.problems.join(" ")).toMatch(/ends before it starts/);
  });

  it("warns that expedited is a clinical assertion, not a queue jump", () => {
    const validation = validatePas({ ...request, urgent: true });
    expect(validation.ok).toBe(true);
    expect(validation.warnings[0]).toMatch(/seriously jeopardise/);
  });

  it("warns when no questionnaire response is attached", () => {
    expect(validatePas({ ...request, questionnaireResponses: [] }).warnings.join(" ")).toMatch(/pended for information/);
  });

  it("builds a Claim with use=preauthorization — the word that makes it a request", () => {
    const bundle = buildPasBundle(request, "pa-1") as Record<string, unknown>;
    const claim = (bundle.entry as Array<{ resource: Record<string, unknown> }>)[0].resource;
    expect(claim.use).toBe("preauthorization");
    expect(claim.id).toBe("pa-1");
    const priority = claim.priority as { coding: Array<{ code: string }> };
    expect(priority.coding[0].code).toBe("normal");
    const item = (claim.item as Array<Record<string, unknown>>)[0];
    expect(item.diagnosisSequence).toEqual([1]);
    expect((item.servicedPeriod as Record<string, string>).end).toBe("2026-05-10");
    expect((claim.supportingInfo as unknown[]).length).toBe(1);
  });

  it("marks an urgent request stat and refuses to build an invalid one", () => {
    const urgent = buildPasBundle({ ...request, urgent: true }, "pa-2") as Record<string, unknown>;
    const claim = (urgent.entry as Array<{ resource: Record<string, unknown> }>)[0].resource;
    expect((claim.priority as { coding: Array<{ code: string }> }).coding[0].code).toBe("stat");

    expect(buildPasBundle({ ...request, diagnoses: [] }, "pa-3")).toMatch(/^Not built:/);
  });

  it("flags a partial approval — the case that reads as approved and carries a number", () => {
    const response = readPasResponse(
      {
        outcome: "complete",
        preAuthRef: "AUTH-77",
        item: [
          { itemSequence: 1, adjudication: [{ category: { coding: [{ code: "approved" }] } }] },
          {
            itemSequence: 2,
            adjudication: [{ category: { coding: [{ code: "denied" }] }, reason: { coding: [{ display: "Not medically necessary" }] } }],
          },
        ],
      },
      ["97110", "97140"],
    );
    expect(response.outcome).toBe("partial");
    expect(response.authorizationNumber).toBe("AUTH-77");
    expect(response.services[1]).toEqual({ code: "97140", decision: "denied", reason: "Not medically necessary" });
    expect(response.gaps.join(" ")).toMatch(/97140 was refused/);
  });

  it("flags an approval with no authorization number", () => {
    const response = readPasResponse(
      { outcome: "complete", item: [{ itemSequence: 1, adjudication: [{ category: { coding: [{ code: "approved" }] } }] }] },
      ["97110"],
    );
    expect(response.outcome).toBe("approved");
    expect(response.authorizationNumber).toBe("");
    expect(response.gaps[0]).toMatch(/Nothing is authorized without one/);
  });

  it("flags services that came back undecided", () => {
    const response = readPasResponse(
      {
        outcome: "complete",
        preAuthRef: "AUTH-1",
        item: [{ itemSequence: 1, adjudication: [{ category: { coding: [{ code: "approved" }] } }] }],
      },
      ["97110", "97140", "97530"],
    );
    expect(response.gaps.join(" ")).toMatch(/3 service\(s\) were requested and 1 came back/);
  });

  it("names the invisible X12 278 leg when the payer returns an error", () => {
    const response = readPasResponse(
      { outcome: "error", error: [{ code: { coding: [{ display: "Missing UMO identifier" }] } }] },
      ["97110"],
    );
    expect(response.outcome).toBe("error");
    expect(response.gaps.join(" ")).toMatch(/X12 278/);
    expect(response.gaps.join(" ")).toMatch(/never seen here/);
  });

  it("reads a pended response as pended rather than approved", () => {
    expect(readPasResponse({ outcome: "queued", disposition: "Pended for medical review" }, ["97110"]).outcome).toBe("pended");
  });
});

// ── Attestations ─────────────────────────────────────────────────────────────

describe("attestation", () => {
  const statement: ClaimStatement = {
    claimId: "CLM-100",
    payer: "Acme Health",
    patientRef: "PT-9",
    billedCents: 45_000,
    codes: ["97110"],
    diagnoses: ["M17.11"],
    serviceDate: "2026-03-10",
    assertion: "Twelve therapy visits were rendered as documented.",
  };

  it("canonicalizes independently of key order", () => {
    expect(canonicalize({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("round-trips a signature and reports a known key as trusted", () => {
    const keys = generateKeypair();
    const attestation = attest(statement, keys, { id: "att-1", signerId: "practice", signedAt: 1_000, auditSeq: 7, auditHash: "abc" });
    const result = verifyAttestation(attestation, { practice: keys.publicKeyPem }, { seq: 7, hash: "abc" });

    expect(result.signatureValid).toBe(true);
    expect(result.trust).toBe("known_key");
    expect(result.anchorValid).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.notes.join(" ")).toMatch(/authorship, not correctness/);
    expect(attestation.keyId).toBe(fingerprint(keys.publicKeyPem));
  });

  it("fails verification when any signed field is altered", () => {
    const keys = generateKeypair();
    const attestation = attest(statement, keys, { id: "att-1", signerId: "practice", signedAt: 1_000 });

    for (const tampered of [
      { ...attestation, statement: { ...statement, billedCents: 450_000 } },
      { ...attestation, signedAt: 2_000 },
      { ...attestation, signerId: "someone-else" },
      { ...attestation, auditSeq: 99 },
    ]) {
      const result = verifyAttestation(tampered, { practice: keys.publicKeyPem });
      expect(result.signatureValid).toBe(false);
      expect(result.problems[0]).toMatch(/signature does not verify/);
    }
  });

  it("treats a key it has never seen as unknown, not as valid", () => {
    const keys = generateKeypair();
    const attestation = attest(statement, keys, { id: "att-1", signerId: "stranger", signedAt: 1_000 });
    const result = verifyAttestation(attestation, {});

    // The cryptography passes and the identity does not, and the two are
    // reported separately because conflating them is the whole trap.
    expect(result.signatureValid).toBe(true);
    expect(result.trust).toBe("unknown_key");
    expect(result.problems[0]).toMatch(/chosen by whoever sent it/);
  });

  it("refuses a key substitution for a signer already on file", () => {
    const ours = generateKeypair();
    const theirs = generateKeypair();
    const attestation = attest(statement, theirs, { id: "att-1", signerId: "practice", signedAt: 1_000 });
    const result = verifyAttestation(attestation, { practice: ours.publicKeyPem });

    expect(result.signatureValid).toBe(true);
    expect(result.trust).toBe("key_mismatch");
    expect(result.problems[0]).toMatch(/not a key rotation/);
  });

  it("catches an anchor that disagrees with this log, and says when it is unanchored", () => {
    const keys = generateKeypair();
    const anchored = attest(statement, keys, { id: "att-1", signerId: "practice", signedAt: 1_000, auditSeq: 7, auditHash: "abc" });
    const mismatch = verifyAttestation(anchored, { practice: keys.publicKeyPem }, { seq: 7, hash: "def" });
    expect(mismatch.anchorChecked).toBe(true);
    expect(mismatch.anchorValid).toBe(false);
    expect(mismatch.problems[0]).toMatch(/disagree about what had happened/);

    const unchecked = verifyAttestation(anchored, { practice: keys.publicKeyPem });
    expect(unchecked.anchorChecked).toBe(false);
    expect(unchecked.notes.join(" ")).toMatch(/anchor is unverified/);

    const loose = attest(statement, keys, { id: "att-2", signerId: "practice", signedAt: 1_000 });
    expect(verifyAttestation(loose, { practice: keys.publicKeyPem }).notes.join(" ")).toMatch(/Unanchored/);
  });

  it("signs over everything except the signature itself", () => {
    const keys = generateKeypair();
    const attestation = attest(statement, keys, { id: "att-1", signerId: "practice", signedAt: 1_000 });
    const { signature, ...unsigned } = attestation;
    expect(signature.length).toBeGreaterThan(0);
    expect(signingPayload(unsigned)).not.toContain(signature);
    expect(signingPayload(unsigned)).toContain("CLM-100");
  });
});

// ── Negotiation ──────────────────────────────────────────────────────────────

describe("negotiate", () => {
  const open = () => openNegotiation({ id: "neg-1", claimId: "CLM-100", payer: "Acme Health", billedCents: 45_000 });

  let seq = 0;
  function msg(from: Party, type: MessageType, extra: Partial<A2AMessage> = {}): A2AMessage {
    seq++;
    return { id: `m-${seq}`, from, type, createdAt: seq, ...extra };
  }

  function send(negotiation: Negotiation, message: A2AMessage): Negotiation {
    const result = applyMessage(negotiation, message);
    expect(result.rejection).toBe("");
    expect(result.ok).toBe(true);
    return result.negotiation;
  }

  it("runs a full evidence-and-offer round to agreement", () => {
    let n = open();
    n = send(n, msg("payer", "request_evidence", { evidence: ["progress notes", "treatment plan"] }));
    expect(n.state).toBe("evidence_requested");

    n = send(n, msg("provider", "provide_evidence", { evidence: ["progress notes", "treatment plan"] }));
    expect(n.state).toBe("evidence_provided");
    expect(n.warnings).toEqual([]);

    n = send(n, msg("payer", "propose_adjustment", { amountCents: 30_000, attestationId: "att-1" }));
    expect(n.state).toBe("offer_on_table");
    expect(n.offerFrom).toBe("payer");

    n = send(n, msg("provider", "accept", { amountCents: 30_000, attestationId: "att-2" }));
    expect(n.state).toBe("agreed");
    expect(n.agreedCents).toBe(30_000);

    const outcome = summarize(n);
    expect(outcome.binding).toBe(false);
    expect(outcome.concessionCents).toBe(15_000);
    expect(outcome.signedThroughout).toBe(true);
    expect(outcome.notes[0]).toMatch(/not a payment determination/);
  });

  it("will not let a party accept its own offer", () => {
    let n = open();
    n = send(n, msg("provider", "propose_adjustment", { amountCents: 40_000 }));
    const result = applyMessage(n, msg("provider", "accept"));
    expect(result.ok).toBe(false);
    expect(result.rejection).toMatch(/a note to itself/);
    expect(result.negotiation.state).toBe("offer_on_table");
  });

  it("treats an acceptance at a different number as a counter-offer, not an agreement", () => {
    let n = open();
    n = send(n, msg("payer", "propose_adjustment", { amountCents: 30_000 }));
    const result = applyMessage(n, msg("provider", "accept", { amountCents: 35_000 }));
    expect(result.ok).toBe(false);
    expect(result.rejection).toMatch(/send it as one/);
  });

  it("enforces who may say what, and when", () => {
    const n = open();
    expect(applyMessage(n, msg("provider", "request_evidence", { evidence: ["notes"] })).rejection).toMatch(
      /provider may not send request_evidence/,
    );
    expect(applyMessage(n, msg("payer", "withdraw")).rejection).toMatch(/payer may not send withdraw/);
    expect(applyMessage(n, msg("provider", "accept")).rejection).toMatch(/not valid while the negotiation is presented/);
    expect(applyMessage(n, msg("provider", "present_claim")).rejection).toMatch(/cannot be presented again/);
    expect(applyMessage(n, msg("payer", "request_evidence", { evidence: [] })).rejection).toMatch(/cannot be answered/);
  });

  it("closes a terminal negotiation rather than letting it be rewritten", () => {
    let n = open();
    n = send(n, msg("provider", "withdraw"));
    expect(n.state).toBe("withdrawn");
    const result = applyMessage(n, msg("payer", "propose_adjustment", { amountCents: 1_000 }));
    expect(result.ok).toBe(false);
    expect(result.rejection).toMatch(/start a new negotiation/);
  });

  it("warns on a partial evidence response, an offer above charges, and bidding against yourself", () => {
    let n = open();
    n = send(n, msg("payer", "request_evidence", { evidence: ["progress notes", "operative report"] }));
    n = send(n, msg("provider", "provide_evidence", { evidence: ["progress notes"] }));
    expect(n.warnings.join(" ")).toMatch(/Answered without supplying: operative report/);

    n = send(n, msg("payer", "propose_adjustment", { amountCents: 50_000 }));
    expect(n.warnings.join(" ")).toMatch(/exceeds the \$450\.00 billed/);

    n = send(n, msg("payer", "propose_adjustment", { amountCents: 48_000 }));
    expect(n.warnings.join(" ")).toMatch(/Bidding against yourself/);
  });

  it("rejects a proposal with no amount", () => {
    expect(applyMessage(open(), msg("payer", "propose_adjustment")).rejection).toMatch(/must carry an amount/);
  });

  it("marks an unsigned money trail as repudiable", () => {
    let n = open();
    n = send(n, msg("payer", "propose_adjustment", { amountCents: 30_000 }));
    n = send(n, msg("provider", "accept"));
    const outcome = summarize(n);
    expect(outcome.signedThroughout).toBe(false);
    expect(outcome.notes.join(" ")).toMatch(/repudiable/);
  });

  it("says a dispute here has no procedural standing of its own", () => {
    let n = open();
    n = send(n, msg("provider", "dispute", { reason: "Underpaid against contract" }));
    expect(n.state).toBe("disputed");
    expect(summarize(n).notes.join(" ")).toMatch(/deadlines, and those did not pause/);
  });

  it("reconciles an agreement against what actually paid", () => {
    let n = open();
    n = send(n, msg("payer", "propose_adjustment", { amountCents: 30_000 }));
    n = send(n, msg("provider", "accept"));

    expect(reconcile(n, 30_000)).toMatchObject({ matched: true, shortfallCents: 0 });

    const short = reconcile(n, 22_000);
    expect(short.matched).toBe(false);
    expect(short.shortfallCents).toBe(8_000);
    expect(short.finding).toMatch(/Underpaid by \$80\.00/);
    expect(short.finding).toMatch(/own agent is on the record/);

    const over = reconcile(n, 34_000);
    expect(over.shortfallCents).toBe(-4_000);
    expect(over.finding).toMatch(/60-day report-and-return clock/);
  });

  it("does not pretend an unfinished negotiation settled anything", () => {
    const result = reconcile(open(), 30_000);
    expect(result.matched).toBe(false);
    expect(result.agreedCents).toBe(0);
    expect(result.finding).toMatch(/Nothing was agreed/);
  });
});
