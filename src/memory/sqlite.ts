import { createRequire } from "node:module";
import { readEnv } from "../config/legacy.js";

// ── SQLite driver ────────────────────────────────────────────────────────────
// better-sqlite3 is a native module. When npm has no prebuilt binary for the
// running Node version it falls back to compiling with node-gyp, which needs a
// full C++ toolchain — on Windows that means a multi-gigabyte Visual Studio
// install. The failure is not graceful either: `npm install` aborts, so `tsc`
// is never installed, the build never runs, and the reported error is
// "'tsc' is not recognized" three steps downstream of the actual cause.
//
// Node ships its own SQLite from 22.5 onward, so there is no reason for a
// toolchain to be a prerequisite. better-sqlite3 is used when it is already
// there (it is faster and its prepared statements are more forgiving), and
// node:sqlite otherwise. The adapter exists so the rest of the codebase cannot
// tell which one it got.

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
  pragma(statement: string): void;
  /** Wrap fn so every call runs inside a transaction, as better-sqlite3 does. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
  /** Which driver is in use — reported at startup so it is never a mystery. */
  readonly driver: "better-sqlite3" | "node:sqlite";
}

const require_ = createRequire(import.meta.url);

/** Both drivers wait this long for a lock rather than failing a concurrent writer. */
const BUSY_TIMEOUT_MS = 5000;

/**
 * Transactions, for a driver that has none.
 *
 * SAVEPOINT rather than BEGIN so a nested call cannot fail with "cannot start a
 * transaction within a transaction" — better-sqlite3 nests via savepoints and
 * code written against it may rely on that.
 */
function savepointTransaction(exec: (sql: string) => void) {
  let depth = 0;
  return <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      const name = `orion_sp_${depth++}`;
      exec(`SAVEPOINT ${name}`);
      try {
        const result = fn(...args);
        exec(`RELEASE ${name}`);
        return result;
      } catch (err) {
        // The rollback can itself throw "no such savepoint" when SQLite already
        // unwound the transaction on its own — an OR ROLLBACK conflict, a full
        // disk (SQLITE_FULL), some IOERR/NOMEM cases all auto-roll-back. Letting
        // that throw replaced the ORIGINAL error (the real cause — a UNIQUE
        // violation, "disk is full") with a confusing "no such savepoint", which
        // the failure classifiers downstream then could not diagnose. Swallow the
        // cleanup's own failure and re-throw the real one.
        try {
          exec(`ROLLBACK TO ${name}`);
          exec(`RELEASE ${name}`);
        } catch {
          // already unwound by SQLite; nothing to release
        }
        throw err;
      } finally {
        depth--;
      }
    };
}

export interface OpenOptions {
  /**
   * Open the file read-only.
   *
   * Enforced by SQLite itself, not by us declining to write: both drivers take
   * the flag and both then fail an INSERT with "attempt to write a readonly
   * database". That matters for user-supplied reference databases, which may be
   * large, irreplaceable, and not ours to modify.
   *
   * The two drivers spell it differently — `readonly` for better-sqlite3,
   * `readOnly` for node:sqlite — which is precisely the sort of detail this
   * adapter exists to absorb.
   */
  readonly?: boolean;
}

function openNodeSqlite(file: string, opts: OpenOptions): SqliteDb {
  // Present from Node 22.5; stable enough to depend on, and the only SQLite a
  // default Windows install is guaranteed to have.
  const { DatabaseSync } = require_("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
      prepare(sql: string): SqliteStatement;
      exec(sql: string): void;
      close(): void;
    };
  };
  const db = opts.readonly ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(file);
  const exec = (sql: string) => db.exec(sql);
  // Match better-sqlite3's default 5s busy timeout. Without it node:sqlite runs
  // with SQLite's default of 0 and a second writer throws "database is locked"
  // the instant the first holds the lock — where better-sqlite3 waits and
  // succeeds. That divergence broke the adapter's whole contract ("the rest of
  // the codebase cannot tell which one it got") on exactly the fallback-only
  // machines this driver exists for. Read-only handles cannot write, so it is
  // pointless there but harmless.
  if (!opts.readonly) exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return {
    prepare: (sql) => db.prepare(sql),
    exec,
    close: () => db.close(),
    // node:sqlite has no pragma(); the statement form does the same thing.
    pragma: (statement) => exec(`PRAGMA ${statement}`),
    transaction: savepointTransaction(exec),
    driver: "node:sqlite",
  };
}

/**
 * Say out loud that the fast driver was wanted and the built-in was used.
 *
 * Once per process, not once per database file: tenancy opens one file per
 * tenant and the reference tables open more, so a per-call line would bury the
 * fact in noise. stderr rather than stdout, and never fatal — the fallback is a
 * supported configuration, this is only a report of which one is running.
 *
 * One line, so `reason` is trimmed to the first line of the load error: a
 * missing native module reports "Cannot find module …" followed by a multi-line
 * require stack, and a warning that scrolls is a warning that gets skimmed.
 */
let announcedFallback = false;
function announceFallback(reason: string): void {
  if (announcedFallback) return;
  announcedFallback = true;
  console.error(
    `[sqlite] wanted better-sqlite3, using node:sqlite — the optional native module did not load (${reason}). ` +
      `Both drivers are supported; set ORION_SQLITE=node to choose this deliberately and silence this line.`,
  );
}

function openBetterSqlite(file: string, opts: OpenOptions): SqliteDb | null {
  let Database: new (path: string, options?: { readonly?: boolean }) => {
    prepare(sql: string): SqliteStatement;
    exec(sql: string): void;
    close(): void;
    pragma(s: string): unknown;
    transaction<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R;
  };
  try {
    Database = require_("better-sqlite3") as never;
  } catch (err) {
    // Only openDatabase consumes this null, and only to fall through to
    // node:sqlite — so a failed load here IS the fallback, and saying so at the
    // point the reason is still in hand keeps the reason in the message.
    announceFallback((err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "");
    return null;
  }
  const db = opts.readonly ? new Database(file, { readonly: true }) : new Database(file);
  // Explicit rather than relying on the driver default (also 5000), so the two
  // drivers demonstrably match and a future default change cannot desync them.
  if (!opts.readonly) db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return {
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
    pragma: (statement) => void db.pragma(statement),
    transaction: (fn) => db.transaction(fn),
    driver: "better-sqlite3",
  };
}

/**
 * Open a database with whichever driver is available.
 *
 * `ORION_SQLITE=node` forces the built-in, which is how the test suite
 * exercises the fallback on a machine where the native module installed fine.
 * A fallback nobody runs is a fallback that does not work.
 */
export function openDatabase(file: string, opts: OpenOptions = {}): SqliteDb {
  // Read under both names — see src/config/legacy.ts. CI pins the fallback
  // driver through this variable, and a rename that quietly stopped honouring
  // it would leave the second CI run silently testing the SAME driver twice
  // while still reporting two passes.
  if (readEnv("SQLITE") === "node") return openNodeSqlite(file, opts);
  return openBetterSqlite(file, opts) ?? openNodeSqlite(file, opts);
}

// ── Folding the write-ahead log into the database file ───────────────────────
// Lives here rather than in the caller because it is a property of the storage
// engine, and because the caller that needs it — scripts/container-boot.mjs —
// is a plain script the test suite cannot reach. A rule nobody can test is a
// rule that quietly stops being true, which is exactly the history of this one:
// the boot script's comment claimed the WAL was folded in before each snapshot
// and the code never did it, so every checkpoint shipped a database missing
// whatever was still in orion.db-wal. On a quiet instance that was hours of
// work, and the snapshot was VALID — just old — so nothing anywhere reported a
// problem.

export interface WalFoldResult {
  /** 1 when another connection prevented the fold. Nothing was moved. */
  busy: number;
  /** Frames left in the WAL afterwards. 0 after a successful TRUNCATE. */
  log: number;
  /** Frames moved into the main file. */
  checkpointed: number;
}

/**
 * Fold every committed write out of `file`'s WAL and into `file` itself, so a
 * byte-for-byte copy of that one file is a complete database.
 *
 * TRUNCATE rather than PASSIVE. PASSIVE moves what it can and reports success
 * even when it moved nothing, which is indistinguishable from the bug this
 * replaces. TRUNCATE also resets the WAL to zero bytes, so its size afterwards
 * is an independent check on the claim rather than a second reading of it.
 *
 * THROWS when the fold cannot be done. That is deliberate and the caller must
 * not swallow it: a snapshot known to be incomplete is worse than no snapshot,
 * because it is indistinguishable from a good one at restore time.
 */
export function foldWal(file: string): WalFoldResult {
  // A second connection to a database another process is using is exactly what
  // WAL exists to permit; openDatabase sets a busy timeout so a concurrent
  // writer is waited for rather than failed.
  const db = openDatabase(file, {});
  try {
    const row = (db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() ?? {}) as Partial<WalFoldResult>;
    const result: WalFoldResult = {
      busy: Number(row.busy ?? 0),
      log: Number(row.log ?? 0),
      checkpointed: Number(row.checkpointed ?? 0),
    };
    if (result.busy === 1) {
      throw new Error("wal_checkpoint reported busy — another connection held the database, so nothing was folded in");
    }
    return result;
  } finally {
    db.close();
  }
}
