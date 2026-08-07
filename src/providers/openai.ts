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

function toOpenAIMessages(system: string, messages: NormalizedMessage[]): ChatMessage[] {
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
      const msg: ChatMessage = { role: "assistant", content: texts.join("\n") || null };
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

  constructor(model: string, opts: { baseURL?: string; apiKey?: string } = {}) {
    this.model = model;
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      stream: true,
      messages: toOpenAIMessages(req.system, req.messages),
      max_completion_tokens: req.maxTokens,
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

// Ollama speaks the OpenAI-compatible chat completions API — locally (no key) or
// via Ollama Cloud (OLLAMA_API_KEY). Only the base URL and auth differ.
export class OllamaProvider extends OpenAIProvider {
  override readonly name = "ollama";
  constructor(model: string, baseURL = "http://localhost:11434/v1") {
    super(model, { baseURL, apiKey: process.env.OLLAMA_API_KEY ?? "ollama" });
  }
}
