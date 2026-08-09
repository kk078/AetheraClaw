import type { MemoryStore } from "../memory/store.js";
import { newId } from "../shared/ids.js";
import { recordAccess } from "../tenancy/store.js";
import type { Extraction, ExtractionSection } from "./extract.js";
import type { PhiSignal } from "../channels/email/classify.js";

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
 */
export function saveDocument(store: MemoryStore, sessionId: string, e: Extraction, at = Date.now()): StoredDocument {
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
         (id, session_id, filename, kind, size_bytes, sha256, text, sections_json, readable, refusal, confidence, phi_json, notes_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      sessionId,
      e.filename,
      e.kind,
      e.sizeBytes,
      e.sha256,
      e.text,
      JSON.stringify(e.sections),
      e.readable ? 1 : 0,
      e.refusal ?? "",
      e.confidence,
      JSON.stringify(e.phi),
      JSON.stringify(e.notes),
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
    actor: AGENT_ACTOR,
    tenantSlug: "",
    sourceAddress: "",
    recordCount: 1,
    at,
  });

  return loadDocument(store, id, { log: false })!;
}

function rowToDocument(r: Record<string, unknown>): StoredDocument {
  const parse = <T>(s: unknown, fallback: T): T => {
    try {
      return JSON.parse(String(s)) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    filename: String(r.filename),
    kind: String(r.kind),
    sizeBytes: Number(r.size_bytes),
    sha256: String(r.sha256),
    text: String(r.text),
    sections: parse<ExtractionSection[]>(r.sections_json, []),
    readable: Number(r.readable) === 1,
    refusal: String(r.refusal),
    confidence: Number(r.confidence),
    phi: parse<PhiSignal[]>(r.phi_json, []),
    notes: parse<string[]>(r.notes_json, []),
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
export function purgeDocuments(store: MemoryStore, opts: { olderThanMs?: number; sessionId?: string } = {}): PurgeResult {
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
      actor: AGENT_ACTOR,
      tenantSlug: "",
      sourceAddress: "",
      recordCount: 1,
      at: Date.now(),
    });
    store.db.prepare("DELETE FROM documents WHERE id = ?").run(r.id);
  }
  return { deleted: rows.length, charactersRemoved };
}
