import { z } from "zod";
import { defineTool } from "../tools/registry.js";
import { newId } from "../shared/ids.js";
import type { Config } from "../config/config.js";
import type { MemoryStore } from "../memory/store.js";
import {
  CHECKPOINT_STAGES,
  STAGES,
  findTransition,
  mayAutomate,
  transitionsFrom,
  type Stage,
  type SwarmMode,
} from "./stages.js";
import {
  DEFAULT_LIMITS,
  clusterFailures,
  planDispatch,
  renderPlan,
  type BlackboardItem,
} from "./dispatch.js";

function db(ctx: { services: Record<string, unknown> }) {
  return (ctx.services.store as MemoryStore).db;
}

function mode(ctx: { services: Record<string, unknown> }): SwarmMode {
  return (ctx.services.config as Config).swarm.mode;
}

interface Row {
  id: string;
  claim_ref: string;
  payer: string;
  stage: string;
  amount_cents: number;
  attempts: number;
  last_error: string;
  note: string;
  updated_at: number;
}

function toItem(row: Row): BlackboardItem {
  return {
    id: row.id,
    claimRef: row.claim_ref,
    payer: row.payer,
    stage: row.stage as Stage,
    attempts: row.attempts,
    lastError: row.last_error,
    amountCents: row.amount_cents,
    updatedAt: row.updated_at,
  };
}

function loadBoard(ctx: { services: Record<string, unknown> }): BlackboardItem[] {
  return (db(ctx).prepare("SELECT * FROM blackboard").all() as Row[]).map(toItem);
}

function logEvent(
  ctx: { services: Record<string, unknown> },
  claimRef: string,
  from: string,
  to: string,
  actor: string,
  automated: boolean,
  detail: string,
): void {
  db(ctx)
    .prepare(
      `INSERT INTO blackboard_events (id, claim_ref, from_stage, to_stage, actor, automated, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId("bbe"), claimRef, from, to, actor, automated ? 1 : 0, detail.slice(0, 1000), Date.now());
}

const STAGE_KEYS = Object.keys(STAGES) as [Stage, ...Stage[]];

export const swarmTrackTool = defineTool({
  name: "swarm_track",
  description:
    "Put a claim on the swarm blackboard, or move one already there. One row per claim, so there is a single answer to where it is rather than a stage inferred from whichever table was written last.",
  schema: z.object({
    claim_ref: z.string(),
    stage: z.enum(STAGE_KEYS).default("captured"),
    payer: z.string().default(""),
    amount: z.number().min(0).default(0).describe("Claim charge in dollars"),
    note: z.string().default(""),
  }),
  execute: async (input, ctx) => {
    const now = Date.now();
    const existing = db(ctx).prepare("SELECT * FROM blackboard WHERE claim_ref = ?").get(input.claim_ref) as
      | Row
      | undefined;
    db(ctx)
      .prepare(
        `INSERT INTO blackboard (id, claim_ref, payer, stage, amount_cents, attempts, last_error, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, '', ?, ?, ?)
         ON CONFLICT(claim_ref) DO UPDATE SET
           payer = excluded.payer, stage = excluded.stage, amount_cents = excluded.amount_cents,
           attempts = 0, last_error = '', note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(
        newId("bb"),
        input.claim_ref,
        input.payer,
        input.stage,
        Math.round(input.amount * 100),
        input.note,
        now,
        now,
      );
    logEvent(ctx, input.claim_ref, existing?.stage ?? "", input.stage, "manual", false, input.note);
    return {
      content: `${input.claim_ref} is at ${STAGES[input.stage].label} (owner: ${STAGES[input.stage].owner}). Next: ${STAGES[input.stage].action}`,
    };
  },
});

export const swarmBoardTool = defineTool({
  name: "swarm_board",
  description:
    "Show the pipeline: how many claims sit at each stage, what would advance on its own, what is waiting on a person, and what has been parked after repeated failures.",
  schema: z.object({ stage: z.enum(STAGE_KEYS).optional() }),
  execute: async (input, ctx) => {
    let items = loadBoard(ctx);
    if (input.stage) items = items.filter((i) => i.stage === input.stage);
    if (items.length === 0) return { content: "Nothing on the board. Add claims with swarm_track." };
    return { content: renderPlan(planDispatch(items, mode(ctx)), DEFAULT_LIMITS) };
  },
});

export const swarmPlanTool = defineTool({
  name: "swarm_plan",
  description:
    "Show what a swarm run WOULD do without doing any of it. Always safe to call. Reports the blast-radius limits it would apply and halts the plan outright when several claims have failed the same way, since that is one broken thing rather than several unlucky claims.",
  schema: z.object({
    max_items: z.number().int().min(1).max(200).optional(),
    max_attempts: z.number().int().min(1).max(10).optional(),
  }),
  execute: async (input, ctx) => {
    const limits = {
      ...DEFAULT_LIMITS,
      ...(input.max_items ? { maxItems: input.max_items } : {}),
      ...(input.max_attempts ? { maxAttemptsPerItem: input.max_attempts } : {}),
    };
    const items = loadBoard(ctx);
    if (items.length === 0) return { content: "Nothing on the board." };
    const plan = planDispatch(items, mode(ctx), limits);
    return {
      content: [
        renderPlan(plan, limits),
        "",
        `Limits: at most ${limits.maxItems} claim(s) per run, ${limits.maxAttemptsPerItem} attempt(s) per claim per stage, halt at ${limits.systematicFailureThreshold} claims failing the same way.`,
        `Stages that always stop for a person, in every mode: ${CHECKPOINT_STAGES.map((s) => STAGES[s].label).join(", ")}.`,
      ].join("\n"),
    };
  },
});

export const swarmAdvanceTool = defineTool({
  name: "swarm_advance",
  description:
    "Move one claim to its next stage. A transition marked as requiring a person needs an actor name and will not run as the swarm — submitting a claim, sending an appeal and writing off a denial are decisions with a name attached, in every mode.",
  schema: z.object({
    claim_ref: z.string(),
    to_stage: z.enum(STAGE_KEYS),
    actor: z.string().describe("A role name for automated moves, or the person taking a checkpoint"),
    detail: z.string().default(""),
    automated: z.boolean().default(false),
  }),
  execute: async (input, ctx) => {
    const row = db(ctx).prepare("SELECT * FROM blackboard WHERE claim_ref = ?").get(input.claim_ref) as Row | undefined;
    if (!row) return { content: `${input.claim_ref} is not on the board.`, isError: true };

    const from = row.stage as Stage;
    const transition = findTransition(from, input.to_stage);
    if (!transition) {
      const options = transitionsFrom(from);
      return {
        content: `${STAGES[from].label} does not lead to ${STAGES[input.to_stage].label}. From here: ${options.map((t) => STAGES[t.to].label).join(", ") || "nowhere — this is terminal"}.`,
        isError: true,
      };
    }
    if (transition.requiresHuman && input.automated) {
      return {
        content: `That move needs a person: ${transition.reason} It cannot be taken as an automated step in any mode.`,
        isError: true,
      };
    }
    if (!transition.requiresHuman && input.automated && !mayAutomate(transition, mode(ctx))) {
      return {
        content:
          mode(ctx) === "off"
            ? "The swarm is off (swarm.mode). Nothing advances automatically."
            : "Assist mode: the swarm names the next step but does not take it. Set swarm.mode to autopilot-with-checkpoints, or take this move yourself.",
        isError: true,
      };
    }

    const now = Date.now();
    db(ctx)
      .prepare("UPDATE blackboard SET stage = ?, attempts = 0, last_error = '', updated_at = ? WHERE claim_ref = ?")
      .run(input.to_stage, now, input.claim_ref);
    logEvent(ctx, input.claim_ref, from, input.to_stage, input.actor, input.automated, input.detail);

    return {
      content: [
        `${input.claim_ref}: ${STAGES[from].label} → ${STAGES[input.to_stage].label} by ${input.actor}${input.automated ? " (automated)" : ""}.`,
        `Next: ${STAGES[input.to_stage].action}`,
        STAGES[input.to_stage].tool ? `Tool: ${STAGES[input.to_stage].tool}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});

export const swarmFailTool = defineTool({
  name: "swarm_record_failure",
  description:
    "Record that a claim could not be advanced. Attempts accumulate at the current stage, and a claim that keeps failing is parked for a person rather than retried forever. Repeated identical failures across different claims halt the next run.",
  schema: z.object({ claim_ref: z.string(), error: z.string() }),
  execute: async (input, ctx) => {
    const row = db(ctx).prepare("SELECT * FROM blackboard WHERE claim_ref = ?").get(input.claim_ref) as Row | undefined;
    if (!row) return { content: `${input.claim_ref} is not on the board.`, isError: true };
    const attempts = row.attempts + 1;
    db(ctx)
      .prepare("UPDATE blackboard SET attempts = ?, last_error = ?, updated_at = ? WHERE claim_ref = ?")
      .run(attempts, input.error, Date.now(), input.claim_ref);
    logEvent(ctx, input.claim_ref, row.stage, row.stage, "swarm", true, `failed: ${input.error}`);

    const clusters = clusterFailures(loadBoard(ctx));
    const systematic = clusters.find((c) => c.count >= DEFAULT_LIMITS.systematicFailureThreshold);
    return {
      content: [
        `${input.claim_ref} failed at ${STAGES[row.stage as Stage].label} (attempt ${attempts}).`,
        attempts >= DEFAULT_LIMITS.maxAttemptsPerItem
          ? "It is now parked — the next run will leave it for a person rather than trying again."
          : "",
        systematic
          ? `${systematic.count} different claims have now failed the same way. The next run will halt rather than advance anything: that is one broken thing, and continuing would multiply it.`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});

export const swarmHistoryTool = defineTool({
  name: "swarm_history",
  description:
    "Show what the swarm did — every stage change, who or what took it, and whether it was automated. Append-only: an autonomous pipeline that cannot say what it did and who authorized it is not one anybody should run.",
  schema: z.object({
    claim_ref: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  execute: async (input, ctx) => {
    const rows = db(ctx)
      .prepare(
        `SELECT * FROM blackboard_events ${input.claim_ref ? "WHERE claim_ref = ?" : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...(input.claim_ref ? [input.claim_ref, input.limit] : [input.limit])) as Array<{
      claim_ref: string;
      from_stage: string;
      to_stage: string;
      actor: string;
      automated: number;
      detail: string;
      created_at: number;
    }>;
    if (rows.length === 0) return { content: "No swarm activity recorded." };
    return {
      content: rows
        .map((r) => {
          const when = new Date(r.created_at).toISOString().replace("T", " ").slice(0, 19);
          const move = r.from_stage === r.to_stage ? `at ${r.to_stage}` : `${r.from_stage || "(new)"} → ${r.to_stage}`;
          return `${when}  ${r.claim_ref}  ${move}  by ${r.actor}${r.automated ? " [auto]" : ""}${r.detail ? ` — ${r.detail}` : ""}`;
        })
        .join("\n"),
    };
  },
});

export const swarmPipelineTool = defineTool({
  name: "swarm_pipeline",
  description:
    "Explain the claim pipeline itself: every stage, which specialist owns it, and which transitions always stop for a person. Useful before turning autonomy up, since those stops are structural rather than settings.",
  schema: z.object({}),
  execute: async (_input, ctx) => {
    const lines: string[] = [`Swarm mode: ${mode(ctx)}.`, ""];
    for (const stage of STAGE_KEYS) {
      const spec = STAGES[stage];
      const options = transitionsFrom(stage);
      lines.push(
        `${spec.label} — owner: ${spec.owner}${spec.terminal ? " (terminal)" : ""}`,
        `    ${spec.action}${spec.tool ? `  [${spec.tool}]` : ""}`,
      );
      for (const t of options) {
        lines.push(`    → ${STAGES[t.to].label}${t.requiresHuman ? "  ** person required **" : ""}: ${t.reason}`);
      }
      lines.push("");
    }
    lines.push(
      "The transitions marked ** person required ** move money or send something outside the practice. They stop for a person in every mode, including autopilot — a setting that could turn that off would make it not a safety property.",
    );
    return { content: lines.join("\n") };
  },
});
