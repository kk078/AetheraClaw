import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../src/gateway/session-manager.js";
import { MemoryStore } from "../src/memory/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loadConfig, type Config } from "../src/config/config.js";
import type { ModelProvider, NormalizedBlock, ProviderEvent, StopReason, TurnRequest } from "../src/providers/types.js";

// Unlike agent-loop.test.ts's ScriptedProvider, this one ALSO streams text_delta
// for text blocks — the real providers do, and the persona wiring only has
// anything to paraphrase if the accumulated assistantText is non-empty.
class TextScriptedProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model = "test";
  private turn = 0;
  constructor(private script: Array<{ stopReason: StopReason; assistant: NormalizedBlock[] }>) {}
  async *streamTurn(_req: TurnRequest): AsyncIterable<ProviderEvent> {
    const step = this.script[Math.min(this.turn, this.script.length - 1)];
    this.turn++;
    for (const b of step.assistant) {
      if (b.type === "text") yield { type: "text_delta", text: b.text };
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
let registry: ToolRegistry;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "aclaw-voice-"));
  store = new MemoryStore(path.join(home, "db.sqlite"));
  registry = new ToolRegistry();
  scriptedProvider = new TextScriptedProvider([
    { stopReason: "end_turn", assistant: [{ type: "text", text: "Your clean claim rate is 92.5% this month." }] },
  ]);
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

async function driveTurn(config: Config, source?: "voice") {
  const sm = new SessionManager(store, registry, config);
  const session = store.createSession();
  const messages: Record<string, unknown>[] = [];
  sm.subscribe(session.id, fakeSocket((m) => messages.push(m)));
  await sm.handleUserMessage(session.id, "what is my clean claim rate", source ? { source } : {});
  // The persona reply is fired fire-and-forget, after turn_completed — with a
  // fake provider it resolves near-instantly, but it is still a separate
  // microtask chain, so give it a turn to land before asserting.
  await new Promise((r) => setTimeout(r, 50));
  return messages;
}

describe("SessionManager — persona-paraphrased spoken replies", () => {
  it("broadcasts persona_reply, with non-empty text, after turn_completed for a voice-originated turn", async () => {
    const config = loadConfig({ workspaceRoot: home, approvalPolicy: "never", speech: { enabled: true } });
    const messages = await driveTurn(config, "voice");

    const completedIdx = messages.findIndex((m) => m.type === "turn_completed");
    const personaIdx = messages.findIndex((m) => m.type === "persona_reply");
    expect(completedIdx).toBeGreaterThanOrEqual(0);
    expect(personaIdx).toBeGreaterThan(completedIdx);

    const persona = messages[personaIdx] as { text: string };
    expect(persona.text.trim().length).toBeGreaterThan(0);
  });

  it("does NOT broadcast persona_reply for a typed turn (source omitted) — zero behavior change for text clients", async () => {
    const config = loadConfig({ workspaceRoot: home, approvalPolicy: "never", speech: { enabled: true } });
    const messages = await driveTurn(config); // no source

    expect(messages.some((m) => m.type === "turn_completed")).toBe(true);
    expect(messages.some((m) => m.type === "persona_reply")).toBe(false);
  });

  it("does NOT broadcast persona_reply when speech.persona.enabled is false, even for a voice-originated turn", async () => {
    const config = loadConfig({
      workspaceRoot: home,
      approvalPolicy: "never",
      speech: { enabled: true, persona: { enabled: false } },
    });
    const messages = await driveTurn(config, "voice");

    expect(messages.some((m) => m.type === "turn_completed")).toBe(true);
    expect(messages.some((m) => m.type === "persona_reply")).toBe(false);
  });

  it("does NOT broadcast persona_reply when speech.enabled is false, even for a voice-originated turn", async () => {
    const config = loadConfig({ workspaceRoot: home, approvalPolicy: "never", speech: { enabled: false } });
    const messages = await driveTurn(config, "voice");

    expect(messages.some((m) => m.type === "turn_completed")).toBe(true);
    expect(messages.some((m) => m.type === "persona_reply")).toBe(false);
  });

  it("/api/speech/config-style flag: speech.persona.enabled defaults to true", () => {
    const config = loadConfig({ workspaceRoot: home });
    expect(config.speech.persona.enabled).toBe(true);
    expect(config.speech.persona.name).toBe("Ari");
  });
});
