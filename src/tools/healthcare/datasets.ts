import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configDir } from "../../config/config.js";
import { defineTool } from "../registry.js";
import type { ScrubFinding } from "./finding.js";
import { checkMueEdits, checkPtpEdits, type MueTable, type PtpEdit } from "./intelligence/ncci.js";

// Local dataset directory: ~/.aetheraclaw/data — populated by the user or the
// (future) data-updates fetcher. Files are optional; tools degrade gracefully.
//   ncci-ptp.json   [{ column1, column2, modifierIndicator }]  ("0" | "1" | "9")
//   mue.json        { "CODE": maxUnits } or { "CODE": { units, mai } }
//   hcpcs.json      { "CODE": "description" }
//   mpfs.json       { "CODE": { work, pe, facilityPe, mp, ...policy indicators } }
//   mpfs-cf.json    { "cf": 32.35 }        conversion factor
//   gpci.json       { "LOCALITY": { work, pe, mp } }
//   cpt.csv         user-licensed CPT: CODE,DESCRIPTION[,FEE]

export function dataDir(): string {
  return path.join(configDir(), "data");
}

/** Read an optional dataset file. Missing or malformed files degrade to null. */
export function loadDataJson<T>(name: string): T | null {
  return loadJson<T>(name);
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

let ncciCache: PtpEdit[] | null | undefined;
let mueCache: MueTable | null | undefined;

export function checkNcci(
  _procs: string[],
  lines: Array<{ cpt_hcpcs: string; units: number; modifiers?: string[] }>,
): ScrubFinding[] {
  if (ncciCache === undefined) ncciCache = loadJson("ncci-ptp.json");
  if (mueCache === undefined) mueCache = loadJson("mue.json");

  const findings: ScrubFinding[] = [
    ...(ncciCache ? checkPtpEdits(ncciCache, lines) : []),
    ...(mueCache ? checkMueEdits(mueCache, lines) : []),
  ];
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
