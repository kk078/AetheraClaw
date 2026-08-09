import { createHash } from "node:crypto";
import { detectPhi, type PhiSignal } from "../channels/email/classify.js";
import { extractDocx, extractXlsx, renderWorkbook, type XlsxWorkbook } from "./ooxml.js";
import { MIN_CONFIDENCE, extractPdf, readingConfidence, type PdfText } from "./pdf.js";
import { looksLikeZip } from "./zip.js";

// ── Document ingest ──────────────────────────────────────────────────────────
// One entry point for "the user handed us a file". It decides what the file IS,
// extracts what can be extracted exactly, and refuses where a reading would be
// a guess.
//
// The refusals are the point. Three failures are possible here and only one of
// them is loud on its own:
//
//   A scanned PDF has no text layer. Returning "" is indistinguishable from a
//   blank page, so it is named as a scan and OCR is named as the thing missing.
//
//   A partially-decodable PDF returns text with holes in it. Since the holes
//   fall wherever a font's CMap was absent — and digits are as likely as
//   letters — a low-confidence reading is refused rather than handed on with a
//   caveat nobody reads.
//
//   An image cannot be read at all. No OCR is installed, and the model this
//   deployment is configured against is text-only, so there is no fallback to
//   a vision model either. Both are said plainly rather than one being implied.

export type DocumentKind = "pdf" | "docx" | "xlsx" | "csv" | "text" | "image" | "x12" | "unknown";

export interface ExtractionSection {
  /** "Page 3", "Sheet: Remittance" — how a person refers to this part. */
  label: string;
  text: string;
}

export interface Extraction {
  kind: DocumentKind;
  filename: string;
  sizeBytes: number;
  sha256: string;
  /** Empty when `readable` is false. */
  sections: ExtractionSection[];
  text: string;
  readable: boolean;
  /** Why it could not be read, when it could not. */
  refusal?: string;
  /** 0–1 for formats where a reading can be partial; 1 for exact formats. */
  confidence: number;
  /** Identifier-shaped text found in the extracted content. */
  phi: PhiSignal[];
  /** Facts worth showing that are not the text itself. */
  notes: string[];
}

const IMAGE_MAGIC: Array<{ kind: string; bytes: number[] }> = [
  { kind: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { kind: "JPEG", bytes: [0xff, 0xd8, 0xff] },
  { kind: "GIF", bytes: [0x47, 0x49, 0x46, 0x38] },
  { kind: "BMP", bytes: [0x42, 0x4d] },
  { kind: "TIFF", bytes: [0x49, 0x49, 0x2a] },
];

function imageKind(buf: Buffer): string | null {
  for (const sig of IMAGE_MAGIC) {
    if (sig.bytes.every((b, i) => buf[i] === b)) return sig.kind;
  }
  // A HEIC/AVIF box lives at offset 4.
  if (buf.subarray(4, 8).toString("latin1") === "ftyp") return "HEIC/AVIF";
  return null;
}

/**
 * What a file IS, decided by CONTENT before extension.
 *
 * Same rule as the mail path, for the same reason: in this domain extensions
 * lie constantly. An 835 arrives as `.txt`, a spreadsheet export as `.xls` when
 * it is really XML, and a scanned EOB as `.pdf` when it is really a photograph.
 */
export function detectKind(filename: string, buf: Buffer): DocumentKind {
  const head = buf.subarray(0, 4096).toString("latin1");
  if (head.startsWith("%PDF")) return "pdf";
  if (imageKind(buf)) return "image";
  if (/^\s*ISA[*|^~]/.test(head)) return "x12";

  if (looksLikeZip(buf)) {
    // Both are ZIPs; the parts inside say which. Extension is the tiebreak only
    // when the container is unreadable.
    const inner = buf.toString("latin1");
    if (inner.includes("word/document.xml")) return "docx";
    if (inner.includes("xl/workbook.xml") || inner.includes("xl/worksheets/")) return "xlsx";
    const lower = filename.toLowerCase();
    if (lower.endsWith(".docx")) return "docx";
    if (lower.endsWith(".xlsx")) return "xlsx";
    return "unknown";
  }

  // Binary vs text is decided on the RAW BYTES, not a latin1 decode. The old
  // check ran a printable-character regex over the latin1 string, which mapped a
  // UTF-8 curly quote or en-dash's continuation bytes (0x80-0x9F) to characters
  // no allowed range covered - so an ordinary .txt or .csv with a smart quote,
  // pasted from Word or Outlook, was refused as "not a format this reads". The
  // real binary tell is a NUL byte, or a high proportion of C0 control bytes that
  // are not tab/newline/CR; high bytes (0x80-0xFF) are ordinary UTF-8/Latin-1.
  const bytes = buf.subarray(0, 4096);
  let controls = 0;
  for (const b of bytes) {
    if (b === 0x00) return "unknown";
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) controls++;
  }
  if (bytes.length > 0 && controls / bytes.length > 0.05) return "unknown";
  if (filename.toLowerCase().endsWith(".csv") || /^[^,\n]{1,80}(,[^,\n]{0,80}){2,}/m.test(head)) return "csv";
  return "text";
}

/** Legacy Office formats, which are a different container entirely. */
function legacyOfficeRefusal(filename: string, buf: Buffer): string | null {
  // The OLE compound-document magic that .doc and .xls share.
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (!ole.every((b, i) => buf[i] === b)) return null;
  const lower = filename.toLowerCase();
  const which = lower.endsWith(".xls") ? "Excel 97–2003 (.xls)" : lower.endsWith(".doc") ? "Word 97–2003 (.doc)" : "a legacy Office";
  return `This is ${which} file — the old OLE compound format, not the ZIP-based one this reads. Open it and save as .docx or .xlsx, or export it to CSV. Guessing at BIFF records would produce numbers I could not stand behind.`;
}

function csvSections(text: string): ExtractionSection[] {
  return [{ label: "CSV", text }];
}

function pdfSections(pdf: PdfText): ExtractionSection[] {
  return pdf.pages.map((p) => ({ label: `Page ${p.number}`, text: p.text }));
}

function xlsxSections(wb: XlsxWorkbook): ExtractionSection[] {
  return wb.sheets.map((s) => ({ label: `Sheet: ${s.name}`, text: s.rows.map((r) => r.join("\t")).join("\n") }));
}

/**
 * Read a document.
 *
 * Never throws for a file it simply cannot read — an unreadable file is a
 * result with `readable: false` and a reason, because "the parser crashed" and
 * "this is a scan" are the same outcome to the person holding the file and only
 * one of them is their problem to solve.
 */
export function extractDocument(filename: string, buf: Buffer): Extraction {
  const base: Omit<Extraction, "kind" | "sections" | "text" | "readable" | "confidence" | "phi" | "notes"> = {
    filename,
    sizeBytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
  const fail = (kind: DocumentKind, refusal: string, notes: string[] = []): Extraction => ({
    ...base,
    kind,
    sections: [],
    text: "",
    readable: false,
    refusal,
    confidence: 0,
    phi: [],
    notes,
  });

  const legacy = legacyOfficeRefusal(filename, buf);
  if (legacy) return fail("unknown", legacy);

  const kind = detectKind(filename, buf);

  if (kind === "image") {
    const what = imageKind(buf) ?? "an image";
    return fail(
      "image",
      `This is ${what}. There is no OCR in this build, and the configured model is text-only, so nothing here can read what the picture says. Re-export the source document as a PDF with a text layer, or type the few fields that matter.`,
      ["An image of a document is not a document — the characters exist only as pixels."],
    );
  }

  try {
    let sections: ExtractionSection[];
    let confidence = 1;
    const notes: string[] = [];

    switch (kind) {
      case "pdf": {
        const pdf = extractPdf(buf);
        if (pdf.scanned) {
          return fail(
            "pdf",
            "This PDF has no text layer — every page is an image, which is what a scanner or a fax gateway produces. There is no OCR in this build, so there is nothing to read. Ask the sender for the original, or for the electronic remittance if this is an EOB.",
            [`${pdf.pages.length} page(s), no text-drawing operators on any of them.`, pdf.producer ? `Producer: ${pdf.producer}` : ""].filter(Boolean),
          );
        }
        confidence = readingConfidence(pdf);
        if (confidence < MIN_CONFIDENCE) {
          return fail(
            "pdf",
            `Only ${(confidence * 100).toFixed(0)}% of the glyphs in this PDF could be mapped back to characters, so the reading has holes in it — and the holes fall wherever a font was missing its ToUnicode table, which hits digits as readily as letters. A partial reading of a remittance is worse than none, so it is refused rather than returned with a caveat.`,
            [`${pdf.unresolved} of ${pdf.glyphs} glyphs unresolved.`, pdf.producer ? `Producer: ${pdf.producer}` : ""].filter(Boolean),
          );
        }
        sections = pdfSections(pdf);
        notes.push(`${pdf.pages.length} page(s), ${pdf.glyphs} glyphs, all mapped.`);
        if (pdf.producer) notes.push(`Producer: ${pdf.producer}`);
        break;
      }
      case "docx": {
        const doc = extractDocx(buf);
        sections = [{ label: "Document", text: doc.paragraphs.join("\n") }];
        if (doc.skippedParts.length > 0) {
          // Named because an ADR often carries its deadline in the header, and
          // "no deadline found" would then be a wrong answer rather than a gap.
          notes.push(`Not read: ${doc.skippedParts.join(", ")} — headers, footers and notes are separate parts of the file.`);
        }
        break;
      }
      case "xlsx": {
        const wb = extractXlsx(buf);
        sections = xlsxSections(wb);
        notes.push(`${wb.sheets.length} sheet(s): ${wb.sheets.map((s) => `${s.name} (${s.rows.length} rows)`).join(", ")}.`);
        notes.push("Cell values are the stored values. A formula cell gives its last computed result, which is absent if the file was written by a tool that never evaluated it.");
        break;
      }
      case "csv":
        sections = csvSections(buf.toString("utf8"));
        break;
      case "text":
        sections = [{ label: "Text", text: buf.toString("utf8") }];
        break;
      case "x12":
        return fail(
          "x12",
          "This is an X12 envelope, not a document to read as prose. Pass it to the parser that writes it to the right tables — era_parse_835 for a remittance, ack_parse_277ca for an acknowledgment — rather than extracting text from it.",
        );
      default:
        return fail("unknown", "Not a format this reads: not a PDF, not a Word or Excel file, not text, not an X12 envelope.");
    }

    const text = sections.map((s) => (sections.length > 1 ? `--- ${s.label} ---\n${s.text}` : s.text)).join("\n\n").trim();

    return { ...base, kind, sections, text, readable: true, confidence, phi: detectPhi(text), notes };
  } catch (err) {
    return fail(kind, `This file is a ${kind} that could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A one-line summary of what was found, for the tool's text output. */
export function describeExtraction(e: Extraction): string {
  const kb = (e.sizeBytes / 1024).toFixed(1);
  if (!e.readable) return `${e.filename} — ${e.kind}, ${kb} KB. NOT READ: ${e.refusal}`;
  const chars = e.text.length;
  const phi = e.phi.length > 0 ? ` Identifier-shaped text found: ${e.phi.map((p) => `${p.kind} ×${p.count}`).join(", ")}.` : "";
  return `${e.filename} — ${e.kind}, ${kb} KB, ${chars} characters across ${e.sections.length} section(s).${phi}`;
}

export { renderWorkbook };
