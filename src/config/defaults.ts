export const DEFAULT_CONFIG_JSON5 = `{
  // AetheraClaw configuration. Env vars override values here.
  // API keys are read from the environment: ANTHROPIC_API_KEY, OPENAI_API_KEY,
  // GEMINI_API_KEY, OLLAMA_API_KEY (Ollama Cloud only).

  // Which model provider drives the agent: "anthropic" | "openai" | "gemini" | "ollama"
  provider: "anthropic",

  providers: {
    anthropic: { model: "claude-opus-5" },
    openai: { model: "gpt-4.1" },
    gemini: { model: "gemini-2.5-pro" },
    // baseUrl "http://localhost:11434/v1" for local Ollama, "https://ollama.com/v1" for Ollama Cloud
    ollama: { model: "qwen3", baseUrl: "http://localhost:11434/v1" },
  },

  // All shell commands and file operations are confined to this directory.
  workspaceRoot: "~/aetheraclaw-workspace",

  // "always" = every tool needs approval; "unsafe-only" = read-only ops auto-approved;
  // "never" = no approvals (NOT recommended).
  approvalPolicy: "unsafe-only",

  gateway: { host: "127.0.0.1", port: 4180 },

  maxTokens: 64000,
  contextTokenBudget: 150000,
  shell: { defaultTimeoutS: 30, maxOutputKb: 50 },

  healthcare: {
    // Path to a user-supplied licensed CPT/fee-schedule CSV (CPT is AMA-licensed and not bundled).
    // cptDataPath: "/path/to/cpt.csv",
    clearinghouse: "mock",
  },

  swarm: { mode: "off" }, // "off" | "assist" | "autopilot-with-checkpoints"
}
`;
