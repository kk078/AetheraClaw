import Anthropic from "@anthropic-ai/sdk";
import type {
  ModelProvider,
  NormalizedBlock,
  NormalizedMessage,
  ProviderEvent,
  StopReason,
  TurnRequest,
} from "./types.js";

type AnthropicBlockParam = Record<string, unknown>;

function toAnthropicMessages(messages: NormalizedMessage[]): Array<{ role: "user" | "assistant"; content: AnthropicBlockParam[] }> {
  const out: Array<{ role: "user" | "assistant"; content: AnthropicBlockParam[] }> = [];
  for (const m of messages) {
    const content: AnthropicBlockParam[] = [];
    for (const b of m.content) {
      switch (b.type) {
        case "text":
          if (b.text.length > 0) content.push({ type: "text", text: b.text });
          break;
        case "tool_use":
          content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} });
          break;
        case "tool_result":
          content.push({
            type: "tool_result",
            tool_use_id: b.toolUseId,
            content: b.content,
            ...(b.isError ? { is_error: true } : {}),
          });
          break;
        case "provider_raw":
          if (b.provider === "anthropic") content.push(b.raw as AnthropicBlockParam);
          break;
      }
    }
    if (content.length > 0) out.push({ role: m.role, content });
  }
  return out;
}

function fromAnthropicContent(blocks: Anthropic.ContentBlock[]): NormalizedBlock[] {
  const out: NormalizedBlock[] = [];
  for (const b of blocks) {
    if (b.type === "text") out.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    else out.push({ type: "provider_raw", provider: "anthropic", raw: b });
  }
  return out;
}

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;

  constructor(model: string, client?: Anthropic, apiKey?: string) {
    this.model = model;
    // An explicit key comes from createProvider, which reads the environment
    // AND the credentials file. Without it the SDK reads only the environment,
    // so a key typed into the console is stored, masked, displayed — and never
    // used. See the note in src/providers/index.ts.
    this.client = client ?? new Anthropic(apiKey ? { apiKey } : {});
  }

  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    const msgs = toAnthropicMessages(req.messages);
    // Prompt caching: breakpoint on the (frozen) system block, and on the last
    // content block of the latest turn so each request reuses the prior prefix.
    const last = msgs[msgs.length - 1];
    if (last && last.content.length > 0) {
      last.content[last.content.length - 1] = {
        ...last.content[last.content.length - 1],
        cache_control: { type: "ephemeral" },
      };
    }
    const tools: Record<string, unknown>[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
    // Server-side web search — no external key needed; executed on Anthropic's side.
    // Only when the request does not already carry a tool of that name: a gateway
    // started for another provider registers a local `web_search` fallback, and a
    // per-session Anthropic override then sends it here — two tools named
    // "web_search" in one request is a 400 that breaks the session every turn. In
    // that case keep the local one (it works) rather than duplicate it.
    if (!tools.some((t) => t.name === "web_search")) {
      tools.push({ type: "web_search_20260209", name: "web_search" });
    }

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: msgs as unknown as Anthropic.MessageParam[],
      tools: tools as unknown as Anthropic.ToolUnion[],
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") yield { type: "text_delta", text: event.delta.text };
        else if (event.delta.type === "thinking_delta" && event.delta.thinking)
          yield { type: "thinking_delta", text: event.delta.thinking };
      } else if (event.type === "content_block_start" && event.content_block.type === "server_tool_use") {
        yield {
          type: "tool_call",
          id: event.content_block.id,
          name: event.content_block.name,
          input: {},
        };
      }
    }

    const final = await stream.finalMessage();
    let stopReason: StopReason;
    switch (final.stop_reason) {
      case "refusal":
        // Check refusal before touching content — content may be empty or partial.
        yield { type: "turn_end", stopReason: "refusal", assistant: [] };
        return;
      case "tool_use":
        stopReason = "tool_use";
        break;
      case "max_tokens":
        stopReason = "max_tokens";
        break;
      case "pause_turn":
        stopReason = "pause_turn";
        break;
      default:
        stopReason = "end_turn";
    }
    const assistant = fromAnthropicContent(final.content);
    for (const b of assistant) {
      if (b.type === "tool_use") yield { type: "tool_call", id: b.id, name: b.name, input: b.input };
    }
    yield { type: "turn_end", stopReason, assistant };
  }
}
