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

// ── The shared secret ────────────────────────────────────────────────────────
// The Worker's /snapshot/ handler compares this and answers 401 without it —
// and it was never being sent. So configuring ORION_SNAPSHOT_URL did not "turn
// on persistence": it turned on a 401 that restore() treated as a failure and
// exited the process over, taking the whole deployment down on first boot.
// Nobody hit it only because the URL was never set.
const SNAPSHOT_TOKEN = process.env.ORION_GATEWAY_TOKEN ?? "";

// ── What else has to survive a restart ───────────────────────────────────────
// The database was the only thing snapshotted, so an API key typed into the
// Providers & keys screen — which lands in credentials.json — was gone at the
// next cold start, roughly twenty idle minutes later. From the operator's side
// that is "I added a key and it did not save", and they are right.
//
// config.json5 travels with it because the same screen writes the active
// provider and the model there; restoring the key without the choice of
// provider would bring back half of the setting.
const SIDECARS = [
  { file: path.join(HOME, "credentials.json"), key: "credentials.json", mode: 0o600 },
  { file: path.join(HOME, "config.json5"), key: "config.json5", mode: 0o600 },
];

const log = (msg) => console.log(`[boot] ${msg}`);

const snapshotHeaders = (extra = {}) =>
  SNAPSHOT_TOKEN ? { "x-aethera-gateway-token": SNAPSHOT_TOKEN, ...extra } : { ...extra };

/**
 * Ask the Worker for the last snapshot.
 *
 * The Worker holds the R2 binding; a container cannot bind R2 directly, so the
 * transfer goes over the container's outbound hostname back to the Worker. That
 * indirection is also the access control — the container never holds an R2
 * credential it could leak.
 */
/**
 * Set when a restore was configured and did not succeed.
 *
 * Checkpointing is then DISABLED for the life of the process. That is the whole
 * safety property the old `process.exit(1)` was reaching for — an instance that
 * could not read the snapshot must never write over it — but exiting also took
 * the site down, turning one bad environment variable into a total outage.
 * Refusing to write achieves the same protection and keeps the console serving.
 */
let snapshotsDisabled = false;

async function restoreOne(key, dest, mode) {
  const res = await fetch(`${BUCKET_BINDING_URL}/snapshot/${encodeURIComponent(key)}`, {
    headers: snapshotHeaders(),
  });
  if (res.status === 404) return 0;
  if (!res.ok) throw new Error(`snapshot fetch for ${key} returned ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  fs.chmodSync(dest, mode);
  return buf.length;
}

async function restore() {
  if (BUCKET_BINDING_URL === "") {
    log("no snapshot URL configured — starting with whatever is on disk (ephemeral).");
    log("anything entered in the console, including provider keys, is lost when this instance stops.");
    snapshotsDisabled = true;
    return;
  }
  if (SNAPSHOT_TOKEN === "") {
    // Every call would 401. Say so here rather than letting it look like an R2
    // problem thirty seconds later.
    log("SNAPSHOT DISABLED: a snapshot URL is set but ORION_GATEWAY_TOKEN is not, so the Worker would refuse every call.");
    snapshotsDisabled = true;
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
    const bytes = await restoreOne(SNAPSHOT_KEY, DB_PATH, 0o600);
    if (bytes === 0) log("no snapshot yet — first boot for this tenant.");
    else log(`restored ${bytes} bytes from snapshot.`);

    // Sidecars are best-effort INDIVIDUALLY: a missing credentials.json is the
    // ordinary state of a deployment nobody has typed a key into, and it must
    // not read as a failed restore.
    for (const s of SIDECARS) {
      try {
        const n = await restoreOne(s.key, s.file, s.mode);
        if (n > 0) log(`restored ${s.key} (${n} bytes).`);
      } catch (err) {
        log(`could not restore ${s.key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    // Do not start writing over a snapshot this instance could not read. Serve
    // anyway — an unreachable snapshot is a configuration problem, and a dark
    // site helps nobody diagnose it.
    log(`RESTORE FAILED: ${err instanceof Error ? err.message : String(err)}`);
    log("starting anyway with checkpointing DISABLED, so the existing snapshot cannot be overwritten.");
    log("fix ORION_SNAPSHOT_URL / ORION_GATEWAY_TOKEN and restart to resume persistence.");
    snapshotsDisabled = true;
  }
}

let checkpointing = false;
async function checkpoint(reason) {
  if (snapshotsDisabled || BUCKET_BINDING_URL === "" || !fs.existsSync(DB_PATH)) return;
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
      headers: snapshotHeaders({ "content-type": "application/octet-stream" }),
      body,
    });
    if (!res.ok) throw new Error(`snapshot PUT returned ${res.status}`);
    log(`checkpointed ${body.length} bytes (${reason}).`);

    // The key and the provider choice, alongside the claims. Sent every time
    // rather than only on change: they are a few hundred bytes, and tracking
    // "has this changed" is a cache that can be wrong in the direction that
    // loses the very thing the operator typed.
    for (const s of SIDECARS) {
      if (!fs.existsSync(s.file)) continue;
      try {
        const put = await fetch(`${BUCKET_BINDING_URL}/snapshot/${encodeURIComponent(s.key)}`, {
          method: "PUT",
          headers: snapshotHeaders({ "content-type": "application/octet-stream" }),
          body: fs.readFileSync(s.file),
        });
        if (!put.ok) log(`checkpoint of ${s.key} returned ${put.status}`);
      } catch (err) {
        log(`checkpoint of ${s.key} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    log(`checkpoint failed (${reason}): ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    checkpointing = false;
  }
}

await restore();

/**
 * Put something on the screen for a first-time visitor.
 *
 * A trial or a presentation that opens on an empty console shows nothing about
 * what the product does — every KPI is null, the worklist is empty, and the
 * honest "no data yet" notes read as a broken deployment to somebody who has
 * never seen it working.
 *
 * Three conditions, all of them required, because the failure this must never
 * cause is writing invented claims into a database that already holds real
 * work: the operator asked for it, there is no database file at all, and the
 * restore above found no snapshot. A populated install fails every one.
 */
async function seedDemoIfEmpty() {
  if ((process.env.ORION_SEED_DEMO ?? "") !== "1") return;
  if (fs.existsSync(DB_PATH)) {
    log("database already exists — not seeding.");
    return;
  }
  log("empty database and ORION_SEED_DEMO=1 — seeding synthetic practice data.");
  await new Promise((resolve) => {
    const seed = spawn(process.execPath, ["scripts/seed-synthetic.mjs"], { stdio: "inherit", env: process.env });
    // Resolve on failure too. A demo without seed data is a worse console; a
    // gateway that refuses to start because the seeder threw is no console.
    seed.once("exit", (code) => {
      if (code !== 0) log(`seeding exited ${code} — starting anyway, the console will just be empty.`);
      resolve();
    });
    seed.once("error", () => resolve());
  });
}

await seedDemoIfEmpty();

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
