import OpenAI from "openai";
import { newId } from "../shared/ids.js";
import type {
  ModelProvider,
  NormalizedBlock,
  NormalizedMessage,
  ProviderEvent,
  StopReason,
  TurnRequest,
} from "./types.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function toOpenAIMessages(system: string, messages: NormalizedMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      // Tool results become role:"tool" messages; plain text becomes a user message.
      const texts: string[] = [];
      for (const b of m.content) {
        if (b.type === "text") texts.push(b.text);
        else if (b.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: b.toolUseId, content: b.content });
        }
      }
      if (texts.length > 0) out.push({ role: "user", content: texts.join("\n") });
    } else {
      const texts: string[] = [];
      const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
      for (const b of m.content) {
        if (b.type === "text") texts.push(b.text);
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      // An assistant message with neither text nor tool_calls serializes to
      // {content: null} with no tool_calls, which the API rejects (content is
      // required unless tool_calls is present). This happens on cross-provider
      // replay: an Anthropic turn that paused for server-side web search with no
      // preamble persists an assistant message of only provider_raw blocks, which
      // are dropped for OpenAI — leaving nothing. The Anthropic and Gemini mappers
      // both skip empty messages; match them rather than emit a message the API
      // refuses on every turn.
      const content = texts.join("\n");
      if (content.length === 0 && toolCalls.length === 0) continue;
      const msg: ChatMessage = { role: "assistant", content: content || null };
      if (toolCalls.length > 0) (msg as { tool_calls?: unknown }).tool_calls = toolCalls;
      out.push(msg);
    }
  }
  return out;
}

export class OpenAIProvider implements ModelProvider {
  readonly name: string = "openai";
  readonly model: string;
  protected client: OpenAI;

  /** Ollama's OpenAI-compatible endpoint reads max_tokens; OpenAI wants max_completion_tokens. */
  protected legacyMaxTokens = false;

  constructor(model: string, opts: { baseURL?: string; apiKey?: string } = {}) {
    this.model = model;
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. Export it, or switch provider with `provider: \"anthropic\" | \"gemini\" | \"ollama\"` in ~/.aetheraclaw/config.json5.",
      );
    }
    this.client = new OpenAI({ apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
  }

  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      stream: true,
      messages: toOpenAIMessages(req.system, req.messages),
      ...(this.legacyMaxTokens ? { max_tokens: req.maxTokens } : { max_completion_tokens: req.maxTokens }),
      ...(req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: "function" as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
    });

    let text = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.delta?.content) {
        text += choice.delta.content;
        yield { type: "text_delta", text: choice.delta.content };
      }
      for (const tc of choice.delta?.tool_calls ?? []) {
        const slot = calls.get(tc.index) ?? { id: tc.id ?? newId("call"), name: "", args: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        calls.set(tc.index, slot);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const assistant: NormalizedBlock[] = [];
    if (text) assistant.push({ type: "text", text });
    for (const slot of calls.values()) {
      let input: unknown = {};
      try {
        input = slot.args ? JSON.parse(slot.args) : {};
      } catch {
        input = { _raw: slot.args };
      }
      assistant.push({ type: "tool_use", id: slot.id, name: slot.name, input });
      yield { type: "tool_call", id: slot.id, name: slot.name, input };
    }

    let stopReason: StopReason = "end_turn";
    if (finish === "tool_calls" || calls.size > 0) stopReason = "tool_use";
    else if (finish === "length") stopReason = "max_tokens";
    else if (finish === "content_filter") stopReason = "refusal";
    yield { type: "turn_end", stopReason, assistant };
  }
}

/** Ollama Cloud's OpenAI-compatible endpoint. */
export const OLLAMA_CLOUD_URL = "https://ollama.com/v1";
export const OLLAMA_LOCAL_URL = "http://localhost:11434/v1";

/**
 * Resolve which Ollama to talk to.
 *
 * The trap this exists to close: a user sets OLLAMA_API_KEY meaning "use Ollama
 * Cloud", the base URL still points at localhost, and the failure is
 * ECONNREFUSED on port 11434 — which reads as "Ollama is not running" and sends
 * them off installing a local server they did not want. A key with no explicit
 * URL means the cloud.
 */
export function resolveOllamaBaseUrl(configured: string | undefined, apiKey: string | undefined): string {
  if (configured && configured !== OLLAMA_LOCAL_URL) return configured;
  if (apiKey) return OLLAMA_CLOUD_URL;
  return OLLAMA_LOCAL_URL;
}

export interface OllamaTarget {
  baseUrl: string;
  model: string;
  cloud: boolean;
}

/**
 * Resolve the endpoint AND the model together, from one decision.
 *
 * They have to move as a pair. Local Ollama and Ollama Cloud host different
 * catalogues — "qwen3" exists locally and 404s on the cloud — so a setup that
 * picks the URL one way and the model another produces a request to a real
 * service for a model it has never heard of, and the error names the model
 * rather than the mismatch that caused it.
 */
export function resolveOllamaTarget(
  configured: { model: string; cloudModel?: string; baseUrl?: string },
  apiKey: string | undefined,
): OllamaTarget {
  const baseUrl = resolveOllamaBaseUrl(configured.baseUrl, apiKey);
  const cloud = baseUrl === OLLAMA_CLOUD_URL;
  return {
    baseUrl,
    model: cloud ? (configured.cloudModel || configured.model) : configured.model,
    cloud,
  };
}

// Ollama speaks the OpenAI-compatible chat completions API — locally (no key) or
// via Ollama Cloud (OLLAMA_API_KEY). Only the base URL, the catalogue and auth
// differ.
export class OllamaProvider extends OpenAIProvider {
  override readonly name = "ollama";
  readonly cloud: boolean;

  constructor(configured: { model: string; cloudModel?: string; baseUrl?: string }) {
    const key = process.env.OLLAMA_API_KEY;
    const target = resolveOllamaTarget(configured, key);
    // "ollama" is the placeholder a local server accepts; the SDK requires
    // something non-empty.
    super(target.model, { baseURL: target.baseUrl, apiKey: key ?? "ollama" });
    this.cloud = target.cloud;
    this.legacyMaxTokens = true;
  }
}
