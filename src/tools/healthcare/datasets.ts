import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configDir } from "../../config/config.js";
import { defineTool } from "../registry.js";
import type { ScrubFinding } from "./finding.js";
import { checkMueEdits, checkPtpEdits, indexPtpEdits, type MueTable, type PtpEdit, type PtpIndex, type PtpTable } from "./intelligence/ncci.js";
import type { Icd10Table } from "./icd10-local.js";
import { managedReferencePath, type ReferenceDbConfig } from "./reference-db.js";
import { lookupRole } from "./reference-routes.js";

// Local dataset directory: ~/.orion/data — populated by the user or the
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
let icd10Cache: Stamped<Icd10Table> | null = null;

/** The local ICD-10-CM code set, or null when it is not installed. */
export function icd10Table(): Icd10Table | null {
  const stamp = fileStamp("icd10.json");
  if (!icd10Cache || icd10Cache.stamp !== stamp) {
    const raw = loadJson<Icd10Table>("icd10.json");
    // A file that parses but has no codes is worse than none: it would answer
    // "not a valid code" for every lookup, offline and confidently.
    icd10Cache = { stamp, value: raw && raw.billable && Object.keys(raw.billable).length > 0 ? raw : null };
  }
  return icd10Cache.value;
}

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
  const hasPtp = Boolean(ncciIndex());
  const hasMue = Boolean(mueTable());
  if (hasPtp && hasMue) return null;
  // Granular, not all-or-nothing. checkNcci runs the two families
  // independently, so with only ncci-ptp.json installed the unit edits were
  // silently skipped while the notice — suppressed because PTP WAS present —
  // said nothing, and a unit overage scrubbed to a clean PASS. Name exactly what
  // could not be checked.
  const missing: string[] = [];
  if (!hasPtp) missing.push("ncci-ptp.json (procedure-to-procedure bundling)");
  if (!hasMue) missing.push("mue.json (medically-unlikely unit edits)");
  return {
    severity: "info",
    rule: "ncci-data",
    message: `Not installed: ${missing.join(" and ")} — drop the public CMS file(s) into ${dataDir()}. What is missing was NOT checked here; a clean result for it means "not checked", not "no edit".`,
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
  /** Edition or similar, when the file states one. A code set with no named year is a code set nobody can date. */
  detail?: string;
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
    file: "icd10.json",
    purpose: "ICD-10-CM diagnosis codes with billable status (the full code set)",
    source: "CMS ICD-10-CM 'Code Descriptions in Tabular Order' (annual, public, NOT AMA-licensed) — cms.gov/medicare/coding-billing/icd-10-codes",
    absentMeans: "icd10_search and icd10_validate fall back to the NLM Clinical Tables API, which needs a network connection and does not name its edition.",
  },
  {
    file: "gpci.json",
    purpose: "Geographic Practice Cost Indices by locality",
    source: "CMS PFS Addendum E (annual, public)",
    absentMeans: "Estimates cannot be localized. A national figure is not a locality figure.",
  },
];

export function datasetStatuses(): DatasetStatus[] {
  return DATASETS.map((d) => {
    const installed = fs.existsSync(path.join(dataDir(), d.file));
    // ICD-10-CM changes every 1 October, so "installed" is not the whole answer:
    // a FY2025 table answers every question confidently and out of last year's
    // book. The edition is stated wherever the dataset is.
    if (d.file === "icd10.json" && installed) {
      const fy = icd10Table()?.fy;
      return { ...d, installed, detail: fy ? `FY${fy}` : "unreadable — reinstall it" };
    }
    return { ...d, installed };
  });
}

export function renderDatasetStatus(statuses: DatasetStatus[], cptConfigured: boolean, referenceDb?: string): string {
  const missing = statuses.filter((s) => !s.installed);
  const lines = [
    `Local dataset directory: ${dataDir()}`,
    "",
    ...statuses.map((s) => `${s.installed ? "installed" : "MISSING "}  ${s.file.padEnd(14)} ${s.purpose}${s.detail ? `  [${s.detail}]` : ""}`),
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
      "None of these are bundled with Orion. The CMS files are public but versioned quarterly or annually, and CPT cannot be redistributed at all, so installation is a deliberate step the practice takes with the release it is billing under.",
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
    // Resolve the reference DB the way the lookup tools do: an explicit
    // referenceDbPath, else the managed copy `reference install` writes. Reporting
    // only the explicit path told the operator to attach a database that was
    // already installed and answering — the tool's whole point is to say what
    // this installation can actually read.
    const explicitRef = cfg?.healthcare?.referenceDbPath;
    const managed = managedReferencePath();
    const refPath =
      explicitRef && fs.existsSync(explicitRef) ? explicitRef : fs.existsSync(managed) ? managed : undefined;
    return {
      content: renderDatasetStatus(datasetStatuses(), Boolean(cptPath && fs.existsSync(cptPath)), refPath),
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
    const cfg = (ctx.services.config as { healthcare?: ReferenceDbConfig & { cptDataPath?: string } } | undefined)?.healthcare ?? {};
    const licensedRoles = cfg.referenceDbLicensedRoles ?? [];

    // ── Fullest description wins, not first source ───────────────────────────
    // "Compiled data wins" is right where the compiled data is better and wrong
    // here. hcpcs.json comes from the RVU file's description column, which is a
    // TRUNCATED ABBREVIATION: J1885 reads "Ketorolac tromethamine inj" there and
    // "Injection, ketorolac tromethamine, per 15 mg" in a real HCPCS table. The
    // second is the code's actual descriptor, and a coder checking a unit
    // definition needs the "per 15 mg".
    //
    // So candidates are gathered from every source and the LONGEST is led with.
    // Others are named when they differ, because a descriptor that disagrees
    // between two sources is worth seeing rather than silently resolving.
    const candidates: Array<{ description: string; source: string }> = [];
    const hcpcs = loadJson<Record<string, string>>("hcpcs.json");
    if (hcpcs?.[code]) candidates.push({ description: hcpcs[code], source: "hcpcs.json (CMS RVU file — descriptions there are abbreviated)" });

    for (const role of ["hcpcs", "cpt"] as const) {
      const hit = lookupRole(cfg, role, code, { licensedRoles });
      if (hit) {
        candidates.push({
          description: hit.description,
          source: `${hit.table} in the attached reference database` + (role === "cpt" ? " (CPT, copyright the AMA — read because healthcare.referenceDbLicensedRoles names \"cpt\")" : ""),
        });
      }
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.description.length - a.description.length);
      const [best, ...rest] = candidates;
      const differing = rest.filter((c) => c.description.trim().toLowerCase() !== best.description.trim().toLowerCase());
      return {
        content: [
          `${code}: ${best.description}`,
          `Source: ${best.source}.`,
          ...(differing.length > 0
            ? ["", "Also described as:", ...differing.map((c) => `  "${c.description}"  — ${c.source}`)]
            : []),
        ].join("\n"),
      };
    }

    // User-supplied CPT CSV
    const cptPath = cfg.cptDataPath;
    if (cptPath && fs.existsSync(cptPath)) {
      const line = fs
        .readFileSync(cptPath, "utf8")
        .split(/\r?\n/)
        .find((l) => l.startsWith(code + ","));
      if (line) return { content: `${code}: ${line.split(",").slice(1).join(",")}\nSource: ${cptPath}.` };
    }
    return {
      content: `${code} not found in local data. HCPCS Level II: install hcpcs.json in ${dataDir()}, or attach a reference database carrying a full Level II table via healthcare.referenceDbPath. CPT descriptors need either a licensed file (healthcare.cptDataPath) or a reference database with "cpt" named in healthcare.referenceDbLicensedRoles. This is a miss in the sources present, not proof the code does not exist.`,
    };
  },
});

// ── Probing the files for the lifecycle check ────────────────────────────────
// The I/O half of src/tools/healthcare/data-lifecycle.ts, kept here because this
// is the module that already knows where the files live. Everything that makes a
// JUDGEMENT about the result is over there, pure and clock-injected.

/** When a dataset file landed on disk, as YYYYMMDD. Empty when it is absent. */
export function datasetInstalledOn(file: string): string {
  try {
    const s = fs.statSync(path.join(dataDir(), file));
    return new Date(s.mtimeMs).toISOString().slice(0, 10).replace(/-/g, "");
  } catch {
    return "";
  }
}

/**
 * The edition a file declares, as the YYYYMMDD its release took effect.
 *
 * Only ICD-10-CM declares one today — every other CMS file we read is a bare
 * table with no version field. That is a property of the source data, not an
 * omission here, and it is exactly why the lifecycle check treats "no stamp" as
 * unknown rather than as current.
 */
export function datasetDeclaredEffective(file: string): string {
  if (file !== "icd10.json") return "";
  const fy = icd10Table()?.fy;
  // FY2026 runs from 1 October 2025.
  return fy ? `${fy - 1}1001` : "";
}

export function datasetProbes(): Array<{ status: DatasetStatus; installedOn: string; declaredEffective: string }> {
  return datasetStatuses().map((status) => ({
    status,
    installedOn: datasetInstalledOn(status.file),
    declaredEffective: status.installed ? datasetDeclaredEffective(status.file) : "",
  }));
}
