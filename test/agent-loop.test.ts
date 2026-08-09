import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { runTurn, sessionTitleFrom, type RunnerDeps } from "../src/agent/runner.js";
import { MemoryStore } from "../src/memory/store.js";
import { ToolRegistry, defineTool } from "../src/tools/registry.js";
import { loadConfig, type Config } from "../src/config/config.js";
import { toOpenAIMessages } from "../src/providers/openai.js";
import type {
  ModelProvider,
  NormalizedBlock,
  NormalizedMessage,
  ProviderEvent,
  StopReason,
  TurnRequest,
} from "../src/providers/types.js";
import type { AgentEvent } from "../src/shared/events.js";

// ── A runnable agent loop, without a real model or network ───────────────────
// runTurn is the heart of the product and had no direct coverage; every bug in
// this file is one that survived 1,866 tests because none of them drove the loop.

/** A provider scripted turn by turn: each entry is one model response. */
class ScriptedProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model = "test";
  private turn = 0;
  lastRequest?: TurnRequest;
  constructor(private script: Array<{ stopReason: StopReason; assistant: NormalizedBlock[] }>) {}
  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    this.lastRequest = req;
    const step = this.script[Math.min(this.turn, this.script.length - 1)];
    this.turn++;
    for (const b of step.assistant) {
      if (b.type === "tool_use") yield { type: "tool_call", id: b.id, name: b.name, input: b.input };
    }
    yield { type: "turn_end", stopReason: step.stopReason, assistant: step.assistant };
  }
}

let home: string;
let store: MemoryStore;
let config: Config;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "aclaw-loop-"));
  store = new MemoryStore(path.join(home, "db.sqlite"));
  config = loadConfig({ workspaceRoot: home, approvalPolicy: "never" });
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function deps(provider: ModelProvider, registry: ToolRegistry, events: AgentEvent[]): RunnerDeps {
  return {
    provider,
    registry,
    store,
    config,
    requestApproval: async () => true,
    emit: (e) => events.push(e),
  };
}

const echoTool = defineTool({
  name: "echo",
  description: "echo",
  schema: z.object({ text: z.string() }),
  assessRisk: () => ({ level: "safe", reason: "" }),
  execute: async (input) => ({ content: `echoed:${input.text}` }),
});

describe("runTurn — history stays replayable", () => {
  it("does not persist a dangling tool_use when the turn is cut off at max_tokens", async () => {
    // The model emitted a tool_use, then the budget ran out mid-call. If that
    // tool_use is stored with no tool_result to follow, the next request is a
    // shape the Anthropic/OpenAI APIs reject with a 400 — every later turn dies.
    const provider = new ScriptedProvider([
      {
        stopReason: "max_tokens",
        assistant: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "toolu_01", name: "echo", input: { text: "hi" } },
        ],
      },
    ]);
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const events: AgentEvent[] = [];
    const session = store.createSession();

    await runTurn(deps(provider, registry, events), session.id, "hello");

    const stored = store.loadMessages(session.id).map((r) => JSON.parse(r.content_json) as NormalizedBlock[]);
    const toolUseIds = stored.flat().filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id);
    const toolResultIds = stored.flat().filter((b) => b.type === "tool_result").map((b) => (b as { toolUseId: string }).toolUseId);
    const dangling = toolUseIds.filter((id) => !toolResultIds.includes(id));
    expect(dangling).toEqual([]);
    // The text is kept — only the orphaned call is dropped.
    expect(JSON.stringify(stored)).toContain("let me check");
    expect(events.some((e) => e.type === "turn_completed")).toBe(true);
  });

  it("executes tools and appends a tool_result on a normal tool_use stop", async () => {
    const provider = new ScriptedProvider([
      { stopReason: "tool_use", assistant: [{ type: "tool_use", id: "toolu_A", name: "echo", input: { text: "yo" } }] },
      { stopReason: "end_turn", assistant: [{ type: "text", text: "done" }] },
    ]);
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const events: AgentEvent[] = [];
    const session = store.createSession();

    await runTurn(deps(provider, registry, events), session.id, "go");

    const stored = store.loadMessages(session.id).map((r) => JSON.parse(r.content_json) as NormalizedBlock[]).flat();
    const result = stored.find((b) => b.type === "tool_result") as { content: string } | undefined;
    expect(result?.content).toBe("echoed:yo");
  });
});

describe("runTurn — failure handling", () => {
  it("turns a store write failure into an error event, not an unhandled rejection", async () => {
    // A SQLITE_BUSY or full disk on the very first persist used to escape the
    // voided promise at the gateway and take the whole process down.
    const provider = new ScriptedProvider([{ stopReason: "end_turn", assistant: [{ type: "text", text: "hi" }] }]);
    const registry = new ToolRegistry();
    const events: AgentEvent[] = [];
    const brokenStore = {
      appendMessage() {
        const e = new Error("database is locked") as Error & { code: string };
        e.code = "SQLITE_BUSY";
        throw e;
      },
    } as unknown as MemoryStore;
    const brokenDeps = { ...deps(provider, registry, events), store: brokenStore };

    await expect(runTurn(brokenDeps, "s1", "hello")).resolves.toBeUndefined();
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("emits turn_completed as well as error when the tool-round cap is hit", async () => {
    // A model that loops forever must still return the CLI its prompt.
    const provider = new ScriptedProvider([
      { stopReason: "tool_use", assistant: [{ type: "tool_use", id: "loop", name: "echo", input: { text: "x" } }] },
    ]);
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const events: AgentEvent[] = [];
    const session = store.createSession();

    await runTurn(deps(provider, registry, events), session.id, "loop please");

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "turn_completed")).toBe(true);
  });
});

describe("sessionTitleFrom", () => {
  it("strips the web client's attachment preamble", () => {
    const input = "[The user attached 1 file(s).]\n- eob.pdf (pdf, 900 characters) — document id doc_1\n\nWhat was denied?";
    expect(sessionTitleFrom(input)).toBe("What was denied?");
  });
  it("keeps a user's own bracketed first line", () => {
    const input = "[URGENT] CLM-1042 denied by Aetna\n\nWhat are my appeal options?";
    // The identifying first line must survive — the old loose bracket test deleted it.
    expect(sessionTitleFrom(input)).toContain("[URGENT] CLM-1042 denied by Aetna");
  });
});

describe("toOpenAIMessages — cross-provider replay", () => {
  it("drops an assistant message that is only Anthropic-only blocks rather than emitting null content", () => {
    // An Anthropic turn that paused for server web search with no preamble
    // persists [provider_raw] only; replayed to OpenAI those blocks vanish, and
    // {content: null} with no tool_calls is a 400 on every turn.
    const messages: NormalizedMessage[] = [
      { role: "user", content: [{ type: "text", text: "search please" }] },
      { role: "assistant", content: [{ type: "provider_raw", provider: "anthropic", raw: { type: "server_tool_use" } }] },
    ];
    const out = toOpenAIMessages("system", messages);
    const assistants = out.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(0);
    expect(out.some((m) => (m as { content: unknown }).content === null)).toBe(false);
  });
});
