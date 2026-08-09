import { readZip } from "./zip.js";

// ── Word and Excel ───────────────────────────────────────────────────────────
// Both are ZIP containers of XML, so both are readable exactly rather than
// approximately — which is the difference that matters against PDF, where the
// text has been reduced to positioned glyphs and reading it is reconstruction.
// Here the characters are still characters.

/** XML entities that appear in OOXML text. Numeric refs are handled separately. */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeXmlText(s: string): string {
  return s.replace(/&(#x?[0-9A-Fa-f]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number(body.slice(1)));
    return ENTITIES[body] ?? whole;
  });
}

// ── .docx ────────────────────────────────────────────────────────────────────

export interface DocxText {
  paragraphs: string[];
  /** Parts that were present but hold text this does not read — headers, footnotes. */
  skippedParts: string[];
}

/**
 * Text from a Word document, one entry per paragraph.
 *
 * Paragraph structure is kept rather than flattened to one string because a
 * denial letter's meaning is carried by its line breaks: an address block, a
 * claim number on its own line and a paragraph of reasoning become
 * indistinguishable once joined.
 *
 * A `<w:p>` is a paragraph; a `<w:t>` is a run of text inside it. Word splits a
 * single sentence across many runs whenever formatting changes mid-word, so the
 * runs within a paragraph are joined with NOTHING between them — inserting a
 * space there puts one inside "CLM-88213".
 */
export function extractDocx(buf: Buffer): DocxText {
  const parts = readZip(buf);
  const xml = parts.get("word/document.xml");
  if (!xml) throw new Error("Not a Word document — word/document.xml is missing from the container.");
  const text = xml.toString("utf8");

  const paragraphs: string[] = [];
  for (const p of text.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    const body = p[1];
    let line = "";
    // <w:tab/> and <w:br/> are text too; dropping them runs table cells and
    // addressed lines together.
    for (const tok of body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)) {
      if (tok[0].startsWith("<w:tab")) line += "\t";
      else if (tok[0].startsWith("<w:br")) line += "\n";
      else line += decodeXmlText(tok[1]);
    }
    paragraphs.push(line);
  }

  // Named, not silently dropped: a records request often puts its deadline in
  // the header, and "no deadline found" would be a wrong answer.
  const skippedParts = [...parts.keys()].filter((n) => /^word\/(header|footer|footnotes|endnotes)\d*\.xml$/.test(n));

  return { paragraphs, skippedParts };
}

// ── .xlsx ────────────────────────────────────────────────────────────────────

export interface XlsxSheet {
  name: string;
  rows: string[][];
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
}

/** Excel's last column is XFD — 16384 columns, so the highest zero-based index. */
export const MAX_COLUMN_INDEX = 16383;

/** Cell reference "BC12" → zero-based column index, so gaps in a row stay gaps. */
export function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref.toUpperCase())?.[1] ?? "";
  let n = 0;
  for (const ch of letters) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
    // Clamp DURING accumulation, not after: a crafted ref like "ZZZZZZZZ1"
    // overflows to ~2e11, and the padding loop that follows (`while cells.length
    // < idx`) then tries hundreds of billions of pushes and OOM-aborts the
    // process on one upload. No real sheet has a column past XFD.
    if (n > MAX_COLUMN_INDEX + 1) return MAX_COLUMN_INDEX;
  }
  return Math.min(n - 1, MAX_COLUMN_INDEX);
}

function sharedStrings(parts: Map<string, Buffer>): string[] {
  const xml = parts.get("xl/sharedStrings.xml")?.toString("utf8");
  if (!xml) return [];
  // A <si> may hold one <t> or many (rich text runs). Concatenating every <t>
  // inside it is what Excel displays; taking the first loses the rest of a
  // formatted cell.
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((si) =>
    [...si[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeXmlText(t[1])).join(""),
  );
}

interface SheetRef {
  name: string;
  /** The worksheet part this tab points at, e.g. "xl/worksheets/sheet2.xml", or "" if unresolved. */
  file: string;
}

/**
 * Sheets in TAB ORDER, each paired with the worksheet part it actually names.
 *
 * The trap: workbook.xml lists tabs in display order, but a tab's worksheet part
 * is found through its r:id in xl/_rels/workbook.xml.rels — not by matching the
 * i-th tab to the i-th sheetN.xml file. Reordering tabs rewrites workbook.xml
 * order but not the part filenames, so pairing by index labels the remittance
 * rows "Denials" and vice versa. This resolves the relationship instead.
 */
function workbookSheets(parts: Map<string, Buffer>): SheetRef[] {
  const wb = parts.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = parts.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";

  const relTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = m[1];
    const id = /\bId="([^"]+)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
    if (id && target) relTarget.set(id, target);
  }

  const out: SheetRef[] = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const attrs = m[1];
    const name = decodeXmlText(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? "");
    const rid = /\br:id="([^"]+)"/.exec(attrs)?.[1] ?? /\bid="([^"]+)"/.exec(attrs)?.[1] ?? "";
    const rawTarget = rid ? relTarget.get(rid) : undefined;
    // Target is relative to xl/ ("worksheets/sheet1.xml") or absolute
    // ("/xl/worksheets/sheet1.xml"); normalise both to the part key.
    const file = rawTarget ? `xl/${rawTarget.replace(/^\/?xl\//, "").replace(/^\//, "")}` : "";
    out.push({ name, file });
  }
  return out;
}

/**
 * Rows and cells from a workbook.
 *
 * THE TRAP THIS EXISTS TO AVOID: a cell carrying `t="s"` does not hold text, it
 * holds an INDEX into the shared string table. Read literally, a column of claim
 * ids comes back as `0 1 2 3` — numbers, plausible ones, in a system where a
 * number in that position could be a claim id. It is the same class of failure
 * as the PDF glyph decode: wrong data that looks like data.
 *
 * Inline strings (`t="inlineStr"`) and formula cells are handled too; a formula
 * cell's `<v>` is its last computed VALUE, which is what a reader wants and what
 * the file may not have if it was never opened by Excel.
 */
export function extractXlsx(buf: Buffer): XlsxWorkbook {
  const parts = readZip(buf);
  const shared = sharedStrings(parts);

  const filesOnDisk = [...parts.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));

  // Prefer the relationship-resolved tab order; fall back to filename order only
  // when the rels are missing or resolve to nothing, so a malformed workbook
  // still reads (just possibly mislabelled) rather than returning no sheets.
  const resolved = workbookSheets(parts).filter((s) => s.file && parts.has(s.file));
  const plan: SheetRef[] =
    resolved.length > 0
      ? resolved
      : filesOnDisk.map((file, i) => ({ name: workbookSheets(parts)[i]?.name ?? `Sheet${i + 1}`, file }));

  const sheets: XlsxSheet[] = [];
  for (const [i, ref] of plan.entries()) {
    const xml = parts.get(ref.file)!.toString("utf8");
    const rows: string[][] = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of r[1].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const body = c[2] ?? "";
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";

        let value: string;
        if (type === "s") value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeXmlText(t[1])).join("");
        else value = decodeXmlText(v);

        // An empty cell in the middle of a row is omitted from the XML
        // entirely. Pushing values in document order would shift every cell to
        // its left and silently move a paid amount into the charge column.
        if (ref) {
          const idx = columnIndex(ref);
          while (cells.length < idx) cells.push("");
          cells[idx] = value;
        } else {
          cells.push(value);
        }
      }
      rows.push(cells);
    }
    sheets.push({ name: ref.name || `Sheet${i + 1}`, rows });
  }

  return { sheets };
}

/** A workbook rendered as text for the model, one tab-separated line per row. */
export function renderWorkbook(wb: XlsxWorkbook): string {
  const out: string[] = [];
  for (const s of wb.sheets) {
    out.push(`--- sheet: ${s.name} (${s.rows.length} row(s)) ---`);
    for (const r of s.rows) out.push(r.join("\t"));
    out.push("");
  }
  return out.join("\n").trim();
}
