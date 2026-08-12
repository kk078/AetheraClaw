import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClarifyRegistry } from "../src/gateway/clarify.js";

// The pending-Promise registry a clarifying question awaits on: request() hands
// back a promise the agent loop can `await`, a client's clarify_response resolves
// it, and an unanswered question times out to null rather than hanging forever.

describe("ClarifyRegistry", () => {
  it("resolves the awaited answer once resolve() is called with the matching id", async () => {
    const registry = new ClarifyRegistry();
    let broadcastId = "";
    const { clarifyId, answer } = registry.request((id) => {
      broadcastId = id;
    });
    expect(broadcastId).toBe(clarifyId);

    expect(registry.resolve(clarifyId, "Tuesday's claim")).toBe(true);
    expect(await answer).toBe("Tuesday's claim");
  });

  it("resolve() on an unknown id is a no-op that reports false, not a throw", () => {
    const registry = new ClarifyRegistry();
    expect(registry.resolve("clar_does_not_exist", "anything")).toBe(false);
  });

  it("resolve() cannot be replayed against an id already answered", async () => {
    const registry = new ClarifyRegistry();
    const { clarifyId, answer } = registry.request(() => {});
    expect(registry.resolve(clarifyId, "first")).toBe(true);
    expect(registry.resolve(clarifyId, "second")).toBe(false);
    expect(await answer).toBe("first");
  });

  it("distinct requests get distinct ids and resolve independently", async () => {
    const registry = new ClarifyRegistry();
    const a = registry.request(() => {});
    const b = registry.request(() => {});
    expect(a.clarifyId).not.toBe(b.clarifyId);

    registry.resolve(b.clarifyId, "b's answer");
    registry.resolve(a.clarifyId, "a's answer");
    expect(await a.answer).toBe("a's answer");
    expect(await b.answer).toBe("b's answer");
  });

  describe("timeout", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("resolves to null — no answer, never a guess — once the timeout elapses unanswered", async () => {
      const registry = new ClarifyRegistry(5_000);
      const { answer } = registry.request(() => {});
      vi.advanceTimersByTime(5_000);
      await expect(answer).resolves.toBeNull();
    });

    it("a late resolve() after timeout reports false and does not affect the already-settled answer", async () => {
      const registry = new ClarifyRegistry(5_000);
      const { clarifyId, answer } = registry.request(() => {});
      vi.advanceTimersByTime(5_000);
      await expect(answer).resolves.toBeNull();
      expect(registry.resolve(clarifyId, "too late")).toBe(false);
    });

    it("defaults to the same 120s timeout ApprovalRegistry uses, when none is given", async () => {
      const registry = new ClarifyRegistry();
      const { answer } = registry.request(() => {});
      vi.advanceTimersByTime(119_999);
      // Not yet — still pending.
      let settled = false;
      void answer.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      vi.advanceTimersByTime(1);
      await expect(answer).resolves.toBeNull();
    });
  });
});
