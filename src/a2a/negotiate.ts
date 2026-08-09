// ── Agent-to-agent claim negotiation ─────────────────────────────────────────
// A structured protocol two agents can hold a claim conversation over: present
// it, ask for evidence, supply it, propose a number, accept or dispute.
//
// The load-bearing sentence in this whole module is that AN AGREEMENT BETWEEN
// TWO AGENTS IS NOT A PAYMENT DETERMINATION. Nothing here moves money. Money
// moves when the payer's adjudication system produces an 835, and that system
// does not read this protocol. So the outcome of a negotiation is an assertion by
// two parties about what they intend, which is useful — it is a documented,
// signed, timestamped position to hold a payer to — and it is not a remittance.
// A practice that books an agreed amount as expected revenue has booked a
// conversation.
//
// The rest of the design follows from that. Outcomes are marked non-binding in
// the type, every rendered outcome says what still has to happen, and the
// reconciliation step against the real 835 is part of the module rather than
// left as an exercise.

export type Party = "provider" | "payer";

export type MessageType =
  | "present_claim"
  | "request_evidence"
  | "provide_evidence"
  | "propose_adjustment"
  | "accept"
  | "dispute"
  | "withdraw";

export interface A2AMessage {
  id: string;
  from: Party;
  type: MessageType;
  createdAt: number;
  /** propose_adjustment / accept: the amount on the table, in cents. */
  amountCents?: number;
  /** Line-level detail behind an amount. */
  lines?: Array<{ code: string; amountCents: number; note: string }>;
  /** request_evidence: what is wanted. provide_evidence: what is supplied. */
  evidence?: string[];
  reason?: string;
  /** Attestation id, when the sender signed this message. */
  attestationId?: string;
}

export type NegotiationState =
  | "presented"
  | "evidence_requested"
  | "evidence_provided"
  | "offer_on_table"
  | "agreed"
  | "disputed"
  | "withdrawn";

export interface Negotiation {
  id: string;
  claimId: string;
  payer: string;
  billedCents: number;
  state: NegotiationState;
  messages: A2AMessage[];
  /** The outstanding offer, if any, and who made it. */
  offerCents: number;
  offerFrom: Party | null;
  agreedCents: number;
  warnings: string[];
}

const TERMINAL: NegotiationState[] = ["agreed", "disputed", "withdrawn"];

export function isTerminal(state: NegotiationState): boolean {
  return TERMINAL.includes(state);
}

export function openNegotiation(input: { id: string; claimId: string; payer: string; billedCents: number }): Negotiation {
  return {
    id: input.id,
    claimId: input.claimId,
    payer: input.payer,
    billedCents: input.billedCents,
    state: "presented",
    messages: [],
    offerCents: 0,
    offerFrom: null,
    agreedCents: 0,
    warnings: [],
  };
}

export interface ApplyResult {
  ok: boolean;
  negotiation: Negotiation;
  /** Why the message was refused. Empty when ok. */
  rejection: string;
}

/** Which party may send which message type. */
const SENDER: Record<MessageType, Party[]> = {
  present_claim: ["provider"],
  request_evidence: ["payer"],
  provide_evidence: ["provider"],
  propose_adjustment: ["provider", "payer"],
  accept: ["provider", "payer"],
  dispute: ["provider", "payer"],
  withdraw: ["provider"],
};

/** Which states each message type may arrive in. */
const ALLOWED_FROM: Record<MessageType, NegotiationState[]> = {
  present_claim: [],
  request_evidence: ["presented", "evidence_provided", "offer_on_table"],
  provide_evidence: ["evidence_requested"],
  propose_adjustment: ["presented", "evidence_requested", "evidence_provided", "offer_on_table"],
  accept: ["offer_on_table"],
  dispute: ["presented", "evidence_requested", "evidence_provided", "offer_on_table"],
  withdraw: ["presented", "evidence_requested", "evidence_provided", "offer_on_table"],
};

/**
 * Apply one message.
 *
 * Pure: takes a negotiation and a message, returns the next negotiation or a
 * rejection. The single rule worth pointing at is that a party cannot accept its
 * own offer — accepting an offer nobody else made is one party writing down a
 * number and calling it agreed, which is exactly the shape of a fabricated
 * settlement and trivially easy to produce by accident when both sides are
 * agents in the same process.
 */
export function applyMessage(negotiation: Negotiation, message: A2AMessage): ApplyResult {
  const refuse = (rejection: string): ApplyResult => ({ ok: false, negotiation, rejection });

  if (isTerminal(negotiation.state)) {
    return refuse(
      `This negotiation is ${negotiation.state} and closed. Reopening it would rewrite a settled record; start a new negotiation instead.`,
    );
  }
  if (!SENDER[message.type].includes(message.from)) {
    return refuse(`A ${message.from} may not send ${message.type}.`);
  }
  if (message.type === "present_claim") {
    return refuse("The claim is presented when the negotiation is opened; it cannot be presented again.");
  }
  if (!ALLOWED_FROM[message.type].includes(negotiation.state)) {
    return refuse(`${message.type} is not valid while the negotiation is ${negotiation.state}.`);
  }

  const next: Negotiation = {
    ...negotiation,
    messages: [...negotiation.messages, message],
    warnings: [...negotiation.warnings],
  };

  switch (message.type) {
    case "request_evidence": {
      if (!message.evidence || message.evidence.length === 0) {
        return refuse("An evidence request that names nothing cannot be answered. List what is wanted.");
      }
      next.state = "evidence_requested";
      break;
    }

    case "provide_evidence": {
      const asked = lastRequested(negotiation);
      const supplied = new Set((message.evidence ?? []).map((e) => e.trim().toLowerCase()));
      const missing = asked.filter((a) => !supplied.has(a.trim().toLowerCase()));
      if (missing.length > 0) {
        next.warnings.push(
          `Answered without supplying: ${missing.join(", ")}. A partial response usually restarts the payer's clock rather than advancing it.`,
        );
      }
      next.state = "evidence_provided";
      break;
    }

    case "propose_adjustment": {
      const amount = message.amountCents ?? -1;
      if (amount < 0) return refuse("A proposal must carry an amount.");
      if (amount > negotiation.billedCents) {
        next.warnings.push(
          `The proposal of $${(amount / 100).toFixed(2)} exceeds the $${(negotiation.billedCents / 100).toFixed(2)} billed. A payer does not pay more than charges, so this is an error somewhere upstream rather than a favourable offer.`,
        );
      }
      if (negotiation.offerFrom === message.from) {
        next.warnings.push(
          `${message.from} moved its own offer without a counter. Bidding against yourself concedes for free — if the other side has not responded, the response is what to chase.`,
        );
      }
      next.offerCents = amount;
      next.offerFrom = message.from;
      next.state = "offer_on_table";
      break;
    }

    case "accept": {
      if (negotiation.offerFrom === null) return refuse("There is no offer to accept.");
      if (negotiation.offerFrom === message.from) {
        return refuse(
          `${message.from} made the outstanding offer and cannot accept it. An agreement needs two parties; one party accepting its own number is a note to itself.`,
        );
      }
      if (message.amountCents !== undefined && message.amountCents !== negotiation.offerCents) {
        return refuse(
          `Accepted $${(message.amountCents / 100).toFixed(2)} but the offer on the table is $${(negotiation.offerCents / 100).toFixed(2)}. An acceptance at a different number is a counter-offer — send it as one.`,
        );
      }
      next.agreedCents = negotiation.offerCents;
      next.state = "agreed";
      break;
    }

    case "dispute": {
      next.state = "disputed";
      break;
    }

    case "withdraw": {
      next.state = "withdrawn";
      break;
    }
  }

  return { ok: true, negotiation: next, rejection: "" };
}

function lastRequested(negotiation: Negotiation): string[] {
  for (let i = negotiation.messages.length - 1; i >= 0; i--) {
    const m = negotiation.messages[i];
    if (m.type === "request_evidence") return m.evidence ?? [];
  }
  return [];
}

export interface NegotiationOutcome {
  state: NegotiationState;
  agreedCents: number;
  billedCents: number;
  /** Billed minus agreed. Positive means the practice conceded. */
  concessionCents: number;
  rounds: number;
  /** Always false, and it is a constant rather than a computation on purpose. */
  binding: false;
  /** Whether every message that moved money was signed. */
  signedThroughout: boolean;
  notes: string[];
}

export function summarize(negotiation: Negotiation): NegotiationOutcome {
  const moneyMessages = negotiation.messages.filter((m) => m.type === "propose_adjustment" || m.type === "accept");
  const signedThroughout = moneyMessages.length > 0 && moneyMessages.every((m) => Boolean(m.attestationId));

  const notes: string[] = [
    "This is an agreement between two agents, not a payment determination. No money moves until the payer's adjudication system produces an 835, and that system does not read this protocol. Book it as an expected outcome to chase, not as revenue.",
  ];

  if (negotiation.state === "agreed") {
    notes.push(
      `Reconcile against the remittance when it arrives: if the 835 pays something other than $${(negotiation.agreedCents / 100).toFixed(2)}, the agreement is the evidence for the appeal, which is most of what it was for.`,
    );
  }
  if (!signedThroughout && moneyMessages.length > 0) {
    notes.push(
      "Not every message carrying an amount was signed. An unsigned position is repudiable — the counterparty can say it never made that offer, and there is nothing to show otherwise.",
    );
  }
  if (negotiation.state === "disputed") {
    notes.push(
      "A dispute here has no procedural standing on its own. The appeal or IDR route that does have standing runs on its own deadlines, and those did not pause while this was happening.",
    );
  }

  return {
    state: negotiation.state,
    agreedCents: negotiation.agreedCents,
    billedCents: negotiation.billedCents,
    concessionCents: negotiation.state === "agreed" ? negotiation.billedCents - negotiation.agreedCents : 0,
    rounds: negotiation.messages.length,
    binding: false,
    signedThroughout,
    notes,
  };
}

export interface Reconciliation {
  matched: boolean;
  agreedCents: number;
  paidCents: number;
  shortfallCents: number;
  finding: string;
}

/**
 * Compare an agreement against what actually paid.
 *
 * This is the step that makes the protocol worth running. An agreement the payer
 * then underpays is the strongest appeal evidence a practice can hold — its own
 * counterparty on the record at a number — and it is only evidence if somebody
 * checks.
 */
export function reconcile(negotiation: Negotiation, paidCents: number): Reconciliation {
  if (negotiation.state !== "agreed") {
    return {
      matched: false,
      agreedCents: 0,
      paidCents,
      shortfallCents: 0,
      finding: `Nothing was agreed — this negotiation is ${negotiation.state}. The $${(paidCents / 100).toFixed(2)} paid stands on the adjudication alone.`,
    };
  }
  const shortfall = negotiation.agreedCents - paidCents;
  if (shortfall === 0) {
    return {
      matched: true,
      agreedCents: negotiation.agreedCents,
      paidCents,
      shortfallCents: 0,
      finding: `Paid as agreed: $${(paidCents / 100).toFixed(2)}.`,
    };
  }
  return {
    matched: false,
    agreedCents: negotiation.agreedCents,
    paidCents,
    shortfallCents: shortfall,
    finding:
      shortfall > 0
        ? `Underpaid by $${(shortfall / 100).toFixed(2)} against an agreement of $${(negotiation.agreedCents / 100).toFixed(2)}. Appeal with the signed agreement attached — the payer's own agent is on the record at that number.`
        : `Paid $${(-shortfall / 100).toFixed(2)} MORE than agreed. An overpayment is not a windfall; the 60-day report-and-return clock starts from identification, and this is identification.`,
  };
}

export function renderNegotiation(negotiation: Negotiation): string {
  const outcome = summarize(negotiation);
  const lines = [
    `Negotiation ${negotiation.id} — claim ${negotiation.claimId} with ${negotiation.payer}, billed $${(negotiation.billedCents / 100).toFixed(2)}.`,
    `State: ${negotiation.state}${negotiation.state === "agreed" ? ` at $${(negotiation.agreedCents / 100).toFixed(2)} (conceded $${(outcome.concessionCents / 100).toFixed(2)})` : ""}.`,
    "",
  ];
  for (const m of negotiation.messages) {
    const amount = m.amountCents !== undefined ? ` $${(m.amountCents / 100).toFixed(2)}` : "";
    const evidence = m.evidence && m.evidence.length > 0 ? ` [${m.evidence.join(", ")}]` : "";
    lines.push(
      `  ${m.from} → ${m.type}${amount}${evidence}${m.reason ? ` — ${m.reason}` : ""}${m.attestationId ? "  (signed)" : "  (unsigned)"}`,
    );
  }
  if (negotiation.messages.length === 0) lines.push("  (no messages yet)");
  if (negotiation.warnings.length > 0) lines.push("", ...negotiation.warnings.map((w) => `⚠ ${w}`));
  lines.push("", ...outcome.notes.map((n) => `  ${n}`));
  return lines.join("\n");
}
