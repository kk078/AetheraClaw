#!/usr/bin/env node
// ── One command to take a fresh clone to a running install ───────────────────
// The README's quick start is four commands plus two data steps, and the two
// data steps are the ones people skip — then wonder why NCCI bundling reports
// itself as unavailable. This runs everything that CAN be automated and then
// says plainly what is left, rather than exiting 0 on a half-configured install.
//
// It also provisions the prerequisites that `npm install` does NOT bring with
// it. Two of them are real and both fail late and confusingly:
//
//   * Playwright's Chromium. `playwright` is a normal dependency, so the module
//     installs and `import("playwright")` resolves — but the browser binary is a
//     separate ~170 MB download that is skipped entirely whenever
//     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set, which CI images and corporate
//     images routinely set. The first symptom is a portal tool failing at run
//     time, hours after the install that looked clean.
//   * A working SQLite driver. better-sqlite3 is optional and node:sqlite is the
//     fallback, so nothing breaks — but which one you got is worth KNOWING, not
//     discovering from a transaction that behaves differently.
//
// What it deliberately does NOT do: install Node itself, ask for an API key, or
// copy a licensed reference database. Installing a runtime needs root and
// replaces something the rest of the machine depends on; a setup script that
// prompts for a secret encourages pasting one into a terminal somebody is
// screen-sharing, and `auth set` already does it properly. Each is reported as
// remaining work with the exact command.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHome } from "./lib/home.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const skipData = args.has("--skip-data");
const skipTests = args.has("--skip-tests");
const skipBrowser = args.has("--skip-browser");

/** Kept in step with `engines.node` in package.json. */
const REQUIRED_NODE_MAJOR = 22;
const REQUIRED_NODE_MINOR = 5;

const steps = [];
/** Things that are missing, that this script cannot fix, and how to fix them. */
const remaining = [];
let failed = false;

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const amber = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

function heading(text) {
  console.log(`\n${bold(text)}`);
}

/**
 * Run a command, recording it as a step.
 *
 * `fatal: false` for anything whose absence degrades the install rather than
 * breaking it — a dataset that will not download, a browser that will not
 * install. Those must not stop the run, because the rest of the system works
 * without them and stopping would leave the user with nothing.
 */
function run(label, command, opts = {}) {
  const { fatal = true, ...spawnOpts } = opts;
  process.stdout.write(`  ${label} … `);
  const started = Date.now();
  const r = spawnSync(command, { cwd: root, shell: true, stdio: "pipe", encoding: "utf8", ...spawnOpts });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.status === 0) {
    console.log(`${green("ok")} (${secs}s)`);
    steps.push({ label, ok: true });
    return { ok: true, stdout: r.stdout ?? "" };
  }
  console.log(`${fatal ? red("FAILED") : amber("skipped")} (${secs}s)`);
  // The tail, not the whole log: a failed tsc prints hundreds of lines and the
  // useful part is at the end, but a wall of output buries the summary below.
  for (const line of `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd().split("\n").slice(-15)) {
    console.log(`      ${line}`);
  }
  if (fatal) {
    steps.push({ label, ok: false });
    failed = true;
  } else {
    steps.push({ label, ok: false, soft: true });
  }
  return { ok: false, stdout: r.stdout ?? "" };
}

function which(cmd) {
  const probe = process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`;
  return spawnSync(probe, { shell: true, stdio: "pipe", encoding: "utf8" }).status === 0;
}

// ── 1. Prerequisites the machine must already have ───────────────────────────

heading("Prerequisites");

const [major, minor] = process.versions.node.split(".").map(Number);
const nodeOk = major > REQUIRED_NODE_MAJOR || (major === REQUIRED_NODE_MAJOR && minor >= REQUIRED_NODE_MINOR);
console.log(`  node          ${process.versions.node} ${nodeOk ? green("ok") : red(`too old — ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}+ required`)}`);

if (!nodeOk) {
  // Not installed automatically, and not for want of trying: every route needs
  // root and replaces a runtime the rest of the machine may depend on. So the
  // exact command for THIS machine, and a stop — every later step would fail in
  // a way that pointed at the wrong thing.
  console.log(`\n  Orion needs Node ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR} or newer. On ${process.platform}:\n`);
  // Version-manager routes first, and not only because they are convenient:
  // they need no root and leave the system node alone, which is the difference
  // between "run this" and "run this and hope nothing else on the box cared".
  const v = REQUIRED_NODE_MAJOR;
  const NVM_INSTALL = "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash";
  if (process.env.NVM_DIR || fs.existsSync(path.join(os.homedir(), ".nvm"))) {
    console.log(`      nvm install ${v} && nvm use ${v}        # nvm is already on this machine`);
  } else if (which("fnm")) {
    console.log(`      fnm install ${v} && fnm use ${v}        # fnm is already on this machine`);
  } else if (which("volta")) {
    console.log(`      volta install node@${v}               # volta is already on this machine`);
  } else if (process.platform === "darwin") {
    console.log(`      brew install node@${v}`);
    console.log("      # or, without admin rights and without touching the system node:");
    console.log(`      ${NVM_INSTALL}`);
    console.log(`      nvm install ${v}`);
  } else if (process.platform === "win32") {
    console.log("      winget install OpenJS.NodeJS.LTS");
    console.log(`      # confirm it is ${v}.x or newer — the LTS alias moves over time`);
  } else {
    console.log(`      ${NVM_INSTALL}`);
    console.log(`      nvm install ${v}                      # no root needed`);
    console.log("      # or use your distribution's nodesource package if you prefer a system install");
  }
  console.log("\n  Then run `npm run setup` again. Nothing has been changed.");
  process.exit(1);
}

// npm ships with Node, so its absence means a broken or partial install rather
// than a missing package — worth naming precisely instead of failing at `npm ci`.
const npmVersion = spawnSync("npm --version", { shell: true, stdio: "pipe", encoding: "utf8" });
if (npmVersion.status === 0) {
  console.log(`  npm           ${npmVersion.stdout.trim()} ${green("ok")}`);
} else {
  console.log(`  npm           ${red("not found")}`);
  console.log("\n  npm ships with Node, so this points at a partial Node install. Reinstall Node and run this again.");
  process.exit(1);
}

console.log(`  platform      ${process.platform}/${process.arch}`);

// A compiler is NOT a prerequisite and saying so here saves people installing
// one pre-emptively — the whole point of the node:sqlite fallback.
console.log(`  C++ toolchain ${amber("not required")} — better-sqlite3 is optional; node:sqlite is the fallback`);

// ── 2. Dependencies and build ────────────────────────────────────────────────

heading("Build");

// `npm ci` is exact and fast but requires the lockfile to match package.json.
// Falling back rather than failing: a contributor mid-edit should still be able
// to run this.
const hasLock = fs.existsSync(path.join(root, "package-lock.json"));
run("install dependencies", hasLock ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund");
run("compile TypeScript", "npm run build");

// tsc exiting 0 means the types check, not that the output runs. This loads the
// whole CLI import graph — every tool module, every provider — which is where a
// bad ESM specifier or a missing copied asset actually shows up.
if (!failed) run("verify the CLI starts", "node dist/cli/index.js --help");

if (!skipTests) {
  // The suite is fully offline — no keys, no network, no database — so a green
  // run here proves the checkout is sound before any provider is configured.
  run("run the test suite", "npm test");
} else {
  console.log(`  run the test suite … ${amber("skipped")} (--skip-tests)`);
}

// ── 3. Runtime components npm install does not bring ─────────────────────────

heading("Runtime components");

const require_ = createRequire(path.join(root, "package.json"));

// Which SQLite driver actually resolved. Both work; the point is that it is
// stated once here rather than inferred later from a behaviour difference.
try {
  require_("better-sqlite3");
  console.log(`  sqlite driver     ${green("better-sqlite3")} (prebuilt binary available for this platform)`);
} catch {
  console.log(`  sqlite driver     ${green("node:sqlite")} (better-sqlite3 has no prebuilt binary here — this is expected and fine)`);
}

// Playwright's browser. The npm package installing successfully says nothing
// about whether the binary is there, and — measured, not assumed — the presence
// of `chromium.executablePath()` does not say so either: a HEADLESS launch runs
// `chrome-headless-shell`, a separate download. A check on executablePath alone
// reported "installed" for a tree whose headless shell was missing, so the only
// honest test is to launch the thing.
//
// Hence: launch is the authority, and a failure triggers the install rather than
// merely reporting it. `existsSync` is used once, as a cheap way to skip a
// pointless launch attempt, and never as the answer.

/** Launch headless and close again. Returns the error text, or "" on success. */
function probeBrowser() {
  const src = `
    import("playwright")
      .then(({ chromium }) => chromium.launch({ headless: true }))
      .then((b) => b.close())
      .then(() => process.exit(0))
      .catch((e) => { console.error(String(e && e.message ? e.message : e)); process.exit(1); });
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
    timeout: 120_000,
  });
  if (r.status === 0) return "";
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return text || `playwright exited ${r.status}${r.signal ? ` (${r.signal})` : ""}`;
}

function executablePresent() {
  try {
    const p = require_("playwright").chromium.executablePath();
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}

if (skipBrowser) {
  console.log(`  portal browser    ${amber("skipped")} (--skip-browser)`);
} else {
  // Not fatal at any point below. The portal tools are one module of many; every
  // other capability works without a browser, and a blocked download must not
  // cost somebody the rest of a working install.
  let installed = false;
  if (!executablePresent()) {
    console.log(`  portal browser    ${amber("missing")} — downloading Chromium (~170 MB, once per machine)`);
    installed = run("download Chromium", "npx --yes playwright install chromium", { fatal: false }).ok;
  }

  process.stdout.write("  launch Chromium … ");
  let err = probeBrowser();

  if (err && !installed) {
    // Reached when the executable was present but the launch still failed — a
    // partial browser tree, or a headless shell that was never downloaded.
    // Worth one install before giving up, because it is the fix in both cases.
    console.log(amber("retrying after install"));
    run("download Chromium", "npx --yes playwright install chromium", { fatal: false });
    process.stdout.write("  launch Chromium … ");
    err = probeBrowser();
  }

  if (!err) {
    console.log(green("ok"));
    steps.push({ label: "portal browser ready", ok: true });
  } else {
    console.log(amber("cannot launch"));
    for (const line of err.split("\n").slice(0, 6)) console.log(`      ${line}`);
    steps.push({ label: "portal browser ready", ok: false, soft: true });
    // `--with-deps` runs a package manager as root. That is the user's call to
    // make knowingly, not something a setup script should do behind them.
    remaining.push(
      process.platform === "linux"
        ? [
            "Chromium will not start — on Linux it needs system libraries no npm package can supply.",
            "    sudo npx playwright install --with-deps chromium",
            "    Only payer-portal browsing is affected; everything else works without it.",
          ]
        : [
            "Chromium will not start. Reinstall it with:",
            "    npx playwright install chromium",
            "    Only payer-portal browsing is affected; everything else works without it.",
          ],
    );
  }
}

// ── 4. Reference data ────────────────────────────────────────────────────────

heading("CMS reference data");

// Shared with the gateway's own resolution so the two cannot disagree about
// which directory the install lives in — see scripts/lib/home.mjs.
const home = resolveHome();
const dataDir = path.join(home, "data");
const present = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter((f) => f.endsWith(".json")) : [];
// The datasets a complete fetch writes (mpfs-cf.json is conditional on the RVU
// file carrying a conversion factor, so it is not required). Checking by NAME,
// not by a count of `.json` files: a `>= 6` count let a run that fetched six but
// 403'd on the ICD-10 zip look complete, so a re-run never retried the one that
// mattered — the most-used offline lookup stayed missing on a machine set up twice.
const REQUIRED_DATASETS = ["ncci-ptp.json", "mue.json", "mpfs.json", "gpci.json", "hcpcs.json", "icd10.json"];
const missingDatasets = REQUIRED_DATASETS.filter((f) => !present.includes(f));

if (skipData) {
  console.log(`  ${amber("skipped")} (--skip-data)`);
} else if (missingDatasets.length === 0) {
  console.log(`  ${present.length} dataset file(s) already installed in ${dataDir} — leaving them alone.`);
  console.log("  Re-fetch with: node scripts/fetch-cms-data.mjs");
} else {
  if (present.length > 0) console.log(`  ${amber(`missing: ${missingDatasets.join(", ")}`)} — fetching the rest`);
  console.log(`  fetching into ${dataDir} (needs network, ~25s)`);
  // Not fatal. A machine behind a proxy that blocks CMS still has a working
  // install; the affected tools report themselves as unavailable rather than
  // answering wrongly, which is the whole design of the dataset layer.
  const r = spawnSync("node", ["scripts/fetch-cms-data.mjs"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`\n  ${amber("Datasets did not download.")} The install still works — NCCI, MUE and pricing`);
    console.log("  checks will report themselves as not installed rather than guessing. Retry later with:");
    console.log("      node scripts/fetch-cms-data.mjs");
  }
}

// ── 5. What is still needed ──────────────────────────────────────────────────

heading("Configuration");

let credentials = {};
try {
  credentials = JSON.parse(fs.readFileSync(path.join(home, "credentials.json"), "utf8"));
} catch {
  credentials = {};
}
const envKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OLLAMA_API_KEY"].filter((v) => process.env[v]);
const configured = new Set([...Object.keys(credentials), ...envKeys.map((v) => v.replace("_API_KEY", "").toLowerCase())]);

if (configured.size > 0) {
  console.log(`  provider key(s):    ${green([...configured].join(", "))}`);
} else {
  console.log(`  provider key(s):    ${amber("none")}`);
  remaining.push([
    "Add a provider, or point at a local model that needs no key:",
    "    node dist/cli/index.js auth set --all       # hidden prompts",
    "    node dist/cli/index.js auth discover        # find a local server instead",
  ]);
}

const managedRef = path.join(home, "reference", "reference.db");
if (fs.existsSync(managedRef)) {
  const gb = (fs.statSync(managedRef).size / 1024 ** 3).toFixed(2);
  console.log(`  reference database: ${green("installed")} (${gb} GB)`);
} else {
  console.log(`  reference database: ${amber("not installed")} (optional)`);
  remaining.push([
    "Attach a reference code database if you have one — it is licensed content and is never committed:",
    "    node dist/cli/index.js reference install <path-to.db>",
  ]);
}

// ── Summary ──────────────────────────────────────────────────────────────────

heading(failed ? "Setup did NOT complete" : "Ready");

for (const s of steps) {
  const mark = s.ok ? green("✓") : s.soft ? amber("○") : red("✗");
  console.log(`  ${mark} ${s.label}`);
}

if (failed) {
  console.log("\nFix the failure above and run `npm run setup` again. It is safe to re-run.");
  process.exit(1);
}

if (remaining.length > 0) {
  console.log(`\n${bold("Still to do")}`);
  for (const block of remaining) for (const line of block) console.log(`  ${line}`);
}

console.log(`\n${bold("Start it")}`);
console.log("  npm start                          # http://127.0.0.1:4180");
console.log("\nCheck what this install can actually do:");
console.log("  node dist/cli/index.js providers    # keys, models, effective tool caps");
console.log("  node dist/cli/index.js tools budget # what raising the tool cap costs in context");
