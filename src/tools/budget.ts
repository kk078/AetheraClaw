import type { ToolSpec } from "../providers/types.js";
import { HARD_TOOL_LIMITS, PROVIDER_TOOL_LIMITS } from "./profiles.js";

// ── What a tool block actually costs ─────────────────────────────────────────
// "Load all the tools" sounds free and is not. The definition block is re-sent
// on EVERY turn to any provider that does not cache it, so the choice is not
// "more tools or fewer" but "more tools or more conversation", measured in the
// same window.
//
// The numbers here are computed from the real registry rather than estimated,
// because the intuition is badly wrong: 224 definitions is over 200 KB, which is
// most of a small context window before the user has typed anything.

/**
 * Bytes on the wire for one tool, in the OpenAI function encoding.
 *
 * That encoding rather than an abstract size because it is what three of the
 * four providers actually receive, and it is the largest of the shapes — a
 * budget that under-counts is worse than none.
 */
export function wireBytes(spec: ToolSpec): number {
  return JSON.stringify({
    type: "function",
    function: { name: spec.name, description: spec.description, parameters: spec.inputSchema },
  }).length;
}

/**
 * Bytes to tokens.
 *
 * Deliberately a ratio and not a tokeniser: a real tokeniser is a per-provider
 * dependency and a large one, and the answer is used to decide "is this a tenth
 * of my window or half of it", where being 15% out changes nothing. Named so
 * nobody mistakes it for exact.
 */
export const BYTES_PER_TOKEN = 4;

export function approxTokens(bytes: number): number {
  return Math.round(bytes / BYTES_PER_TOKEN);
}

export interface BudgetRow {
  count: number;
  bytes: number;
  tokens: number;
}

export function budgetAt(specs: ToolSpec[], counts: number[]): BudgetRow[] {
  const sorted = [...counts].filter((c) => c > 0).sort((a, b) => a - b);
  return sorted.map((count) => {
    const bytes = specs.slice(0, count).reduce((n, s) => n + wireBytes(s), 0);
    return { count, bytes, tokens: approxTokens(bytes) };
  });
}

export interface BudgetReport {
  total: number;
  rows: BudgetRow[];
  /** Every tool, which is the figure "load them all" actually means. */
  all: BudgetRow;
  largest: { name: string; bytes: number };
}

export function buildBudget(specs: ToolSpec[], contextWindow: number): BudgetReport {
  const counts = [16, 32, 64, 128, 256, 512].filter((c) => c < specs.length);
  const largest = specs.reduce(
    (max, s) => (wireBytes(s) > max.bytes ? { name: s.name, bytes: wireBytes(s) } : max),
    { name: "", bytes: 0 },
  );
  const allBytes = specs.reduce((n, s) => n + wireBytes(s), 0);
  void contextWindow;
  return {
    total: specs.length,
    rows: budgetAt(specs, counts),
    all: { count: specs.length, bytes: allBytes, tokens: approxTokens(allBytes) },
    largest,
  };
}

export function renderBudget(report: BudgetReport, opts: { provider: string; contextWindow: number; current: number }): string {
  const { provider, contextWindow, current } = opts;
  const share = (t: number) => `${((t / contextWindow) * 100).toFixed(1)}%`;
  const lines: string[] = [];

  lines.push(`${report.total} tools registered. Sending them costs, every turn, on any provider that does not cache the block.`);
  lines.push(`Measured against a ${contextWindow.toLocaleString()}-token window; ~${BYTES_PER_TOKEN} bytes per token, which is an estimate and not a tokeniser.`);
  lines.push("");
  lines.push(["direct".padStart(7), "bytes".padStart(9), "~tokens".padStart(9), "window".padStart(8)].join("  "));

  for (const r of [...report.rows, report.all]) {
    const mark = r.count === current ? "  <- current" : "";
    lines.push(
      [
        String(r.count).padStart(7),
        r.bytes.toLocaleString().padStart(9),
        r.tokens.toLocaleString().padStart(9),
        share(r.tokens).padStart(8),
      ].join("  ") + mark,
    );
  }

  lines.push("");
  const hard = HARD_TOOL_LIMITS[provider];
  if (hard) {
    lines.push(`${provider} rejects more than ${hard} definitions per request. That is an API limit, not a setting — a larger number here would error on every turn, so it is clamped.`);
  } else {
    lines.push(`${provider} has no hard cap here; the limit is context and selection quality, which is why it is yours to set.`);
  }
  lines.push(`Default for ${provider}: ${PROVIDER_TOOL_LIMITS[provider] ?? 128}. Change it with toolLimits.${provider} in config.json5.`);
  lines.push("");
  lines.push(`Largest single definition: ${report.largest.name} at ${report.largest.bytes.toLocaleString()} bytes.`);
  lines.push("");
  lines.push("NOTHING IS LOST AT A LOWER NUMBER. Tools past the limit are reachable through tool_search and tool_invoke — they cost an extra round trip, not the capability.");
  lines.push("More is also not automatically better: large tool sets measurably degrade which tool a model picks. `aetheraclaw eval` measures that on your own model rather than guessing.");
  return lines.join("\n");
}
