import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkResourceRef } from "../src/tenancy/access-log.js";
import { findUnchainedAccess, recordAccess } from "../src/tenancy/store.js";
import { MemoryStore } from "../src/memory/store.js";
import { openDatabase } from "../src/memory/sqlite.js";

// ── The access log's tamper-evidence must hold against a SQL client ──────────
// The verified audit findings: hyphenated MBIs (as printed on cards) and bare
// SSNs passed the identifier gate, and findUnchainedAccess missed both a
// chain_seq-reuse forge and an in-place row edit.

describe("checkResourceRef — identifier shapes as they actually appear", () => {
  it("refuses an MBI in every printed form", () => {
    expect(checkResourceRef("1EG4-TE5-MK72").ok).toBe(false); // card format
    expect(checkResourceRef("1EG4 TE5 MK72").ok).toBe(false); // spaced
    expect(checkResourceRef("1EG4TE5MK72").ok).toBe(false); // contiguous
  });
  it("refuses an SSN dashed, spaced, or as a bare nine-digit ref", () => {
    expect(checkResourceRef("123-45-6789").ok).toBe(false);
    expect(checkResourceRef("123 45 6789").ok).toBe(false);
    expect(checkResourceRef("123456789").ok).toBe(false);
  });
  it("still accepts internal identifiers, including ones with embedded digits", () => {
    expect(checkResourceRef("CLM-88213").ok).toBe(true);
    expect(checkResourceRef("claim:CLM-88213").ok).toBe(true);
    expect(checkResourceRef("acct-000123456").ok).toBe(true); // not a whole nine-digit run
  });
});

describe("findUnchainedAccess — cross-checks every row against its chain entry", () => {
  let home: string;
  let store: MemoryStore;
  const ev = (over = {}) => ({
    action: "read" as const,
    resourceType: "claim" as const,
    resourceRef: "CLM-1",
    actor: "alice",
    tenantSlug: "acme",
    sourceAddress: "",
    recordCount: 1,
    at: 1000,
    ...over,
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "aclaw-tint-"));
    store = new MemoryStore(path.join(home, "db.sqlite"));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("passes clean, legitimately-recorded access", () => {
    recordAccess(store, ev());
    recordAccess(store, ev({ resourceRef: "CLM-2", action: "export" }));
    expect(findUnchainedAccess(store)).toEqual([]);
  });

  it("catches a fabricated row that reuses a legitimate chain_seq", () => {
    recordAccess(store, ev());
    store.db
      .prepare(
        "INSERT INTO phi_access_log (id,action,resource_type,resource_ref,actor,tenant_slug,source_address,record_count,chain_seq,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run("acc_forge", "export", "claim", "CLM-STOLEN", "mallory", "acme", "", 9999, 1, 1001);
    const flagged = findUnchainedAccess(store);
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    expect(flagged.some((f) => /shares chain entry/.test(f.reason))).toBe(true);
  });

  it("catches an in-place edit of a row that keeps its chain_seq", () => {
    recordAccess(store, ev());
    store.db.prepare("UPDATE phi_access_log SET action=?, resource_ref=?, actor=? WHERE chain_seq=1").run("delete", "CLM-TAMPERED", "mallory");
    const flagged = findUnchainedAccess(store);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].reason).toMatch(/does not match chain entry/);
  });

  it("still catches a row inserted with no chain_seq at all", () => {
    store.db
      .prepare(
        "INSERT INTO phi_access_log (id,action,resource_type,resource_ref,actor,tenant_slug,source_address,record_count,chain_seq,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run("acc_bare", "read", "claim", "CLM-X", "mallory", "acme", "", 1, null, 1002);
    expect(findUnchainedAccess(store).some((f) => /no chain sequence/.test(f.reason))).toBe(true);
  });
});

describe("SQLite adapter — busy_timeout parity", () => {
  it("both drivers report the same non-zero busy timeout on a writable handle", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "aclaw-bt-"));
    try {
      const db = openDatabase(path.join(home, "x.db"));
      const t = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      expect(t.timeout).toBe(5000);
      db.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("a failing transaction surfaces the real error, not 'no such savepoint'", () => {
    // On the node:sqlite fallback an OR ROLLBACK conflict auto-unwinds the
    // transaction; the shim's own ROLLBACK TO then threw and masked the cause.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "aclaw-sp-"));
    try {
      const db = openDatabase(path.join(home, "x.db"));
      db.exec("CREATE TABLE u (id INTEGER PRIMARY KEY, v TEXT UNIQUE)");
      db.exec("INSERT INTO u (id, v) VALUES (1, 'a')");
      const insert = db.transaction(() => db.prepare("INSERT OR ROLLBACK INTO u (id, v) VALUES (2, 'a')").run());
      expect(() => insert()).toThrow(/UNIQUE constraint failed/i);
      db.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("document store — every disclosure is logged", () => {
  it("logs a read when a re-uploaded duplicate returns the stored text", async () => {
    const { saveDocument } = await import("../src/ingest/store.js");
    const { loadAccessEvents } = await import("../src/tenancy/store.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "aclaw-doc-"));
    try {
      const store = new MemoryStore(path.join(home, "db.sqlite"));
      const session = store.createSession();
      const extraction = {
        filename: "eob.pdf",
        kind: "pdf",
        sizeBytes: 40,
        sha256: "abc123",
        text: "PATIENT: Rivera, J. PAID $500",
        sections: [],
        readable: true,
        confidence: 1,
        phi: [],
        notes: [],
      };
      saveDocument(store, session.id, extraction, 1000);
      const afterFirst = loadAccessEvents(store, 0).length;
      // Same bytes, same session: a dedup hit that still discloses the text.
      saveDocument(store, session.id, extraction, 2000);
      const events = loadAccessEvents(store, 0);
      expect(events.length).toBe(afterFirst + 1);
      expect(events.at(-1)?.action).toBe("read");
      store.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
