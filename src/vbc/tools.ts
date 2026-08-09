import { z } from "zod";
import { defineTool } from "../tools/registry.js";
import { newId } from "../shared/ids.js";
import type { Config } from "../config/config.js";
import type { MemoryStore } from "../memory/store.js";
import type { ClaimInput } from "../tools/healthcare/x12/837.js";
import { dataDir, loadDataJson } from "../tools/healthcare/datasets.js";
import { appendAudit } from "../audit/store.js";
import { CURRENT_MODEL, computeRaf, renderRaf, validateModel, type HccModel } from "./hcc.js";
import { findRecaptureGaps, renderRecapture, type CodedDiagnosis } from "./recapture.js";
import { renderSuspects, reviewConditions, type DocumentationExcerpt, type SuspectRule } from "./suspecting.js";
import { MEASURES, computeAll, renderMeasures, type Encounter } from "./quality.js";

type Ctx = { services: Record<string, unknown> };
const store = (ctx: Ctx) => ctx.services.store as MemoryStore;

const MODEL_FILE = "hcc-model.json";

/**
 * The HCC model is a dataset, not code.
 *
 * CMS publishes the mappings and coefficients and they change every year, so
 * inventing them here would be worse than having none: a RAF computed from made-up
 * coefficients looks exactly like a real one and is a compliance problem rather
 * than a bug.
 */
function loadModel(): HccModel | string {
  const raw = loadDataJson<unknown>(MODEL_FILE);
  if (!raw) {
    return `No HCC model installed. Drop ${MODEL_FILE} into ${dataDir()} with the ICD-10→HCC mapping, category definitions and coefficients from the CMS ${CURRENT_MODEL} model files. Nothing here invents coefficients — a made-up RAF looks exactly like a real one.`;
  }
  return validateModel(raw);
}

function claimHistory(ctx: Ctx): CodedDiagnosis[] {
  const rows = store(ctx)
    .db.prepare("SELECT id, claim_json FROM claims")
    .all() as Array<{ id: string; claim_json: string }>;
  const out: CodedDiagnosis[] = [];
  for (const row of rows) {
    let claim: ClaimInput;
    try {
      claim = JSON.parse(row.claim_json) as ClaimInput;
    } catch {
      continue;
    }
    const patientRef = claim.compliance?.patient_ref;
    if (!patientRef) continue;
    const serviceDate = claim.service_lines.map((l) => l.service_date).filter(Boolean).sort()[0] ?? "";
    for (const code of claim.diagnoses) {
      out.push({ patientRef, code, serviceDate, claimRef: claim.claim_id ?? row.id });
    }
  }
  return out;
}

export const rafCalculateTool = defineTool({
  name: "raf_calculate",
  description:
    "Compute a RAF score from diagnoses, broken down term by term. Applies the hierarchies — within a hierarchy only the most severe condition counts, and coding both forms does not pay twice — and reports what was suppressed rather than dropping it silently. Needs the CMS HCC model installed as a dataset; nothing here invents coefficients.",
  schema: z.object({
    patient_ref: z.string().default(""),
    age: z.number().int().min(0).max(120),
    sex: z.enum(["M", "F", "U"]).default("U"),
    diagnoses: z.array(z.string()).min(1),
    institutional: z.boolean().default(false),
    dual_eligible: z.boolean().default(false),
    disabled: z.boolean().default(false),
  }),
  execute: async (input) => {
    const model = loadModel();
    if (typeof model === "string") return { content: model, isError: true };
    const result = computeRaf(
      {
        age: input.age,
        sex: input.sex,
        institutional: input.institutional,
        dualEligible: input.dual_eligible,
        disabled: input.disabled,
      },
      input.diagnoses,
      model,
    );
    return { content: renderRaf(result, input.patient_ref) };
  },
});

export const hccRecaptureTool = defineTool({
  name: "hcc_recapture",
  description:
    "Find chronic conditions coded in a prior year and not yet coded this one. HCCs do not carry forward — every condition has to be documented in a face-to-face encounter and coded again each calendar year — so this is the largest legitimate source of missed risk revenue. Separates patients seen this year (a chart review) from patients not seen at all (a scheduling problem, where no amount of chart review creates an encounter).",
  schema: z.object({
    year: z.number().int().min(2000).max(2100).default(new Date().getUTCFullYear()),
    as_of: z.string().default("").describe("YYYYMMDD; defaults to today"),
    lookback_years: z.number().int().min(1).max(10).default(3),
  }),
  execute: async (input, ctx) => {
    const model = loadModel();
    if (typeof model === "string") return { content: model, isError: true };

    const history = claimHistory(ctx);
    if (history.length === 0) {
      return {
        content:
          "No coded history with patient references. Recapture reads the claims table and needs claims that carry compliance.patient_ref — without it there is nothing to follow a patient across years.",
      };
    }

    const asOf = input.as_of || new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const report = findRecaptureGaps(history, {
      year: input.year,
      asOf,
      model,
      lookbackYears: input.lookback_years,
    });
    const dollars = (ctx.services.config as Config).vbc.dollarsPerRaf;
    return { content: renderRecapture(report, dollars) };
  },
});

const SuspectRuleSchema = z.object({
  hcc: z.string(),
  phrases: z.array(z.string()).min(1).describe("Words in a note that suggest this condition"),
  suggested_code: z.string().describe("The ICD-10 code a coder might consider. A proposal, not a decision."),
});

export const suspectConditionsTool = defineTool({
  name: "suspect_conditions",
  description:
    "Review documentation against what was coded, IN BOTH DIRECTIONS: conditions documented but not coded, and conditions coded with nothing found to support them. The symmetry is structural, not a setting — a tool that only ever proposes adding codes is an upcoding engine whatever it says about itself, because the only direction it can move a risk score is up. Every proposal carries the sentence it came from and which of Monitor/Evaluate/Assess/Treat that sentence supports. Nothing is coded: proposals go to a coder to accept or reject with a reason.",
  schema: z.object({
    patient_ref: z.string(),
    year: z.number().int().min(2000).max(2100).default(new Date().getUTCFullYear()),
    documentation: z
      .array(
        z.object({
          service_date: z.string(),
          text: z.string().describe("De-identified or synthetic note text only"),
          source: z.string().default(""),
        }),
      )
      .min(1),
    coded_hccs: z.array(z.string()).default([]).describe("HCCs already coded for this patient this year"),
    rules: z.array(SuspectRuleSchema).min(1).describe("Phrase-to-condition rules, supplied as data so every one is visible"),
    save: z.boolean().default(false).describe("Queue the proposals for a coder"),
  }),
  execute: async (input, ctx) => {
    const model = loadModel();
    if (typeof model === "string") return { content: model, isError: true };

    const documentation: DocumentationExcerpt[] = input.documentation.map((d) => ({
      patientRef: input.patient_ref,
      serviceDate: d.service_date,
      text: d.text,
      source: d.source || "note",
    }));
    const rules: SuspectRule[] = input.rules.map((r) => ({
      hcc: r.hcc,
      phrases: r.phrases,
      suggestedCode: r.suggested_code,
    }));

    const review = reviewConditions({ documentation, codedHccs: input.coded_hccs, rules, model });

    let queued = 0;
    if (input.save) {
      const now = Date.now();
      const insert = store(ctx).db.prepare(
        `INSERT INTO vbc_suspects (id, patient_ref, year, direction, hcc, label, coefficient, suggested_code,
           quote, meat, source, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      );
      for (const c of review.add) {
        insert.run(newId("vbc"), c.patientRef, input.year, "add", c.hcc, c.label, c.coefficient, c.suggestedCode, c.quote, c.meat.join(","), c.source, now, now);
        queued++;
      }
      for (const c of review.mentions) {
        insert.run(newId("vbc"), c.patientRef, input.year, "mention_only", c.hcc, c.label, c.coefficient, c.suggestedCode, c.quote, "", c.source, now, now);
        queued++;
      }
      for (const c of review.unsupported) {
        insert.run(newId("vbc"), input.patient_ref, input.year, "remove", c.hcc, c.label, c.coefficient, "", c.reason, "", "", now, now);
        queued++;
      }
      appendAudit(store(ctx), {
        kind: "vbc_suspect",
        actor: "suspect_conditions",
        summary: `${review.add.length} add, ${review.unsupported.length} remove, ${review.mentions.length} mention-only for ${input.patient_ref} (${input.year})`,
        payload: { patientRef: input.patient_ref, netRaf: review.netRaf },
      });
    }

    return {
      content: [
        renderSuspects(review),
        queued > 0 ? `\n${queued} proposal(s) queued for review. None of them is coded.` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});

export const suspectListTool = defineTool({
  name: "suspect_list",
  description:
    "Show queued risk-adjustment proposals. The add and remove counts are printed together on purpose — a queue that only ever grows the score is worth noticing before an auditor notices it.",
  schema: z.object({
    status: z.enum(["pending", "accepted", "rejected", "all"]).default("pending"),
    year: z.number().int().optional(),
  }),
  execute: async (input, ctx) => {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (input.status !== "all") {
      clauses.push("status = ?");
      args.push(input.status);
    }
    if (input.year) {
      clauses.push("year = ?");
      args.push(input.year);
    }
    const rows = store(ctx)
      .db.prepare(
        `SELECT * FROM vbc_suspects ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY direction, coefficient DESC LIMIT 200`,
      )
      .all(...args) as Array<{
      id: string;
      patient_ref: string;
      direction: string;
      hcc: string;
      label: string;
      coefficient: number;
      suggested_code: string;
      quote: string;
      meat: string;
      status: string;
    }>;
    if (rows.length === 0) return { content: "No risk-adjustment proposals queued." };

    const adds = rows.filter((r) => r.direction === "add");
    const removes = rows.filter((r) => r.direction === "remove");
    const mentions = rows.filter((r) => r.direction === "mention_only");
    const net = adds.reduce((s, r) => s + r.coefficient, 0) - removes.reduce((s, r) => s + r.coefficient, 0);

    const lines = [
      `${rows.length} proposal(s): ${adds.length} add, ${removes.length} remove, ${mentions.length} mention-only. Net ${net >= 0 ? "+" : ""}${net.toFixed(3)} RAF if all were accepted.`,
    ];
    if (adds.length > 0 && removes.length === 0) {
      lines.push(
        "Every proposal here raises the score. Worth checking that the documentation reviewed actually covered the conditions already coded — an empty remove side can mean nothing was wrong, or that nothing was looked at.",
      );
    }
    for (const r of rows) {
      lines.push(
        "",
        `  ${r.id}  [${r.direction}]  ${r.hcc} ${r.label}  ${r.direction === "remove" ? "−" : "+"}${r.coefficient.toFixed(3)}  ${r.patient_ref}`,
        r.suggested_code ? `    consider ${r.suggested_code}${r.meat ? ` · supports: ${r.meat}` : ""}` : "",
        `    "${r.quote.slice(0, 160)}"`,
      );
    }
    return { content: lines.filter(Boolean).join("\n") };
  },
});

export const suspectReviewTool = defineTool({
  name: "suspect_review",
  description:
    "Accept or reject a risk-adjustment proposal. A reason is required either way — including on acceptance, which is deliberate: a code added to a risk score is the one a RADV audit asks about, and 'the tool suggested it' is not an answer.",
  schema: z.object({
    suspect_id: z.string(),
    decision: z.enum(["accept", "reject"]),
    reviewer: z.string(),
    reason: z.string().describe("Required. What in the record supports the decision."),
  }),
  execute: async (input, ctx) => {
    const row = store(ctx).db.prepare("SELECT * FROM vbc_suspects WHERE id = ?").get(input.suspect_id) as
      | { id: string; hcc: string; direction: string; status: string }
      | undefined;
    if (!row) return { content: `No proposal ${input.suspect_id}.`, isError: true };
    if (!input.reviewer.trim()) return { content: "A reviewer name is required.", isError: true };
    if (!input.reason.trim()) {
      return {
        content:
          "A reason is required, on acceptance as well as rejection. This is the code an auditor asks about, and the answer cannot be that a tool proposed it.",
        isError: true,
      };
    }
    if (row.status !== "pending") {
      return { content: `${input.suspect_id} was already ${row.status}. Decisions are not silently overwritten.`, isError: true };
    }

    store(ctx)
      .db.prepare("UPDATE vbc_suspects SET status = ?, reviewer = ?, review_reason = ?, updated_at = ? WHERE id = ?")
      .run(input.decision === "accept" ? "accepted" : "rejected", input.reviewer.trim(), input.reason, Date.now(), input.suspect_id);
    appendAudit(store(ctx), {
      kind: "vbc_suspect",
      actor: input.reviewer.trim(),
      summary: `${input.decision} ${row.direction} proposal ${row.hcc} (${input.suspect_id})`,
      payload: { id: input.suspect_id, reason: input.reason },
    });

    return {
      content:
        input.decision === "accept"
          ? `${input.suspect_id} accepted by ${input.reviewer}. It still has to be coded on a claim from a face-to-face encounter this year — accepting a proposal does not submit anything.`
          : `${input.suspect_id} rejected. Reason recorded: ${input.reason}`,
    };
  },
});

export const qualityMeasuresTool = defineTool({
  name: "quality_measures",
  description:
    "Compute MIPS/eCQM measure rates from stored claims, and say how much of a poor rate is performance and how much is paperwork. A clinical value reaches a claim only as a CPT Category II code, so a practice that controls blood pressure well but never submits 3074F looks identical to one that never measured it. Denominator patients with no Category II code either way are counted and reported separately.",
  schema: z.object({
    year: z.number().int().min(2000).max(2100).default(new Date().getUTCFullYear()),
    measure: z.string().default("").describe("Restrict to one measure id, e.g. MIPS-236"),
  }),
  execute: async (input, ctx) => {
    const rows = store(ctx).db.prepare("SELECT claim_json FROM claims").all() as Array<{ claim_json: string }>;
    const encounters: Encounter[] = [];
    for (const row of rows) {
      let claim: ClaimInput;
      try {
        claim = JSON.parse(row.claim_json) as ClaimInput;
      } catch {
        continue;
      }
      const patientRef = claim.compliance?.patient_ref;
      if (!patientRef) continue;
      const serviceDate = claim.service_lines.map((l) => l.service_date).filter(Boolean).sort()[0] ?? "";
      if (serviceDate && Number(serviceDate.slice(0, 4)) !== input.year) continue;
      const dob = claim.patient_dob;
      const age = /^\d{8}$/.test(dob) && serviceDate ? Number(serviceDate.slice(0, 4)) - Number(dob.slice(0, 4)) : 0;
      encounters.push({
        patientRef,
        serviceDate,
        age,
        codes: [...claim.diagnoses, ...claim.service_lines.map((l) => l.cpt_hcpcs)],
      });
    }

    if (encounters.length === 0) {
      return {
        content: `No claims for ${input.year} carrying a patient reference. Measures need claims with compliance.patient_ref so a patient can be followed across encounters.`,
      };
    }

    const specs = input.measure ? MEASURES.filter((m) => m.id === input.measure) : MEASURES;
    if (specs.length === 0) {
      return { content: `No measure "${input.measure}". Known: ${MEASURES.map((m) => m.id).join(", ")}.`, isError: true };
    }
    return { content: renderMeasures(computeAll(encounters, specs)) };
  },
});
