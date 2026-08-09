import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { readZip, looksLikeZip } from "../src/ingest/zip.js";
import { columnIndex, decodeXmlText, extractDocx, extractXlsx } from "../src/ingest/ooxml.js";
import { MIN_CONFIDENCE, extractContent, parseToUnicode, extractPdf, readingConfidence, type GlyphMap } from "../src/ingest/pdf.js";
import { detectKind, describeExtraction, extractDocument } from "../src/ingest/extract.js";
import { sessionTitleFrom } from "../src/agent/runner.js";

// Fixtures are BUILT here rather than checked in as binaries, so what each test
// asserts against is visible in the test.

// ── Building a ZIP by hand ───────────────────────────────────────────────────

function zip(entries: Array<{ name: string; content: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.from(e.content, "utf8");
    const deflated = zlib.deflateRawSync(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
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

describe("the ZIP container", () => {
  it("reads entries through the central directory", () => {
    const buf = zip([
      { name: "a.xml", content: "<a>one</a>" },
      { name: "nested/b.xml", content: "<b>two</b>" },
    ]);
    const parts = readZip(buf);
    expect(parts.get("a.xml")!.toString()).toBe("<a>one</a>");
    expect(parts.get("nested/b.xml")!.toString()).toBe("<b>two</b>");
  });

  it("recognises a container by its signature", () => {
    expect(looksLikeZip(zip([{ name: "x", content: "y" }]))).toBe(true);
    expect(looksLikeZip(Buffer.from("%PDF-1.7"))).toBe(false);
  });

  it("refuses a file that is not a container rather than returning nothing", () => {
    expect(() => readZip(Buffer.from("not a zip at all"))).toThrow(/not a zip container/i);
  });
});

// ── Word ─────────────────────────────────────────────────────────────────────

const docx = (body: string) =>
  zip([
    { name: "[Content_Types].xml", content: "<Types/>" },
    {
      name: "word/document.xml",
      content: `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`,
    },
  ]);

describe("Word documents", () => {
  it("keeps one paragraph per line", () => {
    // A denial letter's meaning is in its line breaks: an address block and a
    // paragraph of reasoning are indistinguishable once joined.
    const doc = extractDocx(docx("<w:p><w:r><w:t>First</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p>"));
    expect(doc.paragraphs).toEqual(["First", "Second"]);
  });

  it("joins runs inside a paragraph with nothing between them", () => {
    // Word splits a word across runs whenever formatting changes mid-word.
    // A space here puts one inside a claim id.
    const doc = extractDocx(docx("<w:p><w:r><w:t>CLM-</w:t></w:r><w:r><w:t>88213</w:t></w:r></w:p>"));
    expect(doc.paragraphs[0]).toBe("CLM-88213");
  });

  it("keeps tabs, so table cells do not run together", () => {
    const doc = extractDocx(docx("<w:p><w:r><w:t>99214</w:t><w:tab/><w:t>225.00</w:t></w:r></w:p>"));
    expect(doc.paragraphs[0]).toBe("99214\t225.00");
  });

  it("names the parts it did not read", () => {
    // A records request often carries its deadline in the header. Silence there
    // turns "not read" into "no deadline".
    const buf = zip([
      { name: "word/document.xml", content: "<w:document xmlns:w='x'><w:body/></w:document>" },
      { name: "word/header1.xml", content: "<hdr/>" },
    ]);
    expect(extractDocx(buf).skippedParts).toContain("word/header1.xml");
  });

  it("says so when the container is not a Word document", () => {
    expect(() => extractDocx(zip([{ name: "xl/workbook.xml", content: "<w/>" }]))).toThrow(/not a word document/i);
  });

  it("decodes XML entities, including numeric ones", () => {
    expect(decodeXmlText("A &amp; B &lt;C&gt; &#36;5 &#x2014; end")).toBe("A & B <C> $5 — end");
  });
});

// ── Excel ────────────────────────────────────────────────────────────────────

const xlsx = (sheet: string, shared?: string) =>
  zip([
    { name: "xl/workbook.xml", content: `<workbook><sheets><sheet name="Remittance"/></sheets></workbook>` },
    ...(shared ? [{ name: "xl/sharedStrings.xml", content: shared }] : []),
    { name: "xl/worksheets/sheet1.xml", content: `<worksheet><sheetData>${sheet}</sheetData></worksheet>` },
  ]);

describe("Excel workbooks", () => {
  it("resolves shared strings instead of printing their index", () => {
    // THE trap. A t="s" cell holds an INDEX, not text. Read literally a column
    // of claim ids comes back as 0,1,2 — numbers, in a system where a number
    // there could plausibly be a claim id.
    const wb = extractXlsx(
      xlsx(
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>`,
        `<sst><si><t>CLM-88213</t></si><si><t>Denied</t></si></sst>`,
      ),
    );
    expect(wb.sheets[0].rows[0]).toEqual(["CLM-88213", "Denied"]);
  });

  it("keeps an omitted cell as a gap rather than shifting the row left", () => {
    // Excel omits empty cells entirely. Appending in document order moves every
    // value one column left — a paid amount lands in the charge column.
    const wb = extractXlsx(xlsx(`<row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row>`));
    expect(wb.sheets[0].rows[0]).toEqual(["1", "", "3"]);
  });

  it("concatenates the runs of a rich-text cell", () => {
    const wb = extractXlsx(
      xlsx(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`, `<sst><si><r><t>CLM-</t></r><r><t>88213</t></r></si></sst>`),
    );
    expect(wb.sheets[0].rows[0][0]).toBe("CLM-88213");
  });

  it("reads inline strings", () => {
    const wb = extractXlsx(xlsx(`<row r="1"><c r="A1" t="inlineStr"><is><t>Aetna</t></is></c></row>`));
    expect(wb.sheets[0].rows[0][0]).toBe("Aetna");
  });

  it("takes the sheet name from the workbook", () => {
    expect(extractXlsx(xlsx(`<row r="1"><c r="A1"><v>1</v></c></row>`)).sheets[0].name).toBe("Remittance");
  });

  it("numbers columns past Z", () => {
    expect(columnIndex("A1")).toBe(0);
    expect(columnIndex("Z9")).toBe(25);
    expect(columnIndex("AA1")).toBe(26);
    expect(columnIndex("BC12")).toBe(54);
  });
});

// ── PDF ──────────────────────────────────────────────────────────────────────

describe("ToUnicode CMaps", () => {
  it("reads single mappings", () => {
    const map = parseToUnicode("beginbfchar\n<0028> <0045>\n<0044> <0061>\nendbfchar");
    expect(map.get(0x28)).toBe("E");
    expect(map.get(0x44)).toBe("a");
  });

  it("reads a contiguous range", () => {
    const map = parseToUnicode("beginbfrange\n<0048> <004A> <0065>\nendbfrange");
    expect(map.get(0x48)).toBe("e");
    expect(map.get(0x49)).toBe("f");
    expect(map.get(0x4a)).toBe("g");
  });

  it("reads the ARRAY form of a range", () => {
    // Subset fonts map non-contiguously, so this form carries exactly the
    // characters the document actually uses. Handling only the triple form
    // loses them.
    const map = parseToUnicode("beginbfrange\n<0001> <0003> [<0041> <0052> <0058>]\nendbfrange");
    expect(map.get(1)).toBe("A");
    expect(map.get(2)).toBe("R");
    expect(map.get(3)).toBe("X");
  });

  it("maps a ligature to several characters", () => {
    expect(parseToUnicode("beginbfchar\n<0100> <006600660069>\nendbfchar").get(0x100)).toBe("ffi");
  });

  it("ignores a range claiming an implausible number of glyphs", () => {
    // A malformed CMap asking for four billion entries is a memory bomb.
    const map = parseToUnicode("beginbfrange\n<0000> <FFFFFF> <0041>\nendbfrange");
    expect(map.size).toBe(0);
  });
});

describe("content stream text", () => {
  const font: GlyphMap = new Map([
    [1, "9"], [2, "2"], [3, "1"], [4, "4"], [5, "$"], [6, "."], [7, "0"], [8, "5"],
  ]);
  const fonts = new Map([["F1", font]]);

  it("decodes hex strings through the font's map", () => {
    const r = extractContent("BT /F1 16 Tf 1 0 0 1 10 100 Tm <00010001000200030004> Tj ET", fonts);
    expect(r.text).toBe("99214");
    expect(r.unresolved).toBe(0);
  });

  it("marks a glyph no CMap resolved rather than guessing at it", () => {
    // The whole point. A guessed glyph is a wrong digit that looks right.
    const r = extractContent("BT /F1 16 Tf 1 0 0 1 10 100 Tm <0001009900010002> Tj ET", fonts);
    expect(r.text).toContain("�");
    expect(r.unresolved).toBe(1);
    expect(r.glyphs).toBe(4);
  });

  it("breaks a line when the text moves down the page", () => {
    const r = extractContent(
      "BT /F1 16 Tf 1 0 0 1 10 100 Tm <0001> Tj ET BT /F1 16 Tf 1 0 0 1 10 80 Tm <0002> Tj ET",
      fonts,
    );
    expect(r.text).toBe("9\n2");
  });

  it("separates two columns on the same line", () => {
    const r = extractContent(
      "BT /F1 16 Tf 1 0 0 1 10 100 Tm <0001> Tj ET BT /F1 16 Tf 1 0 0 1 90 100 Tm <0002> Tj ET",
      fonts,
    );
    expect(r.text).toBe("9\t2");
  });

  it("does NOT split a number when a relative move is just the glyph advance", () => {
    // The defect this rule exists for. A live remittance wrote 99211 as
    // `<9921> Tj 31.4 0 Td <1> Tj` — 31.4 is the width of the text just drawn,
    // not a gap. Splitting there turns one CPT code into two fields.
    const r = extractContent("BT /F1 16 Tf 1 0 0 1 10 100 Tm <0001000100020003> Tj 31.40625 0 Td <0003> Tj ET", fonts);
    expect(r.text).toBe("99211");
  });

  it("still separates a relative move that is far past the text drawn", () => {
    const r = extractContent("BT /F1 16 Tf 1 0 0 1 10 100 Tm <0001> Tj 120 0 Td <0002> Tj ET", fonts);
    expect(r.text).toBe("9\t2");
  });
});

/** A complete, uncompressed, single-page PDF — small enough to read in the test. */
function tinyPdf(opts: { withFont?: boolean } = {}): Buffer {
  const withFont = opts.withFont !== false;
  const cmap = `/CIDInit /ProcSet findresource begin
begincmap
2 beginbfchar
<0001> <0048>
<0002> <0069>
endbfchar
endcmap
end`;
  const content = "BT /F1 12 Tf 1 0 0 1 20 700 Tm <00010002> Tj ET";
  const objs = [
    `1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n`,
    `2 0 obj\n<</Type /Pages /Count 1 /Kids [3 0 R]>>\nendobj\n`,
    `3 0 obj\n<</Type /Page /Parent 2 0 R /Contents 4 0 R /Resources <</Font <<${withFont ? "/F1 5 0 R" : ""}>>>>>>\nendobj\n`,
    `4 0 obj\n<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\n`,
    `5 0 obj\n<</Type /Font /Subtype /Type0 /ToUnicode 6 0 R>>\nendobj\n`,
    `6 0 obj\n<</Length ${cmap.length}>>\nstream\n${cmap}\nendstream\nendobj\n`,
  ];
  return Buffer.from(`%PDF-1.7\n${objs.join("")}trailer\n<</Root 1 0 R>>\n%%EOF\n`, "latin1");
}

describe("whole PDFs", () => {
  it("reads a page through its own font resources", () => {
    const pdf = extractPdf(tinyPdf());
    expect(pdf.pages).toHaveLength(1);
    expect(pdf.pages[0].text).toBe("Hi");
    expect(pdf.scanned).toBe(false);
    expect(readingConfidence(pdf)).toBe(1);
  });

  it("reports unresolved glyphs when a page names no usable font", () => {
    const pdf = extractPdf(tinyPdf({ withFont: false }));
    expect(pdf.unresolved).toBe(2);
    expect(readingConfidence(pdf)).toBe(0);
  });

  it("calls a page with no text-drawing operators a scan", () => {
    // An empty string is indistinguishable from a blank page. "This is a
    // photograph and needs OCR" is something a person can act on.
    const noText = Buffer.from(
      "%PDF-1.7\n1 0 obj\n<</Type /Page /Contents 2 0 R /Resources <<>>>>\nendobj\n2 0 obj\n<</Length 20>>\nstream\n0 0 100 100 re f\nendstream\nendobj\n%%EOF",
      "latin1",
    );
    const pdf = extractPdf(noText);
    expect(pdf.scanned).toBe(true);
    expect(pdf.glyphs).toBe(0);
  });

  it("refuses a file that is not a PDF", () => {
    expect(() => extractPdf(Buffer.from("PK"))).toThrow(/not a pdf/i);
  });
});

// ── Detection and refusals ───────────────────────────────────────────────────

describe("what a file is", () => {
  it("decides by content, not by extension", () => {
    // Extensions lie constantly here: an 835 arrives as .txt, a scan as .pdf.
    expect(detectKind("remit.txt", Buffer.from("%PDF-1.4\n..."))).toBe("pdf");
    expect(detectKind("anything.dat", Buffer.from("ISA*00*          *00*"))).toBe("x12");
    expect(detectKind("note.docx", docx("<w:p/>"))).toBe("docx");
    expect(detectKind("book.xlsx", xlsx("<row r='1'/>"))).toBe("xlsx");
  });

  it("knows the image formats a phone camera produces", () => {
    expect(detectKind("eob.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe("image");
    expect(detectKind("eob.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("image");
  });
});

describe("reading a document end to end", () => {
  it("reads a Word file and reports what it found", () => {
    const e = extractDocument("appeal.docx", docx("<w:p><w:r><w:t>Claim CLM-88213 denied CO-97.</w:t></w:r></w:p>"));
    expect(e.readable).toBe(true);
    expect(e.kind).toBe("docx");
    expect(e.text).toContain("CLM-88213");
    expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("flags identifier-shaped text in what it read", () => {
    const e = extractDocument("note.docx", docx("<w:p><w:r><w:t>SSN 123-45-6789 DOB: 01/15/1958</w:t></w:r></w:p>"));
    expect(e.phi.map((p) => p.kind)).toContain("ssn");
    expect(describeExtraction(e)).toMatch(/Identifier-shaped text found/);
  });

  it("refuses an image, naming BOTH reasons nothing can read it", () => {
    // No OCR here, and the configured model is text-only. Saying only one of
    // those invites "then switch the model", which does not help either.
    const e = extractDocument("eob.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    expect(e.readable).toBe(false);
    expect(e.refusal).toMatch(/no OCR/i);
    expect(e.refusal).toMatch(/text-only/i);
  });

  it("refuses a legacy .xls rather than guessing at BIFF records", () => {
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
    const e = extractDocument("remit.xls", ole);
    expect(e.readable).toBe(false);
    expect(e.refusal).toMatch(/Excel 97–2003/);
    expect(e.refusal).toMatch(/save as \.docx or \.xlsx|export it to CSV/);
  });

  it("sends an X12 envelope to its parser instead of reading it as prose", () => {
    const e = extractDocument("file.txt", Buffer.from("ISA*00*          *00*          *ZZ*A*ZZ*B*260808*0000*^*00501*1*0*T*:~"));
    expect(e.readable).toBe(false);
    expect(e.refusal).toMatch(/era_parse_835/);
  });

  it("refuses a partial PDF reading rather than returning it with a caveat", () => {
    // Holes fall wherever a font lacked a CMap, and digits are as likely as
    // letters. A remittance read at 40% is worse than one not read at all.
    const e = extractDocument("eob.pdf", tinyPdf({ withFont: false }));
    expect(e.readable).toBe(false);
    expect(e.refusal).toMatch(/glyphs/i);
    expect(MIN_CONFIDENCE).toBeGreaterThan(0.5);
  });

  it("never throws on a file it cannot parse", () => {
    const e = extractDocument("junk.bin", Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
    expect(e.readable).toBe(false);
    expect(e.refusal).toBeTruthy();
  });
});

// ── Session titles ───────────────────────────────────────────────────────────

describe("the title a session gets", () => {
  it("takes the question, not the attachment preamble in front of it", () => {
    // Every session with a file attached was titled "[The user attached 2
    // file(s).]" in the sidebar — the machinery rather than what was asked.
    const text =
      "[The user attached 2 file(s).]\n- eob.pdf (pdf, 142 characters) — document id doc_1\n- adr.docx (docx, 122 characters) — document id doc_2\nCall document_extract with a document_id to read one. The text is stored; it is not in this message.\n\nRead the attached EOB and tell me what was paid.";
    expect(sessionTitleFrom(text)).toBe("Read the attached EOB and tell me what was paid.");
  });

  it("leaves an ordinary message alone", () => {
    expect(sessionTitleFrom("Is E11.65 billable?")).toBe("Is E11.65 billable?");
  });

  it("falls back to the raw text rather than an empty title", () => {
    // An attachment with no question is still a turn, and a blank row in the
    // sidebar is worse than an awkward one.
    expect(sessionTitleFrom("[The user attached 1 file(s).]\n- eob.pdf — document id doc_1\n")).toMatch(/attached/);
  });

  it("truncates at 60 characters", () => {
    expect(sessionTitleFrom("x".repeat(200))).toHaveLength(60);
  });
});
