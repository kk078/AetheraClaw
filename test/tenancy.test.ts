import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindScope, checkSlug, tenantDbPath, type Tenant } from "../src/tenancy/tenant.js";
import { SINGLE_TENANT, TenantRegistry } from "../src/tenancy/registry.js";
import { MemoryStore } from "../src/memory/store.js";
import {
  BULK_EXPORT_RECORDS,
  DISCLOSING_ACTIONS,
  checkResourceRef,
  prepareAccessEntry,
  renderAccessReview,
  reviewAccess,
  type AccessEvent,
} from "../src/tenancy/access-log.js";
import { findUnchainedAccess, loadAccessEvents, recordAccess } from "../src/tenancy/store.js";
import { verifyChain } from "../src/audit/chain.js";
import { loadChain as loadChainRows } from "../src/audit/store.js";

describe("tenant slugs", () => {
  it("accepts ordinary slugs", () => {
    for (const s of ["acme-health", "practice1", "a"]) {
      expect(checkSlug(s), s).toEqual({ ok: true, slug: s });
    }
  });

  it("lowercases before validating", () => {
    expect(checkSlug("  Acme-Health ")).toEqual({ ok: true, slug: "acme-health" });
  });

  it("rejects rather than sanitizes a traversal", () => {
    // Sanitizing "../other" into "other" would silently point one tenant at
    // another tenant's directory — the exact failure being prevented.
    const result = checkSlug("../other");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/path separators/);
  });

  it("rejects separators, reserved names and bad shapes", () => {
    for (const bad of ["a/b", "a\\b", "..", ".", "", "tenants", "default", "-lead", "trail-", "UPPER!", "x".repeat(64)]) {
      expect(checkSlug(bad).ok, bad).toBe(false);
    }
  });
});

describe("tenant database paths", () => {
  it("puts each tenant under its own directory", () => {
    const p = tenantDbPath("/srv/ac", "acme");
    expect(p).toBe(path.join("/srv/ac", "tenants", "acme", "orion.db"));
  });

  it("re-validates the slug rather than trusting a stored row", () => {
    // A row read back from a hand-edited database is not a guarantee, and this
    // function is the last place a traversal can be stopped.
    expect(() => tenantDbPath("/srv/ac", "../escape")).toThrow(/invalid tenant slug/);
  });

  it("gives two tenants disjoint paths", () => {
    expect(tenantDbPath("/srv/ac", "a")).not.toBe(tenantDbPath("/srv/ac", "b"));
  });
});

describe("scope binding", () => {
  const tenant: Tenant = { id: "t1", slug: "acme", name: "Acme", status: "active", createdAt: 0 };

  it("binds an active tenant", () => {
    const r = bindScope(tenant, "/srv/ac", "cli");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scope.dbPath).toContain(path.join("tenants", "acme"));
  });

  it("refuses a suspended tenant outright, not read-only", () => {
    // Read-only still discloses.
    const r = bindScope({ ...tenant, status: "suspended" }, "/srv/ac", "cli");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/suspended/);
  });

  it("refuses an unknown tenant", () => {
    expect(bindScope(undefined, "/srv/ac", "cli").ok).toBe(false);
  });
});

describe("PHI access log — what must never be stored", () => {
  it("refuses identifier-shaped resource references", () => {
    const cases: Array<[string, string]> = [
      ["123-45-6789", "SSN"],
      ["1EG4TE5MK73", "Medicare MBI"],
      ["123456789A", "legacy HICN"],
      ["patient DOB 1950-01-01", "date of birth"],
      ["jane@example.com", "email address"],
    ];
    for (const [ref, label] of cases) {
      const check = checkResourceRef(ref);
      expect(check.ok, ref).toBe(false);
      expect(check.found, ref).toContain(label);
    }
  });

  it("accepts internal identifiers", () => {
    for (const ref of ["CLM-2026-00184", "acct_9f2c", "ERA-771"]) {
      expect(checkResourceRef(ref).ok, ref).toBe(true);
    }
  });

  it("refuses rather than redacting, and says why", () => {
    const result = prepareAccessEntry({
      action: "read",
      resourceType: "claim",
      resourceRef: "claim for 123-45-6789",
      actor: "u1",
      tenantSlug: "acme",
      sourceAddress: "",
      recordCount: 1,
      at: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/second copy of the record/);
      expect(result.reason).toMatch(/SSN/);
    }
  });

  it("marks exports and prints as disclosing, and reads as not", () => {
    expect(DISCLOSING_ACTIONS.has("export")).toBe(true);
    expect(DISCLOSING_ACTIONS.has("print")).toBe(true);
    expect(DISCLOSING_ACTIONS.has("read")).toBe(false);

    const entry = prepareAccessEntry({
      action: "export",
      resourceType: "report",
      resourceRef: "RPT-9",
      actor: "u1",
      tenantSlug: "acme",
      sourceAddress: "10.0.0.4",
      recordCount: 500,
      at: 1,
    });
    expect(entry.ok).toBe(true);
    if (entry.ok) {
      expect(entry.entry.summary).toMatch(/DISCLOSING/);
      expect(entry.entry.summary).toMatch(/records=500/);
      // The summary carries the reference and nothing about content.
      expect(entry.entry.summary).toContain("report:RPT-9");
    }
  });
});

describe("access review", () => {
  const base = { resourceType: "claim" as const, tenantSlug: "acme", sourceAddress: "", at: 1 };
  const events: AccessEvent[] = [
    { ...base, action: "read", resourceRef: "C1", actor: "alice", recordCount: 1 },
    { ...base, action: "read", resourceRef: "C2", actor: "alice", recordCount: 1 },
    { ...base, action: "write", resourceRef: "C2", actor: "bob", recordCount: 1 },
    { ...base, action: "export", resourceRef: "C3", actor: "bob", recordCount: 400 },
    { ...base, action: "export", resourceRef: "C4", actor: "carol", recordCount: 2 },
  ];

  it("counts every action but separates the disclosing ones", () => {
    const r = reviewAccess(events);
    expect(r.total).toBe(5);
    expect(r.byAction.read).toBe(2);
    expect(r.disclosingEvents).toBe(2);
    expect(r.recordsDisclosed).toBe(402);
  });

  it("surfaces bulk exporters and leaves small ones alone", () => {
    const r = reviewAccess(events);
    expect(r.bulkExporters.map((b) => b.actor)).toEqual(["bob"]);
    expect(r.bulkExporters[0].records).toBeGreaterThanOrEqual(BULK_EXPORT_RECORDS);
  });

  it("frames a bulk exporter as a question, not a finding", () => {
    const out = renderAccessReview(reviewAccess(events), "in the last 30 days");
    expect(out).toMatch(/a question, not a finding/);
    expect(out).toMatch(/regularly reviewing/);
  });

  it("says plainly when nothing left the system", () => {
    const out = renderAccessReview(reviewAccess(events.slice(0, 3)), "today");
    expect(out).toMatch(/Nothing was exported or printed/);
  });
});

describe("registry and isolation, against real databases", () => {
  let root: string;
  let registry: TenantRegistry;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-tenancy-"));
    registry = new TenantRegistry(root);
  });
  afterAll(() => {
    registry.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates a tenant with its own database file", () => {
    const t = registry.create("Acme Health", "acme");
    expect(t.slug).toBe("acme");
    expect(fs.existsSync(tenantDbPath(root, "acme"))).toBe(true);
  });

  it("refuses a duplicate slug", () => {
    expect(() => registry.create("Other", "acme")).toThrow(/already exists/);
  });

  it("refuses an invalid slug before touching the filesystem", () => {
    expect(() => registry.create("Bad", "../evil")).toThrow(/path separators/);
    expect(fs.existsSync(path.join(root, "evil"))).toBe(false);
  });

  it("keeps two tenants' data physically apart", () => {
    registry.create("Beta Clinic", "beta");
    const acme = registry.storeFor("acme");
    const beta = registry.storeFor("beta");

    acme.db.prepare("INSERT INTO worklist_items (id, kind, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run("W-ACME", "denial", "Acme item", "open", 1, 1);

    // Not "filtered out" — absent. The row is in a different file, so a query
    // that forgot a tenant predicate still cannot reach it.
    const seen = beta.db.prepare("SELECT id FROM worklist_items").all() as Array<{ id: string }>;
    expect(seen).toEqual([]);
    expect((acme.db.prepare("SELECT id FROM worklist_items").all() as Array<{ id: string }>)[0].id).toBe("W-ACME");
  });

  it("returns the same handle for the same slug", () => {
    expect(registry.storeFor("acme")).toBe(registry.storeFor("acme"));
  });

  it("open() hands back a scope and its matching store together", () => {
    const opened = registry.open("acme", "cli");
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.scope.tenant.slug).toBe("acme");
      expect(opened.store).toBe(registry.storeFor("acme"));
    }
  });

  it("refuses to open a suspended tenant", () => {
    registry.setStatus("beta", "suspended");
    const opened = registry.open("beta", "cli");
    expect(opened.ok).toBe(false);
    expect(opened.store).toBeUndefined();
    registry.setStatus("beta", "active");
  });

  it("names a real single-tenant identity so nothing has to special-case null", () => {
    expect(SINGLE_TENANT.slug).toBe("primary");
    expect(SINGLE_TENANT.status).toBe("active");
  });
});

describe("access log persistence and integrity", () => {
  let root: string;
  let registry: TenantRegistry;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-acclog-"));
    registry = new TenantRegistry(root);
    registry.create("Acme", "acme");
  });
  afterAll(() => {
    registry.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const event = (over: Partial<AccessEvent> = {}): AccessEvent => ({
    action: "read",
    resourceType: "claim",
    resourceRef: "CLM-1",
    actor: "alice",
    tenantSlug: "acme",
    sourceAddress: "",
    recordCount: 1,
    at: Date.now(),
    ...over,
  });

  it("writes the row and its chain entry together", () => {
    const store = registry.storeFor("acme");
    const result = recordAccess(store, event());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = loadAccessEvents(store, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].resourceRef).toBe("CLM-1");

    const chain = loadChainRows(store);
    expect(chain.some((e) => e.seq === result.chainSeq && e.kind === "phi_access")).toBe(true);
    expect(verifyChain(chain).ok).toBe(true);
  });

  it("writes nothing at all when the reference is refused", () => {
    const store = registry.storeFor("acme");
    const before = loadAccessEvents(store, 0).length;
    const result = recordAccess(store, event({ resourceRef: "123-45-6789" }));
    expect(result.ok).toBe(false);
    expect(loadAccessEvents(store, 0)).toHaveLength(before);
  });

  it("catches a log row inserted outside the recording path", () => {
    const store = registry.storeFor("acme");
    expect(findUnchainedAccess(store)).toEqual([]);
    // A fabricated row is ADDED, not edited — verifying the chain alone would
    // still pass, which is exactly why this cross-check exists.
    store.db
      .prepare(
        `INSERT INTO phi_access_log (id, action, resource_type, resource_ref, actor, tenant_slug, source_address, record_count, chain_seq, created_at)
         VALUES ('forged','read','claim','CLM-9','mallory','acme','',1,NULL,1)`,
      )
      .run();
    expect(verifyChain(loadChainRows(store)).ok).toBe(true);
    const problems = findUnchainedAccess(store);
    expect(problems).toHaveLength(1);
    expect(problems[0].id).toBe("forged");
    expect(problems[0].reason).toMatch(/outside recordAccess/);
  });

  it("keeps each tenant's access log inside that tenant", () => {
    registry.create("Beta", "beta2");
    const beta = registry.storeFor("beta2");
    expect(loadAccessEvents(beta, 0)).toEqual([]);
  });
});

describe("database file permissions", () => {
  it("creates a database owner-only, including the WAL", () => {
    // Found by ops_tenant_integrity_check on its first real run: databases were
    // being created at whatever the umask allowed — 0644 on a default Linux
    // install — so in the database-per-tenant design every tenant's claims were
    // world-readable, and the isolation boundary IS the filesystem.
    if (process.platform === "win32") return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-perm-"));
    const dbPath = path.join(dir, "sub", "db.sqlite");
    const store = new MemoryStore(dbPath);
    store.createSession("force a write");
    try {
      expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(dbPath)).mode & 0o777).toBe(0o700);
      const wal = `${dbPath}-wal`;
      if (fs.existsSync(wal)) expect(fs.statSync(wal).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives every tenant database the same treatment", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-permt-"));
    const reg = new TenantRegistry(root);
    try {
      reg.create("Acme", "acme");
      expect(fs.statSync(tenantDbPath(root, "acme")).mode & 0o777).toBe(0o600);
    } finally {
      reg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
