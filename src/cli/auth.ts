import readline from "node:readline";
import { Writable } from "node:stream";
import type { ProviderName } from "../config/config.js";
import { credentialsPath, loadCredentials, maskKey, resolveKey, setCredential, shapeWarning } from "../config/credentials.js";

// ── Entering a key without leaving it lying around ───────────────────────────
// Three rules shape this file.
//
// The key is never echoed while typing, so it does not end up on a shoulder or
// in a screen recording.
//
// A key given as a command-line ARGUMENT is accepted but warned about, because
// `aetheraclaw auth set openai --key sk-...` lands in ~/.bash_history verbatim.
// Refusing the flag outright would break scripted setup, which is a real need;
// saying nothing would let somebody leak a key while following our own docs.
//
// Nothing here ever prints a key back. `auth list` shows the mask.

export const ALL_PROVIDERS: ProviderName[] = ["anthropic", "openai", "gemini", "ollama"];

/**
 * Read a line with the echo suppressed.
 *
 * Implemented with a Writable that drops everything rather than by toggling raw
 * mode: raw mode has to be restored on every exit path including SIGINT, and a
 * terminal left in raw mode after a Ctrl-C is a broken shell.
 */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;
    const muffled = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: muffled, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = true;
  });
}

export function promptVisible(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export interface SetOutcome {
  stored: boolean;
  messages: string[];
}

/**
 * Store one key, reporting everything worth knowing about it.
 *
 * Pure of I/O prompts: the key arrives already collected, so the decision logic
 * — shape warnings, the environment-shadowing case — is testable without a TTY.
 */
export function evaluateSet(provider: ProviderName, key: string, env: NodeJS.ProcessEnv = process.env): SetOutcome {
  const messages: string[] = [];
  if (!key) return { stored: false, messages: ["No key entered; nothing was stored."] };

  const warn = shapeWarning(provider, key);
  if (warn) messages.push(warn);

  // The trap worth catching: a key is stored, and an environment variable of
  // the same name is already set to something else. The stored key is then
  // ignored on every run and the only symptom is a 401 from a key the user can
  // see is right, in a file they can see is correct.
  const envVar = provider === "anthropic" ? "ANTHROPIC_API_KEY" : `${provider.toUpperCase()}_API_KEY`;
  const shadow = env[envVar];
  if (shadow && shadow.trim() && shadow.trim() !== key) {
    messages.push(
      `${envVar} is also set in this shell, and the environment WINS. Until you unset it, this stored key will not be used: unset ${envVar}`,
    );
  }

  return { stored: true, messages };
}

export function renderList(env: NodeJS.ProcessEnv = process.env): string {
  const { credentials, warnings } = loadCredentials();
  const lines: string[] = [];
  for (const w of warnings) lines.push(`! ${w}`);
  if (warnings.length) lines.push("");

  lines.push(`Credentials file: ${credentialsPath()}`);
  lines.push("");
  lines.push(["provider".padEnd(11), "source".padEnd(8), "key".padEnd(20), "added"].join("  "));

  for (const p of ALL_PROVIDERS) {
    const r = resolveKey(p, { env, store: credentials });
    const stored = credentials[p];
    const source = r.source === "env" ? `env` : r.source === "file" ? "stored" : "—";
    const shown = r.key ? maskKey(r.key) : p === "ollama" ? "(none needed)" : "—";
    const added = r.source === "file" && stored ? new Date(stored.addedAt).toISOString().slice(0, 10) : "";
    lines.push([p.padEnd(11), source.padEnd(8), shown.padEnd(20), added].join("  "));
  }

  lines.push("");
  lines.push("Ollama needs no key when it is a LOCAL server — a key means Ollama Cloud.");
  lines.push("An environment variable always beats a stored key, so a temporary export can override without editing anything.");
  return lines.join("\n");
}

/**
 * Pull whatever keys are already exported into the stored file — "all at once".
 *
 * The migration path for somebody who has been living with `export` lines in a
 * shell profile: it collects them in one command so they can then delete the
 * profile edits, rather than re-typing four keys by hand.
 */
export function importFromEnv(env: NodeJS.ProcessEnv = process.env): { imported: ProviderName[]; skipped: ProviderName[] } {
  const imported: ProviderName[] = [];
  const skipped: ProviderName[] = [];
  for (const p of ALL_PROVIDERS) {
    const envVar = p === "anthropic" ? "ANTHROPIC_API_KEY" : `${p.toUpperCase()}_API_KEY`;
    const v = env[envVar];
    if (v && v.trim()) {
      setCredential(p, v.trim(), "imported from environment");
      imported.push(p);
    } else {
      skipped.push(p);
    }
  }
  return { imported, skipped };
}
