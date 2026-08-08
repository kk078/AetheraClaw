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

export class MemoryStore {
  readonly db: SqliteDb;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = openDatabase(dbPath);
    this.db.pragma("journal_mode = WAL");
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

  close(): void {
    this.db.close();
  }
}
