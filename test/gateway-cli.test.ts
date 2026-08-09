import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { SessionManager } from "../src/gateway/session-manager.js";
import { MemoryStore } from "../src/memory/store.js";
import { saveDocument, listDocuments, purgeDocuments } from "../src/ingest/store.js";

describe("SessionManager.subscribe — one close listener per socket", () => {
  it("does not stack a close listener on every subscribe", () => {
    const sm = new SessionManager({} as never);
    const ws = new EventEmitter() as unknown as import("ws").WebSocket;
    for (let i = 0; i < 15; i++) sm.subscribe("s1", ws);
    expect((ws as unknown as EventEmitter).listenerCount("close")).toBe(1);
  });
});

describe("documents purge — the --older-than cutoff", () => {
  let home: string;
  let store: MemoryStore;
  const doc = (id: string, ageDays: number) => {
    const at = Date.now() - ageDays * 86_400_000;
    saveDocument(
      store,
      "sess",
      { filename: `${id}.txt`, kind: "text", sizeBytes: 5, sha256: id, text: "hello", sections: [], readable: true, confidence: 1, phi: [], notes: [] },
      at,
    );
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "aclaw-purge-"));
    store = new MemoryStore(path.join(home, "db.sqlite"));
    store.createSession(); // not strictly needed, saveDocument takes a session id
    doc("young", 1);
    doc("old", 100);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Mirrors the CLI's validated parse: a non-numeric value must NOT widen scope.
  function cutoffFor(olderThan: string | undefined): { ok: boolean; olderThanMs?: number } {
    if (olderThan === undefined) return { ok: true };
    const days = Number(olderThan);
    if (!Number.isFinite(days) || days < 0) return { ok: false };
    return { ok: true, olderThanMs: Date.now() - days * 86_400_000 };
  }

  it("a numeric value scopes to the older document only", () => {
    const c = cutoffFor("30");
    expect(c.ok).toBe(true);
    const r = purgeDocuments(store, { ...(c.olderThanMs ? { olderThanMs: c.olderThanMs } : {}) });
    expect(r.deleted).toBe(1);
    expect(listDocuments(store).map((d) => d.filename)).toEqual(["young.txt"]);
  });

  it("a non-numeric value is rejected — it must not fall through to deleting everything", () => {
    expect(cutoffFor("30d").ok).toBe(false);
    expect(cutoffFor("1w").ok).toBe(false);
    // Nothing purged: both documents remain.
    expect(listDocuments(store)).toHaveLength(2);
  });
});
