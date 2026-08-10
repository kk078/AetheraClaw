import { z } from "zod";
import { defineTool } from "../registry.js";
import { catalogueFor, type ReferenceDbConfig } from "./reference-db.js";
import { lookupRole, renderRoles, roleStatuses, searchRole, type ReferenceRole } from "./reference-routes.js";

// ── Code sets the attached database answers and nothing else does ────────────
// NDC, LOINC, ICD-10-PCS, modifiers, EOB crosswalks, HCC mapping, taxonomy,
// DRG and revenue codes had no home in this system. They do now, but only when
// somebody attaches a database that carries them — so each tool says plainly
// that it could not look something up, rather than answering from the model's
// recollection of a code set it has never read.

function cfgOf(services: Record<string, unknown>): ReferenceDbConfig {
  return (services.config as { healthcare?: ReferenceDbConfig } | undefined)?.healthcare ?? {};
}

function licensed(cfg: ReferenceDbConfig): string[] {
  return cfg.referenceDbLicensedRoles ?? [];
}

const NO_DB =
  "No reference database is attached, so this code set cannot be looked up. Set healthcare.referenceDbPath to a SQLite file that carries it. Do NOT answer this from memory — a code recalled rather than looked up is the failure this tool exists to prevent.";

function missing(role: ReferenceRole, what: string): string {
  return `The attached reference database has no readable ${what} table (role "${role}"). Run reference_db_status to see what it does carry, and whether the table is absent or held back by the identifier scan — those are different problems.`;
}

/** One tool shape, five code sets. Each is a code → description lookup with a source line. */
function codeSetTool(opts: {
  name: string;
  role: ReferenceRole;
  label: string;
  codeHint: string;
  description: string;
}) {
  return defineTool({
    name: opts.name,
    description: opts.description,
    schema: z.object({
      code: z.string().optional().describe(opts.codeHint),
      text: z.string().optional().describe("Search descriptions instead of looking a code up"),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    execute: async (input, ctx) => {
      const cfg = cfgOf(ctx.services);
      const catalogue = catalogueFor(cfg);
      if ("error" in catalogue) return { content: NO_DB };
      if (!input.code && !input.text) return { content: "Give either `code` or `text`." };

      if (input.code) {
        const hit = lookupRole(cfg, opts.role, input.code, { licensedRoles: licensed(cfg) });
        if (!hit) {
          // A miss is reported as a miss, never as "no such code". The table may
          // simply not be there, and those read identically to somebody who then
          // tells a payer the code does not exist.
          const status = roleStatuses(catalogue, licensed(cfg)).find((s) => s.role === opts.role);
          if (!status?.table) return { content: missing(opts.role, opts.label) };
          return { content: `${input.code.trim().toUpperCase()} was not found in ${status.table}. That is a miss in this table, not proof the code does not exist.` };
        }
        return { content: `${hit.code}: ${hit.description}\nSource: ${hit.table} in ${catalogue.path}.` };
      }

      const rows = searchRole(cfg, opts.role, input.text!, input.limit ?? 15, { licensedRoles: licensed(cfg) });
      if (rows.length === 0) {
        const status = roleStatuses(catalogue, licensed(cfg)).find((s) => s.role === opts.role);
        return { content: status?.table ? `No ${opts.label} match for "${input.text}" in ${status.table}.` : missing(opts.role, opts.label) };
      }
      return {
        content: [...rows.map((r) => `${r.code}  ${r.description}`), "", `Source: ${rows[0].table} in ${catalogue.path}.`].join("\n"),
      };
    },
  });
}

export const ndcLookupTool = codeSetTool({
  name: "ndc_lookup",
  role: "ndc",
  label: "NDC",
  codeHint: "11-digit National Drug Code, e.g. 00093721410",
  description:
    "Look up a National Drug Code (NDC) — the drug identifier on a pharmacy claim and on a J-code line's NDC qualifier. Answers only from an attached reference database; there is no bundled NDC table, so a miss is reported as a miss rather than as a nonexistent code.",
});

export const loincLookupTool = codeSetTool({
  name: "loinc_lookup",
  role: "loinc",
  label: "LOINC",
  codeHint: "LOINC code, e.g. 2160-0",
  description:
    "Look up a LOINC laboratory or clinical observation code. LOINC identifies what was measured, which is what a payer's lab policy is written against — a CPT code says a test was run, LOINC says which analyte. Answers only from an attached reference database.",
});

export const icd10PcsLookupTool = codeSetTool({
  name: "icd10pcs_lookup",
  role: "icd10pcs",
  label: "ICD-10-PCS",
  codeHint: "7-character ICD-10-PCS code, e.g. 0DTJ4ZZ",
  description:
    "Look up an ICD-10-PCS inpatient procedure code. PCS is used on institutional inpatient claims, NOT on the professional 837P this system builds — so a PCS code appearing on a professional claim is itself the finding. Answers only from an attached reference database.",
});

export const modifierLookupTool = codeSetTool({
  name: "modifier_lookup",
  role: "modifier",
  label: "modifier",
  codeHint: "Two-character modifier, e.g. 25, 59, TC, GT",
  description:
    "Look up a CPT/HCPCS modifier's meaning. Modifiers change what a line asserts and what it pays, and the system has no bundled modifier table — so without an attached reference database this reports that it could not check, rather than recalling one.",
});

export const drgLookupTool = codeSetTool({
  name: "drg_lookup",
  role: "drg",
  label: "MS-DRG",
  codeHint: "Three-digit MS-DRG, e.g. 470",
  description:
    "Look up an MS-DRG code. DRGs price INSTITUTIONAL inpatient stays, not professional services — this system bills 837P, so a DRG here is for reading a facility's remittance rather than for anything it generates. Answers only from an attached reference database.",
});

export const taxonomyLookupTool = codeSetTool({
  name: "taxonomy_lookup",
  role: "taxonomy",
  label: "provider taxonomy",
  codeHint: "10-character taxonomy code, e.g. 207Q00000X",
  description:
    "Look up a provider taxonomy code — the specialty classification NPPES records and payers credential against. Answers only from an attached reference database.",
});

// ── EOB crosswalk ────────────────────────────────────────────────────────────

export const eobCrosswalkTool = defineTool({
  name: "eob_crosswalk",
  description:
    "Translate a payer's own EOB / explanation code into the standard CARC and RARC it corresponds to. Payers print proprietary codes on paper remittances that do not appear anywhere in X12, so a denial arriving by post cannot otherwise be matched to the 835 denials already in the system. Answers only from an attached reference database.",
  schema: z.object({
    payer: z.string().optional().describe("Payer name filter — the same EOB code means different things at different payers"),
    code: z.string().describe("The payer's EOB / remark code as printed"),
  }),
  execute: async (input, ctx) => {
    const cfg = cfgOf(ctx.services);
    const catalogue = catalogueFor(cfg);
    if ("error" in catalogue) return { content: NO_DB };

    const hit = lookupRole(cfg, "eob", input.code);
    if (!hit) {
      const status = roleStatuses(catalogue, licensed(cfg)).find((s) => s.role === "eob");
      return { content: status?.table ? `No EOB code "${input.code}" in ${status.table}.` : missing("eob", "EOB crosswalk") };
    }

    // The SAME EOB code means different things at different payers, so a hit
    // whose payer does not match the one asked about is reported as a possible
    // mismatch rather than served as the answer.
    const rowPayer = String(hit.row.payer ?? "").trim();
    const asked = (input.payer ?? "").trim();
    const mismatch = asked && rowPayer && rowPayer.toLowerCase() !== asked.toLowerCase();

    const carc = String(hit.row.carc ?? "").trim();
    const rarc = String(hit.row.rarc ?? "").trim();
    return {
      content: [
        `${hit.code} (${rowPayer || "payer not stated"}): ${hit.description}`,
        carc ? `CARC ${carc}${hit.row.carc_desc ? ` — ${String(hit.row.carc_desc).slice(0, 300)}` : ""}` : "No CARC mapped.",
        rarc ? `RARC ${rarc}${hit.row.rarc_desc ? ` — ${String(hit.row.rarc_desc).slice(0, 300)}` : ""}` : "No RARC mapped.",
        ...(mismatch
          ? ["", `WARNING: you asked about "${asked}" and this row is ${rowPayer}. The same EOB code carries different meanings at different payers, so treat this as a lead rather than the answer.`]
          : []),
        "",
        `Source: ${hit.table} in ${catalogue.path}.`,
      ].join("\n"),
    };
  },
});

// ── HCC risk adjustment ──────────────────────────────────────────────────────

export const hccLookupTool = defineTool({
  name: "hcc_lookup",
  description:
    "Map an ICD-10 diagnosis to its HCC risk-adjustment category and weight across model versions (V22, V24, V28). Reports every version present rather than picking one, because which model a plan is paid under decides the number and this system does not know that. Answers only from an attached reference database.",
  schema: z.object({ code: z.string().describe("ICD-10-CM code, e.g. E11.65 or E1165") }),
  execute: async (input, ctx) => {
    const cfg = cfgOf(ctx.services);
    const catalogue = catalogueFor(cfg);
    if ("error" in catalogue) return { content: NO_DB };

    // Mapping tables are usually keyed undotted; try both rather than reporting
    // a miss that is really a formatting difference.
    const bare = input.code.replace(/\./g, "").toUpperCase();
    const hit = lookupRole(cfg, "hcc", bare) ?? lookupRole(cfg, "hcc", input.code);
    if (!hit) {
      const status = roleStatuses(catalogue, licensed(cfg)).find((s) => s.role === "hcc");
      return {
        content: status?.table
          ? `${input.code} is not mapped to an HCC in ${status.table}. Most diagnoses are not — roughly 10% of ICD-10 carries risk weight — so this is an ordinary answer rather than a failure.`
          : missing("hcc", "HCC mapping"),
      };
    }

    const row = hit.row;
    const versions: string[] = [];
    for (const [label, hcc, weight] of [
      ["V22", "HCC_V22", "RISK_WEIGHT_V22"],
      ["V24", "HCC_V24", "RISK_WEIGHT_V24"],
      ["V28", "HCC_V28", "RISK_WEIGHT_V28"],
    ] as const) {
      const category = String(row[hcc] ?? "").trim();
      if (!category) continue;
      const w = String(row[weight] ?? "").trim();
      versions.push(`  ${label}: HCC ${category}${w ? `, weight ${w}` : ""}`);
    }

    return {
      content: [
        `${hit.code}: ${hit.description}`,
        String(row.CONDITION_CATEGORY ?? "").trim() ? `Condition category: ${String(row.CONDITION_CATEGORY)}` : "",
        versions.length > 0 ? "Risk-adjustment models:" : "Mapped to no HCC in any model version present.",
        ...versions,
        // Named because the number changes materially between them, and quoting
        // one without saying which is how a gap analysis gets built on the wrong
        // model year.
        versions.length > 1 ? "\nThe weight differs by model version. Which one applies depends on the plan's payment year — this database does not say, and neither does Orion." : "",
        `\nSource: ${hit.table} in ${catalogue.path}.`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});

// ── What the attached database can answer ────────────────────────────────────

export const referenceRolesTool = defineTool({
  name: "reference_roles",
  description:
    "Report which code sets the attached reference database can answer — CARC, RARC, HCPCS, CPT, NDC, LOINC, ICD-10-PCS, modifiers, HCC, EOB crosswalk and more — with the table and row count behind each, and which are present but held back. Call this before saying the system cannot look a code set up.",
  schema: z.object({}),
  execute: async (_input, ctx) => {
    const cfg = cfgOf(ctx.services);
    const catalogue = catalogueFor(cfg);
    if ("error" in catalogue) return { content: catalogue.error };
    return { content: `${catalogue.path}\n\n${renderRoles(roleStatuses(catalogue, licensed(cfg)))}` };
  },
});

export const REFERENCE_LOOKUP_TOOLS = [
  ndcLookupTool,
  loincLookupTool,
  icd10PcsLookupTool,
  modifierLookupTool,
  drgLookupTool,
  taxonomyLookupTool,
  eobCrosswalkTool,
  hccLookupTool,
  referenceRolesTool,
];
