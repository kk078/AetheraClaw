import zlib from "node:zlib";

// ── A minimal ZIP reader ─────────────────────────────────────────────────────
// .docx and .xlsx are both ZIP containers of XML. Reading them needs a ZIP
// reader and nothing else, so this is one rather than a dependency — the whole
// format surface used here is the central directory and DEFLATE, both of which
// node:zlib already provides.
//
// It reads through the CENTRAL DIRECTORY rather than scanning for local file
// headers. Local headers may carry a zeroed compressed size with the real one
// in a trailing data descriptor (streamed writers do this constantly), so a
// scanner that trusts them reads the wrong number of bytes and inflates
// garbage. The central directory is written last and always has the true sizes.

/** Signatures, named because a bare 0x06054b50 in a bounds check reads as noise. */
const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;

/** The EOCD is followed by a comment of up to 65535 bytes, so the search is bounded. */
const MAX_COMMENT = 0xffff;

export interface ZipEntry {
  name: string;
  /** Uncompressed bytes. */
  data: Buffer;
}

export class ZipError extends Error {}

function findEocd(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - MAX_COMMENT - 22);
  for (let i = buf.length - 22; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Read every entry in a ZIP archive.
 *
 * Entry names are returned exactly as stored. They are NOT resolved against a
 * directory: nothing here writes a file, and a container built to carry
 * `../../etc/cron.d/x` as a member name is a real attack against tools that
 * extract to disk. Everything stays in memory and is looked up by exact name.
 */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new ZipError("Not a ZIP container — no end-of-central-directory record.");

  let count = buf.readUInt16LE(eocd + 10);
  let start = buf.readUInt32LE(eocd + 16);

  // ZIP64: the 32-bit fields saturate and the real values live in a separate
  // record. Office files this large are rare but a spreadsheet export of a
  // year of claims is not, and the failure without this is silent truncation
  // to 65535 entries.
  const loc = eocd - 20;
  if (loc >= 0 && buf.readUInt32LE(loc) === EOCD64_LOCATOR_SIG) {
    const eocd64 = Number(buf.readBigUInt64LE(loc + 8));
    if (eocd64 >= 0 && eocd64 + 56 <= buf.length) {
      count = Number(buf.readBigUInt64LE(eocd64 + 32));
      start = Number(buf.readBigUInt64LE(eocd64 + 48));
    }
  }

  const out = new Map<string, Buffer>();
  let p = start;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new ZipError(`Damaged ZIP central directory at entry ${n + 1} of ${count}.`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");

    // The local header's extra field is frequently a DIFFERENT length from the
    // central one — writers pad it for alignment — so the data offset must be
    // computed from the local header's own fields, never the central copy's.
    if (localOffset + 30 <= buf.length) {
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      try {
        // 0 = stored, 8 = deflate. Anything else (bzip2, LZMA) is legal ZIP and
        // is not produced by Word or Excel; skipping the entry is better than
        // returning bytes that were never decoded.
        if (method === 0) out.set(name, Buffer.from(raw));
        else if (method === 8) out.set(name, zlib.inflateRawSync(raw));
      } catch {
        // One damaged part must not lose the rest of the document.
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** True when the buffer starts with a local file header — "PK\x03\x04". */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}
