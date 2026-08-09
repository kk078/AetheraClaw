import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configDir } from "../../config/config.js";
import { openDatabase } from "../../memory/sqlite.js";
import { assessStaleness, CODE_SETS, currentRelease, type CodeSetId } from "./updates/release-calendar.js";
import { managedReferencePath, type ReferenceDbConfig } from "./reference-db.js";

// ── The managed reference database ───────────────────────────────────────────
// A configured path works, and it is fragile in one specific way: the path
// usually points at Downloads, and Downloads is the folder people empty. An
// install that answers coding questions from a file somebody is one clean-up
// away from deleting is not installed.
//
// So the file can be taken INTO the installation — ~/.aetheraclaw/reference/ —
// where the app owns it, alongside config.json5 and the CMS datasets.
//
// WHAT THIS IS NOT, and the distinction matters:
//
//   Not committed to the repository. Two reasons, either sufficient. It is
//   gigabytes, and repositories are not file servers. And it carries CPT, which
//   is copyright the AMA and cannot be redistributed — shipping it would hand
//   licensed content to everyone who clones this, which is not the practice's
//   licence to give.
//
//   Not merged into aetheraclaw.db. That database is per-tenant and holds the
//   practice's claims and remittances. Folding a gigabyte of shared reference
//   data into it would bloat every tenant's backup with an identical copy, and
//   updating the code sets would mean rewriting a file that holds live claim
//   data. Reference data and transaction data have different lifetimes, and
//   files are the cheapest way to say so.

export function referenceDir(): string {
  return path.join(configDir(), "reference");
}

/** Re-exported from reference-db, which owns it so the lookup path needs no registration. */
export const managedDbPath = managedReferencePath;

export function manifestPath(): string {
  return path.join(referenceDir(), "manifest.json");
}

export interface TableCount {
  name: string;
  rows: number;
}

export interface ReferenceManifest {
  importedAt: number;
  /** Where it came from, so a re-import can be traced to the same origin. */
  sourcePath: string;
  sizeBytes: number;
  /** Of the INSTALLED file. Detects silent corruption and tells two copies apart. */
  sha256: string;
  tables: TableCount[];
  /**
   * Which edition each code set in the file is, where somebody said.
   *
   * Recorded rather than inferred. A code table carries no edition stamp, and
   * guessing one from row counts would produce a staleness verdict about a
   * fiscal year nobody asserted — confident, checkable-looking, and made up.
   */
  editions: Partial<Record<CodeSetId, string>>;
  note: string;
}

export function readManifest(): ReferenceManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), "utf8")) as ReferenceManifest;
  } catch {
    return null;
  }
}

export function writeManifest(m: ReferenceManifest): void {
  fs.mkdirSync(referenceDir(), { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 2));
}

/**
 * Which file the tools should read.
 *
 * An explicit `referenceDbPath` wins, always. Somebody who names a path has
 * said where the data is, and quietly preferring a managed copy would answer
 * from a file they did not choose.
 */
export function resolveReferencePath(cfg: ReferenceDbConfig): string | null {
  if (cfg.referenceDbPath) return cfg.referenceDbPath;
  const managed = managedDbPath();
  return fs.existsSync(managed) ? managed : null;
}

export function sha256Of(file: string): string {
  const hash = crypto.createHash("sha256");
  // Streamed in 8 MB chunks. Reading a 1.24 GB file into a Buffer to hash it
  // works right up until the machine it is running on does not have the memory.
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read === 0) break;
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export interface SpaceCheck {
  ok: boolean;
  neededBytes: number;
  freeBytes: number | null;
  message: string;
}

/**
 * Is there room for the copy?
 *
 * Checked BEFORE writing rather than discovered halfway through. A copy that
 * runs out of disk at 90% leaves a truncated file at the managed path, and a
 * truncated SQLite database opens fine and answers some queries — which is a
 * worse failure than no file at all.
 */
export function checkSpace(sourceBytes: number, dir: string): SpaceCheck {
  let freeBytes: number | null = null;
  try {
    const s = (fs as unknown as { statfsSync?: (p: string) => { bavail: number; bsize: number } }).statfsSync?.(dir);
    if (s) freeBytes = s.bavail * s.bsize;
  } catch {
    freeBytes = null;
  }
  // 10% headroom: VACUUM INTO writes a fresh file and the manifest follows it.
  const needed = Math.ceil(sourceBytes * 1.1);
  if (freeBytes === null) {
    return { ok: true, neededBytes: needed, freeBytes: null, message: "Free space could not be determined on this platform, so the copy is attempted without the check." };
  }
  return freeBytes >= needed
    ? { ok: true, neededBytes: needed, freeBytes, message: "" }
    : {
        ok: false,
        neededBytes: needed,
        freeBytes,
        message: `Needs about ${(needed / 1e9).toFixed(2)} GB free and ${dir} has ${(freeBytes / 1e9).toFixed(2)} GB. Free some space, or leave the file where it is and set healthcare.referenceDbPath instead — reading in place costs no extra disk.`,
      };
}

export function tableCounts(file: string): TableCount[] {
  const db = openDatabase(file, { readonly: true });
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    return names.map((name) => ({
      name,
      rows: Number((db.prepare(`SELECT COUNT(*) AS c FROM "${name.replace(/"/g, '""')}"`).get() as { c: number | bigint }).c),
    }));
  } finally {
    db.close();
  }
}

/**
 * Copy the file into the installation, compacting it on the way.
 *
 * VACUUM INTO rather than a byte copy. It rebuilds the database into the
 * destination, which does three jobs at once: it reclaims whatever free pages
 * the source accumulated, it fails loudly on a source that is corrupt instead
 * of copying the corruption, and it never leaves a half-written file at the
 * destination on failure the way a streamed copy does.
 */
export function installReference(sourcePath: string, opts: { note?: string; editions?: Partial<Record<CodeSetId, string>> } = {}): ReferenceManifest {
  if (!fs.existsSync(sourcePath)) throw new Error(`No such file: ${path.resolve(sourcePath)}`);
  const target = managedDbPath();
  if (path.resolve(sourcePath) === path.resolve(target)) {
    throw new Error("Source and destination are the same file. Nothing to do.");
  }

  fs.mkdirSync(referenceDir(), { recursive: true });
  const space = checkSpace(fs.statSync(sourcePath).size, referenceDir());
  if (!space.ok) throw new Error(space.message);

  // Written beside the target and moved into place, so a failure part-way
  // leaves the previous installed database untouched rather than replacing a
  // working file with a broken one.
  const staging = `${target}.incoming`;
  fs.rmSync(staging, { force: true });
  const src = openDatabase(sourcePath, { readonly: true });
  try {
    src.exec(`VACUUM INTO '${staging.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }

  const counts = tableCounts(staging);
  if (counts.length === 0) {
    fs.rmSync(staging, { force: true });
    throw new Error("The copy has no tables. Nothing was installed, and the file at the source is not a usable reference database.");
  }

  fs.rmSync(target, { force: true });
  fs.renameSync(staging, target);

  const manifest: ReferenceManifest = {
    importedAt: Date.now(),
    sourcePath: path.resolve(sourcePath),
    sizeBytes: fs.statSync(target).size,
    sha256: sha256Of(target),
    tables: counts,
    editions: opts.editions ?? {},
    note: opts.note ?? "",
  };
  writeManifest(manifest);
  return manifest;
}

// ── Staleness ────────────────────────────────────────────────────────────────
// The application cannot fetch a newer copy of this file. There is no upstream
// URL — it is a database somebody assembled, not a published feed — and
// pretending otherwise with an "update" button that silently does nothing would
// be worse than saying so.
//
// What it CAN do is read the calendar. Code sets turn over on published dates,
// so an install whose edition is known can be told it is behind, and one whose
// edition was never recorded can be told that too rather than assumed current.

export interface ReferenceStaleness {
  setId: CodeSetId;
  label: string;
  installed: string | null;
  current: string;
  stale: boolean;
  message: string;
}

export function assessReference(manifest: ReferenceManifest, asOf?: string): ReferenceStaleness[] {
  return (Object.keys(CODE_SETS) as CodeSetId[]).map((setId) => {
    const spec = CODE_SETS[setId];
    const installed = manifest.editions[setId] ?? null;
    const current = currentRelease(setId, asOf);
    if (!installed) {
      return {
        setId,
        label: spec.label,
        installed: null,
        current,
        // NOT called stale. Unknown and out-of-date are different, and reporting
        // an unrecorded edition as stale would send somebody chasing an update
        // they may already have.
        stale: false,
        message: `Edition not recorded. The current release is ${current}; whether the installed table matches it is unknown. Record it with \`aetheraclaw reference edition ${setId}=${current}\` once you have checked.`,
      };
    }
    const s = assessStaleness(setId, installed, asOf);
    return { setId, label: spec.label, installed, current, stale: s.stale, message: s.message };
  });
}

const bytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${(n / 1e3).toFixed(0)} kB`;

export function describeManifest(m: ReferenceManifest, asOf?: string): string {
  const rows = m.tables.reduce((s, t) => s + t.rows, 0);
  const out = [
    `Installed: ${managedDbPath()}`,
    `${bytes(m.sizeBytes)} · ${m.tables.length} tables · ${rows.toLocaleString()} rows`,
    `Imported ${new Date(m.importedAt).toISOString().slice(0, 10)} from ${m.sourcePath}`,
    `sha256 ${m.sha256.slice(0, 16)}…`,
    ...(m.note ? [`Note: ${m.note}`] : []),
    "",
    "Largest tables:",
    ...[...m.tables]
      .sort((a, b) => b.rows - a.rows)
      .slice(0, 8)
      .map((t) => `  ${t.name.padEnd(28)} ${t.rows.toLocaleString().padStart(11)}`),
    "",
    "Code-set editions:",
  ];

  for (const s of assessReference(m, asOf)) {
    const mark = s.installed === null ? "  ?  " : s.stale ? " OLD " : "  ok ";
    out.push(`${mark} ${s.label.padEnd(24)} ${s.message}`);
  }

  out.push(
    "",
    // Said plainly, because "update" implies a fetch and there is none.
    "There is no upstream to pull from: this file was assembled rather than published, so updating it means obtaining a newer copy and re-running `aetheraclaw reference install`. The CMS-derived slices are the exception — ICD-10-CM, NCCI, MUE and MPFS are refreshed independently by `node scripts/fetch-cms-data.mjs`, and those installed files take precedence over anything in here.",
  );
  return out.join("\n");
}

/** Confirm the installed file is byte-for-byte what the manifest recorded. */
export function verifyInstalled(): { ok: boolean; message: string } {
  const m = readManifest();
  if (!m) return { ok: false, message: "No manifest — nothing has been installed through `aetheraclaw reference install`." };
  const file = managedDbPath();
  if (!fs.existsSync(file)) return { ok: false, message: `The manifest describes ${file}, which does not exist. Re-run the install.` };
  const size = fs.statSync(file).size;
  if (size !== m.sizeBytes) {
    return { ok: false, message: `Size changed: manifest says ${m.sizeBytes.toLocaleString()} bytes, file is ${size.toLocaleString()}. Something wrote to it after the import.` };
  }
  const digest = sha256Of(file);
  return digest === m.sha256
    ? { ok: true, message: `Matches the manifest — ${bytes(size)}, sha256 ${digest.slice(0, 16)}….` }
    : { ok: false, message: `sha256 MISMATCH. The file is not what was installed: manifest ${m.sha256.slice(0, 16)}…, file ${digest.slice(0, 16)}…. Re-install from a source you trust.` };
}
