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
        exec(`ROLLBACK TO ${name}`);
        exec(`RELEASE ${name}`);
        throw err;
      } finally {
        depth--;
      }
    };
}

function openNodeSqlite(file: string): SqliteDb {
  // Present from Node 22.5; stable enough to depend on, and the only SQLite a
  // default Windows install is guaranteed to have.
  const { DatabaseSync } = require_("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): SqliteStatement;
      exec(sql: string): void;
      close(): void;
    };
  };
  const db = new DatabaseSync(file);
  const exec = (sql: string) => db.exec(sql);
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

function openBetterSqlite(file: string): SqliteDb | null {
  let Database: new (path: string) => {
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
  const db = new Database(file);
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
export function openDatabase(file: string): SqliteDb {
  if (process.env.AETHERACLAW_SQLITE === "node") return openNodeSqlite(file);
  return openBetterSqlite(file) ?? openNodeSqlite(file);
}
