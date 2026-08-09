// ── Keeping secrets out of tool output ───────────────────────────────────────
// Storing API keys on disk creates a path that did not exist when they lived
// only in the environment: the agent can read files, and `cat` is on the
// auto-approved list. Before this, `cat ~/.aetheraclaw/credentials.json` ran
// with NO approval prompt and handed four provider keys straight to the model —
// which then puts them in the transcript, the tool-call log, and whatever the
// model says next.
//
// Blocking that one command is not the fix, because the file is not the only
// way to the value: `env`, `grep -r sk-ant ~`, `printenv`, a script that echoes
// it, a stack trace from a failed request with the header attached. Each of
// those is a separate hole and the list has no end.
//
// So the control is at the VALUE, at the single point every tool result passes
// through. If a string equal to a live key would reach the model, it is replaced
// with a marker naming which key it was. That covers every path, including the
// ones nobody thought of, and it degrades safely: the worst case is a false
// positive replacing a string that happened to equal a credential.

/** A secret to scrub, with the name used in its place. */
export interface SecretValue {
  value: string;
  label: string;
}

/**
 * Values shorter than this are not redacted.
 *
 * A short "secret" is either not a real credential or is common enough as
 * ordinary text that scrubbing it would corrupt output — an empty string would
 * match everywhere, and a four-character value would blank out unrelated codes.
 * Every real provider key is far longer than this.
 */
export const MIN_REDACTABLE = 12;

export function redactSecrets(text: string, secrets: SecretValue[]): string {
  let out = text;
  for (const { value, label } of secrets) {
    if (!value || value.length < MIN_REDACTABLE) continue;
    out = out.split(value).join(`[REDACTED:${label}]`);
  }
  return out;
}

/** True when the text contains any of the secrets — for deciding whether to warn. */
export function containsSecret(text: string, secrets: SecretValue[]): boolean {
  return secrets.some((s) => s.value && s.value.length >= MIN_REDACTABLE && text.includes(s.value));
}

/**
 * Paths whose mere mention should escalate a command to needing approval.
 *
 * Belt to redaction's braces, and it does something redaction cannot: it makes
 * the ATTEMPT visible. A model reading the credentials file and getting markers
 * back is contained but silent; an approval prompt naming the file is a person
 * finding out. Matched on the file name rather than the resolved path, because
 * a command may reach it by `~`, by `$HOME`, by a relative path or by a glob,
 * and the name is the part all of those share.
 */
export const SECRET_FILE_NAMES = ["credentials.json", ".env"];

export function mentionsSecretFile(command: string): boolean {
  const lower = command.toLowerCase();
  return SECRET_FILE_NAMES.some((n) => lower.includes(n.toLowerCase()));
}
