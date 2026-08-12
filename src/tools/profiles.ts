import type { ToolSpec } from "../providers/types.js";
import { META_NAMES } from "./meta.js";
import { routeTools } from "../agent/tool-router.js";

// ── Tool profiles ────────────────────────────────────────────────────────────
// The registry holds ~173 tools. Sending all of them on every request is fine on
// exactly one provider and broken on the rest, for two separate reasons:
//
//   OpenAI rejects a request carrying more than 128 tools outright. Not a
//   degradation — a 400 on every turn.
//
//   The definitions serialize to about 145 KB, roughly 37,000 tokens. Anthropic
//   prompt-caches the block so it is paid for once; nobody else does, so on
//   OpenAI and Gemini it is 37k tokens of input on EVERY turn, and on a local
//   Ollama model with an 8k or 32k window it exhausts the context before the
//   conversation has started.
//
// So a session picks a profile. This is not only a workaround for provider
// limits — a model choosing among 173 tools chooses worse than one choosing
// among 30, and every profile here is a coherent job somebody actually does.

export interface Profile {
  name: string;
  description: string;
  /** Prefixes and exact names included. Matched against the tool name. */
  include: string[];
}

/** Always present: the agent cannot work without files, shell and fetch. */
// `data_status` is here rather than in a domain profile because every profile can
// be asked a question the missing datasets answer, and "I could not check" has to
// be reachable from all of them.
// `research_deep` joins them for the same reason: every profile gets asked
// something the installed datasets do not cover — a payer's own policy, a rule
// that changed last month — and the honest answer to those is a cited one, not
// a guess. `research_payer_policy` is narrower and stays in the profiles that
// deal with payer behaviour rather than costing every profile a slot.
const BASE = ["run_command", "read_file", "write_file", "list_dir", "web_fetch", "web_search",
  "tool_search", "tool_describe", "tool_invoke", "data_status", "tenant_current", "phi_access_record",
  "research_deep", "briefing_daily", "ask_user"];

export const PROFILES: Profile[] = [
  {
    name: "coding",
    description: "Look up and validate codes, calculate E/M, run CDI, work the review queue.",
    include: [
      ...BASE,
      "icd10_", "hcpcs_", "pos_lookup", "npi_", "em_", "presubmit_check", "cdi_", "code_suggest", "coding_corrections",
      "review_", "training_", "coverage_", "mac_lookup", "sad_exclusion_check",
      "global_period_", "telehealth_", "incident_to_check", "greenlight_check",
    ],
  },
  {
    name: "claims",
    description: "Build, scrub and submit claims; parse acknowledgments and remittances; coordinate benefits.",
    include: [
      ...BASE,
      "claim_", "era_", "ack_parse_277ca", "cob_", "eligibility_check", "superbill_build",
      "pa_", "dtr_", "filing_proof_record", "timely_filing_", "abn_generate", "gfe_",
      "icd10_validate", "npi_validate", "pos_lookup",
    ],
  },
  {
    name: "denials",
    description: "Work denials: explain them, predict them, fight them, and run the payer twin.",
    include: [
      ...BASE,
      "research_payer_policy",
      "denial_", "appeal_draft", "worklist_", "twin_", "payer_twin_adjudicate", "claim_gauntlet",
      "audit_track", "audit_list", "audit_update", "audit_response_draft", "audit_deadline_calculator",
      "coverage_", "timely_filing_", "ack_parse_277ca", "era_parse_835",
    ],
  },
  {
    name: "revenue",
    description: "Money: variance, fee schedules, forecasting, market rates, value-based care.",
    include: [
      ...BASE,
      "research_payer_policy",
      "payment_variance", "reimbursement_estimate", "fee_schedule_drift", "analytics_query",
      "kpi_dashboard", "contract_rate_",
      "revenue_model_fit", "cash_forecast", "simulate_scenario", "forecast_", "patient_",
      "rate_", "negotiation_brief", "idr_", "raf_calculate", "hcc_recapture", "suspect_",
      "quality_measures", "credit_balance_", "era_export", "report_generate",
    ],
  },
  {
    name: "operations",
    description: "Run the practice: credentialing, compliance, audit chain, swarm, portals, calls, email.",
    include: [
      ...BASE,
      "research_payer_policy",
      "credentialing_", "policy_", "sentinel_", "audit_", "swarm_", "portal_", "payer_call_",
      "call_", "ivr_map_", "email_", "mail_", "code_update_", "code_set_register", "a2a_", "report_generate",
      "phi_access_review",
    ],
  },
  {
    name: "ops",
    description: "Support and DevOps: database integrity, dataset health, inference telemetry, payer drift.",
    include: [
      ...BASE,
      "ops_", "support_", "mail_", "tenant_current", "phi_access_review", "audit_verify", "audit_log",
      "data_status", "code_update_calendar", "code_set_register", "analytics_query",
      // "what has this deployment actually filed" is an operational question, not
      // a billing one. Without this the person who asks it is on the wrong
      // profile to get an answer, and the answer matters most when something has
      // gone wrong — a submission with an unknown outcome may be sitting at a
      // payer. The ledger is read-only; nothing here can send.
      "claim_live_ledger",
    ],
  },
  {
    name: "all",
    description: "Every tool. Only workable on a provider that caches tool definitions and has no tool-count cap.",
    include: ["*"],
  },
];

/**
 * How many tools each provider is sent by DEFAULT.
 *
 * These are starting points, not physics — see HARD_TOOL_LIMITS for the ones
 * that are. Anthropic's 512 is headroom rather than usage: the registry holds
 * 224, so every tool already ships directly there.
 *
 * Ollama's 64 is the conservative one, and deliberately so: it is about
 * CONTEXT, not an API cap. The tool block competes with the conversation for
 * whatever window the model has, and 64 definitions is already a large fraction
 * of an 8k local window. On a large-context cloud model it is far too low, which
 * is exactly why it is now overridable per install — the right number depends on
 * the model's window, and the tool cannot know that without being told.
 */
export const PROVIDER_TOOL_LIMITS: Record<string, number> = {
  anthropic: 512,
  openai: 128,
  gemini: 128,
  ollama: 64,
};

/**
 * Ceilings that configuration CANNOT raise, because the API rejects the request.
 *
 * OpenAI refuses more than 128 function definitions outright — a config that
 * asked for 224 would not get a bigger tool set, it would get an error on every
 * turn. Letting the number be set anyway would be handing somebody a switch
 * whose only effect is to break their install, so the override is clamped and
 * says it clamped.
 *
 * Anthropic, Gemini and Ollama are absent on purpose: their practical limits are
 * about context and selection quality, which vary by model, so those are the
 * user's to choose.
 */
export const HARD_TOOL_LIMITS: Record<string, number> = {
  openai: 128,
};

export interface LimitDecision {
  limit: number;
  /** Set when the requested number could not be honoured. */
  note?: string;
}

/**
 * The tool limit actually used: the requested override, clamped to any hard cap.
 *
 * Pure, so the clamping rule is testable without a provider or a config file.
 */
export function resolveToolLimit(provider: string, requested?: number): LimitDecision {
  const base = PROVIDER_TOOL_LIMITS[provider] ?? 128;
  const hard = HARD_TOOL_LIMITS[provider];

  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return { limit: hard ? Math.min(base, hard) : base };
  }
  if (hard && requested > hard) {
    return {
      limit: hard,
      note: `toolLimits.${provider} asks for ${requested}, but ${provider} rejects more than ${hard} tool definitions per request — the API errors rather than truncating. Using ${hard}.`,
    };
  }
  return { limit: requested };
}

export function profileByName(name: string): Profile | undefined {
  return PROFILES.find((p) => p.name === name);
}

function matches(toolName: string, include: string[]): boolean {
  return include.some((pattern) =>
    pattern === "*" ? true : pattern.endsWith("_") ? toolName.startsWith(pattern) : toolName === pattern,
  );
}

export interface Selection {
  specs: ToolSpec[];
  /** Tools the profile excluded. */
  droppedByProfile: number;
  /** Tools cut purely to fit the provider's limit — these are the dangerous ones. */
  droppedByLimit: string[];
  /** Tools not on the wire but reachable through tool_search / tool_invoke. */
  deferred: string[];
  notes: string[];
}

/**
 * Choose the tools for a turn.
 *
 * When the profile still exceeds the provider's limit, the overflow is dropped
 * and **named**, rather than silently truncated. A model that quietly lost
 * `claim_scrub` will confidently do without it, and the transcript will look
 * like it decided not to scrub the claim rather than like it could not.
 */
export interface SelectOptions {
  /**
   * The message this turn is about. When present, the tools that overflow the
   * provider's cap are chosen FOR THE QUESTION rather than by registration
   * order — see src/agent/tool-router.ts for why that matters more than it
   * sounds.
   */
  hint?: string;
  /** Tool names this session pinned. Loaded ahead of everything scored. */
  pinned?: string[];
}

export function selectTools(
  all: ToolSpec[],
  profileName: string,
  provider: string,
  limitOverride?: number,
  opts: SelectOptions = {},
): Selection {
  const profile = profileByName(profileName);
  const notes: string[] = [];

  if (!profile) {
    notes.push(`No profile named "${profileName}"; using every tool. ${PROFILES.map((p) => p.name).join(", ")} are available.`);
  }
  const include = profile?.include ?? ["*"];
  const matched = all.filter((s) => matches(s.name, include));
  const droppedByProfile = all.length - matched.length;

  const decision = resolveToolLimit(provider, limitOverride);
  const limit = decision.limit;
  if (decision.note) notes.push(decision.note);
  let specs = matched;
  const droppedByLimit: string[] = [];
  const deferred: string[] = [];

  if (matched.length > limit) {
    const base = matched.filter((s) => BASE.includes(s.name) || META_NAMES.has(s.name));
    const rest = matched.filter((s) => !BASE.includes(s.name) && !META_NAMES.has(s.name));
    const room = Math.max(0, limit - base.length);

    // ── Which tools fill the remaining room ────────────────────────────────
    // Without a hint this is registration order, which is what it always was.
    // With one, the tools that answer THIS question come first. The model
    // cannot ask for a tool it was not given and will not say it is missing
    // one — it answers from memory instead, which is the single failure this
    // whole codebase is built to prevent.
    const routed = opts.hint || opts.pinned?.length
      ? routeTools(rest, { message: opts.hint ?? "", pinned: opts.pinned, take: room })
      : [];
    const priority = new Map(routed.map((n, i) => [n, i]));
    const ordered = routed.length
      ? [...rest].sort((a, b) => (priority.get(a.name) ?? Infinity) - (priority.get(b.name) ?? Infinity))
      : rest;
    specs = [...base, ...ordered.slice(0, room)];
    const rest2 = ordered;

    // With the catalogue tools loaded, the overflow is DEFERRED rather than
    // dropped: every one of them is still reachable through tool_search and
    // tool_invoke. Without them there is no route back, so it is a real loss and
    // gets named as one.
    const overflow = rest2.slice(room).map((s) => s.name);
    const catalogueLoaded = all.some((s) => META_NAMES.has(s.name));
    if (catalogueLoaded) {
      deferred.push(...overflow);
      notes.push(
        `${specs.length} tool(s) are loaded directly and ${deferred.length} more are reachable through tool_search / tool_invoke. ${provider} takes at most ${limit} definitions per request, so the rest are discovered on demand rather than shipped every turn.`,
      );
    } else {
      droppedByLimit.push(...overflow);
      notes.push(
        `Profile "${profileName}" has ${matched.length} tools and ${provider} takes at most ${limit}. ${droppedByLimit.length} were dropped: ${droppedByLimit.join(", ")}. Pick a narrower profile — a model cannot ask for a tool it was not given, and it will not say so.`,
      );
    }
  }

  if (provider !== "anthropic" && specs.length > 60) {
    const kb = Math.round(JSON.stringify(specs).length / 1024);
    notes.push(
      `${specs.length} tool definitions (~${kb} KB) are sent on every turn and ${provider} does not cache them. On a small local context window this alone can crowd out the conversation.`,
    );
  }

  return { specs, droppedByProfile, droppedByLimit, deferred, notes };
}

export function renderProfiles(): string {
  return [
    "Tool profiles:",
    ...PROFILES.map((p) => `  ${p.name.padEnd(11)} ${p.description}`),
    "",
    "Per-provider tool ceilings:",
    ...Object.entries(PROVIDER_TOOL_LIMITS).map(
      ([k, v]) => `  ${k.padEnd(11)} ${v}${k === "openai" ? "  (hard API limit — a larger request is rejected)" : k === "ollama" ? "  (context, not an API cap)" : ""}`,
    ),
  ].join("\n");
}
