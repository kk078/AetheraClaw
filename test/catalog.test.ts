import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildCatalog, renderSearch, searchCatalog } from "../src/tools/catalog.js";
import { META_NAMES, META_TOOLS, toolInvokeTool, toolSearchTool } from "../src/tools/meta.js";
import { ToolRegistry, defineTool } from "../src/tools/registry.js";
import { selectTools } from "../src/tools/profiles.js";
import type { ToolSpec } from "../src/providers/types.js";

const spec = (name: string, description: string): ToolSpec => ({
  name,
  description,
  inputSchema: { type: "object", properties: {} },
});

const SPECS = [
  spec("denial_explain", "Explain a CARC or RARC denial code and what to do about it."),
  spec("timely_filing_check", "Check whether a claim is still inside the payer's filing deadline."),
  spec("era_parse_835", "Parse an 835 remittance advice into payments and adjustments."),
  spec("raf_calculate", "Calculate a risk adjustment factor from HCC mappings."),
  spec("rate_benchmark", "Show published market rates for a billing code."),
];

describe("tool catalogue search", () => {
  const catalog = buildCatalog(SPECS);

  it("ranks a name match above a description match", () => {
    const results = searchCatalog(catalog, "denial");
    expect(results[0].name).toBe("denial_explain");
  });

  it("finds a tool by the domain phrase rather than the exact name", () => {
    expect(searchCatalog(catalog, "timely filing deadline")[0].name).toBe("timely_filing_check");
    expect(searchCatalog(catalog, "remittance advice")[0].name).toBe("era_parse_835");
    expect(searchCatalog(catalog, "risk adjustment")[0].name).toBe("raf_calculate");
  });

  it("summarizes to the first sentence so a list stays readable", () => {
    expect(catalog[0].summary).toBe("Explain a CARC or RARC denial code and what to do about it.");
  });

  it("returns nothing rather than noise for an unrelated query, and says how to search", () => {
    const results = searchCatalog(catalog, "photosynthesis");
    expect(results).toEqual([]);
    expect(renderSearch(results, "photosynthesis", catalog.length)).toMatch(/domain word rather than the action/);
  });

  it("ignores words too common here to discriminate", () => {
    // "claim" appears across the domain; on its own it should not rank anything
    // above a tool that genuinely matches the rest of the query.
    expect(searchCatalog(catalog, "claim filing deadline")[0].name).toBe("timely_filing_check");
  });

  it("is deterministic", () => {
    expect(searchCatalog(catalog, "denial code").map((r) => r.name)).toEqual(
      searchCatalog(catalog, "denial code").map((r) => r.name),
    );
  });
});

describe("meta tools", () => {
  function harness(opts: { approve: boolean }) {
    const registry = new ToolRegistry();
    const calls: string[] = [];
    const approvals: string[] = [];
    registry.registerAll(META_TOOLS);
    registry.register(
      defineTool({
        name: "dangerous_thing",
        description: "A tool that requires approval before it runs.",
        schema: z.object({ n: z.number() }),
        assessRisk: () => ({ level: "confirm", reason: "it is dangerous" }),
        execute: async (input) => {
          calls.push(`ran:${input.n}`);
          return { content: `did ${input.n}` };
        },
      }),
    );
    const ctx = {
      workspaceRoot: "/tmp",
      sessionId: "s",
      approvalPolicy: "unsafe-only" as const,
      requestApproval: async (r: { toolName: string }) => {
        approvals.push(r.toolName);
        return opts.approve;
      },
      services: { registry },
    };
    return { registry, ctx, calls, approvals };
  }

  // The whole design rests on this: reaching a tool through the catalogue must
  // not be a way around the gate that guards it.
  it("still asks for approval when invoking through tool_invoke", async () => {
    const h = harness({ approve: true });
    const r = await h.registry.execute("tool_invoke", { name: "dangerous_thing", input: { n: 1 } }, h.ctx as never);
    expect(h.approvals).toEqual(["dangerous_thing"]);
    expect(h.calls).toEqual(["ran:1"]);
    expect(r.content).toBe("did 1");
  });

  it("honours a denial through tool_invoke", async () => {
    const h = harness({ approve: false });
    const r = await h.registry.execute("tool_invoke", { name: "dangerous_thing", input: { n: 1 } }, h.ctx as never);
    expect(h.calls).toEqual([]);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/denied permission/);
  });

  it("still validates input against the real schema", async () => {
    const h = harness({ approve: true });
    const r = await h.registry.execute(
      "tool_invoke",
      { name: "dangerous_thing", input: { n: "not a number" } },
      h.ctx as never,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Invalid input for dangerous_thing/);
    expect(h.calls).toEqual([]);
  });

  it("suggests near matches for an unknown name instead of just failing", async () => {
    const h = harness({ approve: true });
    const r = await h.registry.execute("tool_invoke", { name: "dangerous_thingy", input: {} }, h.ctx as never);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/dangerous_thing/);
  });

  it("refuses to invoke itself", async () => {
    const h = harness({ approve: true });
    for (const name of META_NAMES) {
      const r = await h.registry.execute("tool_invoke", { name, input: {} }, h.ctx as never);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/catalogue tool/);
    }
  });

  it("omits the catalogue tools from search results", async () => {
    const h = harness({ approve: true });
    const r = await h.registry.execute("tool_search", { query: "tool", limit: 20 }, h.ctx as never);
    for (const name of META_NAMES) expect(r.content).not.toContain(`  ${name}\n`);
  });

  it("says plainly when the registry was not wired in", async () => {
    const registry = new ToolRegistry();
    registry.registerAll(META_TOOLS);
    const r = await registry.execute("tool_search", { query: "x" }, {
      workspaceRoot: "/tmp", sessionId: "s", approvalPolicy: "never", requestApproval: async () => true, services: {},
    } as never);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/wiring bug/);
  });
});

describe("deferral versus dropping", () => {
  const many = Array.from({ length: 200 }, (_, i) => spec(`tool_${i}`, `does ${i}`));

  it("defers the overflow when the catalogue tools are present", () => {
    const withMeta = [...many, ...[...META_NAMES].map((n) => spec(n, "catalogue"))];
    const sel = selectTools(withMeta, "all", "ollama");
    expect(sel.specs.length).toBe(64);
    expect(sel.deferred.length).toBe(withMeta.length - 64);
    expect(sel.droppedByLimit).toEqual([]);
    expect(sel.notes.join(" ")).toMatch(/reachable through tool_search/);
    // Every catalogue tool must survive the cut, or nothing is reachable.
    for (const n of META_NAMES) expect(sel.specs.map((s) => s.name)).toContain(n);
  });

  it("drops and names the overflow when they are not, since there is no route back", () => {
    const sel = selectTools(many, "all", "ollama");
    expect(sel.deferred).toEqual([]);
    expect(sel.droppedByLimit.length).toBe(many.length - 64);
    expect(sel.notes.join(" ")).toMatch(/cannot ask for a tool it was not given/);
  });
});
