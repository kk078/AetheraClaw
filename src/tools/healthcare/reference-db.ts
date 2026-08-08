import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configDir } from "../../config/config.js";
import { openDatabase, type SqliteDb } from "../../memory/sqlite.js";
import { defineTool } from "../registry.js";

// ── User-supplied reference databases ────────────────────────────────────────
// A practice may already own a large code or policy database — the case that
// prompted this was a 1.24 GB SQLite file whose contents the owner could not
// vouch for. That uncertainty is the whole design brief:
//
//   * it is never copied into the repository, never committed, and never
//     converted. It stays where the user put it and is read from there.
//   * it is opened READ-ONLY at the driver, so a bug cannot damage a file the
//     user may not be able to replace.
//   * no table is readable until its column names have been scanned for patient
//     identifiers. A file of unknown provenance may carry PHI, and this
//     deployment is explicitly not built to hold PHI.
//
// The last point is the one worth being stubborn about. The cheap version of
// this feature — open the file, let the model write SQL — reads whatever is in
// there on the first question anybody asks. The gate has to come before the
// first read, not after the first surprise.

// ── Identifier scan ──────────────────────────────────────────────────────────
// Column names, not values. Reading values to decide whether values are safe to
// read is circular, and it is also how you end up with a patient's date of
// birth in a debug log. Names are enough: a table that stores an MRN calls the
// column something recognisable, because somebody had to write queries too.
//
// Deliberately broad. A false positive quarantines a table the user can then
// allow by name in config, which costs one line. A false negative serves PHI to
// a language model, which cannot be undone.
export interface IdentifierPattern {
  pattern: RegExp;
  /** What this looks like, in the report. Written to be read by a person. */
  means: string;
}

export const IDENTIFIER_PATTERNS: IdentifierPattern[] = [
  { pattern: /\bmrn\b|medical_?record/i, means: "medical record number" },
  { pattern: /\bpatient/i, means: "patient-level data" },
  { pattern: /member_?(id|num)|subscriber|\bhicn\b|\bmbi\b/i, means: "health plan member identifier" },
  { pattern: /\bssn\b|social_?security/i, means: "social security number" },
  { pattern: /\bdob\b|birth/i, means: "date of birth" },
  { pattern: /first_?name|last_?name|middle_?name|full_?name|surname/i, means: "person name" },
  { pattern: /address|street|city_?state|\bzip\b|postal/i, means: "address" },
  { pattern: /phone|mobile|telephone|\bfax\b/i, means: "telephone number" },
  { pattern: /e_?mail/i, means: "email address" },
  { pattern: /account_?(no|num|id)|\bguarantor\b/i, means: "patient account number" },
  // No trailing \b — `_` is a word character, so `\bencounter\b` misses
  // `encounter_id`, which is the single likeliest spelling in a real schema.
  // `admission` on its own is left out: a DRG reference table legitimately has
  // an admission_type column and quarantining it would be noise, whereas an
  // admission DATE only exists attached to a person.
  { pattern: /\bencounter|\bvisit_?id|admi(t|ssion)_?date/i, means: "encounter identifier" },
];

/**
 * Columns holding a whole document rather than a field.
 *
 * A GAP THE FIRST VERSION HAD, found by reading a real schema. A table of raw
 * X12 files —
 *
 *   era_835_raw(id, filename, file_content, import_date, parsed, claims_count)
 *
 * — has not one column name that looks like an identifier, so the scan let it
 * straight through. Every one of those `file_content` values is an 835, and an
 * 835 carries patient names inside its NM1 segments. Column names cannot see
 * inside a blob.
 *
 * So a document column in a table that also looks transactional is quarantined
 * on the same footing as an `mrn`. The pairing matters: `rcm_knowledge.content`
 * is 1,800 characters of reference text and must stay readable, and it sits in a
 * table with no filename, no import date and no claim count.
 */
export const DOCUMENT_COLUMNS = /^(file_)?content$|^raw(_|$)|_raw$|^payload$|^body$|^document$|^edi$|^x12$/i;

/** Columns that mark a table as holding transactions rather than reference data. */
const TRANSACTIONAL_COLUMNS = /^file_?name$|^import(ed)?_|_at$|^claims?_count$|^parsed$|^received|^era_id$|^claim_id$/i;

export interface IdentifierHit {
  column: string;
  means: string;
}

/** Columns whose names look like patient identifiers, with what each looks like. */
export function scanForIdentifiers(columns: string[]): IdentifierHit[] {
  const hits: IdentifierHit[] = [];
  for (const column of columns) {
    const match = IDENTIFIER_PATTERNS.find((p) => p.pattern.test(column));
    if (match) hits.push({ column, means: match.means });
  }

  // Only when the table also looks transactional — otherwise every reference
  // table with a `content` column would be held back, which is noise rather
  // than caution.
  const transactional = columns.some((c) => TRANSACTIONAL_COLUMNS.test(c));
  if (transactional) {
    for (const column of columns) {
      if (!DOCUMENT_COLUMNS.test(column)) continue;
      if (hits.some((h) => h.column === column)) continue;
      hits.push({ column, means: "a stored document — a raw claim or remittance can carry patient names inside it, and a column name cannot see in" });
    }
  }
  return hits;
}

// ── Code-set identification ──────────────────────────────────────────────────
// Which published code set a table holds cannot be told from column names —
// `codes(code, description)` describes ICD-10, HCPCS, CPT and a hundred private
// tables equally well. It can be told from the SHAPE of the codes themselves,
// so a sample of the code column is read, and only after the table has cleared
// the identifier scan.
//
// Reported as a resemblance, never as a fact. A five-digit code looks like CPT
// and also looks like a ZIP code, and the difference matters because one of
// those is licensed content.
export type CodeSetKind = "icd10cm" | "icd10pcs" | "hcpcs" | "cpt" | "carc" | "unknown";

const CODE_SHAPES: Array<{ kind: CodeSetKind; pattern: RegExp; label: string }> = [
  { kind: "icd10cm", pattern: /^[A-TV-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/, label: "ICD-10-CM diagnosis" },
  { kind: "icd10pcs", pattern: /^[0-9A-HJ-NP-Z]{7}$/, label: "ICD-10-PCS procedure" },
  { kind: "hcpcs", pattern: /^[A-CEGHJ-MP-V][0-9]{4}$/, label: "HCPCS Level II" },
  { kind: "cpt", pattern: /^[0-9]{4}[0-9FMTU]$/, label: "CPT (Level I)" },
  { kind: "carc", pattern: /^(CO|PR|OA|PI)?[0-9]{1,3}$/, label: "adjustment reason" },
];

/** Fraction of a sample that must share a shape before the table is called that code set. */
export const CODE_SHAPE_THRESHOLD = 0.8;

export interface CodeSetGuess {
  kind: CodeSetKind;
  label: string;
  /** Share of the sample matching, 0–1. Reported so a weak match reads as weak. */
  confidence: number;
}

export function identifyCodeSet(sample: string[]): CodeSetGuess {
  const values = sample.map((s) => String(s ?? "").trim().toUpperCase()).filter(Boolean);
  if (values.length === 0) return { kind: "unknown", label: "unrecognised", confidence: 0 };
  let best: CodeSetGuess = { kind: "unknown", label: "unrecognised", confidence: 0 };
  for (const shape of CODE_SHAPES) {
    const hits = values.filter((v) => shape.pattern.test(v)).length;
    const confidence = hits / values.length;
    if (confidence > best.confidence) best = { kind: shape.kind, label: shape.label, confidence };
  }
  return best.confidence >= CODE_SHAPE_THRESHOLD ? best : { kind: "unknown", label: "unrecognised", confidence: best.confidence };
}

// ── Table classification ─────────────────────────────────────────────────────
const CODE_COLUMN = /^(code|cpt|hcpcs|icd|icd10|icd_?10_?cm|dx|proc(edure)?_?code|code_?value|key)$/i;
const DESC_COLUMN = /^(desc|description|long_?desc(ription)?|short_?desc(ription)?|label|title|name|text|term)$/i;

export type TableAccess = "readable" | "quarantined";

export interface RawTable {
  name: string;
  columns: string[];
  rowCount: number;
}

export interface ReferenceTable extends RawTable {
  access: TableAccess;
  /** Non-empty exactly when access is "quarantined". */
  identifiers: IdentifierHit[];
  /** Set when the user allowed this table by name despite a scan hit. */
  allowedByUser?: boolean;
  codeColumn?: string;
  descriptionColumn?: string;
  /** Only populated for readable tables with a code column — needs a value sample. */
  codeSet?: CodeSetGuess;
}

/**
 * Decide whether a table may be read, and what it looks like.
 *
 * `allowTables` is an explicit per-table override. There is deliberately no
 * global "allow everything" switch: the point of the gate is that somebody
 * looked at a named table and decided, and a blanket flag is the same as no
 * gate at all while feeling like a decision.
 */
export function classifyTable(raw: RawTable, allowTables: string[] = []): ReferenceTable {
  const identifiers = scanForIdentifiers(raw.columns);
  const allowed = allowTables.some((t) => t.toLowerCase() === raw.name.toLowerCase());
  const codeColumn = raw.columns.find((c) => CODE_COLUMN.test(c));
  const descriptionColumn = raw.columns.find((c) => DESC_COLUMN.test(c));
  if (identifiers.length > 0 && !allowed) {
    return { ...raw, access: "quarantined", identifiers };
  }
  return {
    ...raw,
    access: "readable",
    identifiers,
    ...(identifiers.length > 0 ? { allowedByUser: true } : {}),
    ...(codeColumn ? { codeColumn } : {}),
    ...(descriptionColumn ? { descriptionColumn } : {}),
  };
}

export interface ReferenceCatalogue {
  path: string;
  driver: string;
  sizeBytes: number;
  tables: ReferenceTable[];
}

export function findTable(catalogue: ReferenceCatalogue, name: string): ReferenceTable | undefined {
  return catalogue.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
}

function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e3).toFixed(0)} kB`;
}

export function describeCatalogue(catalogue: ReferenceCatalogue): string {
  const readable = catalogue.tables.filter((t) => t.access === "readable");
  const held = catalogue.tables.filter((t) => t.access === "quarantined");
  const lines = [
    `Reference database: ${catalogue.path}`,
    `${bytes(catalogue.sizeBytes)}, opened read-only via ${catalogue.driver}, ${catalogue.tables.length} tables.`,
    "",
    "Readable:",
  ];
  if (readable.length === 0) lines.push("  (none)");
  for (const t of readable) {
    const set = t.codeSet && t.codeSet.kind !== "unknown" ? `  — looks like ${t.codeSet.label} (${Math.round(t.codeSet.confidence * 100)}% of sample)` : "";
    lines.push(`  ${t.name}  ${t.rowCount.toLocaleString()} row${t.rowCount === 1 ? "" : "s"}  [${t.columns.join(", ")}]${set}`);
    if (t.allowedByUser) {
      lines.push(`      allowed by name in config despite: ${t.identifiers.map((h) => `${h.column} (${h.means})`).join(", ")}`);
    }
  }
  if (held.length > 0) {
    lines.push(
      "",
      "Held back — these columns look like patient identifiers, and this deployment is not built to hold PHI:",
      ...held.map((t) => `  ${t.name}  ${t.rowCount.toLocaleString()} row${t.rowCount === 1 ? "" : "s"} — ${t.identifiers.map((h) => `${h.column} (${h.means})`).join(", ")}`),
      "",
      "No tool will read these. If a table is a false positive, name it in healthcare.referenceDbAllowTables — one table at a time, deliberately.",
    );
  }
  const cpt = readable.filter((t) => t.codeSet?.kind === "cpt");
  if (cpt.length > 0) {
    lines.push(
      "",
      `Licence note: ${cpt.map((t) => t.name).join(", ")} contains codes shaped like CPT. CPT descriptors are AMA-licensed. Whether this file may be used is the practice's licence question, not something AetheraClaw can answer — say so rather than assuming it is cleared.`,
    );
  }
  return lines.join("\n");
}

// ── I/O ──────────────────────────────────────────────────────────────────────
// Everything above is pure and tested against fixtures. Everything below opens
// files and formats strings.

export interface ReferenceDbConfig {
  referenceDbPath?: string;
  referenceDbAllowTables?: string[];
  referenceDbLicensedRoles?: string[];
}

/** Sample size for code-shape identification. Enough to be sure, small enough to be instant. */
const SAMPLE_ROWS = 200;

export function readCatalogue(file: string, allowTables: string[] = []): ReferenceCatalogue {
  const db = openDatabase(file, { readonly: true });
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    const tables: ReferenceTable[] = [];
    for (const name of names) {
      const columns = (db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all() as Array<{ name: string }>).map((c) => c.name);
      const rowCount = Number((db.prepare(`SELECT COUNT(*) AS c FROM "${name.replace(/"/g, '""')}"`).get() as { c: number | bigint }).c);
      const table = classifyTable({ name, columns, rowCount }, allowTables);
      if (table.access === "readable" && table.codeColumn) {
        const sample = db
          .prepare(`SELECT "${table.codeColumn.replace(/"/g, '""')}" AS v FROM "${name.replace(/"/g, '""')}" LIMIT ${SAMPLE_ROWS}`)
          .all() as Array<{ v: unknown }>;
        table.codeSet = identifyCodeSet(sample.map((r) => String(r.v ?? "")));
      }
      tables.push(table);
    }
    return { path: file, driver: db.driver, sizeBytes: fs.statSync(file).size, tables };
  } finally {
    db.close();
  }
}

// Stamped cache, same shape as the dataset caches in datasets.ts and for the
// same reason: introspecting a large file on every call is waste, and caching
// it forever means a file swapped mid-session is described wrongly until
// restart.
let catalogueCache: { stamp: string; value: ReferenceCatalogue } | null = null;

function stampOf(file: string): string {
  const s = fs.statSync(file);
  return `${file}:${s.mtimeMs}:${s.size}`;
}

export function catalogueFor(cfg: ReferenceDbConfig): ReferenceCatalogue | { error: string } {
  // An explicit path wins; otherwise the managed copy, if one was installed.
  // Resolved through a seam so this module does not import the store and the
  // store does not import this one.
  const file = cfg.referenceDbPath ?? resolveManaged();
  if (!file) {
    return {
      error:
        "No reference database is attached. Either set healthcare.referenceDbPath to read a SQLite file in place, or take a copy into the installation with `aetheraclaw reference install <file>` — the second survives somebody emptying their Downloads folder.",
    };
  }
  if (!fs.existsSync(file)) {
    // Deliberately NOT a silent fallback to the managed copy. An explicit path
    // is somebody saying where the data is, and quietly answering from a
    // different file is how a lookup returns the wrong edition without anyone
    // noticing. But failing while a perfectly good installed copy sits three
    // directories away, and not mentioning it, is a message that wastes an
    // afternoon — this is exactly what happens after `reference install` when
    // the old path is left in config and the original is deleted.
    const managed = resolveManaged();
    return {
      error:
        `Reference database configured but not found at ${file}.` +
        (managed && managed !== file
          ? ` A managed copy IS installed at ${managed}. Remove healthcare.referenceDbPath from your config to use it — it is not substituted automatically, because an explicit path is a choice and answering from a different file would be a different answer.`
          : ""),
    };
  }
  let stamp: string;
  try {
    stamp = stampOf(file);
  } catch (err) {
    return { error: `Reference database at ${file} could not be read: ${(err as Error).message}` };
  }
  if (!catalogueCache || catalogueCache.stamp !== stamp) {
    try {
      catalogueCache = { stamp, value: readCatalogue(file, cfg.referenceDbAllowTables ?? []) };
    } catch (err) {
      return { error: `Reference database at ${file} could not be opened as SQLite: ${(err as Error).message}` };
    }
  }
  return catalogueCache.value;
}

/** Test seam — the cache is process-wide and fixtures reuse temp paths. */
export function resetCatalogueCache(): void {
  catalogueCache = null;
}

/**
 * Where `aetheraclaw reference install` puts a managed copy.
 *
 * Defined HERE rather than in reference-store.ts, which owns installing it. The
 * first version had the store register a resolver back into this module, which
 * only worked if something imported the store — a side-effect import nobody
 * would think to keep, and the failure mode was a managed database silently not
 * being found. Two lines of path arithmetic are not worth a registration.
 */
export function managedReferencePath(): string {
  return path.join(configDir(), "reference", "reference.db");
}

function resolveManaged(): string | null {
  const managed = managedReferencePath();
  return fs.existsSync(managed) ? managed : null;
}

function referenceConfig(services: { config?: unknown }): ReferenceDbConfig {
  const cfg = services.config as { healthcare?: ReferenceDbConfig } | undefined;
  return cfg?.healthcare ?? {};
}

export const referenceDbStatusTool = defineTool({
  name: "reference_db_status",
  description:
    "Report what is inside the user's attached reference database (healthcare.referenceDbPath): every table, its row count and columns, which published code set each looks like, and which tables are held back because their columns look like patient identifiers. Call this before claiming the system does or does not hold a given code set — a table that is held back is not a table that is absent, and the difference matters.",
  schema: z.object({}),
  execute: async (_input, ctx) => {
    const catalogue = catalogueFor(referenceConfig(ctx.services));
    if ("error" in catalogue) return { content: catalogue.error };
    return { content: describeCatalogue(catalogue) };
  },
});

export const MAX_LOOKUP_ROWS = 50;

export function renderLookup(table: ReferenceTable, rows: Array<Record<string, unknown>>, path: string): string {
  if (rows.length === 0) return `No match in ${table.name} (${path}).`;
  const head = [`${rows.length} row${rows.length === 1 ? "" : "s"} from ${table.name} in ${path}:`];
  for (const row of rows) {
    const code = table.codeColumn ? row[table.codeColumn] : undefined;
    const desc = table.descriptionColumn ? row[table.descriptionColumn] : undefined;
    head.push(code !== undefined && desc !== undefined ? `  ${String(code)}: ${String(desc)}` : `  ${JSON.stringify(row)}`);
  }
  return head.join("\n");
}

export const referenceLookupTool = defineTool({
  name: "reference_lookup",
  description:
    "Look a code or phrase up in a table of the user's attached reference database. The table must be one reference_db_status lists as readable — held-back tables cannot be queried through this tool. Results always name the file and table they came from, because a description served from a private database is not the same claim as one from a published CMS file.",
  schema: z.object({
    table: z.string().describe("Table name, exactly as reference_db_status reports it"),
    code: z.string().optional().describe("Exact code to look up, or a prefix when prefix is true"),
    text: z.string().optional().describe("Substring to search for in the description column"),
    prefix: z.boolean().optional().describe("Treat `code` as a prefix rather than an exact match"),
    limit: z.number().int().positive().max(MAX_LOOKUP_ROWS).optional(),
  }),
  execute: async (input, ctx) => {
    const cfg = referenceConfig(ctx.services);
    const catalogue = catalogueFor(cfg);
    if ("error" in catalogue) return { content: catalogue.error };

    const table = findTable(catalogue, input.table);
    if (!table) {
      return { content: `No table named "${input.table}" in ${catalogue.path}. Tables: ${catalogue.tables.map((t) => t.name).join(", ")}` };
    }
    if (table.access === "quarantined") {
      return {
        content: `${table.name} is held back: ${table.identifiers.map((h) => `${h.column} looks like ${h.means}`).join(", ")}. This deployment is not built to hold PHI, so the table is not readable. If that is a false positive, add "${table.name}" to healthcare.referenceDbAllowTables.`,
      };
    }
    if (!input.code && !input.text) return { content: "Give either `code` or `text` to search for." };
    if (input.code && !table.codeColumn) return { content: `${table.name} has no column that looks like a code column. Columns: ${table.columns.join(", ")}` };
    if (input.text && !table.descriptionColumn) return { content: `${table.name} has no column that looks like a description column. Columns: ${table.columns.join(", ")}` };

    // The table and column names come from sqlite_master and were matched
    // against the catalogue above, so they are known-good identifiers rather
    // than model input; the values are bound. The model never supplies SQL.
    const quoted = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.code) {
      where.push(input.prefix ? `${quoted(table.codeColumn!)} LIKE ?` : `UPPER(${quoted(table.codeColumn!)}) = ?`);
      params.push(input.prefix ? `${input.code}%` : input.code.trim().toUpperCase());
    }
    if (input.text) {
      where.push(`${quoted(table.descriptionColumn!)} LIKE ?`);
      params.push(`%${input.text}%`);
    }
    const limit = Math.min(input.limit ?? 20, MAX_LOOKUP_ROWS);

    const db = openDatabase(catalogue.path, { readonly: true });
    try {
      const rows = db.prepare(`SELECT * FROM ${quoted(table.name)} WHERE ${where.join(" AND ")} LIMIT ${limit}`).all(...params) as Array<Record<string, unknown>>;
      return { content: renderLookup(table, rows, catalogue.path) };
    } finally {
      db.close();
    }
  },
});

export const REFERENCE_DB_TOOLS = [referenceDbStatusTool, referenceLookupTool];
