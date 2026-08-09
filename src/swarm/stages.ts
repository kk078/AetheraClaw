// ── The claim pipeline ───────────────────────────────────────────────────────
// A claim moves through a fixed set of stages, and each stage has an owner: a
// specialist role, or a human. The division is not about capability — it is
// about what should never happen without someone deciding.
//
// Two properties are structural rather than configurable, because a setting that
// can turn off a safety property is a safety property that is off:
//
//   Money and outbound actions always stop for a human. Submitting a claim,
//   sending an appeal, refunding an overpayment — none of those advance on their
//   own in any mode.
//
//   Judgement stages route to a person rather than being automated badly. Code
//   selection is the coder's legal responsibility, so the swarm's job there is
//   to put work in front of them, not to decide.

export type Stage =
  | "captured"
  | "coding"
  | "coded"
  | "scrubbing"
  | "twin_review"
  | "ready_to_submit"
  | "submitted"
  | "rejected"
  | "adjudicated"
  | "denied"
  | "appeal_drafted"
  | "paid"
  | "closed";

export type Role = "coder" | "scrubber" | "submitter" | "denial_fighter" | "auditor" | "treasurer" | "human";

export interface StageSpec {
  stage: Stage;
  label: string;
  owner: Role;
  /** Terminal stages are not advanced by anything. */
  terminal: boolean;
  /** What the owner does here. */
  action: string;
  /** The tool that does the work, when a tool can. */
  tool: string;
}

export const STAGES: Record<Stage, StageSpec> = {
  captured: {
    stage: "captured",
    label: "Captured",
    owner: "coder",
    terminal: false,
    action: "Assemble the encounter into a claim and derive diagnosis pointers.",
    tool: "superbill_build",
  },
  coding: {
    stage: "coding",
    label: "Awaiting coder review",
    owner: "human",
    terminal: false,
    action: "A coder accepts, edits or rejects each suggested code. Code selection is theirs, not the swarm's.",
    tool: "review_decide",
  },
  coded: {
    stage: "coded",
    label: "Coded",
    owner: "scrubber",
    terminal: false,
    action: "Run the scrub: code validity, dx linkage, NPI, modifiers, NCCI/MUE and the compliance pack.",
    tool: "claim_scrub",
  },
  scrubbing: {
    stage: "scrubbing",
    label: "Scrub findings open",
    owner: "human",
    terminal: false,
    action: "Errors the scrub found need a decision before the claim moves on.",
    tool: "claim_scrub",
  },
  twin_review: {
    stage: "twin_review",
    label: "Twin review",
    owner: "submitter",
    terminal: false,
    action: "Run the adversarial payer twin before the claim goes out.",
    tool: "claim_gauntlet",
  },
  ready_to_submit: {
    stage: "ready_to_submit",
    label: "Ready to submit",
    owner: "human",
    terminal: false,
    action: "Build and send the 837. This leaves the practice, so a person releases it.",
    tool: "claim_build_837p",
  },
  submitted: {
    stage: "submitted",
    label: "Submitted",
    owner: "denial_fighter",
    terminal: false,
    action: "Watch for the acknowledgment and the remittance.",
    tool: "ack_parse_277ca",
  },
  rejected: {
    stage: "rejected",
    label: "Front-end rejected",
    owner: "denial_fighter",
    terminal: false,
    action: "Correct and resubmit. This never entered adjudication, so there is nothing to appeal and timely filing is still running.",
    tool: "claim_scrub",
  },
  adjudicated: {
    stage: "adjudicated",
    label: "Adjudicated",
    owner: "treasurer",
    terminal: false,
    action: "Post the remittance and check what was allowed against what was expected.",
    tool: "payment_variance",
  },
  denied: {
    stage: "denied",
    label: "Denied",
    owner: "denial_fighter",
    terminal: false,
    action: "Work the denial: understand it, then decide whether it is appealable.",
    tool: "twin_self_heal",
  },
  appeal_drafted: {
    stage: "appeal_drafted",
    label: "Appeal drafted",
    owner: "human",
    terminal: false,
    action: "Review and send the appeal. This leaves the practice, so a person sends it.",
    tool: "appeal_draft",
  },
  paid: { stage: "paid", label: "Paid", owner: "treasurer", terminal: true, action: "Nothing further.", tool: "" },
  closed: { stage: "closed", label: "Closed", owner: "human", terminal: true, action: "Nothing further.", tool: "" },
};

export interface Transition {
  from: Stage;
  to: Stage;
  /**
   * True when this transition must be taken by a person, in every mode. These
   * are the ones that move money or send something outside the practice.
   */
  requiresHuman: boolean;
  reason: string;
}

export const TRANSITIONS: Transition[] = [
  { from: "captured", to: "coding", requiresHuman: false, reason: "Claim assembled; codes go to the review queue." },
  { from: "coding", to: "coded", requiresHuman: true, reason: "A coder decided the codes. That decision is theirs." },
  { from: "coded", to: "scrubbing", requiresHuman: false, reason: "The scrub found errors that need a decision." },
  { from: "coded", to: "twin_review", requiresHuman: false, reason: "The scrub passed." },
  { from: "scrubbing", to: "coded", requiresHuman: true, reason: "The findings were resolved; re-scrub." },
  { from: "twin_review", to: "ready_to_submit", requiresHuman: false, reason: "The twin stopped objecting." },
  { from: "twin_review", to: "coded", requiresHuman: false, reason: "The twin's objections need work upstream." },
  {
    from: "ready_to_submit",
    to: "submitted",
    requiresHuman: true,
    reason: "Submitting sends a claim outside the practice under its name. A person releases it.",
  },
  { from: "submitted", to: "rejected", requiresHuman: false, reason: "The acknowledgment rejected it." },
  { from: "submitted", to: "adjudicated", requiresHuman: false, reason: "A remittance arrived." },
  { from: "rejected", to: "coded", requiresHuman: false, reason: "Corrected; re-scrub before resubmitting." },
  { from: "adjudicated", to: "paid", requiresHuman: false, reason: "Paid as expected." },
  { from: "adjudicated", to: "denied", requiresHuman: false, reason: "The payer denied it." },
  { from: "denied", to: "appeal_drafted", requiresHuman: false, reason: "An appeal was drafted." },
  { from: "denied", to: "closed", requiresHuman: true, reason: "Writing off a denial is a financial decision." },
  {
    from: "appeal_drafted",
    to: "submitted",
    requiresHuman: true,
    reason: "Sending an appeal is outbound correspondence. A person sends it.",
  },
  { from: "appeal_drafted", to: "closed", requiresHuman: true, reason: "Abandoning an appeal is a financial decision." },
];

export function transitionsFrom(stage: Stage): Transition[] {
  return TRANSITIONS.filter((t) => t.from === stage);
}

export function findTransition(from: Stage, to: Stage): Transition | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

/** A stage nothing can advance out of without a person, whatever the mode. */
export function isCheckpoint(stage: Stage): boolean {
  const options = transitionsFrom(stage);
  return options.length > 0 && options.every((t) => t.requiresHuman);
}

export const CHECKPOINT_STAGES: Stage[] = (Object.keys(STAGES) as Stage[]).filter(isCheckpoint);

export type SwarmMode = "off" | "assist" | "autopilot-with-checkpoints";

/** Whether the swarm may take this transition itself, in this mode. */
export function mayAutomate(transition: Transition, mode: SwarmMode): boolean {
  if (mode === "off") return false;
  if (transition.requiresHuman) return false;
  return mode === "autopilot-with-checkpoints";
}
