import { openDatabase } from "../../memory/sqlite.js";
import { catalogueFor, findTable, type ReferenceCatalogue, type ReferenceDbConfig } from "./reference-db.js";

// ── Routing an attached database into the domain tools ───────────────────────
// reference_lookup can query any cleared table generically. That is the right
// floor and the wrong ceiling: nobody asking "what does CARC 253 mean" should
// have to know that the answer lives in a table called ref_carc.
//
// So known table names are mapped to ROLES, and the domain tools consult the
// role rather than the file. Three properties hold this together:
//
//   Compiled tables win on QUALITY, not on precedence. Where the local CMS
//   install is better — ICD-10-CM, where ours carries CMS's own billable flag
//   and the attached copy has that column NULL — the attached one is not
//   consulted at all. A larger row count is not a better answer.
//
//   Every answer names the table it came from. A descriptor served out of a
//   private database is a different claim from one served by a published CMS
//   file, and the reader is the one who has to know which.
//
//   Nothing bypasses the quarantine. Roles resolve through the same catalogue,
//   so a table the identifier scan held back stays unreadable however it is
//   reached.

export type ReferenceRole =
  | "carc"
  | "rarc"
  | "hcpcs"
  | "cpt"
  | "modifier"
  | "ndc"
  | "loinc"
  | "icd10pcs"
  | "icd9cm"
  | "hcc"
  | "eob"
  | "mac"
  | "taxonomy"
  | "drg"
  | "revenue"
  | "payer_timely";

export interface RouteSpec {
  role: ReferenceRole;
  /** What the role answers, in one line, for the status report. */
  purpose: string;
  /** Candidate tables in preference order. First one present and readable wins. */
  tables: string[];
  codeColumn: string;
  /** Tried in order; the first non-empty value is the description. */
  descriptionColumns: string[];
  /** True when reading this role is the user's licence question rather than ours. */
  licensed?: boolean;
}

/**
 * Table names are matched literally.
 *
 * Deliberately not fuzzy. Guessing that a table called `codes` is CARC because
 * it has three-digit codes would serve remark codes as adjustment reasons, and
 * the two read identically on a denial screen.
 */
export const ROUTES: RouteSpec[] = [
  {
    role: "carc",
    purpose: "Claim adjustment reason codes",
    tables: ["ref_carc"],
    codeColumn: "code",
    descriptionColumns: ["description"],
  },
  {
    role: "rarc",
    purpose: "Remittance advice remark codes",
    tables: ["ref_rarc"],
    codeColumn: "code",
    descriptionColumns: ["description"],
  },
  {
    role: "hcpcs",
    purpose: "HCPCS Level II codes, including the unpriced ones the RVU file omits",
    tables: ["ref_hcpcs"],
    codeColumn: "code",
    descriptionColumns: ["long_desc", "short_desc", "description"],
  },
  {
    role: "cpt",
    purpose: "CPT Level I descriptors",
    tables: ["ref_cpt"],
    codeColumn: "code",
    descriptionColumns: ["long_desc", "short_desc", "description"],
    // AMA-licensed. Read only where the practice has confirmed a licence covers
    // it — which is a fact about the practice, not about the file.
    licensed: true,
  },
  {
    role: "modifier",
    purpose: "CPT/HCPCS modifiers",
    tables: ["ref_modifier"],
    codeColumn: "code",
    descriptionColumns: ["description"],
  },
  {
    role: "ndc",
    purpose: "National Drug Codes",
    tables: ["ref_ndc"],
    codeColumn: "ndc",
    descriptionColumns: ["proprietary_name", "nonproprietary_name"],
  },
  {
    role: "loinc",
    purpose: "LOINC laboratory and clinical observation codes",
    tables: ["ref_loinc"],
    codeColumn: "code",
    descriptionColumns: ["name", "short_name", "component"],
  },
  {
    role: "icd10pcs",
    purpose: "ICD-10-PCS inpatient procedure codes",
    tables: ["ref_icd10pcs"],
    codeColumn: "code",
    descriptionColumns: ["description"],
  },
  {
    role: "icd9cm",
    purpose: "ICD-9-CM diagnosis codes, for claims predating the transition",
    tables: ["ref_icd9cm"],
    codeColumn: "code",
    descriptionColumns: ["long_desc", "short_desc"],
  },
  {
    role: "hcc",
    purpose: "ICD-10 to HCC risk-adjustment mapping",
    tables: ["ref_hcc_mapping"],
    codeColumn: "ICD_CODE",
    descriptionColumns: ["LONG_TITLE"],
  },
  {
    role: "eob",
    purpose: "Payer EOB codes crosswalked to CARC/RARC",
    tables: ["ref_eob_crosswalk"],
    codeColumn: "eob_code",
    descriptionColumns: ["eob_desc"],
  },
  {
    role: "mac",
    purpose: "Medicare Administrative Contractors by jurisdiction and state",
    tables: ["ref_mac"],
    codeColumn: "code",
    descriptionColumns: ["name"],
  },
  {
    role: "taxonomy",
    purpose: "Provider taxonomy codes",
    tables: ["ref_taxonomy"],
    codeColumn: "code",
    descriptionColumns: ["display_name", "classification"],
  },
  {
    role: "drg",
    purpose: "MS-DRG codes and weights",
    tables: ["ref_drg"],
    codeColumn: "code",
    descriptionColumns: ["description"],
  },
  {
    role: "revenue",
    purpose: "Revenue codes (institutional billing)",
    tables: ["ref_revenue"],
    codeColumn: "code",
    descriptionColumns: ["description"],
  },
  {
    role: "payer_timely",
    purpose: "Published payer filing and appeal deadlines",
    tables: ["ref_payer_timely"],
    codeColumn: "payer_name",
    descriptionColumns: ["filing_deadline_text"],
  },
];

export function routeFor(role: ReferenceRole): RouteSpec | undefined {
  return ROUTES.find((r) => r.role === role);
}

export interface ResolvedRoute {
  spec: RouteSpec;
  table: string;
  /** Description columns the table actually has, in preference order. */
  columns: string[];
  rowCount: number;
}

/**
 * Which table serves a role in this catalogue, if any.
 *
 * Returns undefined when the table is absent, quarantined, or missing the
 * columns the role needs — three different reasons that all mean "cannot
 * answer", and none of which should produce a partial answer.
 */
export function resolveRoute(catalogue: ReferenceCatalogue, role: ReferenceRole): ResolvedRoute | undefined {
  const spec = routeFor(role);
  if (!spec) return undefined;
  for (const name of spec.tables) {
    const table = findTable(catalogue, name);
    if (!table || table.access !== "readable") continue;
    const has = (c: string) => table.columns.some((x) => x.toLowerCase() === c.toLowerCase());
    if (!has(spec.codeColumn)) continue;
    const columns = spec.descriptionColumns.filter(has);
    if (columns.length === 0) continue;
    return { spec, table: table.name, columns, rowCount: table.rowCount };
  }
  return undefined;
}

export interface RoleHit {
  code: string;
  description: string;
  role: ReferenceRole;
  table: string;
  /** Every column of the matching row, for callers that need more than a description. */
  row: Record<string, unknown>;
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Look a code up under a role.
 *
 * `licensedRoles` is the caller's explicit list of licensed content it is
 * allowed to read. A role marked `licensed` returns nothing unless it is named
 * there — there is no default-on path, because the default cannot be a decision
 * about somebody else's licence.
 */
export function lookupRole(
  cfg: ReferenceDbConfig,
  role: ReferenceRole,
  code: string,
  opts: { licensedRoles?: string[] } = {},
): RoleHit | null {
  const catalogue = catalogueFor(cfg);
  if ("error" in catalogue) return null;
  const resolved = resolveRoute(catalogue, role);
  if (!resolved) return null;
  if (resolved.spec.licensed && !(opts.licensedRoles ?? []).includes(role)) return null;

  const wanted = code.trim().toUpperCase();
  if (!wanted) return null;

  const db = openDatabase(catalogue.path, { readonly: true });
  try {
    const row = db
      .prepare(`SELECT * FROM ${quote(resolved.table)} WHERE UPPER(${quote(resolved.spec.codeColumn)}) = ? LIMIT 1`)
      .get(wanted) as Record<string, unknown> | undefined;
    if (!row) return null;
    const description = resolved.columns.map((c) => row[c]).find((v) => typeof v === "string" && v.trim().length > 0);
    if (typeof description !== "string") return null;
    return { code: wanted, description: description.trim(), role, table: resolved.table, row };
  } finally {
    db.close();
  }
}

/** Rows matching a substring of the description, for search-style tools. */
export function searchRole(
  cfg: ReferenceDbConfig,
  role: ReferenceRole,
  text: string,
  limit = 15,
  opts: { licensedRoles?: string[] } = {},
): RoleHit[] {
  const catalogue = catalogueFor(cfg);
  if ("error" in catalogue) return [];
  const resolved = resolveRoute(catalogue, role);
  if (!resolved) return [];
  if (resolved.spec.licensed && !(opts.licensedRoles ?? []).includes(role)) return [];

  const needle = text.trim();
  if (!needle) return [];

  const db = openDatabase(catalogue.path, { readonly: true });
  try {
    const where = resolved.columns.map((c) => `${quote(c)} LIKE ?`).join(" OR ");
    const rows = db
      .prepare(`SELECT * FROM ${quote(resolved.table)} WHERE ${where} LIMIT ${Math.min(limit, 50)}`)
      .all(...resolved.columns.map(() => `%${needle}%`)) as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
      const description = resolved.columns.map((c) => row[c]).find((v) => typeof v === "string" && v.trim().length > 0);
      const value = row[resolved.spec.codeColumn];
      if (typeof description !== "string" || value === null || value === undefined) return [];
      return [{ code: String(value), description: description.trim(), role, table: resolved.table, row }];
    });
  } finally {
    db.close();
  }
}

/** One line naming where an answer came from. Never omitted. */
export function attribution(hit: RoleHit, path: string): string {
  return `Source: ${hit.table} in ${path}.`;
}

export interface RoleStatus {
  role: ReferenceRole;
  purpose: string;
  table: string | null;
  rowCount: number;
  licensed: boolean;
  /** Set when a table exists for the role but cannot be used. */
  blockedBecause?: string;
}

export function roleStatuses(catalogue: ReferenceCatalogue, licensedRoles: string[] = []): RoleStatus[] {
  return ROUTES.map((spec) => {
    const resolved = resolveRoute(catalogue, spec.role);
    if (!resolved) {
      // Distinguish "held back" from "absent" — a quarantined table is not a
      // missing one, and telling somebody the data is not there when it is
      // sends them looking for a file they already have.
      const held = spec.tables.map((t) => findTable(catalogue, t)).find((t) => t?.access === "quarantined");
      return {
        role: spec.role,
        purpose: spec.purpose,
        table: null,
        rowCount: 0,
        licensed: Boolean(spec.licensed),
        ...(held ? { blockedBecause: `${held.name} is held back by the identifier scan` } : {}),
      };
    }
    const usable = !spec.licensed || licensedRoles.includes(spec.role);
    return {
      role: spec.role,
      purpose: spec.purpose,
      table: resolved.table,
      rowCount: resolved.rowCount,
      licensed: Boolean(spec.licensed),
      ...(usable ? {} : { blockedBecause: `${resolved.table} holds licensed content; add "${spec.role}" to healthcare.referenceDbLicensedRoles to read it` }),
    };
  });
}

export function renderRoles(statuses: RoleStatus[]): string {
  const live = statuses.filter((s) => s.table && !s.blockedBecause);
  const blocked = statuses.filter((s) => s.blockedBecause);
  const absent = statuses.filter((s) => !s.table && !s.blockedBecause);

  const out: string[] = [];
  if (live.length > 0) {
    out.push("Code sets the attached database answers:");
    for (const s of live) out.push(`  ${s.role.padEnd(13)} ${s.rowCount.toLocaleString().padStart(9)}  ${s.purpose}  [${s.table}]`);
  }
  if (blocked.length > 0) {
    out.push("", "Present but not readable:");
    for (const s of blocked) out.push(`  ${s.role.padEnd(13)} ${s.blockedBecause}`);
  }
  if (absent.length > 0) {
    out.push("", `No table for: ${absent.map((s) => s.role).join(", ")}.`);
  }
  return out.join("\n");
}
