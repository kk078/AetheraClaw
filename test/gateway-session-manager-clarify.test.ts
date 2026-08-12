import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../src/gateway/session-manager.js";
import { MemoryStore } from "../src/memory/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { askUserTool } from "../src/tools/ask-user.js";
import { loadConfig, type Config } from "../src/config/config.js";
import type { ModelProvider, NormalizedBlock, ProviderEvent, StopReason, TurnRequest } from "../src/providers/types.js";

// A provider scripted turn by turn, same shape as agent-loop.test.ts's
// ScriptedProvider — here scripted to call ask_user on turn 1 and finish on turn 2,
// so the clarify round trip actually runs through the real tool + registry.
class ScriptedProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model = "test";
  private turn = 0;
  constructor(private script: Array<{ stopReason: StopReason; assistant: NormalizedBlock[] }>) {}
  async *streamTurn(_req: TurnRequest): AsyncIterable<ProviderEvent> {
    const step = this.script[Math.min(this.turn, this.script.length - 1)];
    this.turn++;
    for (const b of step.assistant) {
      if (b.type === "tool_use") yield { type: "tool_call", id: b.id, name: b.name, input: b.input };
    }
    yield { type: "turn_end", stopReason: step.stopReason, assistant: step.assistant };
  }
}

let scriptedProvider: ModelProvider;
vi.mock("../src/providers/index.js", () => ({
  createProvider: () => scriptedProvider,
}));

function fakeSocket(onSend: (msg: Record<string, unknown>) => void) {
  return {
    readyState: 1,
    OPEN: 1,
    send: (payload: string) => onSend(JSON.parse(payload)),
    on: () => {},
  } as unknown as import("ws").WebSocket;
}

let home: string;
let store: MemoryStore;
let config: Config;
let registry: ToolRegistry;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "aclaw-clarify-"));
  store = new MemoryStore(path.join(home, "db.sqlite"));
  config = loadConfig({ workspaceRoot: home, approvalPolicy: "never" });
  registry = new ToolRegistry();
  registry.register(askUserTool);
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("SessionManager — clarifying-question wiring", () => {
  it("broadcasts clarify_request, waits, and resumes the SAME turn once resolveClarification answers it", async () => {
    scriptedProvider = new ScriptedProvider([
      { stopReason: "tool_use", assistant: [{ type: "tool_use", id: "toolu_ask", name: "ask_user", input: { question: "Which claim?" } }] },
      { stopReason: "end_turn", assistant: [{ type: "text", text: "Got it, using the Tuesday claim." }] },
    ]);
    const sm = new SessionManager(store, registry, config);
    const session = store.createSession();
    const messages: Record<string, unknown>[] = [];
    sm.subscribe(session.id, fakeSocket((m) => messages.push(m)));

    const turnPromise = sm.handleUserMessage(session.id, "resolve my claim question");

    await vi.waitFor(() => {
      expect(messages.some((m) => m.type === "clarify_request")).toBe(true);
    });
    const request = messages.find((m) => m.type === "clarify_request") as { clarifyId: string; question: string };
    expect(request.question).toBe("Which claim?");
    // No turn_started fired a second time while the question was pending — this
    // is a pause inside the SAME turn, not a new one.
    expect(messages.filter((m) => m.type === "turn_started")).toHaveLength(1);

    expect(sm.resolveClarification(request.clarifyId, "the Tuesday claim")).toBe(true);
    await turnPromise;

    expect(messages.some((m) => m.type === "clarify_resolved" && m.answer === "the Tuesday claim")).toBe(true);
    expect(messages.filter((m) => m.type === "turn_started")).toHaveLength(1);
    expect(messages.some((m) => m.type === "turn_completed")).toBe(true);

    const stored = store.loadMessages(session.id).map((r) => JSON.parse(r.content_json) as NormalizedBlock[]).flat();
    const result = stored.find((b) => b.type === "tool_result") as { content: string } | undefined;
    expect(result?.content).toBe("User answered: the Tuesday claim");
  });

  it("broadcasts clarify_resolved with answer: null on timeout, and the tool reports it as an error", async () => {
    scriptedProvider = new ScriptedProvider([
      { stopReason: "tool_use", assistant: [{ type: "tool_use", id: "toolu_ask", name: "ask_user", input: { question: "Which payer?" } }] },
      { stopReason: "end_turn", assistant: [{ type: "text", text: "No answer, proceeding carefully." }] },
    ]);
    // A short timeout so the test does not wait two real minutes.
    config = loadConfig({ workspaceRoot: home, approvalPolicy: "never", clarify: { enabled: true, timeoutMs: 30 } });
    const sm = new SessionManager(store, registry, config);
    const session = store.createSession();
    const messages: Record<string, unknown>[] = [];
    sm.subscribe(session.id, fakeSocket((m) => messages.push(m)));

    await sm.handleUserMessage(session.id, "ask something that will time out");

    const resolved = messages.find((m) => m.type === "clarify_resolved") as { answer: string | null };
    expect(resolved.answer).toBeNull();

    const stored = store.loadMessages(session.id).map((r) => JSON.parse(r.content_json) as NormalizedBlock[]).flat();
    const result = stored.find((b) => b.type === "tool_result") as { content: string; isError?: boolean } | undefined;
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("timed out");
  });

  it("does not wire a clarification channel when clarify.enabled is false — ask_user degrades gracefully", async () => {
    scriptedProvider = new ScriptedProvider([
      { stopReason: "tool_use", assistant: [{ type: "tool_use", id: "toolu_ask", name: "ask_user", input: { question: "Which claim?" } }] },
      { stopReason: "end_turn", assistant: [{ type: "text", text: "ok" }] },
    ]);
    config = loadConfig({ workspaceRoot: home, approvalPolicy: "never", clarify: { enabled: false, timeoutMs: 120_000 } });
    const sm = new SessionManager(store, registry, config);
    const session = store.createSession();
    const messages: Record<string, unknown>[] = [];
    sm.subscribe(session.id, fakeSocket((m) => messages.push(m)));

    await sm.handleUserMessage(session.id, "ask something");

    expect(messages.some((m) => m.type === "clarify_request")).toBe(false);
    const stored = store.loadMessages(session.id).map((r) => JSON.parse(r.content_json) as NormalizedBlock[]).flat();
    const result = stored.find((b) => b.type === "tool_result") as { content: string; isError?: boolean } | undefined;
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("not available in this session");
  });

  it("resolveClarification is a thin passthrough to the underlying registry", () => {
    const sm = new SessionManager(store, registry, config);
    expect(sm.resolveClarification("clar_does_not_exist", "anything")).toBe(false);
  });
});
