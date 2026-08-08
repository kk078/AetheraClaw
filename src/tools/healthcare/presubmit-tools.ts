import { z } from "zod";
import { defineTool } from "../registry.js";
import type { MemoryStore } from "../../memory/store.js";
import { ClaimSchema, type ClaimInput } from "./x12/837.js";
import { scrubClaim } from "./claim-scrub.js";
import { loadTelehealthPolicy } from "./compliance/telehealth.js";
import { loadActiveRules } from "../../compliance/rule-store.js";
import { loadEras } from "./analytics.js";
import { collectOutcomes, indexHistory, scoreDenialRisk } from "./prediction/risk.js";
import { datasetStatuses } from "./datasets.js";
import { assessEmLevel, evaluateGate, renderEmRisk, renderGate, type EmRisk } from "./presubmit.js";

const MdmSchema = z.object({
  patient_type: z.enum(["new", "established"]),
  problems: z.object({
    minor_problems: z.number().int().min(0).default(0),
    stable_chronic: z.number().int().min(0).default(0),
    exacerbated_chronic: z.number().int().min(0).default(0),
    acute_uncomplicated: z.number().int().min(0).default(0),
    acute_complicated_or_systemic: z.number().int().min(0).default(0),
    threat_to_life: z.boolean().default(false),
  }),
  data: z.object({
    tests_reviewed: z.number().int().min(0).default(0),
    tests_ordered: z.number().int().min(0).default(0),
    external_notes: z.number().int().min(0).default(0),
    independent_historian: z.boolean().default(false),
    independent_interpretation: z.boolean().default(false),
    discussed_with_external: z.boolean().default(false),
  }),
  risk: z.enum(["minimal", "low", "moderate", "high"]),
});

export const emLevelRiskTool = defineTool({
  name: "em_level_risk",
  description:
    "Compare a billed E/M code against the level the documented MDM supports, in BOTH directions. Billed above the documentation is upcoding — a False Claims Act exposure and what an E/M audit selects on. Billed below it is undercoding, which is not a compliance problem but is revenue earned and not billed, and is the more common finding; a tool that reported only the first direction would teach a practice to downcode defensively, which pulls it under its peer benchmark and invites the audit it was avoiding. The MDM elements are the same ones em_calculate takes — score the note, do not guess them.",
  schema: z.object({
    billed_code: z.string().describe("The E/M code on the claim, e.g. 99214"),
    documentation: MdmSchema.describe("MDM elements as supported by the documentation"),
  }),
  execute: async (input) => {
    const result = assessEmLevel(input.billed_code, input.documentation as Parameters<typeof assessEmLevel>[1]);
    if ("error" in result) return { content: result.error, isError: true };
    return { content: renderEmRisk(result) };
  },
});

export const presubmitCheckTool = defineTool({
  name: "presubmit_check",
  description:
    "Run a claim through every pre-submission check at once — structural and compliance scrubbing, this practice's own denial-risk history, and optionally the E/M level against what the documentation supports — and return one of three verdicts: hold, review, or clear. 'Clear' means nothing that RAN found a problem; any check whose dataset is not installed is reported at the top as a blind spot rather than counted as a pass, because turning an absence of information into a statement of safety is worse than having no gate.",
  schema: z.object({
    claim: ClaimSchema,
    documentation: MdmSchema.optional().describe("Include to check the E/M level on this claim against the note"),
    em_line: z.number().int().min(1).default(1).describe("Which service line carries the E/M code"),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    const claim = input.claim as ClaimInput;

    const findings = scrubClaim(claim, {
      telehealthPolicy: loadTelehealthPolicy(store, claim.payer_name),
      telehealthPolicyWasStored: false,
      policyRules: store ? loadActiveRules(store) : [],
    });

    // Denial risk needs the practice's own remittance history; with none, the
    // scorer returns a bare default, which must not be presented as a prediction.
    let denialProbability: number | null = null;
    let denialFactors: string[] = [];
    if (store) {
      const index = indexHistory(collectOutcomes(loadEras(store)));
      if (index.overall.n > 0) {
        const score = scoreDenialRisk(
          { payer: claim.payer_name, codes: claim.service_lines.map((l) => l.cpt_hcpcs) },
          index,
        );
        denialProbability = score.probability;
        denialFactors = score.factors.filter((f) => Math.abs(f.points) >= 1).map((f) => f.label);
      }
    }

    let emRisk: EmRisk | undefined;
    const emErrors: string[] = [];
    if (input.documentation) {
      const line = claim.service_lines[input.em_line - 1];
      if (!line) {
        emErrors.push(`em_line ${input.em_line} does not exist on this claim (${claim.service_lines.length} line(s)).`);
      } else {
        const assessed = assessEmLevel(line.cpt_hcpcs, input.documentation as Parameters<typeof assessEmLevel>[1]);
        if ("error" in assessed) emErrors.push(assessed.error);
        else emRisk = assessed;
      }
    }

    // A check whose data is absent did not pass — it did not run.
    const checksNotRun: string[] = [];
    for (const ds of datasetStatuses()) {
      if (ds.installed) continue;
      if (ds.file === "ncci-ptp.json") checksNotRun.push("NCCI bundling edits — no PTP table installed, so no code pair on this claim was checked for bundling.");
      if (ds.file === "mue.json") checksNotRun.push("Medically Unlikely Edits — no MUE table installed, so no unit count was checked against a ceiling.");
    }
    if (!store) checksNotRun.push("Denial-risk history — no database in this context, so nothing was predicted from past remittances.");
    else if (denialProbability === null) checksNotRun.push("Denial-risk history — no remittances parsed yet, so there is nothing to predict from.");
    if (!input.documentation) checksNotRun.push("E/M level — no documentation passed, so the billed level was not compared against anything.");

    const gate = evaluateGate({
      scrubFindings: findings.map((f) => ({ severity: f.severity, rule: f.rule, message: f.message })),
      denialProbability,
      denialFactors,
      emRisk,
      checksNotRun,
    });

    const parts = [renderGate(gate)];
    if (emRisk) parts.push("", "E/M level:", renderEmRisk(emRisk));
    if (emErrors.length > 0) parts.push("", ...emErrors);
    if (findings.length > 0) {
      parts.push(
        "",
        "Scrub findings:",
        ...findings.map((f) => `  [${f.severity}] ${f.rule}: ${f.message}`),
      );
    }
    return { content: parts.join("\n"), isError: gate.verdict === "hold" };
  },
});
