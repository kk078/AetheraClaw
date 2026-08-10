import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import type { EmailConfig } from "../../config/config.js";
import type { InboundMessage } from "./classify.js";

// ── Email transport ──────────────────────────────────────────────────────────
// Thin I/O around IMAP and SMTP. Everything that decides anything lives in
// classify.ts; this file only moves bytes, so the interesting behaviour stays
// testable without a mail server.

export interface MailboxCredentials {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/**
 * Credentials come from the environment, never from config on disk and never
 * from the model. The tool layer types them; they are not rendered into any
 * prompt or tool result.
 */
export function imapCredentials(config: EmailConfig): MailboxCredentials | string {
  const pass = process.env.ORION_IMAP_PASSWORD;
  if (!config.imap.host) return "email.imap.host is not configured.";
  if (!config.imap.user) return "email.imap.user is not configured.";
  if (!pass) return "ORION_IMAP_PASSWORD is not set in the environment.";
  return { host: config.imap.host, port: config.imap.port, secure: config.imap.secure, user: config.imap.user, pass };
}

export function smtpCredentials(config: EmailConfig): MailboxCredentials | string {
  const pass = process.env.ORION_SMTP_PASSWORD ?? process.env.ORION_IMAP_PASSWORD;
  if (!config.smtp.host) return "email.smtp.host is not configured.";
  if (!config.smtp.user) return "email.smtp.user is not configured.";
  if (!pass) return "ORION_SMTP_PASSWORD is not set in the environment.";
  return { host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, user: config.smtp.user, pass };
}

export interface FetchOptions {
  mailbox: string;
  /** Only messages newer than this UID, so a poll never re-reads the inbox. */
  sinceUid?: number;
  limit: number;
  /** Restrict to senders matching any of these substrings. */
  fromFilters: string[];
  /**
   * The UIDVALIDITY the stored watermark was recorded under. IMAP UIDs are only
   * monotonic within a fixed UIDVALIDITY; a mailbox recreation/restore/migration
   * bumps it and resets UIDs to low numbers. When it no longer matches, the old
   * watermark points at UIDs that no longer exist and would filter out every
   * genuinely-new (low-UID) message forever — so a mismatch re-scans from the
   * start.
   */
  expectedUidValidity?: string;
}

export interface FetchResult {
  messages: InboundMessage[];
  highestUid: number;
  /** The mailbox's current UIDVALIDITY, for the caller to persist alongside the watermark. */
  uidValidity: string;
}

function senderAllowed(from: string, filters: string[]): boolean {
  if (filters.length === 0) return true;
  const lower = from.toLowerCase();
  return filters.some((f) => lower.includes(f.toLowerCase()));
}

export async function fetchInbox(creds: MailboxCredentials, opts: FetchOptions): Promise<FetchResult> {
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
  });

  const messages: InboundMessage[] = [];
  let highestUid = opts.sinceUid ?? 0;

  await client.connect();
  const lock = await client.getMailboxLock(opts.mailbox);
  let uidValidity = "";
  try {
    const mb = client.mailbox as { uidValidity?: unknown } | boolean;
    uidValidity = mb && typeof mb === "object" && mb.uidValidity != null ? String(mb.uidValidity) : "";
    // If UIDVALIDITY changed since the watermark was recorded, the watermark is
    // meaningless — start over from UID 1 and do not filter on the stale sinceUid.
    const validityChanged =
      opts.expectedUidValidity !== undefined &&
      opts.expectedUidValidity !== "" &&
      uidValidity !== "" &&
      opts.expectedUidValidity !== uidValidity;
    const sinceUid = validityChanged ? undefined : opts.sinceUid;
    if (validityChanged) highestUid = 0;

    const range = `${(sinceUid ?? 0) + 1}:*`;
    for await (const msg of client.fetch({ uid: range }, { uid: true, source: true }, { uid: true })) {
      if (typeof msg.uid === "number" && msg.uid > highestUid) highestUid = msg.uid;
      if (!msg.source) continue;
      // A `uid: n:*` range always returns at least the newest message even when
      // nothing is newer than n, so anything at or below the watermark is a
      // message we have already seen.
      if (sinceUid !== undefined && typeof msg.uid === "number" && msg.uid <= sinceUid) continue;

      const parsed = await simpleParser(msg.source);
      const from = parsed.from?.text ?? "";
      if (!senderAllowed(from, opts.fromFilters)) continue;

      messages.push({
        id: String(msg.uid ?? parsed.messageId ?? ""),
        from,
        subject: parsed.subject ?? "",
        text: parsed.text ?? (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : ""),
        receivedAt: (parsed.date ?? new Date()).getTime(),
      });
      if (messages.length >= opts.limit) break;
    }
  } finally {
    lock.release();
    await client.logout();
  }

  return { messages, highestUid, uidValidity };
}

export interface OutboundMessage {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
}

export async function sendMail(creds: MailboxCredentials, from: string, message: OutboundMessage): Promise<string> {
  const transport = nodemailer.createTransport({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.user, pass: creds.pass },
  });
  const info = await transport.sendMail({
    from,
    to: message.to,
    subject: message.subject,
    text: message.body,
    inReplyTo: message.inReplyTo,
    references: message.inReplyTo,
  });
  return info.messageId ?? "(no message id returned)";
}
