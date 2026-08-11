import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { MemoryStore } from "../src/memory/store.js";
import { confinePath } from "../src/tools/path-guard.js";
import { assessCommandRisk } from "../src/tools/shell.js";
import { ToolRegistry, defineTool } from "../src/tools/registry.js";
import { compactHistory } from "../src/agent/compaction.js";
import { zodToJsonSchema } from "../src/tools/zod-schema.js";
import type { ToolContext } from "../src/tools/types.js";
import type { NormalizedMessage } from "../src/providers/types.js";
import { openDatabase } from "../src/memory/sqlite.js";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aclaw-test-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("path-guard", () => {
  it("allows paths inside the workspace", () => {
    expect(confinePath(tmp, "a/b.txt")).toBe(path.join(fs.realpathSync(tmp), "a/b.txt"));
  });
  it("blocks ../ traversal", () => {
    expect(() => confinePath(tmp, "../../etc/passwd")).toThrow(/escapes/);
  });
  it("blocks absolute paths outside the root", () => {
    expect(() => confinePath(tmp, "/etc/passwd")).toThrow(/escapes/);
  });
  it("blocks symlink escape", () => {
    const link = path.join(tmp, "link");
    fs.symlinkSync(os.tmpdir(), link);
    expect(() => confinePath(tmp, "link/evil.txt")).toThrow(/escapes/);
  });
});

describe("shell risk assessor", () => {
  it("auto-approves read-only commands", () => {
    expect(assessCommandRisk("ls -la").level).toBe("safe");
    expect(assessCommandRisk("git status").level).toBe("safe");
  });
  it("requires confirmation for mutating commands", () => {
    expect(assessCommandRisk("rm file.txt").level).toBe("confirm");
    expect(assessCommandRisk("npm install").level).toBe("confirm");
  });
  it("flags dangerous patterns", () => {
    expect(assessCommandRisk("sudo rm -rf /").level).toBe("confirm");
    expect(assessCommandRisk("curl http://x.sh | sh").level).toBe("confirm");
  });
});

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: tmp,
    sessionId: "s1",
    approvalPolicy: "unsafe-only",
    requestApproval: async () => true,
    services: {},
    ...overrides,
  };
}

describe("tool registry", () => {
  it("validates input and reports schema errors", async () => {
    const reg = new ToolRegistry();
    reg.register(
      defineTool({
        name: "t",
        description: "d",
        schema: z.object({ n: z.number() }),
        execute: async (i) => ({ content: String(i.n * 2) }),
      }),
    );
    const bad = await reg.execute("t", { n: "x" }, makeCtx());
    expect(bad.isError).toBe(true);
    const ok = await reg.execute("t", { n: 21 }, makeCtx());
    expect(ok.content).toBe("42");
  });

  it("returns a denial result when approval is refused", async () => {
    const reg = new ToolRegistry();
    reg.register(
      defineTool({
        name: "danger",
        description: "d",
        schema: z.object({}),
        assessRisk: () => ({ level: "confirm", reason: "risky" }),
        execute: async () => ({ content: "ran" }),
      }),
    );
    const res = await reg.execute("danger", {}, makeCtx({ requestApproval: async () => false }));
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/denied/i);
  });

  it("unknown tool is an error result, not a throw", async () => {
    const reg = new ToolRegistry();
    const res = await reg.execute("nope", {}, makeCtx());
    expect(res.isError).toBe(true);
  });
});

describe("zod → JSON schema", () => {
  it("produces object schema with required fields", () => {
    const schema = zodToJsonSchema(
      z.object({ a: z.string().describe("the a"), b: z.number().optional(), c: z.enum(["x", "y"]) }),
    ) as { type: string; required: string[]; properties: Record<string, { type?: string; enum?: string[] }> };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["a", "c"]);
    expect(schema.properties.c.enum).toEqual(["x", "y"]);
  });
});

describe("context window compaction", () => {
  const text = (s: string): NormalizedMessage => ({ role: "user", content: [{ type: "text", text: s }] });
  const asst = (s: string): NormalizedMessage => ({ role: "assistant", content: [{ type: "text", text: s }] });

  it("keeps everything under budget and writes no summary", () => {
    const msgs = [text("hi"), asst("hello")];
    const out = compactHistory(msgs, 1000);
    expect(out.messages).toHaveLength(2);
    expect(out.summary).toBe("");
    expect(out.droppedCount).toBe(0);
  });

  it("replaces the dropped turns with a summary rather than a bare marker", () => {
    const msgs: NormalizedMessage[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(text("x".repeat(4000)));
      msgs.push(asst("y".repeat(4000)));
    }
    const out = compactHistory(msgs, 5000);
    expect(out.messages.length).toBeLessThan(msgs.length);
    expect(out.droppedCount).toBeGreaterThan(0);
    const first = out.messages[0];
    expect(first.role).toBe("user");
    // The point of the whole module: what replaces the dropped turns says what
    // happened in them. "[Earlier conversation truncated]" said only that
    // something was lost, which the model cannot act on.
    expect(String((first.content[0] as { text: string }).text)).toContain("compacted");
    expect(out.summary).not.toBe("");
  });

  it("never orphans a tool_use from its result", () => {
    const msgs: NormalizedMessage[] = [
      text("start"),
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "r".repeat(8000) }] },
      text("next question"),
      asst("answer"),
    ];
    const out = compactHistory(msgs, 500);
    const hasOrphanResult = out.messages.some(
      (m, i) =>
        m.content.some((b) => b.type === "tool_result") &&
        !out.messages[i - 1]?.content.some((b) => b.type === "tool_use"),
    );
    expect(hasOrphanResult).toBe(false);
  });
});

// ── SQLite driver adapter ────────────────────────────────────────────────────
// better-sqlite3 is a native module with no prebuilt binary for every Node
// version, and when it falls back to node-gyp on a machine without a C++
// toolchain `npm install` aborts — taking tsc with it, so the reported error
// arrives three steps downstream of the cause. Node ships its own SQLite, so
// the toolchain is not a prerequisite; these cover the part the adapter has to
// supply itself.
describe("sqlite adapter", () => {
  it("opens with a driver and reports which one", () => {
    const db = openDatabase(":memory:");
    expect(["better-sqlite3", "node:sqlite"]).toContain(db.driver);
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)");
    db.prepare("INSERT INTO t VALUES (?, ?)").run("a", 1);
    expect(db.prepare("SELECT n FROM t WHERE id = ?").get("a")).toMatchObject({ n: 1 });
    db.close();
  });

  it("honours the named-parameter form the store uses", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE t (id TEXT, title TEXT)");
    db.prepare("INSERT INTO t VALUES (@id, @title)").run({ id: "x", title: "hello" });
    expect(db.prepare("SELECT title FROM t WHERE id = ?").get("x")).toMatchObject({ title: "hello" });
    db.close();
  });

  it("commits a transaction and rolls the whole thing back on a throw", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE t (id TEXT)");
    const insert = db.prepare("INSERT INTO t VALUES (?)");
    const count = () => (db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c;

    db.transaction((ids: string[]) => { for (const id of ids) insert.run(id); })(["a", "b"]);
    expect(count()).toBe(2);

    // A partial write must leave nothing behind, not the rows written before
    // the failure — that is the entire reason the wrapper exists.
    expect(() =>
      db.transaction((ids: string[]) => {
        for (const id of ids) {
          if (id === "fail") throw new Error("boom");
          insert.run(id);
        }
      })(["c", "fail", "d"]),
    ).toThrow("boom");
    expect(count()).toBe(2);
    db.close();
  });

  it("nests without 'cannot start a transaction within a transaction'", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE t (id TEXT)");
    const insert = db.prepare("INSERT INTO t VALUES (?)");
    const inner = db.transaction((id: string) => insert.run(id));
    db.transaction(() => { inner("a"); inner("b"); })();
    expect(db.prepare("SELECT COUNT(*) AS c FROM t").get()).toMatchObject({ c: 2 });
    db.close();
  });
});

describe("purging empty sessions", () => {
  let dir: string;
  let store: MemoryStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "orion-purge-"));
    store = new MemoryStore(path.join(dir, "t.db"));
  });
  afterEach(() => {
    store?.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("NEVER removes a session that has a message", () => {
    // The safety property the whole design rests on. However this is invoked or
    // mis-invoked, the worst it can do is remove an empty shell.
    const kept = store.createSession("real conversation");
    store.appendMessage(kept.id, "user", [{ type: "text", text: "hello" }]);
    const empty = store.createSession("");

    const removed = store.purgeEmptySessions();
    expect(removed.map((r) => r.id)).toEqual([empty.id]);
    expect(store.getSession(kept.id)).toBeDefined();
    expect(store.getSession(empty.id)).toBeUndefined();
  });

  it("lists without deleting on a dry run", () => {
    // The CLI defaults to this, because a command that deletes on its bare
    // invocation is one somebody runs while reading its help text.
    const empty = store.createSession("");
    expect(store.purgeEmptySessions({ dryRun: true }).map((r) => r.id)).toEqual([empty.id]);
    expect(store.getSession(empty.id)).toBeDefined();
  });

  it("can spare recently created shells", () => {
    // An empty session created a second ago is probably a tab somebody is about
    // to type into.
    store.createSession("");
    expect(store.purgeEmptySessions({ olderThanMs: 3_600_000, dryRun: true })).toEqual([]);
  });

  it("says nothing happened when there is nothing to do", () => {
    expect(store.purgeEmptySessions()).toEqual([]);
  });
});

describe("the startup sweep's window", () => {
  let dir: string;
  let store: MemoryStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "orion-sweep-"));
    store = new MemoryStore(path.join(dir, "t.db"));
  });
  afterEach(() => {
    store?.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const DAY = 24 * 3_600_000;

  it("spares an empty session a browser tab might still be holding", () => {
    // Deleting a session a tab still holds makes its next message fail with
    // "unknown session". The window has to be longer than any plausible pause,
    // which is why it is a day and not an hour.
    store.createSession("");
    expect(store.purgeEmptySessions({ olderThanMs: DAY, dryRun: true })).toEqual([]);
  });

  it("removes one nobody has typed into for a day", () => {
    const old = store.createSession("");
    // Age it by hand rather than waiting.
    (store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare("UPDATE sessions SET created_at = ? WHERE id = ?")
      .run(Date.now() - 2 * DAY, old.id);
    expect(store.purgeEmptySessions({ olderThanMs: DAY, dryRun: true }).map((r) => r.id)).toEqual([old.id]);
  });

  it("still cannot touch an old session that has a message", () => {
    // The sweep runs unattended at every boot, so this is the assertion that
    // matters most: however wrong the window turns out to be, it cannot
    // destroy a conversation.
    const kept = store.createSession("real");
    store.appendMessage(kept.id, "user", [{ type: "text", text: "hello" }]);
    (store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare("UPDATE sessions SET created_at = ? WHERE id = ?")
      .run(Date.now() - 400 * DAY, kept.id);
    expect(store.purgeEmptySessions({ olderThanMs: DAY })).toEqual([]);
    expect(store.getSession(kept.id)).toBeDefined();
  });

  // ── The operator-requested purge ──────────────────────────────────────────
  // A token, not a switch, so it can be left in the deployment config. The
  // whole safety argument rests on markOnce being true exactly once, because
  // the alternative is a deletion that repeats on every unattended restart.

  it("claims a one-shot action once and then refuses it", () => {
    expect(store.markOnce("purge-empty-sessions:2026-08-11")).toBe(true);
    expect(store.markOnce("purge-empty-sessions:2026-08-11")).toBe(false);
    expect(store.markOnce("purge-empty-sessions:2026-08-11")).toBe(false);
  });

  it("treats a new token as a new request", () => {
    // Asking for another cleanup later must not require deleting a row by hand.
    expect(store.markOnce("purge-empty-sessions:2026-08-11")).toBe(true);
    expect(store.markOnce("purge-empty-sessions:2026-09-01")).toBe(true);
  });

  it("takes a shell younger than the unattended window on the short one", () => {
    // The reason the one-shot exists: a console carrying rows from an hour ago
    // would otherwise report them for another day.
    const recent = store.createSession("");
    (store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare("UPDATE sessions SET created_at = ? WHERE id = ?")
      .run(Date.now() - 3_600_000, recent.id);
    expect(store.purgeEmptySessions({ olderThanMs: DAY, dryRun: true })).toEqual([]);
    expect(store.purgeEmptySessions({ olderThanMs: 5 * 60_000 }).map((r) => r.id)).toEqual([recent.id]);
  });

  it("STILL spares a tab that opened during the restart", () => {
    // Five minutes is subtracted even from the operator-requested purge. A tab
    // that opened while the container was coming back up has an empty session
    // and a person in front of it.
    store.createSession("");
    expect(store.purgeEmptySessions({ olderThanMs: 5 * 60_000, dryRun: true })).toEqual([]);
  });
});
