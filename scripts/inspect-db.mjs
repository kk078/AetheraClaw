#!/usr/bin/env node
// ── SQLite schema inspector ──────────────────────────────────────────────────
// Prints what is inside a SQLite file so you can decide whether to attach it as
// a reference database (`healthcare.referenceDbPath`) before Orion reads
// a single row of it.
//
//   node scripts/inspect-db.mjs /path/to/reference.db
//
// SAMPLE VALUES ARE REDUCED TO THEIR SHAPE, NOT PRINTED. A file of unknown
// provenance may hold patient data, and a schema dump that pastes three real
// rows into a terminal — and from there into a chat log, a ticket, a support
// email — has leaked exactly what everything downstream is built to prevent.
// So "1985-03-12" prints as `date` and "J. Rivera" as `text(9)`. You learn that
// the column holds dates without learning whose.
//
// Opened read-only through the same driver adapter the application uses, so it
// works on a machine with better-sqlite3 and on one with only Node's built-in
// SQLite (22.5+), and so it cannot alter a file you may not be able to replace.
//
// Zero dependencies beyond the repo itself, same as the CMS fetcher: this has
// to run on a stock Windows install before anything is configured.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

function openReadOnly(file) {
  if (process.env.ORION_SQLITE !== "node") {
    try {
      const Database = require_("better-sqlite3");
      const db = new Database(file, { readonly: true });
      return { db, driver: "better-sqlite3", close: () => db.close() };
    } catch (err) {
      // Only fall through when the module is missing. A file that will not open
      // is a real failure and must not be reported as a driver problem.
      if (!/Cannot find module/.test(String(err && err.message))) throw err;
    }
  }
  const { DatabaseSync } = require_("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  return { db, driver: "node:sqlite", close: () => db.close() };
}

// ── Shape, not content ───────────────────────────────────────────────────────
// The vocabulary is deliberately small. It exists to answer "is this column a
// code, a date, a description, a number" — enough to design against, and not
// enough to identify anybody.
export function shapeOf(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "bigint") return Number.isInteger(Number(value)) ? "int" : "real";
  if (value instanceof Uint8Array) return `blob(${value.length})`;
  const s = String(value);
  if (s === "") return "empty";
  if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(s)) return "date";
  if (/^-?\d+$/.test(s)) return `digits(${s.length})`;
  if (/^-?\d*\.\d+$/.test(s)) return "decimal";
  if (/^[A-Za-z][0-9]{4}$/.test(s)) return "letter+4digits";
  if (/^[A-Za-z][0-9][0-9A-Za-z](\.[0-9A-Za-z]{1,4})?$/.test(s)) return "icd10-shaped";
  if (/^[A-Za-z0-9._-]{1,12}$/.test(s)) return `token(${s.length})`;
  return `text(${s.length})`;
}

/** Distinct shapes seen in a sample, most common first — one line per column. */
function summariseColumn(values) {
  const counts = new Map();
  for (const v of values) counts.set(shapeOf(v), (counts.get(shapeOf(v)) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([shape, n]) => `${shape}×${n}`)
    .join(" ");
}

const SAMPLE = 20;

function bytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e3).toFixed(0)} kB`;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/inspect-db.mjs <path-to-sqlite-file>");
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${path.resolve(file)}`);
    process.exit(2);
  }

  const { db, driver, close } = openReadOnly(file);
  const q = (name) => `"${name.replace(/"/g, '""')}"`;
  try {
    const size = fs.statSync(file).size;
    console.log(`${path.resolve(file)}`);
    console.log(`${bytes(size)} · read-only · ${driver}`);
    console.log("");

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    if (tables.length === 0) console.log("(no tables)");

    for (const name of tables) {
      const columns = db.prepare(`PRAGMA table_info(${q(name)})`).all();
      const rowCount = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${q(name)}`).get().c);
      console.log(`${name} — ${rowCount.toLocaleString()} row${rowCount === 1 ? "" : "s"}`);
      const sample = rowCount > 0 ? db.prepare(`SELECT * FROM ${q(name)} LIMIT ${SAMPLE}`).all() : [];
      for (const col of columns) {
        const shapes = sample.length > 0 ? summariseColumn(sample.map((r) => r[col.name])) : "(empty table)";
        console.log(`    ${col.name.padEnd(28)} ${String(col.type || "").padEnd(10)} ${shapes}`);
      }
      console.log("");
    }

    const indexes = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name").all();
    if (indexes.length > 0) {
      console.log("Indexes:");
      for (const ix of indexes) console.log(`    ${ix.tbl_name}.${ix.name}`);
      console.log("");
    }

    console.log("Next: set healthcare.referenceDbPath to this file, then ask the agent for");
    console.log("reference_db_status. Any table whose columns look like patient identifiers");
    console.log("is held back and will not be read until you allow it by name.");
  } finally {
    close();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("inspect-db.mjs")) main();
