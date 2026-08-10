import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { detectPhi } from "../channels/email/classify.js";
import { configDir } from "../config/config.js";
import type { DocumentKind, Extraction } from "./extract.js";

// ── OCR ──────────────────────────────────────────────────────────────────────
// Three of the sample PDFs this build was tested against extracted ZERO
// characters. They are scans, and `extractDocument` refuses them honestly:
// "no text layer … There is no OCR in this build". Honest, and useless — a
// scanned EOB and a phone photograph of a remittance are much of what actually
// arrives, so the refusal was firing on the ordinary case rather than the
// exotic one.
//
// This module turns that refusal into a reading, under three constraints that
// each prevent a specific way OCR makes things worse:
//
//   OCR IS A GUESS AND IS LABELLED AS ONE. Every reading it produces carries a
//   note saying a machine read the pixels and at what confidence. A coder
//   reading an allowed amount off an OCR'd EOB has to know that "$142.31" came
//   out of a classifier, not out of a text layer — `8`/`3` and `5`/`6` are the
//   confusions that survive a clean scan, and they are confusions in the
//   digits that are the entire content of the document.
//
//   IT IS ONLY APPLIED WHERE THERE IS NOTHING TO LOSE. `needsOcr` is
//   deliberately narrow: a document that was READ, even if what it holds is one
//   line, is left alone. Re-reading a short-but-correct fax cover sheet with
//   OCR replaces a right answer with a guess.
//
//   IT DEGRADES LOUDLY. tesseract.js is an OPTIONAL dependency. When it is not
//   installed the failure is an error naming the install command, or a refusal
//   with that command appended — never an empty string, which is the failure
//   where a scanned EOB silently becomes a blank document and a claim is worked
//   as though the payer said nothing.

export interface OcrResult {
  text: string;
  pages: number;
  engine: "tesseract";
  /** 0–1, the engine's mean confidence over the recognised text. */
  confidence: number;
}

export interface OcrStatus {
  available: boolean;
  /** Why it is unavailable, when it is. Empty when it is available. */
  reason: string;
  /** Where trained language data is cached. Reported so it is never a mystery. */
  dataDir: string;
}

/**
 * The command that makes OCR work, quoted verbatim wherever OCR is missing.
 *
 * A message that says "OCR is not installed" and stops sends the reader to
 * search for which of the several OCR packages this build wanted. Name it.
 */
export const OCR_INSTALL_HINT = "npm install tesseract.js";

/** Default engine language. Trained data for it is fetched on first use, not at import. */
const DEFAULT_LANG = "eng";

/** Rasterisation resolution. Below ~200 dpi tesseract starts losing decimal points. */
const RASTER_DPI = 300;

/**
 * Kinds where OCR has nothing to offer.
 *
 * Held as strings rather than a `DocumentKind[]` on purpose: `DocumentKind`
 * grows (`archive` arrived while this was being written), and a `Set<string>`
 * keeps the rule true for members added after this file was last touched
 * instead of failing to compile against them.
 */
const OCR_CANNOT_HELP: ReadonlySet<string> = new Set(["x12", "csv", "xlsx", "docx", "archive"]);

/**
 * The refusal `extract.ts` writes for a PDF with no text-drawing operators.
 *
 * Matched on the refusal rather than on `kind === "pdf"` because the OTHER PDF
 * refusal — the low-confidence one, where a font's ToUnicode table was missing
 * — must NOT be OCR'd. That file has a real text layer that partly decoded;
 * running OCR over it throws away the characters that were read exactly and
 * replaces all of them with guesses. Only the total-absence case qualifies.
 */
const SCAN_REFUSAL = /no text layer|no text-drawing operators|every page is an image/i;

// ── The pure half ────────────────────────────────────────────────────────────

/**
 * Would OCR turn this refusal into a document?
 *
 * True in exactly two cases: a PDF that carries no text layer at all, and an
 * image. Everything else is false, and the false cases are the ones worth
 * naming:
 *
 *   A document that WAS read is never re-read, however little it holds. A fax
 *   cover sheet is four lines long and those four lines are correct.
 *
 *   A partially-decodable PDF is not a candidate — see SCAN_REFUSAL.
 *
 *   X12, CSV, spreadsheets, Word files and archives have no pixels to read.
 */
export function needsOcr(e: Extraction): boolean {
  if (e.readable) return false;
  if (OCR_CANNOT_HELP.has(e.kind)) return false;
  if (e.kind === "image") return true;
  if (e.kind !== "pdf") return false;
  const evidence = `${e.refusal ?? ""}\n${e.notes.join("\n")}`;
  return SCAN_REFUSAL.test(evidence);
}

/**
 * The note that must travel with every OCR'd document.
 *
 * Never omitted and never softened. OCR text presented as though it were an
 * embedded text layer is worse than the refusal it replaced, because the
 * refusal was at least visible.
 */
function provenanceNote(ocr: OcrResult): string {
  const pct = (ocr.confidence * 100).toFixed(0);
  return `Text recovered by OCR (${ocr.engine}) from ${ocr.pages} page image(s) at ${pct}% mean confidence — these characters were GUESSED from pixels, not read from a text layer. Check every amount, claim id, code and date against the image before acting on it.`;
}

/**
 * Fold an OCR reading into the Extraction it came from.
 *
 * PHI is re-detected over the RECOVERED text rather than carried over from the
 * refused extraction, where it was necessarily empty: the member id and the
 * date of birth on a scanned EOB exist only in the pixels, so before OCR there
 * was nothing to find and after it there is. Skipping this step would route a
 * document full of identifiers past the quarantine that exists to catch them.
 */
export function withOcrText(e: Extraction, ocr: OcrResult): Extraction {
  // `refusal` is dropped by omission rather than set to undefined, so a caller
  // testing `"refusal" in e` sees the same thing as one testing `e.refusal`.
  const { refusal: _cleared, ...rest } = e;

  // OCR that recognised nothing is a FAILED OCR, not a blank document. Handing
  // back `readable: true` with an empty string here would be the exact silent
  // blanking this module exists to prevent — a scanner that fed a page upside
  // down, or a photograph too dark to threshold, would arrive as "the payer
  // sent an empty EOB".
  if (ocr.text.trim() === "") {
    return {
      ...rest,
      sections: [],
      text: "",
      readable: false,
      refusal: `OCR ran over this ${e.kind} and recognised no characters at all. That is a failure of the scan, not an empty document: re-scan it straight and at 300 dpi or higher, or ask the sender for the original.`,
      confidence: 0,
      phi: [],
      notes: [...e.notes, `OCR (${ocr.engine}) returned no text from ${ocr.pages} page image(s).`],
    };
  }

  return {
    ...rest,
    sections: [{ label: "OCR", text: ocr.text }],
    text: ocr.text,
    readable: true,
    confidence: ocr.confidence,
    phi: detectPhi(ocr.text),
    notes: [...e.notes, provenanceNote(ocr)],
  };
}

/**
 * Append the install hint to a refusal OCR could have fixed.
 *
 * Returns the ORIGINAL extraction with one sentence added — still unreadable,
 * still carrying its own reason. The alternative shape, returning a "readable"
 * extraction with empty text, is the one that loses a document silently.
 *
 * Idempotent: ingest may pass the same extraction through more than one layer,
 * and a refusal that names the same command three times reads like a bug and
 * gets skimmed past.
 */
export function ocrUnavailableNote(e: Extraction): Extraction {
  const sentence = `OCR would read this, but it is not installed in this build: run \`${OCR_INSTALL_HINT}\` and ingest the file again.`;
  const refusal = e.refusal ?? "";
  if (refusal.includes(OCR_INSTALL_HINT)) return e;
  return { ...e, refusal: refusal === "" ? sentence : `${refusal} ${sentence}` };
}

// ── The engine ───────────────────────────────────────────────────────────────

/**
 * Where trained language data is cached.
 *
 * Under ORION_HOME (default `~/.orion`) rather than in node_modules
 * or the working directory, so a `npm ci` does not throw away a 20 MB download
 * and one install's data serves every checkout. The directory is created when
 * OCR first runs — never at import, because importing a module must not write
 * to the user's disk or reach the network.
 */
function ocrDataDir(): string {
  return path.join(configDir(), "ocr");
}

interface TesseractWorker {
  recognize(image: Buffer | string): Promise<{ data: { text: string; confidence: number } }>;
  terminate(): Promise<void>;
}

interface TesseractModule {
  createWorker(langs?: string, oem?: number, options?: Record<string, unknown>): Promise<TesseractWorker>;
}

/**
 * Load tesseract.js, or fail with something actionable.
 *
 * The specifier lives in a VARIABLE rather than being written inline. It is an
 * optional dependency, so on most machines the package is genuinely absent —
 * and a literal `import("tesseract.js")` makes `tsc` fail the whole build with
 * "Cannot find module" on every one of them, which turns an optional
 * dependency into a required one at compile time. Same lesson as the sqlite
 * adapter: an optional dependency that breaks the build when missing is not
 * optional.
 */
const TESSERACT_SPECIFIER = "tesseract.js";

async function loadTesseract(specifier: string = TESSERACT_SPECIFIER): Promise<TesseractModule> {
  try {
    return (await import(specifier)) as TesseractModule;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `OCR is not available: tesseract.js is not installed. Run \`${OCR_INSTALL_HINT}\` and try again. (${detail})`,
    );
  }
}

/**
 * The cached worker.
 *
 * A tesseract worker costs a second or two to start and loads its trained data
 * once; a batch of 40 scanned EOBs must not pay that 40 times. The PROMISE is
 * cached rather than the worker, so two ingests starting at the same moment
 * share one startup instead of racing into two.
 */
let workerPromise: Promise<TesseractWorker> | null = null;
let workerLang = "";
let workerSpecifier = "";

async function getWorker(lang: string, langPath: string, specifier: string): Promise<TesseractWorker> {
  // A different language needs different trained data, so the cached worker is
  // replaced rather than reused with the wrong model loaded. The specifier is
  // part of the key for the same reason: a worker from one engine module must
  // never be handed back to a caller that asked for another.
  if (workerPromise && (workerLang !== lang || workerSpecifier !== specifier)) await shutdownOcr();
  if (!workerPromise) {
    workerLang = lang;
    workerSpecifier = specifier;
    workerPromise = (async () => {
      const tesseract = await loadTesseract(specifier);
      fs.mkdirSync(langPath, { recursive: true });
      return tesseract.createWorker(lang, undefined, { langPath, cachePath: langPath });
    })();
    // A failed startup must not be cached — otherwise a transient failure
    // (a network blip fetching the trained data) poisons every later call in
    // the process with the same stale rejection.
    workerPromise.catch(() => {
      workerPromise = null;
      workerLang = "";
      workerSpecifier = "";
    });
  }
  return workerPromise;
}

/**
 * Stop the cached worker and let the process exit.
 *
 * Not optional housekeeping. A tesseract worker is a live child process/thread
 * with an open handle, and an open handle keeps Node's event loop alive: the
 * gateway would ignore Ctrl-C and a vitest run would hang after its last
 * assertion. That exact bug — a background handle nobody shut down — has
 * already been fixed once in this repo; this one is not going to reintroduce it.
 */
export async function shutdownOcr(): Promise<void> {
  const pending = workerPromise;
  workerPromise = null;
  workerLang = "";
  workerSpecifier = "";
  if (!pending) return;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    // Never started, or already gone. Either way there is nothing left to stop,
    // and throwing from a shutdown path would mask whatever is really wrong.
  }
}

const execFileAsync = promisify(execFile);

/**
 * Turn a scanned PDF into page images.
 *
 * tesseract reads IMAGES. A PDF is a container, so its pages have to be
 * rasterised first, and doing it in-process would mean a PDF renderer — which
 * this build deliberately does not have. `pdftoppm` (poppler) is used where it
 * exists, ImageMagick where it does not, and when neither does the failure says
 * which two commands would fix it rather than reporting the scan as unreadable
 * a second time for a different reason.
 */
async function rasterizePdf(buf: Buffer): Promise<Buffer[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orion-ocr-"));
  const src = path.join(dir, "input.pdf");
  try {
    fs.writeFileSync(src, buf);
    const attempts: Array<{ cmd: string; args: string[] }> = [
      { cmd: "pdftoppm", args: ["-r", String(RASTER_DPI), "-png", src, path.join(dir, "page")] },
      { cmd: "magick", args: ["-density", String(RASTER_DPI), src, path.join(dir, "page-%d.png")] },
      { cmd: "convert", args: ["-density", String(RASTER_DPI), src, path.join(dir, "page-%d.png")] },
    ];
    const failures: string[] = [];
    for (const attempt of attempts) {
      try {
        await execFileAsync(attempt.cmd, attempt.args, { maxBuffer: 64 * 1024 * 1024 });
      } catch (err) {
        failures.push(`${attempt.cmd}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      // Sorted by name, which is page order: pdftoppm writes page-1..page-N and
      // magick page-0..page-N-1. Reading them in directory order would shuffle
      // an EOB's service lines onto the wrong claim.
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".png"))
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      if (files.length > 0) return files.map((f) => fs.readFileSync(path.join(dir, f)));
      failures.push(`${attempt.cmd}: produced no page images`);
    }
    throw new Error(
      `This PDF is a scan and has to be rasterised before OCR can read it, but no rasteriser is installed. Install poppler (\`pdftoppm\`) or ImageMagick (\`magick\`). Tried — ${failures.join("; ")}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Is OCR usable, and where does its language data live?
 *
 * Answers rather than throws, because the callers are status surfaces — the
 * startup banner, a health route, a tool description. A status check that
 * throws when the thing it is checking is absent reports nothing at all.
 *
 * `specifier` exists so the ENGINE-MISSING path stays under test. tesseract.js
 * is in the lockfile, so CI installs it and a test that only exercises the
 * absent case when the package happens to be absent never runs anywhere it
 * matters — which is how a degradation path rots into a claim nobody checks.
 * Pointing this at a module that is not there reproduces the failure exactly.
 */
export async function ocrStatus(opts: { specifier?: string } = {}): Promise<OcrStatus> {
  const dataDir = ocrDataDir();
  try {
    await loadTesseract(opts.specifier);
    return { available: true, reason: "", dataDir };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err), dataDir };
  }
}

/**
 * Read the characters out of a scan.
 *
 * Throws rather than returning empty text on every failure path — a missing
 * engine, a missing rasteriser, an unreadable buffer. The caller decides what
 * to do with that (`ocrUnavailableNote` is the honest default); what it must
 * never be handed is a successful-looking result holding "".
 */
export async function runOcr(
  buf: Buffer,
  kind: DocumentKind,
  opts: { langPath?: string; specifier?: string } = {},
): Promise<OcrResult> {
  if (kind !== "pdf" && kind !== "image") {
    throw new Error(`OCR reads scanned PDFs and images. A ${kind} has no page image to read; nothing here would help it.`);
  }

  // The engine is checked BEFORE the pages are rasterised, so a machine with
  // neither reports the one worth fixing first rather than complaining about
  // poppler when tesseract is the thing that is missing.
  const langPath = opts.langPath ?? ocrDataDir();
  const worker = await getWorker(DEFAULT_LANG, langPath, opts.specifier ?? TESSERACT_SPECIFIER);

  const images = kind === "pdf" ? await rasterizePdf(buf) : [buf];
  const texts: string[] = [];
  let confidenceSum = 0;

  for (const [i, image] of images.entries()) {
    const { data } = await worker.recognize(image);
    texts.push(images.length > 1 ? `--- Page ${i + 1} ---\n${data.text.trim()}` : data.text.trim());
    // tesseract reports 0–100; Extraction.confidence is 0–1 and the two being
    // silently different would put "94" through a `< MIN_CONFIDENCE` gate that
    // expects 0.94 and pass everything.
    confidenceSum += data.confidence / 100;
  }

  return {
    text: texts.join("\n\n").trim(),
    pages: images.length,
    engine: "tesseract",
    confidence: images.length > 0 ? confidenceSum / images.length : 0,
  };
}
