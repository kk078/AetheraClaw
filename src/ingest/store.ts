import type { MemoryStore } from "../memory/store.js";
import { newId } from "../shared/ids.js";
import { recordAccess } from "../tenancy/store.js";
import type { Extraction, ExtractionSection } from "./extract.js";
import type { PhiSignal } from "../channels/email/classify.js";
import { decryptField, encryptField, resolveEncryptionKey } from "../compliance/encryption.js";
import { readEnv } from "../config/legacy.js";

// ── Where uploaded document text lives ───────────────────────────────────────
// The deployment chose to persist extracted text rather than hold it for the
// turn. That makes this the one table carrying document CONTENT, so every read
// goes through the PHI access log and there is a purge that actually empties it.
//
// The access log is not decoration. §164.312(b) exists because the
// characteristic incident is somebody with legitimate credentials reading a
// record they had no business reading, which leaves no trace at all in a
// mutation log. A store of EOB text with no read trail is that incident with
// the evidence removed.

// ── The encryption key ───────────────────────────────────────────────────────
// Resolved ONCE. Re-reading the environment per row would let a long-running
// process start writing under a different key halfway through, producing a
// database whose rows need two keys and no record of which is which.
//
// Read through a function rather than a top-level constant so a test can point
// it somewhere: a module-level read happens at import time, before any test has
// had a chance to set anything.
let cachedKey: { raw: string; key: Buffer | null } | null = null;
function documentKey(): Buffer | null {
  const raw = readEnv("ENCRYPTION_KEY") ?? "";
  if (!cachedKey || cachedKey.raw !== raw) cachedKey = { raw, key: resolveEncryptionKey(raw).key };
  return cachedKey.key;
}

export interface StoredDocument {
  id: string;
  sessionId: string;
  filename: string;
  kind: string;
  sizeBytes: number;
  sha256: string;
  text: string;
  sections: ExtractionSection[];
  readable: boolean;
  refusal: string;
  confidence: number;
  phi: PhiSignal[];
  notes: string[];
  createdAt: number;
}

/** The actor recorded for an action the agent took on the user's behalf. */
export const AGENT_ACTOR = "agent";

/**
 * Save an extraction, or return the existing row for identical bytes.
 *
 * Deduplicated by SHA-256 WITHIN a session: the same EOB dropped twice is one
 * document, and a second row would make an exposure count read as two
 * disclosures of two files. Across sessions they stay separate, because a
 * different session is a different context in which somebody chose to upload it.
 *
 * `archiveId` groups the documents that came out of one uploaded archive. It is
 * optional and defaulted, so every existing caller is unchanged — a direct
 * upload stores '' and reads exactly as it did before.
 */
export function saveDocument(
  store: MemoryStore,
  sessionId: string,
  e: Extraction,
  at = Date.now(),
  archiveId = "",
  /**
   * Who caused this write.
   *
   * Defaults to the agent, which is the truth for anything the model does on
   * its own. The gateway passes the VERIFIED identity from Cloudflare Access
   * instead, because §164.312(b) asks a log to record who — and "agent" answers
   * that question with the name of the software rather than the name of a
   * person. On a single-operator laptop those were the same thing; on a hosted
   * deployment with several coders signed in they are not, and an access review
   * that cannot separate them is not an access review.
   */
  actor: string = AGENT_ACTOR,
): StoredDocument {
  const existing = store.db
    .prepare("SELECT id FROM documents WHERE sha256 = ? AND session_id = ?")
    .get(e.sha256, sessionId) as { id: string } | undefined;
  // A dedup hit still returns the full stored text to the caller (and thence to
  // the model), so it is a READ and is logged as one. The original write was
  // logged at first upload; treating this later disclosure as "already logged"
  // left a §164.312(b) gap precisely on the re-access path. loadDocument logs by
  // default — the point is to NOT pass { log: false } here.
  if (existing) return loadDocument(store, existing.id)!;

  const id = newId("doc");
  store.db
    .prepare(
      `INSERT INTO documents
         (id, session_id, filename, kind, size_bytes, sha256, text, sections_json, readable, refusal, confidence, phi_json, notes_json, archive_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      sessionId,
      e.filename,
      e.kind,
      e.sizeBytes,
      e.sha256,
      // Encrypted together, or not at all. sections_json carries the SAME
      // content split by page: encrypting `text` and leaving the sections in
      // the clear would be a feature that reads as protection and provides
      // none.
      encryptIfConfigured(e.text),
      encryptIfConfigured(JSON.stringify(e.sections)),
      e.readable ? 1 : 0,
      e.refusal ?? "",
      e.confidence,
      JSON.stringify(e.phi),
      JSON.stringify(e.notes),
      archiveId,
      at,
    );

  // The write is logged too. It is the moment the content entered the system,
  // and an exposure review that cannot see when a document arrived is missing
  // the first fact it needs.
  recordAccess(store, {
    action: "write",
    resourceType: "document",
    // The internal id, never the filename — a filename is routinely
    // "Rivera, J - EOB 01-15-58.pdf", which would put a name and a date of
    // birth into the access log itself.
    resourceRef: id,
    actor: actor || AGENT_ACTOR,
    tenantSlug: "",
    sourceAddress: "",
    recordCount: 1,
    at,
  });

  return loadDocument(store, id, { log: false })!;
}

function encryptIfConfigured(value: string): string {
  const key = documentKey();
  return key ? encryptField(value, key) : value;
}

function rowToDocument(r: Record<string, unknown>): StoredDocument {
  const parse = <T>(s: unknown, fallback: T): T => {
    try {
      return JSON.parse(String(s)) as T;
    } catch {
      return fallback;
    }
  };
  const key = documentKey();
  // A row written before encryption was turned on has no marker and comes back
  // unchanged, which is what makes enabling it a non-event for an existing
  // install.
  const body = decryptField(String(r.text), key);
  const sectionsRaw = decryptField(String(r.sections_json), key);
  // An unreadable document does not pretend to be an empty one. The refusal
  // text carries the reason, so a coder looking at it is sent to the key rather
  // than to the file they uploaded.
  const notes = parse<string[]>(r.notes_json, []);
  if (!body.ok) notes.unshift(body.why);
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    filename: String(r.filename),
    kind: String(r.kind),
    sizeBytes: Number(r.size_bytes),
    sha256: String(r.sha256),
    text: body.text,
    sections: sectionsRaw.ok ? parse<ExtractionSection[]>(sectionsRaw.text, []) : [],
    readable: Number(r.readable) === 1 && body.ok,
    refusal: body.ok ? String(r.refusal) : body.why,
    confidence: Number(r.confidence),
    phi: parse<PhiSignal[]>(r.phi_json, []),
    notes,
    createdAt: Number(r.created_at),
  };
}

/**
 * Read one document.
 *
 * `log` defaults to TRUE. Reading document content is the access §164.312(b) is
 * about, and a default of false would mean every call site that forgot the
 * option silently read PHI with no trail. The internal calls that pass false
 * are the ones re-reading a row they just wrote, which is already logged as the
 * write.
 */
export function loadDocument(store: MemoryStore, id: string, opts: { log?: boolean; actor?: string } = {}): StoredDocument | null {
  const row = store.db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  if (opts.log !== false) {
    recordAccess(store, {
      action: "read",
      resourceType: "document",
      resourceRef: id,
      actor: opts.actor ?? AGENT_ACTOR,
      tenantSlug: "",
      sourceAddress: "",
      recordCount: 1,
      at: Date.now(),
    });
  }
  return rowToDocument(row);
}

/**
 * Documents in a session, WITHOUT their text.
 *
 * Listing is not reading: a person choosing which document to open should not
 * have to disclose all of them to do it, and a list that carried the content
 * would log one read per row every time the picker was drawn.
 */
export function listDocuments(store: MemoryStore, sessionId?: string): Array<Omit<StoredDocument, "text" | "sections">> {
  const rows = (
    sessionId
      ? store.db.prepare("SELECT * FROM documents WHERE session_id = ? ORDER BY created_at DESC").all(sessionId)
      : store.db.prepare("SELECT * FROM documents ORDER BY created_at DESC").all()
  ) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const { text: _text, sections: _sections, ...rest } = rowToDocument(r);
    return rest;
  });
}

export interface PurgeResult {
  deleted: number;
  /** Bytes of extracted text removed — the figure that says what the store held. */
  charactersRemoved: number;
}

/**
 * Delete stored documents older than a cut-off, or all of them.
 *
 * A delete is logged before it happens rather than after: the row is about to
 * stop existing, and a log written afterwards from a deleted row's id is a log
 * entry nobody can corroborate.
 */
export function purgeDocuments(
  store: MemoryStore,
  opts: { olderThanMs?: number; sessionId?: string; actor?: string } = {},
): PurgeResult {
  const cutoff = opts.olderThanMs ?? Number.MAX_SAFE_INTEGER;
  const rows = (
    opts.sessionId
      ? store.db.prepare("SELECT id, length(text) AS n FROM documents WHERE created_at <= ? AND session_id = ?").all(cutoff, opts.sessionId)
      : store.db.prepare("SELECT id, length(text) AS n FROM documents WHERE created_at <= ?").all(cutoff)
  ) as Array<{ id: string; n: number }>;

  let charactersRemoved = 0;
  for (const r of rows) {
    charactersRemoved += r.n;
    recordAccess(store, {
      action: "delete",
      resourceType: "document",
      resourceRef: r.id,
      actor: opts.actor || AGENT_ACTOR,
      tenantSlug: "",
      sourceAddress: "",
      recordCount: 1,
      at: Date.now(),
    });
    store.db.prepare("DELETE FROM documents WHERE id = ?").run(r.id);
  }

  // An archive row carries the uploaded FILENAME, and a filename is routinely
  // "Rivera, J - EOB 01-15-58.pdf" — a name and a date of birth. Purging the
  // documents while leaving the archive that named them behind would empty the
  // content and keep the index to it, which is not the retention promise
  // `documents purge` makes.
  //
  // Only archives with no surviving documents are removed: a purge scoped by
  // date or session can leave part of a batch in place, and deleting the parent
  // then would orphan what remains.
  try {
    const orphaned = store.db
      .prepare(
        `DELETE FROM document_archives
          WHERE (? = '' OR session_id = ?)
            AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.archive_id = document_archives.id)`,
      )
      .run(opts.sessionId ?? "", opts.sessionId ?? "");
    void orphaned;
  } catch {
    // A database that predates the archive table has nothing to clean up.
  }

  return { deleted: rows.length, charactersRemoved };
}

// ── Uploaded archives ────────────────────────────────────────────────────────
// A .zip of EOBs expands to many documents and, once OCR is involved, takes
// long enough that the upload cannot answer in one request. This row is the
// progress record the console polls and `document_archive_list` reports.
//
// The documents themselves still go through saveDocument into `documents` and
// nowhere else — the README states that nothing but the upload path writes
// document text, and an archive IS the upload path.

export interface ArchiveSkipRecord {
  name: string;
  reason: string;
}

export interface StoredArchive {
  id: string;
  sessionId: string;
  filename: string;
  status: "processing" | "completed" | "failed";
  total: number;
  processed: number;
  failed: number;
  ocrCount: number;
  skipped: ArchiveSkipRecord[];
  notes: string[];
  error: string;
  createdAt: number;
  updatedAt: number;
}

function rowToArchive(r: Record<string, unknown>): StoredArchive {
  const parse = <T>(raw: unknown, fallback: T): T => {
    try {
      return JSON.parse(String(raw ?? "")) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: String(r.id),
    sessionId: String(r.session_id ?? ""),
    filename: String(r.filename ?? ""),
    status: String(r.status ?? "processing") as StoredArchive["status"],
    total: Number(r.total ?? 0),
    processed: Number(r.processed ?? 0),
    failed: Number(r.failed ?? 0),
    ocrCount: Number(r.ocr_count ?? 0),
    skipped: parse<ArchiveSkipRecord[]>(r.skipped_json, []),
    notes: parse<string[]>(r.notes_json, []),
    error: String(r.error ?? ""),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
  };
}

export function createArchive(
  store: MemoryStore,
  sessionId: string,
  filename: string,
  total: number,
  skipped: ArchiveSkipRecord[] = [],
  notes: string[] = [],
  at = Date.now(),
): StoredArchive {
  const id = newId("arc");
  store.db
    .prepare(
      `INSERT INTO document_archives
         (id, session_id, filename, status, total, processed, failed, ocr_count, skipped_json, notes_json, error, created_at, updated_at)
       VALUES (?, ?, ?, 'processing', ?, 0, 0, 0, ?, ?, '', ?, ?)`,
    )
    .run(id, sessionId, filename, total, JSON.stringify(skipped), JSON.stringify(notes), at, at);
  return getArchive(store, id)!;
}

export function updateArchive(
  store: MemoryStore,
  id: string,
  patch: Partial<Pick<StoredArchive, "status" | "processed" | "failed" | "ocrCount" | "error">>,
  at = Date.now(),
): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  // Only the fields actually supplied are written. A whole-row update would
  // race the progress loop against itself and reset counters mid-run.
  if (patch.status !== undefined) (sets.push("status = ?"), args.push(patch.status));
  if (patch.processed !== undefined) (sets.push("processed = ?"), args.push(patch.processed));
  if (patch.failed !== undefined) (sets.push("failed = ?"), args.push(patch.failed));
  if (patch.ocrCount !== undefined) (sets.push("ocr_count = ?"), args.push(patch.ocrCount));
  if (patch.error !== undefined) (sets.push("error = ?"), args.push(patch.error));
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  args.push(at, id);
  store.db.prepare(`UPDATE document_archives SET ${sets.join(", ")} WHERE id = ?`).run(...args);
}

export function getArchive(store: MemoryStore, id: string): StoredArchive | null {
  const row = store.db.prepare("SELECT * FROM document_archives WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToArchive(row) : null;
}

export function listArchives(store: MemoryStore, sessionId?: string, limit = 50): StoredArchive[] {
  const rows = (
    sessionId
      ? store.db
          .prepare("SELECT * FROM document_archives WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
          .all(sessionId, limit)
      : store.db.prepare("SELECT * FROM document_archives ORDER BY created_at DESC LIMIT ?").all(limit)
  ) as Array<Record<string, unknown>>;
  return rows.map(rowToArchive);
}

/** The documents an archive produced. Text is excluded — this is an index, not a read. */
export function documentsInArchive(store: MemoryStore, archiveId: string): Array<Omit<StoredDocument, "text" | "sections">> {
  const rows = store.db
    .prepare(
      `SELECT id, session_id, filename, kind, size_bytes, sha256, readable, refusal, confidence, phi_json, notes_json, archive_id, created_at
         FROM documents WHERE archive_id = ? ORDER BY created_at ASC`,
    )
    .all(archiveId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    sessionId: String(r.session_id ?? ""),
    filename: String(r.filename ?? ""),
    kind: String(r.kind ?? "") as StoredDocument["kind"],
    sizeBytes: Number(r.size_bytes ?? 0),
    sha256: String(r.sha256 ?? ""),
    readable: Number(r.readable ?? 0) === 1,
    refusal: String(r.refusal ?? ""),
    confidence: Number(r.confidence ?? 0),
    phi: (() => {
      try {
        return JSON.parse(String(r.phi_json ?? "[]"));
      } catch {
        return [];
      }
    })(),
    notes: (() => {
      try {
        return JSON.parse(String(r.notes_json ?? "[]"));
      } catch {
        return [];
      }
    })(),
    createdAt: Number(r.created_at ?? 0),
  })) as Array<Omit<StoredDocument, "text" | "sections">>;
}
