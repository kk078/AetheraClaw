import fs from "node:fs";
import path from "node:path";
import { configDir, type ProviderName } from "./config.js";

// ── Provider credentials, entered once and kept ──────────────────────────────
// Until now a key could only arrive as an environment variable, which means
// re-exporting it in every shell, in every terminal, on every reboot — and the
// commonest way people make that stick is to paste the key into a dotfile that
// then gets committed.
//
// WHY THIS IS ITS OWN FILE AND NOT config.json5. Because config.json5 is a file
// people share. In this very project's history the user pasted their whole
// config into a chat window to ask a question about it; had keys lived there,
// they would have pasted four keys along with it. A config that describes how
// the system behaves should stay quotable. Secrets live somewhere you would
// never paste, in a file whose name says what it is.
//
// The file is written 0600 and its permissions are checked on every read, since
// a mode that drifted is the interesting case — a key readable by every account
// on a shared clinic workstation is not protected by having been correct once.

export interface Credential {
  key: string;
  /** When it was stored, so `auth list` can say how old a key is. */
  addedAt: number;
  /** Free text from the user: "billing laptop", "shared clinic key". */
  note?: string;
}

export type CredentialStore = Partial<Record<ProviderName, Credential>>;

export function credentialsPath(): string {
  return path.join(configDir(), "credentials.json");
}

/** Owner read/write only. Anything wider is reported rather than silently fixed. */
export const SECRET_FILE_MODE = 0o600;

export interface LoadResult {
  credentials: CredentialStore;
  /** Non-fatal problems worth telling the user about — bad mode, unreadable file. */
  warnings: string[];
}

export function loadCredentials(file = credentialsPath()): LoadResult {
  const warnings: string[] = [];
  if (!fs.existsSync(file)) return { credentials: {}, warnings };

  // Windows does not model POSIX permissions, so a mode check there reports on
  // the emulation rather than on the file, and would cry wolf on every run.
  if (process.platform !== "win32") {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode !== SECRET_FILE_MODE) {
      warnings.push(
        `${file} is mode ${mode.toString(8)}, not 600 — other accounts on this machine can read your API keys. Fix with: chmod 600 ${file}`,
      );
    }
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CredentialStore;
    // Entries with no key are dropped rather than kept as empty strings, which
    // would otherwise read as "configured" everywhere a truthiness check runs.
    const credentials: CredentialStore = {};
    for (const [name, cred] of Object.entries(parsed)) {
      if (cred && typeof cred.key === "string" && cred.key.trim()) {
        credentials[name as ProviderName] = { ...cred, key: cred.key.trim() };
      }
    }
    return { credentials, warnings };
  } catch (err) {
    // A corrupt credentials file must not stop the app: every provider can also
    // be configured by environment variable, and refusing to boot over this
    // would strand somebody who has a working key in their shell.
    warnings.push(`${file} could not be parsed (${err instanceof Error ? err.message : String(err)}). Ignoring it; environment variables still apply.`);
    return { credentials: {}, warnings };
  }
}

function writeCredentials(store: CredentialStore, file = credentialsPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written to a temp file with the right mode and then renamed, so the key is
  // never briefly on disk as world-readable. `mode` on writeFileSync only
  // applies when the file is CREATED — an existing file keeps its old mode, so
  // the chmod is not redundant.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: SECRET_FILE_MODE });
  fs.chmodSync(tmp, SECRET_FILE_MODE);
  fs.renameSync(tmp, file);
}

export function setCredential(provider: ProviderName, key: string, note?: string, file = credentialsPath()): void {
  const { credentials } = loadCredentials(file);
  credentials[provider] = { key: key.trim(), addedAt: Date.now(), ...(note ? { note } : {}) };
  writeCredentials(credentials, file);
}

export function removeCredential(provider: ProviderName, file = credentialsPath()): boolean {
  const { credentials } = loadCredentials(file);
  if (!credentials[provider]) return false;
  delete credentials[provider];
  writeCredentials(credentials, file);
  return true;
}

/**
 * Show that a key exists without showing the key.
 *
 * Keeps the first four and last four characters: enough to tell two keys apart
 * and to match one against a provider dashboard, not enough to use. Short
 * strings are masked entirely rather than mostly revealed, because the
 * "keep the ends" rule discloses almost everything at eight characters.
 */
export function maskKey(key: string): string {
  if (key.length <= 12) return "*".repeat(Math.max(key.length, 4));
  return `${key.slice(0, 4)}${"*".repeat(8)}${key.slice(-4)}`;
}

/**
 * Prefixes each provider's keys are known to carry.
 *
 * Used to WARN, never to refuse. Providers change their key formats without
 * notice, and a client that rejects a key its own vendor just issued is worse
 * than one that accepts a typo — the typo surfaces on the first call with a
 * clear 401, whereas the refusal has no way out.
 */
export const KEY_PREFIXES: Partial<Record<ProviderName, string[]>> = {
  anthropic: ["sk-ant-"],
  openai: ["sk-"],
  gemini: ["AI"],
};

export function shapeWarning(provider: ProviderName, key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return "The key is empty.";
  if (/\s/.test(trimmed)) return "The key contains a space — check for a copy-paste that picked up a line break.";
  const prefixes = KEY_PREFIXES[provider];
  if (prefixes && !prefixes.some((p) => trimmed.startsWith(p))) {
    return `${provider} keys usually start with ${prefixes.join(" or ")}, and this one does not. Storing it anyway — the provider decides, not this tool.`;
  }
  return null;
}

// ── Resolution ───────────────────────────────────────────────────────────────

export type KeySource = "env" | "file" | "none";

export interface ResolvedKey {
  key?: string;
  source: KeySource;
  /** The environment variable that would carry it, for messages. */
  envVar: string;
}

/**
 * Where a provider's key comes from, and from which of the two places.
 *
 * ENVIRONMENT WINS over the stored file. That order is deliberate: the stored
 * key is the durable default somebody set once, and an environment variable is
 * a per-run override — CI, a different account, a temporary key while rotating.
 * If the file won, an exported key would be silently ignored and the only
 * symptom would be a 401 from a key the user could see was correct.
 */
export function resolveKey(
  provider: ProviderName,
  opts: { env?: NodeJS.ProcessEnv; store?: CredentialStore } = {},
): ResolvedKey {
  const env = opts.env ?? process.env;
  const envVar = provider === "anthropic" ? "ANTHROPIC_API_KEY" : `${provider.toUpperCase()}_API_KEY`;

  const fromEnv = env[envVar];
  if (fromEnv && fromEnv.trim()) return { key: fromEnv.trim(), source: "env", envVar };

  const store = opts.store ?? loadCredentials().credentials;
  const stored = store[provider];
  if (stored?.key) return { key: stored.key, source: "file", envVar };

  return { source: "none", envVar };
}

/** Every secret value this installation knows, for redaction. Values only. */
export function knownSecretValues(opts: { env?: NodeJS.ProcessEnv; store?: CredentialStore } = {}): string[] {
  const providers: ProviderName[] = ["anthropic", "openai", "gemini", "ollama"];
  const out = new Set<string>();
  for (const p of providers) {
    const r = resolveKey(p, opts);
    if (r.key) out.add(r.key);
    // The stored value too, even when an environment variable is winning: the
    // point is to keep the secret out of tool output, and the losing one is
    // still a live credential sitting on this disk.
    const stored = (opts.store ?? loadCredentials().credentials)[p];
    if (stored?.key) out.add(stored.key);
  }
  return [...out];
}

/** The shape of config this needs — kept narrow so it does not drag the whole schema in. */
export interface SecretSourceConfig {
  browser?: { portals?: Array<{ usernameEnv?: string; passwordEnv?: string }> };
  voice?: { authTokenEnv?: string };
}

/**
 * Secrets this installation holds that are NOT provider API keys.
 *
 * The credential store deliberately holds only the four provider keys; the rest
 * — payer-portal logins, the IMAP/SMTP passwords, the voice auth token — are
 * routed through environment variables the config names, because a portal
 * password does not belong in a file people paste into a chat window. But
 * knownSecretValues() cannot see them, so the single-choke-point scrub in the
 * tool registry passed them to the model verbatim the moment a command read the
 * environment (`env`, `printenv`, `grep AETHERACLAW ~/.bashrc`). This closes
 * that: it reads the values the config points at, so the same value-level
 * redaction that covers provider keys covers these too.
 */
export function configuredSecretValues(
  config: SecretSourceConfig,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  const seen = new Set<string>();
  const add = (name: string | undefined, label: string) => {
    if (!name) return;
    const value = env[name]?.trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ value, label });
  };
  for (const portal of config.browser?.portals ?? []) {
    add(portal.passwordEnv, "portal-credential");
    add(portal.usernameEnv, "portal-credential");
  }
  // Named directly (not via config) because transport.ts reads exactly these.
  add("AETHERACLAW_IMAP_PASSWORD", "mail-password");
  add("AETHERACLAW_SMTP_PASSWORD", "mail-password");
  add(config.voice?.authTokenEnv, "auth-token");
  return out;
}
