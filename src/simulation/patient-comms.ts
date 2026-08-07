// ── Patient balances ─────────────────────────────────────────────────────────
// Scoring people on how likely they are to pay is one step away from a
// discrimination engine, so the guard here is the type rather than a policy
// document. PatientAccount has fields for what this account has DONE — prior
// payments on it, how big the balance is, how old, whether insurance has
// finished with it — and no field for age, sex, race, ZIP, language, credit
// score or anything standing in for them. A caller cannot supply what the type
// will not hold.
//
// The output routes to help at least as readily as to collections. A large
// balance from someone who has never paid is the profile of a person who cannot
// pay, not one who will not, and the useful next step is a payment plan or a
// financial-assistance screening. Reading that score as "escalate" gets the
// answer exactly backwards and costs the practice the money it was chasing.
//
// One rule overrides the score entirely: nothing goes to the patient while
// insurance has not finished. Billing someone for a balance the payer may still
// owe is wrong whatever the score says.

export interface PatientAccount {
  /** De-identified reference, never a name or member ID. */
  patientRef: string;
  balanceCents: number;
  /** Days since the balance became the patient's. */
  balanceAgeDays: number;
  /** Has the payer adjudicated? A balance before this is not the patient's yet. */
  insuranceAdjudicated: boolean;
  /** Payments this account has made, ever. */
  priorPayments: number;
  priorPaidCents: number;
  /** Payment plans entered and not completed. */
  brokenPlans: number;
  onPaymentPlan: boolean;
  /** Has anyone checked whether this patient qualifies for assistance? */
  financialAssistanceScreened: boolean;
  statementsSent: number;
}

export function account(over: Partial<PatientAccount> & { patientRef: string }): PatientAccount {
  return {
    balanceCents: 0,
    balanceAgeDays: 0,
    insuranceAdjudicated: true,
    priorPayments: 0,
    priorPaidCents: 0,
    brokenPlans: 0,
    onPaymentPlan: false,
    financialAssistanceScreened: false,
    statementsSent: 0,
    ...over,
  };
}

/** Below this, chasing the balance costs more than the balance. */
export const SMALL_BALANCE_CENTS = 2500;
/** Above this, a plan is the realistic route rather than a demand for the lot. */
export const PLAN_THRESHOLD_CENTS = 40000;

export type OutreachAction =
  | "hold_insurance_pending"
  | "statement"
  | "payment_plan_offer"
  | "financial_assistance_screening"
  | "small_balance_write_off"
  | "already_on_plan";

export interface PropensityScore {
  patientRef: string;
  /** 0 to 1. What this account has done before, and nothing else. */
  score: number;
  factors: Array<{ factor: string; effect: number; why: string }>;
  action: OutreachAction;
  reason: string;
}

/**
 * Score an account on its own history.
 *
 * Deliberately a small, readable sum rather than a fitted model: a practice has
 * to be able to say why a patient was treated the way they were, and "the model
 * said 0.31" is not an answer anyone can act on or contest.
 */
export function scorePropensity(acct: PatientAccount): PropensityScore {
  const factors: Array<{ factor: string; effect: number; why: string }> = [];
  let score = 0.4;

  if (acct.priorPayments > 0) {
    const effect = Math.min(0.3, 0.1 * acct.priorPayments);
    score += effect;
    factors.push({
      factor: "has paid before",
      effect,
      why: `${acct.priorPayments} prior payment(s) on this account. The strongest signal available, and it is behaviour rather than a guess about circumstances.`,
    });
  } else {
    score -= 0.1;
    factors.push({
      factor: "no payment history",
      effect: -0.1,
      why: "Nothing has ever been paid on this account. That is an absence of evidence, not evidence of unwillingness.",
    });
  }

  if (acct.brokenPlans > 0) {
    const effect = -Math.min(0.25, 0.12 * acct.brokenPlans);
    score += effect;
    factors.push({
      factor: "broken payment plan",
      effect,
      why: `${acct.brokenPlans} plan(s) entered and not completed — often a sign the plan was set above what the household could carry.`,
    });
  }

  if (acct.balanceAgeDays > 120) {
    score -= 0.15;
    factors.push({
      factor: "aged balance",
      effect: -0.15,
      why: `${acct.balanceAgeDays} days old. Collection likelihood falls steadily with age, which is an argument for reaching out sooner rather than harder.`,
    });
  }

  if (acct.balanceCents > PLAN_THRESHOLD_CENTS) {
    score -= 0.15;
    factors.push({
      factor: "large balance",
      effect: -0.15,
      why: `$${(acct.balanceCents / 100).toFixed(2)} is more than most households pay at once. Lower likelihood of payment in full is not lower likelihood of payment.`,
    });
  }

  if (acct.statementsSent >= 3 && acct.priorPayments === 0) {
    score -= 0.1;
    factors.push({
      factor: "statements not working",
      effect: -0.1,
      why: `${acct.statementsSent} statements with no payment. Sending a fourth is the least likely thing to change the outcome.`,
    });
  }

  score = Math.max(0, Math.min(1, score));

  const { action, reason } = recommendAction(acct, score);
  return { patientRef: acct.patientRef, score, factors, action, reason };
}

function recommendAction(acct: PatientAccount, score: number): { action: OutreachAction; reason: string } {
  // Overrides the score entirely, and comes first for that reason.
  if (!acct.insuranceAdjudicated) {
    return {
      action: "hold_insurance_pending",
      reason:
        "Insurance has not finished with this claim, so this is not the patient's balance yet. Billing them now bills them for something the payer may owe, and it is the fastest way to a complaint that is justified.",
    };
  }
  if (acct.onPaymentPlan) {
    return { action: "already_on_plan", reason: "An active plan is in place. Leave it alone unless it breaks." };
  }
  if (acct.balanceCents < SMALL_BALANCE_CENTS) {
    return {
      action: "small_balance_write_off",
      reason: `Under $${(SMALL_BALANCE_CENTS / 100).toFixed(2)}. A statement, an envelope and a phone call cost more than this is worth — write it off and spend the effort on a balance that repays it.`,
    };
  }
  if (acct.balanceCents > PLAN_THRESHOLD_CENTS && !acct.financialAssistanceScreened) {
    return {
      action: "financial_assistance_screening",
      reason:
        "A large balance on an unscreened account. Find out whether they qualify for assistance before asking for money — screening first is both the right order and the one that collects more, because a demand nobody can meet produces neither payment nor goodwill.",
    };
  }
  if (score < 0.45 || acct.balanceCents > PLAN_THRESHOLD_CENTS) {
    return {
      action: "payment_plan_offer",
      reason:
        "Full payment is unlikely; an affordable instalment is not. A plan set to what the household can actually carry collects more than a demand that gets ignored.",
    };
  }
  return {
    action: "statement",
    reason: "This account has paid before and the balance is manageable. An ordinary statement is the right next step.",
  };
}

export interface OutreachPlan {
  scores: PropensityScore[];
  byAction: Array<{ action: OutreachAction; count: number; balanceCents: number }>;
  totalBalanceCents: number;
  heldForInsuranceCents: number;
}

export function planOutreach(accounts: PatientAccount[]): OutreachPlan {
  const scores = accounts.map(scorePropensity).sort((a, b) => b.score - a.score);
  const byAction = new Map<OutreachAction, { count: number; balanceCents: number }>();
  let total = 0;
  let held = 0;

  for (const s of scores) {
    const acct = accounts.find((a) => a.patientRef === s.patientRef)!;
    const slot = byAction.get(s.action) ?? { count: 0, balanceCents: 0 };
    slot.count++;
    slot.balanceCents += acct.balanceCents;
    byAction.set(s.action, slot);
    total += acct.balanceCents;
    if (s.action === "hold_insurance_pending") held += acct.balanceCents;
  }

  return {
    scores,
    byAction: [...byAction.entries()]
      .map(([action, v]) => ({ action, ...v }))
      .sort((a, b) => b.balanceCents - a.balanceCents),
    totalBalanceCents: total,
    heldForInsuranceCents: held,
  };
}

const ACTION_LABEL: Record<OutreachAction, string> = {
  hold_insurance_pending: "Hold — insurance not finished",
  statement: "Send a statement",
  payment_plan_offer: "Offer a payment plan",
  financial_assistance_screening: "Screen for financial assistance first",
  small_balance_write_off: "Write off — too small to chase",
  already_on_plan: "On a plan already",
};

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function renderOutreach(plan: OutreachPlan): string {
  const lines = [
    `${plan.scores.length} account(s), ${dollars(plan.totalBalanceCents)} outstanding.`,
    "",
    "What to do with them:",
  ];
  for (const row of plan.byAction) {
    lines.push(`  ${ACTION_LABEL[row.action]} — ${row.count} account(s), ${dollars(row.balanceCents)}`);
  }
  if (plan.heldForInsuranceCents > 0) {
    lines.push(
      "",
      `${dollars(plan.heldForInsuranceCents)} is being held because insurance has not finished with it. That money is not the patients' to owe yet, and asking for it now is the single most common way a billing office earns a complaint it deserves.`,
    );
  }
  lines.push(
    "",
    "Scores come from what each account has done — payments made, plans kept or broken, how old the balance is, how large. Nothing about who the patient is goes into them, and nothing should.",
    "",
    "Accounts:",
  );
  for (const s of plan.scores.slice(0, 25)) {
    lines.push(`  ${s.patientRef}  score ${s.score.toFixed(2)}  → ${ACTION_LABEL[s.action]}`, `    ${s.reason}`);
  }
  if (plan.scores.length > 25) lines.push(`  … and ${plan.scores.length - 25} more.`);
  return lines.join("\n");
}

export interface LetterOptions {
  practiceName: string;
  serviceDescription: string;
  serviceDate: string;
  insurancePaidCents: number;
  adjustmentCents: number;
  contact: string;
  planMonths?: number;
}

/**
 * A patient billing letter, in plain language.
 *
 * Written to be understood rather than to sound official: what the service was,
 * what insurance did, what is left, and what the options are — including the
 * ones that cost the practice money, because a patient who does not know they
 * can ask for a plan does not ask for one. No threats and no deadlines that are
 * not real. It is a draft, and it stays a draft until a person sends it.
 */
export function draftPatientLetter(acct: PatientAccount, score: PropensityScore, opts: LetterOptions): string {
  const balance = dollars(acct.balanceCents);
  const insuranceParagraph = [
    opts.insurancePaidCents > 0
      ? `Your insurance paid ${dollars(opts.insurancePaidCents)}.`
      : "Your insurance did not pay toward this.",
    opts.adjustmentCents > 0
      ? `We also reduced the bill by ${dollars(opts.adjustmentCents)} under our agreement with them, which is not something you owe.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Blank strings here are paragraph breaks, not filler. Stripping them the way
  // the rest of this project strips optional lines would collapse the whole
  // letter into one run-on block.
  const lines: string[] = [
    `# Your bill from ${opts.practiceName}`,
    "",
    `Account: ${acct.patientRef}`,
    "",
    `## What this is for`,
    "",
    `${opts.serviceDescription} on ${opts.serviceDate}.`,
    "",
    `## What your insurance did`,
    "",
    insuranceParagraph,
    "",
    `**Your share is ${balance}.**`,
    "",
  ];

  if (score.action === "payment_plan_offer" || acct.balanceCents > PLAN_THRESHOLD_CENTS) {
    const months = opts.planMonths ?? 6;
    lines.push(
      "## You can pay this over time",
      "",
      `If paying ${balance} at once is difficult, you can spread it out — about ${dollars(Math.ceil(acct.balanceCents / months))} a month over ${months} months. There is no interest and no fee for doing this. Call us and we will set it up; we can also make the monthly amount smaller if that one does not work.`,
      "",
    );
  }

  if (score.action === "financial_assistance_screening" || !acct.financialAssistanceScreened) {
    lines.push(
      "## You may not have to pay all of this",
      "",
      "We have a financial assistance programme, and people are often surprised to find they qualify. It takes one short conversation to find out. Asking costs nothing and does not affect your care.",
      "",
    );
  }

  lines.push(
    "## If this looks wrong",
    "",
    "Tell us. Bills are wrong more often than anyone would like, and we would rather fix one than argue about it. Common things worth checking: whether we have your current insurance, whether the visit was billed the way it happened, and whether your insurance has actually finished processing it.",
    "",
    `You can also ask your insurance company to explain their decision, and you can appeal it. The Explanation of Benefits they sent you says how and by when.`,
    "",
    "## How to reach us",
    "",
    opts.contact,
    "",
    "---",
    "",
    "*Draft — not sent. Review before this goes to a patient.*",
  );

  return lines.join("\n");
}
