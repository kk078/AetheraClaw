import { afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import {
  OCR_INSTALL_HINT,
  needsOcr,
  ocrStatus,
  ocrUnavailableNote,
  runOcr,
  shutdownOcr,
  withOcrText,
  type OcrResult,
} from "../src/ingest/ocr.js";
import type { DocumentKind, Extraction } from "../src/ingest/extract.js";

// Every test here is OFFLINE and none of them needs tesseract installed. That
// is deliberate rather than a shortcut: the decisions worth guarding — WHEN OCR
// is allowed to run, and what a document that went through it must say about
// itself — are all pure, and a suite that only passes on a machine with a
// 20 MB language pack downloaded is a suite that never runs.

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Plain literals rather than round-tripping real files through extractDocument:
// this module's contract is the Extraction SHAPE, and building one by hand keeps
// what each test asserts against visible in the test.

function extraction(over: Partial<Extraction> = {}): Extraction {
  return {
    kind: "text",
    filename: "sample.txt",
    sizeBytes: 100,
    sha256: "0".repeat(64),
    sections: [],
    text: "",
    readable: false,
    confidence: 0,
    phi: [],
    notes: [],
    ...over,
  };
}

/** What extract.ts returns for a PDF whose pages carry no text-drawing operators. */
const scannedPdf = (): Extraction =>
  extraction({
    kind: "pdf",
    filename: "eob-scan.pdf",
    refusal:
      "This PDF has no text layer — every page is an image, which is what a scanner or a fax gateway produces. There is no OCR in this build, so there is nothing to read. Ask the sender for the original, or for the electronic remittance if this is an EOB.",
    notes: ["3 page(s), no text-drawing operators on any of them."],
  });

/** The OTHER PDF refusal: a real text layer that only partly decoded. */
const partialPdf = (): Extraction =>
  extraction({
    kind: "pdf",
    filename: "eob-partial.pdf",
    refusal:
      "Only 62% of the glyphs in this PDF could be mapped back to characters, so the reading has holes in it — and the holes fall wherever a font was missing its ToUnicode table, which hits digits as readily as letters. A partial reading of a remittance is worse than none, so it is refused rather than returned with a caveat.",
    notes: ["410 of 1080 glyphs unresolved."],
  });

const imageDoc = (): Extraction =>
  extraction({
    kind: "image",
    filename: "remit-photo.jpg",
    refusal:
      "This is JPEG. There is no OCR in this build, and the configured model is text-only, so nothing here can read what the picture says.",
    notes: ["An image of a document is not a document — the characters exist only as pixels."],
  });

const ocrResult = (over: Partial<OcrResult> = {}): OcrResult => ({
  text: "Explanation of Benefits\nAllowed 142.31",
  pages: 1,
  engine: "tesseract",
  confidence: 0.87,
  ...over,
});

describe("needsOcr", () => {
  it("is true for a PDF refused because it has no text layer", () => {
    expect(needsOcr(scannedPdf())).toBe(true);
  });

  it("is true for an image", () => {
    expect(needsOcr(imageDoc())).toBe(true);
  });

  it("is FALSE for a document that produced little text but produced it correctly", () => {
    // The failure this prevents: a one-line fax cover sheet is short because it
    // is short, not because the reading failed. OCR'ing it would throw away an
    // exact reading and put a guess in its place.
    const coverSheet = extraction({
      kind: "text",
      filename: "cover.txt",
      sections: [{ label: "Text", text: "FAX COVER — 2 pages to follow." }],
      text: "FAX COVER — 2 pages to follow.",
      readable: true,
      confidence: 1,
    });
    expect(coverSheet.text.length).toBeLessThan(40);
    expect(needsOcr(coverSheet)).toBe(false);
  });

  it("is false for anything already readable, however low its confidence", () => {
    const readablePdf = extraction({ kind: "pdf", readable: true, text: "Paid 12.00", confidence: 0.91 });
    expect(needsOcr(readablePdf)).toBe(false);
  });

  it("is false for a PDF refused for a PARTIAL reading rather than a missing text layer", () => {
    // That file has real characters in it. Replacing all of them with OCR
    // guesses to recover the missing ones is a net loss.
    expect(needsOcr(partialPdf())).toBe(false);
  });

  it("is false for the kinds OCR cannot help", () => {
    for (const kind of ["x12", "csv", "xlsx", "docx", "archive"] as DocumentKind[]) {
      const e = extraction({ kind, refusal: "This is an X12 envelope, not a document to read as prose." });
      expect(needsOcr(e), `${kind} should not be sent to OCR`).toBe(false);
    }
  });
});

describe("withOcrText", () => {
  it("turns a refusal into an ordinary readable Extraction", () => {
    const out = withOcrText(scannedPdf(), ocrResult());
    expect(out.readable).toBe(true);
    expect(out.text).toContain("Explanation of Benefits");
    expect(out.sections.map((s) => s.text).join("")).toContain("142.31");
    expect(out.confidence).toBe(0.87);
    // Cleared by omission, so `"refusal" in e` agrees with `e.refusal`.
    expect(out.refusal).toBeUndefined();
    expect("refusal" in out).toBe(false);
    // Identity is preserved — same file, same hash.
    expect(out.sha256).toBe(scannedPdf().sha256);
    expect(out.kind).toBe("pdf");
  });

  it("re-runs PHI detection over the RECOVERED text", () => {
    // Before OCR the member id existed only as pixels, so `phi` was empty and
    // correct. After OCR it is text, and a document full of identifiers that
    // reports none of them walks straight past the quarantine.
    const before = scannedPdf();
    expect(before.phi).toEqual([]);
    const out = withOcrText(before, ocrResult({ text: "Patient 123-45-6789\nAllowed 142.31" }));
    expect(out.phi.map((p) => p.kind)).toContain("ssn");
    // The signal never carries the value itself.
    expect(JSON.stringify(out.phi)).not.toContain("123-45-6789");
  });

  it("records in the notes that a machine guessed at the characters", () => {
    const out = withOcrText(scannedPdf(), ocrResult({ confidence: 0.87, pages: 3 }));
    const note = out.notes.find((n) => /OCR/.test(n));
    expect(note).toBeDefined();
    expect(note).toMatch(/tesseract/);
    expect(note).toMatch(/87%/);
    expect(note).toMatch(/GUESSED|guess/);
    // The refused extraction's own notes survive; they say how many pages there
    // were and who produced the file.
    expect(out.notes[0]).toMatch(/no text-drawing operators/);
  });

  it("refuses rather than presenting a recognised-nothing scan as a blank document", () => {
    const out = withOcrText(scannedPdf(), ocrResult({ text: "   \n  ", confidence: 0 }));
    expect(out.readable).toBe(false);
    expect(out.text).toBe("");
    expect(out.refusal).toMatch(/recognised no characters/i);
  });
});

describe("ocrUnavailableNote", () => {
  it("appends the install hint to the refusal, exactly once", () => {
    const once = ocrUnavailableNote(scannedPdf());
    expect(once.refusal).toContain(OCR_INSTALL_HINT);
    // Ingest may pass the same extraction through more than one layer.
    const twice = ocrUnavailableNote(once);
    const occurrences = twice.refusal!.split(OCR_INSTALL_HINT).length - 1;
    expect(occurrences).toBe(1);
    expect(twice.refusal).toBe(once.refusal);
  });

  it("keeps the original refusal and never blanks the document", () => {
    const before = imageDoc();
    const after = ocrUnavailableNote(before);
    // The whole point: still refused, still saying why, NOT an empty readable
    // document that a coder would take for an EOB the payer left blank.
    expect(after.readable).toBe(false);
    expect(after.refusal).toContain("There is no OCR in this build");
    expect(after.kind).toBe("image");
    expect(after.notes).toEqual(before.notes);
  });

  it("leaves whatever text the extraction already carried alone", () => {
    const partial = extraction({
      kind: "pdf",
      text: "Explanation of Benefits",
      sections: [{ label: "Page 1", text: "Explanation of Benefits" }],
      refusal: "Only 62% of the glyphs in this PDF could be mapped back to characters.",
    });
    const after = ocrUnavailableNote(partial);
    expect(after.text).toBe("Explanation of Benefits");
    expect(after.sections).toEqual(partial.sections);
  });
});

// A specifier that resolves to nothing, so the engine-missing path is reachable
// on a machine where tesseract.js IS installed. It has to be, now: the package
// is in the lockfile, so CI installs it, and a test written as "skip unless the
// package happens to be absent" would stop running in exactly the place the
// degradation claim needs checking.
const ABSENT_ENGINE = "aetheraclaw-no-such-ocr-engine";

describe("ocrStatus", () => {
  it("reports unavailability with a reason instead of throwing", async () => {
    const status = await ocrStatus({ specifier: ABSENT_ENGINE });
    expect(status.available).toBe(false);
    expect(status.reason.length).toBeGreaterThan(0);
    expect(status.reason).toContain(OCR_INSTALL_HINT);
    // The cache path is reported even when the engine is missing — "OCR is
    // unavailable" without saying where it looked sends people to delete the
    // wrong directory.
    expect(status.dataDir).toBe(path.join(process.env.AETHERACLAW_HOME!, "ocr"));
  });

  it("reports availability with no reason when the engine loads", async () => {
    const status = await ocrStatus();
    expect(typeof status.available).toBe("boolean");
    expect(status.dataDir).toBe(path.join(process.env.AETHERACLAW_HOME!, "ocr"));
    if (status.available) expect(status.reason).toBe("");
    else expect(status.reason).toContain(OCR_INSTALL_HINT);
  });

  it("does not create or download anything just by being asked", async () => {
    const { existsSync } = await import("node:fs");
    const status = await ocrStatus({ specifier: ABSENT_ENGINE });
    expect(existsSync(status.dataDir)).toBe(false);
  });
});

describe("runOcr", () => {
  it("refuses kinds that have no page image to read", async () => {
    await expect(runOcr(Buffer.from("a,b,c"), "csv")).rejects.toThrow(/no page image/i);
  });

  it("names the install command when tesseract is not installed", async () => {
    await expect(
      runOcr(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image", { specifier: ABSENT_ENGINE }),
    ).rejects.toThrow(new RegExp(OCR_INSTALL_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("checks the engine BEFORE it writes a language directory", async () => {
    // Order matters: a missing engine must not leave an empty ocr/ behind, or
    // "is OCR set up?" answers yes on the evidence of a directory nothing put
    // anything in.
    const { existsSync } = await import("node:fs");
    const dataDir = path.join(process.env.AETHERACLAW_HOME!, "ocr");
    await expect(runOcr(Buffer.from([0x89, 0x50]), "image", { specifier: ABSENT_ENGINE })).rejects.toThrow();
    expect(existsSync(dataDir)).toBe(false);
  });

  it("does not cache a failed startup, so a later call retries instead of inheriting it", async () => {
    // The poisoned-cache bug: one failure sticking to `workerPromise` would make
    // every subsequent OCR in the process fail with a stale rejection, long
    // after whatever caused it was fixed.
    await expect(runOcr(Buffer.from([0x89]), "image", { specifier: ABSENT_ENGINE })).rejects.toThrow(
      /not installed/i,
    );
    await expect(runOcr(Buffer.from([0x89]), "image", { specifier: ABSENT_ENGINE })).rejects.toThrow(
      /not installed/i,
    );
  });
});

// A live tesseract worker holds an open handle, and an open handle keeps the
// event loop alive — the run would hang here rather than exit. Safe to call
// when nothing ever started.
afterAll(async () => {
  await shutdownOcr();
});
