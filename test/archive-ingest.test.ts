import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { ZipError, readZipReport } from "../src/ingest/zip.js";
import { DEFAULT_MAX_ENTRIES, expandArchive, isNoiseEntry } from "../src/ingest/archive.js";
import { detectKind, extractDocument } from "../src/ingest/extract.js";

// ── Archives ─────────────────────────────────────────────────────────────────
// A payer portal hands over a batch as one .zip. What this suite pins down is
// the ACCOUNTING: every member of the archive is read, refused with a reason
// about that file, or named as a skip. The one thing none of them may do is
// disappear — in a forty-file batch, a file that vanishes between the zip and
// the table is one the operator believes was processed.

/**
 * Build a ZIP. `declaredUncompressed` overrides the central-dir size field to
 * lie; `method` overrides the compression method so an entry can claim a codec
 * this does not read while still carrying deflate bytes.
 */
function zip(entries: Array<{ name: string; content: Buffer; declaredUncompressed?: number; method?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const deflated = zlib.deflateRawSync(e.content);
    const uncompressed = e.declaredUncompressed ?? e.content.length;
    const method = e.method ?? 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, deflated);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
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

/** A PDF with no text-drawing operators at all — what a scanner or fax gateway produces. */
const scannedPdf = Buffer.from(
  "%PDF-1.7\n1 0 obj\n<</Type /Page /Contents 2 0 R /Resources <<>>>>\nendobj\n2 0 obj\n<</Length 20>>\nstream\n0 0 100 100 re f\nendstream\nendobj\n%%EOF",
  "latin1",
);

const docx = (body: string) =>
  zip([
    { name: "[Content_Types].xml", content: Buffer.from("<Types/>") },
    {
      name: "word/document.xml",
      content: Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`),
    },
  ]);

const xlsx = () =>
  zip([
    { name: "xl/workbook.xml", content: Buffer.from(`<workbook><sheets><sheet name="Remittance"/></sheets></workbook>`) },
    { name: "xl/worksheets/sheet1.xml", content: Buffer.from(`<worksheet><sheetData><row r="1"/></sheetData></worksheet>`) },
  ]);

/** The batch an operator actually forwards: two EOBs, a call note and a spreadsheet export. */
const mixedBatch = () =>
  zip([
    { name: "eob-clean.pdf", content: tinyPdf() },
    { name: "eob-scan.pdf", content: scannedPdf },
    { name: "call-note.txt", content: Buffer.from("Called payer 08/06; rep said reprocess.", "utf8") },
    { name: "rows.csv", content: Buffer.from("cpt,charge,paid\n99214,225.00,140.00\n", "utf8") },
  ]);

// ── What the container reports it dropped ────────────────────────────────────

describe("readZipReport — an entry that was not read is named", () => {
  it("names the compression method it does not support, rather than dropping the entry silently", () => {
    // THE regression this change exists for. A member compressed with bzip2 or
    // LZMA used to vanish inside a try/catch, so a 40-file archive came back
    // with 39 files and no indication that a 40th had ever been there.
    const buf = zip([
      { name: "readable.txt", content: Buffer.from("kept") },
      { name: "odd-codec.bin", content: Buffer.from("payload"), method: 14 },
    ]);
    const report = readZipReport(buf);
    expect(report.entries.get("readable.txt")!.toString()).toBe("kept");
    expect(report.entries.has("odd-codec.bin")).toBe(false);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].name).toBe("odd-codec.bin");
    expect(report.skipped[0].reason).toContain("14");
  });

  it("names the per-entry cap when a header declares a size past it", () => {
    const buf = zip([
      { name: "ok.xml", content: Buffer.from("<a>fine</a>") },
      { name: "bomb.xml", content: Buffer.from("small"), declaredUncompressed: 500 * 1024 * 1024 },
    ]);
    const report = readZipReport(buf);
    expect(report.entries.get("ok.xml")!.toString()).toBe("<a>fine</a>");
    expect(report.entries.has("bomb.xml")).toBe(false);
    expect(report.skipped.map((s) => s.name)).toEqual(["bomb.xml"]);
    expect(report.skipped[0].reason).toMatch(/100 MB/);
  });

  it("refuses the whole container rather than answering part of a bomb", () => {
    // A partial answer from a hostile archive is worse than a refusal: the
    // caller cannot tell which half it got. Both container-level failures stay
    // a thrown ZipError, not a skip list.
    expect(() => readZipReport(Buffer.from("not a zip at all"))).toThrow(ZipError);
    const damaged = mixedBatch();
    damaged.writeUInt32LE(0, 16 + damaged.length - 22); // EOCD's central-directory offset → garbage
    expect(() => readZipReport(damaged)).toThrow(ZipError);
  });

  it("does not report a directory record as a skip — it was never a file", () => {
    const report = readZipReport(
      zip([
        { name: "invoices/", content: Buffer.alloc(0) },
        { name: "invoices/a.txt", content: Buffer.from("a") },
      ]),
    );
    expect([...report.entries.keys()]).toEqual(["invoices/a.txt"]);
    expect(report.skipped).toEqual([]);
  });

  it("reports nothing skipped for an ordinary archive", () => {
    expect(readZipReport(mixedBatch()).skipped).toEqual([]);
  });
});

// ── Detection ────────────────────────────────────────────────────────────────

describe("detectKind — a plain ZIP is an archive, an OOXML file is not", () => {
  it("calls a plain container an archive instead of refusing it as unknown", () => {
    expect(detectKind("batch.zip", mixedBatch())).toBe("archive");
  });

  it("still reads Word and Excel containers as documents", () => {
    // Both are ZIPs. If the archive branch caught them, every .docx in the
    // system would come back as a one-line manifest of its own XML parts.
    expect(detectKind("appeal.docx", docx("<w:p/>"))).toBe("docx");
    expect(detectKind("remit.xlsx", xlsx())).toBe("xlsx");
  });
});

describe("extractDocument — an archive extracts to a manifest", () => {
  it("lists what is inside without reading any of it", () => {
    const e = extractDocument("batch.zip", mixedBatch());
    expect(e.kind).toBe("archive");
    expect(e.readable).toBe(true);
    expect(e.text).toContain("eob-clean.pdf");
    expect(e.text).toMatch(/rows\.csv — csv/);
    expect(e.text).toMatch(/call-note\.txt — text/);
    // "Hi" is the text drawn inside eob-clean.pdf. The manifest must not
    // recurse: forty EOBs flattened into one blob have no way to say which
    // file was the scan.
    expect(e.text).not.toContain("Hi");
    expect(e.notes.join(" ")).toMatch(/4 file\(s\)/);
    expect(e.notes.join(" ")).toMatch(/0 of them unreadable/);
  });

  it("counts the entries the container could not read", () => {
    const e = extractDocument("batch.zip", zip([{ name: "odd.bin", content: Buffer.from("x"), method: 14 }]));
    expect(e.readable).toBe(true);
    expect(e.text).toMatch(/odd\.bin — NOT READ: .*14/);
    expect(e.notes.join(" ")).toMatch(/1 of them unreadable/);
  });
});

// ── Expansion ────────────────────────────────────────────────────────────────

describe("expandArchive — one result per document", () => {
  const byName = (out: ReturnType<typeof expandArchive>, name: string) => out.entries.find((e) => e.name === name)!;

  it("reads a mixed batch and carries each file's own verdict", () => {
    const out = expandArchive(mixedBatch());
    expect(out.entries.map((e) => e.name)).toEqual(["eob-clean.pdf", "eob-scan.pdf", "call-note.txt", "rows.csv"]);
    expect(out.skipped).toEqual([]);

    const clean = byName(out, "eob-clean.pdf").extraction;
    expect(clean.kind).toBe("pdf");
    expect(clean.readable).toBe(true);
    expect(clean.text).toContain("Hi");

    // A refused file is an ENTRY, not a skip: "this EOB is a scan" is the
    // answer, and it belongs in the row for that EOB.
    const scan = byName(out, "eob-scan.pdf").extraction;
    expect(scan.kind).toBe("pdf");
    expect(scan.readable).toBe(false);
    expect(scan.refusal).toMatch(/no text layer/i);

    expect(byName(out, "call-note.txt").extraction.readable).toBe(true);
    expect(byName(out, "rows.csv").extraction.kind).toBe("csv");
    expect(byName(out, "rows.csv").extraction.text).toContain("99214");
  });

  it("hands back each member's bytes, so nothing has to inflate the archive twice", () => {
    // What runs after expansion — OCR over the scan — needs the file itself.
    // Re-reading the container to recover one page doubles the decompression
    // the caps are sized against.
    const out = expandArchive(mixedBatch());
    expect(byName(out, "eob-clean.pdf").bytes.equals(tinyPdf())).toBe(true);
    expect(byName(out, "eob-scan.pdf").bytes.equals(scannedPdf)).toBe(true);
    expect(byName(out, "rows.csv").bytes.toString("utf8")).toBe("cpt,charge,paid\n99214,225.00,140.00\n");
  });

  it("drops packaging silently and never calls it a skip", () => {
    // A folder zipped on a Mac arrives with a __MACOSX resource fork beside
    // every file. Reporting those as unreadable buries the real skips in noise
    // the operator never chose to send.
    const out = expandArchive(
      zip([
        { name: "eob.pdf", content: tinyPdf() },
        { name: "__MACOSX/._eob.pdf", content: Buffer.from("resource fork") },
        { name: ".DS_Store", content: Buffer.from("mac junk") },
        { name: "Thumbs.db", content: Buffer.from("windows junk") },
        { name: ".hidden-note", content: Buffer.from("dotfile") },
        { name: "invoices/", content: Buffer.alloc(0) },
      ]),
    );
    expect(out.entries.map((e) => e.name)).toEqual(["eob.pdf"]);
    expect(out.skipped).toEqual([]);
  });

  it("knows which names are packaging", () => {
    expect(isNoiseEntry("__MACOSX/._eob.pdf")).toBe(true);
    expect(isNoiseEntry(".DS_Store")).toBe(true);
    expect(isNoiseEntry("batch/.DS_Store")).toBe(true);
    expect(isNoiseEntry("Thumbs.db")).toBe(true);
    expect(isNoiseEntry("batch/.env")).toBe(true);
    expect(isNoiseEntry("invoices/")).toBe(true);
    expect(isNoiseEntry("eob.pdf")).toBe(false);
    expect(isNoiseEntry("invoices/eob.pdf")).toBe(false);
  });

  it("lists a nested archive as a skip instead of recursing into it", () => {
    // The caps in zip.ts are per archive, so each level of nesting multiplies
    // what one 32 MB upload can inflate to. That shape IS the bomb.
    const inner = zip([{ name: "inner.txt", content: Buffer.from("deep") }]);
    const out = expandArchive(
      zip([
        { name: "eob.pdf", content: tinyPdf() },
        { name: "more-claims.zip", content: inner },
      ]),
    );
    expect(out.entries.map((e) => e.name)).toEqual(["eob.pdf"]);
    expect(out.skipped.map((s) => s.name)).toEqual(["more-claims.zip"]);
    expect(out.skipped[0].reason).toMatch(/nested/i);
    expect(JSON.stringify(out)).not.toContain("inner.txt");
  });

  it("carries the container's own skips through", () => {
    const out = expandArchive(
      zip([
        { name: "eob.pdf", content: tinyPdf() },
        { name: "odd-codec.bin", content: Buffer.from("payload"), method: 14 },
      ]),
    );
    expect(out.entries.map((e) => e.name)).toEqual(["eob.pdf"]);
    expect(out.skipped.map((s) => s.name)).toEqual(["odd-codec.bin"]);
    expect(out.skipped[0].reason).toContain("14");
  });

  it("counts the entries it did not reach when the cap trips", () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ name: `note${i}.txt`, content: Buffer.from(`file ${i}`) }));
    const out = expandArchive(zip(files), { maxEntries: 2 });
    expect(out.entries.map((e) => e.name)).toEqual(["note0.txt", "note1.txt"]);
    expect(out.notes.join(" ")).toContain("3 further entries were not processed");
    expect(DEFAULT_MAX_ENTRIES).toBe(200);
  });

  it("says so when the buffer is not a container at all, rather than throwing", () => {
    const out = expandArchive(tinyPdf());
    expect(out.entries).toEqual([]);
    expect(out.skipped).toEqual([]);
    expect(out.notes.join(" ")).toMatch(/not a ZIP container/i);
  });
});
