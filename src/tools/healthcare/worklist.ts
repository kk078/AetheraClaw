import { z } from "zod";
import { defineTool } from "../registry.js";
import { newId } from "../../shared/ids.js";
import type { MemoryStore } from "../../memory/store.js";

function db(ctx: { services: Record<string, unknown> }) {
  const store = ctx.services.store as MemoryStore | undefined;
  if (!store) throw new Error("store service unavailable");
  return store.db;
}

export const worklistAddTool = defineTool({
  name: "worklist_add",
  description:
    "Add an item to the RCM worklist (denials to work, rejections, prior auths, audit responses, reminders). Priority is a number — higher works first.",
  schema: z.object({
    kind: z.enum(["denial", "rejection", "prior_auth", "reminder", "audit", "compliance", "credentialing"]),
    title: z.string(),
    detail: z.string().optional().describe("Free-form detail (claim id, payer, amounts, next step)"),
    priority: z.number().default(0),
    due_days: z.number().int().optional().describe("Days until due (e.g. filing deadline)"),
  }),
  execute: async (input, ctx) => {
    const now = Date.now();
    const id = newId("wl");
    db(ctx)
      .prepare(
        "INSERT INTO worklist_items (id, kind, title, detail_json, status, priority, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)",
      )
      .run(id, input.kind, input.title, JSON.stringify({ detail: input.detail ?? "" }), input.priority, input.due_days ? now + input.due_days * 86_400_000 : null, now, now);
    return { content: `Added worklist item ${id}: [${input.kind}] ${input.title}` };
  },
});

export const worklistListTool = defineTool({
  name: "worklist_list",
  description: "List open worklist items ordered by priority and due date.",
  schema: z.object({
    kind: z.string().optional(),
    status: z.enum(["open", "in_progress", "done", "dismissed"]).default("open"),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  execute: async (input, ctx) => {
    const rows = db(ctx)
      .prepare(
        `SELECT * FROM worklist_items WHERE status = ? ${input.kind ? "AND kind = ?" : ""} ORDER BY priority DESC, COALESCE(due_at, 9e15) ASC LIMIT ?`,
      )
      .all(...(input.kind ? [input.status, input.kind, input.limit] : [input.status, input.limit])) as Array<{
      id: string;
      kind: string;
      title: string;
      priority: number;
      due_at: number | null;
    }>;
    if (rows.length === 0) return { content: "Worklist is empty." };
    return {
      content: rows
        .map(
          (r) =>
            `${r.id}  [${r.kind}] p=${r.priority}${r.due_at ? ` due=${new Date(r.due_at).toISOString().slice(0, 10)}` : ""}  ${r.title}`,
        )
        .join("\n"),
    };
  },
});

export const worklistUpdateTool = defineTool({
  name: "worklist_update",
  description: "Update a worklist item's status (open, in_progress, done, dismissed).",
  schema: z.object({
    id: z.string(),
    status: z.enum(["open", "in_progress", "done", "dismissed"]),
  }),
  execute: async (input, ctx) => {
    const res = db(ctx)
      .prepare("UPDATE worklist_items SET status = ?, updated_at = ? WHERE id = ?")
      .run(input.status, Date.now(), input.id);
    return res.changes ? { content: `${input.id} → ${input.status}` } : { content: `No item ${input.id}`, isError: true };
  },
});
