#!/usr/bin/env node
// ── Refuse to deploy a configuration that cannot work ────────────────────────
// Every check here exists because the failure it catches is SILENT or looks
// like something else. A deploy that succeeds and then serves 500s to every
// request is worse than one that never started, because the first tells you
// what is wrong and the second sends you looking at Cloudflare's status page.
//
// Run by .github/workflows/deploy.yml before wrangler, and worth running by
// hand before the first deploy.

import fs from "node:fs";
import path from "node:path";

const problems = [];
const notes = [];

const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

// ── 1. The Access audience ───────────────────────────────────────────────────
// The placeholder deploys perfectly happily. What it produces is a Worker that
// rejects every Access token — including valid ones — because the AUD it
// compares against matches no application. The symptom is "403 for everyone",
// which reads as an Access misconfiguration rather than a config file nobody
// finished.
const wrangler = read("wrangler.jsonc");
if (wrangler === "") {
  problems.push("wrangler.jsonc is missing — there is nothing to deploy.");
} else {
  if (/REPLACE_WITH_ACCESS_APPLICATION_AUD/.test(wrangler)) {
    problems.push(
      "wrangler.jsonc still has the placeholder ACCESS_AUD. Copy the AUD tag from the Zero Trust " +
        "application for this hostname; with the placeholder the Worker rejects every session, valid or not.",
    );
  }
  const team = /"ACCESS_TEAM_DOMAIN"\s*:\s*"([^"]*)"/.exec(wrangler)?.[1] ?? "";
  if (!team.endsWith(".cloudflareaccess.com")) {
    problems.push(
      `ACCESS_TEAM_DOMAIN is "${team}", which is not a Cloudflare Access team domain. ` +
        "The Worker fetches its signing keys from there; a wrong value fails every verification.",
    );
  }
}

// ── 2. The shared secret ─────────────────────────────────────────────────────
// src/gateway/auth.ts is deliberately fail-closed: bound off loopback with no
// token, the gateway serves NOTHING. That is the right behaviour and it is also
// a total outage, so it must be caught here rather than by a user.
const token = process.env.GATEWAY_TOKEN ?? "";
if (token === "") {
  problems.push(
    "GATEWAY_TOKEN is not set. The container refuses every request without it — the deploy would " +
      "succeed and the site would answer 500 to everything.",
  );
} else if (token.length < 32) {
  problems.push(`GATEWAY_TOKEN is ${token.length} characters. Use at least 32 — \`openssl rand -hex 32\`.`);
}

for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
  if (!process.env[name]) problems.push(`${name} is not set; wrangler cannot authenticate.`);
}

// ── 3. The PHI posture ───────────────────────────────────────────────────────
// Not a problem, but the single most consequential setting in the deployment,
// so it is REPORTED rather than assumed. Somebody reading the deploy log should
// be able to see what this release will accept.
const phi = /"ORION_PHI=(\w+)"|ORION_PHI=(\w+)/.exec(read("Dockerfile"));
const phiValue = phi ? phi[1] || phi[2] : "(unset)";
if (phiValue === "permitted") {
  notes.push(
    "PHI posture: PERMITTED. This deployment will accept protected health information. " +
      "That is correct only if a Business Associate Agreement covering these services is in force.",
  );
} else {
  notes.push(`PHI posture: BLOCKED (${phiValue}) — identifier-bearing documents are refused with 422 and not stored.`);
}

// ── 4. The build is real ─────────────────────────────────────────────────────
// The container runs dist/, and a Dockerfile that copies an empty dist/ starts
// a process that exits immediately — which Cloudflare reports as an unhealthy
// instance rather than as a missing build.
if (!fs.existsSync(path.join("dist", "cli", "index.js"))) {
  problems.push("dist/cli/index.js is missing — run `npm run build` before deploying.");
}
if (!fs.existsSync(path.join("dist", "memory", "schema.sql"))) {
  problems.push(
    "dist/memory/schema.sql is missing. The build copies it separately from the TypeScript, so a " +
      "partial build produces a container that starts and then fails to open its database.",
  );
}

// ── Report ───────────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  ${n}`);
if (problems.length === 0) {
  console.log("\nPreflight passed.");
  process.exit(0);
}
console.error(`\n${problems.length} problem(s) would break this deploy:\n`);
for (const p of problems) console.error(`  - ${p}`);
process.exit(1);
