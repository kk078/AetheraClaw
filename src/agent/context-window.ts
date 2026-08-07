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

// Simple truncation: drop oldest turns until under budget. Cuts only at boundaries
// where the next kept message is a plain user message (never orphans a tool_use
// from its tool_result pair). Upgrade path: provider-side compaction.
export function truncateToBudget(messages: NormalizedMessage[], tokenBudget: number): NormalizedMessage[] {
  if (estimateTokens(messages) <= tokenBudget) return messages;

  const kept = [...messages];
  while (kept.length > 2 && estimateTokens(kept) > tokenBudget) {
    // Find the next safe cut: index of the first plain user message after position 0.
    let cut = -1;
    for (let i = 1; i < kept.length; i++) {
      const m = kept[i];
      const isPlainUser = m.role === "user" && m.content.every((b) => b.type === "text");
      if (isPlainUser) {
        cut = i;
        break;
      }
    }
    if (cut === -1) break;
    kept.splice(0, cut);
  }
  if (kept.length < messages.length && kept.length > 0 && kept[0].role === "user") {
    kept[0] = {
      ...kept[0],
      content: [{ type: "text", text: "[Earlier conversation truncated]" }, ...kept[0].content],
    };
  }
  return kept;
}
