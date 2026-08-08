import type { z } from "zod";
import type { ToolView } from "../views/types.js";

export type RiskLevel = "safe" | "confirm";

export interface ToolContext {
  workspaceRoot: string;
  sessionId: string;
  approvalPolicy: "always" | "unsafe-only" | "never";
  requestApproval(details: { toolName: string; description: string; input: unknown }): Promise<boolean>;
  signal?: AbortSignal;
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
