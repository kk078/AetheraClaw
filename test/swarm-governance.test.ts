import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { swarmAdvanceTool, swarmTrackTool } from "../src/swarm/tools.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { MemoryStore } from "../src/memory/store.js";
import { loadConfig, type Config } from "../src/config/config.js";
import type { ToolContext } from "../src/tools/types.js";

// ── The swarm's human checkpoints must not be crossable by the model alone ───
// swarm.test.ts covers the pure stage graph; nothing drove the tool wrappers,
// where the requiresHuman gate and the audit trail actually live.

let home: string;
let store: MemoryStore;
let config: Config;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "aclaw-swarm-"));
  store = new MemoryStore(path.join(home, "db.sqlite"));
  config = loadConfig({ workspaceRoot: home });
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function ctx(overrides: { approve?: boolean; onApproval?: () => void } = {}): ToolContext {
  return {
    workspaceRoot: home,
    secrets: [],
    sessionId: "s1",
    approvalPolicy: "unsafe-only",
    requestApproval: async () => {
      overrides.onApproval?.();
      return overrides.approve ?? true;
    },
    services: { store, config },
  };
}

function registry() {
  const r = new ToolRegistry();
  r.register(swarmTrackTool);
  r.register(swarmAdvanceTool);
  return r;
}

function history(claim: string) {
  return store.db.prepare("SELECT * FROM blackboard_events WHERE claim_ref = ? ORDER BY created_at").all(claim) as Array<{
    from_stage: string;
    to_stage: string;
    actor: string;
    automated: number;
  }>;
}

function stageOf(claim: string): string {
  return (store.db.prepare("SELECT stage FROM blackboard WHERE claim_ref = ?").get(claim) as { stage: string }).stage;
}

describe("swarm_advance — human checkpoints", () => {
  it("asks a real person before a person-required move, whatever the model reports", async () => {
    const r = registry();
    // Place at ready_to_submit, then try to submit.
    store.db
      .prepare("INSERT INTO blackboard (id, claim_ref, payer, stage, amount_cents, attempts, last_error, note, created_at, updated_at) VALUES ('bb1','CLM-1','Medicare','ready_to_submit',12000,0,'','',0,0)")
      .run();

    let asked = 0;
    const denied = await r.execute(
      "swarm_advance",
      { claim_ref: "CLM-1", to_stage: "submitted", actor: "submitter" },
      ctx({ approve: false, onApproval: () => asked++ }),
    );
    expect(asked).toBe(1);
    expect(denied.isError).toBe(true);
    expect(stageOf("CLM-1")).toBe("ready_to_submit"); // not advanced without approval
  });

  it("records the move only after approval, and never as automated", async () => {
    const r = registry();
    store.db
      .prepare("INSERT INTO blackboard (id, claim_ref, payer, stage, amount_cents, attempts, last_error, note, created_at, updated_at) VALUES ('bb1','CLM-1','Medicare','ready_to_submit',12000,0,'','',0,0)")
      .run();
    const ok = await r.execute("swarm_advance", { claim_ref: "CLM-1", to_stage: "submitted", actor: "Dana" }, ctx({ approve: true }));
    expect(ok.isError).not.toBe(true);
    expect(stageOf("CLM-1")).toBe("submitted");
    const events = history("CLM-1");
    expect(events.at(-1)?.automated).toBe(0);
    expect(events.at(-1)?.actor).toBe("Dana");
  });

  it("refuses a checkpoint outright when the call declares itself automated", async () => {
    const r = registry();
    store.db
      .prepare("INSERT INTO blackboard (id, claim_ref, payer, stage, amount_cents, attempts, last_error, note, created_at, updated_at) VALUES ('bb1','CLM-1','Medicare','ready_to_submit',12000,0,'','',0,0)")
      .run();
    let asked = 0;
    const res = await r.execute(
      "swarm_advance",
      { claim_ref: "CLM-1", to_stage: "submitted", actor: "bot", automated: true },
      ctx({ approve: true, onApproval: () => asked++ }),
    );
    expect(res.isError).toBe(true);
    expect(asked).toBe(0); // rejected before any prompt
    expect(stageOf("CLM-1")).toBe("ready_to_submit");
  });
});

describe("swarm_track — placement only, no pipeline moves", () => {
  it("refuses to jump an existing claim to a non-adjacent stage", async () => {
    const r = registry();
    await r.execute("swarm_track", { claim_ref: "CLM-9", stage: "captured", payer: "UHC", amount: 100 }, ctx());
    const res = await r.execute("swarm_track", { claim_ref: "CLM-9", stage: "submitted" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/swarm_advance/);
    expect(stageOf("CLM-9")).toBe("captured");
  });

  it("does not silently un-park a claim held for a person", async () => {
    const r = registry();
    store.db
      .prepare("INSERT INTO blackboard (id, claim_ref, payer, stage, amount_cents, attempts, last_error, note, created_at, updated_at) VALUES ('bb1','CLM-P','Aetna','scrubbing',9000,3,'payer id missing','',0,0)")
      .run();
    // Re-track with the same stage but new metadata: attempts/last_error must survive.
    await r.execute("swarm_track", { claim_ref: "CLM-P", stage: "scrubbing", payer: "Aetna", amount: 95, note: "recheck" }, ctx());
    const row = store.db.prepare("SELECT attempts, last_error FROM blackboard WHERE claim_ref = ?").get("CLM-P") as {
      attempts: number;
      last_error: string;
    };
    expect(row.attempts).toBe(3);
    expect(row.last_error).toBe("payer id missing");
  });

  it("logs a placement as 'track', not a human 'manual' authorization", async () => {
    const r = registry();
    await r.execute("swarm_track", { claim_ref: "CLM-2", stage: "captured", payer: "UHC", amount: 50 }, ctx());
    expect(history("CLM-2").at(-1)?.actor).toBe("track");
  });
});
