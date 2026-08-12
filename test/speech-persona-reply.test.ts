import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { personaReply } from "../src/speech/persona-reply.js";
import { DEFAULT_PERSONA, personaSystemPrompt } from "../src/speech/persona.js";
import type { ModelProvider, ProviderEvent, TurnRequest } from "../src/providers/types.js";

class FakeProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model = "test";
  lastRequest?: TurnRequest;
  constructor(private chunks: string[]) {}
  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    this.lastRequest = req;
    for (const c of this.chunks) yield { type: "text_delta", text: c };
    yield { type: "turn_end", stopReason: "end_turn", assistant: [] };
  }
}

class ThrowingProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model = "test";
  // eslint-disable-next-line require-yield
  async *streamTurn(): AsyncIterable<ProviderEvent> {
    throw new Error("the provider is unreachable");
  }
}

class HangingProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model = "test";
  // eslint-disable-next-line require-yield
  async *streamTurn(): AsyncIterable<ProviderEvent> {
    await new Promise(() => {}); // never resolves
  }
}

describe("personaReply", () => {
  it("returns the paraphrased text, assembled from streamed chunks", async () => {
    const provider = new FakeProvider(["Looks like the claim is ", "clean, nothing to fix."]);
    const result = await personaReply(provider, "The claim passed all pre-submission checks.");
    expect(result).toBe("Looks like the claim is clean, nothing to fix.");
  });

  it("uses personaSystemPrompt as the system, never buildSystemPrompt's output", async () => {
    const provider = new FakeProvider(["ok"]);
    await personaReply(provider, "the written reply");
    expect(provider.lastRequest?.system).toBe(personaSystemPrompt(DEFAULT_PERSONA));
  });

  it("sends the written reply as the (only) user message, verbatim", async () => {
    const provider = new FakeProvider(["ok"]);
    await personaReply(provider, "  the written reply, with padding  ");
    expect(provider.lastRequest?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "the written reply, with padding" }] },
    ]);
  });

  it("resolves null, not empty string, for empty or whitespace-only input", async () => {
    const provider = new FakeProvider(["should never be called"]);
    expect(await personaReply(provider, "")).toBeNull();
    expect(await personaReply(provider, "   ")).toBeNull();
    expect(provider.lastRequest).toBeUndefined();
  });

  it("resolves null, not empty string, when the model produces no text", async () => {
    const provider = new FakeProvider([]);
    expect(await personaReply(provider, "something")).toBeNull();
  });

  it("resolves null rather than rejecting when the provider throws", async () => {
    await expect(personaReply(new ThrowingProvider(), "something")).resolves.toBeNull();
  });

  it("uses the given persona rather than the default when one is passed", async () => {
    const provider = new FakeProvider(["ok"]);
    const custom = { name: "Rae", voice: "You are Rae, brisk and precise." };
    await personaReply(provider, "the written reply", { persona: custom });
    expect(provider.lastRequest?.system).toBe(personaSystemPrompt(custom));
    expect(provider.lastRequest?.system).not.toBe(personaSystemPrompt(DEFAULT_PERSONA));
  });

  describe("timeout", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("resolves null within timeoutMs when the provider never yields, rather than hanging the caller", async () => {
      const promise = personaReply(new HangingProvider(), "something", { timeoutMs: 5_000 });
      let settled: string | null | "pending" = "pending";
      void promise.then((v) => (settled = v));

      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe("pending");

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBeNull();
    });
  });
});
