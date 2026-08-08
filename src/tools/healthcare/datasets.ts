import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configDir } from "../../config/config.js";
import { defineTool } from "../registry.js";
import type { ScrubFinding } from "./finding.js";
import { checkMueEdits, checkPtpEdits, indexPtpEdits, type MueTable, type PtpEdit, type PtpIndex, type PtpTable } from "./intelligence/ncci.js";

// Local dataset directory: ~/.aetheraclaw/data — populated by the user or the
// (future) data-updates fetcher. Files are optional; tools degrade gracefully.
//   ncci-ptp.json   { "COL1": { "COL2": "0" | "1" | "9" } }  — or the older
//                   [{ column1, column2, modifierIndicator }] array, still read
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

// ── Cache invalidation ───────────────────────────────────────────────────────
// These were cached on first use and never re-checked, which is right until the
// moment somebody installs the data. Then the running process keeps its "absent"
// answer forever and the scrubber prints "NCCI/MUE data not installed — drop
// ncci-ptp.json into <dir>" at a reader who has just done exactly that. It is
// the worst kind of wrong message: specific, actionable, and describing work
// already finished.
//
// Keyed on mtime and size, so installing the data mid-session picks it up, and
// so does a quarterly refresh over a running gateway. The cost is two stat calls
// per scrub against a 20 MB table that takes a second to parse.
interface Stamped<T> {
  stamp: string;
  value: T | null;
}

function fileStamp(name: string): string {
  try {
    const s = fs.statSync(path.join(dataDir(), name));
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "absent";
  }
}

let ncciCache: Stamped<PtpIndex> | null = null;
let mueCache: Stamped<MueTable> | null = null;

function ncciIndex(): PtpIndex | null {
  const stamp = fileStamp("ncci-ptp.json");
  if (!ncciCache || ncciCache.stamp !== stamp) {
    const raw = loadJson<PtpEdit[] | PtpTable>("ncci-ptp.json");
    ncciCache = { stamp, value: raw ? indexPtpEdits(raw) : null };
  }
  return ncciCache.value;
}

function mueTable(): MueTable | null {
  const stamp = fileStamp("mue.json");
  if (!mueCache || mueCache.stamp !== stamp) mueCache = { stamp, value: loadJson<MueTable>("mue.json") };
  return mueCache.value;
}

export function checkNcci(
  _procs: string[],
  lines: Array<{ cpt_hcpcs: string; units: number; modifiers?: string[] }>,
): ScrubFinding[] {
  // Indexed once and reused, but re-read when the file changes — see above.
  const ncci = ncciIndex();
  const mue = mueTable();

  return [
    ...(ncci ? checkPtpEdits(ncci, lines) : []),
    ...(mue ? checkMueEdits(mue, lines) : []),
  ];
}

/**
 * The "NCCI data is not installed" notice, or null when it is.
 *
 * Separated from checkNcci because the scrubber runs the edits once per DISTINCT
 * SERVICE DATE — bundling is a same-day question — and this notice was being
 * appended inside that loop. A claim spanning three dates therefore reported the
 * same missing-data warning three times. It is a fact about the installation,
 * not about a date group, so it belongs at the claim level and is emitted once.
 */
export function ncciDataNotice(): ScrubFinding | null {
  if (ncciIndex() || mueTable()) return null;
  return {
    severity: "info",
    rule: "ncci-data",
    message: `NCCI/MUE data not installed — drop ncci-ptp.json / mue.json (from public CMS files) into ${dataDir()} for bundling & unit edits`,
  };
}

// ── What is actually installed ───────────────────────────────────────────────
// Absent data is not the same as a negative result, and a model with no way to
// tell them apart will conflate them. Observed: asked whether an E/M and an EKG
// bundle, a model reported that NCCI data was not installed and then stated in
// the same answer that "the NCCI tables do not bundle 99214 with 93000" — a
// claim about tables it had just said it could not read.
//
// So the inventory is a tool. "I cannot check this" becomes something the model
// can look up and say, instead of something it has to infer from silence.
export interface DatasetStatus {
  file: string;
  purpose: string;
  installed: boolean;
  /** Where a user gets it. Named exactly, because "download it from CMS" is not an instruction. */
  source: string;
  /** What stops working without it. */
  absentMeans: string;
}

const DATASETS: Array<Omit<DatasetStatus, "installed">> = [
  {
    file: "ncci-ptp.json",
    purpose: "NCCI Procedure-to-Procedure bundling edits",
    source: "CMS National Correct Coding Initiative Edits (quarterly, public) — cms.gov/medicare/coding-billing/ncci-medicare",
    absentMeans: "Bundling cannot be checked at all. Not 'no edit found' — no table was read.",
  },
  {
    file: "mue.json",
    purpose: "Medically Unlikely Edits (per-code unit ceilings)",
    source: "CMS MUE tables (quarterly, public) — same NCCI page",
    absentMeans: "Unit overages cannot be detected.",
  },
  {
    file: "hcpcs.json",
    purpose: "HCPCS Level II code descriptions",
    source: "CMS HCPCS Quarterly Update (public)",
    absentMeans: "hcpcs_lookup returns nothing for Level II codes.",
  },
  {
    file: "mpfs.json",
    purpose: "Medicare Physician Fee Schedule RVUs (work / PE / facility PE / MP)",
    source: "CMS PFS Relative Value Files (annual, public)",
    absentMeans: "reimbursement_estimate cannot compute an allowed amount. It will refuse rather than estimate — do not supply RVUs or a rate from memory.",
  },
  {
    file: "mpfs-cf.json",
    purpose: "MPFS conversion factor",
    source: "CMS PFS Final Rule for the applicable year",
    absentMeans: "No dollar conversion is possible even with RVUs present.",
  },
  {
    file: "gpci.json",
    purpose: "Geographic Practice Cost Indices by locality",
    source: "CMS PFS Addendum E (annual, public)",
    absentMeans: "Estimates cannot be localized. A national figure is not a locality figure.",
  },
];

export function datasetStatuses(): DatasetStatus[] {
  return DATASETS.map((d) => ({ ...d, installed: fs.existsSync(path.join(dataDir(), d.file)) }));
}

export function renderDatasetStatus(statuses: DatasetStatus[], cptConfigured: boolean, referenceDb?: string): string {
  const missing = statuses.filter((s) => !s.installed);
  const lines = [
    `Local dataset directory: ${dataDir()}`,
    "",
    ...statuses.map((s) => `${s.installed ? "installed" : "MISSING "}  ${s.file.padEnd(14)} ${s.purpose}`),
    `${cptConfigured ? "configured" : "not set  "}  CPT (Level I)  AMA-licensed; supply your own file via healthcare.cptDataPath`,
    // The attached reference database belongs in this inventory even though it
    // is not a file in dataDir(): the question this tool answers is "what can
    // this installation actually read", and answering it from one list is the
    // whole point.
    referenceDb
      ? `attached   reference DB   ${referenceDb} — call reference_db_status for its tables; some may be held back`
      : `not set    reference DB   attach your own SQLite reference database via healthcare.referenceDbPath`,
  ];
  if (missing.length > 0) {
    lines.push(
      "",
      "What the missing files mean — these are limits on what can be checked, not findings:",
      ...missing.map((s) => `  ${s.file}: ${s.absentMeans}\n      Source: ${s.source}`),
      "",
      "None of these are bundled with AetheraClaw. The CMS files are public but versioned quarterly or annually, and CPT cannot be redistributed at all, so installation is a deliberate step the practice takes with the release it is billing under.",
    );
  }
  return lines.join("\n");
}

export const dataStatusTool = defineTool({
  name: "data_status",
  description:
    "Report which local reference datasets are installed (NCCI PTP, MUE, HCPCS, MPFS RVUs, conversion factor, GPCI, CPT) and what cannot be checked without each. Call this before stating that a code pair is not bundled, that a unit count is allowed, or what a service pays — if the table is not installed, the honest answer is that it could not be checked, not that no edit exists.",
  schema: z.object({}),
  execute: async (_input, ctx) => {
    const cfg = ctx.services.config as { healthcare?: { cptDataPath?: string; referenceDbPath?: string } } | undefined;
    const cptPath = cfg?.healthcare?.cptDataPath;
    const refPath = cfg?.healthcare?.referenceDbPath;
    return {
      content: renderDatasetStatus(
        datasetStatuses(),
        Boolean(cptPath && fs.existsSync(cptPath)),
        refPath && fs.existsSync(refPath) ? refPath : undefined,
      ),
    };
  },
});

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
