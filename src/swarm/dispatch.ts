import { STAGES, mayAutomate, transitionsFrom, type Role, type Stage, type SwarmMode } from "./stages.js";

// ── Dispatch planning ────────────────────────────────────────────────────────
// What a swarm run WOULD do, computed before anything is done.
//
// The danger in an unattended pipeline is not a wrong action. A human working a
// queue makes a wrong call occasionally and catches it on the next one. A
// dispatcher makes the same wrong call four hundred times before anyone looks,
// and four hundred identical bad claims is not four hundred mistakes — it is one
// mistake and a compliance event.
//
// So the limits here are about blast radius rather than correctness: cap how much
// one run can touch, stop advancing an item that keeps failing, and halt the
// whole run when failures start looking systematic rather than incidental.

export interface BlackboardItem {
  id: string;
  claimRef: string;
  payer: string;
  stage: Stage;
  attempts: number;
  lastError: string;
  amountCents: number;
  updatedAt: number;
}

export interface DispatchLimits {
  /** Items one run may advance. */
  maxItems: number;
  /** Attempts on one item at one stage before it is parked for a human. */
  maxAttemptsPerItem: number;
  /**
   * Identical failures across distinct items before the run halts.
   *
   * One item failing is that item's problem. The same failure on several items
   * is a broken rule, a bad dataset or a changed payer, and continuing turns one
   * fixable problem into a batch of them.
   */
  systematicFailureThreshold: number;
}

export const DEFAULT_LIMITS: DispatchLimits = {
  maxItems: 25,
  maxAttemptsPerItem: 3,
  systematicFailureThreshold: 3,
};

export type PlanDecision =
  | "automate"
  | "needs_human"
  | "parked_max_attempts"
  | "terminal"
  | "blocked_by_mode"
  | "over_item_limit";

export interface PlannedItem {
  item: BlackboardItem;
  decision: PlanDecision;
  role: Role;
  action: string;
  tool: string;
  reason: string;
}

export interface DispatchPlan {
  mode: SwarmMode;
  planned: PlannedItem[];
  automatable: PlannedItem[];
  needingHuman: PlannedItem[];
  parked: PlannedItem[];
  halted: boolean;
  haltReason: string;
}

/** Failures that look like the same underlying problem, whatever item they hit. */
export function failureSignature(error: string): string {
  return error
    .toLowerCase()
    // Strip the parts that differ per item so the shape of the failure is what
    // gets compared, not the identifiers in it.
    .replace(/\b[a-z]{2,6}[-_]?\d{3,}\b/g, "<id>")
    .replace(/\$\s?[\d,]+(\.\d{2})?/g, "<amount>")
    .replace(/\b\d{8}\b/g, "<date>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export interface FailureCluster {
  signature: string;
  count: number;
  claimRefs: string[];
}

/** Repeated failures, worst first. */
export function clusterFailures(items: BlackboardItem[]): FailureCluster[] {
  const clusters = new Map<string, FailureCluster>();
  for (const item of items) {
    if (!item.lastError.trim()) continue;
    const signature = failureSignature(item.lastError);
    const slot = clusters.get(signature) ?? { signature, count: 0, claimRefs: [] };
    slot.count++;
    // Distinct items only: one item retried three times is not three items failing.
    if (!slot.claimRefs.includes(item.claimRef)) slot.claimRefs.push(item.claimRef);
    clusters.set(signature, slot);
  }
  return [...clusters.values()]
    .map((c) => ({ ...c, count: c.claimRefs.length }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Plan a run.
 *
 * Items are ordered oldest-first so nothing starves, then capped. Everything
 * beyond the cap is reported rather than silently dropped — a queue that quietly
 * stops at twenty-five looks identical to a queue that finished.
 */
export function planDispatch(
  items: BlackboardItem[],
  mode: SwarmMode,
  limits: DispatchLimits = DEFAULT_LIMITS,
): DispatchPlan {
  const clusters = clusterFailures(items);
  const systematic = clusters.find((c) => c.count >= limits.systematicFailureThreshold);
  if (systematic) {
    return {
      mode,
      planned: [],
      automatable: [],
      needingHuman: [],
      parked: [],
      halted: true,
      haltReason: `Halted before doing anything: ${systematic.count} different claims failed the same way — "${systematic.signature}" (${systematic.claimRefs.slice(0, 5).join(", ")}${systematic.claimRefs.length > 5 ? ", …" : ""}). That is one broken thing, not several unlucky claims, and advancing the rest would multiply it. Fix the cause, clear the errors, then run again.`,
    };
  }

  const ordered = [...items].sort((a, b) => a.updatedAt - b.updatedAt);
  const planned: PlannedItem[] = [];
  // Slots the run would actually spend. Counting queue positions instead would
  // let terminal, parked and waiting-on-a-person claims consume the budget —
  // a board of paid claims would exhaust the limit having advanced nothing.
  let taken = 0;

  for (const item of ordered) {
    const spec = STAGES[item.stage];
    const options = transitionsFrom(item.stage);

    if (spec.terminal || options.length === 0) {
      planned.push({
        item,
        decision: "terminal",
        role: spec.owner,
        action: spec.action,
        tool: spec.tool,
        reason: `${spec.label} is a terminal stage.`,
      });
      continue;
    }

    if (item.attempts >= limits.maxAttemptsPerItem) {
      planned.push({
        item,
        decision: "parked_max_attempts",
        role: "human",
        action: spec.action,
        tool: spec.tool,
        reason: `Tried ${item.attempts} time(s) at ${spec.label} without moving. Something here needs a person${item.lastError ? `: ${item.lastError}` : ""}.`,
      });
      continue;
    }

    const automatable = options.filter((t) => mayAutomate(t, mode));
    if (automatable.length === 0) {
      const allHuman = options.every((t) => t.requiresHuman);
      planned.push({
        item,
        decision: allHuman ? "needs_human" : "blocked_by_mode",
        role: allHuman ? "human" : spec.owner,
        action: spec.action,
        tool: spec.tool,
        reason: allHuman
          ? options[0].reason
          : mode === "off"
            ? "The swarm is off. Nothing advances on its own."
            : "Assist mode: the swarm says what is next but does not take it.",
      });
      continue;
    }

    if (taken >= limits.maxItems) {
      planned.push({
        item,
        decision: "over_item_limit",
        role: spec.owner,
        action: spec.action,
        tool: spec.tool,
        reason: `Beyond this run's limit of ${limits.maxItems} items.`,
      });
      continue;
    }

    taken++;
    planned.push({
      item,
      decision: "automate",
      role: spec.owner,
      action: spec.action,
      tool: spec.tool,
      reason: `${spec.owner} advances this from ${spec.label}.`,
    });
  }

  return {
    mode,
    planned,
    automatable: planned.filter((p) => p.decision === "automate"),
    needingHuman: planned.filter((p) => p.decision === "needs_human" || p.decision === "parked_max_attempts"),
    parked: planned.filter((p) => p.decision === "parked_max_attempts"),
    halted: false,
    haltReason: "",
  };
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function renderPlan(plan: DispatchPlan, limits: DispatchLimits = DEFAULT_LIMITS): string {
  if (plan.halted) return plan.haltReason;

  const lines: string[] = [`Swarm mode: ${plan.mode}.`];
  if (plan.planned.length === 0) return "Nothing on the board.";

  const byStage = new Map<Stage, PlannedItem[]>();
  for (const p of plan.planned) byStage.set(p.item.stage, [...(byStage.get(p.item.stage) ?? []), p]);

  lines.push("", "Pipeline:");
  for (const [stage, group] of byStage) {
    const value = group.reduce((sum, p) => sum + p.item.amountCents, 0);
    lines.push(`  ${STAGES[stage].label}: ${group.length} claim(s), ${money(value)} — owner ${STAGES[stage].owner}`);
  }

  if (plan.automatable.length > 0) {
    lines.push("", `Would advance ${plan.automatable.length} claim(s):`);
    for (const p of plan.automatable.slice(0, 20)) {
      lines.push(`  ${p.item.claimRef} — ${STAGES[p.item.stage].label} · ${p.role} · ${p.tool || "no tool"}`);
    }
    if (plan.automatable.length > 20) lines.push(`  … and ${plan.automatable.length - 20} more.`);
  } else {
    lines.push("", "Nothing advances on its own right now.");
  }

  const waiting = plan.planned.filter((p) => p.decision === "needs_human");
  if (waiting.length > 0) {
    lines.push("", `Waiting on a person — ${waiting.length} claim(s):`);
    for (const p of waiting.slice(0, 20)) {
      lines.push(`  ${p.item.claimRef} — ${STAGES[p.item.stage].label}: ${p.reason}`);
    }
    if (waiting.length > 20) lines.push(`  … and ${waiting.length - 20} more.`);
  }

  if (plan.parked.length > 0) {
    lines.push("", `Parked after repeated failures — ${plan.parked.length} claim(s):`);
    for (const p of plan.parked) lines.push(`  ${p.item.claimRef}: ${p.reason}`);
  }

  const overflow = plan.planned.filter((p) => p.decision === "over_item_limit");
  if (overflow.length > 0) {
    lines.push(
      "",
      `${overflow.length} claim(s) were ready but fall beyond this run's limit of ${limits.maxItems}. They are still here; run again to take the next batch.`,
    );
  }

  const blocked = plan.planned.filter((p) => p.decision === "blocked_by_mode");
  if (blocked.length > 0 && plan.mode !== "autopilot-with-checkpoints") {
    lines.push(
      "",
      plan.mode === "off"
        ? `${blocked.length} claim(s) could be advanced automatically if the swarm were enabled.`
        : `${blocked.length} claim(s) are ready to advance. In assist mode the swarm names them; you take them.`,
    );
  }

  return lines.join("\n");
}
