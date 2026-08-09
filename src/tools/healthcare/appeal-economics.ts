import { CARC } from "./denial-codes.js";

// ── Is this denial worth appealing? ──────────────────────────────────────────
// Every denial worklist sorts by dollars. Dollars is the wrong sort: a $4,000
// denial the practice has never once overturned is worth less than a $600 one it
// wins four times in five, and sorting by amount puts them the wrong way round
// every single day.
//
// The right quantity is expected recovery — amount × P(overturn) − the cost of
// doing the work — and every input is already here: the practice's own appeal
// outcomes, the recoverable amount, the deadline.
//
// TWO THINGS THIS MUST NOT BECOME, both designed against rather than warned about.
//
// 1. A CONFIDENT GUESS. Below a real sample there is no probability to estimate,
//    and a made-up 12% would send genuinely recoverable money to a write-off
//    pile with a number attached to make it look considered. Where the evidence
//    is thin the tool says so and makes NO recommendation — the same posture as
//    the drift check and the KPIs.
//
// 2. AN AUTOMATIC WRITE-OFF MACHINE. This never outputs "write this off". The
//    closest it comes is reporting that a denial is below the cost of working it
//    — and before it will even say that, it checks whether the denial is part of
//    a CLUSTER. Forty $60 denials sharing one CARC are not forty write-offs;
//    they are one upstream fault worth $2,400, and they are the most valuable
//    thing in the queue precisely because fixing the cause clears all of them and
//    stops the next forty. A tool that ranked by per-claim value would bury them.

export interface DenialOutcome {
  payer: string;
  carc: string;
  /** True when an appeal was actually filed. Denials never appealed say nothing about win rate. */
  appealed: boolean;
  /** True when the appeal recovered money. Only meaningful where `appealed`. */
  overturned: boolean;
}

export interface AppealCandidate {
  id: string;
  claimId: string;
  payer: string;
  carc: string;
  amountCents: number;
  /** Days left to file. Null when unknown — which is NOT the same as plenty. */
  daysToDeadline: number | null;
}

/** Below this many APPEALED denials, there is no rate to estimate. */
export const MIN_APPEAL_SAMPLE = 12;

/** Staff cost of working one appeal, in cents. An input, not a guess — override it. */
export const DEFAULT_APPEAL_COST_CENTS = 4_500;

/** This many denials sharing a cause is a systemic fault, not a set of coincidences. */
export const CLUSTER_SIZE = 5;

export type Basis = "payer_carc" | "carc" | "practice" | "none";

export interface OverturnEstimate {
  rate: number | null;
  /** How many APPEALED denials the rate rests on. */
  n: number;
  basis: Basis;
  explain: string;
}

/**
 * P(overturn), backing off through progressively broader evidence.
 *
 * Payer × CARC first, because that is the question actually being asked. Then
 * the CARC across all payers, then the practice's overall appeal record. Each
 * level reports the sample it rests on, so a 70% from eleven appeals is not
 * presented like a 70% from four hundred.
 *
 * The denominator is APPEALS FILED, not denials received. Denials that were
 * never appealed are not evidence about winning — counting them would drive
 * every rate toward zero and produce a tool that recommends never appealing,
 * which is self-fulfilling: the less you appeal, the worse the number gets.
 */
export function overturnRate(history: DenialOutcome[], payer: string, carc: string): OverturnEstimate {
  const appealed = history.filter((h) => h.appealed);
  const p = payer.trim().toLowerCase();
  const c = carc.trim().toUpperCase();

  const levels: Array<{ basis: Basis; rows: DenialOutcome[]; explain: string }> = [
    {
      basis: "payer_carc",
      rows: appealed.filter((h) => h.payer.trim().toLowerCase() === p && h.carc.trim().toUpperCase() === c),
      explain: `this practice's own appeals of CARC ${c} to ${payer}`,
    },
    {
      basis: "carc",
      rows: appealed.filter((h) => h.carc.trim().toUpperCase() === c),
      explain: `this practice's appeals of CARC ${c} across all payers — ${payer} specifically has too few to judge`,
    },
    {
      basis: "practice",
      rows: appealed,
      explain: `this practice's overall appeal record — CARC ${c} has too few appeals of its own to judge`,
    },
  ];

  for (const l of levels) {
    if (l.rows.length < MIN_APPEAL_SAMPLE) continue;
    const wins = l.rows.filter((r) => r.overturned).length;
    return { rate: wins / l.rows.length, n: l.rows.length, basis: l.basis, explain: l.explain };
  }

  return {
    rate: null,
    n: appealed.length,
    basis: "none",
    explain:
      appealed.length === 0
        ? "no appeals have been recorded, so there is no win rate to estimate from"
        : `only ${appealed.length} appeal(s) recorded in total, below the ${MIN_APPEAL_SAMPLE} needed before a rate means anything`,
  };
}

export type Recommendation =
  | "appeal"
  | "appeal_thin_evidence"
  | "deadline_passed"
  | "below_cost_check_cluster"
  | "no_recommendation";

export interface AppealAssessment {
  candidate: AppealCandidate;
  estimate: OverturnEstimate;
  /** amount × rate − cost, in cents. Null when the rate could not be estimated. */
  expectedCents: number | null;
  recommendation: Recommendation;
  why: string;
}

export interface ClusterFinding {
  carc: string;
  carcDesc: string;
  payer: string;
  count: number;
  totalCents: number;
}

export interface AppealTriage {
  assessments: AppealAssessment[];
  clusters: ClusterFinding[];
  /** Sum of expected recovery across everything recommended for appeal. */
  expectedTotalCents: number;
  costCents: number;
}

export interface TriageOptions {
  appealCostCents?: number;
  now?: number;
}

/**
 * Rank denials by what appealing them is actually worth.
 *
 * The deadline is a hard gate applied before any arithmetic: an appeal that
 * cannot be filed has an expected value of zero however large the balance, and
 * showing a $4,000 opportunity that expired last week wastes the one resource
 * this whole exercise is about — somebody's afternoon.
 */
export function triageAppeals(
  candidates: AppealCandidate[],
  history: DenialOutcome[],
  opts: TriageOptions = {},
): AppealTriage {
  const cost = opts.appealCostCents ?? DEFAULT_APPEAL_COST_CENTS;

  // Clusters are computed over EVERY candidate, before any is judged
  // individually — a denial's membership in a systemic fault is a fact about
  // the batch, and a per-claim loop cannot see it.
  const grouped = new Map<string, ClusterFinding>();
  for (const c of candidates) {
    const key = `${c.payer.trim().toLowerCase()}|${c.carc.trim().toUpperCase()}`;
    const slot = grouped.get(key) ?? {
      carc: c.carc.trim().toUpperCase(),
      carcDesc: CARC[c.carc.trim().toUpperCase()]?.desc ?? "code not in the bundled CARC dataset",
      payer: c.payer,
      count: 0,
      totalCents: 0,
    };
    slot.count++;
    slot.totalCents += c.amountCents;
    grouped.set(key, slot);
  }
  const clusters = [...grouped.values()].filter((g) => g.count >= CLUSTER_SIZE).sort((a, b) => b.totalCents - a.totalCents);
  const clustered = new Set(clusters.map((c) => `${c.payer.trim().toLowerCase()}|${c.carc}`));

  const assessments: AppealAssessment[] = candidates.map((candidate) => {
    const estimate = overturnRate(history, candidate.payer, candidate.carc);

    if (candidate.daysToDeadline !== null && candidate.daysToDeadline <= 0) {
      return {
        candidate,
        estimate,
        expectedCents: 0,
        recommendation: "deadline_passed",
        why: "The filing deadline has passed. Nothing here is recoverable on the merits, whatever the balance — the only remaining question is whether a banked acceptance defends a timely-filing denial.",
      };
    }

    if (estimate.rate === null) {
      return {
        candidate,
        estimate,
        expectedCents: null,
        recommendation: "no_recommendation",
        why: `No recommendation: ${estimate.explain}. This is deliberately not a guess — an invented win rate would send recoverable money to a write-off pile with a number attached to make it look considered.`,
      };
    }

    const expectedCents = Math.round(candidate.amountCents * estimate.rate) - cost;
    const inCluster = clustered.has(`${candidate.payer.trim().toLowerCase()}|${candidate.carc.trim().toUpperCase()}`);

    if (expectedCents <= 0) {
      return {
        candidate,
        estimate,
        expectedCents,
        recommendation: "below_cost_check_cluster",
        why: inCluster
          ? "Individually this is worth less than the work, but it is part of a cluster sharing one cause — see below. The group is the opportunity; fixing the cause clears all of them and stops the next batch arriving the same way."
          : "Expected recovery is below the stated cost of working it. That is a fact, not an instruction: this tool does not recommend write-offs, because the decision depends on payer relationships and volume it cannot see.",
      };
    }

    const thin = estimate.basis !== "payer_carc";
    return {
      candidate,
      estimate,
      expectedCents,
      recommendation: thin ? "appeal_thin_evidence" : "appeal",
      why: thin
        ? `Worth appealing on the evidence available, but the rate comes from ${estimate.explain} (${estimate.n} appeals) rather than from this payer's own record for this code.`
        : `Worth appealing: ${(estimate.rate * 100).toFixed(0)}% of ${estimate.n} appeals of this code to this payer were overturned.`,
    };
  });

  // Expected value descending, but a passed deadline sinks regardless — it is
  // not a small opportunity, it is a closed one.
  assessments.sort((a, b) => {
    if (a.recommendation === "deadline_passed" && b.recommendation !== "deadline_passed") return 1;
    if (b.recommendation === "deadline_passed" && a.recommendation !== "deadline_passed") return -1;
    return (b.expectedCents ?? -1) - (a.expectedCents ?? -1);
  });

  return {
    assessments,
    clusters,
    expectedTotalCents: assessments
      .filter((a) => a.recommendation === "appeal" || a.recommendation === "appeal_thin_evidence")
      .reduce((sum, a) => sum + (a.expectedCents ?? 0), 0),
    costCents: cost,
  };
}

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function renderTriage(t: AppealTriage, limit = 15): string {
  if (t.assessments.length === 0) {
    return "No denials to triage. This ranks open denials by what appealing them is worth — parse remittances with era_parse_835 and open worklist items first.";
  }

  const lines = [
    `${t.assessments.length} denial(s), ranked by expected recovery rather than by balance.`,
    `Cost of working one appeal: ${money(t.costCents)} — an input, not an estimate. Change it and the ranking changes.`,
    "",
  ];

  const worth = t.assessments.filter((a) => a.recommendation === "appeal" || a.recommendation === "appeal_thin_evidence");
  if (worth.length > 0) {
    lines.push(`WORTH APPEALING — ${worth.length}, expected recovery ${money(t.expectedTotalCents)}:`, "");
    for (const a of worth.slice(0, limit)) {
      lines.push(
        `  ${money(a.expectedCents ?? 0).padStart(12)}  ${a.candidate.claimId}  ${a.candidate.payer} CARC ${a.candidate.carc}` +
          `  (billed ${money(a.candidate.amountCents)}${a.candidate.daysToDeadline !== null ? `, ${a.candidate.daysToDeadline}d left` : ""})`,
        `                ${a.why}`,
      );
    }
    if (worth.length > limit) lines.push(`  … and ${worth.length - limit} more.`);
    lines.push("");
  }

  if (t.clusters.length > 0) {
    lines.push(
      `CLUSTERS — ${t.clusters.length} cause(s) hitting ${CLUSTER_SIZE}+ claims each:`,
      "",
      ...t.clusters.map(
        (c) => `  ${money(c.totalCents).padStart(12)}  ${c.count}× ${c.payer} CARC ${c.carc} — ${c.carcDesc}`,
      ),
      "",
      "These are the most valuable rows here even where each claim is small, and a ranking by per-claim value would bury them. One cause across this many claims is an upstream fault: fix it at the source and the whole group clears, and the next batch does not arrive the same way.",
      "",
    );
  }

  const unknown = t.assessments.filter((a) => a.recommendation === "no_recommendation");
  if (unknown.length > 0) {
    lines.push(
      `NO RECOMMENDATION — ${unknown.length}. There is not enough appeal history to estimate a win rate, and a guessed one would send recoverable money to a write-off pile with a number attached to make it look considered. Record appeal outcomes and these become answerable.`,
      "",
    );
  }

  const expired = t.assessments.filter((a) => a.recommendation === "deadline_passed");
  if (expired.length > 0) {
    lines.push(`DEADLINE PASSED — ${expired.length}. Not small opportunities; closed ones. Check filing_proof before writing them off, since a banked acceptance can still defeat a timely-filing denial.`, "");
  }

  const belowCost = t.assessments.filter((a) => a.recommendation === "below_cost_check_cluster");
  if (belowCost.length > 0) {
    lines.push(
      `BELOW THE COST OF WORKING — ${belowCost.length}. This tool does not recommend writing anything off: that decision depends on payer relationships and volume it cannot see, and a batch of small denials sharing one cause is worth more as a fix than as a write-off.`,
    );
  }

  return lines.join("\n").trimEnd();
}
