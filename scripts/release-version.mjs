#!/usr/bin/env node
// ── What version is this, and is it worth releasing? ─────────────────────────
// Reads the commits since the last v-tag, decides a semantic bump from them,
// writes package.json and CHANGELOG.md, and tells the workflow what happened.
//
// The decision this makes that matters most is the one to release NOTHING.
// A repository where every push produces a version produces versions that mean
// nothing — and, here, redeploys a PHI application to make a typo in a comment
// live. Commits that cannot change behaviour do not earn a release.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const out = (key, value) => {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`${key}=${value}`);
};

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

let lastTag = "";
try {
  lastTag = git("describe", "--tags", "--abbrev=0", "--match", "v*");
} catch {
  // No tag yet. Everything in history is the first release.
}

const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
const log = git("log", range, "--pretty=format:%s%n%b%n--END--");
const commits = log
  .split("--END--")
  .map((c) => c.trim())
  .filter(Boolean);

// ── An explicit bump beats the commit log, INCLUDING when it is empty ────────
// Read here rather than after the commit scan, because the empty-range exit
// below used to return before this variable was ever looked at. The workflow
// offers "Force a specific bump instead of reading the commits" and it did
// nothing in the one situation somebody reaches for it: HEAD is usually the
// `chore(release):` commit the last tag points at, so `vX.Y.Z..HEAD` is empty
// and the run ended with released=false and no explanation naming the input.
//
// Nothing failed. The dispatch was accepted, the job went green, and no tag and
// no deploy appeared — which is the shape of outage nobody notices, and the
// exact failure mode the deploy handoff in release.yml was already written to
// avoid once before.
const forced = (process.env.FORCED_BUMP ?? "").trim();
const VALID_BUMPS = ["major", "minor", "patch"];
if (forced && !VALID_BUMPS.includes(forced)) {
  // Refuse rather than fall through to reading the commits. A typo'd input that
  // silently reverts to automatic behaviour is worse than an error: the operator
  // believes they forced something and the log looks ordinary.
  console.error(`FORCED_BUMP must be one of ${VALID_BUMPS.join(", ")} — got "${forced}".`);
  process.exit(1);
}

if (commits.length === 0 && !forced) {
  out("released", "false");
  out("version", pkg.version);
  console.log("Nothing since the last tag.");
  process.exit(0);
}

if (commits.length === 0) {
  // Deliberate: re-cutting a version on an unchanged tree. The image is rebuilt
  // and redeployed, which is a legitimate thing to want — an environment change,
  // a base-image rebuild, or forcing the container to restart. Said out loud so
  // the run's log explains a release whose changelog entry is empty.
  console.log(`Nothing since ${lastTag || "the beginning"}, but FORCED_BUMP=${forced} was given — releasing anyway.`);
}

// Conventional-commit prefixes, read leniently. This repository does not write
// strict `feat:`/`fix:` subjects, so a commit that matches nothing is treated as
// a patch — the safe direction, because under-stating a change releases it as a
// fix rather than not releasing it at all.
const BREAKING = /(^|\n)BREAKING[ -]CHANGE|!:/;
const FEATURE = /^(feat|feature)(\(|:)/i;
const FIX = /^(fix|perf|revert)(\(|:)/i;
// Prefixes that cannot change what the software does.
const NO_RELEASE = /^(docs|chore|style|test|ci|build)(\(|:)/i;

let bump = "";
const notable = [];
for (const commit of commits) {
  const subject = commit.split("\n")[0];
  if (BREAKING.test(commit)) bump = "major";
  else if (FEATURE.test(subject)) bump = bump === "major" ? bump : "minor";
  else if (FIX.test(subject)) bump = bump || "patch";
  else if (!NO_RELEASE.test(subject)) bump = bump || "patch";
  if (!NO_RELEASE.test(subject)) notable.push(subject);
}

if (forced) bump = forced;

if (!bump) {
  out("released", "false");
  out("version", pkg.version);
  console.log(`${commits.length} commit(s), none of them release-worthy.`);
  process.exit(0);
}

const [major, minor, patch] = pkg.version.split(".").map(Number);
const next =
  bump === "major" ? `${major + 1}.0.0` : bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;

pkg.version = next;
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

// package-lock.json carries the version in two places and `npm ci` compares
// them against package.json. Leaving it stale would break the very install step
// the deploy depends on — the same class of failure that already broke CI once.
try {
  execFileSync("npm", ["install", "--package-lock-only"], { stdio: "inherit" });
} catch {
  console.log("could not refresh package-lock.json; continuing");
}

const date = new Date().toISOString().slice(0, 10);
// A forced release with nothing behind it would otherwise write a heading and
// a blank space, and a changelog entry that lists no changes reads as a bug in
// the changelog rather than as a deliberate redeploy. Say which it is.
const lines = notable.length > 0 ? notable.map((s) => `- ${s}`) : ["- Re-released with no code changes (forced bump)."];
const entry = [`## v${next} — ${date}`, "", ...lines, ""].join("\n");
const existing = fs.existsSync("CHANGELOG.md") ? fs.readFileSync("CHANGELOG.md", "utf8") : "# Changelog\n";
const [heading, ...rest] = existing.split("\n");
fs.writeFileSync("CHANGELOG.md", [heading, "", entry, ...rest].join("\n"));
fs.writeFileSync(".release-notes.md", entry);

out("released", "true");
out("version", next);
console.log(`v${pkg.version} (${bump}) from ${commits.length} commit(s).`);
