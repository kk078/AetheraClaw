// ── Tenant database integrity ────────────────────────────────────────────────
// The database-per-tenant design puts the isolation boundary in the filesystem
// rather than in a WHERE clause. That is what makes it hard to breach by
// accident — but it also means the boundary is only as good as the files, and
// nothing was watching them. A tenant database with a mode of 0666, or two
// tenants whose slugs resolve to one path, is a disclosure that no amount of
// correct application code prevents.
//
// So the sweep checks the boundary itself, not only the health of what is
// inside it. Findings are ordered by what they cost if ignored: a broken
// isolation boundary first, corruption second, performance last.

export type IntegritySeverity = "critical" | "warning" | "info";

export interface IntegrityFinding {
  severity: IntegritySeverity;
  tenant: string;
  check: string;
  detail: string;
  remedy: string;
}

export interface TenantDbFacts {
  slug: string;
  path: string;
  exists: boolean;
  /** POSIX mode bits, or null on a platform that does not report them meaningfully. */
  mode: number | null;
  sizeBytes: number;
  walBytes: number;
  /** PRAGMA integrity_check — "ok" when sound. */
  integrity: string;
  /** PRAGMA foreign_key_check row count. */
  foreignKeyViolations: number;
  pageCount: number;
  freelistCount: number;
  /** Tables the schema should have created. */
  missingTables: string[];
}

/**
 * WAL above this is worth a look.
 *
 * A write-ahead log grows until a checkpoint, and a checkpoint needs a moment
 * with no readers. A WAL that keeps growing usually means a long-lived read
 * transaction is pinning it — the classic symptom is a process that opened a
 * connection and never closed it. 64 MB is not a hard failure; it is the point
 * at which "this will checkpoint eventually" stops being a safe assumption.
 */
export const WAL_WARN_BYTES = 64 * 1024 * 1024;

/** Free pages above this share mean the file is mostly holes. */
export const FRAGMENTATION_WARN = 0.25;

/** World- or group-writable is the mode that matters; a tenant DB should be owner-only. */
export function permissionProblem(mode: number | null): string | null {
  if (mode === null) return null;
  const perms = mode & 0o777;
  if (perms & 0o007) return `world-accessible (mode ${perms.toString(8)})`;
  if (perms & 0o070) return `group-accessible (mode ${perms.toString(8)})`;
  return null;
}

export function analyzeTenant(facts: TenantDbFacts): IntegrityFinding[] {
  const out: IntegrityFinding[] = [];
  const at = (severity: IntegritySeverity, check: string, detail: string, remedy: string) =>
    out.push({ severity, tenant: facts.slug, check, detail, remedy });

  if (!facts.exists) {
    at(
      "critical",
      "database-missing",
      `No database file at ${facts.path}.`,
      "The tenant exists in the registry but has no store. Serving it will create an empty one, which looks like data loss to whoever opens it. Restore from backup before the next request, or remove the registry entry.",
    );
    return out;
  }

  const perms = permissionProblem(facts.mode);
  if (perms) {
    at(
      "critical",
      "permissions",
      `Database file is ${perms}.`,
      "The isolation boundary here IS the filesystem. Set 0600 on the file and 0700 on its directory — no amount of correct application code compensates for a readable file.",
    );
  }

  if (facts.integrity !== "ok") {
    at(
      "critical",
      "integrity",
      `PRAGMA integrity_check returned: ${facts.integrity.slice(0, 300)}`,
      "The file is corrupt. Do not write to it. Recover with `.recover` from the sqlite3 CLI into a fresh file, or restore from backup; continuing to serve a corrupt database compounds the damage.",
    );
  }

  if (facts.foreignKeyViolations > 0) {
    at(
      "warning",
      "foreign-keys",
      `${facts.foreignKeyViolations} foreign-key violation(s).`,
      "Usually rows written while `PRAGMA foreign_keys` was off. Find the orphans with PRAGMA foreign_key_check and decide per table whether to delete or repoint them — this is a data question, not a mechanical one.",
    );
  }

  if (facts.missingTables.length > 0) {
    at(
      "critical",
      "schema-drift",
      `Missing table(s): ${facts.missingTables.join(", ")}.`,
      "This database was created by an older build. The schema is applied with CREATE TABLE IF NOT EXISTS on every open, so simply serving the tenant once will add them — but check first whether the missing tables mean an incomplete migration rather than an old file.",
    );
  }

  if (facts.walBytes > WAL_WARN_BYTES) {
    at(
      "warning",
      "wal-size",
      `WAL is ${(facts.walBytes / 1024 / 1024).toFixed(1)} MB.`,
      "A WAL that keeps growing usually means a long-lived read transaction is pinning it — most often a connection opened and never closed. Find the holder before running a checkpoint; the checkpoint will not stick otherwise.",
    );
  }

  const fragmentation = facts.pageCount > 0 ? facts.freelistCount / facts.pageCount : 0;
  if (fragmentation > FRAGMENTATION_WARN) {
    at(
      "info",
      "fragmentation",
      `${(fragmentation * 100).toFixed(0)}% of pages are free (${facts.freelistCount} of ${facts.pageCount}).`,
      "VACUUM reclaims them. It rewrites the whole file and needs a lock for the duration, so run it in a maintenance window rather than under load.",
    );
  }

  return out;
}

/**
 * Cross-tenant checks — the ones that are about the boundary rather than a file.
 *
 * Two tenants sharing a path is the single worst outcome this architecture can
 * produce: it is not a leak, it is one practice reading another's database
 * directly, and it would be invisible to every per-file check above.
 */
export function analyzeBoundary(tenants: Array<{ slug: string; path: string }>, tenantsRoot: string): IntegrityFinding[] {
  const out: IntegrityFinding[] = [];
  const byPath = new Map<string, string[]>();
  for (const t of tenants) {
    const key = t.path.toLowerCase();
    byPath.set(key, [...(byPath.get(key) ?? []), t.slug]);
  }
  for (const [p, slugs] of byPath) {
    if (slugs.length < 2) continue;
    out.push({
      severity: "critical",
      tenant: slugs.join(", "),
      check: "shared-path",
      detail: `${slugs.length} tenants resolve to the same database file: ${p}`,
      remedy:
        "This is not a leak, it is shared storage — each of these tenants can read the others' claims directly. Stop serving them until the registry is corrected.",
    });
  }
  for (const t of tenants) {
    if (t.path.startsWith(tenantsRoot)) continue;
    out.push({
      severity: "critical",
      tenant: t.slug,
      check: "path-escape",
      detail: `Database is outside the tenants directory: ${t.path}`,
      remedy: "A tenant path outside the managed root bypasses the layout the isolation argument depends on. Correct the registry entry.",
    });
  }
  return out;
}

export interface IntegrityReport {
  tenantsChecked: number;
  findings: IntegrityFinding[];
}

export function renderIntegrity(report: IntegrityReport): string {
  if (report.tenantsChecked === 0) {
    return "No tenants to check. In a single-tenant install there is one database and no isolation boundary to verify — the file-permission and corruption checks still apply, so run this with tenancy enabled or check the file directly.";
  }
  if (report.findings.length === 0) {
    return `${report.tenantsChecked} tenant database(s) checked: no findings. Integrity check clean, no foreign-key violations, schema complete, permissions owner-only, WAL and free-page counts within bounds.`;
  }

  const order: IntegritySeverity[] = ["critical", "warning", "info"];
  const lines = [`${report.tenantsChecked} tenant database(s) checked, ${report.findings.length} finding(s).`, ""];
  for (const sev of order) {
    const group = report.findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    lines.push(`${sev.toUpperCase()} — ${group.length}`);
    for (const f of group) {
      lines.push(`  [${f.tenant}] ${f.check}: ${f.detail}`, `      ${f.remedy}`);
    }
    lines.push("");
  }
  if (report.findings.some((f) => f.check === "shared-path" || f.check === "permissions")) {
    lines.push(
      "At least one finding is about the isolation boundary rather than about performance. In this architecture the boundary IS the filesystem, so those are the ones to fix before anything else.",
    );
  }
  return lines.join("\n").trimEnd();
}
