import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { foldWal, openDatabase } from "../src/memory/sqlite.js";

// ── What went wrong in production, as a test ─────────────────────────────────
// The snapshot mechanism copied orion.db and nothing else while the database
// ran in WAL mode, so recent writes — which live in orion.db-wal until SQLite
// folds them in at its own threshold — were absent from every snapshot. The
// PUT succeeded, the restore was valid, and the restored database was simply
// old. Nothing reported a fault because, byte for byte, nothing was faulty.
//
// The assertion that matters is the round trip: copy the ONE file the
// snapshotter sends, open the copy, and count the rows.

describe("a snapshot is one file, and it has to be complete", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "orion-wal-"));
    dbPath = path.join(dir, "orion.db");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write rows the way the gateway does: WAL mode, connection left open. */
  const writeRows = (n: number) => {
    const db = openDatabase(dbPath, {});
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, v TEXT)");
    const ins = db.prepare("INSERT INTO rows (v) VALUES (?)");
    for (let i = 0; i < n; i++) ins.run(`row-${i}`);
    return db;
  };

  const rowsIn = (file: string): number | string => {
    const r = openDatabase(file, { readonly: true });
    try {
      return (r.prepare("SELECT COUNT(*) AS c FROM rows").get() as { c: number }).c;
    } catch (err) {
      return `unreadable: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      r.close();
    }
  };

  it("loses the writes when the main file is copied on its own", () => {
    // The defect, stated as a fact about SQLite rather than about our code, so
    // it stays true if someone reorganises the snapshotter. Without the fold,
    // the copy does not even contain the TABLE.
    const db = writeRows(200);
    const naive = path.join(dir, "naive.db");
    fs.copyFileSync(dbPath, naive);
    db.close();
    expect(rowsIn(naive)).not.toBe(200);
  });

  it("keeps every row when the WAL is folded in first", () => {
    const db = writeRows(200);
    foldWal(dbPath);
    const complete = path.join(dir, "complete.db");
    fs.copyFileSync(dbPath, complete);
    db.close();
    expect(rowsIn(complete)).toBe(200);
  });

  it("empties the WAL, which is the independent check on the claim", () => {
    // TRUNCATE resets it to zero. PASSIVE would report success having moved
    // nothing, which is indistinguishable from the bug — so the size afterwards
    // is a second reading rather than a restatement of the first.
    const db = writeRows(200);
    expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    foldWal(dbPath);
    expect(fs.statSync(`${dbPath}-wal`).size).toBe(0);
    db.close();
  });

  it("folds from a SECOND connection while the first still holds the database", () => {
    // The deployment shape: the gateway owns its connection for the life of the
    // process, and the snapshotter is a different process entirely. A fold that
    // only worked on an idle database would work in a test and never in
    // production — the exact failure mode this whole area already had once.
    const held = writeRows(50);
    const result = foldWal(dbPath);
    expect(result.busy).toBe(0);
    const copy = path.join(dir, "while-held.db");
    fs.copyFileSync(dbPath, copy);
    expect(rowsIn(copy)).toBe(50);
    // And the holder is still usable afterwards — folding must not disturb it.
    held.prepare("INSERT INTO rows (v) VALUES (?)").run("after");
    expect((held.prepare("SELECT COUNT(*) AS c FROM rows").get() as { c: number }).c).toBe(51);
    held.close();
  });

  it("reports what it moved", () => {
    const db = writeRows(100);
    const result = foldWal(dbPath);
    expect(result.log).toBe(0);
    expect(result.busy).toBe(0);
    db.close();
  });

  it("is safe to run when there is nothing to fold", () => {
    // Every 60 seconds on an idle instance. It must not throw and must not
    // leave the database worse than it found it.
    const db = writeRows(10);
    foldWal(dbPath);
    expect(() => foldWal(dbPath)).not.toThrow();
    const copy = path.join(dir, "idle.db");
    fs.copyFileSync(dbPath, copy);
    db.close();
    expect(rowsIn(copy)).toBe(10);
  });
});
