import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── The script that decides whether anything is released ─────────────────────
// It had no tests, and it silently did the wrong thing: `workflow_dispatch`
// offers "Force a specific bump instead of reading the commits" and the input
// was read AFTER the early exit for an empty commit range. HEAD is normally the
// `chore(release):` commit the last tag points at, so that range is empty and
// the forced bump was unreachable in exactly the situation somebody uses it.
//
// The dispatch was accepted, the job went green, and there was no tag and no
// deploy — nothing failed, and nothing happened. These tests run the real script
// against real throwaway repositories, because the behaviour under test is its
// reading of `git log`, and a mocked git would be testing the mock.

const REPO_ROOT = process.cwd();
const SCRIPT = path.join(REPO_ROOT, "scripts", "release-version.mjs");

describe("deciding whether to release", () => {
  let dir: string;

  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

  const commit = (subject: string) => {
    fs.appendFileSync(path.join(dir, "file.txt"), `${subject}\n`);
    git("add", "-A");
    git("commit", "-m", subject);
  };

  /** Run the real script; returns stdout plus the resulting package version. */
  const run = (env: Record<string, string> = {}) => {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: "", FORCED_BUMP: "", ...env },
    });
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version: string };
    return { stdout, version: pkg.version };
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "orion-release-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.2.3" }, null, 2));
    fs.writeFileSync(path.join(dir, "file.txt"), "");
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("config", "commit.gpgsign", "false");
    commit("chore: initial");
    git("tag", "-a", "v1.2.3", "-m", "v1.2.3");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("releases nothing when nothing has happened", () => {
    // The decision the script exists to make. Unchanged by this fix.
    const { stdout, version } = run();
    expect(stdout).toContain("released=false");
    expect(version).toBe("1.2.3");
  });

  it("RELEASES ON A FORCED BUMP WITH AN EMPTY RANGE — the bug", () => {
    // HEAD is the tagged commit, so there is nothing since the tag. Before the
    // fix this exited released=false without ever reading FORCED_BUMP.
    const { stdout, version } = run({ FORCED_BUMP: "patch" });
    expect(stdout).toContain("released=true");
    expect(version).toBe("1.2.4");
  });

  it("says why it released something with no commits behind it", () => {
    // Otherwise the run's log is indistinguishable from a normal release and
    // the changelog entry lists nothing.
    const { stdout } = run({ FORCED_BUMP: "minor" });
    expect(stdout).toMatch(/FORCED_BUMP=minor was given/);
    const changelog = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
    expect(changelog).toMatch(/no code changes \(forced bump\)/);
  });

  it("honours each bump level", () => {
    expect(run({ FORCED_BUMP: "minor" }).version).toBe("1.3.0");
  });

  it("REFUSES a bump it does not understand rather than falling back", () => {
    // A typo that silently reverts to automatic behaviour is worse than an
    // error: the operator believes they forced something, and the log looks
    // perfectly ordinary.
    expect(() => run({ FORCED_BUMP: "pathc" })).toThrow();
  });

  it("still overrides the commit log when there ARE commits", () => {
    commit("feat: something that would be a minor");
    expect(run({ FORCED_BUMP: "patch" }).version).toBe("1.2.4");
  });

  it("does not release for commits that cannot change behaviour", () => {
    commit("docs: fix a typo in a comment");
    const { stdout, version } = run();
    expect(stdout).toContain("released=false");
    expect(version).toBe("1.2.3");
  });

  it("treats an unrecognised subject as a patch, not as nothing", () => {
    // This repository does not write strict conventional subjects, and the safe
    // direction is releasing a change as a fix rather than not releasing it.
    commit("make the worklist sort by age");
    expect(run().version).toBe("1.2.4");
  });
});
