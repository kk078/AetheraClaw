// ── The queue of mail nobody can see ─────────────────────────────────────────
//
// Quarantine already works: a message whose subject or body matches a PHI
// pattern is stored with its body dropped and its subject redacted, and the
// agent never sees it. That is the right posture and it creates a problem the
// posture cannot solve on its own — the message is still a real piece of work.
// An appeal decision, a records request with a clock on it, or a payer's reply
// about a claim can all carry a member ID, and all three then sit in a table
// nobody looks at.
//
// So this is a REVIEW QUEUE, not a release switch. The distinction matters:
//
//   REVIEWING a held message means a person reads its metadata and decides what
//   to do. Nothing is un-redacted and nothing reaches the model.
//
//   RELEASING would mean putting the body back where the agent can read it.
//   That is not offered here, and deliberately. The body was never stored — it
//   is not being withheld, it is gone — so "release" would have to mean
//   re-fetching it from the mailbox, which is a decision about PHI ingress that
//   belongs to the posture, not to a queue.
//
// What a person CAN do is record that they have dealt with it, and say how, so
// the queue drains and the next person knows.
//
// Pure. Rows in, verdicts out.

export interface HeldMessage {
  id: string;
  sender: string;
  /** Already redacted at write time. Never the original. */
  subject: string;
  status: string;
  receivedAt: number;
  /** Which PHI kinds triggered the hold. Kinds, never values. */
  phiKinds: string[];
  claimRefs: string[];
  /** Deadlines the classifier found in the SUBJECT, since the body was not kept. */
  deadlines: string[];
}

export type HeldUrgency = "critical" | "high" | "normal";

export interface HeldReview {
  message: HeldMessage;
  urgency: HeldUrgency;
  /** Days it has been sitting. */
  ageDays: number;
  /** What a person should do, in one sentence. */
  action: string;
  reason: string;
}

const DAY = 86_400_000;

/**
 * Triage one held message.
 *
 * Age is the main signal available, and that is the honest position: with no
 * body there is very little else to go on. Saying so beats inventing a
 * confidence from a redacted subject line.
 */
export function reviewHeld(m: HeldMessage, now: number): HeldReview {
  const ageDays = Math.floor((now - m.receivedAt) / DAY);

  if (m.deadlines.length > 0) {
    return {
      message: m,
      urgency: "critical",
      ageDays,
      action: `Open this message in the mailbox itself and act on it there. ${m.deadlines.join(", ")}.`,
      reason:
        "A date was visible in the subject before it was redacted. A held message with a deadline is the worst " +
        "combination available: it has a clock and it is invisible to everything that would otherwise chase it.",
    };
  }
  if (ageDays >= 14) {
    return {
      message: m,
      urgency: "critical",
      ageDays,
      action: "Open it in the mailbox. If it needed a reply, that reply is now two weeks late.",
      reason:
        `Held ${ageDays} days. Quarantine protects the database, not the practice — the correspondence still ` +
        "happened, and nothing in this system has chased it.",
    };
  }
  if (m.claimRefs.length > 0) {
    return {
      message: m,
      urgency: "high",
      ageDays,
      action: `Read it in the mailbox against ${m.claimRefs.join(", ")}, then record what it said with mail_held_resolve.`,
      reason: "It names a claim, so it is about work in progress rather than a notice.",
    };
  }
  return {
    message: m,
    urgency: ageDays >= 3 ? "high" : "normal",
    ageDays,
    action: "Read it in the mailbox and record the outcome, or mark it as needing nothing.",
    reason:
      `Held ${ageDays} day(s) for ${m.phiKinds.join(", ") || "a PHI pattern"}. The body was never stored, so there ` +
      "is nothing here to read but the sender and the date.",
  };
}

const ORDER: Record<HeldUrgency, number> = { critical: 0, high: 1, normal: 2 };

export function reviewQueue(messages: HeldMessage[], now: number): HeldReview[] {
  return messages
    .map((m) => reviewHeld(m, now))
    .sort((a, b) => ORDER[a.urgency] - ORDER[b.urgency] || b.ageDays - a.ageDays);
}

export function renderQueueReview(reviews: HeldReview[]): string {
  if (reviews.length === 0) {
    return "No mail is being held. Either nothing matched a PHI pattern, or quarantine is off for this deployment.";
  }
  const critical = reviews.filter((r) => r.urgency === "critical").length;
  const lines = [
    `${reviews.length} message(s) held at the PHI boundary${critical > 0 ? `, ${critical} of them urgent` : ""}.`,
    "",
    // Repeated on every render, because the single most likely misreading is
    // that this list is something the agent can open.
    "Bodies were never stored. These have to be read in the mailbox itself; nothing here un-redacts anything.",
    "",
  ];
  for (const r of reviews) {
    lines.push(
      `  [${r.urgency.toUpperCase()}] ${r.ageDays}d  from ${r.message.sender}  "${r.message.subject || "(no subject)"}"`,
    );
    lines.push(`      ${r.action}`);
    lines.push(`      ${r.reason}`);
  }
  return lines.join("\n");
}

export interface ResolveRequest {
  id: string;
  /** What the person did about it. Required — an unexplained resolution is a row that says work happened with no evidence. */
  outcome: string;
  actor: string;
}

export interface ResolveVerdict {
  ok: boolean;
  status: string;
  why: string;
}

/**
 * Decide whether a resolution may be recorded.
 *
 * The outcome text is mandatory and the check is here rather than in a schema
 * default, because a default would make an empty resolution legal and the whole
 * value of this queue is that draining it leaves a record of what was done.
 */
export function resolveVerdict(req: ResolveRequest): ResolveVerdict {
  const outcome = req.outcome.trim();
  if (outcome === "") {
    return {
      ok: false,
      status: "",
      why: "Say what was done about this message. Clearing it with no outcome leaves a row asserting that somebody handled it and no way to know what happened.",
    };
  }
  if (outcome.length < 8) {
    return {
      ok: false,
      status: "",
      why: `"${outcome}" is not an outcome anybody can act on later. Name what the message was and what was done.`,
    };
  }
  return { ok: true, status: "resolved", why: "" };
}
