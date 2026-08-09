import type { Config } from "../config/config.js";
import type { MemoryStore } from "../memory/store.js";
import type { ModelProvider, NormalizedBlock, NormalizedMessage } from "../providers/types.js";
import { selectTools } from "../tools/profiles.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import { withCard } from "../views/verdict.js";
import { isPlumbing, previewCard } from "../views/workflow.js";
import type { AgentEvent } from "../shared/events.js";
import { knownSecretValues } from "../config/credentials.js";
import { buildSystemPrompt, catalogueBlock } from "./system-prompt.js";
import { truncateToBudget } from "./context-window.js";

const MAX_TOOL_ROUNDS = 40;

/**
 * A session's title, from the first thing the user actually said.
 *
 * The UI prefixes a turn with a bracketed block naming any attached files, so
 * the model knows which document ids exist. Titling from the raw text made
 * every session with an attachment read "[The user attached 2 file(s).]" in the
 * sidebar — the machinery, not the question.
 */
export function sessionTitleFrom(text: string): string {
  // The block opens with a bracketed line and is closed by a blank line. Matching
  // its interior line by line was tried and stopped at the first line that was
  // neither a bullet nor blank — leaving the instruction to the model as the
  // title. The terminator is the reliable part.
  const withoutContext = /^\s*\[/.test(text) ? text.replace(/^[\s\S]*?\n\s*\n/, "") : text;
  return (withoutContext.trim() || text.trim()).slice(0, 60);
}

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
  if (session && !session.title) store.setSessionTitle(sessionId, sessionTitleFrom(userText));

  emit({ type: "turn_started", sessionId });

  const ctx: ToolContext = {
    workspaceRoot: config.workspaceRoot,
    // Resolved once per turn rather than per call: the values do not change
    // mid-turn, and reading the credentials file on every tool execution would
    // be a file read per call for a list that is almost always empty.
    secrets: knownSecretValues().map((value) => ({ value, label: "api-key" })),
    sessionId,
    approvalPolicy: config.approvalPolicy,
    requestApproval: deps.requestApproval,
    services: deps.services ?? {},
    // Every tool call the agent makes lands in the log, so support_fmea_diagnose
    // can read real production failures instead of requiring someone to find and
    // paste them first.
    onToolCall: (record) => store.recordToolCall(record),
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
      const selection = selectTools(registry.specs(), config.toolProfile, provider.name, config.toolLimits[provider.name]);
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
        // tool_invoke is a wrapper: its card would say "tool_invoke" above a
        // result produced by something else. Report the INNER tool, which is
        // what actually ran and what the reader needs named.
        const inner =
          call.name === "tool_invoke" ? String((call.input as { name?: unknown } | null)?.name ?? "").trim() : "";
        const toolName = inner || call.name;
        // One place, so the stored view and the streamed view cannot disagree
        // about the verdict. The preview re-badge happens HERE rather than in
        // summarize(), because whether a result was applied is a fact about the
        // TOOL and the view has no idea which one produced it.
        const carded = result.view ? withCard(result.view) : undefined;
        const view =
          carded?.card ? { ...carded, card: previewCard(carded.card, toolName) } : carded;
        if (view) store.saveToolView(sessionId, call.id, view);
        emit({
          type: "tool_result",
          sessionId,
          toolUseId: call.id,
          toolName,
          summary: result.content.slice(0, 400),
          isError: result.isError ?? false,
          // A tool_invoke that named a real tool is NOT plumbing — the inner
          // tool did the work, and hiding it would lose exactly the call the
          // user cares about on a deferred-tool provider like Ollama.
          plumbing: isPlumbing(call.name) && !inner,
          view,
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
