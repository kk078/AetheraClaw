import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APP_DIR_NAME,
  LEGACY_DIR_NAME,
  legacyEnvNamesInUse,
  legacyNotice,
  readEnv,
  resolveDbFile,
  resolveHome,
} from "../src/config/legacy.js";

// The rename from AetheraClaw to Orion is cheap in source and expensive on
// disk. What these tests protect against is not a compile error — it is an
// install that starts, finds no database where the NEW name says one should be,
// creates an empty one, and shows a practice a clean slate where their
// receivables used to be. The old data is on disk the entire time.

const made: string[] = [];
function tmpdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "orion-legacy-"));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("readEnv", () => {
  it("prefers the new name when both are set", () => {
    // So an operator can export the new one and delete the old one afterwards,
    // rather than having to do both in the same instant.
    expect(readEnv("HOME", { ORION_HOME: "/new", AETHERACLAW_HOME: "/old" })).toBe("/new");
  });

  it("falls back to the old name", () => {
    expect(readEnv("HOME", { AETHERACLAW_HOME: "/old" })).toBe("/old");
  });

  it("treats an EMPTY value as unset under both names", () => {
    // `export ORION_HOME=` is how a shell script clears a variable it did not
    // mean to set. Honouring "" would resolve the data directory to the
    // process's working directory.
    expect(readEnv("HOME", { ORION_HOME: "", AETHERACLAW_HOME: "/old" })).toBe("/old");
    expect(readEnv("HOME", { ORION_HOME: "", AETHERACLAW_HOME: "" })).toBeUndefined();
  });

  it("is undefined when neither is set", () => {
    expect(readEnv("SQLITE", {})).toBeUndefined();
  });
});

describe("resolveDbFile", () => {
  it("uses the new filename in an empty directory", () => {
    const dir = tmpdir();
    expect(path.basename(resolveDbFile(dir))).toBe(`${APP_DIR_NAME}.db`);
  });

  it("FINDS AN EXISTING PRE-RENAME DATABASE rather than creating an empty one beside it", () => {
    // The whole point. This is the failure that looks like data loss to the
    // person it happens to: the claims are right there, under the old name.
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, `${LEGACY_DIR_NAME}.db`), "SQLite format 3\0");
    expect(path.basename(resolveDbFile(dir))).toBe(`${LEGACY_DIR_NAME}.db`);
  });

  it("prefers the new file when both exist", () => {
    // Both present means a migration already happened. The new one is the live
    // database and the old one is a leftover; reading the leftover would drop
    // every row written since.
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, `${LEGACY_DIR_NAME}.db`), "old");
    fs.writeFileSync(path.join(dir, `${APP_DIR_NAME}.db`), "new");
    expect(path.basename(resolveDbFile(dir))).toBe(`${APP_DIR_NAME}.db`);
  });
});

describe("resolveHome", () => {
  it("honours an explicit setting under either name, over anything on disk", () => {
    const dir = tmpdir();
    expect(resolveHome({ ORION_HOME: dir })).toBe(dir);
    expect(resolveHome({ AETHERACLAW_HOME: dir })).toBe(dir);
  });

  it("expands a leading ~", () => {
    expect(resolveHome({ ORION_HOME: "~/somewhere" })).toBe(path.join(os.homedir(), "somewhere"));
  });

  it("falls back to the pre-rename directory only when the new one does not exist", () => {
    // Exercised through the real home directory rather than a fixture, because
    // that is the branch that decides where a live install reads from. Whichever
    // of the two exists here, the answer must be a directory that EXISTS when
    // either does — never a third, empty path.
    const resolved = resolveHome({});
    const next = path.join(os.homedir(), `.${APP_DIR_NAME}`);
    const legacy = path.join(os.homedir(), `.${LEGACY_DIR_NAME}`);
    if (fs.existsSync(next)) expect(resolved).toBe(next);
    else if (fs.existsSync(legacy)) expect(resolved).toBe(legacy);
    else expect(resolved).toBe(next);
  });

  it("never invents a directory when neither exists", () => {
    expect(resolveHome({})).toMatch(new RegExp(`\\.(${APP_DIR_NAME}|${LEGACY_DIR_NAME})$`));
  });
});

describe("legacyEnvNamesInUse", () => {
  it("lists only old names with no new equivalent set", () => {
    const names = legacyEnvNamesInUse({
      AETHERACLAW_HOME: "/old",
      AETHERACLAW_SQLITE: "node",
      ORION_SQLITE: "node", // superseded — not worth mentioning
      PATH: "/usr/bin",
    });
    expect(names).toEqual(["AETHERACLAW_HOME"]);
  });

  it("ignores an old name set to empty", () => {
    expect(legacyEnvNamesInUse({ AETHERACLAW_HOME: "" })).toEqual([]);
  });
});

describe("legacyNotice", () => {
  it("says nothing when nothing legacy is in play", () => {
    expect(legacyNotice(`/home/x/.${APP_DIR_NAME}`, `/home/x/.${APP_DIR_NAME}/${APP_DIR_NAME}.db`, {})).toBe("");
  });

  it("names the directory, the file and the variables that are still old", () => {
    const notice = legacyNotice(
      `/home/x/.${LEGACY_DIR_NAME}`,
      `/home/x/.${LEGACY_DIR_NAME}/${LEGACY_DIR_NAME}.db`,
      { AETHERACLAW_SQLITE: "node" },
    );
    expect(notice).toContain(`.${LEGACY_DIR_NAME}`);
    expect(notice).toContain(`${LEGACY_DIR_NAME}.db`);
    expect(notice).toContain("AETHERACLAW_SQLITE");
  });

  it("reads as a notice, not a warning", () => {
    // Continuing on the old names is supported. Calling a working install
    // broken teaches people to ignore the startup banner, which is where the
    // things that ARE broken get reported.
    const notice = legacyNotice(`/home/x/.${LEGACY_DIR_NAME}`, `/home/x/.${LEGACY_DIR_NAME}/x.db`, {});
    expect(notice).toMatch(/still work|nothing needs doing/i);
    expect(notice).not.toMatch(/error|fail|deprecated|must/i);
  });
});
