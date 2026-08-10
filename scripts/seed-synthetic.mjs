#!/usr/bin/env node
// ── Synthetic practice data ──────────────────────────────────────────────────
//
// Almost every analytic in this system reads claims and remittances, so a fresh
// install answers "no data" to most questions and there is no way to see whether
// the analytics are right. This seeds a small practice that exercises them.
//
// Everything here is FABRICATED. The names are invented, the member ids are
// obviously synthetic (SYN-…), the NPIs are the CMS-published test NPIs, and no
// row derives from any real document. That is not a disclaimer, it is the
// design constraint: this deployment is not approved for real patient data, so
// the seed data must be safe to commit, screenshot and paste into an issue.
//
// The shape is chosen so the analytics have something to find rather than a
// uniform happy path:
//   - claims spread across ~15 months, so a real cohort sits PAST the 120-day
//     settle line net collection rate requires, while newer claims still age in
//     AR. A book that is all recent computes no NCR at all — correctly, and
//     unhelpfully for a demo
//   - some still unpaid and ageing, so AR is not all resolved
//   - a contractual-adjustment mix per payer, so payment_variance has a median
//   - denials that matter: CO-197 (no prior auth), CO-97 (bundled), PR-1
//     (deductible), CO-16 (missing info)
//   - a reversal-and-correction pair, so net collection cannot be computed by
//     naive summing
//   - a PLB WO recoupment, so the deposit does not tie to the claims total
//   - two claims deliberately close to a timely-filing limit, so the briefing
//     has something genuinely urgent to lead with
//
// Usage: node scripts/seed-synthetic.mjs [--reset] [--claims N]

import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { resolveDbFile, resolveHome } from "./lib/home.mjs";

const dist = (p) => pathToFileURL(path.join(process.cwd(), "dist", p)).href;
const { MemoryStore } = await import(dist("memory/store.js"));
const { parse835All } = await import(dist("tools/healthcare/x12/835.js"));
const { newId } = await import(dist("shared/ids.js"));

const argv = process.argv.slice(2);
const RESET = argv.includes("--reset");
const N = Number(argv[argv.indexOf("--claims") + 1]) || 40;

// Resolved the same way the gateway resolves it, so seeding cannot write a
// second database next to the one the application actually reads — see
// scripts/lib/home.mjs.
const home = resolveHome();
const dbFile = resolveDbFile(home);
const store = new MemoryStore(dbFile);

// ── Deterministic randomness ────────────────────────────────────────────────
// Seeded so two runs produce the same practice. A seed set that changes every
// run makes "the number moved" impossible to interpret.
let seed = 20260809;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const DAY = 86_400_000;
const now = Date.now();
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

// ── The practice ────────────────────────────────────────────────────────────
// CMS publishes these NPIs for testing; they belong to no real provider.
const BILLING_NPI = "1234567893";
const RENDERING = [
  { npi: "1245319599", name: "Alder Family Medicine" },
  { npi: "1023011178", name: "Alder Family Medicine" },
];

const PAYERS = [
  { name: "Meridian Health Plan", id: "MRDN1", filingDays: 90, allowedFactor: 0.62 },
  { name: "Cascade Mutual", id: "CSCD2", filingDays: 180, allowedFactor: 0.71 },
  { name: "Northgate Medicare Advantage", id: "NGMA3", filingDays: 365, allowedFactor: 0.58 },
];

// Ordinary primary-care work, priced roughly like the real fee schedule.
const SERVICES = [
  { code: "99213", charge: 165, desc: "office visit, established, low" },
  { code: "99214", charge: 245, desc: "office visit, established, moderate" },
  { code: "99395", charge: 210, desc: "preventive visit, established" },
  { code: "36415", charge: 18, desc: "venipuncture" },
  { code: "85025", charge: 42, desc: "CBC with differential" },
  { code: "80053", charge: 58, desc: "comprehensive metabolic panel" },
  { code: "93000", charge: 96, desc: "ECG with interpretation" },
  { code: "20610", charge: 188, desc: "major joint injection" },
];

const DIAGNOSES = ["E11.9", "I10", "E78.5", "M54.50", "J06.9", "E11.65", "Z00.00", "R51.9"];

// Invented. Any resemblance to a real person is coincidence, and the member ids
// are prefixed so nobody can mistake one for a real subscriber number.
const FIRST = ["Wren", "Calder", "Ines", "Osric", "Marisol", "Teodor", "Vesna", "Rune", "Perpetua", "Baste"];
const LAST = ["Quillfeather", "Marchetti", "Okonjo", "Vandersloot", "Bramblewick", "Ferreira", "Lindqvist", "Achterberg"];

function patient(i) {
  return {
    last: LAST[i % LAST.length],
    first: FIRST[i % FIRST.length],
    dob: `${between(1945, 2005)}${String(between(1, 12)).padStart(2, "0")}${String(between(1, 28)).padStart(2, "0")}`,
    member: `SYN-${100000 + i * 37}`,
    sex: pick(["M", "F", "U"]),
  };
}

// ── Claims ──────────────────────────────────────────────────────────────────

function buildClaim(i) {
  const p = patient(i);
  const payer = PAYERS[i % PAYERS.length];
  const prov = pick(RENDERING);
  // Two claims are placed deliberately close to their filing limit so the
  // briefing has a real "about to be lost" item rather than a manufactured one.
  const jeopardy = i === 3 || i === 11;
  // Two thirds of the book is older than the 120-day settle window so the net
  // collection cohort is populated; the rest is recent and still ageing.
  const settled = i % 3 !== 0;
  const ageDays = jeopardy ? payer.filingDays - between(4, 9) : settled ? between(130, 430) : between(2, 110);
  const dos = now - ageDays * DAY;

  const lineCount = between(1, 3);
  const lines = [];
  const used = new Set();
  for (let n = 0; n < lineCount; n++) {
    let s = pick(SERVICES);
    while (used.has(s.code)) s = pick(SERVICES);
    used.add(s.code);
    lines.push({
      cpt_hcpcs: s.code,
      modifiers: s.code === "20610" && rnd() > 0.6 ? ["RT"] : [],
      charge: s.charge,
      units: 1,
      dx_pointers: [1],
      service_date: ymd(dos),
      place_of_service: "11",
    });
  }

  return {
    claimId: `SYN-CLM-${String(1000 + i)}`,
    payer,
    createdAt: dos,
    ageDays,
    claim: {
      claim_id: `SYN-CLM-${String(1000 + i)}`,
      payer_name: payer.name,
      payer_id: payer.id,
      billing_provider_npi: BILLING_NPI,
      billing_provider_name: "Alder Family Medicine",
      rendering_provider_npi: prov.npi,
      subscriber_id: p.member,
      patient_last: p.last,
      patient_first: p.first,
      patient_dob: p.dob,
      patient_sex: p.sex,
      diagnoses: [pick(DIAGNOSES)],
      service_lines: lines,
    },
  };
}

const claims = Array.from({ length: N }, (_, i) => buildClaim(i));

if (RESET) {
  for (const t of ["claims", "remittances", "worklist_items", "filing_proof"]) {
    try {
      store.db.prepare(`DELETE FROM ${t} WHERE id LIKE 'SYN-%' OR id LIKE '%syn%'`).run();
    } catch {
      /* table may not exist yet */
    }
  }
  // Remittance ids are generated, so clear synthetic ones by payer instead.
  try {
    store.db.prepare("DELETE FROM remittances WHERE payer IN (?, ?, ?)").run(...PAYERS.map((p) => p.name));
  } catch {
    /* no table yet */
  }
}

const insertClaim = store.db.prepare(
  "INSERT OR REPLACE INTO claims (id, payer, claim_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
);
for (const c of claims) {
  insertClaim.run(c.claimId, c.payer.name, JSON.stringify(c.claim), "submitted", c.createdAt, c.createdAt);
}

// ── Remittances ─────────────────────────────────────────────────────────────
// Real X12, built segment by segment and handed to the project's own parser, so
// what lands in the database is exactly what a posted remittance produces —
// not a hand-written approximation of one that could drift from the parser.

const SEP = "*";
const TERM = "~";
const seg = (...f) => f.join(SEP) + TERM;

/** One claim's worth of 835 segments. `outcome` decides how the money moves. */
function claimSegments(c, outcome) {
  const out = [];
  const total = c.claim.service_lines.reduce((s, l) => s + l.charge, 0);
  const allowedFor = (l) => Math.round(l.charge * c.payer.allowedFactor * 100) / 100;
  const allowed = c.claim.service_lines.reduce((s, l) => s + allowedFor(l), 0);

  let paid = 0;
  let patientResp = 0;
  let status = "1"; // processed as primary

  if (outcome === "paid") {
    paid = Math.round(allowed * 100) / 100;
  } else if (outcome === "deductible") {
    patientResp = Math.min(allowed, 150);
    paid = Math.round((allowed - patientResp) * 100) / 100;
  } else if (outcome === "denied-auth" || outcome === "denied-bundled" || outcome === "denied-info") {
    paid = 0;
    status = "4"; // denied
  } else if (outcome === "reversal") {
    paid = -Math.round(allowed * 100) / 100;
    status = "22"; // reversal of a previous payment
  }

  out.push(seg("CLP", c.claimId, status, total.toFixed(2), paid.toFixed(2), patientResp.toFixed(2), "MC", `ICN${c.claimId.slice(-4)}0`));
  out.push(seg("NM1", "QC", "1", c.claim.patient_last, c.claim.patient_first, "", "", "", "MI", c.claim.subscriber_id));

  // Claim-level adjustment for the denials, line-level for the money.
  if (outcome === "denied-auth") out.push(seg("CAS", "CO", "197", total.toFixed(2)));
  if (outcome === "denied-bundled") out.push(seg("CAS", "CO", "97", total.toFixed(2)));
  if (outcome === "denied-info") out.push(seg("CAS", "CO", "16", total.toFixed(2)));

  // A denial writes the WHOLE charge off at claim level, so the lines must not
  // also carry a contractual adjustment. Emitting both double-writes the
  // adjustment, shrinks the net-collection denominator below the payments, and
  // produces a rate above 100% — which is how a demo dataset ends up "proving"
  // an impossible number.
  const denied = outcome.startsWith("denied");

  for (const l of c.claim.service_lines) {
    const a = allowedFor(l);
    const contractual = denied ? 0 : Math.round((l.charge - a) * 100) / 100;
    const mods = (l.modifiers ?? []).filter(Boolean);
    const proc = ["HC", l.cpt_hcpcs, ...mods].join(":");
    const linePaid =
      outcome === "paid" ? a : outcome === "deductible" ? Math.max(0, a - 150 / c.claim.service_lines.length) : outcome === "reversal" ? -a : 0;
    out.push(seg("SVC", proc, l.charge.toFixed(2), linePaid.toFixed(2), "", String(l.units)));
    out.push(seg("DTM", "472", l.service_date));
    if (contractual > 0) out.push(seg("CAS", "CO", "45", contractual.toFixed(2)));
    if (outcome === "deductible") out.push(seg("CAS", "PR", "1", (150 / c.claim.service_lines.length).toFixed(2)));
  }
  return { segments: out, paid };
}

/** One 835 per payer, so each carries its own check and its own PLB. */
function buildEra(payer, group, checkNo, withRecoupment) {
  const body = [];
  let deposit = 0;
  for (const { claim, outcome } of group) {
    const { segments, paid } = claimSegments(claim, outcome);
    body.push(...segments);
    deposit += paid;
  }

  // A takeback: the payer keeps $412.75 out of this deposit to recover an
  // earlier overpayment. Positive PLB REDUCES the payment, which is the sign
  // convention the reconciler exists to get right.
  const plb = withRecoupment ? 412.75 : 0;
  const bpr = Math.round((deposit - plb) * 100) / 100;

  const segs = [
    seg("ISA", "00", "          ", "00", "          ", "ZZ", "SYNPAYER       ", "ZZ", "ALDERFAMILY    ", ymd(now).slice(2), "1200", "^", "00501", "000000001", "0", "P", ":"),
    seg("GS", "HP", "SYNPAYER", "ALDERFAMILY", ymd(now), "1200", "1", "X", "005010X221A1"),
    seg("ST", "835", "0001"),
    seg("BPR", "I", bpr.toFixed(2), "C", "ACH", "CCP", "01", "999999999", "DA", "123456789", "1512345678", "", "01", "999988880", "DA", "98765", ymd(now)),
    seg("TRN", "1", checkNo, "1512345678"),
    seg("DTM", "405", ymd(now)),
    seg("N1", "PR", payer.name),
    seg("N1", "PE", "Alder Family Medicine", "XX", BILLING_NPI),
    seg("LX", "1"),
    ...body,
  ];
  if (withRecoupment) segs.push(seg("PLB", BILLING_NPI, ymd(now).slice(0, 4) + "1231", "WO:SYN-CLM-1002", plb.toFixed(2)));
  segs.push(seg("SE", String(segs.length + 1), "0001"), seg("GE", "1", "1"), seg("IEA", "1", "000000001"));
  return segs.join("");
}

// Which claims got remitted, and how. Roughly 70% of the book is adjudicated;
// the rest is still outstanding, which is what makes days-in-AR meaningful.
const OUTCOMES = ["paid", "paid", "paid", "paid", "deductible", "denied-auth", "paid", "denied-bundled", "paid", "denied-info"];
const adjudicated = claims.filter((_, i) => i % 10 !== 7 && i % 10 !== 9).slice(0, Math.floor(N * 0.7));

const byPayer = new Map();
for (const [i, c] of adjudicated.entries()) {
  const outcome = OUTCOMES[i % OUTCOMES.length];
  if (!byPayer.has(c.payer.name)) byPayer.set(c.payer.name, { payer: c.payer, group: [] });
  byPayer.get(c.payer.name).group.push({ claim: c, outcome });
}

// The reversal pair: the same claim paid, then reversed, so anything that sums
// payments naively will disagree with anything that nets them.
const first = adjudicated[0];
if (first) {
  byPayer.get(first.payer.name).group.push({ claim: first, outcome: "reversal" });
}

let eraCount = 0;
let claimRows = 0;
const insertEra = store.db.prepare("INSERT INTO remittances (id, payer, era_json, received_at) VALUES (?, ?, ?, ?)");

for (const [name, { payer, group }] of byPayer) {
  const text = buildEra(payer, group, `CHK${10000 + eraCount}`, name === PAYERS[0].name);
  // The project's own parser, deliberately: a hand-built JSON blob here could
  // drift from what era_parse_835 actually produces, and then every analytic
  // would be tested against data no real remittance can create.
  for (const era of parse835All(text)) {
    insertEra.run(newId("era"), era.payer || name, JSON.stringify(era), now - between(1, 20) * DAY);
    claimRows += era.claims.length;
    eraCount += 1;
  }
}

// ── Worklist ────────────────────────────────────────────────────────────────
// One item per denial, priced and dated, so worklist mode and the briefing have
// real work rather than placeholder rows.

const insertWork = store.db.prepare(
  "INSERT OR REPLACE INTO worklist_items (id, kind, title, detail_json, status, priority, due_at, created_at, updated_at) VALUES (?, 'denial', ?, ?, 'open', ?, ?, ?, ?)",
);
const DENIAL_TEXT = {
  "denied-auth": ["CO-197", "no prior authorization on file"],
  "denied-bundled": ["CO-97", "bundled into another service"],
  "denied-info": ["CO-16", "missing or invalid information"],
};
let workCount = 0;
for (const { payer, group } of byPayer.values()) {
  for (const { claim, outcome } of group) {
    const d = DENIAL_TEXT[outcome];
    if (!d) continue;
    const total = claim.claim.service_lines.reduce((s, l) => s + l.charge, 0);
    // Same title convention the real 835 ingest writes (see denialCandidates in
    // prediction/intake.ts): claim, procedure, CARC and its description. The
    // amount deliberately stays OUT of the title — worklist mode speaks it from
    // detail_json, and having it in both truncated the spoken line mid-figure.
    const proc = claim.claim.service_lines[0]?.cpt_hcpcs ?? "";
    insertWork.run(
      `SYN-WL-${claim.claimId}`,
      `${claim.claimId} (${proc}) — CARC ${d[0].replace(/^..-/, "")}: ${d[1]}`,
      JSON.stringify({ claimId: claim.claimId, payer: payer.name, carc: d[0], reason: d[1], amount: total }),
      total > 300 ? 0.9 : 0.5,
      now + between(5, 40) * DAY,
      now - between(1, 25) * DAY,
      now,
    );
    workCount += 1;
  }
}

// ── Front-end acknowledgments ───────────────────────────────────────────────
// Acceptance rate is measured from 277CA acknowledgments, not from submission
// logs — proof that a payer took the claim, rather than proof that we sent it.
// Most are accepted; a few are front-end rejections, which carry no appeal
// rights and leave the filing clock running.
let acceptedCount = 0;
let rejectedCount = 0;
try {
  const insertProof = store.db.prepare(
    "INSERT OR REPLACE INTO filing_proof (id, claim_id, accepted_on, payer, payer_claim_number, source, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertReject = store.db.prepare(
    "INSERT OR REPLACE INTO worklist_items (id, kind, title, detail_json, status, priority, due_at, created_at, updated_at) VALUES (?, 'rejection', ?, ?, 'open', ?, ?, ?, ?)",
  );
  for (const [i, c] of claims.entries()) {
    const at = c.createdAt + between(1, 3) * DAY;
    if (i % 12 === 5) {
      insertReject.run(
        `SYN-RJ-${c.claimId}`,
        `${c.claimId} — ${c.payer.name} front-end rejection, subscriber not found`,
        JSON.stringify({ claim_id: c.claimId, payer: c.payer.name, category: "A3", reason: "subscriber not found" }),
        0.8,
        at + 20 * DAY,
        at,
        at,
      );
      rejectedCount += 1;
    } else {
      insertProof.run(`SYN-FP-${c.claimId}`, c.claimId, ymd(at), c.payer.name, `ACK${1000 + i}`, "277CA acknowledgment", at);
      acceptedCount += 1;
    }
  }
} catch (err) {
  console.log(`  (skipped acknowledgments: ${err.message})`);
}

const count = (t) => store.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
console.log(`Seeded synthetic practice data into ${dbFile}`);
console.log(`  claims          ${count("claims")}  (${N} written this run, across ${PAYERS.length} payers)`);
console.log(`  remittances     ${count("remittances")}  (${claimRows} adjudicated claim rows, built as X12 and parsed by parse835All)`);
console.log(`  worklist_items  ${count("worklist_items")}  (${workCount} denials written this run)`);
console.log(`  acknowledgments ${acceptedCount} accepted, ${rejectedCount} front-end rejections`);
console.log("\nEverything is fabricated: invented names, SYN- member ids, CMS test NPIs.");
store.close();
