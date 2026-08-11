import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SNAPSHOT_STATUS_FILE,
  STALE_AFTER_MS,
  assessSnapshot,
  readSnapshotStatus,
  type SnapshotStatus,
} from "../src/ops/snapshot-status.js";

const T0 = 1_800_000_000_000;

const status = (over: Partial<SnapshotStatus> = {}): SnapshotStatus => ({
  lastAttemptAt: T0,
  lastSuccessAt: T0,
  lastBytes: 4096,
  lastReason: "interval",
  lastError: "",
  consecutiveFailures: 0,
  disabled: false,
  disabledReason: "",
  restoredAt: T0 - 60_000,
  restoredBytes: 4000,
  ...over,
});

describe("judging whether a deployment is persisting", () => {
  it("calls a fresh checkpoint ok and says how much a restart would cost", () => {
    const a = assessSnapshot(status({ lastSuccessAt: T0 - 30_000 }), T0);
    expect(a.verdict).toBe("ok");
    expect(a.persisting).toBe(true);
    expect(a.ageSeconds).toBe(30);
    expect(a.summary).toMatch(/lose at most the last 30s/);
  });

  it("reports NOTHING MEASURED as unknown rather than healthy", () => {
    // The failure this whole module exists for was invisible because every
    // surface reported health it had not established. An absent status file
    // must never read as a working checkpoint.
    const a = assessSnapshot(null, T0);
    expect(a.verdict).toBe("unknown");
    expect(a.persisting).toBe(false);
    expect(a.ageSeconds).toBeNull();
    expect(a.summary).toMatch(/UNMEASURED/);
  });

  it("calls a checkpoint that stopped landing stale, even with no error", () => {
    // The exact shape of the production symptom: nothing throwing, nothing in
    // the log, and the last accepted write hours old.
    const a = assessSnapshot(status({ lastSuccessAt: T0 - STALE_AFTER_MS - 1 }), T0);
    expect(a.verdict).toBe("stale");
    expect(a.persisting).toBe(false);
    expect(a.summary).toMatch(/would be lost by a restart/);
  });

  it("does not cry wolf on one slow tick", () => {
    // A threshold that fires on ordinary jitter gets muted, and a muted alert
    // is the same as no alert on the day it matters.
    expect(assessSnapshot(status({ lastSuccessAt: T0 - STALE_AFTER_MS + 1_000 }), T0).verdict).toBe("ok");
  });

  it("reports failures with the count and the error", () => {
    const a = assessSnapshot(status({ consecutiveFailures: 3, lastError: "snapshot PUT returned 401" }), T0);
    expect(a.verdict).toBe("failing");
    expect(a.consecutiveFailures).toBe(3);
    expect(a.summary).toContain("401");
  });

  it("puts failing ahead of stale when both are true", () => {
    // A named cause beats "it stopped happening". Someone reading "3 failures,
    // last error 401" fixes a token; someone reading "stale" goes hunting.
    const a = assessSnapshot(
      status({ lastSuccessAt: T0 - 10 * STALE_AFTER_MS, consecutiveFailures: 9, lastError: "boom" }),
      T0,
    );
    expect(a.verdict).toBe("failing");
  });

  it("says plainly when checkpointing is off", () => {
    const a = assessSnapshot(status({ disabled: true, disabledReason: "no ORION_SNAPSHOT_URL is configured" }), T0);
    expect(a.verdict).toBe("disabled");
    expect(a.persisting).toBe(false);
    expect(a.summary).toMatch(/lost when this instance stops/);
  });

  it("does not call a just-booted container healthy before anything has landed", () => {
    // Enabled, nothing failing, nothing written yet. That is genuinely unknown:
    // it is the ordinary state for thirty seconds and a real problem at an hour.
    const a = assessSnapshot(status({ lastSuccessAt: 0, lastBytes: 0 }), T0);
    expect(a.verdict).toBe("unknown");
    expect(a.persisting).toBe(false);
    expect(a.ageSeconds).toBeNull();
  });

  it("never reports a negative age from a clock that moved backwards", () => {
    expect(assessSnapshot(status({ lastSuccessAt: T0 + 5_000 }), T0).ageSeconds).toBe(0);
  });
});

describe("reading the status file", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "orion-snap-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (body: string) => fs.writeFileSync(path.join(dir, SNAPSHOT_STATUS_FILE), body);

  it("round-trips what the boot script writes", () => {
    write(JSON.stringify(status({ lastBytes: 12_345 })));
    expect(readSnapshotStatus(dir)?.lastBytes).toBe(12_345);
  });

  it("returns null when there is no file", () => {
    expect(readSnapshotStatus(dir)).toBeNull();
  });

  it("returns null for malformed JSON rather than a half-built status", () => {
    // A defaulted lastSuccessAt of 0 would read as "never checkpointed" and
    // send somebody hunting a failure that is really a broken file.
    write("{not json");
    expect(readSnapshotStatus(dir)).toBeNull();
  });

  it("returns null when the timestamps are the wrong type", () => {
    write(JSON.stringify({ lastAttemptAt: "yesterday", lastSuccessAt: null }));
    expect(readSnapshotStatus(dir)).toBeNull();
  });

  it("survives a file missing the optional fields", () => {
    write(JSON.stringify({ lastAttemptAt: T0, lastSuccessAt: T0 }));
    const s = readSnapshotStatus(dir);
    expect(s).not.toBeNull();
    expect(s?.disabled).toBe(false);
    expect(s?.lastError).toBe("");
  });

  it("treats a truncated write as unreadable, not as healthy", () => {
    // The reason the writer renames into place. If a reader ever did catch a
    // partial file, the answer must be "unknown", never "ok".
    const full = JSON.stringify(status());
    write(full.slice(0, Math.floor(full.length / 2)));
    expect(assessSnapshot(readSnapshotStatus(dir), T0).verdict).toBe("unknown");
  });
});
