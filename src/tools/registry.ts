import { z } from "zod";
import { zodToJsonSchema } from "./zod-schema.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import type { ToolSpec } from "../providers/types.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: ToolDefinition[]): void {
    for (const t of tools) this.register(t);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema),
    }));
  }

  // Single choke point: validate → assess risk → approval gate → execute.
  async execute(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { content: `Unknown tool: ${name}`, isError: true };

    const parsed = tool.schema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      return { content: `Invalid input for ${name}: ${parsed.error.message}`, isError: true };
    }

    const risk = tool.assessRisk(parsed.data);
    const needsApproval =
      ctx.approvalPolicy === "always" || (ctx.approvalPolicy === "unsafe-only" && risk.level === "confirm");
    if (needsApproval) {
      const approved = await ctx.requestApproval({
        toolName: name,
        description: risk.reason,
        input: parsed.data,
      });
      if (!approved) {
        return { content: "User denied permission to run this tool call.", isError: true };
      }
    }

    try {
      return await tool.execute(parsed.data, ctx);
    } catch (err) {
      return { content: `Tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
}

// Convenience for defining tools with inference.
export function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  assessRisk?: (input: z.infer<S>) => { level: "safe" | "confirm"; reason: string };
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
}): ToolDefinition<z.infer<S>> {
  return {
    name: def.name,
    description: def.description,
    schema: def.schema,
    assessRisk: def.assessRisk ?? (() => ({ level: "safe", reason: "read-only operation" })),
    execute: def.execute,
  };
}
