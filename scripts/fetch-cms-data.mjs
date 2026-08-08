#!/usr/bin/env node
// ── CMS reference data fetcher ───────────────────────────────────────────────
// Downloads the public CMS files AetheraClaw's offline checks need and converts
// them into the JSON shapes `src/tools/healthcare/datasets.ts` reads, in
// ~/.aetheraclaw/data (or $AETHERACLAW_HOME/data).
//
//   ncci-ptp.json   procedure-to-procedure bundling edits
//   mue.json        medically unlikely edits (units per code, with the MAI)
//   mpfs.json       RVUs and payment policy indicators
//   mpfs-cf.json    the conversion factor, read out of the same RVU file
//   gpci.json       geographic practice cost indices by locality
//   hcpcs.json      HCPCS Level II descriptions
//
// LICENCE, STATED PLAINLY. The NCCI, MUE and MPFS files contain CPT codes,
// which are copyright the American Medical Association. CMS publishes them for
// download and routes the NCCI links through an AMA licence acceptance page.
// Running this script on your own machine, for your own use, is the same act as
// clicking through that page — which is why the files are fetched at runtime and
// NEVER committed to this repository. Do not redistribute what lands in
// ~/.aetheraclaw/data. This is the same posture as `cptDataPath`: the project
// ships the code that reads licensed data, not the data.
//
// No dependencies, and no `unzip` on the PATH — the ZIP reader below is ~60
// lines of zlib, because this has to run on a stock Windows install where the
// only thing you can count on is Node itself.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const UA = "AetheraClaw/0.1 (reference-data fetcher)";

function dataDir() {
  const home = process.env.AETHERACLAW_HOME
    ? process.env.AETHERACLAW_HOME.replace(/^~(?=$|[/\\])/, os.homedir())
    : path.join(os.homedir(), ".aetheraclaw");
  return path.join(home, "data");
}

// ── Minimal ZIP reader ───────────────────────────────────────────────────────
// Central directory → local header → inflateRaw. Enough for CMS's archives and
// deliberately no more: it refuses anything it does not understand rather than
// returning a partial file, because a silently truncated edit table is worse
// than no edit table.

function readZipEntries(buf) {
  // End of central directory: scan back for the signature, allowing a comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP file (no end-of-central-directory record)");

  let count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  // ZIP64: 0xffff/0xffffffff are sentinels meaning "look in the ZIP64 record".
  if (count === 0xffff || ptr === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || buf.readUInt32LE(locator) !== 0x07064b50) throw new Error("ZIP64 archive without a locator");
    const z64 = Number(buf.readBigUInt64LE(locator + 8));
    if (buf.readUInt32LE(z64) !== 0x06064b50) throw new Error("ZIP64 end-of-central-directory not found");
    count = Number(buf.readBigUInt64LE(z64 + 32));
    ptr = Number(buf.readBigUInt64LE(z64 + 48));
  }

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error(`central directory entry ${i} is malformed`);
    const method = buf.readUInt16LE(ptr + 10);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    let localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);

    if (localOffset === 0xffffffff) {
      // The real offset lives in the ZIP64 extra field (header id 0x0001).
      let e = ptr + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = buf.readUInt16LE(e);
        const size = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          // Fields appear in a fixed order, only when their 32-bit slot was a
          // sentinel. Uncompressed and compressed sizes are not sentinels here,
          // so the offset is first.
          localOffset = Number(buf.readBigUInt64LE(e + 4));
          break;
        }
        e += 4 + size;
      }
      if (localOffset === 0xffffffff) throw new Error(`ZIP64 offset missing for ${name}`);
    }

    entries.push({ name, method, localOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extract(buf, entry) {
  if (buf.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(entry.localOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  // The local header's sizes can be zeroed with a trailing data descriptor, so
  // decompress to the end of the buffer and let the stream find its own end.
  const body = buf.subarray(start);
  if (entry.method === 0) return body;
  if (entry.method === 8) return zlib.inflateRawSync(body, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  throw new Error(`${entry.name}: unsupported compression method ${entry.method}`);
}

/** Extract the first entry whose name matches, as text. */
function textFromZip(buf, pattern) {
  const entries = readZipEntries(buf);
  const hit = entries.find((e) => pattern.test(e.name));
  if (!hit) throw new Error(`no entry matching ${pattern} — archive holds: ${entries.map((e) => e.name).join(", ")}`);
  return extract(buf, hit).toString("latin1");
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function get(url, asBuffer = false) {
  const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return asBuffer ? Buffer.from(await res.arrayBuffer()) : res.text();
}

/**
 * Find the newest download link on a CMS index page.
 *
 * Scraped rather than hardcoded because these URLs carry a quarter in their
 * name and change four times a year. A hardcoded URL would work today and 404
 * silently in October, which is the failure this project keeps trying not to
 * ship — so when the scrape finds nothing, it says so and names the page rather
 * than falling back to a stale link.
 */
async function newestLink(pageUrl, pattern) {
  const html = await get(pageUrl);
  const hrefs = [...html.matchAll(/href="([^"]+\.zip)"/g)]
    .map((m) => m[1])
    .filter((h) => pattern.test(h));
  if (hrefs.length === 0) throw new Error(`no download matching ${pattern} on ${pageUrl} — CMS may have restructured the page`);
  // Lexicographically last works because CMS names carry the quarter (…2026q3…).
  const pick = hrefs.sort().at(-1);
  return pick.startsWith("http") ? pick : `https://www.cms.gov${pick.replace(/^\/license\/ama\?file=/, "")}`;
}

const write = (name, value) => {
  const file = path.join(dataDir(), name);
  fs.writeFileSync(file, JSON.stringify(value));
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`  wrote ${name.padEnd(14)} ${String(kb).padStart(7)} KB`);
};

// ── Converters ───────────────────────────────────────────────────────────────

/**
 * NCCI procedure-to-procedure edits.
 *
 * DELETED EDITS ARE DROPPED, and that is the most important line in this file.
 * The published table is cumulative: roughly a third of its rows are edits that
 * once existed and no longer do, each carrying a deletion date. Loading them all
 * would make the scrubber report bundling violations that CMS retired years ago
 * — confident, specific, and wrong, on claims that would have paid.
 */
function convertPtp(text) {
  const edits = [];
  let deleted = 0;
  for (const raw of text.split("\n")) {
    const f = raw.replace(/\r$/, "").split("\t");
    if (f.length < 6) continue;
    const col1 = f[0].trim();
    const col2 = f[1].trim();
    if (!/^[A-Z0-9]{5}$/.test(col1) || !/^[A-Z0-9]{5}$/.test(col2)) continue; // header/preamble rows
    const deletionDate = f[4].trim();
    if (deletionDate && deletionDate !== "*") {
      deleted++;
      continue;
    }
    const indicator = f[5].trim();
    edits.push({ column1: col1, column2: col2, modifierIndicator: indicator });
  }
  return { edits, deleted };
}

/** MUE: units per code, keeping the adjudication indicator — 2 is absolute, 3 is not. */
function convertMue(text) {
  const table = {};
  for (const raw of text.split("\n")) {
    const f = parseCsvLine(raw.replace(/\r$/, ""));
    if (f.length < 3) continue;
    const code = (f[0] ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) continue;
    const units = Number((f[1] ?? "").trim());
    if (!Number.isFinite(units)) continue;
    const mai = ((f[2] ?? "").trim().match(/^(\d)/) ?? [])[1];
    table[code] = mai ? { units, mai } : { units };
  }
  return table;
}

/**
 * MPFS RVUs, policy indicators, and the conversion factor.
 *
 * Rows carrying a modifier (26 professional / TC technical) are SKIPPED. They
 * are components of the same code, and letting one overwrite the global row
 * would silently price every global service at its professional component —
 * roughly a third of the correct amount, with nothing to show it happened.
 */
function convertMpfs(text) {
  const rows = {};
  let cf = null;
  let componentRows = 0;
  for (const raw of text.split("\n")) {
    const f = parseCsvLine(raw.replace(/\r$/, ""));
    if (f.length < 26) continue;
    const code = (f[0] ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) continue;
    if ((f[1] ?? "").trim() !== "") {
      componentRows++;
      continue;
    }
    const num = (i) => {
      const v = Number((f[i] ?? "").trim());
      return Number.isFinite(v) ? v : 0;
    };
    if (cf === null) {
      const c = Number((f[25] ?? "").trim());
      if (Number.isFinite(c) && c > 0) cf = c;
    }
    rows[code] = {
      work: num(5),
      pe: num(6),
      facilityPe: num(8),
      mp: num(10),
      multipleProcedure: (f[18] ?? "").trim(),
      bilateral: (f[19] ?? "").trim(),
      assistantSurgery: (f[20] ?? "").trim(),
      coSurgery: (f[21] ?? "").trim(),
    };
  }
  return { rows, cf, componentRows };
}

/** GPCI by locality, keyed "STATE-LOCALITY" and also by locality name. */
function convertGpci(text) {
  const table = {};
  for (const raw of text.split("\n")) {
    const f = parseCsvLine(raw.replace(/\r$/, ""));
    if (f.length < 7) continue;
    const state = (f[1] ?? "").trim().toUpperCase();
    const localityNo = (f[2] ?? "").trim();
    const name = (f[3] ?? "").trim();
    const work = Number((f[4] ?? "").trim());
    const pe = Number((f[5] ?? "").trim());
    const mp = Number((f[6] ?? "").trim());
    if (!/^[A-Z]{2}$/.test(state) || !Number.isFinite(work) || !Number.isFinite(pe) || !Number.isFinite(mp)) continue;
    const entry = { work, pe, mp };
    // Two keys per locality, because nobody remembers a locality number and the
    // lookup is a plain string match — "TX-31" and "AUSTIN" both land here.
    table[`${state}-${localityNo}`] = entry;
    if (name) table[name.replace(/\*+$/, "").toUpperCase()] = entry;
  }
  return table;
}

/**
 * Code descriptions, taken from the RVU file rather than the HCPCS release.
 *
 * CMS publishes an "alpha-numeric HCPCS file" that looks like the obvious
 * source and is not: the ANWEB record in the 2026 releases carries roughly
 * 1,700 codes and does not contain J1885, E0114, A0428 or G0008 — four of the
 * most-billed HCPCS Level II codes there are. Whatever that file is, it is not
 * the code set, and a converter built on it would answer "not found" for codes
 * that plainly exist.
 *
 * The RVU file's own DESCRIPTION column is validated data covering every PRICED
 * code, which is the set the rest of this system reasons about anyway. What it
 * does NOT cover is unpriced HCPCS — most DME, supplies and drugs. That gap is
 * real, and `hcpcs_lookup` reports a miss as "not found in local data" rather
 * than as a nonexistent code, so the gap reads as a gap.
 */
function descriptionsFrom(text) {
  const table = {};
  for (const raw of text.split("\n")) {
    const f = parseCsvLine(raw.replace(/\r$/, ""));
    if (f.length < 3) continue;
    const code = (f[0] ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) continue;
    if ((f[1] ?? "").trim() !== "") continue; // component row; same description
    const desc = (f[2] ?? "").trim();
    if (desc) table[code] = desc;
  }
  return table;
}

/** Minimal RFC-4180 splitter — CMS quotes descriptions containing commas. */
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

// ── Sources ──────────────────────────────────────────────────────────────────

const NCCI_PTP_PAGE =
  "https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-procedure-procedure-ptp-edits";
const MUE_PAGE =
  "https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-medically-unlikely-edits-mues";
const RVU_PAGE = "https://www.cms.gov/medicare/payment/fee-schedules/physician/pfs-relative-value-files";

/** Which setting's edits to install. Practitioner is the default; a facility passes --hospital. */
const setting = process.argv.includes("--hospital") ? "hospital" : "practitioner";

/**
 * Convert ZIPs already on disk instead of downloading them.
 *
 * CMS's CDN refuses some clients outright — a plain 403 on the index pages,
 * from a network where a browser loads the same page fine. That is the site's
 * decision about automated access and this script does not argue with it: it
 * does not rotate a User-Agent or pretend to be a browser, because a tool that
 * defeats a bot rule to fetch AMA-licensed data is doing something nobody
 * agreed to.
 *
 * The honest route is better anyway. Downloading in a browser is the path that
 * goes THROUGH the AMA licence acceptance page, which the direct-link fetch
 * quietly skips. So: save the ZIPs, point this at the folder, and the same
 * validated converters run offline.
 */
const fromDirArg = process.argv.find((a) => a.startsWith("--from-dir="));
const FROM_DIR = fromDirArg ? fromDirArg.slice("--from-dir=".length) : null;

/** Pick local ZIPs by filename. CMS's names carry the setting and the part number. */
function localZips(pattern) {
  const files = fs.readdirSync(FROM_DIR).filter((f) => f.toLowerCase().endsWith(".zip") && pattern.test(f));
  return files.sort().map((f) => ({ name: f, buf: fs.readFileSync(path.join(FROM_DIR, f)) }));
}

const DOWNLOAD_HELP = [
  "",
  "CMS refused the request. That is the site's decision about automated access, and this script",
  "does not work around it — no User-Agent rotation, no pretending to be a browser.",
  "",
  "Download them yourself instead, which is also the route that goes through the AMA licence page:",
  "",
  `  NCCI PTP  ${NCCI_PTP_PAGE}`,
  "            all FOUR practitioner PTP parts (…-f1.zip through …-f4.zip)",
  `  MUE       ${MUE_PAGE}`,
  "            the practitioner services MUE table",
  `  MPFS      ${RVU_PAGE}`,
  "            the newest RVU quarter (rvu26a…rvu26d)",
  "",
  "Then, with every ZIP saved in one folder:",
  "",
  "  node scripts/fetch-cms-data.mjs --from-dir=C:\\Users\\you\\Downloads\\cms",
  "",
].join("\n");

async function fetchNcci() {
  if (FROM_DIR) return ncciFromDir();
  // The table is split across four files; all four are needed or the edit set
  // has holes, and a hole reads exactly like "no edit exists for this pair".
  const table = {};
  let deleted = 0;
  let kept = 0;
  for (let n = 1; n <= 4; n++) {
    const url = await newestLink(NCCI_PTP_PAGE, new RegExp(`${setting}-ptp-edits.*-f${n}\\.zip$`));
    process.stdout.write(`  part ${n}/4 … `);
    const zip = await get(url, true);
    const text = textFromZip(zip, /\.txt$/i);
    const { edits, deleted: d } = convertPtp(text);
    deleted += d;
    // Written as { COL1: { COL2: indicator } } rather than a list of objects.
    // The array form repeated the three key names 1.7 million times — 105 MB on
    // disk and 2.3 s of JSON.parse before the first scrub could run. Nested, the
    // same edits are a fifth of the size and arrive already indexed.
    for (const e of edits) {
      (table[e.column1] ??= {})[e.column2] = e.modifierIndicator;
      kept++;
    }
    console.log(`${edits.length.toLocaleString()} active`);
  }
  console.log(`  ${deleted.toLocaleString()} retired edit(s) dropped — loading them would flag bundling CMS no longer enforces.`);
  console.log(`  ${kept.toLocaleString()} pair(s) under ${Object.keys(table).length.toLocaleString()} column-1 code(s)`);
  write("ncci-ptp.json", table);
}

/**
 * Same converters, local files.
 *
 * A MISSING PART IS FATAL, not a warning. Each of the four PTP files holds a
 * different slice of the code range, so three of four is not "most of the edits"
 * — it is a table with a silent hole in it, and a pair that falls in the hole
 * reads exactly like a pair CMS never bundled. Installing that is worse than
 * installing nothing, because data_status would report the dataset as present.
 */
function ncciFromDir() {
  const want = setting === "hospital" ? /hospital-ptp-edits.*-f\d\.zip$/i : /practitioner-ptp-edits.*-f\d\.zip$/i;
  const files = localZips(want);
  if (files.length === 0) {
    throw new Error(`no ${setting} PTP zips in ${FROM_DIR} (looking for names like …-${setting}-ptp-edits-…-f1.zip)`);
  }
  const parts = new Set(files.map((f) => (f.name.match(/-f(\d)\./i) ?? [])[1]).filter(Boolean));
  if (parts.size < 4) {
    throw new Error(
      `only ${parts.size} of 4 PTP parts present (found f${[...parts].sort().join(", f")}). ` +
        `Each part holds a different slice of the code range, so a missing one is a silent hole in the edit table — ` +
        `a pair inside it would read as "not bundled" rather than "not checked". Refusing to install a partial table.`,
    );
  }

  const table = {};
  let deleted = 0;
  let kept = 0;
  for (const f of files) {
    const { edits, deleted: d } = convertPtp(textFromZip(f.buf, /\.txt$/i));
    deleted += d;
    for (const e of edits) {
      (table[e.column1] ??= {})[e.column2] = e.modifierIndicator;
      kept++;
    }
    console.log(`  ${f.name} — ${edits.length.toLocaleString()} active`);
  }
  console.log(`  ${deleted.toLocaleString()} retired edit(s) dropped — loading them would flag bundling CMS no longer enforces.`);
  console.log(`  ${kept.toLocaleString()} pair(s) under ${Object.keys(table).length.toLocaleString()} column-1 code(s)`);
  write("ncci-ptp.json", table);
}

function mueFromDir() {
  const want = setting === "hospital" ? /outpatient-hospital.*mue-table\.zip$/i : /practitioner.*mue-table\.zip$/i;
  const files = localZips(want);
  if (files.length === 0) throw new Error(`no ${setting} MUE table zip in ${FROM_DIR}`);
  const table = convertMue(textFromZip(files[0].buf, /\.csv$/i));
  console.log(`  ${files[0].name} — ${Object.keys(table).length.toLocaleString()} code(s) with a unit limit`);
  write("mue.json", table);
}

function mpfsFromDir() {
  const files = localZips(/rvu\d{2}[a-d]/i);
  if (files.length === 0) throw new Error(`no RVU zip in ${FROM_DIR} (looking for a name containing rvu26a…rvu26d)`);
  // Last by name: rvu26c sorts after rvu26b, so the newest quarter present wins.
  const f = files[files.length - 1];
  console.log(`  ${f.name}`);
  writeMpfsFrom(f.buf);
}

/** Shared by the network and local paths so the two cannot diverge. */
function writeMpfsFrom(zip) {
  const rvuCsv = textFromZip(zip, /PPRRVU.*nonQPP\.csv$/i);
  const { rows, cf, componentRows } = convertMpfs(rvuCsv);
  console.log(`  ${Object.keys(rows).length.toLocaleString()} priced code(s); ${componentRows.toLocaleString()} 26/TC component row(s) skipped`);
  write("mpfs.json", rows);
  if (cf) {
    console.log(`  conversion factor ${cf} (read from the same file, not remembered)`);
    write("mpfs-cf.json", { cf });
  } else {
    console.log("  ! no conversion factor found in the RVU file; mpfs-cf.json not written, so the built-in default applies");
  }
  const gpci = convertGpci(textFromZip(zip, /GPCI\d*\.csv$/i));
  console.log(`  ${Object.keys(gpci).length.toLocaleString()} GPCI key(s)`);
  write("gpci.json", gpci);

  const descriptions = descriptionsFrom(rvuCsv);
  console.log(`  ${Object.keys(descriptions).length.toLocaleString()} description(s) for priced codes — see the note in descriptionsFrom about what this does NOT cover`);
  write("hcpcs.json", descriptions);
}

async function fetchMue() {
  if (FROM_DIR) return mueFromDir();
  const url = await newestLink(MUE_PAGE, new RegExp(`${setting === "hospital" ? "outpatient-hospital" : "practitioner"}-services-mue-table\\.zip$`));
  const zip = await get(url, true);
  const table = convertMue(textFromZip(zip, /\.csv$/i));
  console.log(`  ${Object.keys(table).length.toLocaleString()} code(s) with a unit limit`);
  write("mue.json", table);
}

async function fetchMpfs() {
  if (FROM_DIR) return mpfsFromDir();
  // Quarter pages are RVU_PAGE/rvu<yy><a-d>. Probed newest-first rather than
  // scraped: the index page's own hrefs are malformed (the path separators are
  // stripped, giving /medicaremedicare-fee-service-payment…), so scraping it
  // yields links that 404. Probing costs four HEAD-ish requests and cannot be
  // wrong about which quarter is actually published.
  const yy = Number(String(new Date().getFullYear()).slice(2));
  const candidates = [];
  for (const y of [yy, yy - 1]) for (const q of ["d", "c", "b", "a"]) candidates.push(`rvu${String(y).padStart(2, "0")}${q}`);
  let zip = null;
  let lastError = null;
  for (const item of candidates) {
    try {
      const url = await newestLink(`${RVU_PAGE}/${item}`, /\.zip$/);
      zip = await get(url, true);
      console.log(`  ${item}`);
      break;
    } catch (err) {
      // Kept, not swallowed. The first version reported "no usable RVU release
      // found" when every attempt had actually been refused with a 403 — a
      // message that sent the reader looking for a missing file instead of at
      // the refusal, which is the one fact that mattered.
      lastError = err;
    }
  }
  if (!zip) throw new Error(`no RVU release could be retrieved under ${RVU_PAGE} — last attempt: ${lastError?.message ?? "unknown"}`);
  writeMpfsFrom(zip);
}

// ── Main ─────────────────────────────────────────────────────────────────────

// hcpcs.json is written by fetchMpfs — it comes out of the same RVU file.
const ALL = { ncci: fetchNcci, mue: fetchMue, mpfs: fetchMpfs };

async function main() {
  const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7);
  const wanted = only ? only.split(",").map((s) => s.trim()) : Object.keys(ALL);
  const unknown = wanted.filter((w) => !(w in ALL));
  if (unknown.length) {
    console.error(`Unknown dataset(s): ${unknown.join(", ")}. Available: ${Object.keys(ALL).join(", ")}`);
    process.exit(2);
  }

  if (FROM_DIR && !fs.existsSync(FROM_DIR)) {
    console.error(`--from-dir points at ${FROM_DIR}, which does not exist.`);
    process.exit(2);
  }
  fs.mkdirSync(dataDir(), { recursive: true });
  console.log(`AetheraClaw reference data → ${dataDir()}`);
  console.log(FROM_DIR ? `Source: local ZIPs in ${FROM_DIR} (no network)` : "Source: cms.gov");
  console.log(`Setting: ${setting} services${setting === "practitioner" ? "  (pass --hospital for outpatient facility edits)" : ""}`);
  console.log(
    "\nThese files contain CPT codes, copyright the American Medical Association.\n" +
      "CMS publishes them for download under an AMA licence you accept by using them.\n" +
      "They are written to your machine only and must not be redistributed.\n",
  );

  let failed = 0;
  let refused = false;
  for (const name of wanted) {
    console.log(`${name}:`);
    try {
      await ALL[name]();
    } catch (err) {
      failed++;
      if (/HTTP 40[133]/.test(err.message)) refused = true;
      // One dataset failing must not lose the others — they are independent,
      // and a partial install is reported honestly by data_status anyway.
      console.error(`  ! ${name} failed: ${err.message}`);
    }
    console.log("");
  }

  console.log(
    failed === 0
      ? "Done. Run `aetheraclaw` and ask for data_status to confirm what is installed."
      : `Done with ${failed} failure(s). data_status will report exactly what is missing and what that stops you checking.`,
  );
  // A 403 is not a bug to retry into — it is the site declining, and the useful
  // response is telling the reader the route that works rather than leaving them
  // to run the same command again.
  if (refused && !FROM_DIR) console.log(DOWNLOAD_HELP);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
