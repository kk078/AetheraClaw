import { detectKind, extractDocument, type Extraction } from "./extract.js";
import { looksLikeZip, readZipReport } from "./zip.js";

// ── An archive of documents ──────────────────────────────────────────────────
// A payer portal hands over a batch as one .zip: forty EOBs, a cover letter,
// and whatever the operator's machine put in there on the way. This turns that
// into one result per file, and the point of it is the accounting — every
// member of the archive ends up in exactly one of three places:
//
//   entries  — it was read, or it was refused for a reason about that FILE (a
//              scan, a partial PDF). A refusal is still an entry: "this EOB is
//              a scan" is the answer the operator needs, in the row for that
//              EOB, not an absence.
//   skipped  — nothing could be done with it at all, with the reason named.
//   nowhere  — it was packaging rather than a document (see isNoiseEntry).
//
// Nothing may fall out silently. In a forty-file batch the count is what an
// operator checks against, and a file that vanishes between the zip and the
// table is one they will believe was processed.

export interface ArchiveEntryResult {
  name: string;
  /**
   * The member's uncompressed bytes, carried rather than re-derived. Whatever
   * runs after expansion — OCR over the pages of a PDF that came back with no
   * text layer — would otherwise have to inflate the whole archive a second
   * time to recover one file, doubling exactly the work the caps in zip.ts are
   * sized against. It is the same Buffer readZipReport already holds, not a copy.
   */
  bytes: Buffer;
  extraction: Extraction;
}

export interface ArchiveSkip {
  name: string;
  reason: string;
}

export interface ArchiveExpansion {
  entries: ArchiveEntryResult[];
  skipped: ArchiveSkip[];
  /** Facts about the expansion itself — a cap that was hit, a container that was not one. */
  notes: string[];
}

/**
 * How many members are expanded before the rest are counted and left.
 *
 * Every entry costs a full extraction — a PDF's glyphs decoded through its own
 * fonts — so an archive of thousands would hold a request open for minutes.
 * Two hundred is well past any batch a person assembles by hand.
 */
export const DEFAULT_MAX_ENTRIES = 200;

/** Filenames the zip carries that nobody put there on purpose. */
const NOISE_BASENAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

/**
 * True for a member that is archive PACKAGING rather than a document.
 *
 * These are excluded silently, and that is the one place silence is right:
 * `__MACOSX/._eob.pdf` is the resource fork macOS writes beside every file
 * when it zips a folder, so a 40-file batch made on a Mac arrives with 80
 * members. Reporting the other 40 as "skipped — unreadable" buries the real
 * skips in noise the operator never chose to send.
 */
export function isNoiseEntry(name: string): boolean {
  // Directory records carry no content; there is nothing to extract from one.
  if (name.endsWith("/")) return true;
  const parts = name.split("/");
  if (parts.includes("__MACOSX")) return true;
  const base = parts[parts.length - 1] ?? "";
  if (base === "") return true;
  if (base.startsWith(".")) return true;
  return NOISE_BASENAMES.has(base.toLowerCase());
}

/**
 * Read every document in an archive, one result per file.
 *
 * Pure: the buffer goes in, results come out, nothing is written and nothing
 * is fetched. It throws only what `readZipReport` throws — a decompression
 * bomb, which is a refusal of the whole container rather than a partial answer.
 */
export function expandArchive(buf: Buffer, opts: { maxEntries?: number } = {}): ArchiveExpansion {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries: ArchiveEntryResult[] = [];
  const skipped: ArchiveSkip[] = [];
  const notes: string[] = [];

  if (!looksLikeZip(buf)) {
    // Not an exception: this is reached from a path that already believes it
    // holds an archive, and "it is not one" is a finding to report next to the
    // others rather than a crash for the caller to translate.
    notes.push("This is not a ZIP container — there is no archive here to expand.");
    return { entries, skipped, notes };
  }

  const report = readZipReport(buf);
  // The container's own skips come through unchanged. They are the reason this
  // function can promise that every member is accounted for.
  for (const s of report.skipped) skipped.push({ name: s.name, reason: s.reason });

  const members = [...report.entries].filter(([name]) => !isNoiseEntry(name));
  for (const [name, bytes] of members.slice(0, maxEntries)) {
    // A zip inside a zip is not recursed. The caps in zip.ts are per archive,
    // so each level of nesting multiplies what a 32 MB upload can inflate to —
    // that shape IS the decompression bomb. An OOXML file is a zip too, which
    // is why this asks detectKind rather than looking at the magic bytes: a
    // .docx must still be read as a document.
    if (detectKind(name, bytes) === "archive") {
      skipped.push({
        name,
        reason: "A ZIP inside the ZIP. Nested archives are not expanded — the size caps here are per archive, so each level of nesting multiplies what the upload can inflate to. Unpack it and send the files it holds.",
      });
      continue;
    }
    // extractDocument never throws: a file it cannot read comes back with
    // readable: false and a reason about that file. That is an ENTRY, not a
    // skip — "this EOB is a scan" belongs in the row for that EOB.
    entries.push({ name, bytes, extraction: extractDocument(name, bytes) });
  }

  const remaining = members.length - Math.min(members.length, maxEntries);
  if (remaining > 0) {
    notes.push(`${remaining} further entries were not processed — this expands at most ${maxEntries} files from one archive.`);
  }

  return { entries, skipped, notes };
}
