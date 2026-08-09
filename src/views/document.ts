import type { StoredDocument } from "../ingest/store.js";
import type { PhiSignal } from "../channels/email/classify.js";

// ── An uploaded document, as a panel ─────────────────────────────────────────
// Two things have to be visible without scrolling: whether the file was read at
// all, and whether what came out carries patient identifiers. Everything else
// is the text, which is long.

export interface DocumentSectionView {
  label: string;
  text: string;
  characters: number;
}

export interface DocumentView {
  id: string;
  filename: string;
  kind: string;
  sizeBytes: number;
  readable: boolean;
  refusal: string;
  /** 0–1; only meaningful for PDF, where a reading can be partial. */
  confidence: number;
  sections: DocumentSectionView[];
  characters: number;
  phi: PhiSignal[];
  notes: string[];
  /** True when the extracted text is held in the database rather than discarded. */
  stored: boolean;
}

/** Sections longer than this are cut in the VIEW only; the stored text is whole. */
export const SECTION_PREVIEW_CHARS = 4000;

export function buildDocumentView(doc: StoredDocument): DocumentView {
  return {
    id: doc.id,
    filename: doc.filename,
    kind: doc.kind,
    sizeBytes: doc.sizeBytes,
    readable: doc.readable,
    refusal: doc.refusal,
    confidence: doc.confidence,
    sections: doc.sections.map((s) => ({
      label: s.label,
      text: s.text.length > SECTION_PREVIEW_CHARS ? `${s.text.slice(0, SECTION_PREVIEW_CHARS)}\n…` : s.text,
      characters: s.text.length,
    })),
    characters: doc.text.length,
    phi: doc.phi,
    notes: doc.notes,
    stored: true,
  };
}
