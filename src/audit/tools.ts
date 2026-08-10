import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { defineTool } from "../tools/registry.js";
import { confinePath } from "../tools/path-guard.js";
import type { Config } from "../config/config.js";
import type { MemoryStore } from "../memory/store.js";
import { renderVerify, verifyChain } from "./chain.js";
import { appendAudit, chainHead, loadAnchors, loadChain } from "./store.js";

type Ctx = { services: Record<string, unknown> };

const store = (ctx: Ctx) => ctx.services.store as MemoryStore;

export const auditRecordTool = defineTool({
  name: "audit_record",
  description:
    "Append an entry to the tamper-evident audit log. Each entry carries the hash of the one before it, so editing a past entry breaks every entry after it. The payload is hashed, not stored — the log proves what happened without becoming a second copy of the data.",
  schema: z.object({
    kind: z.string().describe("e.g. tool_call, approval, review, rule_change, disclosure"),
    actor: z.string().describe("Who or what did it"),
    summary: z.string(),
    payload: z.unknown().optional().describe("Hashed into the entry, never stored"),
  }),
  execute: async (input, ctx) => {
    const entry = appendAudit(store(ctx), input);
    return { content: `Entry ${entry.seq} recorded. Hash ${entry.hash.slice(0, 16)}…` };
  },
});

export const auditVerifyTool = defineTool({
  name: "audit_verify",
  description:
    "Verify the audit log end to end: recompute every hash, check every link, and check the chain against any published anchors. Says plainly what the result does and does not prove — a chain in a database anyone can write to catches corruption and casual edits, and only an anchor catches a consistent rewrite.",
  schema: z.object({}),
  execute: async (_input, ctx) => {
    const anchors = loadAnchors(store(ctx));
    return { content: renderVerify(verifyChain(loadChain(store(ctx)), anchors), anchors.length) };
  },
});

export const auditAnchorTool = defineTool({
  name: "audit_anchor",
  description:
    "Record the current head of the audit log as an anchor, and write it to a file to publish. This is what turns the log from a habit into evidence: put the head hash somewhere this application cannot reach back into — the compliance binder, a signed email to yourself, a commit — and a later rewrite of history is caught even if the rewritten chain is internally consistent.",
  schema: z.object({
    published_to: z.string().describe('Where the anchor is going, e.g. "compliance binder 2026-Q3" or "email to CO"'),
    write_to: z.string().default("").describe("Workspace-relative file to write the witness statement to"),
  }),
  execute: async (input, ctx) => {
    const head = chainHead(store(ctx));
    if (!head) return { content: "The audit log is empty — there is nothing to anchor yet.", isError: true };

    const existing = store(ctx).db.prepare("SELECT seq FROM audit_anchors WHERE seq = ?").get(head.seq);
    if (existing) {
      return { content: `Entry ${head.seq} is already anchored. Record more activity before anchoring again.` };
    }

    store(ctx)
      .db.prepare("INSERT INTO audit_anchors (seq, hash, published_to, created_at) VALUES (?, ?, ?, ?)")
      .run(head.seq, head.hash, input.published_to, Date.now());

    const witness = [
      "Orion audit log anchor",
      "",
      `Entries:   ${head.seq}`,
      `Head hash: ${head.hash}`,
      `Taken at:  ${new Date().toISOString()}`,
      `Published: ${input.published_to}`,
      "",
      "This records the state of the audit log at the moment above. Keep it somewhere",
      "Orion cannot write to. If the log is later rewritten — even consistently,",
      "so that it verifies against itself — comparing it to this hash will show it.",
      "",
      "Verify with: orion audit verify",
    ].join("\n");

    let written = "";
    if (input.write_to) {
      const config = ctx.services.config as Config;
      const target = confinePath(config.workspaceRoot, input.write_to);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, witness, "utf8");
      written = input.write_to;
    }

    return {
      content: [
        `Anchored entry ${head.seq} at ${head.hash.slice(0, 16)}… (${input.published_to}).`,
        written ? `Witness written to ${written}.` : "",
        "The anchor only does its job once it is somewhere outside this machine. Move it now, not later.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});

export const auditLogTool = defineTool({
  name: "audit_log",
  description: "Show recent audit-log entries in order, with their sequence numbers and hashes.",
  schema: z.object({
    limit: z.number().int().min(1).max(500).default(50),
    kind: z.string().default("").describe("Filter to one kind of entry"),
  }),
  execute: async (input, ctx) => {
    const entries = loadChain(store(ctx))
      .filter((e) => !input.kind || e.kind === input.kind)
      .slice(-input.limit);
    if (entries.length === 0) return { content: "No audit entries." };
    return {
      content: entries
        .map(
          (e) =>
            `${String(e.seq).padStart(5)}  ${new Date(e.createdAt).toISOString().replace("T", " ").slice(0, 19)}  ` +
            `${e.kind.padEnd(12)}  ${e.actor.padEnd(18)}  ${e.summary}  [${e.hash.slice(0, 8)}]`,
        )
        .join("\n"),
    };
  },
});
