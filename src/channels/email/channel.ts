import type { Config } from "../../config/config.js";
import type { MemoryStore } from "../../memory/store.js";
import type { AgentEvent } from "../../shared/events.js";
import type { Channel } from "../types.js";
import { newId } from "../../shared/ids.js";
import { classify, renderClassification } from "./classify.js";
import { fetchInbox, imapCredentials } from "./transport.js";

// ── Email channel ────────────────────────────────────────────────────────────
// The first out-of-process channel. It polls a mailbox, classifies what it finds,
// and hands the agent a summary of what arrived — deliberately a summary and not
// the raw mail. Two reasons: a payer letter is long and mostly boilerplate, and
// this deployment is not approved for PHI, so raw bodies do not belong in a
// session transcript that will be stored and replayed.
//
// Outbound mail is NOT part of the poll loop. Replies are drafted and sent
// through approval-gated tools, so nothing leaves the practice on a timer.

export interface EmailChannelDeps {
  config: Config;
  store: MemoryStore;
  /** Inject a message into a session and run the agent. */
  handleUserMessage(sessionId: string, text: string): Promise<void>;
  /** Overridable so the loop is testable without a mail server. */
  fetch?: typeof fetchInbox;
  log?: (message: string) => void;
}

export class EmailChannel implements Channel {
  readonly name = "email";
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(private deps: EmailChannelDeps) {}

  async start(): Promise<void> {
    const email = this.deps.config.email;
    if (!email.enabled) return;
    const creds = imapCredentials(email);
    if (typeof creds === "string") {
      this.log(`email channel not started: ${creds}`);
      return;
    }
    if (!email.sessionId) {
      this.log("email channel not started: email.sessionId is not configured, so there is nowhere to deliver to.");
      return;
    }
    this.log(`email channel polling ${email.imap.mailbox} every ${email.pollSeconds}s`);
    // Fire once immediately so a misconfiguration surfaces now rather than at
    // the end of the first interval.
    void this.poll();
    this.timer = setInterval(() => void this.poll(), email.pollSeconds * 1000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Agent events are not mirrored to the mailbox — replies go out only through email_send. */
  async deliver(_event: AgentEvent): Promise<void> {}

  private log(message: string): void {
    (this.deps.log ?? console.error)(`[email] ${message}`);
  }

  async poll(): Promise<number> {
    // A slow mailbox must not stack overlapping polls on top of each other.
    if (this.polling) return 0;
    this.polling = true;
    try {
      return await this.pollOnce();
    } catch (err) {
      this.log(`poll failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    } finally {
      this.polling = false;
    }
  }

  private async pollOnce(): Promise<number> {
    const email = this.deps.config.email;
    const creds = imapCredentials(email);
    if (typeof creds === "string") return 0;

    const mailbox = email.imap.mailbox;
    const watermark = this.deps.store.db
      .prepare("SELECT MAX(CAST(uid AS INTEGER)) AS uid FROM inbound_mail WHERE mailbox = ?")
      .get(mailbox) as { uid: number | null } | undefined;

    const fetcher = this.deps.fetch ?? fetchInbox;
    const { messages } = await fetcher(creds, {
      mailbox,
      sinceUid: watermark?.uid ?? undefined,
      limit: email.maxPerPoll,
      fromFilters: email.fromFilters,
    });
    if (messages.length === 0) return 0;

    const insert = this.deps.store.db.prepare(
      `INSERT OR IGNORE INTO inbound_mail
         (id, uid, mailbox, sender, subject, body, kind, confidence, route_to,
          deadlines_json, claim_refs_json, amounts_json, phi_json, quarantined, status, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
    );

    const summaries: string[] = [];
    let held = 0;
    for (const message of messages) {
      const c = classify(message);
      const quarantined = email.quarantinePhi && c.phi.length > 0;
      const changed = insert.run(
        newId("mail"),
        message.id,
        mailbox,
        message.from,
        message.subject,
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
      ).changes;
      if (changed === 0) continue;
      if (quarantined) held++;
      summaries.push(renderClassification(message, c));
    }
    if (summaries.length === 0) return 0;

    await this.deps.handleUserMessage(
      email.sessionId,
      [
        `${summaries.length} new message(s) arrived in ${mailbox}.`,
        held > 0 ? `${held} were held for possible PHI and their bodies were not stored.` : "",
        "",
        summaries.join("\n\n---\n\n"),
        "",
        "Nothing has been filed. Review each with email_route and file the ones that need it — read the letter before starting any clock from a date pulled out of it.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return summaries.length;
  }
}
