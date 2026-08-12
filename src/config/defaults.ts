export const DEFAULT_CONFIG_JSON5 = `{
  // Orion configuration. Env vars override values here.
  // API keys are read from the environment: ANTHROPIC_API_KEY, OPENAI_API_KEY,
  // GEMINI_API_KEY, OLLAMA_API_KEY (Ollama Cloud only).

  // Which model provider drives the agent: "anthropic" | "openai" | "gemini" | "ollama"
  //
  // This is a PREFERENCE, not a requirement. If the named provider's key is not
  // in the environment, Orion uses whichever provider's key IS present and
  // says so at startup — it will not refuse to run and tell you to go and get a
  // key for a provider you did not choose. Pass --provider to pin one for a
  // single run; an explicit --provider is never substituted.
  provider: "anthropic",

  providers: {
    anthropic: { model: "claude-opus-5" },
    openai: { model: "gpt-4.1" },
    gemini: { model: "gemini-2.5-pro" },
    // baseUrl "http://localhost:11434/v1" for local Ollama, "https://ollama.com/v1" for Ollama Cloud
    ollama: { model: "qwen3", baseUrl: "http://localhost:11434/v1" },
  },

  // All shell commands and file operations are confined to this directory.
  workspaceRoot: "~/orion-workspace",

  // "always" = every tool needs approval; "unsafe-only" = read-only ops auto-approved;
  // "never" = no approvals (NOT recommended).
  approvalPolicy: "unsafe-only",

  // Whether the agent can pause a turn to ask a clarifying question (the
  // ask_user tool) instead of guessing at an ambiguous request. An unanswered
  // question times out after timeoutMs and the agent is told plainly, rather
  // than left waiting.
  // clarify: { enabled: true, timeoutMs: 120000 },

  gateway: { host: "127.0.0.1", port: 4180 },

  maxTokens: 64000,
  contextTokenBudget: 150000,
  shell: { defaultTimeoutS: 30, maxOutputKb: 50 },

  healthcare: {
    // Path to a user-supplied licensed CPT/fee-schedule CSV (CPT is AMA-licensed and not bundled).
    // cptDataPath: "/path/to/cpt.csv",
    // A SQLite reference database you already own. Read in place, read-only, never
    // copied. Run "node scripts/inspect-db.mjs <path>" first to see what is in it.
    // referenceDbPath: "/path/to/reference.db",
    // Tables to read even though their columns look like patient identifiers.
    // referenceDbAllowTables: [],
    // Licensed code sets in that database you have confirmed you may read.
    // "cpt" reads CPT descriptors, which are copyright the AMA.
    // referenceDbLicensedRoles: [],
    clearinghouse: "mock",
    // "sandbox" or "production" — separate from the connector choice on
    // purpose. Production means real claims to real payers.
    clearinghouseEnv: "sandbox",
    // "education" or "production". Production refuses anything that might
    // identify a patient rather than guessing, requires an acknowledgment per
    // uploaded file, and tells the model it is working on real records.
    // Separate from ORION_PHI, which decides whether PHI may be STORED at all.
    phiMode: "education",
    // Days to keep extracted document text. 0 keeps it indefinitely.
    // Set this to the practice's retention period once there is real data.
    documentRetentionDays: 0,
  },

  // Email channel. Disabled until a mailbox is configured; passwords come from
  // ORION_IMAP_PASSWORD / ORION_SMTP_PASSWORD, never from this file.
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
      //   usernameEnv: 'ORION_PORTAL_AVAILITY_USER',
      //   passwordEnv: 'ORION_PORTAL_AVAILITY_PASSWORD',
      // },
    ],
    headless: true,
    navigationTimeoutMs: 30000,
    executablePath: '',   // set when the host ships its own Chromium
    redactPhi: true,
  },

  swarm: { mode: "off" }, // "off" | "assist" | "autopilot-with-checkpoints"

  // Talking to Orion at your desk. Distinct from 'voice' above, which is
  // the telephony carrier used to call payers.
  speech: {
    enabled: false,
    // "browser" needs nothing installed, but Chrome sends the audio to Google.
    // "local" runs whisper.cpp + Piper here and nothing leaves the machine.
    // "cloud" is fastest and most natural, and ships audio to a vendor.
    engine: "browser",
    // "push-to-talk" (hold the mic, or Ctrl+Space) or "always-on" with a wake word.
    mode: "push-to-talk",
    wakeWord: "hey aethera",
    speakReplies: true,
    maxSpokenChars: 1200,
    // local: { whisperBin: 'whisper-cli', whisperModel: '/path/ggml-base.en.bin',
    //          piperBin: 'piper', piperVoice: '/path/en_US-amy-medium.onnx' },
    // cloud: { sttVendor: 'openai', ttsVendor: 'openai', ttsVoice: 'alloy',
    //          sttKeyEnv: 'OPENAI_API_KEY', ttsKeyEnv: 'OPENAI_API_KEY' },
    consent: { requireAcknowledgement: true, retainAudio: false },
  },
}
`;
