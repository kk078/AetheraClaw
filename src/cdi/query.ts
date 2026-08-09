// ── Compliant physician queries ──────────────────────────────────────────────
// A query asks a provider to clarify their own documentation. It is the single
// most scrutinised communication in clinical documentation integrity, because a
// query that suggests its own answer manufactures the diagnosis it was supposed
// to discover — and the resulting code is indefensible even when the condition
// was real.
//
// So this module is a CHECKER before it is a builder. Every query it can emit
// has been run against the rules below, and a query that fails them is refused
// rather than emitted with a warning attached. A warning on a leading query is
// a leading query.
//
// This matters more, not less, for a query a machine wrote. The 2026 draft of
// the practice brief says so directly: technology-generated queries meet the
// same standard as any other. Nothing here gets a discount for being automated.

/**
 * Which version of the practice brief governs.
 *
 * Stated because it moved recently and is still moving. The 2022 Update (plus
 * its denials addendum) is the operative guidance; a 2026 Update went out for
 * public comment, which closed 12 June 2026, with a final expected after. The
 * rules encoded here are the ones stable across both — non-leading, clinical
 * indicators present, an alternate response always available — rather than
 * anything that only appears in the draft.
 */
export const QUERY_BRIEF_STATUS =
  "Checked against the ACDIS/AHIMA Guidelines for Achieving a Compliant Query Practice, 2022 Update, which is the operative version. A 2026 Update is in progress — public comment closed 12 June 2026 — and extends the guidance to ambulatory and professional-fee settings and to technology-generated queries. The rules applied here are the ones common to both.";

/**
 * Open-ended is the safest and least often used. Multiple choice is allowed
 * anywhere given clinical indicators and a real alternative. Yes/no is the
 * narrow one: it may only VERIFY a diagnosis already documented somewhere in
 * the record, never introduce one.
 */
export type QueryFormat = "open_ended" | "multiple_choice" | "yes_no";

export interface QueryOption {
  text: string;
  /** True for "other, please specify", "unable to determine", "not clinically significant". */
  escape: boolean;
}

export interface PhysicianQuery {
  patientRef: string;
  format: QueryFormat;
  /** The non-leading statement of what needs clarifying. */
  question: string;
  /** What in the record prompted this — quoted, never paraphrased. */
  clinicalIndicators: string[];
  options: QueryOption[];
  /** Yes/no only: where the diagnosis is already documented. */
  alreadyDocumentedAt: string;
  author: string;
}

/**
 * The escape options. At least one must be present on any query with options.
 *
 * A menu with no way off it is a menu with one real answer, however many rows
 * it has.
 */
export const ESCAPE_OPTIONS = [
  "Other — please specify",
  "Unable to determine",
  "Not clinically significant",
];

/**
 * Language that makes a query leading regardless of everything else around it.
 *
 * The financial patterns are the ones that end careers: a query mentioning
 * reimbursement, a DRG, a risk score or a quality measure has told the provider
 * what answer pays, and no amount of neutral phrasing elsewhere undoes that.
 */
const LEADING_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /\b(reimburse\w*|revenue|payment|paid more|drg|rw|relative weight|risk score|raf|hcc capture|quality (measure|score)|star rating)\b/i,
    why: "names a financial or scoring consequence. Telling a provider what an answer is worth is the clearest form of leading there is, and it is the one auditors look for first.",
  },
  {
    pattern: /\bplease (document|add|specify that|confirm that|state that)\s+\w+/i,
    why: "instructs the provider to document a particular thing rather than asking what the clinical picture supports.",
  },
  {
    pattern: /\b(would you agree|do you agree|can you confirm that the patient has|isn'?t this|wouldn'?t this be)\b/i,
    why: "invites agreement with a conclusion the query has already drawn.",
  },
  {
    pattern: /\b(if you document|documenting .* would allow|this would (let|allow) us)\b/i,
    why: "describes what documenting an answer would enable, which is the same as naming its value.",
  },
  {
    pattern: /\bthe patient (clearly|obviously|must) ha[sd]\b/i,
    why: "asserts the diagnosis rather than asking about it.",
  },
];

export interface QueryCheck {
  compliant: boolean;
  problems: string[];
  notes: string[];
}

/**
 * Check a query against the rules that survive across brief versions.
 *
 * Returns problems rather than throwing so the caller can show a person exactly
 * what is wrong with a draft. What it will not do is return `compliant: true`
 * with problems attached.
 */
export function checkQueryCompliance(query: PhysicianQuery): QueryCheck {
  const problems: string[] = [];
  const notes: string[] = [];

  if (query.clinicalIndicators.length === 0) {
    problems.push(
      "No clinical indicators. A query without the findings that prompted it asks the provider to document a diagnosis on the strength of being asked, which is the definition of leading.",
    );
  }

  const haystack = [query.question, ...query.options.map((o) => o.text)].join(" ");
  for (const { pattern, why } of LEADING_PATTERNS) {
    const hit = haystack.match(pattern);
    if (hit) problems.push(`"${hit[0]}" ${why}`);
  }

  if (query.format === "multiple_choice") {
    if (query.options.length === 0) {
      problems.push("A multiple-choice query with no options is an open-ended query mislabelled.");
    } else if (!query.options.some((o) => o.escape)) {
      problems.push(
        "No option lets the provider answer outside the list. A menu with no way off it has one real answer however many rows it has — include an 'other, please specify' and an 'unable to determine'.",
      );
    } else if (query.options.filter((o) => !o.escape).length === 1) {
      // Not automatically wrong: the brief allows a single reasonable option
      // where the indicators support only one. But it is the shape a leading
      // query takes, so it gets said out loud.
      notes.push(
        "Only one clinical option is offered. The brief permits that when the indicators genuinely support one answer — but it is also exactly what a leading query looks like, so be sure the record supports no other.",
      );
    }
  }

  if (query.format === "yes_no") {
    if (!query.alreadyDocumentedAt) {
      problems.push(
        "A yes/no query may only verify a diagnosis already documented elsewhere in the record. With nothing to point at, it introduces the diagnosis — say where it already appears, or ask this as multiple choice.",
      );
    }
    if (!query.options.some((o) => /unable to determine/i.test(o.text))) {
      problems.push("Yes/no queries must offer 'unable to determine'. Forcing a binary answer to a clinical question is leading by omission.");
    }
  }

  if (query.format === "open_ended" && query.options.length > 0) {
    problems.push("An open-ended query with options is a multiple-choice query. Label it as one so it is checked as one.");
  }

  if (query.question.trim().length === 0) {
    problems.push("The query has no question.");
  }

  notes.push(QUERY_BRIEF_STATUS);
  return { compliant: problems.length === 0, problems, notes };
}

/**
 * Build a query, or refuse.
 *
 * Escape options are appended for multiple choice rather than being required of
 * the caller, since the failure this prevents is one of omission and a caller
 * who forgot them once will forget them again. A `string` return is a refusal.
 */
export function buildQuery(input: {
  patientRef: string;
  format: QueryFormat;
  question: string;
  clinicalIndicators: string[];
  options?: string[];
  alreadyDocumentedAt?: string;
  author: string;
}): PhysicianQuery | string {
  const options: QueryOption[] =
    input.format === "multiple_choice"
      ? [
          ...(input.options ?? []).map((text) => ({ text, escape: false })),
          ...ESCAPE_OPTIONS.map((text) => ({ text, escape: true })),
        ]
      : input.format === "yes_no"
        ? [
            { text: "Yes", escape: false },
            { text: "No", escape: false },
            { text: "Unable to determine", escape: true },
          ]
        : [];

  const query: PhysicianQuery = {
    patientRef: input.patientRef,
    format: input.format,
    question: input.question.trim(),
    clinicalIndicators: input.clinicalIndicators,
    options,
    alreadyDocumentedAt: input.alreadyDocumentedAt ?? "",
    author: input.author,
  };

  const check = checkQueryCompliance(query);
  if (!check.compliant) {
    return `Not sent. This query is not compliant:\n${check.problems.map((p) => `  - ${p}`).join("\n")}`;
  }
  return query;
}

export interface QueryResponse {
  response: string;
  respondedBy: string;
  respondedAt: number;
  /** Why this replaced an earlier answer. Empty on a first response. */
  amendReason: string;
}

/**
 * Whether a response may be written over one already recorded.
 *
 * Replacing an answered query with a different answer is what "re-query until
 * the provider says the right thing" looks like once it reaches the database —
 * the first answer disappears and the record shows a single clean response. So
 * an overwrite needs a stated reason and the earlier answer is kept beside it,
 * exactly as the coding review queue treats a decided suggestion.
 *
 * Returns a refusal, or empty when the write is allowed.
 */
export function checkResponseOverwrite(existing: QueryResponse | null, amendReason: string): string {
  if (!existing || !existing.response) return "";
  if (!amendReason.trim()) {
    return `This query was already answered "${existing.response}" by ${existing.respondedBy}. Recording a different answer over it would leave a record showing only the second one — which is what re-querying until the provider agrees looks like from the outside. Supply an amend reason; the first answer is kept either way.`;
  }
  return "";
}

export function renderQuery(query: PhysicianQuery): string {
  const lines = [
    `Query for ${query.patientRef} — ${query.format.replace("_", " ")}, from ${query.author}.`,
    "",
    "Documented in the record:",
    ...query.clinicalIndicators.map((i) => `  "${i}"`),
    "",
    query.question,
  ];
  if (query.alreadyDocumentedAt) {
    lines.push("", `This diagnosis already appears at: ${query.alreadyDocumentedAt}. This query verifies it rather than introducing it.`);
  }
  if (query.options.length > 0) {
    lines.push("", ...query.options.map((o) => `  [ ] ${o.text}`));
  }
  lines.push(
    "",
    "Answer as the record supports, including not at all. This query carries no preferred answer and none of the options is worth more than another.",
  );
  return lines.join("\n");
}
