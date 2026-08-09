import type { Config } from "../config/config.js";
import type { ModelProvider, NormalizedBlock, NormalizedMessage } from "../providers/types.js";
import { selectTools } from "../tools/profiles.js";
import { META_NAMES } from "../tools/meta.js";
import type { ToolRegistry } from "../tools/registry.js";
import { buildSystemPrompt, catalogueBlock } from "../agent/system-prompt.js";
import { CASES, isRefusalCase, type EvalCase } from "./cases.js";

// ── The harness ──────────────────────────────────────────────────────────────
// Runs each case against the CONFIGURED provider with the SAME tool selection
// production uses — selectTools, same profile, same provider cap — so the
// 64-direct/147-deferred split the model actually faces is the split under test.
//
// ONLY CATALOGUE TOOLS ARE EXECUTED. tool_search and tool_describe run for real,
// because the model cannot discover a deferred tool without them and the whole
// point is measuring whether it does. Every domain tool is stubbed: what is being
// measured is which tool the model REACHES FOR, and running claim_scrub or
// era_parse_835 for real would mean a harness with side effects, network calls
// and a database — none of which change the answer.

export const MAX_ROUNDS = 6;

// WHAT THE STUB COSTS, STATED SO NOBODY HAS TO REDISCOVER IT. A stubbed tool
// returns no data, so a model that would have searched, read a real result and
// then invoked something more specific may stop after the search. That is why
// several cases accept `tool_search` as a pass: reaching for the catalogue is
// the behaviour under test, and demanding the full search → describe → invoke
// chain would score the harness's own emptiness. It does mean a bare
// `tool_search` pass is a weaker signal than an invocation, and the per-case
// output prints the whole chain so the difference is visible rather than hidden
// in the total.
/** The stub every non-catalogue tool returns, in place of running. */
const STUB = "(evaluation harness: this tool was not executed. Assume it succeeded and continue, or answer the user.)";

export interface CaseResult {
  case: EvalCase;
  /** Every tool the model reached for, in order. tool_invoke contributes its target's name. */
  reached: string[];
  passed: boolean;
  /** Present when the run itself failed, as opposed to the model choosing wrong. */
  error?: string;
  ms: number;
}

/**
 * Did this run pass?
 *
 * A refusal case (empty `expect`) passes by calling NOTHING. Everything else
 * passes by reaching any one of the named tools — several tools legitimately
 * answer some of these questions, and demanding one exact name would score
 * house style rather than capability.
 */
export function scoreCase(c: EvalCase, reached: string[]): boolean {
  if (isRefusalCase(c)) return reached.length === 0;
  return c.expect.some((name) => reached.includes(name));
}

export interface EvalDeps {
  provider: ModelProvider;
  registry: ToolRegistry;
  config: Config;
  services: Record<string, unknown>;
}

export async function runCase(deps: EvalDeps, c: EvalCase): Promise<CaseResult> {
  const { provider, registry, config } = deps;
  const started = Date.now();
  const system = buildSystemPrompt(config.workspaceRoot);
  const selection = selectTools(registry.specs(), config.toolProfile, provider.name, config.toolLimits[provider.name]);
  const messages: NormalizedMessage[] = [{ role: "user", content: [{ type: "text", text: c.prompt }] }];
  const reached: string[] = [];

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let stopReason = "end_turn";
      let assistant: NormalizedBlock[] = [];
      for await (const event of provider.streamTurn({
        system: selection.deferred.length > 0 ? system + catalogueBlock(selection.deferred.length) : system,
        messages,
        tools: selection.specs,
        maxTokens: config.maxTokens,
      })) {
        if (event.type === "turn_end") {
          stopReason = event.stopReason;
          assistant = event.assistant;
        }
      }

      if (assistant.length > 0) messages.push({ role: "assistant", content: assistant });
      const uses = assistant.filter((b): b is Extract<NormalizedBlock, { type: "tool_use" }> => b.type === "tool_use");
      if (stopReason !== "tool_use" || uses.length === 0) break;

      const results: NormalizedBlock[] = [];
      for (const use of uses) {
        reached.push(use.name);
        // tool_invoke's target is the tool that was actually reached for. Without
        // this the harness would score every deferred call as "tool_invoke" and
        // be blind to whether the right one was chosen.
        if (use.name === "tool_invoke") {
          const target = (use.input as { name?: unknown }).name;
          if (typeof target === "string") reached.push(target);
        }

        const content = META_NAMES.has(use.name) && use.name !== "tool_invoke"
          ? (await registry.execute(use.name, use.input, harnessContext(deps))).content
          : STUB;
        results.push({ type: "tool_result", toolUseId: use.id, content, isError: false });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    return { case: c, reached, passed: false, error: (err as Error).message, ms: Date.now() - started };
  }

  return { case: c, reached, passed: scoreCase(c, reached), ms: Date.now() - started };
}

function harnessContext(deps: EvalDeps) {
  return {
    workspaceRoot: deps.config.workspaceRoot,
    sessionId: "eval",
    approvalPolicy: "never" as const,
    // Nothing that could prompt is ever executed — only tool_search and
    // tool_describe, both read-only — so this cannot silently approve anything.
    requestApproval: async () => false,
    services: deps.services,
  };
}

export interface EvalReport {
  results: CaseResult[];
  passed: number;
  total: number;
  provider: string;
  model: string;
  directTools: number;
  deferredTools: number;
}

export async function runEval(deps: EvalDeps, cases: EvalCase[] = CASES, onCase?: (r: CaseResult) => void): Promise<EvalReport> {
  const selection = selectTools(deps.registry.specs(), deps.config.toolProfile, deps.provider.name, deps.config.toolLimits[deps.provider.name]);
  const results: CaseResult[] = [];
  // Serial, not parallel: a rate-limited provider turning concurrent requests
  // into 429s would score as capability failures, which is the one thing a
  // measurement harness must not do.
  for (const c of cases) {
    const r = await runCase(deps, c);
    results.push(r);
    onCase?.(r);
  }
  return {
    results,
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    provider: deps.provider.name,
    model: deps.provider.model,
    directTools: selection.specs.length,
    deferredTools: selection.deferred.length,
  };
}

export function renderReport(report: EvalReport): string {
  const out = [
    "",
    `${report.provider} / ${report.model} — ${report.directTools} tools loaded directly, ${report.deferredTools} behind the catalogue.`,
    "",
  ];

  // A run the provider failed is not a capability measurement. Said before the
  // failures so nobody reads a rate-limited run as a finding about the model.
  const errored = report.results.filter((r) => r.error);
  if (errored.length > 0) {
    out.push(
      `${errored.length} of ${report.results.length} case(s) ERRORED — the provider failed, so this score measures availability, not capability.`,
      `First error: ${errored[0].error}`,
      "",
    );
  }

  const failures = report.results.filter((r) => !r.passed);
  for (const r of failures) {
    out.push(
      `FAIL  ${r.case.id}`,
      `      "${r.case.prompt}"`,
      `      reached: ${r.reached.length > 0 ? r.reached.join(" → ") : "(no tool called)"}`,
      `      wanted:  ${isRefusalCase(r.case) ? "no tool call at all" : r.case.expect.join(" | ")}`,
      `      why:     ${r.case.why}`,
      // Same blind spot as the voice report: a provider error scores as a
      // failure with no tool reached, which reads as "the model chose not to"
      // when the request never completed. Naming it keeps a flaky run from
      // being recorded as a capability finding.
      ...(r.error ? [`      ERROR:   ${r.error} — the provider failed; this is not a behavioural result`] : []),
      ...(r.error ? [`      error:   ${r.error}`] : []),
      "",
    );
  }

  out.push(
    `${report.passed}/${report.total} passed.`,
    // Per-case, not a bare aggregate: "76%" hides WHICH capability is
    // unreachable, and unreachable capabilities are the point of the exercise.
    failures.length === 0
      ? "Every case reached a tool that can actually answer it."
      : `${failures.length} case(s) above. A low score is the finding — the cases describe real questions, so tuning them to pass measures nothing.`,
  );
  return out.join("\n");
}
