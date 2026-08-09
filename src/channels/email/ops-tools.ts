import fs from "node:fs";
import { z } from "zod";
import { defineTool } from "../../tools/registry.js";
import { confinePath } from "../../tools/path-guard.js";
import type { MemoryStore } from "../../memory/store.js";
import { classify, type Classification, type CorrespondenceKind } from "./classify.js";
import { recommend, renderRecommendation, type LocalFacts, type Urgency } from "./recommend.js";
import { renderTriage, triageAttachments } from "./attachments.js";
import {
  buildBriefing,
  payerLatency,
  renderBriefing,
  renderLatency,
  type CorrespondenceRecord,
} from "./mis.js";

interface MailRow {
  id: string;
  sender: string;
  subject: string;
  kind: string;
  confidence: number;
  route_to: string;
  deadlines_json: string;
  claim_refs_json: string;
  amounts_json: string;
  quarantined: number;
  status: string;
  received_at: number;
}

function store(ctx: { services: Record<string, unknown> }): MemoryStore | undefined {
  return ctx.services.store as MemoryStore | undefined;
}

function loadMail(s: MemoryStore, sinceMs: number, status?: string): MailRow[] {
  const rows = status
    ? s.db.prepare("SELECT * FROM inbound_mail WHERE received_at >= ? AND status = ? ORDER BY received_at DESC").all(sinceMs, status)
    : s.db.prepare("SELECT * FROM inbound_mail WHERE received_at >= ? ORDER BY received_at DESC").all(sinceMs);
  return rows as MailRow[];
}

/** Rebuild the classification from stored columns, without re-reading a body that may never have been stored. */
function classificationOf(row: MailRow): Classification {
  return {
    kind: row.kind as CorrespondenceKind,
    confidence: row.confidence,
    matched: [],
    routeTo: row.route_to,
    why: "",
    deadlines: JSON.parse(row.deadlines_json || "[]"),
    amountsCents: JSON.parse(row.amounts_json || "[]"),
    claimRefs: JSON.parse(row.claim_refs_json || "[]"),
    phi: [],
  };
}

/**
 * What this database already knows about the claims a letter names.
 *
 * One query per fact rather than a join, because the tables normalize claim ids
 * differently — `claims` stores it inside a JSON blob, `filing_proof` in a
 * column, `worklist_items` in a detail blob. Matching each on its own terms is
 * the only way the answers agree.
 */
function localFacts(s: MemoryStore, refs: string[]): LocalFacts {
  const facts: LocalFacts = { knownClaims: [], claimsWithOpenItem: [], claimsWithFilingProof: [], claimsAdjudicated: [] };
  for (const ref of refs) {
    const like = `%${ref}%`;
    if (s.db.prepare("SELECT 1 FROM claims WHERE id = ? OR claim_json LIKE ? LIMIT 1").get(ref, like)) facts.knownClaims.push(ref);
    if (
      s.db
        .prepare("SELECT 1 FROM worklist_items WHERE status IN ('open','in_progress') AND (title LIKE ? OR detail_json LIKE ?) LIMIT 1")
        .get(like, like)
    ) {
      facts.claimsWithOpenItem.push(ref);
    }
    if (s.db.prepare("SELECT 1 FROM filing_proof WHERE UPPER(TRIM(claim_id)) = ? LIMIT 1").get(ref.toUpperCase())) {
      facts.claimsWithFilingProof.push(ref);
    }
    if (s.db.prepare("SELECT 1 FROM remittances WHERE era_json LIKE ? LIMIT 1").get(like)) facts.claimsAdjudicated.push(ref);
  }
  return facts;
}

const URGENCY_ORDER: Record<Urgency, number> = { critical: 0, high: 1, normal: 2, informational: 3 };

export const mailInboxSweepTool = defineTool({
  name: "mail_inbox_sweep",
  description:
    "List operational mail grouped by URGENCY rather than by arrival, with the claim each letter names and what the system already knows about it. Urgency comes from the deadline the letter states — computed from when it was RECEIVED, so looking at the inbox again never resets the clock — not from its category: an ADR with 25 days left and one with 3 are the same kind of letter and different problems.",
  schema: z.object({
    hours: z.number().int().min(1).max(24 * 365).default(168),
    status: z.enum(["new", "routed", "dismissed"]).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  execute: async (input, ctx) => {
    const s = store(ctx);
    if (!s) return { content: "No database in this context.", isError: true };

    const now = Date.now();
    const rows = loadMail(s, now - input.hours * 3_600_000, input.status).slice(0, input.limit);
    if (rows.length === 0) {
      return { content: `No operational mail in the last ${input.hours}h. Mail is classified as it is polled — an empty sweep means nothing arrived, not that nothing needs attention.` };
    }

    const scored = rows.map((row) => {
      const c = classificationOf(row);
      return { row, c, rec: recommend(c, localFacts(s, c.claimRefs), now, row.received_at) };
    });
    scored.sort((a, b) => URGENCY_ORDER[a.rec.urgency] - URGENCY_ORDER[b.rec.urgency] || (a.rec.daysToDeadline ?? 999) - (b.rec.daysToDeadline ?? 999));

    const counts = scored.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x.rec.urgency]: (acc[x.rec.urgency] ?? 0) + 1 }), {});
    const held = rows.filter((r) => r.quarantined === 1).length;

    return {
      content: [
        `${rows.length} message(s) in the last ${input.hours}h — ` +
          (["critical", "high", "normal", "informational"] as Urgency[])
            .filter((u) => counts[u])
            .map((u) => `${counts[u]} ${u}`)
            .join(", "),
        held > 0 ? `${held} held for possible PHI; their bodies were never stored, so the facts below came from headers and subjects.` : "",
        "",
        ...scored.map((x) => renderRecommendation(x.rec, `${x.row.subject || "(no subject)"} — from ${x.row.sender}`)),
        "",
        "Nothing has been filed. Each entry names the tools that would act on it.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  },
});

export const mailAttachmentScanTool = defineTool({
  name: "mail_attachment_scan",
  description:
    "Identify what a saved email attachment IS and name the tool that parses it. Detection is by CONTENT before extension, because extensions lie constantly here — an 835 arrives as .txt, .dat, .era or with none at all, while the ISA envelope and the ST transaction-set code inside it do not lie. Reports PDFs as PDFs: there is no PDF text extraction in this build, and returning the ASCII fragments visible in a raw PDF stream would look like a reading and be worse than nothing.",
  schema: z.object({
    paths: z.array(z.string()).min(1).describe("Workspace-relative paths to saved attachments"),
  }),
  execute: async (input, ctx) => {
    const files: Array<{ filename: string; content: Buffer }> = [];
    const missing: string[] = [];
    for (const p of input.paths) {
      try {
        const resolved = confinePath(ctx.workspaceRoot, p);
        if (!fs.existsSync(resolved)) {
          missing.push(p);
          continue;
        }
        files.push({ filename: p, content: fs.readFileSync(resolved) });
      } catch (err) {
        missing.push(`${p} (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    const parts = [renderTriage(triageAttachments(files))];
    if (missing.length > 0) parts.push("", `Not read: ${missing.join(", ")}`);
    return { content: parts.join("\n"), isError: files.length === 0 };
  },
});

export const mailRecommendActionTool = defineTool({
  name: "mail_recommend_action",
  description:
    "Cross-reference one stored message against what this database already knows about the claims it names, and recommend the next step. The same records request is three different situations — claim unknown here, claim known with nothing open, or an item already open — and only the middle one is work. It refuses to recommend opening an item for a claim that does not exist, because a queue full of phantom claims is worse than an empty one.",
  schema: z.object({
    mail_id: z.string().describe("id from mail_inbox_sweep or email_list"),
  }),
  execute: async (input, ctx) => {
    const s = store(ctx);
    if (!s) return { content: "No database in this context.", isError: true };

    const row = s.db.prepare("SELECT * FROM inbound_mail WHERE id = ?").get(input.mail_id) as MailRow | undefined;
    if (!row) return { content: `No message with id ${input.mail_id}.`, isError: true };

    const c = classificationOf(row);
    const facts = localFacts(s, c.claimRefs);
    const rec = recommend(c, facts, Date.now(), row.received_at);

    const lines = [renderRecommendation(rec, `${row.subject || "(no subject)"} — from ${row.sender}`), ""];
    if (c.claimRefs.length > 0) {
      lines.push(
        "What this database knows about the claims named:",
        ...c.claimRefs.map((ref) => {
          const bits = [
            facts.knownClaims.includes(ref) ? "built here" : "NOT FOUND",
            facts.claimsWithOpenItem.includes(ref) ? "worklist item open" : "",
            facts.claimsWithFilingProof.includes(ref) ? "filing proof banked" : "",
            facts.claimsAdjudicated.includes(ref) ? "remittance received" : "",
          ].filter(Boolean);
          return `  ${ref}: ${bits.join(" · ")}`;
        }),
      );
    } else {
      lines.push("The letter names no claim reference, so nothing could be cross-referenced. Its urgency comes from the stated deadline alone.");
    }
    return { content: lines.join("\n") };
  },
});

export const mailOpsBriefingTool = defineTool({
  name: "mail_ops_briefing",
  description:
    "Daily operational briefing from the mailbox: what arrived, what was held, what could not be placed, how many carry a deadline inside a week, and the dollar value of informal denials — the ones that arrived by email rather than on an 835 and are therefore invisible to remittance analytics, which means the practice's denial rate is understated by exactly these. Optionally reports payer response latency as a median, because one letter arriving after nine months drags a mean past anything anyone would recognise.",
  schema: z.object({
    hours: z.number().int().min(1).max(24 * 90).default(24),
    include_latency: z.boolean().default(false).describe("Also measure days from claim built to first correspondence, per payer"),
  }),
  execute: async (input, ctx) => {
    const s = store(ctx);
    if (!s) return { content: "No database in this context.", isError: true };

    const now = Date.now();
    const rows = loadMail(s, now - input.hours * 3_600_000);
    const records: CorrespondenceRecord[] = rows.map((row) => {
      const c = classificationOf(row);
      return {
        kind: c.kind,
        sender: row.sender,
        // Sender domain stands in for payer: the classifier does not name one,
        // and inventing a payer from body text would attribute letters to the
        // wrong organisation, which is worse than grouping by who sent them.
        payer: row.sender.split("@")[1] ?? row.sender,
        claimRefs: c.claimRefs,
        amountsCents: c.amountsCents,
        receivedAt: row.received_at,
        quarantined: row.quarantined === 1,
        confidence: row.confidence,
      };
    });

    let critical = 0;
    let high = 0;
    let unclassified = 0;
    for (const row of rows) {
      const c = classificationOf(row);
      if (c.kind === "other") unclassified++;
      const rec = recommend(c, localFacts(s, c.claimRefs), now, row.received_at);
      if (rec.urgency === "critical") critical++;
      else if (rec.urgency === "high") high++;
    }

    const parts = [renderBriefing(buildBriefing({ correspondence: records, critical, high, unclassified, windowHours: input.hours }), input.hours)];

    if (input.include_latency) {
      const built = new Map<string, number>();
      for (const r of s.db.prepare("SELECT id, claim_json, created_at FROM claims").all() as Array<{ id: string; claim_json: string; created_at: number }>) {
        let ref = r.id;
        try {
          ref = (JSON.parse(r.claim_json) as { claim_id?: string }).claim_id ?? r.id;
        } catch {
          /* fall back to the row id */
        }
        built.set(ref, r.created_at);
      }
      // Latency is measured over ALL correspondence, not the briefing window: a
      // 24-hour window would report the latency of whatever happened to arrive
      // yesterday, which is not a payer's behaviour.
      const all = loadMail(s, 0).map((row) => {
        const c = classificationOf(row);
        return {
          kind: c.kind,
          sender: row.sender,
          payer: row.sender.split("@")[1] ?? row.sender,
          claimRefs: c.claimRefs,
          amountsCents: c.amountsCents,
          receivedAt: row.received_at,
          quarantined: row.quarantined === 1,
          confidence: row.confidence,
        };
      });
      parts.push("", renderLatency(payerLatency(all, built)));
    }

    return { content: parts.join("\n") };
  },
});

export const MAIL_OPS_TOOLS = [mailInboxSweepTool, mailAttachmentScanTool, mailRecommendActionTool, mailOpsBriefingTool];
