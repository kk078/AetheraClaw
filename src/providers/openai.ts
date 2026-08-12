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

  /** Kept so an error can name the endpoint that produced it. */
  protected readonly baseUrl: string;

  constructor(model: string, opts: { baseURL?: string; apiKey?: string } = {}) {
    this.model = model;
    this.baseUrl = opts.baseURL ?? "https://api.openai.com/v1";
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. Export it, or switch provider with `provider: \"anthropic\" | \"gemini\" | \"ollama\"` in ~/.orion/config.json5.",
      );
    }
    this.client = new OpenAI({ apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
  }

  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    const stream = await this.createStream(req);
    yield* this.consume(stream, req);
  }

  private async createStream(req: TurnRequest) {
    try {
      return await this.requestStream(req);
    } catch (err) {
      // A misconfigured base URL does not fail like an API — it succeeds as a
      // WEBSITE, and the body is a page. See explainProviderError.
      throw explainProviderError(err, this.baseUrl);
    }
  }

  private async requestStream(req: TurnRequest) {
    return await this.client.chat.completions.create({
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
  }

  private async *consume(
    stream: Awaited<ReturnType<OpenAIProvider["requestStream"]>>,
    _req: TurnRequest,
  ): AsyncIterable<ProviderEvent> {
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
  if (configured && configured !== OLLAMA_LOCAL_URL) return normalizeOllamaBaseUrl(configured);
  if (apiKey) return OLLAMA_CLOUD_URL;
  return OLLAMA_LOCAL_URL;
}

/**
 * Put the missing `/v1` back on a base URL that has no path.
 *
 * OBSERVED IN THE CONSOLE. A user typed "hi" and the assistant replied with
 * ollama.com's marketing 404 page — the entire HTML document, doctype and
 * footer included. The base URL was `https://ollama.com`, which is the obvious
 * thing to type and the one value that cannot work: the OpenAI-compatible API
 * lives under /v1, so the SDK appended /chat/completions to the WEBSITE and got
 * a web page. Unauthenticated, the difference is stark and easy to check:
 *
 *   https://ollama.com/v1/chat/completions  ->  401  application/json
 *   https://ollama.com/chat/completions     ->  404  text/html
 *
 * Only a URL with no path of its own is touched. A deployment pointing at a
 * proxy on a subpath means it deliberately, and rewriting that would break a
 * working setup to fix a broken one.
 */
export function normalizeOllamaBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return OLLAMA_LOCAL_URL;
  try {
    const url = new URL(trimmed);
    if (url.pathname === "" || url.pathname === "/") return `${url.origin}/v1`;
    return trimmed;
  } catch {
    // Not a URL at all. Hand it back untouched: the connection error names the
    // value the operator typed, which is more use than a guess at what they
    // meant.
    return trimmed;
  }
}

/**
 * Whether a base URL is Ollama Cloud, by HOST rather than by exact string.
 *
 * `https://ollama.com` and `https://ollama.com/v1` are the same service, and
 * comparing full strings made the first one "not cloud" — so it also picked
 * `model` instead of `cloudModel`, and the two catalogues differ. One typo, two
 * failures, and the second only shows up as a model that does not exist.
 */
export function isOllamaCloudUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).host === new URL(OLLAMA_CLOUD_URL).host;
  } catch {
    return false;
  }
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
  const cloud = isOllamaCloudUrl(baseUrl);
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

// ── When the endpoint answers with a web page ───────────────────────────────

/** Does this body look like a rendered HTML page rather than an API response? */
export function looksLikeHtml(body: string): boolean {
  return /<!doctype\s+html|<html[\s>]/i.test(body);
}

/**
 * Turn "here is a web page" into a sentence naming the cause.
 *
 * WHAT THIS FIXES, exactly as it was seen: the user typed "hi" and the console
 * printed ollama.com's 404 page — doctype, nav, tailwind link, footer, the lot —
 * as though the model had said it. The body of a non-2xx response goes into the
 * SDK's error message, the agent surfaces that message, and a whole website
 * lands in the transcript. Nothing in it says "your base URL is wrong", which is
 * the only fact that matters.
 *
 * A misconfigured base URL is the ordinary cause and does not fail like an API:
 * it SUCCEEDS as a website. So the shape of the body is the diagnosis, and the
 * page itself is never worth showing.
 */
export function explainProviderError(err: unknown, baseUrl: string): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  if (!looksLikeHtml(original.message)) return original;
  const explained = new Error(
    `${baseUrl} returned an HTML PAGE, not an API response — so this address is serving a website ` +
      `rather than the OpenAI-compatible API. The usual cause is a base URL missing its path: ` +
      `https://ollama.com serves the marketing site, and https://ollama.com/v1 serves the API. ` +
      `Check the base URL for this provider. (The page itself is not shown; it said nothing useful.)`,
  );
  // Keep the original reachable for a log without putting it in front of a
  // person. `cause` is exactly this: the machine keeps it, the reader does not.
  (explained as Error & { cause?: unknown }).cause = original;
  return explained;
}
