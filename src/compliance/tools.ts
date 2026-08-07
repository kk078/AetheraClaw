import { z } from "zod";
import { readFileSync } from "node:fs";
import { defineTool } from "../tools/registry.js";
import { newId } from "../shared/ids.js";
import { confinePath } from "../tools/path-guard.js";
import type { Config } from "../config/config.js";
import type { MemoryStore } from "../memory/store.js";
import { ClaimSchema, type ClaimInput } from "../tools/healthcare/x12/837.js";
import { compilePolicy, renderCompileResult, type DraftRule } from "./reg-compiler.js";
import { evaluateRules, payerKey, renderRule, type PolicyRule } from "./rule-dsl.js";
import { loadActiveRules, toRule, type RuleRow } from "./rule-store.js";
import {
  MIN_SAMPLE_FOR_EXTRAPOLATION,
  auditSample,
  drawSample,
  renderReport,
  seedFrom,
  type SampledClaim,
} from "./sentinel.js";
import { appendAudit } from "../audit/store.js";

type Ctx = { services: Record<string, unknown> };

function db(ctx: Ctx) {
  return (ctx.services.store as MemoryStore).db;
}


function insertRule(ctx: Ctx, rule: PolicyRule): void {
  const now = Date.now();
  db(ctx)
    .prepare(
      `INSERT INTO policy_rules (id, kind, codes_json, diagnoses_json, modifiers_json, pos_json, max_units, period,
         severity, message, payer, status, source_document, source_citation, source_quote, source_effective,
         source_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, codes_json = excluded.codes_json, diagnoses_json = excluded.diagnoses_json,
         modifiers_json = excluded.modifiers_json, pos_json = excluded.pos_json, max_units = excluded.max_units,
         period = excluded.period, severity = excluded.severity, message = excluded.message,
         source_quote = excluded.source_quote, updated_at = excluded.updated_at
       WHERE policy_rules.status = 'draft'`,
    )
    .run(
      rule.id,
      rule.kind,
      JSON.stringify(rule.codes),
      JSON.stringify(rule.diagnoses),
      JSON.stringify(rule.modifiers),
      JSON.stringify(rule.placesOfService),
      rule.maxUnits,
      rule.period,
      rule.severity,
      rule.message,
      rule.payer,
      rule.status,
      rule.source.document,
      rule.source.citation,
      rule.source.quote,
      rule.source.effective,
      rule.source.url,
      now,
      now,
    );
}

export const policyCompileTool = defineTool({
  name: "policy_compile",
  description:
    "Read a coverage policy (LCD, NCD, billing article, payer bulletin) and draft scrub rules from the sentences that state obligations. Every rule is a DRAFT carrying the paragraph it came from, and none of them affects a claim until a person accepts it with policy_rule_review. The result also lists the obligations the compiler could NOT encode — those are the parts of the policy this practice is not checking, and they matter more than the ones it could.",
  schema: z.object({
    text: z.string().default("").describe("Policy text. Supply this or file."),
    file: z.string().default("").describe("Workspace-relative path to a text file containing the policy."),
    document: z.string().describe('The document this came from, e.g. "LCD L33822" or "Aetna CPB 0121"'),
    citation: z.string().default("").describe("Section or group reference inside the document"),
    effective: z.string().default("").describe("YYYYMMDD the policy takes effect"),
    url: z.string().default(""),
    payer: z.string().default("").describe("Restrict the drafted rules to one payer. Empty means all payers."),
    save: z.boolean().default(false).describe("Store the drafts for review. They are still inert until accepted."),
  }),
  execute: async (input, ctx) => {
    let text = input.text;
    if (!text && input.file) {
      const config = ctx.services.config as Config;
      text = readFileSync(confinePath(config.workspaceRoot, input.file), "utf8");
    }
    if (!text.trim()) return { content: "Supply either `text` or `file`.", isError: true };

    const idPrefix = input.document.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "policy";
    const result = compilePolicy(text, {
      source: { document: input.document, citation: input.citation, effective: input.effective, url: input.url },
      payer: payerKey(input.payer),
      idPrefix,
    });

    if (input.save) {
      for (const draft of result.drafts) {
        const { basis: _basis, ...rule } = draft as DraftRule;
        insertRule(ctx, rule);
      }
      appendAudit(ctx.services.store as MemoryStore, {
        kind: "rule_change",
        actor: "policy_compile",
        summary: `Drafted ${result.drafts.length} rule(s) from ${input.document}`,
        payload: { document: input.document, ids: result.drafts.map((d) => d.id) },
      });
    }

    return {
      content: [
        renderCompileResult(result, input.document),
        "",
        input.save
          ? `${result.drafts.length} draft(s) stored. Review them with policy_rule_list, then policy_rule_review to accept or reject each one.`
          : "Nothing was stored. Re-run with save: true to queue these for review.",
      ].join("\n"),
    };
  },
});

export const policyRuleAddTool = defineTool({
  name: "policy_rule_add",
  description:
    "Write a scrub rule by hand, as a draft. The source document and a verbatim quote of the policy text are required — a rule that cannot be traced back to the sentence it came from cannot be re-checked when the policy changes or defended when the payer asks, and the evaluator skips it.",
  schema: z.object({
    kind: z.enum([
      "requires_diagnosis",
      "excluded_diagnosis",
      "requires_modifier",
      "prohibited_modifier",
      "frequency_limit",
      "place_of_service",
      "not_covered",
      "requires_documentation",
    ]),
    codes: z.array(z.string()).min(1).describe('Procedure codes. A trailing "*" makes one a prefix, e.g. "9721*".'),
    diagnoses: z.array(z.string()).default([]).describe("ICD-10-CM codes; a category covers its children"),
    modifiers: z.array(z.string()).default([]),
    places_of_service: z.array(z.string()).default([]),
    max_units: z.number().int().min(0).default(0),
    period: z.enum(["claim", "day", "month", "year", "lifetime"]).default("claim"),
    severity: z.enum(["error", "warning", "info"]).default("warning"),
    message: z.string().describe("What to tell the biller when this fires"),
    payer: z.string().default("").describe("Empty applies the rule to every payer"),
    source_document: z.string(),
    source_citation: z.string().default(""),
    source_quote: z.string().describe("The policy sentence, quoted rather than paraphrased"),
    source_effective: z.string().default(""),
    source_url: z.string().default(""),
  }),
  execute: async (input, ctx) => {
    if (!input.source_quote.trim()) {
      return { content: "A verbatim quote of the policy text is required.", isError: true };
    }
    const rule: PolicyRule = {
      id: newId("rule"),
      kind: input.kind,
      codes: input.codes,
      diagnoses: input.diagnoses,
      modifiers: input.modifiers,
      placesOfService: input.places_of_service,
      maxUnits: input.max_units,
      period: input.period,
      severity: input.severity,
      message: input.message,
      payer: payerKey(input.payer),
      status: "draft",
      source: {
        document: input.source_document,
        citation: input.source_citation,
        quote: input.source_quote,
        effective: input.source_effective,
        url: input.source_url,
      },
    };
    insertRule(ctx, rule);
    appendAudit(ctx.services.store as MemoryStore, {
      kind: "rule_change",
      actor: "policy_rule_add",
      summary: `Drafted ${rule.id} (${rule.kind})`,
      payload: rule,
    });
    return { content: `Drafted:\n\n${renderRule(rule)}\n\nIt is inert until accepted with policy_rule_review.` };
  },
});

export const policyRuleListTool = defineTool({
  name: "policy_rule_list",
  description:
    "List policy rules with the source text each one came from. Drafts are shown first — those are the ones waiting on a decision.",
  schema: z.object({
    status: z.enum(["draft", "active", "rejected", "retired", "all"]).default("draft"),
    document: z.string().default("").describe("Filter to one source document"),
  }),
  execute: async (input, ctx) => {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (input.status !== "all") {
      clauses.push("status = ?");
      args.push(input.status);
    }
    if (input.document) {
      clauses.push("source_document LIKE ?");
      args.push(`%${input.document}%`);
    }
    const rows = db(ctx)
      .prepare(
        `SELECT * FROM policy_rules ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY status, created_at DESC LIMIT 200`,
      )
      .all(...args) as RuleRow[];
    if (rows.length === 0) return { content: `No ${input.status === "all" ? "" : `${input.status} `}rules.` };
    return { content: rows.map(toRule).map(renderRule).join("\n\n") };
  },
});

export const policyRuleReviewTool = defineTool({
  name: "policy_rule_review",
  description:
    "Accept, reject or retire a drafted rule. Accepting makes it live in claim_scrub on the next run. A rejection needs a reason — it is what stops the same bad draft being re-imported next quarter — and every decision is written to the tamper-evident audit log.",
  schema: z.object({
    rule_id: z.string(),
    decision: z.enum(["accept", "reject", "retire"]),
    reviewer: z.string().describe("Who decided. An unattributed rule change is not an audit trail."),
    reason: z.string().default(""),
  }),
  execute: async (input, ctx) => {
    const row = db(ctx).prepare("SELECT * FROM policy_rules WHERE id = ?").get(input.rule_id) as RuleRow | undefined;
    if (!row) return { content: `No rule ${input.rule_id}.`, isError: true };
    if (!input.reviewer.trim()) return { content: "A reviewer name is required.", isError: true };
    if (input.decision !== "accept" && !input.reason.trim()) {
      return { content: `A reason is required to ${input.decision} a rule.`, isError: true };
    }
    const status = input.decision === "accept" ? "active" : input.decision === "reject" ? "rejected" : "retired";
    db(ctx)
      .prepare("UPDATE policy_rules SET status = ?, reviewer = ?, review_reason = ?, updated_at = ? WHERE id = ?")
      .run(status, input.reviewer.trim(), input.reason, Date.now(), input.rule_id);
    appendAudit(ctx.services.store as MemoryStore, {
      kind: "rule_change",
      actor: input.reviewer.trim(),
      summary: `${input.decision} rule ${input.rule_id} → ${status}`,
      payload: { rule_id: input.rule_id, decision: input.decision, reason: input.reason },
    });
    return {
      content:
        status === "active"
          ? `${input.rule_id} is active. It runs against every claim scrubbed from now on.\n\n${renderRule({ ...toRule(row), status: "active" })}`
          : `${input.rule_id} is ${status}. Reason recorded: ${input.reason}`,
    };
  },
});

export const policyRuleTestTool = defineTool({
  name: "policy_rule_test",
  description:
    "Run the active policy rules against a claim without scrubbing it, to see what a rule set would say. Useful before accepting a draft: pass check_drafts to include rules still awaiting review.",
  schema: ClaimSchema.extend({
    check_drafts: z.boolean().default(false).describe("Include draft rules, so a draft can be tried before accepting"),
  }),
  execute: async (input, ctx) => {
    const { check_drafts, ...claim } = input;
    const rows = db(ctx)
      .prepare(`SELECT * FROM policy_rules WHERE status IN (${check_drafts ? "'active','draft'" : "'active'"})`)
      .all() as RuleRow[];
    // Drafts are inert by construction, so testing one means running it as if active.
    const rules = rows.map(toRule).map((r) => ({ ...r, status: "active" as const }));
    if (rules.length === 0) return { content: "No rules to run." };
    const findings = evaluateRules(claim as ClaimInput, rules);
    if (findings.length === 0) return { content: `${rules.length} rule(s) ran; none fired on this claim.` };
    return {
      content: [
        `${rules.length} rule(s) ran, ${findings.length} finding(s):`,
        ...findings.map((f) => `[${f.severity.toUpperCase()}] ${f.rule}: ${f.message}`),
      ].join("\n"),
    };
  },
});

export const sentinelRunTool = defineTool({
  name: "sentinel_run",
  description:
    "Sample your own claims and audit them the way a contractor would. Reports the error rate WITH the interval around it — a rate from a small sample is a direction, not a number — and says whether it reaches the 50% 'high level of payment error' threshold, which is the line that lets a contractor extrapolate an overpayment across every claim instead of the ones it reviewed. The sample is seeded and reproducible. Findings are recorded but nothing is filed as an overpayment: identification starts a 60-day clock, and that is a person's call.",
  schema: z.object({
    sample_size: z.number().int().min(1).max(500).default(30),
    seed: z.string().default("").describe("Anything; the same value redraws the same claims. Defaults to today."),
    payer: z.string().default("").describe("Restrict the population to one payer"),
    file_findings: z.boolean().default(false).describe("Open worklist items for the claims with errors"),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore;
    const rows = (
      input.payer
        ? store.db.prepare("SELECT id, payer, claim_json FROM claims WHERE payer = ?").all(input.payer)
        : store.db.prepare("SELECT id, payer, claim_json FROM claims").all()
    ) as Array<{ id: string; payer: string; claim_json: string }>;

    if (rows.length === 0) {
      return {
        content:
          "No stored claims to sample. Claims are recorded when claim_build_837p runs, so build some claims first — a self-audit needs a population.",
      };
    }

    const population: SampledClaim[] = rows.map((r) => {
      const claim = JSON.parse(r.claim_json) as ClaimInput;
      return {
        id: r.id,
        claim,
        paidCents: Math.round(claim.service_lines.reduce((sum, l) => sum + l.charge, 0) * 100),
      };
    });

    const seedText = input.seed || new Date().toISOString().slice(0, 10);
    const seed = seedFrom(seedText);
    const sample = drawSample(population, input.sample_size, seed);
    const report = auditSample(sample, population.length, seed, { rules: loadActiveRules(store) });

    const runId = newId("sent");
    store.db
      .prepare(
        `INSERT INTO sentinel_runs (id, seed, population_size, sample_size, claims_in_error, error_rate,
           lower_bound, upper_bound, conservative_bound, report, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        seed,
        report.populationSize,
        report.sampleSize,
        report.claimsInError,
        report.errorRate.point,
        report.errorRate.lower,
        report.errorRate.upper,
        report.conservativeLowerBound,
        renderReport(report),
        Date.now(),
      );

    let filed = 0;
    if (input.file_findings) {
      const now = Date.now();
      for (const audit of report.audits.filter((a) => a.inError)) {
        store.db
          .prepare(
            `INSERT INTO worklist_items (id, kind, title, detail_json, status, priority, created_at, updated_at)
             VALUES (?, 'compliance', ?, ?, 'open', ?, ?, ?)`,
          )
          .run(
            newId("wl"),
            `Self-audit finding: ${audit.claimRef}`,
            JSON.stringify({ run: runId, claim: audit.claimRef, findings: audit.findings }),
            audit.paidCents / 100,
            now,
            now,
          );
        filed++;
      }
    }

    appendAudit(store, {
      kind: "sentinel",
      actor: "sentinel_run",
      summary: `Audited ${report.sampleSize}/${report.populationSize} claims, ${report.claimsInError} with errors (seed "${seedText}")`,
      payload: { runId, seed, seedText, claimsInError: report.claimsInError },
    });

    return {
      content: [
        renderReport(report),
        "",
        `Run ${runId}, seed phrase "${seedText}".`,
        filed > 0 ? `${filed} worklist item(s) opened.` : "",
        report.sampleSize < MIN_SAMPLE_FOR_EXTRAPOLATION
          ? `Sample ${MIN_SAMPLE_FOR_EXTRAPOLATION} or more claims to get an exposure estimate.`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});

export const sentinelHistoryTool = defineTool({
  name: "sentinel_history",
  description:
    "Show past self-audit runs and how the error rate has moved. A single run is a snapshot; the trend across runs is what shows whether an education effort worked.",
  schema: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
  execute: async (input, ctx) => {
    const rows = db(ctx)
      .prepare("SELECT * FROM sentinel_runs ORDER BY created_at DESC LIMIT ?")
      .all(input.limit) as Array<{
      id: string;
      seed: number;
      sample_size: number;
      population_size: number;
      claims_in_error: number;
      error_rate: number;
      lower_bound: number;
      upper_bound: number;
      created_at: number;
    }>;
    if (rows.length === 0) return { content: "No self-audit runs yet." };
    return {
      content: rows
        .map(
          (r) =>
            `${new Date(r.created_at).toISOString().slice(0, 10)}  ${r.id}  ${r.claims_in_error}/${r.sample_size} in error ` +
            `(${(r.error_rate * 100).toFixed(1)}%, 95% CI ${(r.lower_bound * 100).toFixed(1)}–${(r.upper_bound * 100).toFixed(1)}%)  ` +
            `population ${r.population_size}  seed ${r.seed}`,
        )
        .join("\n"),
    };
  },
});
