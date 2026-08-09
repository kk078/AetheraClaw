import { z } from "zod";
import { defineTool } from "../tools/registry.js";
import { newId } from "../shared/ids.js";
import type { MemoryStore } from "../memory/store.js";
import { appendAudit } from "../audit/store.js";
import {
  ESCAPE_OPTIONS,
  QUERY_BRIEF_STATUS,
  buildQuery,
  checkQueryCompliance,
  checkResponseOverwrite,
  renderQuery,
  type PhysicianQuery,
  type QueryFormat,
  type QueryResponse,
} from "./query.js";
import {
  analyzeNote,
  queryFor,
  renderFindings,
  summarize,
  type CdiFinding,
  type Dimension,
  type SpecificityRule,
} from "./realtime.js";
import { greenlight, renderGreenlight, type CoverageStatus, type GreenlightInput, type Network } from "./greenlight.js";
import type { PaRequirement } from "../fhir/crd.js";

type Ctx = { services: Record<string, unknown> };
const store = (ctx: Ctx) => ctx.services.store as MemoryStore;

// DB I/O and formatting only. Every rule lives in query.ts / realtime.ts /
// greenlight.ts as an exported pure function.

interface RuleRow {
  id: string;
  triggers: string;
  dimension: string;
  needs: string;
  unspecified_code: string;
  affects_risk: number;
  options_json: string;
}

function loadRules(ctx: Ctx): SpecificityRule[] {
  return (store(ctx).db.prepare("SELECT * FROM cdi_rules").all() as RuleRow[]).map((r) => ({
    id: r.id,
    triggers: JSON.parse(r.triggers) as string[],
    dimension: r.dimension as Dimension,
    needs: r.needs,
    unspecifiedCode: r.unspecified_code,
    affectsRiskAdjustment: r.affects_risk === 1,
    ...(r.options_json !== "[]" ? { options: JSON.parse(r.options_json) as string[] } : {}),
  }));
}

export const cdiRuleAddTool = defineTool({
  name: "cdi_rule_add",
  description:
    "Record a specificity rule: a phrase that marks documentation less specific than the patient, and which axis it is missing. Rules are data so a practice can read and edit every one — a rule nobody can inspect is one nobody can defend when asked why a query went out.",
  schema: z.object({
    id: z.string().default(""),
    triggers: z.array(z.string()).min(1),
    dimension: z.enum(["laterality", "severity", "acuity", "type", "linkage", "stage", "episode"]),
    needs: z.string().describe("What a coder would need to see, in plain words."),
    unspecified_code: z.string().default("").describe("Where the vague form usually codes to."),
    affects_risk_adjustment: z.boolean().default(false),
    options: z.array(z.string()).default([]).describe("Overrides the axis vocabulary when it is narrower here."),
  }),
  execute: async (input, ctx) => {
    const id = input.id || newId("cdir");
    store(ctx)
      .db.prepare(
        `INSERT INTO cdi_rules (id, triggers, dimension, needs, unspecified_code, affects_risk, options_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET triggers = excluded.triggers, dimension = excluded.dimension,
           needs = excluded.needs, unspecified_code = excluded.unspecified_code,
           affects_risk = excluded.affects_risk, options_json = excluded.options_json`,
      )
      .run(
        id,
        JSON.stringify(input.triggers),
        input.dimension,
        input.needs,
        input.unspecified_code,
        input.affects_risk_adjustment ? 1 : 0,
        JSON.stringify(input.options),
        Date.now(),
      );
    return { content: `Rule ${id}: ${input.triggers.join(" / ")} → ${input.dimension} (${input.needs}).` };
  },
});

export const cdiAnalyzeTool = defineTool({
  name: "cdi_analyze",
  description:
    "Read de-identified documentation and find where the record is less specific than the patient. Every finding carries the sentence it came from, verbatim and with its offset. It never proposes the more specific code — offering the answer and collecting a click is a leading query wearing a code suggestion's clothes, and unspecified is frequently the correct code anyway.",
  schema: z.object({
    patient_ref: z.string().describe("De-identified reference only — never a name or an MBI."),
    service_date: z.string().describe("YYYYMMDD"),
    text: z.string(),
    source: z.string().default("note"),
  }),
  execute: async (input, ctx) => {
    const rules = loadRules(ctx);
    if (rules.length === 0) {
      return {
        content: "No specificity rules recorded. Add some with cdi_rule_add — with an empty rule set this reports nothing and that would look like a clean note.",
        isError: true,
      };
    }
    const findings = analyzeNote(
      { patientRef: input.patient_ref, serviceDate: input.service_date, text: input.text, source: input.source },
      rules,
    );
    return { content: renderFindings(summarize(findings)) };
  },
});

function saveQuery(ctx: Ctx, query: PhysicianQuery, finding: CdiFinding | null): string {
  const id = newId("q");
  const now = Date.now();
  store(ctx)
    .db.prepare(
      `INSERT INTO cdi_queries (id, patient_ref, format, query_json, check_json, finding_json, status, response, responded_by, history_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', '', '', '[]', ?, ?)`,
    )
    .run(
      id,
      query.patientRef,
      query.format,
      JSON.stringify(query),
      JSON.stringify(checkQueryCompliance(query)),
      JSON.stringify(finding ?? {}),
      now,
      now,
    );
  appendAudit(store(ctx), {
    kind: "cdi_query",
    actor: query.author,
    summary: `Compliant ${query.format} query drafted for ${query.patientRef}`,
    payload: { id, format: query.format },
  });
  return id;
}

export const cdiQueryDraftTool = defineTool({
  name: "cdi_query_draft",
  description:
    `Draft a physician query, or refuse to. Checked against the rules that make a query leading — naming a financial or scoring consequence, instructing the provider what to document, inviting agreement with a conclusion, offering a menu with no way off it. A non-compliant query is refused rather than emitted with a warning, because a warning on a leading query is a leading query. Escape options (${ESCAPE_OPTIONS.join("; ")}) are added automatically. This standard applies in full to a query a machine wrote.`,
  schema: z.object({
    patient_ref: z.string(),
    format: z.enum(["open_ended", "multiple_choice", "yes_no"]),
    question: z.string(),
    clinical_indicators: z.array(z.string()).describe("The findings that prompted this, quoted from the record."),
    options: z.array(z.string()).default([]),
    already_documented_at: z.string().default("").describe("Yes/no only: where the diagnosis already appears."),
    author: z.string().default("CDI"),
  }),
  execute: async (input, ctx) => {
    const built = buildQuery({
      patientRef: input.patient_ref,
      format: input.format as QueryFormat,
      question: input.question,
      clinicalIndicators: input.clinical_indicators,
      options: input.options,
      alreadyDocumentedAt: input.already_documented_at,
      author: input.author,
    });
    if (typeof built === "string") return { content: `${built}\n\n${QUERY_BRIEF_STATUS}`, isError: true };

    const id = saveQuery(ctx, built, null);
    return { content: [`Query ${id} — compliant, saved as a draft.`, "", renderQuery(built)].join("\n") };
  },
});

export const cdiQueryFromFindingTool = defineTool({
  name: "cdi_query_from_finding",
  description:
    "Generate a query from a specificity gap. The options come from the AXIS, never from a guess at the answer — 'left / right / bilateral / unable to determine' is exhaustive and carries no preference, which is what makes a generated query non-leading by construction. A query built around the answer the tool thinks is right cannot get that property back by rewording.",
  schema: z.object({
    patient_ref: z.string(),
    service_date: z.string().describe("YYYYMMDD"),
    text: z.string(),
    source: z.string().default("note"),
    rule_id: z.string().default("").describe("Limit to one rule. Otherwise the highest-ranked finding is used."),
    author: z.string().default("CDI"),
  }),
  execute: async (input, ctx) => {
    const rules = loadRules(ctx);
    const findings = analyzeNote(
      { patientRef: input.patient_ref, serviceDate: input.service_date, text: input.text, source: input.source },
      input.rule_id ? rules.filter((r) => r.id === input.rule_id) : rules,
    );
    const ranked = summarize(findings).findings;
    if (ranked.length === 0) return { content: "No specificity gap matched, so there is nothing to ask about.", isError: true };

    const finding = ranked[0];
    const rule = rules.find((r) => r.id === finding.ruleId);
    const built = queryFor(finding, input.author, rule);
    if (typeof built === "string") return { content: built, isError: true };

    const id = saveQuery(ctx, built, finding);
    return {
      content: [
        `Query ${id} from finding on ${finding.ruleId} (${finding.dimension}), ${finding.source} offset ${finding.offset}.`,
        "",
        renderQuery(built),
      ].join("\n"),
    };
  },
});

export const cdiQueryListTool = defineTool({
  name: "cdi_query_list",
  description: "List drafted and answered queries. Queries are kept whether or not they were answered — whether one was leading is a question asked years later, by someone who was not there.",
  schema: z.object({ query_id: z.string().default(""), status: z.enum(["all", "draft", "sent", "answered"]).default("all") }),
  execute: async (input, ctx) => {
    if (input.query_id) {
      const row = store(ctx).db.prepare("SELECT * FROM cdi_queries WHERE id = ?").get(input.query_id) as
        | { query_json: string; status: string; response: string; responded_by: string }
        | undefined;
      if (!row) return { content: `No query ${input.query_id}.`, isError: true };
      const query = JSON.parse(row.query_json) as PhysicianQuery;
      return {
        content: [
          renderQuery(query),
          "",
          `Status: ${row.status}${row.response ? ` — answered "${row.response}" by ${row.responded_by}` : ""}`,
        ].join("\n"),
      };
    }
    const rows = store(ctx)
      .db.prepare(
        `SELECT id, patient_ref, format, status, response FROM cdi_queries ${input.status === "all" ? "" : "WHERE status = ?"} ORDER BY created_at DESC`,
      )
      .all(...(input.status === "all" ? [] : [input.status])) as Array<{
      id: string;
      patient_ref: string;
      format: string;
      status: string;
      response: string;
    }>;
    if (rows.length === 0) return { content: "No queries." };
    return {
      content: rows.map((r) => `${r.id} — ${r.patient_ref}, ${r.format} [${r.status}]${r.response ? ` → ${r.response}` : ""}`).join("\n"),
    };
  },
});

export const cdiQueryRespondTool = defineTool({
  name: "cdi_query_respond",
  description:
    "Record a provider's answer to a query. A compliant query response in the permanent record supports code assignment on its own — which is exactly why the query that produced it has to have been compliant, and why both are kept together.",
  schema: z.object({
    query_id: z.string(),
    response: z.string(),
    responded_by: z.string(),
    amend_reason: z
      .string()
      .default("")
      .describe("Required to record an answer over one already given. The earlier answer is kept either way."),
  }),
  execute: async (input, ctx) => {
    const row = store(ctx)
      .db.prepare("SELECT query_json, response, responded_by, history_json FROM cdi_queries WHERE id = ?")
      .get(input.query_id) as
      | { query_json: string; response: string; responded_by: string; history_json: string }
      | undefined;
    if (!row) return { content: `No query ${input.query_id}.`, isError: true };

    const existing: QueryResponse | null = row.response
      ? { response: row.response, respondedBy: row.responded_by, respondedAt: 0, amendReason: "" }
      : null;
    const refusal = checkResponseOverwrite(existing, input.amend_reason);
    if (refusal) return { content: `Not recorded. ${refusal}`, isError: true };

    const history = JSON.parse(row.history_json) as QueryResponse[];
    if (existing) history.push(existing);

    store(ctx)
      .db.prepare(
        "UPDATE cdi_queries SET status = 'answered', response = ?, responded_by = ?, history_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(input.response, input.responded_by, JSON.stringify(history), Date.now(), input.query_id);
    appendAudit(store(ctx), {
      kind: "cdi_query_response",
      actor: input.responded_by,
      summary: `Query ${input.query_id} answered`,
      payload: { id: input.query_id },
    });

    const query = JSON.parse(row.query_json) as PhysicianQuery;
    const escaped = query.options.find((o) => o.escape && o.text.toLowerCase() === input.response.trim().toLowerCase());
    return {
      content: [
        `Recorded: ${input.responded_by} answered "${input.response}".`,
        history.length > 0
          ? `This replaces "${history[history.length - 1].response}" — amended because: ${input.amend_reason}. The earlier answer is kept.`
          : "",
        escaped
          ? "That is one of the escape options, which means the query did its job — the provider was able to decline the menu. Do not re-query the same question hoping for a different answer."
          : "Any code from this belongs in the review queue like any other suggestion, with this query as its provenance.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});

export const greenlightCheckTool = defineTool({
  name: "greenlight_check",
  description:
    "Pre-service go/no-go: eligibility, prior authorization, coverage and cost in one answer. Fails closed — an unknown on any axis that can stop a claim is a STOP, not a middling score. There is no percentage, because a blocker cannot be outweighed: three clean checks and a terminated policy is not 75% clear, it is a self-pay visit nobody warned the patient about.",
  schema: z.object({
    patient_ref: z.string(),
    service_date: z.string().describe("YYYYMMDD"),
    code: z.string(),
    payer: z.string(),
    network: z.enum(["in", "out", "unknown"]).default("unknown"),
    eligibility_checked: z.boolean().default(false),
    eligibility_active: z.boolean().default(false),
    eligibility_checked_at: z.number().int().default(0).describe("Epoch ms. Zero means never."),
    plan_name: z.string().default(""),
    copay_cents: z.number().int().min(0).default(0),
    deductible_remaining_cents: z.number().int().min(0).default(0),
    pa_requirement: z.enum(["required", "not_required", "conditional", "unknown"]).default("unknown"),
    auth_number: z.string().default(""),
    auth_expires_on: z.string().default("").describe("YYYYMMDD"),
    coverage_status: z.enum(["covered", "not_covered", "conditional", "unknown"]).default("unknown"),
    coverage_policy: z.string().default(""),
    coverage_checked_at: z.number().int().default(0),
    allowed_cents: z.number().int().min(0).default(0),
    estimate_source: z.string().default(""),
  }),
  execute: async (input, ctx) => {
    const composed: GreenlightInput = {
      patientRef: input.patient_ref,
      serviceDate: input.service_date,
      code: input.code,
      payer: input.payer,
      network: input.network as Network,
      eligibility: {
        checked: input.eligibility_checked,
        active: input.eligibility_active,
        checkedAt: input.eligibility_checked_at,
        planName: input.plan_name,
        copayCents: input.copay_cents,
        deductibleRemainingCents: input.deductible_remaining_cents,
      },
      priorAuth: {
        requirement: input.pa_requirement as PaRequirement,
        authNumber: input.auth_number,
        expiresOn: input.auth_expires_on,
        checkedAt: 0,
      },
      coverage: {
        status: input.coverage_status as CoverageStatus,
        policy: input.coverage_policy,
        checkedAt: input.coverage_checked_at,
      },
      estimate: { allowedCents: input.allowed_cents, source: input.estimate_source },
    };

    const result = greenlight(composed);
    appendAudit(store(ctx), {
      kind: "greenlight",
      actor: "greenlight_check",
      summary: `${result.verdict.toUpperCase()} for ${input.code} / ${input.payer} on ${input.service_date}`,
      payload: { code: input.code, verdict: result.verdict, blockers: result.blockers.length },
    });

    return { content: renderGreenlight(composed, result), isError: result.verdict === "stop" };
  },
});
