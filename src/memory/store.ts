import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newId } from "../shared/ids.js";
import { openDatabase, type SqliteDb } from "./sqlite.js";

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

  close(): void {
    this.db.close();
  }
}
