import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Surviving the rename ─────────────────────────────────────────────────────
// The application was called AetheraClaw and is now called Orion. A rename is
// cheap in source and expensive on disk: the old name is not only in the code,
// it is in the environment variables an operator has already exported, in the
// directory holding their configuration, and in the FILENAME of the database
// holding their claims, documents and audit log.
//
// A rename that ignores that does not fail loudly. It starts, finds no database
// where the new name says one should be, CREATES AN EMPTY ONE, and presents a
// practice with a clean slate where their receivables used to be. The data is
// still on disk the whole time, under the old name, which is the detail that
// makes it look like data loss to the person it happens to.
//
// So both names are honoured, old as a fallback, and the old one is never
// written to — an install that keeps using it keeps working, and a new install
// never creates one.

/** What the product is called now, lower-cased, as it appears on disk. */
export const APP_DIR_NAME = "orion";
/** What it used to be called. Read, never written. */
export const LEGACY_DIR_NAME = "aetheraclaw";

const ENV_PREFIX = "ORION_";
const LEGACY_ENV_PREFIX = "AETHERACLAW_";

/**
 * Read a setting from the environment under either name.
 *
 * `suffix` is the part after the prefix: `readEnv("HOME")` reads ORION_HOME and
 * falls back to AETHERACLAW_HOME. The new name wins when both are set, so an
 * operator migrating can export the new one and delete the old one afterwards
 * rather than having to do both at the same moment.
 */
export function readEnv(suffix: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const next = env[ENV_PREFIX + suffix];
  if (next !== undefined && next !== "") return next;
  const legacy = env[LEGACY_ENV_PREFIX + suffix];
  if (legacy !== undefined && legacy !== "") return legacy;
  return undefined;
}

/** Names read but no longer documented, for the startup notice. */
export function legacyEnvNamesInUse(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((k) => k.startsWith(LEGACY_ENV_PREFIX) && (env[k] ?? "") !== "")
    .filter((k) => (env[ENV_PREFIX + k.slice(LEGACY_ENV_PREFIX.length)] ?? "") === "")
    .sort();
}

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Where configuration and data live.
 *
 * An explicit environment setting wins under either name. With neither set the
 * new directory is used — UNLESS it does not exist and the old one does, which
 * is exactly the shape of an install that predates the rename. That install
 * keeps its directory; nothing is moved, copied or migrated behind anyone's
 * back, because a migration that runs unattended over the only copy of a
 * practice's claims is not a convenience.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = readEnv("HOME", env);
  if (explicit) return expandTilde(explicit);
  const next = path.join(os.homedir(), `.${APP_DIR_NAME}`);
  if (fs.existsSync(next)) return next;
  const legacy = path.join(os.homedir(), `.${LEGACY_DIR_NAME}`);
  if (fs.existsSync(legacy)) return legacy;
  return next;
}

/**
 * The database file inside a given directory.
 *
 * Same rule, one level down, and needed separately: an operator who sets
 * ORION_HOME to their existing directory still has a file in it called
 * `aetheraclaw.db`. Resolving the directory correctly and then opening the
 * wrong filename inside it creates the empty database this module exists to
 * prevent.
 */
export function resolveDbFile(dir: string): string {
  const next = path.join(dir, `${APP_DIR_NAME}.db`);
  if (fs.existsSync(next)) return next;
  const legacy = path.join(dir, `${LEGACY_DIR_NAME}.db`);
  if (fs.existsSync(legacy)) return legacy;
  return next;
}

/**
 * One line for the startup banner when anything legacy is still in play.
 *
 * Empty when there is nothing to say. This is deliberately a notice and not a
 * warning: continuing to use the old names is supported, not a fault, and
 * crying wolf about a working install teaches people to ignore the banner.
 */
export function legacyNotice(home: string, dbFile: string, env: NodeJS.ProcessEnv = process.env): string {
  const parts: string[] = [];
  if (path.basename(home) === `.${LEGACY_DIR_NAME}`) parts.push(`data directory ${home}`);
  if (path.basename(dbFile) === `${LEGACY_DIR_NAME}.db`) parts.push(`database ${path.basename(dbFile)}`);
  const envNames = legacyEnvNamesInUse(env);
  if (envNames.length > 0) parts.push(`${envNames.join(", ")}`);
  if (parts.length === 0) return "";
  return `Using pre-rename names (${parts.join("; ")}). These still work and nothing needs doing; rename them to the ORION_ prefix when convenient.`;
}
