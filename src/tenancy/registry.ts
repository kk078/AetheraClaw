import fs from "node:fs";
import path from "node:path";
import { newId } from "../shared/ids.js";
import { openDatabase, type SqliteDb } from "../memory/sqlite.js";
import { MemoryStore } from "../memory/store.js";
import { bindScope, checkSlug, tenantDbPath, type ScopeResult, type Tenant } from "./tenant.js";

// The registry is the ONLY cross-tenant object in the system: it holds the list
// of tenants and nothing else. It carries no claims, no remittances, no
// accounts — so a compromise of it discloses which practices exist, not what
// they billed. Everything else lives in a per-tenant database the registry only
// knows the path to.

const REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL
);
`;

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  created_at: number;
}

function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status === "suspended" ? "suspended" : "active",
    createdAt: row.created_at,
  };
}

export class TenantRegistry {
  readonly db: SqliteDb;
  /**
   * Open per-tenant handles, keyed by slug.
   *
   * Cached because opening a SQLite file runs the full 47-table schema, and a
   * gateway serving several tenants would otherwise pay that on every request.
   * Keyed by slug rather than by anything caller-supplied, so two names for the
   * same tenant cannot produce two handles with divergent WAL state.
   */
  private readonly stores = new Map<string, MemoryStore>();

  constructor(private readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
    this.db = openDatabase(path.join(root, "tenants.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(REGISTRY_SCHEMA);
  }

  create(name: string, slug: string): Tenant {
    const check = checkSlug(slug);
    if (!check.ok) throw new Error(check.reason);
    if (this.bySlug(check.slug)) throw new Error(`A tenant with slug "${check.slug}" already exists.`);
    const tenant: Tenant = {
      id: newId("tnt"),
      slug: check.slug,
      name: name.trim() || check.slug,
      status: "active",
      createdAt: Date.now(),
    };
    this.db
      .prepare("INSERT INTO tenants (id, slug, name, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(tenant.id, tenant.slug, tenant.name, tenant.status, tenant.createdAt);
    // Create the database eagerly. A tenant that exists in the registry but has
    // no database is a tenant whose first request fails at an awkward moment.
    this.storeFor(tenant.slug);
    return tenant;
  }

  bySlug(slug: string): Tenant | undefined {
    const row = this.db.prepare("SELECT * FROM tenants WHERE slug = ?").get(slug) as TenantRow | undefined;
    return row ? toTenant(row) : undefined;
  }

  list(): Tenant[] {
    return (this.db.prepare("SELECT * FROM tenants ORDER BY slug ASC").all() as TenantRow[]).map(toTenant);
  }

  setStatus(slug: string, status: Tenant["status"]): void {
    this.db.prepare("UPDATE tenants SET status = ? WHERE slug = ?").run(status, slug);
    // Drop the cached handle so a suspended tenant's connection does not linger.
    this.stores.get(slug)?.close();
    this.stores.delete(slug);
  }

  /** Open (or reuse) the tenant's own database. */
  storeFor(slug: string): MemoryStore {
    const existing = this.stores.get(slug);
    if (existing) return existing;
    const store = new MemoryStore(tenantDbPath(this.root, slug));
    this.stores.set(slug, store);
    return store;
  }

  /**
   * The one supported way to get a tenant-scoped handle.
   *
   * Returns the scope AND the store together so no caller can end up holding a
   * scope for one tenant and a store for another — the mistake that would defeat
   * the entire design, and the only one the file-per-tenant layout cannot make
   * structurally impossible.
   */
  open(slug: string, actor: string): ScopeResult & { store?: MemoryStore } {
    const result = bindScope(this.bySlug(slug), this.root, actor);
    if (!result.ok) return result;
    return { ...result, store: this.storeFor(result.scope.tenant.slug) };
  }

  close(): void {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
    this.db.close();
  }
}

/**
 * The tenant a single-tenant install runs as.
 *
 * Every existing deployment has one practice and a database at the old path.
 * Rather than migrate them, single-tenant mode stays exactly as it was and
 * tenancy is opt-in — so turning the feature on cannot move anyone's data, and
 * leaving it off cannot cost them anything.
 */
export const SINGLE_TENANT: Tenant = {
  id: "tnt_single",
  slug: "primary",
  name: "Primary practice",
  status: "active",
  createdAt: 0,
};
