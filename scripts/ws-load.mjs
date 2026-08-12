#!/usr/bin/env node
// ── Apply the load the container was under ──────────────────────────────────
// docs/PRODUCTION-ROADMAP.md carried this as an open item for a reason worth
// repeating: the WebSocket saturation was MITIGATED, NOT DIAGNOSED, because
// "reproducing it needs the load the container was under" and there was no way
// to apply that load. This is that way.
//
// The original symptom, recorded on the live deployment: WebSocket connections
// opened in quick succession intermittently failed the UPGRADE with HTTP 500,
// while spaced-out connections succeeded and plain HTTP stayed 200.
//
// What it does that a naive load test does not: half the clients vanish with a
// TCP RST rather than a close handshake. That is what a killed tab, a dropped
// phone connection and a cycled container actually look like to the server, and
// it is the case that produces a socket-level "error" event. A test that closes
// politely never exercises the path where things break.
//
//   node scripts/ws-load.mjs 4180 [rounds] [per-round]
//
// Reports, per run: connections opened, upgrade failures WITH THEIR STATUS, the
// close codes clients actually received, and whether plain HTTP stayed healthy
// throughout. The status and the close code are the diagnosis — a refusal the
// client cannot see is the thing this exists to catch.

import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const WebSocket = require_("ws");

const PORT = process.argv[2] ?? "4180";
const ROUNDS = Number(process.argv[3] ?? 5);
const PER_ROUND = Number(process.argv[4] ?? 40);
const base = `http://127.0.0.1:${PORT}`;

const tally = new Map();
const bump = (k) => tally.set(k, (tally.get(k) ?? 0) + 1);

let opened = 0;
let resets = 0;
let httpFailures = 0;

async function httpProbe() {
  // Plain HTTP through the same process. In the original report this stayed
  // 200 throughout, which is what made it saturation rather than a bad route —
  // so a run where this starts failing is a materially different finding.
  try {
    const res = await fetch(`${base}/healthz`);
    if (!res.ok) {
      httpFailures++;
      bump(`http ${res.status}`);
    }
  } catch {
    httpFailures++;
    bump("http request threw");
  }
}

for (let round = 0; round < ROUNDS; round++) {
  const live = [];
  await Promise.all(
    Array.from(
      { length: PER_ROUND },
      () =>
        new Promise((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
          ws.on("open", () => {
            opened++;
            live.push(ws);
            resolve();
          });
          // The case that matters. A browser cannot read this status, so an
          // upgrade refused here is a refusal the user never learns the reason
          // for — and the client reconnects immediately.
          ws.on("unexpected-response", (_req, res) => {
            bump(`UPGRADE FAILED http ${res.statusCode}`);
            resolve();
          });
          ws.on("close", (code, reason) => {
            bump(`close ${code}${reason?.length ? ` — ${reason.toString().slice(0, 60)}` : ""}`);
          });
          ws.on("error", () => resolve());
          setTimeout(resolve, 5000);
        }),
    ),
  );

  for (const ws of live.slice(0, Math.floor(live.length / 2))) {
    try {
      // RST, not a close frame.
      ws._socket?.resetAndDestroy();
      resets++;
    } catch {
      /* already gone */
    }
  }
  await httpProbe();
  for (const ws of live.slice(Math.floor(live.length / 2))) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 150));
  await httpProbe();
}

console.log(`\n${ROUNDS} rounds x ${PER_ROUND} connections against ${base}\n`);
console.log(`  opened            ${opened}`);
console.log(`  killed with RST   ${resets}`);
console.log(`  HTTP failures     ${httpFailures}${httpFailures === 0 ? "  (plain HTTP stayed healthy)" : ""}`);
console.log("\n  what clients saw:");
for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(v).padStart(5)} x  ${k}`);
}
const invisible = [...tally].filter(([k]) => k.startsWith("UPGRADE FAILED"));
console.log(
  invisible.length > 0
    ? "\n  UPGRADE FAILURES PRESENT. A browser cannot read an HTTP status on a failed\n" +
        "  handshake, so each of these is a refusal the client cannot act on."
    : "\n  No upgrade failures: every refusal arrived as a close code the client can read.",
);
