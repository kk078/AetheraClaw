// ── Documentation Templates and Rules ────────────────────────────────────────
// DTR pulls the payer's own questionnaire and fills in what the record already
// answers, so a clinician confirms rather than retypes. The saving is real and
// so is the hazard, and they are the same mechanism.
//
// A prior authorization request is a statement to a payer about a patient. An
// autofilled answer that is wrong is a false statement that nobody typed and
// nobody read — the clinician signed a form whose answers appeared on their
// own. So every prefilled answer here carries where it came from, answers that
// could not be filled are named rather than left looking complete, and a
// questionnaire is never submitted straight from prefill.

export type AnswerType = "boolean" | "string" | "integer" | "decimal" | "date" | "choice";

export interface QuestionnaireItem {
  linkId: string;
  text: string;
  type: AnswerType;
  required: boolean;
  /**
   * Where the answer lives in the practice's data, when it lives anywhere.
   * A dotted path into the context object handed to prefill.
   */
  source?: string;
  /** choice questions: the allowed answers. */
  options?: string[];
}

export interface Questionnaire {
  id: string;
  title: string;
  payer: string;
  items: QuestionnaireItem[];
}

export type AnswerOrigin = "prefilled" | "unanswered" | "needs_clinician" | "clinician_answered";

export interface Answer {
  linkId: string;
  text: string;
  /** The questionnaire's declared type, carried so the emitted answer is typed from it. */
  type: AnswerType;
  value: string | number | boolean | null;
  origin: AnswerOrigin;
  /** Exactly where the value came from — printed beside it for review. */
  provenance: string;
  required: boolean;
}

export interface PrefillResult {
  questionnaireId: string;
  answers: Answer[];
  /** Required questions with no answer. The form is not submittable while these exist. */
  missingRequired: Answer[];
  /** Questions only a clinician can answer, whatever is in the record. */
  clinicianRequired: Answer[];
  complete: boolean;
  warnings: string[];
}

/**
 * Questions a record cannot answer.
 *
 * Clinical judgement, failure of conservative therapy, and anything phrased as
 * an attestation are the payer asking a person to assert something. Filling
 * those from structured data would be inventing the assertion, which is exactly
 * the failure this module is built to avoid.
 */
const CLINICIAN_ONLY = [
  /medical(ly)? necessar/i,
  /clinical(ly)? (judgement|judgment|rationale|indicated)/i,
  /failed (conservative|first[- ]line|prior)/i,
  /attest/i,
  /in your opinion/i,
  /why (is|are|was)/i,
  /expected (outcome|benefit)/i,
];

export function needsClinician(text: string): boolean {
  return CLINICIAN_ONLY.some((pattern) => pattern.test(text));
}

function readPath(context: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node && typeof node === "object" && key in (node as Record<string, unknown>)) {
      return (node as Record<string, unknown>)[key];
    }
    return undefined;
  }, context);
}

function coerce(value: unknown, type: AnswerType): string | number | boolean | null {
  if (value === undefined || value === null || value === "") return null;
  switch (type) {
    case "boolean": {
      // Recognise the standard string encodings of true/false from EHR and claims
      // data. `=== "true"` alone turned "yes"/"Y"/"1" into a DEFINITE false — a
      // prior-auth answer asserting the patient is NOT on anticoagulation when the
      // record says they are, inverted toward clinical harm. Anything unrecognised
      // is left UNANSWERED (null) for the clinician, never guessed as false.
      if (typeof value === "boolean") return value;
      const s = String(value).trim().toLowerCase();
      if (["true", "yes", "y", "1", "t"].includes(s)) return true;
      if (["false", "no", "n", "0", "f"].includes(s)) return false;
      return null;
    }
    case "integer":
      return Number.isFinite(Number(value)) ? Math.round(Number(value)) : null;
    case "decimal":
      return Number.isFinite(Number(value)) ? Number(value) : null;
    default:
      return String(value);
  }
}

/**
 * Fill what the record answers and name what it does not.
 *
 * A choice answer that does not match one of the payer's options is left
 * unanswered rather than sent through. A payer questionnaire with an
 * out-of-vocabulary answer is rejected, and a silent coercion to the nearest
 * option would be the tool choosing a clinical answer.
 */
export function prefill(
  questionnaire: Questionnaire,
  context: Record<string, unknown>,
  provenanceLabel = "practice record",
): PrefillResult {
  const answers: Answer[] = [];
  const warnings: string[] = [];

  for (const item of questionnaire.items) {
    if (needsClinician(item.text)) {
      answers.push({
        linkId: item.linkId,
        text: item.text,
        type: item.type,
        value: null,
        origin: "needs_clinician",
        provenance: "Left blank on purpose — this asks for a clinical assertion, and a record cannot make one.",
        required: item.required,
      });
      continue;
    }

    const raw = item.source ? readPath(context, item.source) : undefined;
    const value = coerce(raw, item.type);

    if (value === null) {
      answers.push({
        linkId: item.linkId,
        text: item.text,
        type: item.type,
        value: null,
        origin: "unanswered",
        provenance: item.source ? `Nothing at ${item.source} in the record.` : "No mapping to the record.",
        required: item.required,
      });
      continue;
    }

    if (item.type === "choice" && item.options && !item.options.includes(String(value))) {
      answers.push({
        linkId: item.linkId,
        text: item.text,
        type: item.type,
        value: null,
        origin: "unanswered",
        provenance: `The record holds "${String(value)}", which is not one of the payer's options (${item.options.join(", ")}). Left blank rather than mapped to the nearest one.`,
        required: item.required,
      });
      warnings.push(
        `${item.linkId}: the record's value is outside the payer's answer set. Choosing the nearest option would be this tool making a clinical answer.`,
      );
      continue;
    }

    answers.push({
      linkId: item.linkId,
      text: item.text,
      type: item.type,
      value,
      origin: "prefilled",
      provenance: `${provenanceLabel}: ${item.source}`,
      required: item.required,
    });
  }

  const missingRequired = answers.filter((a) => a.required && a.value === null && a.origin !== "needs_clinician");
  const clinicianRequired = answers.filter((a) => a.origin === "needs_clinician");
  const prefilled = answers.filter((a) => a.origin === "prefilled").length;

  if (prefilled > 0) {
    warnings.push(
      `${prefilled} answer(s) were filled from the record and nobody has read them yet. A prior authorization is a statement to a payer about a patient — an autofilled answer that is wrong is a false statement nobody typed.`,
    );
  }

  return {
    questionnaireId: questionnaire.id,
    answers,
    missingRequired,
    clinicianRequired,
    complete: missingRequired.length === 0 && clinicianRequired.every((a) => !a.required),
    warnings,
  };
}

/** Apply a clinician's answers over a prefill, keeping the origin honest. */
export function applyAnswers(result: PrefillResult, provided: Record<string, string | number | boolean>): PrefillResult {
  const answers = result.answers.map((a) => {
    if (!(a.linkId in provided)) return a;
    // A distinct origin, not "prefilled". The origin field exists to say who made
    // the assertion, and labelling a clinician's own answer as machine-filled
    // destroys exactly the distinction the module is built around.
    return {
      ...a,
      value: provided[a.linkId],
      origin: "clinician_answered" as AnswerOrigin,
      provenance: "Answered by the reviewing clinician.",
    };
  });
  const missingRequired = answers.filter((a) => a.required && a.value === null && a.origin !== "needs_clinician");
  const clinicianRequired = answers.filter((a) => a.origin === "needs_clinician");
  return {
    ...result,
    answers,
    missingRequired,
    clinicianRequired,
    complete: missingRequired.length === 0 && clinicianRequired.every((a) => !a.required),
    warnings: result.warnings,
  };
}

/** The FHIR QuestionnaireResponse, emitted only from a reviewed prefill. */
export function toQuestionnaireResponse(
  questionnaire: Questionnaire,
  result: PrefillResult,
  patientRef: string,
  authoredOn: string,
): Record<string, unknown> | string {
  if (!result.complete) {
    return `Not submittable: ${result.missingRequired.length} required question(s) unanswered and ${result.clinicianRequired.filter((a) => a.required).length} awaiting a clinician. A questionnaire submitted from prefill alone is a set of assertions nobody made.`;
  }
  return {
    resourceType: "QuestionnaireResponse",
    questionnaire: `Questionnaire/${questionnaire.id}`,
    status: "completed",
    subject: { reference: patientRef },
    authored: authoredOn,
    item: result.answers
      .filter((a) => a.value !== null)
      .map((a) => ({
        linkId: a.linkId,
        text: a.text,
        answer: [{ [answerKey(a)]: a.value }],
      })),
  };
}

/**
 * Type the answer from the questionnaire's declared type, not from the runtime
 * value.
 *
 * Inferring it from the value gets two cases wrong in ways a payer rejects: a
 * date becomes valueString, and a decimal that happens to be whole — 2.0 visits
 * per week, a dose of 5.0 — becomes valueInteger. The questionnaire already says
 * what each answer is, so there is nothing to guess at.
 */
function answerKey(answer: Answer): string {
  switch (answer.type) {
    case "boolean":
      return "valueBoolean";
    case "integer":
      return "valueInteger";
    case "decimal":
      return "valueDecimal";
    case "date":
      return "valueDate";
    default:
      return "valueString";
  }
}

export function renderPrefill(result: PrefillResult): string {
  const lines = [`Questionnaire ${result.questionnaireId} — ${result.answers.length} question(s).`, ""];

  for (const a of result.answers) {
    const shown = a.value === null ? "(blank)" : String(a.value);
    lines.push(
      `  ${a.linkId}${a.required ? " *" : ""}  ${a.text}`,
      `      ${shown}   [${a.origin}] ${a.provenance}`,
    );
  }

  if (result.clinicianRequired.length > 0) {
    lines.push(
      "",
      `${result.clinicianRequired.length} question(s) are for the clinician. These ask for a clinical assertion — medical necessity, failure of conservative therapy, an attestation — and no record answers them. Filling them automatically would be inventing the assertion.`,
    );
  }
  if (result.missingRequired.length > 0) {
    lines.push(
      "",
      `${result.missingRequired.length} required question(s) have no answer in the record: ${result.missingRequired.map((a) => a.linkId).join(", ")}.`,
    );
  }

  lines.push(
    "",
    result.complete
      ? "Every required question is answered. It still needs reading before it is sent."
      : "Not submittable yet.",
    ...result.warnings.map((w) => `⚠ ${w}`),
  );
  return lines.join("\n");
}
