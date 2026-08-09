import { z } from "zod";
import { defineTool } from "./registry.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./types.js";
import { buildCatalog, renderDescribe, renderSearch, searchCatalog } from "./catalog.js";

// ── Meta-tools ───────────────────────────────────────────────────────────────
// Three tools that make the other 170 reachable without putting them on the
// wire. The model searches, reads the schema it needs, and invokes — so the
// per-turn cost is three definitions instead of a hundred and seventy.
//
// The property that matters most: tool_invoke goes back through
// registry.execute, which is the single choke point for zod validation, risk
// assessment and the approval gate. Nothing here is a side door. A tool that
// would have prompted for approval when called directly still prompts when
// called through tool_invoke, and a malformed input is still rejected against
// the real schema.

/** Declared literally, not derived: the tools below reference it. */
export const META_NAMES: ReadonlySet<string> = new Set(["tool_search", "tool_describe", "tool_invoke"]);

function registryFrom(ctx: ToolContext): ToolRegistry | null {
  return (ctx.services?.registry as ToolRegistry | undefined) ?? null;
}

const NO_REGISTRY =
  "The tool catalogue is not available in this session — the registry was not passed to the tool context. This is a wiring bug, not a usage error.";

export const toolSearchTool = defineTool({
  name: "tool_search",
  description:
    "Search the full tool catalogue by keyword. Only a few tools are loaded directly; everything else in this system is reached through here. Search by the domain word rather than the action — 'remittance', 'timely filing', 'prior authorization', 'risk adjustment'. An empty query lists everything.",
  schema: z.object({
    query: z.string().default("").describe("Domain keywords, e.g. 'denial appeal' or 'fee schedule variance'"),
    limit: z.number().int().min(1).max(60).default(12),
  }),
  execute: async (input, ctx) => {
    const registry = registryFrom(ctx);
    if (!registry) return { content: NO_REGISTRY, isError: true };
    const specs = registry.specs().filter((s) => !META_NAMES.has(s.name));
    const catalog = buildCatalog(specs);
    const results = input.query.trim()
      ? searchCatalog(catalog, input.query, input.limit)
      : catalog.slice(0, input.limit).map((e) => ({ ...e, score: 0 }));
    return { content: renderSearch(results, input.query || "(everything)", catalog.length) };
  },
});

export const toolDescribeTool = defineTool({
  name: "tool_describe",
  description:
    "Show the full description and input schema for named tools, so a call can be built correctly the first time. Use after tool_search.",
  schema: z.object({ names: z.array(z.string()).min(1).max(8) }),
  execute: async (input, ctx) => {
    const registry = registryFrom(ctx);
    if (!registry) return { content: NO_REGISTRY, isError: true };
    const all = registry.specs();
    const found = input.names.map((n) => all.find((s) => s.name === n)).filter((s): s is NonNullable<typeof s> => !!s);
    const missing = input.names.filter((n) => !all.some((s) => s.name === n));
    if (found.length === 0) {
      return { content: renderDescribe([], missing), isError: true };
    }
    return { content: renderDescribe(found, missing) };
  },
});

export const toolInvokeTool = defineTool({
  name: "tool_invoke",
  description:
    "Run any tool in the catalogue by name. Input is validated against that tool's real schema and its approval rules still apply, so this is a way to reach a tool rather than a way around it. Get the schema from tool_describe first if unsure.",
  schema: z.object({
    name: z.string(),
    input: z.record(z.unknown()).default({}),
  }),
  execute: async (input, ctx) => {
    const registry = registryFrom(ctx);
    if (!registry) return { content: NO_REGISTRY, isError: true };
    if (META_NAMES.has(input.name)) {
      return { content: `${input.name} is a catalogue tool and cannot be invoked through tool_invoke.`, isError: true };
    }
    if (!registry.has(input.name)) {
      const catalog = buildCatalog(registry.specs());
      const near = searchCatalog(catalog, input.name, 5);
      return {
        content: [
          `No tool named "${input.name}".`,
          near.length > 0 ? `Closest matches: ${near.map((n) => n.name).join(", ")}.` : "Run tool_search to find it.",
        ].join(" "),
        isError: true,
      };
    }
    // Straight back through the one choke point — validation, risk, approval.
    return registry.execute(input.name, input.input, ctx);
  },
});

export const META_TOOLS = [toolSearchTool, toolDescribeTool, toolInvokeTool];
