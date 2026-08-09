import { createRequire } from "node:module";

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
      const name = `aetheraclaw_sp_${depth++}`;
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
  } catch {
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
 * `AETHERACLAW_SQLITE=node` forces the built-in, which is how the test suite
 * exercises the fallback on a machine where the native module installed fine.
 * A fallback nobody runs is a fallback that does not work.
 */
export function openDatabase(file: string, opts: OpenOptions = {}): SqliteDb {
  if (process.env.AETHERACLAW_SQLITE === "node") return openNodeSqlite(file, opts);
  return openBetterSqlite(file, opts) ?? openNodeSqlite(file, opts);
}
