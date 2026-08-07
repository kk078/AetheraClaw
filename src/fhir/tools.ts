import { z } from "zod";
import { defineTool } from "../tools/registry.js";
import { newId } from "../shared/ids.js";
import type { MemoryStore } from "../memory/store.js";
import { appendAudit } from "../audit/store.js";
import { loadEras } from "../tools/healthcare/analytics.js";
import {
  PA_DENIAL_CARCS,
  checkRequirement,
  renderCrd,
  ruleFromDenial,
  type PaRequirement,
  type PaRule,
} from "./crd.js";
import {
  applyAnswers,
  prefill,
  renderPrefill,
  toQuestionnaireResponse,
  type PrefillResult,
  type Questionnaire,
  type QuestionnaireItem,
} from "./dtr.js";
import {
  buildPasBundle,
  readPasResponse,
  renderPasResponse,
  validatePas,
  type PasRequest,
} from "./pas.js";
import { daysUntilApiMandate, decisionDeadline, renderDeadline, renderSettled, type Urgency } from "./pa-clock.js";

type Ctx = { services: Record<string, unknown> };
const store = (ctx: Ctx) => ctx.services.store as MemoryStore;

// DB I/O and formatting only. Every rule lives in crd.ts / dtr.ts / pas.ts /
// pa-clock.ts as an exported pure function.

interface RuleRow {
  payer: string;
  code: string;
  requirement: string;
  condition: string;
  source: string;
  updated_at: number;
}

function loadRules(ctx: Ctx): PaRule[] {
  return (store(ctx).db.prepare("SELECT * FROM pa_rules").all() as RuleRow[]).map((r) => ({
    payer: r.payer,
    code: r.code,
    requirement: r.requirement as PaRequirement,
    condition: r.condition,
    source: r.source,
    updatedAt: r.updated_at,
  }));
}

function saveRule(ctx: Ctx, rule: PaRule): void {
  store(ctx)
    .db.prepare(
      `INSERT INTO pa_rules (id, payer, code, requirement, condition, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(payer, code) DO UPDATE SET
         requirement = excluded.requirement, condition = excluded.condition,
         source = excluded.source, updated_at = excluded.updated_at`,
    )
    .run(newId("parule"), rule.payer, rule.code, rule.requirement, rule.condition, rule.source, rule.updatedAt);
}

export const paRequirementCheckTool = defineTool({
  name: "pa_requirement_check",
  description:
    "Coverage requirements discovery: does this code need prior authorization from this payer? Answers from the practice's own rule table. 'Unknown' is a real answer and is kept separate from 'not required' — never having seen a denial for a code is not evidence the code is exempt, and collapsing the two is how a service gets rendered without an authorization it needed.",
  schema: z.object({
    payer: z.string(),
    code: z.string(),
    place_of_service: z.string().default(""),
    urgent: z.boolean().default(false),
  }),
  execute: async (input, ctx) => {
    const verdict = checkRequirement(
      { payer: input.payer, code: input.code, placeOfService: input.place_of_service, urgent: input.urgent },
      loadRules(ctx),
    );
    return { content: renderCrd(verdict) };
  },
});

export const paRuleSetTool = defineTool({
  name: "pa_rule_set",
  description:
    "Record what a payer requires prior authorization for. Use requirement='conditional' with a condition when it turns on the circumstance rather than the code.",
  schema: z.object({
    payer: z.string(),
    code: z.string(),
    requirement: z.enum(["required", "not_required", "conditional", "unknown"]),
    condition: z.string().default(""),
    source: z.string().default("entered by hand"),
  }),
  execute: async (input, ctx) => {
    const rule: PaRule = {
      payer: input.payer,
      code: input.code.replace(/[.\s]/g, "").toUpperCase(),
      requirement: input.requirement,
      condition: input.condition,
      source: input.source,
      updatedAt: Date.now(),
    };
    saveRule(ctx, rule);
    return { content: `${rule.code} with ${rule.payer}: ${rule.requirement}${rule.condition ? ` — ${rule.condition}` : ""}.` };
  },
});

export const paRulesLearnTool = defineTool({
  name: "pa_rules_learn",
  description:
    `Build the prior-authorization list from the practice's own denials. CARC ${PA_DENIAL_CARCS.join("/")} is the payer stating on the record that a service needed an authorization it did not have — the most reliable source of a PA list a practice can get, at the cost of one denied claim per entry learned.`,
  schema: z.object({ save: z.boolean().default(true) }),
  execute: async (input, ctx) => {
    const now = Date.now();
    const existing = new Set(loadRules(ctx).map((r) => `${r.payer.toLowerCase()}|${r.code}`));
    const learned = new Map<string, PaRule>();

    for (const { payer, era } of loadEras(store(ctx))) {
      const name = payer || era.payer;
      for (const claim of era.claims) {
        for (const line of claim.lines) {
          for (const adj of line.adjustments) {
            const rule = ruleFromDenial(name, line.procedure, adj.carc, now);
            if (rule) learned.set(`${rule.payer.toLowerCase()}|${rule.code}`, rule);
          }
        }
      }
    }

    const fresh = [...learned.values()].filter((r) => !existing.has(`${r.payer.toLowerCase()}|${r.code}`));
    if (input.save) for (const rule of fresh) saveRule(ctx, rule);

    if (learned.size === 0) {
      return {
        content:
          "No authorization-related denials found in stored remittances. That means nothing was learned, not that nothing requires authorization — a practice that has never been denied for it has never tested it.",
      };
    }
    const lines = [
      `${learned.size} code/payer pair(s) were denied for a missing authorization; ${fresh.length} of them were new${input.save ? " and have been recorded" : " (not saved — save was false)"}.`,
      "",
      ...[...learned.values()].map((r) => `  ${r.code} — ${r.payer} (${r.source})`),
    ];
    return { content: lines.join("\n") };
  },
});

export const dtrQuestionnaireAddTool = defineTool({
  name: "dtr_questionnaire_add",
  description:
    "Store a payer's DTR questionnaire so it can be prefilled. Each item names where its answer lives in the practice record via a dotted 'source' path; items with no source are asked of a person.",
  schema: z.object({
    payer: z.string(),
    title: z.string(),
    items: z.array(
      z.object({
        link_id: z.string(),
        text: z.string(),
        type: z.enum(["boolean", "string", "integer", "decimal", "date", "choice"]),
        required: z.boolean().default(false),
        source: z.string().default(""),
        options: z.array(z.string()).default([]),
      }),
    ),
  }),
  execute: async (input, ctx) => {
    const id = newId("q");
    const items: QuestionnaireItem[] = input.items.map((i) => ({
      linkId: i.link_id,
      text: i.text,
      type: i.type,
      required: i.required,
      ...(i.source ? { source: i.source } : {}),
      ...(i.options.length > 0 ? { options: i.options } : {}),
    }));
    store(ctx)
      .db.prepare("INSERT INTO pa_questionnaires (id, payer, title, items_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.payer, input.title, JSON.stringify(items), Date.now());
    return { content: `Stored questionnaire ${id} — "${input.title}" for ${input.payer}, ${items.length} item(s).` };
  },
});

function loadQuestionnaire(ctx: Ctx, id: string): Questionnaire | null {
  const row = store(ctx).db.prepare("SELECT * FROM pa_questionnaires WHERE id = ?").get(id) as
    | { id: string; payer: string; title: string; items_json: string }
    | undefined;
  if (!row) return null;
  return { id: row.id, payer: row.payer, title: row.title, items: JSON.parse(row.items_json) as QuestionnaireItem[] };
}

function loadPrefill(ctx: Ctx, id: string): { questionnaireId: string; patientRef: string; result: PrefillResult } | null {
  const row = store(ctx).db.prepare("SELECT * FROM pa_prefills WHERE id = ?").get(id) as
    | { questionnaire_id: string; patient_ref: string; result_json: string }
    | undefined;
  if (!row) return null;
  return {
    questionnaireId: row.questionnaire_id,
    patientRef: row.patient_ref,
    result: JSON.parse(row.result_json) as PrefillResult,
  };
}

export const dtrPrefillTool = defineTool({
  name: "dtr_prefill",
  description:
    "Fill a payer questionnaire from de-identified practice data and name what could not be filled. Questions asking for a clinical assertion — medical necessity, failure of conservative therapy, anything phrased as an attestation — are left blank on purpose: filling them from structured data would be inventing the assertion. Every filled answer carries where it came from, and nothing is submitted from here.",
  schema: z.object({
    questionnaire_id: z.string(),
    patient_ref: z.string().describe("De-identified reference only — never a name or an MBI."),
    context: z.record(z.unknown()).default({}).describe("The practice record the source paths read from."),
  }),
  execute: async (input, ctx) => {
    const questionnaire = loadQuestionnaire(ctx, input.questionnaire_id);
    if (!questionnaire) return { content: `No questionnaire ${input.questionnaire_id}.`, isError: true };

    const result = prefill(questionnaire, input.context);
    const id = newId("pf");
    const now = Date.now();
    store(ctx)
      .db.prepare(
        "INSERT INTO pa_prefills (id, questionnaire_id, patient_ref, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, questionnaire.id, input.patient_ref, JSON.stringify(result), now, now);

    return { content: [`Prefill ${id} — ${questionnaire.title} (${questionnaire.payer}).`, "", renderPrefill(result)].join("\n") };
  },
});

export const dtrAnswerTool = defineTool({
  name: "dtr_answer",
  description:
    "Apply a clinician's answers to a prefill and emit the FHIR QuestionnaireResponse once nothing required is outstanding. Answers supplied here are recorded as answered by the reviewing clinician rather than prefilled, because who made an assertion is the thing the provenance is for.",
  schema: z.object({
    prefill_id: z.string(),
    answers: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
    emit: z.boolean().default(false).describe("Emit the QuestionnaireResponse when complete."),
  }),
  execute: async (input, ctx) => {
    const stored = loadPrefill(ctx, input.prefill_id);
    if (!stored) return { content: `No prefill ${input.prefill_id}.`, isError: true };
    const questionnaire = loadQuestionnaire(ctx, stored.questionnaireId);
    if (!questionnaire) return { content: `Prefill ${input.prefill_id} points at a questionnaire that is gone.`, isError: true };

    const updated = applyAnswers(stored.result, input.answers);
    store(ctx)
      .db.prepare("UPDATE pa_prefills SET result_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(updated), Date.now(), input.prefill_id);

    const parts = [renderPrefill(updated)];
    if (input.emit) {
      const response = toQuestionnaireResponse(questionnaire, updated, stored.patientRef, new Date().toISOString());
      parts.push("", typeof response === "string" ? response : JSON.stringify(response, null, 2));
    }
    return { content: parts.join("\n") };
  },
});

const PasServiceSchema = z.object({
  code: z.string(),
  code_system: z.string().default("http://www.ama-assn.org/go/cpt"),
  quantity: z.number().int().min(1).default(1),
  start_date: z.string(),
  end_date: z.string().default(""),
  diagnosis_refs: z.array(z.number().int()).default([]),
});

export const paSubmitTool = defineTool({
  name: "pa_submit",
  description:
    "Build the Da Vinci PAS bundle for a prior authorization and start the decision clock. `use: 'preauthorization'` is what makes this an authorization request rather than a bill — the same Claim resource carries both. The clock runs from the payer's RECEIPT, so pass received_at when it is known rather than letting transport time come out of the practice's side.",
  schema: z.object({
    payer: z.string(),
    patient_ref: z.string().describe("De-identified reference only."),
    requesting_npi: z.string(),
    performing_npi: z.string(),
    diagnoses: z.array(z.string()),
    services: z.array(PasServiceSchema),
    urgent: z.boolean().default(false),
    questionnaire_responses: z.array(z.string()).default([]),
    received_at: z.number().int().default(0).describe("Epoch ms the payer received it. Defaults to now."),
  }),
  execute: async (input, ctx) => {
    const request: PasRequest = {
      patientRef: input.patient_ref,
      payer: input.payer,
      requestingProviderNpi: input.requesting_npi,
      performingProviderNpi: input.performing_npi,
      diagnoses: input.diagnoses,
      services: input.services.map((s) => ({
        code: s.code,
        codeSystem: s.code_system,
        quantity: s.quantity,
        startDate: s.start_date,
        endDate: s.end_date,
        diagnosisRefs: s.diagnosis_refs,
      })),
      urgent: input.urgent,
      questionnaireResponses: input.questionnaire_responses,
    };

    const validation = validatePas(request);
    if (!validation.ok) {
      return { content: ["Not submittable:", ...validation.problems.map((p) => `  ${p}`)].join("\n"), isError: true };
    }

    const id = newId("pa");
    const bundle = buildPasBundle(request, id);
    const now = Date.now();
    const receivedAt = input.received_at > 0 ? input.received_at : now;

    store(ctx)
      .db.prepare(
        `INSERT INTO pa_requests (id, payer, patient_ref, urgency, codes, request_json, bundle_json,
           submitted_at, received_at, outcome, auth_number, response_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', '{}', ?, ?)`,
      )
      .run(
        id,
        input.payer,
        input.patient_ref,
        input.urgent ? "expedited" : "standard",
        request.services.map((s) => s.code).join(","),
        JSON.stringify(request),
        JSON.stringify(bundle),
        now,
        receivedAt,
        now,
        now,
      );

    appendAudit(store(ctx), {
      kind: "pa_submit",
      actor: "pa_submit",
      summary: `Prior authorization ${id} to ${input.payer} for ${request.services.map((s) => s.code).join(", ")}`,
      payload: { id, payer: input.payer, urgent: input.urgent },
    });

    const deadline = decisionDeadline(receivedAt, input.urgent ? "expedited" : "standard", now);
    return {
      content: [
        `Prior authorization ${id} built for ${input.payer}.`,
        renderDeadline(deadline),
        ...validation.warnings.map((w) => `⚠ ${w}`),
        "",
        typeof bundle === "string" ? bundle : JSON.stringify(bundle, null, 2),
      ].join("\n"),
    };
  },
});

interface RequestRow {
  id: string;
  payer: string;
  patient_ref: string;
  urgency: string;
  codes: string;
  request_json: string;
  received_at: number;
  outcome: string;
  auth_number: string;
  updated_at: number;
}

export const paStatusTool = defineTool({
  name: "pa_status",
  description:
    "Show outstanding prior authorizations against the CMS-0057-F decision clock: 72 HOURS on expedited, seven CALENDAR days on standard, both running from receipt and both in force since 1 January 2026. Reading expedited as three days hands the payer most of an extra day on exactly the requests where someone is waiting for care.",
  schema: z.object({ include_decided: z.boolean().default(false) }),
  execute: async (input, ctx) => {
    const rows = store(ctx)
      .db.prepare(
        `SELECT * FROM pa_requests ${input.include_decided ? "" : "WHERE outcome = 'pending'"} ORDER BY received_at ASC`,
      )
      .all() as RequestRow[];

    if (rows.length === 0) return { content: "No prior authorizations tracked." };

    const now = Date.now();
    const lines: string[] = [];
    let overdue = 0;
    for (const row of rows) {
      // A decided request is measured against WHEN IT WAS DECIDED, not against
      // now. Measuring it against now leaves settled rows drifting further
      // overdue every day they sit here, which is how a work queue stops
      // meaning anything.
      const decided = row.outcome !== "pending";
      const deadline = decisionDeadline(row.received_at, row.urgency as Urgency, decided ? row.updated_at : now);
      if (deadline.late && !decided) overdue++;
      lines.push(
        `${row.id} — ${row.payer}, ${row.codes || "no codes"}, patient ${row.patient_ref} [${row.outcome}${row.auth_number ? ` #${row.auth_number}` : ""}]`,
        `  ${decided ? renderSettled(deadline) : renderDeadline(deadline).split("\n")[0]}`,
      );
    }

    const days = daysUntilApiMandate(now);
    lines.push(
      "",
      overdue > 0
        ? `${overdue} request(s) are past the payer's decision deadline. Each is worth a call with the request reference — the reference is what makes the call provable later.`
        : "Nothing is past its decision deadline.",
      days > 0
        ? `The FHIR Prior Authorization API is required in ${days} day(s). The decision timeframes above are already in force and do not wait for it.`
        : "The FHIR Prior Authorization API compliance date has passed.",
    );
    return { content: lines.join("\n") };
  },
});

export const paResponseRecordTool = defineTool({
  name: "pa_response_record",
  description:
    "Record the payer's ClaimResponse against a tracked request. Reads per-service dispositions individually because partial approval is the case that gets missed — the outcome says approved and carries an authorization number while one requested service was quietly refused.",
  schema: z.object({
    request_id: z.string(),
    response: z.record(z.unknown()).describe("The FHIR ClaimResponse as returned by the payer."),
  }),
  execute: async (input, ctx) => {
    const row = store(ctx).db.prepare("SELECT * FROM pa_requests WHERE id = ?").get(input.request_id) as
      | RequestRow
      | undefined;
    if (!row) return { content: `No prior authorization ${input.request_id}.`, isError: true };

    const request = JSON.parse(row.request_json) as PasRequest;
    const response = readPasResponse(input.response, request.services.map((s) => s.code));

    store(ctx)
      .db.prepare("UPDATE pa_requests SET outcome = ?, auth_number = ?, response_json = ?, updated_at = ? WHERE id = ?")
      .run(response.outcome, response.authorizationNumber, JSON.stringify(response), Date.now(), row.id);

    appendAudit(store(ctx), {
      kind: "pa_response",
      actor: "pa_response_record",
      summary: `Prior authorization ${row.id} came back ${response.outcome}`,
      payload: { id: row.id, outcome: response.outcome },
    });

    const deadline = decisionDeadline(row.received_at, row.urgency as Urgency, Date.now());
    return {
      content: [
        renderPasResponse(response),
        "",
        deadline.late
          ? `The decision arrived ${deadline.hoursLate.toFixed(1)} hour(s) after it was due.`
          : "The decision arrived within the required timeframe.",
      ].join("\n"),
    };
  },
});
