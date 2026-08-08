import type { Classification } from "./classify.js";

// ── From classified mail to a next action ────────────────────────────────────
// Classification says what a letter IS. It does not say what to do, because that
// depends on what the practice already knows about the claim it names — and that
// is the whole difference between a tidy inbox and a worked one.
//
// The same ADR is three different situations:
//   • claim unknown here          → the letter is about work done elsewhere, or
//                                   the claim id was mis-read. Do not open a
//                                   worklist item for a claim that does not exist.
//   • claim known, no item open   → the actionable case, and the one that goes
//                                   missing. This is what the tool is for.
//   • item already open           → say so and stop. A second item for the same
//                                   letter is how a queue becomes noise, and a
//                                   noisy queue is one nobody reads.
//
// Urgency comes from the deadline the letter states, not from its category. An
// ADR with 25 days left and an ADR with 3 are the same kind of letter and
// completely different problems.

export interface LocalFacts {
  /** Claim refs from the letter that exist in this database. */
  knownClaims: string[];
  /** Claim refs with a worklist item already open. */
  claimsWithOpenItem: string[];
  /** Claim refs with banked proof of timely filing. */
  claimsWithFilingProof: string[];
  /** Claim refs a remittance has already resolved. */
  claimsAdjudicated: string[];
}

export type Urgency = "critical" | "high" | "normal" | "informational";

export interface Recommendation {
  urgency: Urgency;
  action: string;
  why: string;
  /** Tools that carry it out, in order. */
  tools: string[];
  /** Days to the nearest stated deadline, or null when the letter states none. */
  daysToDeadline: number | null;
}

/** Inside this many days, a deadline dominates whatever the letter is about. */
export const CRITICAL_DAYS = 7;
export const HIGH_DAYS = 21;

function ymdToMs(ymd: string): number | null {
  if (!/^\d{8}$/.test(ymd)) return null;
  return Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
}

/**
 * Days to the soonest deadline the letter states.
 *
 * Letters state deadlines BOTH ways and the relative form is more common: "you
 * must respond within 30 days" far outnumbers a printed date. A relative window
 * counts from when the letter was RECEIVED, not from now — measuring it from now
 * would reset the clock every time somebody looked at the inbox, which is the
 * one direction this number must never move.
 */
export function daysToNearestDeadline(c: Classification, now: number, receivedAt: number): number | null {
  const days: number[] = [];
  for (const d of c.deadlines) {
    if (d.date) {
      const ms = ymdToMs(d.date);
      if (ms !== null) days.push(Math.floor((ms - now) / 86_400_000));
    }
    if (typeof d.days === "number") {
      const dueAt = receivedAt + d.days * 86_400_000;
      days.push(Math.floor((dueAt - now) / 86_400_000));
    }
  }
  return days.length > 0 ? Math.min(...days) : null;
}

function urgencyFrom(days: number | null, kind: string): Urgency {
  if (days !== null) {
    if (days <= CRITICAL_DAYS) return "critical";
    if (days <= HIGH_DAYS) return "high";
  }
  // A letter with no stated deadline is not automatically low: an overpayment
  // demand starts a 60-day statutory clock whether or not it says so, and a
  // records request has one even when the date is on a page nobody scanned.
  if (kind === "records_request" || kind === "audit_notice" || kind === "overpayment_demand") return "high";
  if (kind === "policy_bulletin") return "informational";
  return "normal";
}

export function recommend(c: Classification, facts: LocalFacts, now: number, receivedAt: number): Recommendation {
  const days = daysToNearestDeadline(c, now, receivedAt);
  const urgency = urgencyFrom(days, c.kind);
  const unknown = c.claimRefs.filter((r) => !facts.knownClaims.includes(r));
  const alreadyOpen = c.claimRefs.filter((r) => facts.claimsWithOpenItem.includes(r));
  const actionable = c.claimRefs.filter((r) => facts.knownClaims.includes(r) && !facts.claimsWithOpenItem.includes(r));

  if (c.claimRefs.length > 0 && actionable.length === 0 && alreadyOpen.length > 0) {
    return {
      urgency,
      action: `Already being worked — ${alreadyOpen.join(", ")} has an open worklist item.`,
      why: "Opening a second item for the same letter is how a queue becomes noise, and a noisy queue is one nobody reads. Add this letter to the existing item instead.",
      tools: ["worklist_list"],
      daysToDeadline: days,
    };
  }

  if (c.claimRefs.length > 0 && unknown.length === c.claimRefs.length) {
    return {
      urgency,
      action: `No claim here matches ${unknown.join(", ")}.`,
      why: "Either the letter concerns work done outside this system, the claim id was mis-read from the letter, or — in a multi-tenant install — the claim belongs to a different tenant and is unreachable from this connection by design. Do NOT open a worklist item against a claim that does not exist; a queue full of phantom claims is worse than an empty one.",
      tools: ["support_trace_claim"],
      daysToDeadline: days,
    };
  }

  switch (c.kind) {
    case "records_request":
    case "audit_notice":
      return {
        urgency,
        action: `Open a records worklist item for ${actionable.join(", ") || "the claims named"}${days !== null ? `, due in ${days} day(s)` : ""}.`,
        why:
          days !== null && days <= CRITICAL_DAYS
            ? "The response window closes inside a week. Missing an ADR window loses the claim outright — there is no determination to appeal, because none was made."
            : "An unanswered records request becomes a denial with no appeal rights. The deadline runs from the letter, not from when somebody opened it.",
        tools: ["audit_track", "worklist_add", "audit_response_draft"],
        daysToDeadline: days,
      };

    case "overpayment_demand":
      return {
        urgency: urgency === "normal" ? "high" : urgency,
        action: `Record the overpayment for ${actionable.join(", ") || "the claims named"} and start the 60-day clock.`,
        why: "The ACA report-and-return deadline runs from IDENTIFICATION, which is the date this letter was read — not the date somebody got round to it. Recording it is what makes that date defensible.",
        tools: ["credit_balance_add", "credit_balance_list"],
        daysToDeadline: days,
      };

    case "denial":
      return {
        urgency,
        action: `Triage as a denial for ${actionable.join(", ") || "the claims named"}.`,
        why:
          "A denial arriving by EMAIL rather than on an 835 is worth noticing in itself: it will not appear in remittance analytics, so the practice's denial rate understates reality by exactly these. Record it so it counts.",
        tools: ["denial_explain", "worklist_add", "appeal_draft"],
        daysToDeadline: days,
      };

    case "clearinghouse_rejection":
      return {
        urgency,
        action: `Correct and resubmit ${actionable.join(", ") || "the claims named"}.`,
        why: "A front-end rejection never entered adjudication, so there are no appeal rights and nothing to appeal — but timely filing kept running the whole time. Check the window before assuming there is room.",
        tools: ["ack_parse_277ca", "timely_filing_check", "claim_scrub"],
        daysToDeadline: days,
      };

    case "revalidation":
      return {
        urgency,
        action: "Record the revalidation deadline against the provider's enrollment.",
        why: "A lapsed enrollment denies every claim as provider-not-eligible (CARC B7), and no appeal recovers a service furnished while unenrolled.",
        tools: ["credentialing_track", "credentialing_check"],
        daysToDeadline: days,
      };

    case "policy_bulletin":
      return {
        urgency: "informational",
        action: "Check whether the changed policy touches codes this practice actually bills.",
        why: "Most bulletins are irrelevant to any given practice. The ones that are not are worth a lot, and the difference is knowable rather than a matter of reading all of them.",
        tools: ["policy_watch", "code_update_diff"],
        daysToDeadline: days,
      };

    default:
      return {
        urgency,
        action: "Read it — the classifier could not place this confidently.",
        why: "Reported as unplaced rather than filed into the nearest category. A letter in the wrong queue is worse than one in no queue, because the wrong queue looks handled.",
        tools: ["email_list"],
        daysToDeadline: days,
      };
  }
}

export function renderRecommendation(r: Recommendation, subject: string): string {
  const marker = { critical: "‼", high: "!", normal: "·", informational: " " }[r.urgency];
  return [
    `${marker} ${r.urgency.toUpperCase()}${r.daysToDeadline !== null ? ` — ${r.daysToDeadline} day(s) to the stated deadline` : " — no deadline stated"}`,
    `  ${subject}`,
    `  ACTION: ${r.action}`,
    `  ${r.why}`,
    r.tools.length > 0 ? `  Tools: ${r.tools.join(" → ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
