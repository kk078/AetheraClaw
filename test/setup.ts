import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Test isolation from the real installation ────────────────────────────────
// Without this, the suite reads ~/.orion — the developer's OWN config and
// reference data. Two tests failed the moment real NCCI edits were installed on
// this machine: one asserting the "NCCI data not installed" notice fires, and
// one asserting a warning-only claim produces no errors, which stopped being
// true once a real bundling edit existed to find.
//
// That failure mode is the dangerous shape. A CI runner has no ~/.orion,
// so both tests pass there forever while failing for anyone who has actually
// used the product — green on the machine nobody works on, red on every machine
// somebody does. Pointing ORION_HOME at an empty temp directory makes the
// suite depend on its fixtures and nothing else.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orion-test-home-"));
process.env.ORION_HOME = dir;

export function teardown(): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
