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

const REGENERATED_HEADER = `// Rewritten by \`aetheraclaw auth local\`.
// Comments from the shipped default are not preserved by that command — the
// original is always available in src/config/defaults.ts.
`;

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
