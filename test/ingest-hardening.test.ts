import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { readZip } from "../src/ingest/zip.js";
import { extractXlsx, columnIndex, MAX_COLUMN_INDEX } from "../src/ingest/ooxml.js";
import { extractContent, extractPdf } from "../src/ingest/pdf.js";
import { detectKind } from "../src/ingest/extract.js";

// ── Hardening against hostile and pathological documents ─────────────────────
// Each test is a verified audit finding: a zip bomb, an unbounded xlsx column,
// PDF text drawn with operators the reader ignored, an array-form filter, and
// pages returned out of reading order.

/** Build a ZIP; `declaredUncompressed` overrides the central-dir size field to lie. */
function zip(entries: Array<{ name: string; content: Buffer; declaredUncompressed?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const deflated = zlib.deflateRawSync(e.content);
    const uncompressed = e.declaredUncompressed ?? e.content.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, deflated);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + deflated.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

describe("ZIP — decompression-bomb caps", () => {
  it("skips an entry whose declared uncompressed size is over the per-entry cap", () => {
    const buf = zip([
      { name: "ok.xml", content: Buffer.from("<a>fine</a>") },
      { name: "bomb.xml", content: Buffer.from("small"), declaredUncompressed: 500 * 1024 * 1024 },
    ]);
    const parts = readZip(buf);
    expect(parts.get("ok.xml")!.toString()).toBe("<a>fine</a>");
    expect(parts.has("bomb.xml")).toBe(false); // declared too big — skipped, not inflated
  });

  it("still reads an ordinary multi-part container", () => {
    const buf = zip([
      { name: "word/document.xml", content: Buffer.from("<w:t>hi</w:t>") },
      { name: "[Content_Types].xml", content: Buffer.from("<Types/>") },
    ]);
    expect(readZip(buf).get("word/document.xml")!.toString()).toContain("hi");
  });
});

describe("xlsx — column index is bounded", () => {
  it("clamps a pathological cell ref instead of driving a giant padding loop", () => {
    expect(columnIndex("ZZZZZZZZ1")).toBe(MAX_COLUMN_INDEX);
    expect(columnIndex("A1")).toBe(0);
    expect(columnIndex("AA1")).toBe(26);
  });

  it("extracts a crafted sheet with a huge column ref without exhausting memory", () => {
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="ZZZZZZZZ1"><v>2</v></c></row></sheetData></worksheet>`;
    const buf = zip([
      { name: "xl/workbook.xml", content: Buffer.from(`<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>`) },
      { name: "xl/_rels/workbook.xml.rels", content: Buffer.from(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`) },
      { name: "xl/worksheets/sheet1.xml", content: Buffer.from(sheet) },
    ]);
    const wb = extractXlsx(buf);
    expect(wb.sheets[0].rows[0].length).toBeLessThanOrEqual(MAX_COLUMN_INDEX + 1);
  });
});

describe("xlsx — sheet names follow the workbook relationships", () => {
  it("labels reordered tabs by their real worksheet part, not by file index", () => {
    // Tabs dragged so "Denials" (rId2 -> sheet2.xml) sits before "Remittance"
    // (rId1 -> sheet1.xml). Pairing by index would swap the labels.
    const buf = zip([
      {
        name: "xl/workbook.xml",
        content: Buffer.from(
          `<workbook><sheets><sheet name="Denials" r:id="rId2"/><sheet name="Remittance" r:id="rId1"/></sheets></workbook>`,
        ),
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        content: Buffer.from(
          `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
        ),
      },
      { name: "xl/worksheets/sheet1.xml", content: Buffer.from(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>REMIT-ROW</t></is></c></row></sheetData></worksheet>`) },
      { name: "xl/worksheets/sheet2.xml", content: Buffer.from(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>DENIAL-ROW</t></is></c></row></sheetData></worksheet>`) },
    ]);
    const wb = extractXlsx(buf);
    const denials = wb.sheets.find((s) => s.name === "Denials");
    const remit = wb.sheets.find((s) => s.name === "Remittance");
    expect(denials?.rows[0][0]).toBe("DENIAL-ROW");
    expect(remit?.rows[0][0]).toBe("REMIT-ROW");
  });
});

describe("PDF — text drawn with the show operators the reader ignored", () => {
  const noFont = new Map();
  it("reads the ' and \" line-advance show operators", () => {
    const r = extractContent("BT /F1 12 Tf (Hello) ' (world) ' ET", noFont);
    expect(r.text).toContain("Hello");
    expect(r.text).toContain("world");
    expect(r.glyphs).toBeGreaterThan(0);
  });
  it("does not drop a TJ array whose string contains brackets", () => {
    const r = extractContent("BT /F1 12 Tf [([see note] denied)] TJ ET", noFont);
    expect(r.text).toContain("[see note] denied");
  });
});

describe("PDF — array-form /Filter", () => {
  it("decodes a Flate stream declared as /Filter [/FlateDecode]", () => {
    const content = "BT /F1 12 Tf 1 0 0 1 20 700 Tm (Total) Tj ET";
    const compressed = zlib.deflateSync(Buffer.from(content, "latin1"));
    const head = Buffer.from("%PDF-1.7\n");
    const o1 = Buffer.from("1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n");
    const o2 = Buffer.from("2 0 obj\n<</Type /Pages /Count 1 /Kids [3 0 R]>>\nendobj\n");
    const o3 = Buffer.from("3 0 obj\n<</Type /Page /Parent 2 0 R /Contents 4 0 R /Resources <<>>>>\nendobj\n");
    const o4a = Buffer.from(`4 0 obj\n<</Length ${compressed.length} /Filter [/FlateDecode]>>\nstream\n`);
    const o4b = Buffer.from("\nendstream\nendobj\n");
    const tail = Buffer.from("trailer\n<</Root 1 0 R>>\n%%EOF\n");
    const pdf = Buffer.concat([head, o1, o2, o3, o4a, compressed, o4b, tail]);
    const out = extractPdf(pdf);
    expect(out.scanned).toBe(false);
    expect(out.pages[0].text).toContain("Total");
  });
});

describe("PDF — pages in reading order", () => {
  it("walks the page tree rather than returning byte-scan order", () => {
    // Object bytes are laid out A, C, B, but the /Kids order is A, B, C.
    const page = (n: number) =>
      `${n} 0 obj\n<</Type /Page /Parent 2 0 R /Contents 1${n} 0 R /Resources <<>>>>\nendobj\n`;
    const contents = (n: number, text: string) => {
      const c = `BT /F1 12 Tf 1 0 0 1 20 700 Tm (${text}) Tj ET`;
      return `1${n} 0 obj\n<</Length ${c.length}>>\nstream\n${c}\nendstream\nendobj\n`;
    };
    const pdf = Buffer.from(
      "%PDF-1.7\n" +
        "1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n" +
        "2 0 obj\n<</Type /Pages /Count 3 /Kids [3 0 R 5 0 R 4 0 R]>>\nendobj\n" +
        page(3) +
        contents(3, "PAGE-A") +
        page(4) + // C appears in the file BEFORE B
        contents(4, "PAGE-C") +
        page(5) +
        contents(5, "PAGE-B") +
        "trailer\n<</Root 1 0 R>>\n%%EOF\n",
      "latin1",
    );
    const out = extractPdf(pdf);
    expect(out.pages.map((p) => p.text)).toEqual(["PAGE-A", "PAGE-B", "PAGE-C"]);
  });
});

describe("detectKind — UTF-8 text is not mistaken for binary", () => {
  it("accepts text and CSV containing smart quotes and en-dashes", () => {
    expect(detectKind("note.txt", Buffer.from("John’s claim was denied", "utf8"))).toBe("text");
    expect(detectKind("data.csv", Buffer.from("name,range,amt\nJohn,1–2,50\n", "utf8"))).toBe("csv");
  });
  it("still refuses genuinely binary content", () => {
    expect(detectKind("x.bin", Buffer.from([0x00, 0x01, 0x02, 0x03, 0x41]))).toBe("unknown");
  });
});
