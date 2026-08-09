import type { ClaimInput } from "../x12/837.js";
import { isEmCode } from "../compliance/global-period.js";
import type { TwinVerdict } from "./verdict.js";

// ── Gauntlet ─────────────────────────────────────────────────────────────────
// The biller fixes, the twin re-attacks, until the claim survives N clean passes
// or the rounds run out.
//
// The danger in a loop like this is not that it fails to converge — it is that it
// converges the wrong way. The objective it optimizes is "the twin stops
// objecting", and there are two ways to reach that which are not fixes:
//
//   The claim did not change. The twin simply answered differently the second
//   time. That is a coin landing the other way up, not a corrected claim.
//
//   The claim changed by billing MORE. Raising an E/M level or adding a
//   distinct-service modifier will make a bundling or medical-necessity
//   objection disappear, and if the record does not support the change that is
//   upcoding — a compliance problem manufactured by an automated loop that was
//   only ever told to make the objection go away.
//
// Both are detected structurally and reported. The loop cannot tell whether the
// documentation supports a change; it can tell that a change needs checking, and
// it says so rather than presenting a clean final verdict as a finished claim.

/** Modifiers that unbundle or increase payment, and therefore need the record behind them. */
export const REVENUE_INCREASING_MODIFIERS = ["22", "25", "50", "59", "XE", "XP", "XS", "XU", "76", "77", "91"];

export interface LineFingerprint {
  code: string;
  modifiers: string[];
  units: number;
  charge: number;
  pointers: number[];
  pos: string;
}

/** The billable content of a claim — what changing would change the claim. */
export function claimFingerprint(claim: ClaimInput): {
  diagnoses: string[];
  lines: LineFingerprint[];
} {
  return {
    diagnoses: claim.diagnoses.map((d) => d.replace(/\./g, "").toUpperCase()),
    lines: claim.service_lines.map((l) => ({
      code: l.cpt_hcpcs.trim().toUpperCase(),
      modifiers: [...(l.modifiers ?? [])].map((m) => m.trim().toUpperCase()).sort(),
      units: l.units ?? 1,
      charge: l.charge,
      pointers: [...(l.dx_pointers ?? [])].sort((a, b) => a - b),
      pos: l.place_of_service ?? "11",
    })),
  };
}

export function fingerprintKey(claim: ClaimInput): string {
  return JSON.stringify(claimFingerprint(claim));
}

export function claimsDiffer(a: ClaimInput, b: ClaimInput): boolean {
  return fingerprintKey(a) !== fingerprintKey(b);
}

/** The E/M level is the last digit: 99213 → 3, 99214 → 4. */
export function emLevel(code: string): number | null {
  const normalized = code.trim().toUpperCase();
  if (!isEmCode(normalized)) return null;
  const level = Number(normalized.slice(-1));
  return Number.isFinite(level) ? level : null;
}

export type ChangeDirection = "revenue_increasing" | "neutral" | "revenue_decreasing";

export interface ClaimChange {
  direction: ChangeDirection;
  description: string;
  needsRecord: boolean;
}

/**
 * What changed between two versions of a claim, and which way.
 *
 * Only the revenue-increasing changes carry `needsRecord`: a fix that bills less,
 * or bills the same differently, cannot be upcoding. A fix that bills more might
 * be entirely correct — and the only way to know is to read the note.
 */
export function diffClaims(before: ClaimInput, after: ClaimInput): ClaimChange[] {
  const changes: ClaimChange[] = [];
  const a = claimFingerprint(before);
  const b = claimFingerprint(after);

  if (b.lines.length > a.lines.length) {
    changes.push({
      direction: "revenue_increasing",
      description: `${b.lines.length - a.lines.length} service line(s) added.`,
      needsRecord: true,
    });
  } else if (b.lines.length < a.lines.length) {
    changes.push({
      direction: "revenue_decreasing",
      description: `${a.lines.length - b.lines.length} service line(s) removed.`,
      needsRecord: false,
    });
  }

  const pairs = Math.min(a.lines.length, b.lines.length);
  for (let i = 0; i < pairs; i++) {
    const before1 = a.lines[i];
    const after1 = b.lines[i];
    const n = i + 1;

    if (before1.code !== after1.code) {
      const from = emLevel(before1.code);
      const to = emLevel(after1.code);
      if (from !== null && to !== null && to > from) {
        changes.push({
          direction: "revenue_increasing",
          description: `Line ${n}: E/M level raised, ${before1.code} → ${after1.code}.`,
          needsRecord: true,
        });
      } else if (from !== null && to !== null && to < from) {
        changes.push({
          direction: "revenue_decreasing",
          description: `Line ${n}: E/M level lowered, ${before1.code} → ${after1.code}.`,
          needsRecord: false,
        });
      } else {
        changes.push({
          direction: "neutral",
          description: `Line ${n}: procedure changed, ${before1.code} → ${after1.code}.`,
          needsRecord: true,
        });
      }
    }

    const added = after1.modifiers.filter((m) => !before1.modifiers.includes(m));
    const removed = before1.modifiers.filter((m) => !after1.modifiers.includes(m));
    const risky = added.filter((m) => REVENUE_INCREASING_MODIFIERS.includes(m));
    if (risky.length > 0) {
      changes.push({
        direction: "revenue_increasing",
        description: `Line ${n}: modifier ${risky.join(", ")} added — this is the kind of modifier that makes an edit go away by asserting a separate or more extensive service.`,
        needsRecord: true,
      });
    }
    const benign = added.filter((m) => !risky.includes(m));
    if (benign.length > 0) {
      changes.push({ direction: "neutral", description: `Line ${n}: modifier ${benign.join(", ")} added.`, needsRecord: true });
    }
    if (removed.length > 0) {
      changes.push({ direction: "neutral", description: `Line ${n}: modifier ${removed.join(", ")} removed.`, needsRecord: false });
    }

    if (after1.units > before1.units) {
      changes.push({
        direction: "revenue_increasing",
        description: `Line ${n}: units raised ${before1.units} → ${after1.units}.`,
        needsRecord: true,
      });
    } else if (after1.units < before1.units) {
      changes.push({
        direction: "revenue_decreasing",
        description: `Line ${n}: units lowered ${before1.units} → ${after1.units}.`,
        needsRecord: false,
      });
    }

    if (after1.charge > before1.charge) {
      changes.push({
        direction: "revenue_increasing",
        description: `Line ${n}: charge raised $${before1.charge.toFixed(2)} → $${after1.charge.toFixed(2)}.`,
        needsRecord: true,
      });
    }

    if (JSON.stringify(before1.pointers) !== JSON.stringify(after1.pointers)) {
      changes.push({
        direction: "neutral",
        description: `Line ${n}: diagnosis pointers changed ${before1.pointers.join(",")} → ${after1.pointers.join(",")}.`,
        needsRecord: true,
      });
    }
    if (before1.pos !== after1.pos) {
      changes.push({
        direction: "neutral",
        description: `Line ${n}: place of service changed ${before1.pos} → ${after1.pos}.`,
        needsRecord: true,
      });
    }
  }

  const addedDx = b.diagnoses.filter((d) => !a.diagnoses.includes(d));
  const removedDx = a.diagnoses.filter((d) => !b.diagnoses.includes(d));
  if (addedDx.length) {
    changes.push({
      direction: "neutral",
      description: `Diagnoses added: ${addedDx.join(", ")}.`,
      needsRecord: true,
    });
  }
  if (removedDx.length) {
    changes.push({ direction: "neutral", description: `Diagnoses removed: ${removedDx.join(", ")}.`, needsRecord: false });
  }

  return changes;
}

export interface GauntletRound {
  round: number;
  claim: ClaimInput;
  verdict: TwinVerdict;
  /** Changes the biller made going INTO this round. Empty on the first. */
  changes: ClaimChange[];
}

export interface GauntletOutcome {
  rounds: GauntletRound[];
  cleanPasses: number;
  converged: boolean;
  /** Converged only because the twin changed its answer on an unchanged claim. */
  convergedWithoutChanges: boolean;
  changesNeedingRecord: ClaimChange[];
  submissionReady: boolean;
  summary: string;
}

export const DEFAULT_CLEAN_PASSES = 2;

/**
 * Read a finished gauntlet.
 *
 * `submissionReady` is deliberately narrow: it requires the twin to have gone
 * quiet AND the claim to have actually changed on the way there AND nothing
 * revenue-increasing to be waiting on a human. Anything else is a result to look
 * at, not a claim to send.
 */
export function assessGauntlet(rounds: GauntletRound[], requiredCleanPasses = DEFAULT_CLEAN_PASSES): GauntletOutcome {
  let cleanPasses = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (rounds[i].verdict.verdict === "PAY") cleanPasses++;
    else break;
  }
  const converged = cleanPasses >= requiredCleanPasses;
  const allChanges = rounds.flatMap((r) => r.changes);
  const changesNeedingRecord = allChanges.filter((c) => c.needsRecord && c.direction === "revenue_increasing");

  // Did anything actually change across the run?
  const everChanged = allChanges.length > 0;
  const convergedWithoutChanges = converged && !everChanged && rounds.length > 1;

  const submissionReady = converged && everChanged && changesNeedingRecord.length === 0;

  const summary: string[] = [];
  if (converged) {
    summary.push(`The twin returned PAY on ${cleanPasses} consecutive pass(es) after ${rounds.length} round(s).`);
  } else {
    const last = rounds[rounds.length - 1]?.verdict.verdict ?? "UNREADABLE";
    summary.push(
      `The twin was still objecting after ${rounds.length} round(s) — last verdict ${last}. This claim is not ready; work the remaining findings by hand.`,
    );
  }

  if (convergedWithoutChanges) {
    summary.push(
      "The claim never changed across those rounds, so the twin simply answered differently the second time. That is the model being inconsistent, not a claim being fixed — treat the earlier objection as still open.",
    );
  }

  if (changesNeedingRecord.length > 0) {
    summary.push(
      `${changesNeedingRecord.length} change(s) increase what this claim bills and must be verified against the documentation before submission:`,
      ...changesNeedingRecord.map((c) => `  ${c.description}`),
      "A loop told only to make the objection disappear will reach for these first. If the record does not support them, this is upcoding — the twin going quiet is not evidence that it does.",
    );
  }

  if (submissionReady) {
    summary.push("Nothing here bills more than the original, and the twin is quiet. Still a prediction, not a guarantee.");
  }

  return {
    rounds,
    cleanPasses,
    converged,
    convergedWithoutChanges,
    changesNeedingRecord,
    submissionReady,
    summary: summary.join("\n"),
  };
}

export function renderGauntlet(outcome: GauntletOutcome): string {
  const lines: string[] = [];
  for (const round of outcome.rounds) {
    lines.push(`── Round ${round.round} ──`);
    if (round.changes.length > 0) {
      lines.push("Changes made before this round:");
      for (const c of round.changes) {
        lines.push(`  [${c.direction.replace(/_/g, " ")}] ${c.description}`);
      }
    }
    lines.push(
      `Verdict: ${round.verdict.verdict ?? "UNREADABLE"}${round.verdict.confidence ? ` (${round.verdict.confidence})` : ""}` +
        (round.verdict.predictedCarcs.length ? ` · ${round.verdict.predictedCarcs.join(", ")}` : ""),
    );
    if (round.verdict.rationale) lines.push(round.verdict.rationale);
    lines.push("");
  }
  lines.push("── Outcome ──", outcome.summary);
  return lines.join("\n");
}
