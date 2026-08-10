import type { NormalizedMessage } from "../providers/types.js";

// Rough token estimate: ~4 chars per token.
export function estimateTokens(messages: NormalizedMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text" || b.type === "tool_result") chars += (b as { text?: string; content?: string }).text?.length ?? (b as { content?: string }).content?.length ?? 0;
      else chars += JSON.stringify(b).length;
    }
  }
  return Math.ceil(chars / 4);
}
