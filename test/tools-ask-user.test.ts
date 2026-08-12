import { describe, expect, it, vi } from "vitest";
import { askUserTool } from "../src/tools/ask-user.js";
import type { ToolContext } from "../src/tools/types.js";

// ask_user is the one tool that calls ctx.requestClarification directly from
// inside its own execute() rather than going through the registry's pre-execute
// approval gate — these tests exercise that call in isolation, with a fake
// ctx.requestClarification standing in for the real gateway wiring.

function fakeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: "/tmp/workspace",
    sessionId: "sess_test",
    approvalPolicy: "unsafe-only",
    requestApproval: vi.fn().mockResolvedValue(true),
    services: {},
    ...overrides,
  };
}

describe("askUserTool", () => {
  it("returns the answer, prefixed, when requestClarification resolves with text", async () => {
    const ctx = fakeCtx({ requestClarification: vi.fn().mockResolvedValue("Tuesday's claim") });
    const result = await askUserTool.execute({ question: "Which claim did you mean?" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("User answered: Tuesday's claim");
  });

  it("passes both question and context through to requestClarification", async () => {
    const requestClarification = vi.fn().mockResolvedValue("yes");
    const ctx = fakeCtx({ requestClarification });
    await askUserTool.execute({ question: "Proceed with the write-off?", context: "Balance is under the threshold." }, ctx);
    expect(requestClarification).toHaveBeenCalledWith({
      question: "Proceed with the write-off?",
      context: "Balance is under the threshold.",
    });
  });

  it("reports a timeout plainly rather than inventing an answer, when requestClarification resolves null", async () => {
    const ctx = fakeCtx({ requestClarification: vi.fn().mockResolvedValue(null) });
    const result = await askUserTool.execute({ question: "Which payer?" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No answer was received");
    expect(result.content).toContain("Which payer?");
  });

  it("degrades gracefully with an explanatory error when no clarification channel is wired up", async () => {
    const ctx = fakeCtx(); // requestClarification omitted entirely
    const result = await askUserTool.execute({ question: "Which claim?" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available in this session");
  });

  it("assessRisk defaults to safe — asking a question does not itself trigger the approval gate", () => {
    expect(askUserTool.assessRisk({ question: "anything" }).level).toBe("safe");
  });

  it("rejects an empty question at the schema level", () => {
    const parsed = askUserTool.schema.safeParse({ question: "" });
    expect(parsed.success).toBe(false);
  });
});
