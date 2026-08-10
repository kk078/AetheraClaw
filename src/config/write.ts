import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { configDir } from "./config.js";

// ── Editing config.json5 in place ────────────────────────────────────────────
// `auth local` has to change three fields and leave everything else — including
// every comment in the shipped default — exactly as it was. Re-serialising the
// parsed object would work and would silently delete every comment in the file,
// which is most of what makes that file worth reading.
//
// So the whole object is read, the fields are set, and it is written back with
// a header saying it was rewritten. That still loses comments, which is why the
// header exists: better to say the file was regenerated than to let somebody
// discover their annotations are gone.

export function configPath(): string {
  return path.join(configDir(), "config.json5");
}

function regeneratedHeader(by: string): string {
  return `// Rewritten by ${by}.
// Comments from the shipped default are NOT preserved when this file is
// rewritten — the annotated original is always in src/config/defaults.ts.
`;
}

const REGENERATED_HEADER = regeneratedHeader("`orion auth local`");

/**
 * Point the ollama provider block at a local OpenAI-compatible server.
 *
 * Uses the "ollama" slot rather than inventing a "local" provider because that
 * slot ALREADY carries a baseUrl and is already driven by the OpenAI-compatible
 * adapter. LM Studio and llama.cpp speak the same protocol, so a new provider
 * name would be a second spelling of the code path that already works.
 */
export function writeLocalProvider(baseUrl: string, model: string, file = configPath()): void {
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON5.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      // A config that will not parse is replaced rather than merged into: merging
      // into a broken object would produce a second broken object.
      raw = {};
    }
  }

  const providers = (raw.providers ?? {}) as Record<string, Record<string, unknown>>;
  providers.ollama = { ...(providers.ollama ?? {}), model, baseUrl };
  raw.providers = providers;
  raw.provider = "ollama";

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${REGENERATED_HEADER}${JSON.stringify(raw, null, 2)}\n`);
}

export interface ProviderSettings {
  /** Which provider drives the agent. Omit to leave the active one alone. */
  provider?: string;
  /** Per-provider model, e.g. { anthropic: "claude-opus-5" }. */
  models?: Record<string, string>;
  /** The ollama slot alone carries an endpoint and a separate cloud catalogue. */
  ollama?: { baseUrl?: string; cloudModel?: string };
}

/**
 * Persist what the console's provider screen changed.
 *
 * Exists so a person can set up their own install WITHOUT editing a file by
 * hand or re-exporting a variable in every shell. The key was already
 * enterable in the console; the model, the endpoint and which provider is
 * actually active were not, so anyone sharing this repo still had to talk
 * somebody through a text editor.
 *
 * A field that is absent is LEFT ALONE rather than reset to a default. This is
 * a patch, not a rewrite: the screen sends only what it changed, and a
 * whole-object write would silently drop settings the screen does not show.
 */
export function writeProviderSettings(patch: ProviderSettings, file = configPath()): void {
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON5.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      raw = {};
    }
  }

  const providers = (raw.providers ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, model] of Object.entries(patch.models ?? {})) {
    if (!model.trim()) continue;
    providers[name] = { ...(providers[name] ?? {}), model: model.trim() };
  }
  if (patch.ollama) {
    const slot = { ...(providers.ollama ?? {}) };
    if (patch.ollama.baseUrl !== undefined) slot.baseUrl = patch.ollama.baseUrl.trim();
    // An empty cloudModel is REMOVED rather than stored as "": the resolver
    // falls back to `model` when it is absent, and an empty string would be a
    // model name the cloud has never heard of.
    if (patch.ollama.cloudModel !== undefined) {
      const v = patch.ollama.cloudModel.trim();
      if (v) slot.cloudModel = v;
      else delete slot.cloudModel;
    }
    providers.ollama = slot;
  }
  raw.providers = providers;
  if (patch.provider) raw.provider = patch.provider;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Names the actual writer. A header blaming `auth local` for a change made on
  // the Providers screen sends the next reader looking in the wrong place.
  fs.writeFileSync(
    file,
    `${regeneratedHeader('the "Providers & keys" screen in the console')}${JSON.stringify(raw, null, 2)}\n`,
  );
}
