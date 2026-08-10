import path from "node:path";
import { resolveDbFile } from "../config/legacy.js";

// ── Multi-tenant isolation ───────────────────────────────────────────────────
// The requirement is that one health system's data can never be read by
// another's. The usual answer is a `tenant_id` column on every table plus a
// row-level security policy, and on PostgreSQL that is right. Here it is not
// available: **SQLite has no row-level security.** There is no CREATE POLICY,
// no current_setting, no engine-level predicate. A tenant_id column in SQLite is
// enforced only by every query remembering to say `AND tenant_id = ?`.
//
// That distinction decides the whole design. This project has 47 tables and
// several hundred queries written across three dozen tool modules. Isolation by
// discipline means a single forgotten WHERE clause is a cross-tenant disclosure
// with nothing underneath it to catch the mistake — no policy, no error, just
// another practice's claims in the result set.
//
// So a tenant is a DATABASE FILE. Isolation is enforced by which handle was
// opened, and a query that forgets its tenant cannot reach one, because the
// connection it runs on physically does not contain another tenant's rows. It
// costs cross-tenant reporting, which has to be done by opening each tenant in
// turn and aggregating in application code — a real cost, and the right trade
// against silent disclosure.
//
// The second rule matters as much: **the model cannot choose the tenant.** Tool
// input is untrusted model output, and a tool that takes a tenant id is a tool
// that can be argued into taking a different one. The binding is made once, out
// of band (CLI flag, gateway session creation, config), and travels in the tool
// context where nothing the model emits can reach it.

/** Slug rules exist so a tenant id can safely become a directory name. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Reserved because they collide with the single-tenant layout or with path semantics. */
const RESERVED_SLUGS = new Set(["", ".", "..", "default", "tenants", "data", "knowledge", "node_modules"]);

export interface Tenant {
  id: string;
  /** Directory-safe identity. Immutable once created — the data lives under it. */
  slug: string;
  name: string;
  status: "active" | "suspended";
  createdAt: number;
}

export type SlugCheck = { ok: true; slug: string } | { ok: false; reason: string };

/**
 * Validate a slug for use as a directory name.
 *
 * Rejecting rather than sanitizing is deliberate. Sanitizing "../other" into
 * "other" silently points a tenant at a different tenant's directory, which is
 * the exact failure this function exists to prevent — so a bad slug is an error
 * the caller must fix, never a slug the function invents.
 */
export function checkSlug(raw: string): SlugCheck {
  const slug = raw.trim().toLowerCase();
  if (RESERVED_SLUGS.has(slug)) return { ok: false, reason: `"${slug}" is reserved and cannot be a tenant slug.` };
  if (slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    return { ok: false, reason: "A slug cannot contain path separators or '..' — it becomes a directory name." };
  }
  if (!SLUG_RE.test(slug)) {
    return {
      ok: false,
      reason: "A slug must be 1–63 characters of lowercase letters, digits and hyphens, starting and ending with a letter or digit.",
    };
  }
  return { ok: true, slug };
}

/**
 * Where a tenant's database lives.
 *
 * Re-validates the slug rather than trusting the caller: this function turns a
 * string into a filesystem path, and it is the last place a traversal can be
 * stopped. The registry validates on write, but a row read back from a database
 * someone edited by hand is not a guarantee.
 */
export function tenantDbPath(root: string, slug: string): string {
  const check = checkSlug(slug);
  if (!check.ok) throw new Error(`refusing to build a path from an invalid tenant slug: ${check.reason}`);
  const dir = path.join(root, "tenants", check.slug);
  const resolved = path.resolve(dir);
  const base = path.resolve(path.join(root, "tenants"));
  // Belt and braces: even a slug that passed the regex must land under the
  // tenants directory. If these two ever disagree, the regex is the bug.
  if (resolved !== path.join(base, check.slug)) {
    throw new Error(`tenant path escaped the tenants directory: ${resolved}`);
  }
  return resolveDbFile(dir);
}

/**
 * The tenant a request runs as. Constructed at the edge and passed down; there
 * is deliberately no setter and no way to derive one from tool input.
 */
export interface TenantScope {
  tenant: Tenant;
  dbPath: string;
  /** Who is acting, for the access log. "cli", "gateway:<session>", a user id. */
  actor: string;
}

export type ScopeResult = { ok: true; scope: TenantScope } | { ok: false; reason: string };

/**
 * Bind a request to a tenant.
 *
 * A suspended tenant is refused rather than served read-only. Suspension in this
 * context usually means a terminated contract or an unresolved compliance
 * question, and "read-only" still discloses.
 */
export function bindScope(tenant: Tenant | undefined, root: string, actor: string): ScopeResult {
  if (!tenant) return { ok: false, reason: "No such tenant." };
  if (tenant.status !== "active") {
    return { ok: false, reason: `Tenant "${tenant.slug}" is ${tenant.status}. No data is served for a tenant that is not active.` };
  }
  return { ok: true, scope: { tenant, dbPath: tenantDbPath(root, tenant.slug), actor } };
}
