import { GoogleGenAI } from "@google/genai";
import { newId } from "../shared/ids.js";
import type {
  ModelProvider,
  NormalizedBlock,
  NormalizedMessage,
  ProviderEvent,
  StopReason,
  TurnRequest,
} from "./types.js";

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

// Gemini function declarations accept a JSON-Schema subset; strip unsupported keys.
function sanitizeSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null) return { type: "object" };
  const drop = new Set(["additionalProperties", "$schema", "default"]);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== "object" || node === null) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (drop.has(k)) continue;
      out[k] = walk(v);
    }
    return out;
  };
  return walk(schema) as Record<string, unknown>;
}

function toGeminiContents(messages: NormalizedMessage[], toolNameById: Map<string, string>) {
  const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];
  for (const m of messages) {
    const parts: GeminiPart[] = [];
    for (const b of m.content) {
      if (b.type === "text") parts.push({ text: b.text });
      else if (b.type === "tool_use") {
        toolNameById.set(b.id, b.name);
        parts.push({ functionCall: { name: b.name, args: (b.input as Record<string, unknown>) ?? {} } });
      } else if (b.type === "tool_result") {
        parts.push({
          functionResponse: {
            name: toolNameById.get(b.toolUseId) ?? "tool",
            response: { result: b.content, ...(b.isError ? { error: true } : {}) },
          },
        });
      }
    }
    if (parts.length > 0) contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
  }
  return contents;
}

export class GeminiProvider implements ModelProvider {
  readonly name = "gemini";
  readonly model: string;
  private ai: GoogleGenAI;

  constructor(model: string) {
    this.model = model;
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    const toolNameById = new Map<string, string>();
    const contents = toGeminiContents(req.messages, toolNameById);
    const stream = await this.ai.models.generateContentStream({
      model: this.model,
      contents,
      config: {
        systemInstruction: req.system,
        maxOutputTokens: req.maxTokens,
        ...(req.tools.length > 0
          ? {
              tools: [
                {
                  functionDeclarations: req.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: sanitizeSchema(t.inputSchema),
                  })),
                },
              ],
            }
          : {}),
      },
    });

    let text = "";
    const callBlocks: NormalizedBlock[] = [];
    let finish: string | undefined;

    for await (const chunk of stream) {
      const t = chunk.text;
      if (t) {
        text += t;
        yield { type: "text_delta", text: t };
      }
      for (const fc of chunk.functionCalls ?? []) {
        const id = newId("call");
        const block: NormalizedBlock = { type: "tool_use", id, name: fc.name ?? "tool", input: fc.args ?? {} };
        callBlocks.push(block);
        yield { type: "tool_call", id, name: fc.name ?? "tool", input: fc.args ?? {} };
      }
      finish = chunk.candidates?.[0]?.finishReason ?? finish;
    }

    const assistant: NormalizedBlock[] = [];
    if (text) assistant.push({ type: "text", text });
    assistant.push(...callBlocks);

    let stopReason: StopReason = "end_turn";
    if (callBlocks.length > 0) stopReason = "tool_use";
    else if (finish === "MAX_TOKENS") stopReason = "max_tokens";
    else if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT") stopReason = "refusal";
    yield { type: "turn_end", stopReason, assistant };
  }
}
