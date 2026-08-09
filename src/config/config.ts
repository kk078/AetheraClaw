import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { z } from "zod";
import { DEFAULT_CONFIG_JSON5 } from "./defaults.js";
import { resolveKey } from "./credentials.js";

const ProviderBlock = z.object({
  model: z.string(),
  baseUrl: z.string().optional(),
});

export const ConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai", "gemini", "ollama"]).default("anthropic"),
  // Which slice of the ~173-tool registry a session is given. "all" only works
  // on a provider with no tool-count cap that caches the definition block.
  toolProfile: z.string().default("all"),
  providers: z
    .object({
      anthropic: ProviderBlock.default({ model: "claude-opus-5" }),
      openai: ProviderBlock.default({ model: "gpt-4.1" }),
      gemini: ProviderBlock.default({ model: "gemini-2.5-pro" }),
      // Ollama is two services behind one name, so it carries two models.
      // "qwen3" is a LOCAL name that `ollama pull qwen3` provides; Ollama Cloud
      // serves a different catalogue entirely and answers 404 for a name it does
      // not host. Which one is used follows the same decision as the base URL —
      // a key with no explicit local URL means the cloud — so the two can never
      // disagree about which service is being addressed.
      ollama: ProviderBlock.extend({ cloudModel: z.string().default("gpt-oss:120b") }).default({
        model: "qwen3",
        cloudModel: "gpt-oss:120b",
        baseUrl: "http://localhost:11434/v1",
      }),
    })
    .default({}),
  /**
   * How many tool definitions to send directly, per provider. Absent = the
   * built-in default.
   *
   * Exists because the right number depends on the MODEL'S CONTEXT WINDOW, and
   * nothing here can know that. The shipped Ollama default of 64 is sized for an
   * 8k local window; on a large-context cloud model it leaves most of the
   * catalogue behind tool_search for no reason. Raising it is not free — the
   * whole block is re-sent every turn on any provider that does not cache — so
   * `aetheraclaw tools budget` prints the measured cost before you choose.
   *
   * A value above a provider's hard API limit is clamped and reported, never
   * silently honoured: OpenAI errors on more than 128 rather than truncating.
   */
  toolLimits: z.record(z.number().int().positive()).default({}),
  workspaceRoot: z.string().default("~/aetheraclaw-workspace"),
  approvalPolicy: z.enum(["always", "unsafe-only", "never"]).default("unsafe-only"),
  gateway: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(4180),
    })
    .default({}),
  maxTokens: z.number().int().positive().default(64000),
  contextTokenBudget: z.number().int().positive().default(150000),
  shell: z
    .object({
      defaultTimeoutS: z.number().int().positive().default(30),
      maxOutputKb: z.number().int().positive().default(50),
    })
    .default({}),
  healthcare: z
    .object({
      cptDataPath: z.string().optional(),
      // A user-supplied SQLite reference database, read in place and read-only.
      // Same posture as cptDataPath: the file stays where the user put it and
      // never enters the repository.
      referenceDbPath: z.string().optional(),
      // Tables to read despite their column names looking like patient
      // identifiers. Named one at a time on purpose — there is no global
      // override, because a blanket flag is the same as no gate.
      referenceDbAllowTables: z.array(z.string()).default([]),
      // Roles whose content is licensed (currently "cpt") and which the practice
      // has confirmed it may read. Named explicitly and never defaulted on: the
      // default cannot be a decision about somebody else's licence.
      referenceDbLicensedRoles: z.array(z.string()).default([]),
      clearinghouse: z.string().default("mock"),
    })
    .default({}),
  email: z
    .object({
      enabled: z.boolean().default(false),
      imap: z
        .object({
          host: z.string().default(""),
          port: z.number().int().default(993),
          secure: z.boolean().default(true),
          user: z.string().default(""),
          mailbox: z.string().default("INBOX"),
        })
        .default({}),
      smtp: z
        .object({
          host: z.string().default(""),
          port: z.number().int().default(587),
          secure: z.boolean().default(false),
          user: z.string().default(""),
          from: z.string().default(""),
        })
        .default({}),
      pollSeconds: z.number().int().min(30).default(300),
      maxPerPoll: z.number().int().min(1).max(200).default(25),
      fromFilters: z.array(z.string()).default([]),
      // Inbound mail carrying identifier-shaped text is held rather than
      // delivered into a session: this deployment is not approved for PHI, and
      // an inbox is where it arrives unasked.
      quarantinePhi: z.boolean().default(true),
      sessionId: z.string().default(""),
    })
    .default({}),
  browser: z
    .object({
      // Navigation is confined to these origins. Credentials are named here by
      // ENVIRONMENT VARIABLE only — no secret belongs in a config file.
      portals: z
        .array(
          z.object({
            key: z.string(),
            label: z.string(),
            origins: z.array(z.string()).min(1),
            loginUrl: z.string().default(""),
            usernameSelector: z.string().default(""),
            passwordSelector: z.string().default(""),
            submitSelector: z.string().default(""),
            usernameEnv: z.string().default(""),
            passwordEnv: z.string().default(""),
            signedInSelector: z.string().default(""),
          }),
        )
        .default([]),
      headless: z.boolean().default(true),
      navigationTimeoutMs: z.number().int().positive().default(30000),
      executablePath: z.string().default(""),
      redactPhi: z.boolean().default(true),
    })
    .default({}),
  swarm: z
    .object({ mode: z.enum(["off", "assist", "autopilot-with-checkpoints"]).default("off") })
    .default({}),
  vbc: z
    .object({
      /** Dollars of revenue per 1.0 RAF, for sizing a gap. 0 means do not guess. */
      dollarsPerRaf: z.number().min(0).default(0),
    })
    .default({}),
  tenancy: z
    .object({
      // Off by default, and turning it on cannot move an existing install's
      // data: single-tenant keeps the old database path, multi-tenant puts each
      // tenant under tenants/<slug>/. There is no automatic migration because a
      // migration that guesses which practice owns which row is worse than none.
      enabled: z.boolean().default(false),
      // Which tenant a process serves when nothing more specific says otherwise.
      // A CLI flag or a gateway session binding overrides it. This is the ONLY
      // place a default tenant can come from — never tool input.
      defaultTenant: z.string().default(""),
    })
    .default({}),
  voice: z
    .object({
      // Defaults to the simulator. Real dialling is opt-in because a payer call
      // means saying a member ID out loud, and this build is not approved for PHI.
      provider: z.enum(["simulator", "twilio"]).default("simulator"),
      fromNumber: z.string().default("").describe("E.164 number calls originate from"),
      callerState: z.string().default("").describe("Two-letter state the practice calls from — decides the recording rule"),
      webhookUrl: z.string().default(""),
      accountSidEnv: z.string().default("TWILIO_ACCOUNT_SID"),
      authTokenEnv: z.string().default("TWILIO_AUTH_TOKEN"),
      /** Off by default. Twelve states make recording without consent a crime. */
      recordCalls: z.boolean().default(false),
      maxCallMinutes: z.number().int().positive().default(45),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type EmailConfig = Config["email"];

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function configDir(): string {
  return process.env.AETHERACLAW_HOME
    ? expandHome(process.env.AETHERACLAW_HOME)
    : path.join(os.homedir(), ".aetheraclaw");
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dir = configDir();
  const file = path.join(dir, "config.json5");
  let raw: unknown = {};
  if (fs.existsSync(file)) {
    raw = JSON5.parse(fs.readFileSync(file, "utf8"));
  } else {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, DEFAULT_CONFIG_JSON5);
    raw = JSON5.parse(DEFAULT_CONFIG_JSON5);
  }
  const merged = { ...(raw as Record<string, unknown>), ...overrides };
  const cfg = ConfigSchema.parse(merged);
  // Absolute, always. This is the confinement root every file tool resolves
  // against, and a relative one moves with the process's working directory —
  // so the same config would confine to two different folders depending on
  // where the gateway happened to be started.
  cfg.workspaceRoot = path.resolve(expandHome(cfg.workspaceRoot));
  fs.mkdirSync(cfg.workspaceRoot, { recursive: true });
  return cfg;
}

export type ProviderName = Config["provider"];

/**
 * Preference order when the configured provider cannot run.
 *
 * A provider with a key ranks above one without. Ollama is last not because it
 * is worse but because it is the only one that is "usable" with no key at all —
 * that means a LOCAL server, which may simply not be running, so it is the
 * fallback of last resort rather than a confident pick. With OLLAMA_API_KEY set
 * it is Ollama Cloud and ranks with the rest.
 */
const SUBSTITUTION_ORDER: ProviderName[] = ["anthropic", "openai", "gemini", "ollama"];

export interface ProviderChoice {
  provider: ProviderName;
  /** Set when the configured provider was passed over. Announced, never silent. */
  substitutedFrom?: ProviderName;
  /** Empty when a provider was found; otherwise why nothing could run. */
  error: string;
}

/**
 * Decide which provider actually runs.
 *
 * This exists because the previous behaviour was to hard-exit whenever the
 * CONFIGURED provider had no key — and the shipped default is "anthropic". A
 * user who had set only OLLAMA_API_KEY was therefore told, every single time, to
 * go and get an Anthropic key, while a provider that could have served the
 * request sat configured and ignored. The instruction to "set ANTHROPIC_API_KEY"
 * was the tool refusing to use what the user had actually chosen.
 *
 * An EXPLICIT --provider is never substituted: that is a direct instruction, and
 * quietly serving a different model than the one named is worse than failing.
 * Everything else falls through to whatever can run, and says so.
 */
export function resolveProvider(
  config: Pick<Config, "provider">,
  opts: { explicit?: string; env?: NodeJS.ProcessEnv } = {},
): ProviderChoice {
  const env = opts.env ?? process.env;
  const usable = (p: ProviderName): boolean => (p === "ollama" ? true : Boolean(keyFromEnv(p, env)));
  const keyed = (p: ProviderName): boolean => Boolean(keyFromEnv(p, env));

  if (opts.explicit) {
    const p = opts.explicit as ProviderName;
    if (!SUBSTITUTION_ORDER.includes(p)) {
      return { provider: config.provider, error: `Unknown provider "${opts.explicit}". Choose one of: ${SUBSTITUTION_ORDER.join(", ")}.` };
    }
    if (!usable(p)) {
      return { provider: p, error: `--provider ${p} was given but no key is configured for it. Run \`aetheraclaw auth set ${p}\`, or export ${envVarFor(p)}, or name a provider you have a key for.` };
    }
    return { provider: p, error: "" };
  }

  if (usable(config.provider)) return { provider: config.provider, error: "" };

  const substitute =
    SUBSTITUTION_ORDER.find((p) => p !== config.provider && keyed(p)) ??
    SUBSTITUTION_ORDER.find((p) => p !== config.provider && usable(p));

  if (!substitute) {
    return {
      provider: config.provider,
      error: `No provider can run. Add a key with \`aetheraclaw auth set <provider>\` (or export one of ${SUBSTITUTION_ORDER.map(envVarFor).join(", ")}), or start a local model server — \`aetheraclaw auth discover\` will find one.`,
    };
  }
  return { provider: substitute, substitutedFrom: config.provider, error: "" };
}

export function envVarFor(provider: ProviderName): string {
  return provider === "anthropic" ? "ANTHROPIC_API_KEY" : `${provider.toUpperCase()}_API_KEY`;
}

/**
 * A provider's key from EITHER place: the environment, or the stored file.
 *
 * Named `keyFromEnv` historically, when the environment was the only source.
 * It now consults both, because a key entered once with `auth set` has to count
 * as configured everywhere the environment did — otherwise the provider table
 * says "--" for a provider that works, and substitution passes over it.
 */
function keyFromEnv(provider: ProviderName, env: NodeJS.ProcessEnv): string | undefined {
  return resolveKey(provider, { env }).key;
}

/** A provider's key, from the environment first and the stored file second. */
export function apiKeyFor(provider: Config["provider"]): string | undefined {
  return resolveKey(provider).key;
}
