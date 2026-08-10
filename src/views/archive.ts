// ── A dropped archive, as a manifest ─────────────────────────────────────────
// Somebody drops a .zip of a month's correspondence: EOB PDFs, an 835, a
// spreadsheet, and — every time — a handful of entries that did not come out
// the other side. The one question this panel answers is per-file: what
// happened to THIS one?
//
// The document view answers that for a single upload. An archive cannot reuse
// it, because the interesting facts are the ones that would be lost in an
// aggregate: "47 of 50 read" is a number that reads as success and hides the
// three files somebody has to go find in their inbox.
//
// Two rules follow from that, and both are enforced here rather than in the
// browser:
//
//   Nothing is silently dropped. The row list is capped, and what the cap left
//   out is REPORTED as a count. A table that quietly ends at fifty is a table
//   that lies about the archive.
//
//   The rows that need a human sort first. A fifty-row cap that spends itself
//   on successes and cuts the three failures is the wrong fifty, however
//   faithfully it renders.

/**
 * What became of one entry.
 *
 * `ocr` is deliberately not folded into `read`. The characters came from a
 * machine's guess at pixels, and an operator reconciling a payment against an
 * OCR'd EOB is doing something different from one reading extracted text — so
 * the table must say which at a glance rather than in a note underneath.
 *
 * `refused` is a decision the reader made (encrypted, too large, a format it
 * will not parse); `skipped` is the reader failing to decode the entry at all.
 * Both need a person and they need different people, so they stay apart.
 */
export type ArchiveRowStatus = "read" | "ocr" | "refused" | "skipped";

export interface ArchiveRow {
  filename: string;
  kind: string;
  status: ArchiveRowStatus;
  characters: number;
  /**
   * Identifier signal KINDS only — "ssn", "mbi".
   *
   * Never a value, and never a count either: a manifest of fifty files is a
   * wide surface, and "ssn ×3" beside a filename is a small piece of the
   * record it is describing. The document view shows counts for one file the
   * operator already opened; a list does not need them to say "this one
   * carries identifiers".
   */
  phi: string[];
  /** What the classifier made of it — "denial", "remittance". */
  classification?: string;
  /** The handler the entry was routed to — "era_parse_835". */
  routeTo?: string;
  /** Why it was refused, or why it could not be decoded. Absent otherwise. */
  detail?: string;
  /** Present once the extracted text is stored and addressable. */
  documentId?: string;
}

export interface ArchiveViewData {
  archiveId: string;
  filename: string;
  status: "processing" | "completed" | "failed";
  /** Entries in the archive — ALL of them, not the number of rows below. */
  total: number;
  read: number;
  ocr: number;
  refused: number;
  skipped: number;
  /** At most MAX_ARCHIVE_ROWS, worst-first. */
  rows: ArchiveRow[];
  /** How many entries the cap left out. Zero when the table is whole. */
  truncated: number;
  notes: string[];
}

/**
 * The row cap.
 *
 * A number, not a boolean "truncated" flag as batch_heal carries: that view
 * measures a query that hit a limit and genuinely cannot say how much was
 * beyond it. Here the entries were all enumerated, so the remainder is known
 * and reporting it as "and 214 more" costs nothing.
 */
export const MAX_ARCHIVE_ROWS = 50;

/** What an entry looks like before the view has decided anything about it. */
export interface ArchiveEntryInput {
  filename: string;
  kind: string;
  status: ArchiveRowStatus;
  characters?: number;
  /**
   * Accepts detector output (`{ kind, count, hint }`) as well as bare kinds,
   * and keeps only the kind. Taking PhiSignal here rather than making every
   * caller remember to strip it is the point: the narrowing happens once, in
   * the place that is tested, instead of at each call site that could forget.
   */
  phi?: ReadonlyArray<string | { kind: string }>;
  classification?: string;
  routeTo?: string;
  detail?: string;
  documentId?: string;
}

export interface ArchiveViewInput {
  archiveId: string;
  filename: string;
  status: "processing" | "completed" | "failed";
  entries: ReadonlyArray<ArchiveEntryInput>;
  notes?: readonly string[];
}

/**
 * Display order: the entries a person has to do something about, then the ones
 * a machine guessed at, then the ones that simply worked.
 *
 * `refused` and `skipped` share the top rank rather than being ordered against
 * each other. Both are work and neither is more urgent in general — putting
 * every refusal above every undecodable entry would be an invented priority,
 * and inside a rank the archive's own order is preserved so the table still
 * reads like the file it came from.
 */
const RANK: Record<ArchiveRowStatus, number> = {
  refused: 0,
  skipped: 0,
  ocr: 1,
  read: 2,
};

function toRow(e: ArchiveEntryInput): ArchiveRow {
  return {
    filename: e.filename,
    kind: e.kind,
    status: e.status,
    characters: e.characters ?? 0,
    // Deduplicated: two SSN-shaped hits in one file is still "this file has
    // SSNs", which is the whole of what the column says.
    phi: [...new Set((e.phi ?? []).map((p) => (typeof p === "string" ? p : p.kind)).filter((k) => k.length > 0))],
    ...(e.classification ? { classification: e.classification } : {}),
    ...(e.routeTo ? { routeTo: e.routeTo } : {}),
    ...(e.detail ? { detail: e.detail } : {}),
    ...(e.documentId ? { documentId: e.documentId } : {}),
  };
}

export function buildArchiveView(input: ArchiveViewInput): ArchiveViewData {
  const all = input.entries.map(toRow);

  // Counted over EVERY entry, before the cap. The counts and the rows answer
  // different questions — "what is in the archive" and "what can I show you" —
  // and deriving the first from the second is how a manifest ends up claiming
  // the archive held fifty files.
  const count = (s: ArchiveRowStatus) => all.filter((r) => r.status === s).length;

  const ordered = all
    .map((row, index) => ({ row, index }))
    // The index tiebreak is explicit rather than leaning on a stable sort: the
    // ordering is a promise this view makes, so it is written down.
    .sort((a, b) => RANK[a.row.status] - RANK[b.row.status] || a.index - b.index)
    .map((r) => r.row);

  return {
    archiveId: input.archiveId,
    filename: input.filename,
    status: input.status,
    total: all.length,
    read: count("read"),
    ocr: count("ocr"),
    refused: count("refused"),
    skipped: count("skipped"),
    rows: ordered.slice(0, MAX_ARCHIVE_ROWS),
    truncated: Math.max(0, all.length - MAX_ARCHIVE_ROWS),
    notes: [...(input.notes ?? [])],
  };
}
