import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "../../tools/registry.js";
import { confinePath } from "../../tools/path-guard.js";
import { newId } from "../../shared/ids.js";
import { appendAudit } from "../../audit/store.js";
import type { Config } from "../../config/config.js";
import type { MemoryStore } from "../../memory/store.js";
import { classify, redact, renderClassification, type InboundMessage } from "./classify.js";
import { fetchInbox, imapCredentials, sendMail, smtpCredentials } from "./transport.js";

function db(ctx: { services: Record<string, unknown> }) {
  const store = ctx.services.store as MemoryStore | undefined;
  if (!store) throw new Error("store service unavailable");
  return store.db;
}

function emailConfig(ctx: { services: Record<string, unknown> }): Config["email"] {
  return (ctx.services.config as Config).email;
}

interface MailRow {
  id: string;
  uid: string;
  sender: string;
  subject: string;
  body: string;
  kind: string;
  confidence: number;
  route_to: string;
  deadlines_json: string;
  claim_refs_json: string;
  amounts_json: string;
  phi_json: string;
  quarantined: number;
  status: string;
  received_at: number;
}

/** Store one classified message. Returns false when it was already stored. */
function storeMessage(
  ctx: { services: Record<string, unknown> },
  mailbox: string,
  message: InboundMessage,
  quarantinePhi: boolean,
): { stored: boolean; quarantined: boolean; summary: string } {
  const c = classify(message);
  const quarantined = quarantinePhi && c.phi.length > 0;
  const result = db(ctx)
    .prepare(
      `INSERT OR IGNORE INTO inbound_mail
         (id, uid, mailbox, sender, subject, body, kind, confidence, route_to,
          deadlines_json, claim_refs_json, amounts_json, phi_json, quarantined, status, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
    )
    .run(
      newId("mail"),
      message.id,
      mailbox,
      message.from,
      // Redact the subject too when quarantining — PHI in the subject is what
      // triggered it, and storing it raw defeats the quarantine.
      quarantined ? redact(message.subject) : message.subject,
      quarantined ? "" : message.text,
      c.kind,
      c.confidence,
      c.routeTo,
      JSON.stringify(c.deadlines),
      JSON.stringify(c.claimRefs),
      JSON.stringify(c.amountsCents),
      JSON.stringify(c.phi),
      quarantined ? 1 : 0,
      message.receivedAt,
      Date.now(),
    );
  const stored = result.changes > 0;
  if (stored) {
    // Bind the ingest into the hash chain. The HASH of the raw message is what
    // is anchored — not the message — so the chain can later prove that a
    // specific letter was the one ingested, without the log becoming a second
    // copy of correspondence whose body was deliberately not stored.
    const store = ctx.services.store as MemoryStore | undefined;
    if (store) {
      appendAudit(store, {
        kind: "mail_ingest",
        actor: `mailbox:${mailbox}`,
        summary: `${c.kind} from ${message.from} — ${message.subject.slice(0, 120)}${quarantined ? " [HELD: PHI]" : ""}`,
        payload: { uid: message.id, from: message.from, subject: message.subject, body: message.text },
      });
    }
  }
  return { stored, quarantined, summary: renderClassification(message, c) };
}

export const emailPollTool = defineTool({
  name: "email_poll",
  description:
    "Fetch new payer correspondence from the configured mailbox and classify each message into the RCM artifact it actually is — a records request, an audit notice, an overpayment demand, a revalidation notice, a denial, a policy bulletin — along with the deadlines, claim references and amounts it carries. Only messages newer than the last poll are read. Messages carrying identifier-shaped text are held rather than stored, because this deployment is not approved for real patient data.",
  schema: z.object({
    mailbox: z.string().optional().describe("Defaults to the configured mailbox"),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  assessRisk: () => ({ level: "confirm", reason: "connect to the mailbox and read new messages" }),
  execute: async (input, ctx) => {
    const config = emailConfig(ctx);
    const creds = imapCredentials(config);
    if (typeof creds === "string") return { content: creds, isError: true };

    const mailbox = input.mailbox ?? config.imap.mailbox;
    const watermark = db(ctx)
      .prepare("SELECT MAX(CAST(uid AS INTEGER)) AS uid FROM inbound_mail WHERE mailbox = ?")
      .get(mailbox) as { uid: number | null } | undefined;

    let result;
    try {
      result = await fetchInbox(creds, {
        mailbox,
        sinceUid: watermark?.uid ?? undefined,
        limit: input.limit ?? config.maxPerPoll,
        fromFilters: config.fromFilters,
      });
    } catch (err) {
      return { content: `Could not read ${mailbox}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }

    if (result.messages.length === 0) {
      return { content: `No new messages in ${mailbox} since UID ${watermark?.uid ?? 0}.` };
    }

    const summaries: string[] = [];
    let stored = 0;
    let quarantined = 0;
    for (const message of result.messages) {
      const outcome = storeMessage(ctx, mailbox, message, config.quarantinePhi);
      if (!outcome.stored) continue;
      stored++;
      if (outcome.quarantined) quarantined++;
      summaries.push(outcome.summary);
    }

    return {
      content: [
        `${stored} new message(s) from ${mailbox}.`,
        quarantined > 0
          ? `${quarantined} held for possible PHI — their bodies were not stored. Review them in the mailbox directly, or set email.quarantinePhi to false only if this deployment has been cleared for patient data.`
          : "",
        "",
        summaries.join("\n\n---\n\n"),
        "",
        "Nothing has been filed anywhere yet. Use email_route to see what each message implies, then call the tool it names.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});

export const emailListTool = defineTool({
  name: "email_list",
  description: "List classified payer correspondence, newest first. Defaults to what has not been routed yet.",
  schema: z.object({
    status: z.enum(["new", "routed", "dismissed", "all"]).default("new"),
    kind: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  execute: async (input, ctx) => {
    const where: string[] = [];
    const args: unknown[] = [];
    if (input.status !== "all") {
      where.push("status = ?");
      args.push(input.status);
    }
    if (input.kind) {
      where.push("kind = ?");
      args.push(input.kind);
    }
    const rows = db(ctx)
      .prepare(
        `SELECT * FROM inbound_mail ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY received_at DESC LIMIT ?`,
      )
      .all(...args, input.limit) as MailRow[];
    if (rows.length === 0) return { content: "No correspondence matched." };

    return {
      content: rows
        .map((r) => {
          const deadlines = JSON.parse(r.deadlines_json) as Array<{ days?: number; date?: string }>;
          const when = new Date(r.received_at).toISOString().slice(0, 10);
          return [
            `${r.id}  [${r.kind}] ${when}  ${r.subject || "(no subject)"}`,
            `      from ${r.sender}${r.route_to ? ` · route with ${r.route_to}` : ""}${r.quarantined ? " · HELD for possible PHI" : ""}`,
            deadlines.length
              ? `      deadlines: ${deadlines.map((d) => (d.days !== undefined ? `${d.days}d from receipt` : d.date)).join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n"),
    };
  },
});

export const emailRouteTool = defineTool({
  name: "email_route",
  description:
    "Show one message's full classification — what it is, which tool should take it, the deadlines it imposes and the claims it names — and optionally mark it routed once you have filed it. This tool does not file anything itself: the deadline in a letter is the one that governs, and it should be read before a clock is started from it.",
  schema: z.object({
    mail_id: z.string(),
    mark: z.enum(["routed", "dismissed"]).optional().describe("Set once you have actually filed it"),
    note: z.string().optional(),
  }),
  execute: async (input, ctx) => {
    const row = db(ctx).prepare("SELECT * FROM inbound_mail WHERE id = ?").get(input.mail_id) as MailRow | undefined;
    if (!row) return { content: `No message ${input.mail_id}.`, isError: true };

    if (input.mark) {
      db(ctx).prepare("UPDATE inbound_mail SET status = ? WHERE id = ?").run(input.mark, input.mail_id);
    }

    const deadlines = JSON.parse(row.deadlines_json) as Array<{ days?: number; date?: string; quote: string }>;
    const claimRefs = JSON.parse(row.claim_refs_json) as string[];
    const amounts = JSON.parse(row.amounts_json) as number[];
    const phi = JSON.parse(row.phi_json) as Array<{ hint: string; count: number }>;
    const receivedYmd = new Date(row.received_at).toISOString().slice(0, 10).replace(/-/g, "");

    const lines = [
      `${row.id} — ${row.kind} (${(row.confidence * 100).toFixed(0)}% confidence)`,
      `From ${row.sender} · received ${receivedYmd}`,
      `Subject: ${row.subject}`,
      "",
    ];
    if (row.route_to) lines.push(`File it with: ${row.route_to}`, "");
    if (deadlines.length) {
      lines.push("Deadlines stated in the message:");
      for (const d of deadlines) {
        lines.push(
          d.days !== undefined
            ? `  ${d.days} days from receipt (${receivedYmd}) — "${d.quote}"`
            : `  ${d.date} — "${d.quote}"`,
        );
      }
      lines.push("");
    }
    if (claimRefs.length) lines.push(`Claim references: ${claimRefs.join(", ")}`, "");
    if (amounts.length) lines.push(`Amounts: ${amounts.map((c) => `$${(c / 100).toFixed(2)}`).join(", ")}`, "");
    if (phi.length) {
      lines.push(
        `HELD — ${phi.map((p) => `${p.count}× ${p.hint}`).join(", ")}. The body was not stored; read it in the mailbox.`,
        "",
      );
    } else if (row.body) {
      lines.push("Body:", redact(row.body).slice(0, 4000), "");
    }
    lines.push(
      "Read the letter before starting a clock from it. These dates are pulled by pattern and the letter's own wording governs.",
    );
    if (input.mark) lines.push("", `Marked ${input.mark}.`);
    return { content: lines.join("\n") };
  },
});

export const emailDraftTool = defineTool({
  name: "email_draft",
  description:
    "Draft an outbound reply and store it unsent. Nothing leaves the practice until email_send is approved, so a draft can be reviewed and edited first.",
  schema: z.object({
    to: z.string(),
    subject: z.string(),
    body: z.string(),
    in_reply_to: z.string().optional().describe("Message-ID being replied to"),
  }),
  execute: async (input, ctx) => {
    const id = newId("out");
    db(ctx)
      .prepare(
        `INSERT INTO outbound_mail (id, recipient, subject, body, in_reply_to, status, message_id, error, created_at, sent_at)
         VALUES (?, ?, ?, ?, ?, 'draft', '', '', ?, NULL)`,
      )
      .run(id, input.to, input.subject, input.body, input.in_reply_to ?? "", Date.now());
    return {
      content: `Drafted ${id} to ${input.to}: "${input.subject}". Nothing has been sent — review it, then send with email_send.`,
    };
  },
});

export const emailSendTool = defineTool({
  name: "email_send",
  description:
    "Send a stored draft. This puts a message outside the practice under its own address, so it is approval-gated and sends only what was drafted.",
  schema: z.object({ draft_id: z.string() }),
  assessRisk: (input) => ({ level: "confirm", reason: `send email draft ${input.draft_id}` }),
  execute: async (input, ctx) => {
    const config = emailConfig(ctx);
    const creds = smtpCredentials(config);
    if (typeof creds === "string") return { content: creds, isError: true };
    const from = config.smtp.from || config.smtp.user;

    const row = db(ctx)
      .prepare("SELECT * FROM outbound_mail WHERE id = ?")
      .get(input.draft_id) as
      | { id: string; recipient: string; subject: string; body: string; in_reply_to: string; status: string }
      | undefined;
    if (!row) return { content: `No draft ${input.draft_id}.`, isError: true };
    if (row.status === "sent") return { content: `${row.id} was already sent.`, isError: true };

    try {
      const messageId = await sendMail(creds, from, {
        to: row.recipient,
        subject: row.subject,
        body: row.body,
        inReplyTo: row.in_reply_to || undefined,
      });
      db(ctx)
        .prepare("UPDATE outbound_mail SET status = 'sent', message_id = ?, sent_at = ? WHERE id = ?")
        .run(messageId, Date.now(), row.id);
      return { content: `Sent ${row.id} to ${row.recipient} (${messageId}).` };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      db(ctx).prepare("UPDATE outbound_mail SET status = 'failed', error = ? WHERE id = ?").run(error, row.id);
      return { content: `Could not send ${row.id}: ${error}. The draft is kept and can be retried.`, isError: true };
    }
  },
});

export const emailIngestTool = defineTool({
  name: "email_ingest_file",
  description:
    "Classify correspondence from a file in the workspace rather than a mailbox — a saved letter, an exported message, or a pasted transcript. Useful when the mailbox is not connected, and the only way to exercise the classifier on real letters without giving out mailbox credentials.",
  schema: z.object({
    path: z.string().describe("Workspace-relative path to a text file"),
    from: z.string().default("(file)"),
    subject: z.string().default(""),
    store: z.boolean().default(true),
  }),
  execute: async (input, ctx) => {
    const p = confinePath(ctx.workspaceRoot, input.path);
    if (!fs.existsSync(p)) return { content: `No file at ${input.path}.`, isError: true };
    const text = fs.readFileSync(p, "utf8");
    const message: InboundMessage = {
      id: `file:${path.basename(p)}:${fs.statSync(p).mtimeMs}`,
      from: input.from,
      subject: input.subject || path.basename(p),
      text,
      receivedAt: Date.now(),
    };
    if (!input.store) return { content: renderClassification(message, classify(message)) };
    const outcome = storeMessage(ctx, "file", message, emailConfig(ctx).quarantinePhi);
    return {
      content: [outcome.summary, "", outcome.stored ? "Stored for routing." : "Already stored — nothing changed."].join("\n"),
    };
  },
});
