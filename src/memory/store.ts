import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newId } from "../shared/ids.js";
import { openDatabase, type SqliteDb } from "./sqlite.js";
import type { RetentionPlan, ToolCallRecord } from "../support/tool-log.js";
import { totalPruned, type ViewPruneResult } from "../views/retention.js";

export interface SessionRow {
  id: string;
  title: string;
  provider: string;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: "user" | "assistant";
  content_json: string;
  stop_reason: string | null;
  created_at: number;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Make a database owner-only.
 *
 * SQLite also creates `-wal` and `-shm` siblings, and the WAL holds recently
 * written rows — leaving it readable would defeat the point of locking down the
 * main file. Windows does not model POSIX permissions, so chmod there is a
 * no-op the platform reports as success; the check that reads these back knows
 * not to report a mode on Windows for the same reason.
 *
 * Failures are swallowed deliberately: a filesystem that cannot represent these
 * modes (a mounted share, a container volume) must not stop the application from
 * starting. ops_tenant_integrity_check reads the modes back and reports what is
 * actually on disk, which is the honest place for that to surface.
 */
export function restrictPermissions(dbPath: string): void {
  try {
    fs.chmodSync(path.dirname(dbPath), 0o700);
  } catch {
    /* not representable here */
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      if (fs.existsSync(dbPath + suffix)) fs.chmodSync(dbPath + suffix, 0o600);
    } catch {
      /* not representable here */
    }
  }
}

export class MemoryStore {
  readonly db: SqliteDb;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = openDatabase(dbPath);
    this.db.pragma("journal_mode = WAL");
    // Tighten permissions AFTER the driver has created the file. Databases were
    // being created at whatever the umask allowed — 0644 on a default Linux
    // install — which in the database-per-tenant design means every tenant's
    // claims were world-readable. Found by ops_tenant_integrity_check on its
    // first real run, which is the entire argument for having built it.
    restrictPermissions(dbPath);
    this.db.pragma("foreign_keys = ON");
    const schemaFile = path.join(here, "schema.sql");
    // In dev (tsx) schema.sql sits next to the .ts; after tsc it must be copied — fall back to src.
    const sql = fs.existsSync(schemaFile)
      ? fs.readFileSync(schemaFile, "utf8")
      : fs.readFileSync(path.join(here, "../../src/memory/schema.sql"), "utf8");
    this.db.exec(sql);
    this.migrate();
  }

  /**
   * Columns added to a table that already existed.
   *
   * schema.sql is replayed in full on every open, and `CREATE TABLE IF NOT
   * EXISTS` leaves an existing table exactly as it was — so a column added to
   * that statement reaches new databases only, and every install that predates
   * it silently lacks the column until something throws "no such column" at
   * runtime.
   *
   * A bare `ALTER TABLE` in schema.sql is not the fix either: it succeeds once
   * and then throws "duplicate column name" on the next open, which would break
   * every install that had already run it. So the check happens here, against
   * pragma_table_info, and adding a column is a no-op the second time.
   */
  private migrate(): void {
    this.addColumnIfMissing("documents", "archive_id", "TEXT NOT NULL DEFAULT ''");
    // Indexed here rather than in schema.sql because the column may have only
    // just been added above — schema.sql runs first, and an index over a column
    // an older database does not have yet fails the whole open.
    try {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_documents_archive ON documents(archive_id)");
    } catch {
      /* the query works without the index; a missing index is slow, not wrong */
    }
  }

  private addColumnIfMissing(table: string, column: string, declaration: string): void {
    try {
      const cols = this.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>;
      // A table that does not exist yet needs nothing — schema.sql just created
      // it with the column already in place.
      if (cols.length === 0 || cols.some((c) => c.name === column)) return;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    } catch {
      // A migration that cannot run must not stop the store opening: the caller
      // gets "no such column" from the specific query that needs it, which is a
      // far more locatable failure than a database that will not open at all.
    }
  }

  createSession(title = "", provider = "anthropic"): SessionRow {
    const now = Date.now();
    const row: SessionRow = { id: newId("sess"), title, provider, created_at: now, updated_at: now };
    this.db
      .prepare(
        "INSERT INTO sessions (id, title, provider, created_at, updated_at) VALUES (@id, @title, @provider, @created_at, @updated_at)",
      )
      .run(row);
    return row;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  listSessions(limit = 100): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as SessionRow[];
  }

  setSessionTitle(id: string, title: string): void {
    this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
      .run(title.slice(0, 120), Date.now(), id);
  }

  appendMessage(sessionId: string, role: "user" | "assistant", content: unknown, stopReason?: string): MessageRow {
    const now = Date.now();
    const seqRow = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE session_id = ?")
      .get(sessionId) as { next: number };
    const row: MessageRow = {
      id: newId("msg"),
      session_id: sessionId,
      seq: seqRow.next,
      role,
      content_json: JSON.stringify(content),
      stop_reason: stopReason ?? null,
      created_at: now,
    };
    const insert = this.db.prepare(
      "INSERT INTO messages (id, session_id, seq, role, content_json, stop_reason, created_at) VALUES (@id, @session_id, @seq, @role, @content_json, @stop_reason, @created_at)",
    );
    const touch = this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?");
    this.db.transaction(() => {
      insert.run(row);
      touch.run(now, sessionId);
    })();
    return row;
  }

  loadMessages(sessionId: string): MessageRow[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as MessageRow[];
  }

  /**
   * Save a tool's rendered view.
   *
   * Kept out of `messages` on purpose — see the schema comment. Nothing written
   * here is ever replayed into the model's context.
   */
  saveToolView(sessionId: string, toolUseId: string, view: { kind: string; data: unknown }): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO tool_views (session_id, tool_use_id, kind, data_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sessionId, toolUseId, view.kind, JSON.stringify(view.data), Date.now());
  }

  /** Views for a session, keyed by tool_use_id so the UI can attach them on replay. */
  loadToolViews(sessionId: string): Record<string, { kind: string; data: unknown }> {
    const rows = this.db
      .prepare("SELECT tool_use_id, kind, data_json FROM tool_views WHERE session_id = ?")
      .all(sessionId) as Array<{ tool_use_id: string; kind: string; data_json: string }>;
    const out: Record<string, { kind: string; data: unknown }> = {};
    for (const r of rows) {
      try {
        out[r.tool_use_id] = { kind: r.kind, data: JSON.parse(r.data_json) };
      } catch {
        // A malformed row loses one rendering, not the whole transcript.
      }
    }
    return out;
  }

  /**
   * Record one tool call.
   *
   * Called from the registry's choke point on every invocation, so this runs
   * more often than anything else in the store. It is a single INSERT with no
   * read, and pruning is amortized rather than done here — a retention sweep on
   * every call would make the log's cost scale with the log's size, which is the
   * opposite of what a log should do.
   */
  recordToolCall(record: ToolCallRecord): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, session_id, tool_name, ok, outcome, duration_ms, input_shape, error_text, depth, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("tc"),
        record.sessionId,
        record.toolName,
        record.ok ? 1 : 0,
        record.outcome,
        record.durationMs,
        record.inputShape,
        record.errorText,
        record.depth,
        record.at,
      );
  }

  loadToolCalls(sinceMs: number, opts: { failuresOnly?: boolean; tool?: string; limit?: number } = {}): ToolCallRecord[] {
    const clauses = ["created_at >= ?"];
    const params: unknown[] = [sinceMs];
    if (opts.failuresOnly) clauses.push("ok = 0");
    if (opts.tool) {
      clauses.push("tool_name = ?");
      params.push(opts.tool);
    }
    params.push(opts.limit ?? 1000);

    const rows = this.db
      .prepare(
        `SELECT session_id, tool_name, ok, outcome, duration_ms, input_shape, error_text, depth, created_at
           FROM tool_calls WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params) as Array<{
      session_id: string;
      tool_name: string;
      ok: number;
      outcome: string;
      duration_ms: number;
      input_shape: string;
      error_text: string;
      depth: number;
      created_at: number;
    }>;

    return rows.map((r) => ({
      sessionId: r.session_id,
      toolName: r.tool_name,
      ok: r.ok === 1,
      outcome: r.outcome as ToolCallRecord["outcome"],
      durationMs: r.duration_ms,
      inputShape: r.input_shape,
      errorText: r.error_text,
      depth: r.depth,
      at: r.created_at,
    }));
  }

  /** Drop rows past the age cutoff, then past the row ceiling. Returns how many went. */
  pruneToolCalls(plan: RetentionPlan): number {
    let removed = 0;
    this.db.transaction(() => {
      removed += Number(this.db.prepare("DELETE FROM tool_calls WHERE created_at < ?").run(plan.cutoff).changes);
      // The ceiling is a second, independent bound: a burst inside the retention
      // window can outrun the age rule entirely, and the age rule alone would let
      // it fill the disk while every row was technically recent.
      removed += Number(
        this.db
          .prepare(
            `DELETE FROM tool_calls WHERE id IN (
               SELECT id FROM tool_calls ORDER BY created_at DESC LIMIT -1 OFFSET ?
             )`,
          )
          .run(plan.maxRows).changes,
      );
    })();
    return removed;
  }

  /**
   * Orphans first, then age, then the ceiling — see src/views/retention.ts.
   *
   * Orphans are separated because they are the only category that is pure dead
   * weight: there is no foreign key on tool_views, so every deleted session
   * leaves its rendered views behind permanently. Reporting the three counts
   * separately is what tells an operator whether the table is growing because
   * of real use or because sessions are being deleted.
   */
  pruneToolViews(plan: RetentionPlan): ViewPruneResult {
    const parts = { orphaned: 0, aged: 0, overCeiling: 0 };
    this.db.transaction(() => {
      parts.orphaned = Number(
        this.db
          .prepare("DELETE FROM tool_views WHERE session_id NOT IN (SELECT id FROM sessions)")
          .run().changes,
      );
      parts.aged = Number(this.db.prepare("DELETE FROM tool_views WHERE created_at < ?").run(plan.cutoff).changes);
      parts.overCeiling = Number(
        this.db
          .prepare(
            `DELETE FROM tool_views WHERE rowid IN (
               SELECT rowid FROM tool_views ORDER BY created_at DESC LIMIT -1 OFFSET ?
             )`,
          )
          .run(plan.maxRows).changes,
      );
    })();
    return { ...parts, total: totalPruned(parts) };
  }

  close(): void {
    this.db.close();
  }
}
