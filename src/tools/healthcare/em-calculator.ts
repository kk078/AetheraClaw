import { z } from "zod";
import { defineTool } from "../registry.js";

// Deterministic 2021 E/M MDM-guideline scorer for office/outpatient visits
// (99202–99205 new / 99212–99215 established). Two of three elements set the level.

type Level = "straightforward" | "low" | "moderate" | "high";
const LEVEL_ORDER: Level[] = ["straightforward", "low", "moderate", "high"];

function problemsLevel(input: { minor_problems: number; stable_chronic: number; exacerbated_chronic: number; acute_uncomplicated: number; acute_complicated_or_systemic: number; threat_to_life: boolean }): Level {
  if (input.threat_to_life) return "high";
  if (input.exacerbated_chronic >= 2 || input.acute_complicated_or_systemic >= 1) return "moderate";
  if (input.exacerbated_chronic === 1) return "moderate";
  if (input.stable_chronic >= 2) return "moderate";
  if (input.stable_chronic === 1 || input.acute_uncomplicated >= 1) return "low";
  if (input.minor_problems >= 2) return "low";
  return "straightforward";
}

function dataLevel(input: { tests_reviewed: number; tests_ordered: number; external_notes: number; independent_historian: boolean; independent_interpretation: boolean; discussed_with_external: boolean }): Level {
  const cat1Count = input.tests_reviewed + input.tests_ordered + input.external_notes + (input.independent_historian ? 1 : 0);
  const cat2 = input.independent_interpretation;
  const cat3 = input.discussed_with_external;
  const met = [cat1Count >= 3, cat2, cat3].filter(Boolean).length;
  if (met >= 2) return "high";
  if (cat1Count >= 3 || cat2 || cat3) return "moderate";
  if (cat1Count >= 2) return "low";
  return "straightforward";
}

function riskLevel(input: { risk: "minimal" | "low" | "moderate" | "high" }): Level {
  return input.risk === "minimal" ? "straightforward" : input.risk;
}

export function calculateEm(input: {
  patient_type: "new" | "established";
  problems: Parameters<typeof problemsLevel>[0];
  data: Parameters<typeof dataLevel>[0];
  risk: "minimal" | "low" | "moderate" | "high";
}): { level: Level; code: string; rationale: string[] } {
  const p = problemsLevel(input.problems);
  const d = dataLevel(input.data);
  const r = riskLevel({ risk: input.risk });
  // MDM level = middle value (2 of 3 must meet or exceed).
  const sorted = [p, d, r].map((l) => LEVEL_ORDER.indexOf(l)).sort((a, b) => a - b);
  const mdm = LEVEL_ORDER[sorted[1]];
  const codes: Record<Level, [string, string]> = {
    straightforward: ["99202", "99212"],
    low: ["99203", "99213"],
    moderate: ["99204", "99214"],
    high: ["99205", "99215"],
  };
  const code = codes[mdm][input.patient_type === "new" ? 0 : 1];
  return {
    level: mdm,
    code,
    rationale: [
      `Problems addressed: ${p}`,
      `Data reviewed/analyzed: ${d}`,
      `Risk of complications/management: ${r}`,
      `MDM level (2-of-3 middle value): ${mdm}`,
      `Code (${input.patient_type} patient): ${code}`,
    ],
  };
}

export const emCalculateTool = defineTool({
  name: "em_calculate",
  description:
    "Calculate the office/outpatient E/M level (99202-99215) under the 2021 MDM guidelines from structured inputs: problems addressed, data reviewed, and risk. Returns the code with element-by-element rationale. Gather the inputs from the documentation conversationally, then call this.",
  schema: z.object({
    patient_type: z.enum(["new", "established"]),
    problems: z.object({
      minor_problems: z.number().int().min(0).default(0),
      stable_chronic: z.number().int().min(0).default(0).describe("Stable chronic illnesses"),
      exacerbated_chronic: z.number().int().min(0).default(0).describe("Chronic illnesses with exacerbation/progression"),
      acute_uncomplicated: z.number().int().min(0).default(0),
      acute_complicated_or_systemic: z.number().int().min(0).default(0).describe("Acute complicated injury/illness with systemic symptoms"),
      threat_to_life: z.boolean().default(false),
    }),
    data: z.object({
      tests_reviewed: z.number().int().min(0).default(0),
      tests_ordered: z.number().int().min(0).default(0),
      external_notes: z.number().int().min(0).default(0).describe("External notes/records sources reviewed"),
      independent_historian: z.boolean().default(false),
      independent_interpretation: z.boolean().default(false),
      discussed_with_external: z.boolean().default(false).describe("Discussion of management with external physician/QHP"),
    }),
    risk: z.enum(["minimal", "low", "moderate", "high"]).describe("Risk of complications/morbidity from patient management (e.g. prescription drug management = moderate)"),
  }),
  execute: async (input) => {
    const result = calculateEm(input);
    return { content: result.rationale.join("\n") };
  },
});
