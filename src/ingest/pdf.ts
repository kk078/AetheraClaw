import zlib from "node:zlib";

/** Cap on a single inflated PDF stream — a kilobyte of Flate can claim gigabytes. */
const MAX_STREAM_BYTES = 200 * 1024 * 1024;

// ── PDF text extraction ──────────────────────────────────────────────────────
// This is the format that matters most in RCM — EOBs, ADR letters, denial
// letters and appeal determinations all arrive as PDF — and it is the one where
// a naive reader is actively dangerous rather than merely incomplete.
//
// WHY. A PDF does not store text. It stores positioned GLYPH IDS against a
// subset font, plus a `/ToUnicode` CMap per font mapping those ids back to
// characters. Extracting a real EOB with a reader that resolves only the first
// font it finds produced this:
//
//     Explanation of Benefits          <- the heading, perfect
//     �a�e�� �e�i�a�e � ��e�� �������  <- "Payer: Medicare · Check 0012345"
//     otal pai�� �������               <- "Total paid: $142.31"
//
// The decorative heading survived and the claim id, the check number and every
// dollar amount were destroyed. That is the good case, because it is visibly
// broken. The common shortcut — treating unmapped glyph ids as Latin-1 — fails
// SILENTLY, returning digits that are wrong and look right. In a billing system
// "$142.31" against "$143.21" is the entire content of the document.
//
// So fonts are resolved per page, through the page's own resource dictionary,
// and a glyph with no mapping is reported rather than guessed.

export interface PdfPage {
  /** 1-based, as a person refers to it. */
  number: number;
  text: string;
  /** Glyphs on this page that no font CMap could resolve. */
  unresolved: number;
}

export interface PdfText {
  pages: PdfPage[];
  /**
   * True when the file carries no text-drawing operators at all — a scan.
   *
   * Reported rather than returned as empty text: "this PDF is a photograph of
   * a document and needs OCR, which is not installed" is an answer somebody can
   * act on. An empty string is indistinguishable from a blank page.
   */
  scanned: boolean;
  /** Total glyphs no CMap resolved, across every page. */
  unresolved: number;
  /** Total glyphs drawn. `unresolved / glyphs` is the confidence in this reading. */
  glyphs: number;
  producer: string;
}

export class PdfError extends Error {}

// ── Object layer ─────────────────────────────────────────────────────────────

interface PdfObject {
  /** The dictionary/array/scalar source between `obj` and `stream`/`endobj`. */
  head: string;
  /** Decoded stream payload, where the object had one. */
  stream?: Buffer;
}

const OBJ_RE = /(\d+)\s+(\d+)\s+obj\b/g;

/**
 * Index every object in the file by number.
 *
 * Objects are found by SCANNING for `N G obj` rather than by walking the xref
 * table. Real PDFs — especially ones assembled by clearinghouse portals and
 * fax-to-PDF gateways — routinely carry byte offsets that are wrong after an
 * incremental update, and a reader that trusts the xref fails completely on a
 * file every other tool opens. Scanning cannot be defeated by a stale offset.
 */
function indexObjects(buf: Buffer): Map<number, PdfObject> {
  const latin = buf.toString("latin1");
  const objects = new Map<number, PdfObject>();

  OBJ_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OBJ_RE.exec(latin))) {
    const num = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const endObj = latin.indexOf("endobj", bodyStart);
    const streamAt = latin.indexOf("stream", bodyStart);

    // A `stream` keyword only belongs to this object if it comes before endobj.
    const hasStream = streamAt >= 0 && (endObj < 0 || streamAt < endObj);
    const head = latin.slice(bodyStart, hasStream ? streamAt : endObj < 0 ? bodyStart : endObj);

    let stream: Buffer | undefined;
    if (hasStream) {
      // The keyword is followed by CRLF or LF — never CR alone, per the spec,
      // and getting this off by one byte corrupts the first byte of the stream.
      let dataStart = streamAt + "stream".length;
      if (latin[dataStart] === "\r") dataStart++;
      if (latin[dataStart] === "\n") dataStart++;

      // /Length is often an indirect reference that cannot be resolved until
      // every object is indexed, so the endstream marker decides instead.
      const endStream = latin.indexOf("endstream", dataStart);
      if (endStream > dataStart) {
        let raw = buf.subarray(dataStart, endStream);
        // Trim the EOL that precedes `endstream` and is not part of the data.
        if (raw.length && raw[raw.length - 1] === 0x0a) raw = raw.subarray(0, raw.length - 1);
        if (raw.length && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1);
        stream = decodeStream(head, raw);
      }
    }
    objects.set(num, { head, ...(stream ? { stream } : {}) });
  }

  expandObjectStreams(objects);
  return objects;
}

/** Apply the stream filter. Unknown filters yield undefined rather than raw bytes. */
function decodeStream(head: string, raw: Buffer): Buffer | undefined {
  // A stream with no /Filter at all is genuinely stored uncompressed.
  if (!/\/Filter\b/.test(head)) return raw;

  // /Filter is either a name (`/FlateDecode`) or an ARRAY (`[/FlateDecode]`,
  // and for a chain `[/ASCII85Decode /FlateDecode]`). The old regex matched only
  // the name form, so the spec-legal array form fell through to `return raw` —
  // handing the COMPRESSED bytes back as if decoded, which parse as scanned
  // (glyphs 0) and mislabel a text PDF as a scan. Parse both forms and, when a
  // filter is present but not one we can apply, return undefined rather than raw.
  const spec = /\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/.exec(head)?.[1];
  if (!spec) return undefined;
  const names = spec.startsWith("[")
    ? [...spec.matchAll(/\/([A-Za-z0-9]+)/g)].map((m) => m[1])
    : [spec.slice(1)];

  try {
    let out = raw;
    let flated = false;
    for (const name of names) {
      if (name === "FlateDecode") {
        out = zlib.inflateSync(out, { maxOutputLength: MAX_STREAM_BYTES });
        flated = true;
      } else if (name === "ASCIIHexDecode") {
        out = Buffer.from(out.toString("latin1").replace(/[^0-9A-Fa-f]/g, ""), "hex");
      } else if (name === "ASCII85Decode") {
        out = ascii85Decode(out);
      } else {
        // DCTDecode is a JPEG, CCITTFaxDecode is a fax image, and anything else
        // is a filter we do not implement. Returning their bytes as text is how
        // a "reading" full of mojibake gets produced — refuse instead.
        return undefined;
      }
    }
    // The predictor is a Flate concept; applyPredictor is a no-op without a
    // /Predictor in the dictionary, so calling it only after Flate is enough.
    return flated ? applyPredictor(head, out) : out;
  } catch {
    return undefined;
  }
}

/** ASCII85 (base-85) decode, the second-commonest PDF stream filter after Flate. */
function ascii85Decode(raw: Buffer): Buffer {
  const text = raw.toString("latin1").replace(/\s/g, "");
  const end = text.indexOf("~>");
  const body = end >= 0 ? text.slice(0, end) : text;
  const out: number[] = [];
  let tuple = 0;
  let count = 0;
  for (const ch of body) {
    if (ch === "z" && count === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const v = ch.charCodeAt(0) - 33;
    if (v < 0 || v > 84) continue;
    tuple = tuple * 85 + v;
    if (++count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    for (let i = 0; i < count - 1; i++) out.push((tuple >>> (24 - i * 8)) & 0xff);
  }
  return Buffer.from(out);
}

/** PNG predictors, used on xref and object streams. Only Up/Sub/None appear in practice. */
function applyPredictor(head: string, data: Buffer): Buffer {
  const predictor = Number(/\/Predictor\s+(\d+)/.exec(head)?.[1] ?? 1);
  if (predictor < 10) return data;
  const columns = Number(/\/Columns\s+(\d+)/.exec(head)?.[1] ?? 1);
  const rowLen = columns + 1;
  const out: number[] = [];
  const prev = new Uint8Array(columns);
  for (let r = 0; r + rowLen <= data.length; r += rowLen) {
    const tag = data[r];
    const row = data.subarray(r + 1, r + rowLen);
    const cur = new Uint8Array(columns);
    for (let i = 0; i < columns; i++) {
      const a = i > 0 ? cur[i - 1] : 0;
      const b = prev[i];
      cur[i] = tag === 2 ? (row[i] + b) & 0xff : tag === 1 ? (row[i] + a) & 0xff : row[i];
    }
    out.push(...cur);
    prev.set(cur);
  }
  return Buffer.from(out);
}

/**
 * Unpack compressed object streams (`/Type /ObjStm`) into the index.
 *
 * Every PDF produced in the last fifteen years by Acrobat, Word or a payer
 * portal packs most of its dictionaries — including the font and page objects
 * this reader needs — inside these. Without unpacking them the extractor finds
 * no fonts at all and reports a text PDF as scanned.
 */
function expandObjectStreams(objects: Map<number, PdfObject>): void {
  for (const obj of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(obj.head) || !obj.stream) continue;
    const n = Number(/\/N\s+(\d+)/.exec(obj.head)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(obj.head)?.[1] ?? 0);
    const text = obj.stream.toString("latin1");
    const header = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = header[i * 2];
      const off = header[i * 2 + 1];
      if (!Number.isFinite(num) || !Number.isFinite(off)) continue;
      const end = i + 1 < n ? first + header[(i + 1) * 2 + 1] : text.length;
      // A contained object never overrides a top-level one: an incremental
      // update writes the NEWER version outside the stream.
      if (!objects.has(num)) objects.set(num, { head: text.slice(first + off, end) });
    }
  }
}

/** Resolve `12 0 R` to the object it names, following one level of indirection. */
function deref(objects: Map<number, PdfObject>, token: string | undefined): PdfObject | undefined {
  if (!token) return undefined;
  const ref = /^\s*(\d+)\s+\d+\s+R\s*$/.exec(token);
  return ref ? objects.get(Number(ref[1])) : undefined;
}

// ── ToUnicode CMaps ──────────────────────────────────────────────────────────

export type GlyphMap = Map<number, string>;

/**
 * Parse a ToUnicode CMap into glyph id → text.
 *
 * `bfrange` has two forms and both appear in the wild: a start/end/destination
 * triple, and a start/end followed by an ARRAY of individual destinations. The
 * array form is used for non-contiguous mappings, which is exactly what a
 * subset font produces — so a reader handling only the triple form loses the
 * characters that were subset, which are the ones actually used in the document.
 */
export function parseToUnicode(cmap: string): GlyphMap {
  const map: GlyphMap = new Map();
  const codePoint = (hex: string): string => {
    // A destination may be several UTF-16 code units — a ligature such as "ffi"
    // maps one glyph to three characters.
    let s = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return s || String.fromCodePoint(parseInt(hex, 16));
  };

  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(parseInt(pair[1], 16), codePoint(pair[2]));
    }
  }

  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1];
    // Array form first — its opening looks like the triple form's prefix, so
    // matching the triple first would consume it and mis-map the range.
    for (const arr of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(arr[1], 16);
      const dsts = [...arr[3].matchAll(/<([0-9A-Fa-f]*)>/g)].map((d) => d[1]);
      dsts.forEach((d, i) => map.set(lo + i, codePoint(d)));
    }
    const withoutArrays = body.replace(/<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>\s*\[[\s\S]*?\]/g, "");
    for (const tri of withoutArrays.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(tri[1], 16);
      const hi = parseInt(tri[2], 16);
      const dst = parseInt(tri[3], 16);
      // A malformed range claiming millions of glyphs is a decompression bomb
      // in miniature; a real font subset is at most a few hundred.
      if (hi < lo || hi - lo > 65535) continue;
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(dst + (c - lo)));
    }
  }

  return map;
}

/** Every font named in a page's resources, mapped by its resource name (`F4`). */
function pageFonts(objects: Map<number, PdfObject>, pageHead: string): Map<string, GlyphMap> {
  const fonts = new Map<string, GlyphMap>();

  // /Resources may be inline or an indirect reference.
  const resourcesRef = /\/Resources\s+(\d+\s+\d+\s+R)/.exec(pageHead)?.[1];
  const resources = resourcesRef ? (deref(objects, resourcesRef)?.head ?? "") : pageHead;

  const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? "";
  const fontDictRef = /\/Font\s+(\d+\s+\d+\s+R)/.exec(resources)?.[1];
  const entries = fontDict || (deref(objects, fontDictRef)?.head ?? "");

  for (const entry of entries.matchAll(/\/([A-Za-z0-9#+._-]+)\s+(\d+)\s+\d+\s+R/g)) {
    const name = entry[1];
    const font = objects.get(Number(entry[2]));
    if (!font) continue;
    const toUnicodeRef = /\/ToUnicode\s+(\d+\s+\d+\s+R)/.exec(font.head)?.[1];
    const cmapObj = deref(objects, toUnicodeRef);
    if (cmapObj?.stream) fonts.set(name, parseToUnicode(cmapObj.stream.toString("latin1")));
    else fonts.set(name, new Map());
  }

  return fonts;
}

// ── Content streams ──────────────────────────────────────────────────────────

/** Unescape a PDF literal string: `\(`, `\n`, `\053` octal. */
function unescapeLiteral(s: string): string {
  return s.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, (_, esc: string) => {
    const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
    if (esc in simple) return simple[esc];
    return String.fromCharCode(parseInt(esc, 8));
  });
}

const UNRESOLVED = "�";

/**
 * Walk a page's content stream and rebuild its text.
 *
 * Line breaks come from the text-positioning operators rather than from
 * anything in the strings, because a PDF contains no newlines: a table row and
 * the row beneath it are two text objects at different y-coordinates and
 * nothing else. Without this every EOB comes back as one unreadable line with
 * the service lines run together.
 *
 * SEPARATING COLUMNS FROM CONTINUED TEXT is the subtle half, and the naive
 * readings of it both corrupt numbers. Comparing a move against the font size
 * split `99211` into `9921` and `1` in a live remittance — because the file
 * writes that digit as `<9921> Tj 31.40625 0 Td <1> Tj`, and 31.4 is not a gap,
 * it is exactly the width of the text just drawn. Emitting a column separator
 * there turns one CPT code into two fields, and `$63.11` into `$63.1` and `1`.
 *
 * So the comparison is against a PEN POSITION: where the text drawn so far
 * ended, estimated at half an em per character. A move that lands about there
 * is the same run continuing; one that lands materially past it is white space
 * somebody put in deliberately. Both operator families go through the same
 * rule, because both are used for both purposes by real producers.
 *
 * The half-em average is the known weakness — a run of wide capitals is
 * underestimated — so the threshold is small and the fallback is a missing tab
 * rather than a split number.
 */
export function extractContent(content: string, fonts: Map<string, GlyphMap>): { text: string; glyphs: number; unresolved: number } {
  let out = "";
  let glyphs = 0;
  let unresolved = 0;
  let font: GlyphMap | undefined;
  let fontSize = 0;
  let lastY: number | null = null;
  // Where the last drawn text ended, and where the next will start.
  let penX = 0;
  let lineX = 0;

  /** White space wider than this is deliberate. Small, so a bad estimate loses a tab rather than splitting a number. */
  const GAP_EM = 0.15;
  /** How far a relative advance may exceed the estimate and still be the same run continuing. */
  const CONTINUATION_TOLERANCE = 1.6;

  /**
   * Approximate advance for one character, in ems.
   *
   * A flat half-em average was tried first and lost the column breaks in
   * `225.00 142.31` — currency is mostly digits and periods, and a period is
   * barely half the width of a digit, so six characters were overestimated by
   * enough to swallow the gap. Real widths are in the font program; two buckets
   * recover the money columns without parsing it.
   */
  const charWidth = (ch: string): number => {
    if (".,:;'`|!ilI ".includes(ch)) return 0.28;
    if ("-()[]/".includes(ch)) return 0.33;
    if ("WM@%".includes(ch)) return 0.85;
    // Capitals run wide in the serif faces payers use — Georgia's M is nearly
    // twice a digit. Estimating them as digits split "CLM-88011" after the
    // eighth character and put a tab inside a claim id.
    if (ch >= "A" && ch <= "Z") return 0.7;
    return 0.5;
  };

  /** Estimated width of the text drawn since the last positioning operator. */
  let runWidth = 0;

  const advance = (drawn: string) => {
    let em = 0;
    for (const ch of drawn) em += charWidth(ch);
    penX += em * fontSize;
    runWidth += em * fontSize;
  };

  /** A move to absolute `x` on the current line: separator only if it clears the pen. */
  const gapTo = (x: number) => {
    if (x - penX > GAP_EM * fontSize && out && !/\s$/.test(out)) out += "\t";
    penX = x;
    runWidth = 0;
  };

  /**
   * A relative move inside a text object, which is the case worth getting right.
   *
   * `dx` here is not a guess — it is the advance the PRODUCER measured for the
   * text it just drew, from the real font metrics. So it is compared against
   * the estimate as a RATIO rather than an absolute distance, which survives a
   * typeface whose widths differ from the table above, and afterwards the pen is
   * re-anchored to the true position so the estimate's error cannot accumulate
   * across a line.
   */
  const relativeMove = (dx: number, toX: number) => {
    if (dx > runWidth * CONTINUATION_TOLERANCE + GAP_EM * fontSize && out && !/\s$/.test(out)) out += "\t";
    penX = toX;
    runWidth = 0;
  };

  const decodeHex = (hex: string): string => {
    let s = "";
    // Identity-H, the encoding used by every subset font here, is two bytes per
    // glyph. A one-byte simple font is handled by falling back below.
    for (let i = 0; i + 4 <= hex.length; i += 4) {
      const id = parseInt(hex.slice(i, i + 4), 16);
      glyphs++;
      const ch = font?.get(id);
      if (ch === undefined) {
        unresolved++;
        s += UNRESOLVED;
      } else s += ch;
    }
    return s;
  };

  const decodeLiteral = (lit: string): string => {
    const raw = unescapeLiteral(lit);
    let s = "";
    for (const ch of raw) {
      glyphs++;
      // A simple font's string bytes ARE character codes; the CMap, where the
      // font has one, still wins.
      const mapped = font?.get(ch.charCodeAt(0));
      s += mapped ?? ch;
    }
    return s;
  };

  const TOKEN =
    /\/([A-Za-z0-9#+._-]+)\s+([\d.]+)\s+Tf|<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^\\()])*)\)\s*Tj|\[((?:\((?:\\.|[^()])*\)|<[0-9A-Fa-f\s]*>|[^\][])*)\]\s*TJ|([-\d.]+)\s+([-\d.]+)\s+(?:Td|TD)|([-\d.\s]+?)\s+Tm|<([0-9A-Fa-f\s]*)>\s*(['"])|\(((?:\\.|[^\\()])*)\)\s*(['"])|T\*|ET/g;

  for (const t of content.matchAll(TOKEN)) {
    const whole = t[0];

    if (whole.endsWith("Tf")) {
      font = fonts.get(t[1]) ?? new Map();
      fontSize = Number(t[2]) || fontSize;
      continue;
    }
    if (whole.endsWith("Tj") && t[3] !== undefined) {
      const s = decodeHex(t[3].replace(/\s+/g, ""));
      out += s;
      advance(s);
      continue;
    }
    if (whole.endsWith("Tj") && t[4] !== undefined) {
      const s = decodeLiteral(t[4]);
      out += s;
      advance(s);
      continue;
    }
    if (whole.endsWith("TJ") && t[5] !== undefined) {
      // A TJ array interleaves strings with kerning numbers. A large negative
      // adjustment is a word space the file never wrote as a character —
      // ignoring it joins "Total paid" into "Totalpaid".
      for (const piece of t[5].matchAll(/<([0-9A-Fa-f\s]*)>|\((?:\\.|[^\\()])*\)|(-?[\d.]+)/g)) {
        if (piece[1] !== undefined) {
          const s = decodeHex(piece[1].replace(/\s+/g, ""));
          out += s;
          advance(s);
        } else if (piece[2] !== undefined) {
          // A TJ number is a kerning adjustment in thousandths of an em,
          // subtracted from the position. A large one is a space the file never
          // wrote as a character; ignoring it joins "Total paid" into one word.
          const kern = Number(piece[2]);
          penX -= (kern / 1000) * fontSize;
          if (kern < -180 && out && !/\s$/.test(out)) out += " ";
        } else {
          const s = decodeLiteral(piece[0].slice(1, -1));
          out += s;
          advance(s);
        }
      }
      continue;
    }
    // The `'` and `"` operators move to the next line and then show a string —
    // spec-standard, emitted by real producers for line-by-line text. They were
    // matched by nothing, so their text was neither emitted NOR counted: a whole
    // document set with `'` came back glyphs 0 and was misreported as scanned,
    // and one that used it in places dropped those paragraphs at confidence 1,
    // slipping past the very refusal gate that exists to catch a partial read.
    if (whole.endsWith("'") || whole.endsWith('"')) {
      out += "\n";
      lastY = null;
      penX = lineX;
      runWidth = 0;
      if (t[9] !== undefined) {
        const s = decodeHex(t[9].replace(/\s+/g, ""));
        out += s;
        advance(s);
      } else if (t[11] !== undefined) {
        const s = decodeLiteral(t[11]);
        out += s;
        advance(s);
      }
      continue;
    }
    if (whole === "T*") {
      out += "\n";
      lastY = null;
      penX = lineX;
      runWidth = 0;
      continue;
    }
    if (whole.endsWith("Td") || whole.endsWith("TD")) {
      // Relative to the start of the current line, and cumulative.
      if (Number(t[7]) !== 0) {
        out += "\n";
        lineX += Number(t[6]);
        penX = lineX;
        runWidth = 0;
      } else {
        const dx = Number(t[6]);
        lineX += dx;
        relativeMove(dx, lineX);
      }
      continue;
    }
    if (whole.endsWith("Tm")) {
      // A new text object: it sets the line origin outright.
      const nums = t[8].trim().split(/\s+/).map(Number);
      const x = nums[4];
      const y = nums[5];
      if (Number.isFinite(y)) {
        if (lastY !== null && Math.abs(y - lastY) > 0.5) {
          out += "\n";
          penX = x;
          runWidth = 0;
        } else if (lastY !== null) {
          gapTo(x);
        } else {
          penX = x;
          runWidth = 0;
        }
        lastY = y;
      }
      if (Number.isFinite(x)) lineX = x;
      continue;
    }
  }

  return { text: out, glyphs, unresolved };
}

/** Page objects in READING order, walked through the page tree. */
function pages(objects: Map<number, PdfObject>): PdfObject[] {
  // The page tree (/Root → /Pages → /Kids) is what defines both the order pages
  // are read in and which page objects are actually LIVE. Filtering the object
  // table by /Type /Page instead returned pages in byte-scan order — so an
  // incrementally-saved insertion came out last and mislabelled every following
  // page — and resurrected pages that an incremental update had removed from the
  // tree but left in the file. Walk the tree.
  let rootRef: number | undefined;
  for (const obj of objects.values()) {
    if (/\/Type\s*\/Catalog\b/.test(obj.head)) {
      rootRef = Number(/\/Pages\s+(\d+)\s+\d+\s+R/.exec(obj.head)?.[1]);
      break;
    }
  }

  const ordered: PdfObject[] = [];
  const seen = new Set<number>();
  const visit = (num: number): void => {
    if (seen.has(num)) return; // guard against a malformed cyclic tree
    seen.add(num);
    const obj = objects.get(num);
    if (!obj) return;
    // /Page\b does not match /Pages (the following "s" leaves no word boundary),
    // so a leaf is distinguished from an interior node by type alone.
    if (/\/Type\s*\/Page\b/.test(obj.head)) {
      ordered.push(obj);
      return;
    }
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(obj.head);
    if (kids) for (const m of kids[1].matchAll(/(\d+)\s+\d+\s+R/g)) visit(Number(m[1]));
  };
  if (rootRef !== undefined && Number.isFinite(rootRef)) visit(rootRef);

  // Fall back to byte-scan order only when the tree yielded nothing — a
  // malformed or unusually-linearized file still reads, just possibly reordered,
  // rather than returning no pages at all.
  return ordered.length > 0 ? ordered : [...objects.values()].filter((o) => /\/Type\s*\/Page\b/.test(o.head));
}

/** Every content stream belonging to one page, concatenated. */
function pageContent(objects: Map<number, PdfObject>, page: PdfObject): string {
  const single = /\/Contents\s+(\d+\s+\d+\s+R)/.exec(page.head)?.[1];
  const array = /\/Contents\s*\[([^\]]*)\]/.exec(page.head)?.[1];
  const refs = array ? [...array.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => `${m[1]} 0 R`) : single ? [single] : [];
  // Split across several streams mid-operator is legal, so they are joined
  // before parsing rather than parsed one at a time.
  return refs
    .map((r) => deref(objects, r)?.stream?.toString("latin1") ?? "")
    .join("\n");
}

export function extractPdf(buf: Buffer): PdfText {
  if (!buf.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
    throw new PdfError("Not a PDF — the file does not start with %PDF.");
  }

  const objects = indexObjects(buf);
  const producer = /\/Producer\s*\((?:\\.|[^\\()])*\)/.exec(buf.toString("latin1"))?.[0] ?? "";

  const out: PdfPage[] = [];
  let glyphs = 0;
  let unresolved = 0;

  for (const [i, page] of pages(objects).entries()) {
    const content = pageContent(objects, page);
    const fonts = pageFonts(objects, page.head);
    const r = extractContent(content, fonts);
    glyphs += r.glyphs;
    unresolved += r.unresolved;
    out.push({ number: i + 1, text: r.text.replace(/[ \t]+\n/g, "\n").trim(), unresolved: r.unresolved });
  }

  return {
    pages: out,
    scanned: glyphs === 0,
    unresolved,
    glyphs,
    producer: /\((.*)\)/.exec(producer)?.[1] ?? "",
  };
}

/** Share of glyphs that resolved, as a fraction. 1 when nothing was drawn. */
export function readingConfidence(pdf: PdfText): number {
  if (pdf.glyphs === 0) return 1;
  return (pdf.glyphs - pdf.unresolved) / pdf.glyphs;
}

/**
 * Below this, the reading is reported as unusable rather than returned.
 *
 * A document where one glyph in ten is a replacement character is not a
 * document with a few typos — it is one where an unknown subset of the digits
 * is missing, and there is no way to tell which. The failure mode this guards
 * against is a biller reading "$142.31" off a page where the file said
 * something else.
 */
export const MIN_CONFIDENCE = 0.9;
