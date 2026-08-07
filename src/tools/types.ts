import type { z } from "zod";

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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolDefinition<I = any> {
  name: string;
  description: string;
  schema: z.ZodType<I>;
  assessRisk(input: I): { level: RiskLevel; reason: string };
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}
