import { envVarFor, resolveProvider } from "../src/config/config.js";
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
  explainProviderError,
  isOllamaCloudUrl,
  looksLikeHtml,
  normalizeOllamaBaseUrl,
  resolveOllamaBaseUrl,
  resolveOllamaTarget,
} from "../src/providers/openai.js";
import type { ProviderEvent, ToolSpec } from "../src/providers/types.js";
import { createProvider } from "../src/providers/index.js";
import { resolveKey } from "../src/config/credentials.js";
import { GeminiProvider } from "../src/providers/gemini.js";

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

  // ── The console printed a website ────────────────────────────────────────
  // A user typed "hi" and got ollama.com's 404 page back as the reply, doctype
  // and footer included. The base URL was `https://ollama.com` — the obvious
  // thing to type, and the one value that cannot work, because the
  // OpenAI-compatible API lives under /v1 and the bare host serves marketing.
  //
  //   https://ollama.com/v1/chat/completions -> 401 application/json
  //   https://ollama.com/chat/completions    -> 404 text/html

  it("puts the missing /v1 back on a host with no path", () => {
    expect(normalizeOllamaBaseUrl("https://ollama.com")).toBe("https://ollama.com/v1");
    expect(normalizeOllamaBaseUrl("https://ollama.com/")).toBe("https://ollama.com/v1");
    expect(normalizeOllamaBaseUrl("http://localhost:11434")).toBe("http://localhost:11434/v1");
  });

  it("leaves a URL that already has a path alone", () => {
    // A deployment pointing at a proxy on a subpath means it. Rewriting that
    // would break a working setup in order to fix a broken one.
    expect(normalizeOllamaBaseUrl("https://proxy.internal/ollama")).toBe("https://proxy.internal/ollama");
    expect(normalizeOllamaBaseUrl("https://ollama.com/v1")).toBe("https://ollama.com/v1");
  });

  it("normalises through the resolver, which is where it actually matters", () => {
    expect(resolveOllamaBaseUrl("https://ollama.com", "sk-abc")).toBe("https://ollama.com/v1");
  });

  it("recognises the cloud by HOST, so the model catalogue follows too", () => {
    // Comparing full strings made `https://ollama.com` "not cloud", so it also
    // picked `model` instead of `cloudModel` — one typo, two failures, and the
    // second surfaces only as a model that does not exist.
    expect(isOllamaCloudUrl("https://ollama.com")).toBe(true);
    expect(isOllamaCloudUrl("https://ollama.com/v1")).toBe(true);
    expect(isOllamaCloudUrl(OLLAMA_LOCAL_URL)).toBe(false);
    expect(isOllamaCloudUrl("not a url")).toBe(false);
  });

  // ── A bearer token must not travel in the clear ─────────────────────────
  // Found in the LIVE config after the /v1 fix went out: `http://ollama.com/`.
  // Plain HTTP to a remote host with OLLAMA_API_KEY in an Authorization header
  // on every turn. The site's redirect to HTTPS does not help — the redirect is
  // the second request, and the key went out in the clear on the first.

  it("upgrades http to https for the CLOUD host, where the key goes", () => {
    expect(normalizeOllamaBaseUrl("http://ollama.com/")).toBe("https://ollama.com/v1");
    expect(normalizeOllamaBaseUrl("http://ollama.com/v1")).toBe("https://ollama.com/v1");
  });

  it("does NOT upgrade a self-hosted server, which would break it", () => {
    // The first version of this upgraded every non-loopback address, and the
    // two "never overrides an explicit URL" cases above caught it: a private
    // Ollama does not speak TLS, so https fails to connect. Breaking every
    // self-hosted install to fix a hosted one is the wrong trade, and the
    // existing tests were the ones that said so.
    expect(normalizeOllamaBaseUrl("http://gpu-box.lan:11434/v1")).toBe("http://gpu-box.lan:11434/v1");
    expect(normalizeOllamaBaseUrl("http://localhost:11434")).toBe("http://localhost:11434/v1");
    expect(normalizeOllamaBaseUrl("http://192.168.1.50:11434/v1")).toBe("http://192.168.1.50:11434/v1");
  });

  it("does not downgrade an https URL", () => {
    expect(normalizeOllamaBaseUrl("https://gpu-box.lan/v1")).toBe("https://gpu-box.lan/v1");
  });

  it("hands back something that is not a URL untouched", () => {
    // The connection error then names what the operator typed, which is more
    // use than a guess at what they meant.
    expect(normalizeOllamaBaseUrl("localhost:11434")).toBe("localhost:11434");
  });
});

describe("an endpoint that answers with a web page", () => {
  it("recognises an HTML body", () => {
    expect(looksLikeHtml("<!doctype html> <html><head><title>Ollama</title>")).toBe(true);
    expect(looksLikeHtml('<html class="h-full">')).toBe(true);
    expect(looksLikeHtml('{"error":{"message":"model not found"}}')).toBe(false);
  });

  it("replaces the page with the one fact that matters", () => {
    const err = explainProviderError(
      new Error('404 status code (no body)\n<!doctype html> <html><title>Ollama</title>...</html>'),
      "https://ollama.com",
    );
    expect(err.message).toContain("HTML PAGE");
    expect(err.message).toContain("https://ollama.com/v1");
    // The page is NOT shown. It was several kilobytes of nav and footer, and it
    // said nothing about the cause.
    expect(err.message).not.toContain("doctype");
  });

  it("keeps the original reachable without putting it in front of a person", () => {
    const original = new Error("<!doctype html><html></html>");
    const err = explainProviderError(original, "https://ollama.com") as Error & { cause?: unknown };
    expect(err.cause).toBe(original);
  });

  it("does not touch an ordinary API error", () => {
    const original = new Error("429 rate limit exceeded");
    expect(explainProviderError(original, "https://ollama.com/v1")).toBe(original);
  });
});

describe("ollama model follows the endpoint", () => {
  const configured = { model: "qwen3", cloudModel: "gpt-oss:120b", baseUrl: OLLAMA_LOCAL_URL };

  // The pair has to move together. Local and cloud host different catalogues,
  // so picking the URL one way and the model the other sends a real request for
  // a model that service has never heard of — and the 404 names the model
  // rather than the mismatch that caused it.
  it("uses the cloud model on the cloud endpoint", () => {
    const target = resolveOllamaTarget(configured, "sk-abc");
    expect(target).toEqual({ baseUrl: OLLAMA_CLOUD_URL, model: "gpt-oss:120b", cloud: true });
  });

  it("uses the local model on the local endpoint", () => {
    const target = resolveOllamaTarget(configured, undefined);
    expect(target).toEqual({ baseUrl: OLLAMA_LOCAL_URL, model: "qwen3", cloud: false });
  });

  it("treats an explicit non-cloud URL as local even when a key is set", () => {
    const target = resolveOllamaTarget({ ...configured, baseUrl: "http://gpu-box.lan:11434/v1" }, "sk-abc");
    expect(target).toEqual({ baseUrl: "http://gpu-box.lan:11434/v1", model: "qwen3", cloud: false });
  });

  it("falls back to the local name when no cloud model is configured", () => {
    expect(resolveOllamaTarget({ model: "qwen3" }, "sk-abc").model).toBe("qwen3");
    expect(resolveOllamaTarget({ model: "qwen3", cloudModel: "" }, "sk-abc").model).toBe("qwen3");
  });

  it("wires the resolved pair into the provider", () => {
    const saved = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "sk-abc";
    try {
      const provider = new OllamaProvider(configured);
      expect(provider.model).toBe("gpt-oss:120b");
      expect(provider.cloud).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.OLLAMA_API_KEY;
      else process.env.OLLAMA_API_KEY = saved;
    }
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
  const provider =
    Ctor === (OllamaProvider as never)
      ? (new OllamaProvider({ model: "test-model" }) as OpenAIProvider)
      : new Ctor("test-model", { apiKey: "test" });
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

// ── Provider selection ───────────────────────────────────────────────────────
// The shipped default is "anthropic", and the old behaviour hard-exited whenever
// that provider's key was missing. A user who had set only OLLAMA_API_KEY was
// therefore told, every single run, to go and get an Anthropic key — while a
// provider that could have served the request sat configured and ignored.
describe("provider resolution", () => {
  const cfg = (provider: "anthropic" | "openai" | "gemini" | "ollama") => ({ provider });

  it("uses the configured provider when its key is present", () => {
    const r = resolveProvider(cfg("anthropic"), { env: { ANTHROPIC_API_KEY: "k" } });
    expect(r.provider).toBe("anthropic");
    expect(r.substitutedFrom).toBeUndefined();
  });

  it("falls through to the provider the user actually has a key for", () => {
    const r = resolveProvider(cfg("anthropic"), { env: { OLLAMA_API_KEY: "k" } });
    expect(r.provider).toBe("ollama");
    expect(r.substitutedFrom).toBe("anthropic");
    expect(r.error).toBe("");
  });

  it("announces the substitution rather than making it silently", () => {
    // Serving a different model than the config names without saying so is how
    // somebody debugs the wrong provider for an hour.
    expect(resolveProvider(cfg("anthropic"), { env: { GEMINI_API_KEY: "k" } }).substitutedFrom).toBe("anthropic");
  });

  it("NEVER substitutes an explicit --provider", () => {
    // That is a direct instruction; quietly serving a different model is worse
    // than failing.
    const r = resolveProvider(cfg("ollama"), { explicit: "openai", env: { OLLAMA_API_KEY: "k" } });
    expect(r.provider).toBe("openai");
    // Both ways in, because a key can now be stored as well as exported and an
    // error naming only the variable sends the user to the harder of the two.
    expect(r.error).toMatch(/auth set openai/);
    expect(r.error).toMatch(/OPENAI_API_KEY/);
  });

  it("accepts an explicit provider that does have a key", () => {
    const r = resolveProvider(cfg("anthropic"), { explicit: "ollama", env: { OLLAMA_API_KEY: "k" } });
    expect(r).toEqual({ provider: "ollama", error: "" });
  });

  it("rejects an unknown provider name", () => {
    expect(resolveProvider(cfg("anthropic"), { explicit: "claude", env: {} }).error).toMatch(/Unknown provider/);
  });

  it("prefers a keyed provider over keyless local Ollama", () => {
    // Ollama with no key means a LOCAL server, which may not be running — so it
    // is the fallback of last resort, not a confident pick.
    const r = resolveProvider(cfg("anthropic"), { env: { OPENAI_API_KEY: "k" } });
    expect(r.provider).toBe("openai");
  });

  it("still offers local Ollama when nothing is keyed", () => {
    const r = resolveProvider(cfg("anthropic"), { env: {} });
    expect(r.provider).toBe("ollama");
    expect(r.error).toBe("");
  });

  it("runs Ollama with no key at all, since local needs none", () => {
    expect(resolveProvider(cfg("ollama"), { env: {} })).toEqual({ provider: "ollama", error: "" });
  });

  it("names every env var when it cannot help", () => {
    const r = resolveProvider(cfg("anthropic"), { explicit: "gemini", env: {} });
    expect(r.error).toMatch(/GEMINI_API_KEY/);
  });

  it("derives env var names without a lookup table to drift", () => {
    expect(envVarFor("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(envVarFor("ollama")).toBe("OLLAMA_API_KEY");
    expect(envVarFor("gemini")).toBe("GEMINI_API_KEY");
    expect(envVarFor("openai")).toBe("OPENAI_API_KEY");
  });
});

// ── The key the console stored was never used ───────────────────────────────
// Providers & keys writes to credentials.json and shows the value back as
// "stored on this machine". Every provider read its OWN environment variable
// and nothing else, so that key was never used by anything.
//
// Three of the four failed loudly ("GEMINI_API_KEY is not set"). Ollama had a
// plausible fallback to "ollama" — the placeholder a LOCAL server accepts — so
// it sent `Authorization: Bearer ollama` to Ollama Cloud and got a 401. That is
// the same status a revoked key produces, and it cost a long detour into
// whether the key was still valid. It was.

describe("a key stored in the console, with no environment variable", () => {
  const cfg = (provider: string) =>
    ({
      provider,
      providers: {
        anthropic: { model: "claude-opus-5" },
        openai: { model: "gpt-4.1" },
        gemini: { model: "gemini-2.5-pro" },
        ollama: { model: "gpt-oss:120b", cloudModel: "gpt-oss:120b", baseUrl: "http://ollama.com/" },
      },
    }) as unknown as Parameters<typeof createProvider>[0];

  const withoutEnv = <T,>(fn: () => T): T => {
    const saved = { ...process.env };
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OLLAMA_API_KEY"]) delete process.env[k];
    try {
      return fn();
    } finally {
      Object.assign(process.env, saved);
    }
  };

  it("REACHES the ollama provider, instead of the placeholder", () => {
    // The exact production shape: key in the file, nothing in the environment.
    const store = { ollama: { key: "a-real-cloud-key" } } as never;
    withoutEnv(() => {
      const resolved = resolveKey("ollama", { store });
      expect(resolved.source).toBe("file");
      expect(resolved.key).toBe("a-real-cloud-key");
      // And the provider must be built with THAT, not with "ollama".
      const p = new OllamaProvider(cfg("ollama").providers.ollama, resolved.key);
      expect((p as unknown as { client: { apiKey: string } }).client.apiKey).toBe("a-real-cloud-key");
    });
  });

  it("still falls back to the placeholder when there is genuinely no key", () => {
    // A local server takes any non-empty string, and demanding a key for
    // localhost would break every offline install.
    withoutEnv(() => {
      const p = new OllamaProvider({ model: "qwen3", baseUrl: OLLAMA_LOCAL_URL });
      expect((p as unknown as { client: { apiKey: string } }).client.apiKey).toBe("ollama");
    });
  });

  it("passes a stored key to gemini rather than throwing", () => {
    withoutEnv(() => {
      expect(() => new GeminiProvider("gemini-2.5-pro", "a-stored-gemini-key")).not.toThrow();
      // Without one it still names the environment variable, which is the right
      // message when nothing is configured anywhere.
      expect(() => new GeminiProvider("gemini-2.5-pro")).toThrow(/GEMINI_API_KEY/);
    });
  });

  it("passes a stored key to openai rather than throwing", () => {
    withoutEnv(() => {
      expect(() => new OpenAIProvider("gpt-4.1", { apiKey: "a-stored-openai-key" })).not.toThrow();
      expect(() => new OpenAIProvider("gpt-4.1")).toThrow(/OPENAI_API_KEY/);
    });
  });
});
