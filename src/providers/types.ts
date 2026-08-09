// Normalized, provider-independent message and streaming shapes. All conversation
// history is persisted in this form; each adapter maps to its provider's wire format.

export type NormalizedBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  // Provider-specific blocks (e.g. Anthropic server-side web_search results, thinking
  // blocks) preserved verbatim; replayed only to the same provider, dropped elsewhere.
  | { type: "provider_raw"; provider: string; raw: unknown };

export interface NormalizedMessage {
  role: "user" | "assistant";
  content: NormalizedBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  // JSON Schema (object type) for the tool input.
  inputSchema: Record<string, unknown>;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause_turn";

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "turn_end"; stopReason: StopReason; assistant: NormalizedBlock[] };

export interface TurnRequest {
  system: string;
  messages: NormalizedMessage[];
  tools: ToolSpec[];
  maxTokens: number;
}

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent>;
}
