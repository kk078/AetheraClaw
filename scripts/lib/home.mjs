import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Where the data lives, for the scripts ────────────────────────────────────
// A deliberate duplicate of resolveHome() in src/config/legacy.ts. It is
// duplicated rather than imported because these scripts run BEFORE a build
// exists — `npm start` on a fresh clone compiles the TypeScript, so importing
// dist/ from the thing that produces dist/ is a bootstrap it cannot satisfy.
//
// Keeping them in step matters more than the duplication costs. The two
// disagreeing is not cosmetic: the gateway read its data from the pre-rename
// directory while `npm start` looked in the new one, reported the 30 MB of
// CMS reference data as MISSING, and pointed at `npm run setup` — which would
// have downloaded a second copy into the other directory and left the install
// split across two, with lookups reading one and the fetcher writing the other.

const APP_DIR_NAME = "orion";
const LEGACY_DIR_NAME = "aetheraclaw";

function expandTilde(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** ORION_HOME, then AETHERACLAW_HOME, then whichever directory exists. */
export function resolveHome(env = process.env) {
  const explicit = env.ORION_HOME || env.AETHERACLAW_HOME;
  if (explicit) return path.resolve(expandTilde(explicit));
  const next = path.join(os.homedir(), `.${APP_DIR_NAME}`);
  if (fs.existsSync(next)) return next;
  const legacy = path.join(os.homedir(), `.${LEGACY_DIR_NAME}`);
  if (fs.existsSync(legacy)) return legacy;
  return next;
}
