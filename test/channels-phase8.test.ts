import { describe, expect, it } from "vitest";
import {
  checkBrowserHealth,
  classifyBrowserError,
  renderBrowserHealth,
} from "../src/tools/browser/health.js";
import {
  renderQueueReview,
  resolveVerdict,
  reviewHeld,
  reviewQueue,
  type HeldMessage,
} from "../src/channels/email/quarantine.js";

const NOW = Date.UTC(2026, 5, 1);
const DAY = 86_400_000;

function held(over: Partial<HeldMessage> = {}): HeldMessage {
  return {
    id: "m1",
    sender: "claims@payer.example",
    subject: "Regarding member [REDACTED]",
    status: "new",
    receivedAt: NOW - DAY,
    phiKinds: ["mbi"],
    claimRefs: [],
    deadlines: [],
    ...over,
  };
}

describe("browser health", () => {
  it("reports ready when a browser starts and closes", async () => {
    const r = await checkBrowserHealth({
      importPlaywright: async () => ({ chromium: {} }),
      launch: async () => ({ close: async () => {} }),
    });
    expect(r.status).toBe("ready");
    expect(renderBrowserHealth(r)).toMatch(/ready/);
  });

  it("distinguishes a missing PACKAGE from a missing BINARY", async () => {
    // The two have completely different fixes, and a boolean would send
    // somebody to the wrong one.
    const noPkg = await checkBrowserHealth({
      importPlaywright: async () => {
        throw new Error("Cannot find package 'playwright' imported from /app/x.js");
      },
    });
    expect(noPkg.status).toBe("no_playwright");
    expect(noPkg.fix).toContain("npm install playwright");

    const noBin = await checkBrowserHealth({
      importPlaywright: async () => ({ chromium: {} }),
      launch: async () => {
        throw new Error("Executable doesn't exist at /root/.cache/ms-playwright/chromium-1091/chrome-linux/chrome");
      },
    });
    expect(noBin.status).toBe("no_browser_binary");
    expect(noBin.fix).toContain("playwright install chromium");
  });

  it("points at the configured path when there is one, rather than the download command", async () => {
    const r = classifyBrowserError(new Error("spawn EACCES"), "/opt/pw-browsers/chromium");
    expect(r.fix).toContain("/opt/pw-browsers/chromium");
    expect(r.fix).not.toContain("npx playwright install");
  });

  it("says the rest of the product is unaffected", async () => {
    // Without this sentence, "browser not available" reads as "Orion is
    // broken". Portal automation is one capability among many.
    const out = renderBrowserHealth(classifyBrowserError(new Error("nope"), ""));
    expect(out).toMatch(/unaffected/);
    expect(out).toMatch(/scrubbing|X12/);
  });

  it("actually launches rather than checking for a file", async () => {
    // A binary that exists and cannot run — wrong architecture, missing shared
    // library, no sandbox permission — passes every cheaper check and fails at
    // the moment it matters.
    let launched = false;
    await checkBrowserHealth({
      importPlaywright: async () => ({ chromium: {} }),
      launch: async () => {
        launched = true;
        return { close: async () => {} };
      },
    });
    expect(launched).toBe(true);
  });
});

describe("the quarantine review queue", () => {
  it("treats a deadline in a held message as the worst case there is", () => {
    const r = reviewHeld(held({ deadlines: ["appeal due 2026-06-15"] }), NOW);
    expect(r.urgency).toBe("critical");
    // It has a clock AND it is invisible to everything that would chase it.
    expect(r.reason).toMatch(/clock/);
  });

  it("escalates anything held for two weeks", () => {
    const r = reviewHeld(held({ receivedAt: NOW - 20 * DAY }), NOW);
    expect(r.urgency).toBe("critical");
    expect(r.reason).toMatch(/Quarantine protects the database, not the practice/);
  });

  it("raises a message naming a claim above an anonymous notice", () => {
    expect(reviewHeld(held({ claimRefs: ["CLM-1042"] }), NOW).urgency).toBe("high");
    expect(reviewHeld(held(), NOW).urgency).toBe("normal");
  });

  it("orders the queue worst first", () => {
    const q = reviewQueue(
      [held({ id: "a" }), held({ id: "b", deadlines: ["due soon"] }), held({ id: "c", claimRefs: ["X"] })],
      NOW,
    );
    expect(q.map((r) => r.message.id)).toEqual(["b", "c", "a"]);
  });

  it("never suggests the agent can open one", () => {
    // The single most likely misreading of this list. The bodies were not
    // withheld — they were never stored.
    const out = renderQueueReview(reviewQueue([held()], NOW));
    expect(out).toMatch(/never stored/);
    expect(out).toMatch(/read in the mailbox/i);
  });

  it("says plainly when nothing is held", () => {
    expect(renderQueueReview([])).toMatch(/No mail is being held/);
  });
});

describe("resolving a held message", () => {
  it("refuses an empty outcome", () => {
    // Clearing it with no outcome leaves a row asserting somebody handled it
    // and no way to know what happened.
    const v = resolveVerdict({ id: "m1", outcome: "   ", actor: "kim" });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/no way to know what happened/);
  });

  it("refuses an outcome too short to mean anything", () => {
    expect(resolveVerdict({ id: "m1", outcome: "done", actor: "kim" }).ok).toBe(false);
  });

  it("accepts an outcome somebody could act on later", () => {
    const v = resolveVerdict({
      id: "m1",
      outcome: "Aetna appeal decision — upheld; recorded against CLM-1042 and closed",
      actor: "kim",
    });
    expect(v.ok).toBe(true);
    expect(v.status).toBe("resolved");
  });
});
