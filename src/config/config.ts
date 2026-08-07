import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { z } from "zod";
import { DEFAULT_CONFIG_JSON5 } from "./defaults.js";

const ProviderBlock = z.object({
  model: z.string(),
  baseUrl: z.string().optional(),
});

export const ConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai", "gemini", "ollama"]).default("anthropic"),
  providers: z
    .object({
      anthropic: ProviderBlock.default({ model: "claude-opus-5" }),
      openai: ProviderBlock.default({ model: "gpt-4.1" }),
      gemini: ProviderBlock.default({ model: "gemini-2.5-pro" }),
      ollama: ProviderBlock.default({ model: "qwen3", baseUrl: "http://localhost:11434/v1" }),
    })
    .default({}),
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
  cfg.workspaceRoot = expandHome(cfg.workspaceRoot);
  fs.mkdirSync(cfg.workspaceRoot, { recursive: true });
  return cfg;
}

export function apiKeyFor(provider: Config["provider"]): string | undefined {
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "gemini":
      return process.env.GEMINI_API_KEY;
    case "ollama":
      return process.env.OLLAMA_API_KEY; // optional for local
  }
}
