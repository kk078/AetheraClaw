import type { Config } from "../config/config.js";
import type { MemoryStore } from "../memory/store.js";
import type { ModelProvider, NormalizedBlock, NormalizedMessage } from "../providers/types.js";
import { selectTools } from "../tools/profiles.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import type { AgentEvent } from "../shared/events.js";
import { buildSystemPrompt, catalogueBlock } from "./system-prompt.js";
import { truncateToBudget } from "./context-window.js";

const MAX_TOOL_ROUNDS = 40;

export interface RunnerDeps {
  provider: ModelProvider;
  registry: ToolRegistry;
  store: MemoryStore;
  config: Config;
  requestApproval: ToolContext["requestApproval"];
  emit: (event: AgentEvent) => void;
  services?: Record<string, unknown>;
}

function loadHistory(store: MemoryStore, sessionId: string): NormalizedMessage[] {
  return store.loadMessages(sessionId).map((row) => ({
    role: row.role,
    content: JSON.parse(row.content_json) as NormalizedBlock[],
  }));
}

// The manual agent loop: stream a model turn, persist it, execute requested tools
// (through the approval-gated registry), persist results, repeat until done.
export async function runTurn(deps: RunnerDeps, sessionId: string, userText: string): Promise<void> {
  const { provider, registry, store, config, emit } = deps;
  const system = buildSystemPrompt(config.workspaceRoot);

  store.appendMessage(sessionId, "user", [{ type: "text", text: userText }]);
  const session = store.getSession(sessionId);
  if (session && !session.title) store.setSessionTitle(sessionId, userText.slice(0, 60));

  emit({ type: "turn_started", sessionId });

  const ctx: ToolContext = {
    workspaceRoot: config.workspaceRoot,
    sessionId,
    approvalPolicy: config.approvalPolicy,
    requestApproval: deps.requestApproval,
    services: deps.services ?? {},
  };

  try {
    let rounds = 0;
    for (;;) {
      if (++rounds > MAX_TOOL_ROUNDS) {
        emit({ type: "error", sessionId, message: `stopped after ${MAX_TOOL_ROUNDS} tool rounds` });
        break;
      }
      const messages = truncateToBudget(loadHistory(store, sessionId), config.contextTokenBudget);
      // Chosen per provider: OpenAI rejects more than 128 tools outright, and
      // nobody but Anthropic caches the definition block.
      const selection = selectTools(registry.specs(), config.toolProfile, provider.name);
      const toolSpecs = selection.specs;
      // Logged rather than emitted as errors: these are notes about how the
      // turn is configured, and surfacing them as errors makes every start of
      // every conversation look like something went wrong.
      if (rounds === 1) for (const note of selection.notes) console.error(`[tools] ${note}`);
      let stopReason = "end_turn";
      let assistant: NormalizedBlock[] = [];

      for await (const event of provider.streamTurn({
        system: selection.deferred.length > 0 ? system + catalogueBlock(selection.deferred.length) : system,
        messages,
        tools: toolSpecs,
        maxTokens: config.maxTokens,
      })) {
        switch (event.type) {
          case "text_delta":
            emit({ type: "text_delta", sessionId, text: event.text });
            break;
          case "thinking_delta":
            emit({ type: "thinking_delta", sessionId, text: event.text });
            break;
          case "tool_call":
            emit({ type: "tool_call", sessionId, toolUseId: event.id, toolName: event.name, input: event.input });
            break;
          case "turn_end":
            stopReason = event.stopReason;
            assistant = event.assistant;
            break;
        }
      }

      if (stopReason === "refusal") {
        emit({ type: "refusal", sessionId });
        emit({ type: "turn_completed", sessionId, stopReason });
        return;
      }

      // Checkpoint the assistant message before running tools (crash-safe resume).
      if (assistant.length > 0) store.appendMessage(sessionId, "assistant", assistant, stopReason);

      if (stopReason === "pause_turn") continue; // server-side tool paused; re-send to resume

      const toolUses = assistant.filter((b): b is Extract<NormalizedBlock, { type: "tool_use" }> => b.type === "tool_use");
      if (stopReason !== "tool_use" || toolUses.length === 0) {
        emit({ type: "turn_completed", sessionId, stopReason });
        return;
      }

      const results: NormalizedBlock[] = [];
      for (const call of toolUses) {
        const result = await registry.execute(call.name, call.input, ctx);
        if (result.view) store.saveToolView(sessionId, call.id, result.view);
        emit({
          type: "tool_result",
          sessionId,
          toolUseId: call.id,
          summary: result.content.slice(0, 400),
          isError: result.isError ?? false,
          view: result.view,
        });
        // `result.view` is deliberately NOT carried into the block pushed here:
        // this array becomes the model's next turn, and the view would be sent
        // to the provider on every turn thereafter.
        results.push({ type: "tool_result", toolUseId: call.id, content: result.content, isError: result.isError });
      }
      store.appendMessage(sessionId, "user", results);
    }
  } catch (err) {
    emit({ type: "error", sessionId, message: err instanceof Error ? err.message : String(err) });
    emit({ type: "turn_completed", sessionId, stopReason: "error" });
  }
}
