import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configDir } from "../../config/config.js";
import { defineTool } from "../registry.js";
import type { ScrubFinding } from "./claim-scrub.js";

// Local dataset directory: ~/.aetheraclaw/data — populated by the user or the
// (future) data-updates fetcher. Files are optional; tools degrade gracefully.
//   ncci-ptp.json   [{ column1, column2, modifierAllowed }]
//   mue.json        { "CODE": maxUnits }
//   hcpcs.json      { "CODE": "description" }
//   mpfs.json       { "CODE": { work, pe, mp } }  (RVUs)
//   cpt.csv         user-licensed CPT: CODE,DESCRIPTION[,FEE]

function dataDir(): string {
  return path.join(configDir(), "data");
}

function loadJson<T>(name: string): T | null {
  const p = path.join(dataDir(), name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

let ncciCache: Array<{ column1: string; column2: string; modifierAllowed: boolean }> | null | undefined;
let mueCache: Record<string, number> | null | undefined;

export function checkNcci(
  procs: string[],
  lines: Array<{ cpt_hcpcs: string; units: number; modifiers?: string[] }>,
): ScrubFinding[] {
  const findings: ScrubFinding[] = [];
  if (ncciCache === undefined) ncciCache = loadJson("ncci-ptp.json");
  if (mueCache === undefined) mueCache = loadJson("mue.json");

  if (ncciCache) {
    for (const edit of ncciCache) {
      if (procs.includes(edit.column1) && procs.includes(edit.column2)) {
        const line2 = lines.find((l) => l.cpt_hcpcs === edit.column2);
        const hasBypassModifier = (line2?.modifiers ?? []).some((m) => ["59", "XE", "XP", "XS", "XU"].includes(m));
        if (!hasBypassModifier) {
          findings.push({
            severity: "error",
            rule: "ncci-ptp",
            message: `NCCI PTP edit: ${edit.column2} is bundled into ${edit.column1}${edit.modifierAllowed ? " — a distinct-service modifier (59/X{EPSU}) may be appropriate if documentation supports it" : " — modifier bypass NOT allowed"}`,
          });
        }
      }
    }
  }
  if (mueCache) {
    for (const line of lines) {
      const max = mueCache[line.cpt_hcpcs];
      if (max !== undefined && line.units > max) {
        findings.push({
          severity: "error",
          rule: "mue",
          message: `MUE: ${line.cpt_hcpcs} billed with ${line.units} units; Medicare MUE limit is ${max}`,
        });
      }
    }
  }
  if (!ncciCache && !mueCache) {
    findings.push({
      severity: "info",
      rule: "ncci-data",
      message: `NCCI/MUE data not installed — drop ncci-ptp.json / mue.json (from public CMS files) into ${dataDir()} for bundling & unit edits`,
    });
  }
  return findings;
}

export const hcpcsLookupTool = defineTool({
  name: "hcpcs_lookup",
  description:
    "Look up a HCPCS Level II code description from locally installed public CMS data. CPT (Level I) is AMA-licensed and only available if the user configured their own licensed CPT file.",
  schema: z.object({ code: z.string().describe("HCPCS/CPT code, e.g. E0601 or 99213") }),
  execute: async (input, ctx) => {
    const code = input.code.trim().toUpperCase();
    const hcpcs = loadJson<Record<string, string>>("hcpcs.json");
    if (hcpcs?.[code]) return { content: `${code}: ${hcpcs[code]}` };
    // User-supplied CPT CSV
    const cfg = ctx.services.config as { healthcare?: { cptDataPath?: string } } | undefined;
    const cptPath = cfg?.healthcare?.cptDataPath;
    if (cptPath && fs.existsSync(cptPath)) {
      const line = fs
        .readFileSync(cptPath, "utf8")
        .split(/\r?\n/)
        .find((l) => l.startsWith(code + ","));
      if (line) return { content: `${code}: ${line.split(",").slice(1).join(",")}` };
    }
    return {
      content: `${code} not found in local data. HCPCS Level II: install hcpcs.json in ${dataDir()}. CPT codes require a user-supplied licensed file (healthcare.cptDataPath in config).`,
    };
  },
});

const MEDICARE_CF_2025 = 32.35; // conversion factor — override via mpfs-cf.json

export const reimbursementEstimateTool = defineTool({
  name: "reimbursement_estimate",
  description:
    "Estimate the Medicare allowed amount for a procedure code from locally installed MPFS RVU data (work + PE + MP RVUs × conversion factor). Use to spot underpayments vs actual 835 payments.",
  schema: z.object({
    code: z.string(),
    units: z.number().int().min(1).default(1),
  }),
  execute: async (input) => {
    const mpfs = loadJson<Record<string, { work: number; pe: number; mp: number }>>("mpfs.json");
    if (!mpfs) {
      return {
        content: `MPFS RVU data not installed — drop mpfs.json ({"CODE":{work,pe,mp}}) from the public CMS PFS relative value files into ${dataDir()}`,
      };
    }
    const row = mpfs[input.code.trim().toUpperCase()];
    if (!row) return { content: `No RVU data for ${input.code}` };
    const cf = loadJson<{ cf: number }>("mpfs-cf.json")?.cf ?? MEDICARE_CF_2025;
    const totalRvu = row.work + row.pe + row.mp;
    const allowed = totalRvu * cf * input.units;
    return {
      content: `${input.code}: work ${row.work} + PE ${row.pe} + MP ${row.mp} = ${totalRvu.toFixed(2)} RVU × CF $${cf} × ${input.units} unit(s) = expected allowed $${allowed.toFixed(2)} (national, non-geographically-adjusted)`,
    };
  },
});
