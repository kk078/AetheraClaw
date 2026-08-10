import type { Config } from "../config/config.js";
import type { MemoryStore } from "../memory/store.js";
import type { ModelProvider, NormalizedBlock, NormalizedMessage } from "../providers/types.js";
import { selectTools } from "../tools/profiles.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import { withCard } from "../views/verdict.js";
import { isPlumbing, previewCard } from "../views/workflow.js";
import type { AgentEvent } from "../shared/events.js";
import { configuredSecretValues, knownSecretValues } from "../config/credentials.js";
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
  // The attachment block the web client prepends opens with this exact line and
  // is closed by a blank line; strip it so the title is the question, not the
  // machinery. Matched on the literal opener rather than "any leading bracket",
  // because users legitimately start messages with brackets ("[URGENT] CLM-1042
  // …") and the loose test deleted their own first line.
  const withoutContext = /^\[The user attached /.test(text) ? text.replace(/^[\s\S]*?\n\s*\n/, "") : text;
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
  const system = buildSystemPrompt(config.workspaceRoot, config.healthcare.phiMode);

  try {
    // Inside the try: the first persist can throw (SQLITE_BUSY from a second
    // process on the same file, or a full disk), and outside it that rejection
    // escaped the `void handleUserMessage(...)` at the gateway and — with no
    // unhandledRejection handler anywhere — took the whole gateway down with it.
    // In here it becomes the single-turn error event the catch was built for.
    store.appendMessage(sessionId, "user", [{ type: "text", text: userText }]);
    const session = store.getSession(sessionId);
    if (session && !session.title) store.setSessionTitle(sessionId, sessionTitleFrom(userText));

    emit({ type: "turn_started", sessionId });

    const ctx: ToolContext = {
      workspaceRoot: config.workspaceRoot,
      // Resolved once per turn rather than per call: the values do not change
      // mid-turn, and reading the credentials file on every tool execution would
      // be a file read per call for a list that is almost always empty. Provider
      // keys AND the non-provider secrets the config routes through the
      // environment (portal logins, mail passwords, the voice token) — the scrub
      // is only as complete as this list.
      secrets: [
        ...knownSecretValues().map((value) => ({ value, label: "api-key" })),
        ...configuredSecretValues(config),
      ],
      sessionId,
      approvalPolicy: config.approvalPolicy,
      requestApproval: deps.requestApproval,
      services: deps.services ?? {},
      // Every tool call the agent makes lands in the log, so support_fmea_diagnose
      // can read real production failures instead of requiring someone to find and
      // paste them first.
      onToolCall: (record) => store.recordToolCall(record),
    };

    let rounds = 0;
    for (;;) {
      if (++rounds > MAX_TOOL_ROUNDS) {
        emit({ type: "error", sessionId, message: `stopped after ${MAX_TOOL_ROUNDS} tool rounds` });
        // turn_completed too: error alone is not the protocol's terminal event
        // (the catch below emits both), and the CLI client returns its prompt
        // only on turn_completed — without it the terminal never shows `you>`
        // again and the turn looks stuck.
        emit({ type: "turn_completed", sessionId, stopReason: "error" });
        break;
      }
      const messages = truncateToBudget(loadHistory(store, sessionId), config.contextTokenBudget);
      // Chosen per provider: OpenAI rejects more than 128 tools outright, and
      // nobody but Anthropic caches the definition block.
      // The user's message is the hint. Which tools overflow the provider's cap
      // is now decided by what was ASKED rather than by registration order — a
      // model that was not given denial_explain does not say so, it answers
      // from memory, which is the failure this whole codebase exists to stop.
      const selection = selectTools(
        registry.specs(),
        config.toolProfile,
        provider.name,
        config.toolLimits[provider.name],
        { hint: userText },
      );
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

      // Checkpoint the assistant message before running tools (crash-safe resume),
      // but keep a tool_use block only when we are about to execute it and append
      // its result on this same pass. A turn cut off mid-tool-call — max_tokens
      // arriving after the model emitted a (partial) tool_use, or any non-tool_use
      // stop carrying one — would otherwise persist a tool_use with no tool_result
      // to follow it, a shape the Anthropic and OpenAI APIs both reject with a 400.
      // That poisons every later turn in the session with no path back. Dropping
      // the orphan keeps the text and loses only the call that was never run.
      const toPersist = stopReason === "tool_use" ? assistant : assistant.filter((b) => b.type !== "tool_use");
      if (toPersist.length > 0) store.appendMessage(sessionId, "assistant", toPersist, stopReason);

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
          // Marked when truncated so the telemetry drawer's "returned to the
          // model" pane does not silently show a 400-char preview as if it were
          // the full text (the replay path shows the whole thing). The model
          // still receives the untruncated content below.
          summary: result.content.length > 400 ? `${result.content.slice(0, 400)}\n…[truncated preview; reload to see the full result]` : result.content,
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
