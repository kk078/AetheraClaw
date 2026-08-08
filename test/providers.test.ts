import { describe, expect, it } from "vitest";
import {
  PROFILES,
  PROVIDER_TOOL_LIMITS,
  profileByName,
  renderProfiles,
  selectTools,
} from "../src/tools/profiles.js";
import {
  OLLAMA_CLOUD_URL,
  OLLAMA_LOCAL_URL,
  OllamaProvider,
  OpenAIProvider,
  resolveOllamaBaseUrl,
} from "../src/providers/openai.js";
import type { ProviderEvent, ToolSpec } from "../src/providers/types.js";

const spec = (name: string): ToolSpec => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: "object", properties: { a: { type: "string" } } },
});

// ── Tool profiles ────────────────────────────────────────────────────────────

describe("tool profiles", () => {
  const registry = [
    "run_command", "read_file", "write_file", "list_dir", "web_fetch",
    "icd10_search", "icd10_validate", "em_calculate", "cdi_analyze", "review_list",
    "claim_scrub", "claim_build_837p", "era_parse_835", "cob_determine_primary",
    "denial_explain", "appeal_draft", "worklist_add", "twin_calibrate",
    "payment_variance", "cash_forecast", "rate_benchmark", "raf_calculate",
    "credentialing_track", "portal_login", "swarm_board", "a2a_attest",
  ].map(spec);

  it("gives every profile the base tools, without which the agent can do nothing", () => {
    for (const profile of PROFILES) {
      const { specs } = selectTools(registry, profile.name, "anthropic");
      for (const base of ["read_file", "write_file", "run_command", "list_dir"]) {
        expect(specs.map((s) => s.name)).toContain(base);
      }
    }
  });

  it("scopes each profile to a coherent job", () => {
    const names = (p: string) => selectTools(registry, p, "anthropic").specs.map((s) => s.name);

    expect(names("coding")).toContain("icd10_search");
    expect(names("coding")).toContain("em_calculate");
    expect(names("coding")).not.toContain("claim_build_837p");

    expect(names("claims")).toContain("claim_scrub");
    expect(names("claims")).toContain("era_parse_835");
    expect(names("claims")).not.toContain("portal_login");

    expect(names("denials")).toContain("appeal_draft");
    expect(names("denials")).toContain("twin_calibrate");

    expect(names("revenue")).toContain("cash_forecast");
    expect(names("revenue")).toContain("rate_benchmark");

    expect(names("operations")).toContain("portal_login");
    expect(names("operations")).toContain("a2a_attest");

    expect(names("all")).toHaveLength(registry.length);
  });

  it("reports how many the profile excluded", () => {
    const selection = selectTools(registry, "coding", "anthropic");
    expect(selection.droppedByProfile).toBe(registry.length - selection.specs.length);
    expect(selection.droppedByProfile).toBeGreaterThan(0);
    expect(selection.droppedByLimit).toEqual([]);
  });

  // The defect this whole module exists for: 173 tools against a 128 cap is a
  // 400 on every single turn, not a degradation.
  it("holds each provider under its ceiling", () => {
    const many = Array.from({ length: 173 }, (_, i) => spec(`tool_${i}`));
    for (const [provider, limit] of Object.entries(PROVIDER_TOOL_LIMITS)) {
      const { specs } = selectTools(many, "all", provider);
      expect(specs.length).toBeLessThanOrEqual(limit);
    }
    expect(selectTools(many, "all", "openai").specs.length).toBe(128);
    expect(selectTools(many, "all", "ollama").specs.length).toBe(64);
    expect(selectTools(many, "all", "anthropic").specs.length).toBe(173);
  });

  // A model that quietly lost claim_scrub will confidently do without it, and
  // the transcript reads like it chose not to scrub rather than like it couldn't.
  it("names every tool cut to fit rather than truncating silently", () => {
    const many = Array.from({ length: 200 }, (_, i) => spec(`tool_${i}`));
    const selection = selectTools(many, "all", "openai");
    expect(selection.droppedByLimit).toHaveLength(72);
    expect(selection.notes.join(" ")).toMatch(/128/);
    expect(selection.notes.join(" ")).toMatch(/cannot ask for a tool it was not given/);
  });

  it("keeps the base tools when cutting to fit", () => {
    const many = [...Array.from({ length: 200 }, (_, i) => spec(`tool_${i}`)), spec("read_file"), spec("run_command")];
    const { specs } = selectTools(many, "all", "ollama");
    expect(specs.map((s) => s.name)).toContain("read_file");
    expect(specs.map((s) => s.name)).toContain("run_command");
    expect(specs.length).toBe(64);
  });

  it("warns about uncached definition payloads on non-Anthropic providers only", () => {
    const many = Array.from({ length: 100 }, (_, i) => spec(`tool_${i}`));
    expect(selectTools(many, "all", "gemini").notes.join(" ")).toMatch(/does not cache them/);
    expect(selectTools(many, "all", "anthropic").notes.join(" ")).not.toMatch(/does not cache/);
  });

  it("falls back to everything on an unknown profile, and says so", () => {
    const selection = selectTools(registry, "nonsense", "anthropic");
    expect(selection.specs).toHaveLength(registry.length);
    expect(selection.notes[0]).toMatch(/No profile named "nonsense"/);
    expect(profileByName("nonsense")).toBeUndefined();
    expect(profileByName("coding")?.name).toBe("coding");
    expect(renderProfiles()).toMatch(/hard API limit/);
  });
});

// ── Ollama Cloud vs local ────────────────────────────────────────────────────

describe("ollama base url", () => {
  // The trap: a key set meaning "cloud", a URL still pointing at localhost, and
  // an ECONNREFUSED that reads as "Ollama isn't running".
  it("sends a key-holding user to the cloud rather than to localhost", () => {
    expect(resolveOllamaBaseUrl(undefined, "sk-abc")).toBe(OLLAMA_CLOUD_URL);
    expect(resolveOllamaBaseUrl(OLLAMA_LOCAL_URL, "sk-abc")).toBe(OLLAMA_CLOUD_URL);
  });

  it("stays local with no key", () => {
    expect(resolveOllamaBaseUrl(undefined, undefined)).toBe(OLLAMA_LOCAL_URL);
    expect(resolveOllamaBaseUrl(OLLAMA_LOCAL_URL, undefined)).toBe(OLLAMA_LOCAL_URL);
  });

  it("never overrides an explicit URL", () => {
    expect(resolveOllamaBaseUrl("http://gpu-box.lan:11434/v1", "sk-abc")).toBe("http://gpu-box.lan:11434/v1");
    expect(resolveOllamaBaseUrl("http://gpu-box.lan:11434/v1", undefined)).toBe("http://gpu-box.lan:11434/v1");
  });
});

// ── Adapter wire mapping, against recorded streams ───────────────────────────

/** Stand in for the OpenAI SDK, capturing the request and replaying chunks. */
function fakeOpenAI(chunks: unknown[]) {
  const captured: { request?: Record<string, unknown> } = {};
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          captured.request = request;
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  };
  return { client, captured };
}

function makeProvider(chunks: unknown[], Ctor: typeof OpenAIProvider = OpenAIProvider) {
  const { client, captured } = fakeOpenAI(chunks);
  const provider = new Ctor("test-model", { apiKey: "test" });
  (provider as unknown as { client: unknown }).client = client;
  return { provider, captured };
}

async function drain(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const REQ = { system: "sys", messages: [], tools: [], maxTokens: 1000 };

describe("openai adapter", () => {
  it("streams text deltas and closes the turn", async () => {
    const { provider } = makeProvider([
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const events = await drain(provider.streamTurn(REQ));
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text)).toEqual([
      "Hello",
      " world",
    ]);
    const end = events.at(-1) as { type: string; stopReason: string; assistant: unknown[] };
    expect(end.stopReason).toBe("end_turn");
    expect(end.assistant).toEqual([{ type: "text", text: "Hello world" }]);
  });

  // Arguments arrive split across chunks at arbitrary boundaries — reassembling
  // them wrong yields a tool call with silently empty input.
  it("reassembles tool-call arguments fragmented across chunks", async () => {
    const { provider } = makeProvider([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "icd10_", arguments: '{"cod' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "validate", arguments: 'e":"E11' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.65"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const events = await drain(provider.streamTurn(REQ));
    const call = events.find((e) => e.type === "tool_call") as { name: string; input: unknown };
    expect(call.name).toBe("icd10_validate");
    expect(call.input).toEqual({ code: "E11.65" });
    expect((events.at(-1) as { stopReason: string }).stopReason).toBe("tool_use");
  });

  it("keeps parallel tool calls separate by index", async () => {
    const { provider } = makeProvider([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "a", function: { name: "npi_validate", arguments: '{"npi":"1"}' } },
                { index: 1, id: "b", function: { name: "icd10_search", arguments: '{"q":"x"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const calls = (await drain(provider.streamTurn(REQ))).filter((e) => e.type === "tool_call");
    expect(calls.map((c) => (c as { name: string }).name)).toEqual(["npi_validate", "icd10_search"]);
  });

  it("preserves malformed arguments instead of throwing them away", async () => {
    const { provider } = makeProvider([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "t", arguments: "{not json" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const call = (await drain(provider.streamTurn(REQ))).find((e) => e.type === "tool_call") as { input: { _raw: string } };
    expect(call.input._raw).toBe("{not json");
  });

  it("maps finish reasons", async () => {
    for (const [finish, expected] of [
      ["stop", "end_turn"],
      ["length", "max_tokens"],
      ["content_filter", "refusal"],
    ] as const) {
      const { provider } = makeProvider([{ choices: [{ delta: { content: "x" }, finish_reason: finish }] }]);
      expect((((await drain(provider.streamTurn(REQ))).at(-1)) as { stopReason: string }).stopReason).toBe(expected);
    }
  });

  it("sends tool schemas in OpenAI function shape", async () => {
    const { provider, captured } = makeProvider([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    await drain(provider.streamTurn({ ...REQ, tools: [spec("claim_scrub")] }));
    expect(captured.request?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "claim_scrub",
          description: "does claim_scrub",
          parameters: { type: "object", properties: { a: { type: "string" } } },
        },
      },
    ]);
  });

  it("omits the tools key entirely when there are none", async () => {
    const { provider, captured } = makeProvider([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    await drain(provider.streamTurn(REQ));
    expect(captured.request).not.toHaveProperty("tools");
  });

  it("uses max_completion_tokens for OpenAI and max_tokens for Ollama", async () => {
    const openai = makeProvider([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    await drain(openai.provider.streamTurn(REQ));
    expect(openai.captured.request).toHaveProperty("max_completion_tokens", 1000);
    expect(openai.captured.request).not.toHaveProperty("max_tokens");

    // Ollama's OpenAI-compatible endpoint ignores max_completion_tokens, which
    // means an unbounded generation rather than an error.
    const ollama = makeProvider([{ choices: [{ delta: {}, finish_reason: "stop" }] }], OllamaProvider as never);
    await drain(ollama.provider.streamTurn(REQ));
    expect(ollama.captured.request).toHaveProperty("max_tokens", 1000);
    expect(ollama.captured.request).not.toHaveProperty("max_completion_tokens");
  });

  it("refuses to construct without a key, naming the fix", () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => new OpenAIProvider("gpt-4.1")).toThrow(/OPENAI_API_KEY is not set/);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});

// ── Cross-provider history ───────────────────────────────────────────────────

describe("switching providers mid-session", () => {
  it("drops Anthropic-only blocks rather than replaying them elsewhere", async () => {
    const { provider, captured } = makeProvider([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    await drain(
      provider.streamTurn({
        ...REQ,
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            content: [
              { type: "provider_raw", provider: "anthropic", raw: { type: "thinking", thinking: "…" } },
              { type: "text", text: "hello" },
              { type: "tool_use", id: "t1", name: "npi_validate", input: { npi: "1" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }] },
        ],
      }),
    );

    const messages = captured.request?.messages as Array<Record<string, unknown>>;
    expect(JSON.stringify(messages)).not.toMatch(/thinking/);

    // A tool result must follow the assistant message that called it, or OpenAI
    // rejects the conversation.
    const assistantAt = messages.findIndex((m) => m.role === "assistant");
    const toolAt = messages.findIndex((m) => m.role === "tool");
    expect(assistantAt).toBeGreaterThan(-1);
    expect(toolAt).toBeGreaterThan(assistantAt);
    expect(messages[toolAt].tool_call_id).toBe("t1");
  });
});
