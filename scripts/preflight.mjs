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

// ── 3b. Public access, and the one combination that must never ship ──────────
// PUBLIC_ACCESS="1" serves this hostname to anyone, with no sign-in. That was
// asked for deliberately for a trial, and it is reported on every deploy so it
// cannot become the thing nobody remembers turning on.
//
// The INTERLOCK is the part that matters. Public and PHI-permitted together is
// an unauthenticated console over real patient data, and the day the BAA is
// signed the natural change is one word in the Dockerfile — a change nobody
// would connect to a flag in a different file. So the two are checked together
// here, and that combination FAILS the deploy rather than warning about it.
const publicAccess = /"PUBLIC_ACCESS"\s*:\s*"1"/.test(wrangler);
if (publicAccess && phiValue === "permitted") {
  problems.push(
    "PUBLIC_ACCESS is \"1\" AND ORION_PHI is permitted. That is an unauthenticated console over " +
      "protected health information, reachable by anyone who learns the hostname. Set PUBLIC_ACCESS " +
      'to "0" and re-create the Access application (workflow: Access setup) before permitting PHI.',
  );
} else if (publicAccess) {
  notes.push(
    "Sign-in: NONE. PUBLIC_ACCESS=\"1\" — anyone who reaches this hostname gets the console, the " +
      "claims database and the tools. Safe only while the data is synthetic and the PHI posture is blocked.",
  );
} else {
  notes.push("Sign-in: Cloudflare Access. Every request must present a verified session.");
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

// ── 5. The Containers API actually answers this token ────────────────────────
// The only check here that makes a network call, and it earns it. The v0.1.1
// deploy passed every other gate, spent ninety seconds building and exporting
// the container image, and was refused at the push with a 403 on
// /accounts/{id}/containers/me — Containers is a separate authorisation from
// Workers, and the token had the second without the first.
//
// Everything before the push is wasted work when this is wrong, and the error
// arrives at the end of the log where it reads as a build failure rather than
// as a token that was never going to be allowed. Ask the question first.
//
// Failure here is a WARNING rather than a blocker, deliberately: a network
// check that can fail for its own reasons — a blip, an outage, a proxy — must
// not become a new way for a correct deploy to be refused.
if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) {
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/containers/me`,
      { headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } },
    );
    if (res.status === 403 || res.status === 401) {
      problems.push(
        `The Containers API refused this token (HTTP ${res.status} on /containers/me). Two causes, and the ` +
          "first is the one that cannot be fixed with configuration: CONTAINERS REQUIRES THE WORKERS PAID " +
          "PLAN, so on a free account this is an entitlement, not a permission, and no token scope will " +
          "open it. If the account is already paid, then it is the account-level Containers permission " +
          "missing from the token — Containers authorises separately from Workers, so a token that deploys " +
          "a Worker fine is still refused here, at the image PUSH, after the whole image has been built.",
      );
    } else if (!res.ok) {
      notes.push(`Containers API returned HTTP ${res.status}; continuing, since that may be transient.`);
    } else {
      notes.push("Containers API: reachable with this token.");
    }
  } catch (err) {
    notes.push(`Could not reach the Containers API (${err instanceof Error ? err.message : String(err)}); continuing.`);
  }
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
