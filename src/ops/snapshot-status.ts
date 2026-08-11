import fs from "node:fs";
import path from "node:path";

// ── Is this deployment persisting? ───────────────────────────────────────────
// The question this file exists to answer, and the reason it exists is that on
// 2026-08-11 nobody could answer it. The console reported a healthy gateway, a
// green deploy and a sensible-looking database — and rows written half an hour
// before a restart were gone afterwards, with the same day-old snapshot coming
// back each time. Every surface said "fine". The evidence was in a container
// log nobody could reach without a Cloudflare session.
//
// A DEPLOYMENT THAT SILENTLY STOPS PERSISTING LOOKS EXACTLY LIKE A HEALTHY ONE.
// That is the whole problem: the failure is invisible between restarts, and the
// restart is where the loss is realised. So the check cannot be "did the last
// write succeed" — it has to be "when did a checkpoint last LAND", asked at any
// moment, from outside the container.
//
// The writer is scripts/container-boot.mjs, which owns the R2 round trip. It
// drops a small JSON file after every attempt. This module reads it and judges
// it. Deliberately a file rather than an HTTP callback into the gateway: the
// gateway is publicly served, and an endpoint that accepts a status POST is an
// endpoint anyone can lie to. A file has exactly one writer.

/** What container-boot.mjs writes after each checkpoint attempt. */
export interface SnapshotStatus {
  /** Epoch ms of the last attempt, successful or not. 0 if never. */
  lastAttemptAt: number;
  /** Epoch ms of the last attempt that R2 accepted. 0 if never. */
  lastSuccessAt: number;
  /** Bytes in the last accepted checkpoint. */
  lastBytes: number;
  /** Why the last attempt ran: "interval", "shutdown:SIGTERM", … */
  lastReason: string;
  /** The last failure's message, or "" if the last attempt succeeded. */
  lastError: string;
  /** Failures since the last success. Reset to 0 on success. */
  consecutiveFailures: number;
  /** True when the boot script decided not to checkpoint at all. */
  disabled: boolean;
  /** Why it is disabled, in a sentence. Empty when it is not. */
  disabledReason: string;
  /** Epoch ms the database was restored at boot, and how many bytes came back. */
  restoredAt: number;
  restoredBytes: number;
}

export const SNAPSHOT_STATUS_FILE = "snapshot-status.json";

/**
 * How long a checkpoint may go unlanded before it is called stale.
 *
 * Five times the 60s cadence. One missed tick is a slow PUT and says nothing;
 * five in a row is a pattern. Tight enough that the answer is wrong for minutes
 * rather than a day, loose enough that a busy instance does not cry wolf — an
 * alert that fires on ordinary jitter gets muted, and a muted alert is the same
 * as no alert on the day it matters.
 */
export const STALE_AFTER_MS = 5 * 60_000;

export type SnapshotVerdict = "ok" | "stale" | "failing" | "disabled" | "unknown";

export interface SnapshotAssessment {
  verdict: SnapshotVerdict;
  /** Seconds since the last checkpoint R2 accepted. null when there has never been one. */
  ageSeconds: number | null;
  lastBytes: number;
  consecutiveFailures: number;
  /** One sentence an operator can act on. */
  summary: string;
  /** True only for "ok". Anything else means writes may not survive a restart. */
  persisting: boolean;
}

/**
 * Judge a status. Pure, and `now` is injected — the verdict is a function of
 * the clock, so a test that cannot control the clock cannot test the verdict.
 *
 * `null` status is "unknown", NEVER "ok". The absence of a status file means
 * either a build that predates this check or a boot script that never got as
 * far as writing one, and both of those are states where persistence is in
 * question. Reporting an unmeasured thing as healthy is how the original
 * problem stayed invisible for a day.
 */
export function assessSnapshot(status: SnapshotStatus | null, now: number): SnapshotAssessment {
  if (status === null) {
    return {
      verdict: "unknown",
      ageSeconds: null,
      lastBytes: 0,
      consecutiveFailures: 0,
      summary:
        "No checkpoint status has been written, so whether this deployment persists is UNMEASURED. " +
        "Either the container predates this check or its boot script never reached a first checkpoint.",
      persisting: false,
    };
  }

  const ageSeconds = status.lastSuccessAt > 0 ? Math.max(0, Math.round((now - status.lastSuccessAt) / 1000)) : null;

  if (status.disabled) {
    return {
      verdict: "disabled",
      ageSeconds,
      lastBytes: status.lastBytes,
      consecutiveFailures: status.consecutiveFailures,
      summary:
        `Checkpointing is OFF: ${status.disabledReason || "no reason recorded"}. ` +
        "Everything written here — including any key typed into the console — is lost when this instance stops.",
      persisting: false,
    };
  }

  if (status.consecutiveFailures > 0) {
    return {
      verdict: "failing",
      ageSeconds,
      lastBytes: status.lastBytes,
      consecutiveFailures: status.consecutiveFailures,
      summary:
        `${status.consecutiveFailures} checkpoint(s) have failed since the last success` +
        (ageSeconds === null ? ", and none has ever succeeded" : `, ${ageSeconds}s ago`) +
        `. Last error: ${status.lastError || "not recorded"}.`,
      persisting: false,
    };
  }

  if (ageSeconds === null) {
    // Enabled, nothing failing, and nothing has landed. A container that has
    // been up for seconds is fine here; one that has been up for an hour is
    // not, and the caller can tell them apart from the age of the process.
    return {
      verdict: "unknown",
      ageSeconds: null,
      lastBytes: 0,
      consecutiveFailures: 0,
      summary: "Checkpointing is enabled but nothing has landed in R2 yet. Expected within the first minute of a boot.",
      persisting: false,
    };
  }

  if (now - status.lastSuccessAt > STALE_AFTER_MS) {
    return {
      verdict: "stale",
      ageSeconds,
      lastBytes: status.lastBytes,
      consecutiveFailures: 0,
      summary:
        `The last checkpoint R2 accepted was ${ageSeconds}s ago, past the ${STALE_AFTER_MS / 1000}s threshold, ` +
        "and nothing is reporting an error. Writes since then would be lost by a restart.",
      persisting: false,
    };
  }

  return {
    verdict: "ok",
    ageSeconds,
    lastBytes: status.lastBytes,
    consecutiveFailures: 0,
    summary: `Last checkpoint landed ${ageSeconds}s ago, ${status.lastBytes} bytes. A restart would lose at most the last ${ageSeconds}s.`,
    persisting: true,
  };
}

/**
 * Read the status file, or null when there isn't a usable one.
 *
 * Every failure — missing, unreadable, malformed, wrong shape — collapses to
 * null, which assessSnapshot reports as "unknown". A half-parsed status with
 * defaulted fields would be worse than none: a `lastSuccessAt` of 0 filled in
 * for a field that failed to parse reads as "never checkpointed" and would send
 * someone hunting a failure that is really a typo in this file.
 */
export function readSnapshotStatus(home: string): SnapshotStatus | null {
  try {
    const raw = fs.readFileSync(path.join(home, SNAPSHOT_STATUS_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<SnapshotStatus>;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.lastAttemptAt !== "number" || typeof parsed.lastSuccessAt !== "number") return null;
    return {
      lastAttemptAt: parsed.lastAttemptAt,
      lastSuccessAt: parsed.lastSuccessAt,
      lastBytes: typeof parsed.lastBytes === "number" ? parsed.lastBytes : 0,
      lastReason: typeof parsed.lastReason === "string" ? parsed.lastReason : "",
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : "",
      consecutiveFailures: typeof parsed.consecutiveFailures === "number" ? parsed.consecutiveFailures : 0,
      disabled: parsed.disabled === true,
      disabledReason: typeof parsed.disabledReason === "string" ? parsed.disabledReason : "",
      restoredAt: typeof parsed.restoredAt === "number" ? parsed.restoredAt : 0,
      restoredBytes: typeof parsed.restoredBytes === "number" ? parsed.restoredBytes : 0,
    };
  } catch {
    return null;
  }
}
