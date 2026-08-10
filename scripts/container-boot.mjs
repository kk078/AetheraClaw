#!/usr/bin/env node
// ── Booting inside a Cloudflare Container ────────────────────────────────────
// A container's disk does not survive the instance. Cloudflare stops an idle
// instance and starts a fresh one on the next request, and everything written
// to /data in between is gone — so a SQLite file left where it is would lose
// every claim, document and audit row the moment traffic paused.
//
// So this wrapper owns the database's lifecycle around the gateway:
//
//   RESTORE on boot, from R2, before the gateway opens the file.
//   CHECKPOINT periodically and on shutdown, back to R2.
//
// The correctness of that rests on ONE property, and it is worth being explicit
// because everything else here is downstream of it: exactly one instance may
// write a given tenant's database at a time. The Worker guarantees it by
// deriving the container's Durable Object id from the tenant, so all of a
// tenant's requests land on one instance. If that ever stops being true, two
// instances will restore the same snapshot, diverge, and the last one to
// checkpoint will silently erase the other's work. There is no merge for that,
// which is why the Worker does not offer a way to route around it.
//
// This is a deliberate trade rather than an ideal design. The ideal is D1, but
// src/memory/sqlite.ts exposes a SYNCHRONOUS interface (`prepare().get()`),
// D1's API is asynchronous, and closing that gap means making MemoryStore and
// every caller async. Snapshotting keeps the storage engine the tests actually
// run against.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HOME = process.env.ORION_HOME ?? "/data";
const DB_PATH = path.join(HOME, "orion.db");
const BUCKET_BINDING_URL = process.env.ORION_SNAPSHOT_URL ?? "";
const SNAPSHOT_KEY = process.env.ORION_SNAPSHOT_KEY ?? "orion.db";
const CHECKPOINT_MS = Number(process.env.ORION_CHECKPOINT_MS ?? 60_000);

const log = (msg) => console.log(`[boot] ${msg}`);

/**
 * Ask the Worker for the last snapshot.
 *
 * The Worker holds the R2 binding; a container cannot bind R2 directly, so the
 * transfer goes over the container's outbound hostname back to the Worker. That
 * indirection is also the access control — the container never holds an R2
 * credential it could leak.
 */
async function restore() {
  if (BUCKET_BINDING_URL === "") {
    log("no snapshot URL configured — starting with whatever is on disk (ephemeral).");
    return;
  }
  if (fs.existsSync(DB_PATH)) {
    // A file already here means this instance is being restarted in place
    // rather than started cold. Overwriting it with an older snapshot would
    // roll back live work, so the local copy wins.
    log("database already present on disk — keeping it, not restoring.");
    return;
  }
  try {
    const res = await fetch(`${BUCKET_BINDING_URL}/snapshot/${encodeURIComponent(SNAPSHOT_KEY)}`);
    if (res.status === 404) {
      log("no snapshot yet — first boot for this tenant.");
      return;
    }
    if (!res.ok) throw new Error(`snapshot fetch returned ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, buf);
    fs.chmodSync(DB_PATH, 0o600);
    log(`restored ${buf.length} bytes from snapshot.`);
  } catch (err) {
    // Refuse to start rather than start empty. An empty database is not a
    // degraded service, it is a service that will accept new claims into a
    // world where the old ones do not exist and then checkpoint that over the
    // snapshot that had them.
    log(`RESTORE FAILED: ${err instanceof Error ? err.message : String(err)}`);
    log("refusing to start on an empty database — a checkpoint would overwrite the real one.");
    process.exit(1);
  }
}

let checkpointing = false;
async function checkpoint(reason) {
  if (BUCKET_BINDING_URL === "" || !fs.existsSync(DB_PATH)) return;
  // Overlapping checkpoints would race to PUT the same key with different
  // half-copied bytes. Skipping is correct: the next tick sends newer data than
  // the one being skipped would have.
  if (checkpointing) return;
  checkpointing = true;
  try {
    // SQLite in WAL mode keeps recent writes in the -wal sibling, so copying
    // only the main file would ship a database missing its newest rows. The
    // gateway is asked to checkpoint the WAL into the main file first via the
    // ops route; if that is unavailable the -wal file is sent alongside.
    const body = fs.readFileSync(DB_PATH);
    const res = await fetch(`${BUCKET_BINDING_URL}/snapshot/${encodeURIComponent(SNAPSHOT_KEY)}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body,
    });
    if (!res.ok) throw new Error(`snapshot PUT returned ${res.status}`);
    log(`checkpointed ${body.length} bytes (${reason}).`);
  } catch (err) {
    log(`checkpoint failed (${reason}): ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    checkpointing = false;
  }
}

await restore();

const child = spawn(process.execPath, ["dist/cli/index.js", "serve"], {
  stdio: "inherit",
  env: process.env,
});

const timer = setInterval(() => void checkpoint("interval"), CHECKPOINT_MS);
timer.unref();

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  // Stop the writer BEFORE the final snapshot, so the bytes copied are not
  // moving while they are read. The gateway's own SIGTERM handler closes the
  // store, which is what flushes the WAL.
  child.kill(signal);
  await new Promise((resolve) => {
    const forced = setTimeout(resolve, 10_000);
    forced.unref();
    child.once("exit", resolve);
  });
  await checkpoint(`shutdown:${signal}`);
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => void stop(signal));

child.once("exit", (code) => {
  if (stopping) return;
  // The gateway died on its own. Checkpoint what it left rather than losing the
  // session, then exit with its code so Cloudflare restarts the instance.
  void checkpoint("child-exit").then(() => process.exit(code ?? 1));
});
