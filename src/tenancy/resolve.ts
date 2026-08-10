import path from "node:path";
import { configDir, type Config } from "../config/config.js";
import { resolveDbFile } from "../config/legacy.js";
import { MemoryStore } from "../memory/store.js";
import { TenantRegistry, SINGLE_TENANT } from "./registry.js";
import type { Tenant } from "./tenant.js";

// The single place a process decides which tenant it serves. Everything that
// opens a database goes through here, so there is exactly one code path that can
// get the decision wrong, and it is tested.

export interface Resolved {
  store: MemoryStore;
  tenant: Tenant;
  /** Present only in multi-tenant mode; the caller closes it. */
  registry?: TenantRegistry;
}

export function tenancyRoot(): string {
  return configDir();
}

/**
 * Open the database this process should use.
 *
 * Single-tenant is the default and keeps the original path, so an existing
 * install is untouched by this feature existing. Multi-tenant requires a tenant
 * to be named — by flag or by config — and **fails rather than falling back**.
 * A silent fallback to "the first tenant" or "the primary database" in a
 * multi-tenant deployment is how one practice's operator ends up looking at
 * another practice's claims, so the ambiguous case is an error.
 */
export function resolveStore(config: Config, tenantSlug?: string): Resolved {
  if (!config.tenancy.enabled) {
    if (tenantSlug) {
      throw new Error(
        `--tenant was given but tenancy is disabled. Set tenancy.enabled in config.json5 first; until then there is one database and naming a tenant would be misleading about what is isolated.`,
      );
    }
    return { store: new MemoryStore(resolveDbFile(configDir())), tenant: SINGLE_TENANT };
  }

  const slug = (tenantSlug || config.tenancy.defaultTenant).trim();
  if (!slug) {
    throw new Error(
      "Tenancy is enabled but no tenant was named. Pass --tenant <slug> or set tenancy.defaultTenant. There is deliberately no default: picking one for you is how an operator ends up in the wrong practice's data.",
    );
  }

  const registry = new TenantRegistry(tenancyRoot());
  const opened = registry.open(slug, "cli");
  if (!opened.ok || !opened.store) {
    registry.close();
    const known = new TenantRegistry(tenancyRoot());
    const names = known.list().map((t) => t.slug);
    known.close();
    throw new Error(
      `${opened.ok ? "Tenant opened without a store." : opened.reason} Known tenants: ${names.length > 0 ? names.join(", ") : "(none — create one with `orion tenants create`)"}`,
    );
  }
  return { store: opened.store, tenant: opened.scope.tenant, registry };
}
