import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── The line that says which SQLite driver you got ───────────────────────────
// openDatabase prefers better-sqlite3 and falls back to the built-in
// node:sqlite when the optional native module will not load. That fallback used
// to be silent, which made a green run unfalsifiable: the full suite passing
// twice is exactly what CI's two-driver matrix looks like when the native
// module failed to install and BOTH legs quietly ran node:sqlite.
//
// Testing this in-process is not possible in any honest way — the warning fires
// once per process, and vitest has already loaded the module (and the real
// better-sqlite3) long before any test runs. So each case is a real child
// process with a real module resolution failure, and the assertion is on the
// stderr an operator would actually see.
//
// A fallback nobody runs is a fallback that does not work; the same is true of
// the warning attached to it.

const REPO_ROOT = process.cwd();
const SQLITE_MODULE = path.join(REPO_ROOT, "src", "memory", "sqlite.ts");

/**
 * The child: hide better-sqlite3 on request, then open every named database.
 *
 * Module._load is private and this is the one place that earns it — the require
 * happens inside openDatabase, so nothing the child can pass in reaches it. The
 * fake error copies the shape of a genuine one, multi-line require stack
 * included, because trimming that to a single line is part of what is tested.
 */
const CHILD = `
import Module from "node:module";
import { pathToFileURL } from "node:url";

if (process.env.HIDE_BETTER_SQLITE3 === "1") {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "better-sqlite3") {
      const err = new Error("Cannot find module 'better-sqlite3'\\nRequire stack:\\n- fake-require-stack");
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }
    return load.call(this, request, ...rest);
  };
}

// Imported dynamically so the module under test loads AFTER the hook is in
// place; a static import would be hoisted above it and always find the module.
const { openDatabase } = await import(pathToFileURL(process.argv[2]).href);
const drivers = process.argv.slice(3).map((file) => {
  const db = openDatabase(file);
  const driver = db.driver;
  db.close();
  return driver;
});
process.stdout.write(JSON.stringify(drivers));
`;

const require_ = createRequire(import.meta.url);
const betterSqliteInstalled = (() => {
  try {
    require_.resolve("better-sqlite3");
    return true;
  } catch {
    return false;
  }
})();

interface Run {
  /** One entry per database opened, in order. */
  drivers: string[];
  /** Only the lines this module emits — vitest's own noise is not ours. */
  warnings: string[];
  /** Everything the child wrote, for asserting what did NOT reach the operator. */
  stderr: string;
}

/** Open `opens` databases in one child process and report what it said. */
function run(opts: { hide: boolean; forceNodeDriver?: boolean; opens?: number }): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orion-sqlite-fallback-"));
  try {
    const script = path.join(dir, "open-databases.mjs");
    fs.writeFileSync(script, CHILD);
    const files = Array.from({ length: opts.opens ?? 1 }, (_, i) => path.join(dir, `db-${i}.sqlite`));

    // The suite's own second leg runs under ORION_SQLITE=node, which would
    // otherwise force the built-in in every child here and test nothing. Both
    // spellings are cleared — src/config/legacy.ts reads either.
    const env = { ...process.env, HIDE_BETTER_SQLITE3: opts.hide ? "1" : "0" };
    delete env.ORION_SQLITE;
    delete env.AETHERACLAW_SQLITE;
    if (opts.forceNodeDriver) env.ORION_SQLITE = "node";

    const child = spawnSync(process.execPath, ["--import", "tsx", script, SQLITE_MODULE, ...files], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env,
    });
    if (child.status !== 0) {
      throw new Error(`child exited ${String(child.status)}\n${child.stdout}\n${child.stderr}`);
    }
    // node:sqlite's own ExperimentalWarning shares this stderr; only the lines
    // this module writes are the subject, and each is asserted whole so a
    // message that wrapped onto a second line would fail rather than pass.
    const warnings = child.stderr.split("\n").filter((line) => line.includes("[sqlite]"));
    return { drivers: JSON.parse(child.stdout) as string[], warnings, stderr: child.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("the SQLite driver says which one it is", () => {
  it("names the driver it wanted and the driver it got", () => {
    const { drivers, warnings, stderr } = run({ hide: true, opens: 2 });
    expect(drivers).toEqual(["node:sqlite", "node:sqlite"]);
    // Two databases, one line: this is the property that keeps the warning
    // readable on a tenanted install, where every tenant opens its own file.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("wanted better-sqlite3");
    expect(warnings[0]).toContain("using node:sqlite");
    expect(warnings[0]).toContain("Cannot find module 'better-sqlite3'");
    // ONE line, so the reason and the closing advice have to share it. Asserting
    // only that the stray require stack is absent from `warnings[0]` would not
    // catch an untrimmed message: the stack lands on lines of its own, which
    // this filter never looks at, and the count stays 1. So check the tail is
    // still on the same line, and that the stack reached nobody at all.
    expect(warnings[0]).toContain("set ORION_SQLITE=node");
    expect(stderr).not.toContain("fake-require-stack");
  });

  it.skipIf(!betterSqliteInstalled)("says nothing when the preferred driver loads", () => {
    const { drivers, warnings } = run({ hide: false });
    expect(drivers).toEqual(["better-sqlite3"]);
    expect(warnings).toEqual([]);
  });

  it("says nothing when the built-in was chosen deliberately", () => {
    const { drivers, warnings } = run({ hide: true, forceNodeDriver: true });
    expect(drivers).toEqual(["node:sqlite"]);
    expect(warnings).toEqual([]);
  });
});
