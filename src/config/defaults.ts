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

  // Email channel. Disabled until a mailbox is configured; passwords come from
  // AETHERACLAW_IMAP_PASSWORD / AETHERACLAW_SMTP_PASSWORD, never from this file.
  email: {
    enabled: false,
    imap: { host: '', port: 993, secure: true, user: '', mailbox: 'INBOX' },
    smtp: { host: '', port: 587, secure: false, user: '', from: '' },
    pollSeconds: 300,
    maxPerPoll: 25,
    fromFilters: [],          // e.g. ['medicare', 'availity'] to ignore everything else
    quarantinePhi: true,      // hold mail carrying identifier-shaped text
    sessionId: '',            // session new correspondence is delivered into
  },

  // Payer portal automation. Navigation is confined to the origins listed here,
  // and credentials are named by ENVIRONMENT VARIABLE only — no secret in this file.
  browser: {
    portals: [
      // {
      //   key: 'availity',
      //   label: 'Availity Essentials',
      //   origins: ['https://apps.availity.com'],   // include any SSO host it redirects through
      //   loginUrl: 'https://apps.availity.com/web/onboarding/availity-fr-ui/',
      //   usernameSelector: '#userId',
      //   passwordSelector: '#password',
      //   submitSelector: 'button[type=submit]',
      //   signedInSelector: '#dashboard',           // exists only once signed in
      //   usernameEnv: 'AETHERACLAW_PORTAL_AVAILITY_USER',
      //   passwordEnv: 'AETHERACLAW_PORTAL_AVAILITY_PASSWORD',
      // },
    ],
    headless: true,
    navigationTimeoutMs: 30000,
    executablePath: '',   // set when the host ships its own Chromium
    redactPhi: true,
  },

  swarm: { mode: "off" }, // "off" | "assist" | "autopilot-with-checkpoints"
}
`;
