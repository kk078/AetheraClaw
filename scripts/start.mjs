#!/usr/bin/env node
// ── One command from a bare clone to a running gateway ───────────────────────
// `npm run setup` exists for the FULL install — tests, Chromium, ~30 MB of CMS
// data. This is the other half: the shortest honest path from `git clone` to a
// gateway you can open in a browser. It installs what is missing, builds what
// is stale, and then gets out of the way.
//
// Two rules shape everything below.
//
//   * Every step is skipped when it is already satisfied. A start command that
//     reinstalls or rebuilds on every run stops being a start command — people
//     go back to typing `node dist/cli/index.js serve` to avoid the wait, and
//     then the stale-build case is back. The second run must print five lines
//     and start.
//   * Nothing large or surprising happens implicitly. The browser download
//     (~170 MB) and the CMS datasets (~30 MB) belong to `npm run setup`, which
//     the user chose to run. A `npm start` that silently pulls two hundred
//     megabytes on a hotel connection is a bug, however convenient it looks in
//     the happy case. Both are REPORTED here with the command that fixes them.
//
// It also does not stop for a missing provider key. That is the point of the
// in-app settings page: the gateway starts, the browser opens, and the key is
// entered there. Refusing to boot over it would send people back to the CLI for
// the one step the UI was built to own.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHome } from "./lib/home.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const amber = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function heading(text) {
  console.log(`\n${bold(text)}`);
}

/** `  label        value` — the aligned two-column form `npm run setup` uses. */
function status(label, value) {
  console.log(`  ${label.padEnd(12)}  ${value}`);
}

// ── Arguments ────────────────────────────────────────────────────────────────
// Only two flags are ours; everything else is forwarded verbatim to `serve`, so
// `npm start -- --port 4200 --provider ollama` works without this script having
// to know what those options mean. Parsing them here would mean re-implementing
// commander's option list and getting it wrong the next time one changes.

const argv = process.argv.slice(2);
const skipBuild = argv.includes("--skip-build");
const wantsHelp = argv.includes("--help") || argv.includes("-h");
const serveArgs = argv.filter((a) => a !== "--skip-build");

if (wantsHelp) {
  console.log(`${bold("npm start")} — install, build if needed, then run the gateway.

  npm start                                 check, build if stale, serve
  npm start -- --port 4200                  any \`serve\` option, forwarded
  npm start -- --provider ollama --host 0.0.0.0
  npm start -- --skip-build                 serve whatever is already in dist/

Checks, each skipped when already satisfied:

  node          ${bold("hard stop")} if too old — every later step would fail confusingly
  dependencies  npm ci (or npm install) only when node_modules/ is absent
  build         npm run build only when dist/ is missing or older than src/
  datasets      reported, never downloaded — that is \`npm run setup\`
  provider      reported, never prompted — set it in the app, under "Providers & keys"

Options handled here (everything else goes to \`serve\`):
  --skip-build  do not compile, even if src/ is newer than dist/
  --help, -h    this text

For the full install — test suite, Chromium for payer portals, CMS reference
data — run \`npm run setup\` instead. It is safe to run at any time.`);
  process.exit(0);
}

heading("Starting Orion");

// ── 1. Node ──────────────────────────────────────────────────────────────────
// The one hard stop. Everything after this — npm ci, tsc, the gateway's own
// imports — fails on an old Node with an error about syntax or a missing
// builtin, which sends people looking in the wrong place entirely.
//
// The required version is read from `engines.node` rather than written down
// again. scripts/setup.mjs keeps its constants "in step with engines.node in
// package.json"; a second hand-maintained copy is a second thing to forget, and
// the failure mode of drift is this script waving through a Node that setup
// rejects (or the reverse).

function requiredNode() {
  const fallback = { major: 22, minor: 5 };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const m = /(\d+)(?:\.(\d+))?/.exec(String(pkg.engines?.node ?? ""));
    if (!m) return fallback;
    return { major: Number(m[1]), minor: Number(m[2] ?? 0) };
  } catch {
    // A package.json this script cannot read is a broken checkout, not a reason
    // to skip the version gate — fall back to the known-good pair.
    return fallback;
  }
}

const need = requiredNode();
const [major, minor] = process.versions.node.split(".").map(Number);
const nodeOk = major > need.major || (major === need.major && minor >= need.minor);
status("node", `${process.versions.node} ${nodeOk ? green("ok") : red(`too old — ${need.major}.${need.minor}+ required`)}`);

if (!nodeOk) {
  // Not installed automatically, and not for want of trying: every route needs
  // root and replaces a runtime the rest of the machine may depend on. So the
  // exact command for THIS machine, and a stop.
  console.log(`\n  Orion needs Node ${need.major}.${need.minor} or newer. On ${process.platform}:\n`);
  // Version-manager routes first, and not only because they are convenient:
  // they need no root and leave the system node alone, which is the difference
  // between "run this" and "run this and hope nothing else on the box cared".
  const v = need.major;
  const NVM_INSTALL = "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash";
  const which = (cmd) => {
    const probe = process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`;
    return spawnSync(probe, { shell: true, stdio: "pipe", encoding: "utf8" }).status === 0;
  };
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
  console.log("\n  Then run `npm start` again. Nothing has been changed.");
  process.exit(1);
}

// ── 2. Dependencies ──────────────────────────────────────────────────────────

/**
 * Run a command with its output on the terminal, and stop on failure.
 *
 * stdio is inherited on purpose: `npm ci` and `tsc` are the two steps here that
 * take minutes, and a progress bar the user can see is the difference between
 * "it is working" and "it has hung". Capturing them to print a tail afterwards,
 * as setup.mjs does for its many short steps, would buy a tidier log at the
 * cost of a silent two-minute pause on the very first run.
 */
function run(command, env = {}) {
  const r = spawnSync(command, { cwd: root, shell: true, stdio: "inherit", env: { ...process.env, ...env } });
  return r.status === 0;
}

const nodeModules = path.join(root, "node_modules");
if (fs.existsSync(nodeModules)) {
  status("dependencies", `${green("installed")} ${dim("(node_modules/ present — delete it to force a reinstall)")}`);
} else {
  // `npm ci` is exact and fast but requires the lockfile to match package.json.
  // Falling back rather than failing: a contributor mid-edit should still be
  // able to start the thing.
  const hasLock = fs.existsSync(path.join(root, "package-lock.json"));
  status("dependencies", `${amber("missing")} — running ${hasLock ? "npm ci" : "npm install"} (a few minutes, once)`);
  console.log("");
  // PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, deliberately. `playwright` is a normal
  // dependency, so installing it would otherwise fetch a ~170 MB Chromium here
  // — during a command the user typed expecting a web server to come up. The
  // browser is only needed for payer-portal automation, `npm run setup` fetches
  // it, and the portal tools report themselves unavailable without it. A first
  // `npm start` is the wrong moment to spend that download silently.
  const ok = run(hasLock ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund", {
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
  });
  if (!ok) {
    console.log(`\n  ${red("Dependencies did not install.")} The error is above — usually a network or registry`);
    console.log("  problem, or a lockfile that no longer matches package.json. Nothing else has run.");
    console.log("  Retry with `npm start`, or `npm install` on its own to see it plainly.");
    process.exit(1);
  }
  console.log("");
  status("dependencies", green("installed"));
}

// ── 3. Build ─────────────────────────────────────────────────────────────────
// Rebuilding is decided by mtime, not by "does dist/ exist": a checkout that
// pulled new commits has a perfectly good dist/ that is now WRONG, and serving
// it is worse than a slow start — the symptom is a fix that "did not work",
// with no hint that the running code is three commits old.
//
// The walk is done here rather than shelled out to `find` because this script
// has to work on Windows too, and because a subprocess per start is a cost paid
// on every run for something Node reads in a few milliseconds.

const entry = path.join(root, "dist", "cli", "index.js");

/** Newest mtime among `.ts` files under a directory, or 0 if there are none. */
function newestSource(dir) {
  let newest = 0;
  let stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith(".ts")) {
        const m = fs.statSync(full).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  }
  return newest;
}

const built = fs.existsSync(entry);
const builtAt = built ? fs.statSync(entry).mtimeMs : 0;
const srcAt = newestSource(path.join(root, "src"));
const stale = built && srcAt > builtAt;

if (skipBuild) {
  if (!built) {
    // The one case where --skip-build cannot be honoured: there is nothing to
    // start. Said plainly rather than falling through to a confusing MODULE_NOT_FOUND.
    status("build", red("nothing built — --skip-build cannot start dist/cli/index.js because it does not exist"));
    console.log("\n  Run `npm start` without --skip-build (or `npm run build`) to compile it first.");
    process.exit(1);
  }
  status("build", `${amber("skipped")} (--skip-build)${stale ? amber(" — src/ is NEWER than dist/, you are running old code") : ""}`);
} else if (!built || stale) {
  status("build", `${amber(built ? "stale — src/ is newer than dist/" : "missing")} — compiling`);
  console.log("");
  if (!run("npm run build")) {
    console.log(`\n  ${red("The build failed.")} The compiler output is above. Nothing is served, because`);
    console.log("  serving the previous dist/ would run code that does not match this checkout.");
    console.log("  To start the old build anyway: npm start -- --skip-build");
    process.exit(1);
  }
  console.log("");
  status("build", green("compiled"));
} else {
  status("build", `${green("up to date")} ${dim("(no .ts under src/ is newer than dist/cli/index.js)")}`);
}

// ── 4. CMS reference data ────────────────────────────────────────────────────
// Reported, never fetched. ~30 MB from CMS is a `npm run setup` decision, and
// the app is designed to run without it: the NCCI, MUE and pricing tools report
// themselves as not installed rather than guessing, which is the honest failure.
// Naming the missing files matters — "datasets missing" sends people to re-run
// a fetch that already succeeded for five of six.

// Shared with the gateway's own resolution so the two cannot disagree about
// which directory the install lives in — see scripts/lib/home.mjs.
const home = resolveHome();
const dataDir = path.join(home, "data");
const present = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter((f) => f.endsWith(".json")) : [];
// The same list scripts/setup.mjs checks, and checked BY NAME for the same
// reason: a count lets a run that fetched five and 403'd on the sixth look complete.
const REQUIRED_DATASETS = ["ncci-ptp.json", "mue.json", "mpfs.json", "gpci.json", "hcpcs.json", "icd10.json"];
const missingDatasets = REQUIRED_DATASETS.filter((f) => !present.includes(f));

if (missingDatasets.length === 0) {
  status("datasets", `${green(`${present.length} file(s)`)} in ${dataDir}`);
} else {
  status("datasets", `${amber(`missing ${missingDatasets.join(", ")}`)} — run \`npm run setup\` to fetch them (~30 MB); those lookups report as unavailable until then`);
}

// ── 5. Provider ──────────────────────────────────────────────────────────────
// A missing key is NOT an error here. The gateway starts without one — the
// settings page is served, the key is entered there, and it is written to
// ~/.orion/credentials.json at 0600. That flow is the whole reason this
// command exists, so it gets a clear signpost instead of a refusal.
//
// Names only, never values, and never a prefix of one: this output ends up in
// screen shares and pasted terminal logs, which is exactly how a key leaks.

const envKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OLLAMA_API_KEY"].filter((v) =>
  (process.env[v] ?? "").trim(),
);
let stored = [];
try {
  // Same shape as src/config/credentials.ts: { provider: { key, addedAt } }.
  // Entries without a non-empty key are dropped there too, so that a blank
  // entry does not read as "configured" to a truthiness check.
  const parsed = JSON.parse(fs.readFileSync(path.join(home, "credentials.json"), "utf8"));
  stored = Object.entries(parsed)
    .filter(([, c]) => c && typeof c.key === "string" && c.key.trim())
    .map(([name]) => name);
} catch {
  // Absent, or unreadable. Neither stops a start: the environment may carry a
  // key, and the app reports a corrupt credentials file itself.
  stored = [];
}
const configured = [...new Set([...stored, ...envKeys.map((v) => v.replace("_API_KEY", "").toLowerCase())])];

// Where the UI will actually be, so the link below is not a lie when somebody
// passed --port or --host. Read off the forwarded args only; the config file is
// the gateway's to parse.
const argValue = (flag) => {
  const i = serveArgs.indexOf(flag);
  return i >= 0 && serveArgs[i + 1] && !serveArgs[i + 1].startsWith("-") ? serveArgs[i + 1] : undefined;
};
const uiHost = argValue("--host") ?? "127.0.0.1";
const uiPort = argValue("--port") ?? "4180";
const uiUrl = `http://${uiHost === "0.0.0.0" ? "127.0.0.1" : uiHost}:${uiPort}`;

if (configured.length > 0) {
  status("provider", `${green(configured.sort().join(", "))} ${dim("(key present — not shown)")}`);
} else {
  status("provider", `${amber("none configured")} — starting anyway`);
  console.log("");
  // The real path, not a hardcoded ~/.orion — ORION_HOME moves it,
  // and telling somebody to look in a file that is not the one being written is
  // worse than saying nothing.
  const credFile = path.join(home, "credentials.json");
  const shown = credFile.startsWith(`${os.homedir()}${path.sep}`) ? `~${credFile.slice(os.homedir().length)}` : credFile;
  console.log(`  No provider key was found, and that is fine. Open ${bold(uiUrl)} and add one`);
  console.log(`  under ${bold('"Providers & keys"')} — it is stored on this machine at ${shown},`);
  console.log("  readable only by you, and takes effect without a restart.");
  console.log("  Running a local model instead? Point it at Ollama there; no key is needed.");
}

// ── 6. Serve ─────────────────────────────────────────────────────────────────

heading("Gateway");
console.log(`  ${dim(`node dist/cli/index.js serve${serveArgs.length > 0 ? ` ${serveArgs.join(" ")}` : ""}`)}`);

// spawn, not spawnSync: this process has to stay alive and RESPONSIVE while the
// gateway runs, so that Ctrl-C reaches the child. Signals sent to a foreground
// process group already reach both, but `npm start` is also run detached, under
// systemd, and inside containers that signal PID 1 only — in all of those the
// wrapper is the only thing that gets the signal, and a gateway that outlives
// its parent keeps port 4180 bound with nothing left to stop it.
const child = spawn(process.execPath, [path.join("dist", "cli", "index.js"), "serve", ...serveArgs], {
  cwd: root,
  stdio: "inherit",
});

// Forwarding is necessary but — measured, not assumed — not sufficient. The
// gateway registers its own SIGINT/SIGTERM handler (to close the mail channel),
// and registering ANY handler replaces Node's default "terminate on this
// signal". So the forwarded signal is received, the mail channel closes, and
// the HTTP server keeps the port bound. A first Ctrl-C therefore appeared to do
// nothing, and the next `npm start` failed with EADDRINUSE against a gateway
// nobody could see. Hence the escalation: ask nicely, then insist.
const GRACE_MS = 5000;
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    // Best effort throughout: the child may already be gone, and signalling a
    // dead pid throws.
    if (stopping) {
      // A second Ctrl-C means "now". Skip the rest of the grace period.
      console.log("  Forcing it down.");
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
      return;
    }
    stopping = true;
    console.log("\n  Stopping the gateway … (Ctrl-C again to force)");
    try {
      child.kill(sig);
    } catch {
      /* already exited */
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }, GRACE_MS).unref();
  });
}

child.on("error", (err) => {
  console.error(`\n  ${red("Could not start the gateway.")} ${err.message}`);
  console.error("  If this says ENOENT, dist/ is incomplete — run `npm run build`.");
  process.exit(1);
});

child.on("exit", (code, signal) => {
  // The child's status is this command's status, so `npm start` in a script or
  // a supervisor sees the truth. A signalled exit is reported as 128+n, the
  // shell convention — reporting 0 there would tell a supervisor the gateway
  // shut down cleanly when it was killed.
  if (signal) {
    if (stopping) console.log(`  Gateway stopped (${signal}).`);
    process.exit(128 + (os.constants.signals[signal] ?? 0));
  }
  process.exit(code ?? 0);
});
