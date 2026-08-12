import type { z } from "zod";
import type { ToolView } from "../views/types.js";
import type { ToolCallRecord } from "../support/tool-log.js";

export type RiskLevel = "safe" | "confirm";

export interface ToolContext {
  workspaceRoot: string;
  sessionId: string;
  approvalPolicy: "always" | "unsafe-only" | "never";
  requestApproval(details: { toolName: string; description: string; input: unknown }): Promise<boolean>;
  /**
   * Ask the user a clarifying question mid-tool-call and wait for an answer.
   *
   * Optional: a caller that has not wired a clarify channel (a test harness, an
   * embedding without voice) simply cannot use ask_user — the tool degrades to
   * an explanatory error rather than crashing. Mirrors requestApproval's shape
   * on purpose, so a tool author who already knows one knows the other. Resolves
   * to null when the question goes unanswered — "no answer", never a guess.
   */
  requestClarification?(details: { question: string; context?: string }): Promise<string | null>;
  signal?: AbortSignal;
  /**
   * Called once per tool execution, whatever the outcome.
   *
   * Optional so the registry stays free of any database dependency — a callback
   * the caller wires up, not a store the registry reaches for. Failures inside
   * it are swallowed by the registry: a broken log must never take down the tool
   * call it was only observing.
   */
  onToolCall?(record: ToolCallRecord): void;
  /**
   * How deep this call is inside another tool's execution.
   *
   * Managed by the registry, which increments it around `execute` and restores
   * it after. Tools that re-enter the registry — `tool_invoke` — pass their own
   * context straight through, so the registry is the only place that can see the
   * nesting. Safe to mutate because tool execution is sequential within one
   * context; two concurrent turns get two contexts.
   */
  callDepth?: number;
  /**
   * Secret values to scrub from every tool result before it reaches the model.
   *
   * Carried on the context rather than read from disk inside the registry, so
   * the registry keeps no config dependency and a test can supply its own.
   * Empty or absent means no scrubbing — which is correct for a deployment that
   * stores no keys, and is why this is optional rather than defaulted.
   */
  secrets?: Array<{ value: string; label: string }>;
  services: Record<string, unknown>; // shared handles (db, config, …) for domain tools
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /**
   * Optional structured payload for the UI.
   *
   * Never reaches the model: `content` is what goes into the conversation, and
   * this is stored separately and streamed to the browser. A rendered claim form
   * would be thousands of tokens of JSON restating what `content` already says
   * in prose — paying for it twice would be the entire cost of the feature with
   * none of the benefit.
   */
  view?: ToolView;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolDefinition<I = any> {
  name: string;
  description: string;
  schema: z.ZodType<I>;
  assessRisk(input: I): { level: RiskLevel; reason: string };
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}
