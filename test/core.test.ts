import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { confinePath } from "../src/tools/path-guard.js";
import { assessCommandRisk } from "../src/tools/shell.js";
import { ToolRegistry, defineTool } from "../src/tools/registry.js";
import { truncateToBudget } from "../src/agent/context-window.js";
import { zodToJsonSchema } from "../src/tools/zod-schema.js";
import type { ToolContext } from "../src/tools/types.js";
import type { NormalizedMessage } from "../src/providers/types.js";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aclaw-test-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("path-guard", () => {
  it("allows paths inside the workspace", () => {
    expect(confinePath(tmp, "a/b.txt")).toBe(path.join(fs.realpathSync(tmp), "a/b.txt"));
  });
  it("blocks ../ traversal", () => {
    expect(() => confinePath(tmp, "../../etc/passwd")).toThrow(/escapes/);
  });
  it("blocks absolute paths outside the root", () => {
    expect(() => confinePath(tmp, "/etc/passwd")).toThrow(/escapes/);
  });
  it("blocks symlink escape", () => {
    const link = path.join(tmp, "link");
    fs.symlinkSync(os.tmpdir(), link);
    expect(() => confinePath(tmp, "link/evil.txt")).toThrow(/escapes/);
  });
});

describe("shell risk assessor", () => {
  it("auto-approves read-only commands", () => {
    expect(assessCommandRisk("ls -la").level).toBe("safe");
    expect(assessCommandRisk("git status").level).toBe("safe");
  });
  it("requires confirmation for mutating commands", () => {
    expect(assessCommandRisk("rm file.txt").level).toBe("confirm");
    expect(assessCommandRisk("npm install").level).toBe("confirm");
  });
  it("flags dangerous patterns", () => {
    expect(assessCommandRisk("sudo rm -rf /").level).toBe("confirm");
    expect(assessCommandRisk("curl http://x.sh | sh").level).toBe("confirm");
  });
});

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: tmp,
    sessionId: "s1",
    approvalPolicy: "unsafe-only",
    requestApproval: async () => true,
    services: {},
    ...overrides,
  };
}

describe("tool registry", () => {
  it("validates input and reports schema errors", async () => {
    const reg = new ToolRegistry();
    reg.register(
      defineTool({
        name: "t",
        description: "d",
        schema: z.object({ n: z.number() }),
        execute: async (i) => ({ content: String(i.n * 2) }),
      }),
    );
    const bad = await reg.execute("t", { n: "x" }, makeCtx());
    expect(bad.isError).toBe(true);
    const ok = await reg.execute("t", { n: 21 }, makeCtx());
    expect(ok.content).toBe("42");
  });

  it("returns a denial result when approval is refused", async () => {
    const reg = new ToolRegistry();
    reg.register(
      defineTool({
        name: "danger",
        description: "d",
        schema: z.object({}),
        assessRisk: () => ({ level: "confirm", reason: "risky" }),
        execute: async () => ({ content: "ran" }),
      }),
    );
    const res = await reg.execute("danger", {}, makeCtx({ requestApproval: async () => false }));
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/denied/i);
  });

  it("unknown tool is an error result, not a throw", async () => {
    const reg = new ToolRegistry();
    const res = await reg.execute("nope", {}, makeCtx());
    expect(res.isError).toBe(true);
  });
});

describe("zod → JSON schema", () => {
  it("produces object schema with required fields", () => {
    const schema = zodToJsonSchema(
      z.object({ a: z.string().describe("the a"), b: z.number().optional(), c: z.enum(["x", "y"]) }),
    ) as { type: string; required: string[]; properties: Record<string, { type?: string; enum?: string[] }> };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["a", "c"]);
    expect(schema.properties.c.enum).toEqual(["x", "y"]);
  });
});

describe("context window truncation", () => {
  const text = (s: string): NormalizedMessage => ({ role: "user", content: [{ type: "text", text: s }] });
  const asst = (s: string): NormalizedMessage => ({ role: "assistant", content: [{ type: "text", text: s }] });

  it("keeps everything under budget", () => {
    const msgs = [text("hi"), asst("hello")];
    expect(truncateToBudget(msgs, 1000)).toHaveLength(2);
  });

  it("drops oldest turns and marks truncation", () => {
    const msgs: NormalizedMessage[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(text("x".repeat(4000)));
      msgs.push(asst("y".repeat(4000)));
    }
    const out = truncateToBudget(msgs, 5000);
    expect(out.length).toBeLessThan(msgs.length);
    const first = out[0];
    expect(first.role).toBe("user");
    expect(first.content[0]).toMatchObject({ type: "text", text: "[Earlier conversation truncated]" });
  });

  it("never orphans a tool_use from its result", () => {
    const msgs: NormalizedMessage[] = [
      text("start"),
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "r".repeat(8000) }] },
      text("next question"),
      asst("answer"),
    ];
    const out = truncateToBudget(msgs, 500);
    // The cut must land on the plain user message, not between tool_use and tool_result.
    const hasOrphanResult = out.some(
      (m, i) => m.content.some((b) => b.type === "tool_result") && !out[i - 1]?.content.some((b) => b.type === "tool_use"),
    );
    expect(hasOrphanResult).toBe(false);
  });
});
