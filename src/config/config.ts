import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { z } from "zod";
import { DEFAULT_CONFIG_JSON5 } from "./defaults.js";
import { resolveKey } from "./credentials.js";
import { readEnv, resolveHome } from "./legacy.js";

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
   * `orion tools budget` prints the measured cost before you choose.
   *
   * A value above a provider's hard API limit is clamped and reported, never
   * silently honoured: OpenAI errors on more than 128 rather than truncating.
   */
  toolLimits: z.record(z.number().int().positive()).default({}),
  workspaceRoot: z.string().default("~/orion-workspace"),
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
  // Deliberately a sibling of `voice` rather than a field inside it. `voice`
  // already means "which telephony carrier places an outbound payer call";
  // this is the operator talking to Orion at their own desk. They share
  // the word "voice" in English and nothing else — same config key would make
  // `voice.provider: "twilio"` and a browser microphone one setting.
  // Document ingest. An archive of EOBs is the realistic batch, and a scanned
  // one is the realistic document.
  ingest: z
    .object({
      // "auto" runs OCR only on a file that came back unreadable BECAUSE it has
      // no text layer. "off" leaves those refused, which is the right setting
      // where the OCR dependency cannot be installed and a silent guess would
      // be worse than an honest refusal.
      ocr: z.enum(["auto", "off"]).default("auto"),
      /** Bounds the work one upload can start; the remainder is reported, never dropped. */
      maxArchiveEntries: z.number().int().positive().max(2000).default(200),
    })
    .default({ ocr: "auto", maxArchiveEntries: 200 }),

  speech: z
    .object({
      // Off until asked for. A microphone that turns itself on because a
      // package was installed is the wrong default anywhere, and doubly so on
      // a workstation inside a clinic.
      enabled: z.boolean().default(false),
      // browser = Web Speech API, zero install, but Chrome ships the audio to
      // Google. local = whisper.cpp + Piper, nothing leaves the machine.
      // cloud = a vendor API, best latency, worst PHI posture.
      engine: z.enum(["browser", "local", "cloud"]).default("browser"),
      // Push-to-talk is the default because a hot microphone in a room where
      // patients are discussed records the room, not the request.
      mode: z.enum(["push-to-talk", "always-on"]).default("push-to-talk"),
      wakeWord: z.string().default("hey aethera").describe("Only used when mode is always-on"),
      speakReplies: z.boolean().default(true),
      /** Spoken replies are cut at a sentence boundary past this; a five-minute monologue is not an answer. */
      maxSpokenChars: z.number().int().positive().default(1200),
      // A spoken answer should be the verdict, not the essay. "brief" speaks the
      // headline and the number and waits to be asked for the rest; the screen
      // still shows everything either way, so this trades nothing away. It is
      // the default because a reply that is right and four paragraphs long is,
      // out loud, a reply nobody listened to the end of.
      verbosity: z.enum(["brief", "full"]).default("brief"),
      /**
       * Look a code up from the interim transcript, while the speaker is still
       * talking.
       *
       * Strictly local reads against the installed tables — never a tool call,
       * never anything that writes, and discarded when the final transcript
       * disagrees. It only fills in the composer hint sooner.
       */
      prefetch: z.boolean().default(true),
      local: z
        .object({
          whisperBin: z.string().default("whisper-cli"),
          whisperModel: z.string().default("").describe("Path to a ggml Whisper model file"),
          piperBin: z.string().default("piper"),
          piperVoice: z.string().default("").describe("Path to a Piper .onnx voice"),
        })
        .default({}),
      cloud: z
        .object({
          sttVendor: z.enum(["openai", "deepgram"]).default("openai"),
          ttsVendor: z.enum(["openai", "elevenlabs"]).default("openai"),
          sttModel: z.string().default("whisper-1"),
          ttsModel: z.string().default("tts-1"),
          ttsVoice: z.string().default("alloy"),
          // The env var NAME, never the key — same convention as Twilio above
          // and the payer portals.
          sttKeyEnv: z.string().default("OPENAI_API_KEY"),
          ttsKeyEnv: z.string().default("OPENAI_API_KEY"),
        })
        .default({}),
      consent: z
        .object({
          /** The browser asks once per session before the microphone is first opened. */
          requireAcknowledgement: z.boolean().default(true),
          /** Off: captured audio is transcribed and dropped, never written to disk. */
          retainAudio: z.boolean().default(false),
        })
        .default({}),
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

/**
 * Where configuration and data live.
 *
 * Delegates to resolveHome, which honours the pre-rename ORION_HOME/`~/.orion`
 * names as well as the old AETHERACLAW ones. See src/config/legacy.ts for why
 * that matters more than it looks: an install from before the rename has its
 * claims in the old directory, and silently starting fresh next to them reads
 * as data loss.
 */
export function configDir(): string {
  return resolveHome(process.env);
}

/**
 * Let the environment set the listening address.
 *
 * Needed because a container has no config file to edit and no command line to
 * extend: the image is built once and configured by environment, which is why
 * ORION_HOME already works this way.
 *
 * Applied AFTER the schema parse and BEFORE any CLI override, so precedence
 * reads the way people expect — flag beats environment beats file. A port that
 * is not a number in range is IGNORED rather than coerced: `parseInt` turns
 * "8080abc" into 8080 and "" into NaN, and a gateway that quietly listens
 * somewhere other than where it was told is worse than one that uses its
 * default.
 */
export function applyGatewayEnv(cfg: Config, env: NodeJS.ProcessEnv): Config {
  const host = readEnv("HOST", env)?.trim();
  if (host) cfg.gateway.host = host;
  const rawPort = readEnv("PORT", env)?.trim();
  if (rawPort && /^\d+$/.test(rawPort)) {
    const port = Number(rawPort);
    if (port > 0 && port <= 65535) cfg.gateway.port = port;
  }
  return cfg;
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
  applyGatewayEnv(cfg, process.env);
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
      return { provider: p, error: `--provider ${p} was given but no key is configured for it. Run \`orion auth set ${p}\`, or export ${envVarFor(p)}, or name a provider you have a key for.` };
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
      error: `No provider can run. Add a key with \`orion auth set <provider>\` (or export one of ${SUBSTITUTION_ORDER.map(envVarFor).join(", ")}), or start a local model server — \`orion auth discover\` will find one.`,
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
