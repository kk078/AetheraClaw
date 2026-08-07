// ── Reading files nobody can open ────────────────────────────────────────────
// A payer's Transparency in Coverage in-network file is routinely tens of
// gigabytes and sometimes hundreds. JSON.parse on one is not slow, it is
// impossible — the string alone exceeds what a process can hold, and the parsed
// object would be several times larger again.
//
// So the file is never held. This scans it as it arrives and emits one
// in-network record at a time, keeping only the record currently being read.
// Peak memory is the size of the largest single record rather than the size of
// the file, and that bound is the whole design.
//
// The trap that catches every first attempt at this is brace counting. A record
// containing {"name": "Removal of foreign body {see note}"} closes early under a
// naive depth counter, and everything after it is misaligned garbage that still
// parses often enough to look like it worked. Strings and their escapes are
// tracked explicitly here for that reason.

/** A record larger than this is reported rather than buffered without limit. */
export const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;

export interface StreamStats {
  /** Characters fed in. */
  consumed: number;
  /** Complete objects emitted. */
  emitted: number;
  /** Objects abandoned for exceeding the buffer bound. */
  oversize: number;
  /** Largest single record seen, in characters. */
  peakRecordBytes: number;
}

/**
 * Emits top-level objects from inside a JSON array, one at a time.
 *
 * Deliberately not a general JSON parser: it finds object boundaries and hands
 * each object's text to JSON.parse, which is what keeps memory bounded to one
 * record while still getting a real parse of that record.
 */
export class ObjectStreamer {
  private depth = 0;
  private buffer = "";
  private inString = false;
  private escaped = false;
  private started = false;
  /** Inside a record that blew the buffer: still lexing it, no longer keeping it. */
  private skipping = false;
  readonly stats: StreamStats = { consumed: 0, emitted: 0, oversize: 0, peakRecordBytes: 0 };

  constructor(private maxRecordBytes: number = DEFAULT_MAX_RECORD_BYTES) {}

  /** Copy a span that is known to contain nothing the lexer cares about. */
  private append(chunk: string, from: number, to: number): void {
    if (!this.started || this.skipping || to <= from) return;
    this.buffer += chunk.slice(from, to);
    if (this.buffer.length > this.maxRecordBytes) {
      // Stop BUFFERING the oversized record, but keep reading it: the depth and
      // string state have to stay live until its closing brace.
      //
      // Resetting the lexer here instead loses the rest of the file. The
      // abandoned record is usually mid-string, so clearing inString makes the
      // next quote OPEN a string rather than close one, and from then on every
      // brace looks like string content — including the next record's.
      this.stats.oversize++;
      this.skipping = true;
      this.buffer = "";
    }
  }

  /**
   * Feed a chunk; get back whatever completed inside it.
   *
   * Scans in spans rather than character by character. Payer files are tens of
   * gigabytes and the overwhelming majority of every one of them is ordinary
   * text between quotes and braces; appending that a character at a time was the
   * difference between a file taking minutes and taking hours.
   */
  push(chunk: string): string[] {
    const out: string[] = [];
    const n = chunk.length;
    this.stats.consumed += n;
    let i = 0;

    // An escape that straddled the chunk boundary: the escaped character is the
    // first one here and means nothing to the lexer.
    if (this.escaped && n > 0) {
      this.append(chunk, 0, 1);
      this.escaped = false;
      i = 1;
    }

    while (i < n) {
      let j = i;
      if (this.inString) {
        while (j < n) {
          const c = chunk.charCodeAt(j);
          if (c === 34 || c === 92) break; // " or backslash
          j++;
        }
      } else {
        while (j < n) {
          const c = chunk.charCodeAt(j);
          if (c === 34 || c === 123 || c === 125) break; // " { }
          j++;
        }
      }

      if (j > i) {
        this.append(chunk, i, j);
        i = j;
        if (i >= n) break;
      }

      const c = chunk.charCodeAt(i);

      if (this.inString) {
        if (c === 92) {
          if (i + 1 < n) {
            this.append(chunk, i, i + 2);
            i += 2;
          } else {
            // Backslash is the last character in this chunk; remember it.
            this.append(chunk, i, i + 1);
            this.escaped = true;
            i += 1;
          }
          continue;
        }
        this.append(chunk, i, i + 1);
        this.inString = false;
        i++;
        continue;
      }

      if (c === 34) {
        this.append(chunk, i, i + 1);
        this.inString = true;
        i++;
        continue;
      }

      if (c === 123) {
        if (!this.started) {
          this.started = true;
          this.skipping = false;
          this.buffer = "{";
        } else {
          this.append(chunk, i, i + 1);
        }
        this.depth++;
        i++;
        continue;
      }

      // Closing brace.
      this.append(chunk, i, i + 1);
      this.depth--;
      if (this.depth === 0 && this.started) {
        if (!this.skipping) {
          this.stats.peakRecordBytes = Math.max(this.stats.peakRecordBytes, this.buffer.length);
          out.push(this.buffer);
          this.stats.emitted++;
        }
        // Safe to clear the lexer only here: depth is zero and we are provably
        // outside any string.
        this.reset();
      }
      i++;
    }

    return out;
  }

  /** True when a record is part-read — a truncated file ends here. */
  get pending(): boolean {
    return this.started;
  }

  private reset(): void {
    this.depth = 0;
    this.buffer = "";
    this.started = false;
    this.skipping = false;
    this.inString = false;
    this.escaped = false;
  }
}

// ── In-network records ───────────────────────────────────────────────────────

export type NegotiatedType = "negotiated" | "derived" | "fee schedule" | "percentage" | "per diem";
export type BillingClass = "professional" | "institutional";

export interface RateRecord {
  billingCode: string;
  billingCodeType: string;
  description: string;
  negotiatedType: NegotiatedType;
  billingClass: BillingClass;
  /** Dollars for most types; a PERCENTAGE for negotiatedType "percentage". */
  rate: number;
  serviceCodes: string[];
  expirationDate: string;
  /** Whatever identifies the provider side — TIN, NPI list, or a reference id. */
  providerRef: string;
  source: string;
}

export interface IngestOptions {
  /** Only keep these billing codes. Empty keeps everything, which is rarely what you want. */
  codes: string[];
  source: string;
  maxRecordBytes?: number;
  /** Stop after this many matching rates. */
  limit?: number;
}

export interface IngestResult {
  rates: RateRecord[];
  /** Records read and discarded because the code was not wanted. */
  skipped: number;
  stats: StreamStats;
  warnings: string[];
  truncated: boolean;
}

function normalizeCode(code: string): string {
  return String(code).replace(/[.\s]/g, "").toUpperCase();
}

interface RawInNetwork {
  billing_code?: string;
  billing_code_type?: string;
  name?: string;
  description?: string;
  negotiated_rates?: Array<{
    negotiated_prices?: Array<{
      negotiated_type?: string;
      negotiated_rate?: number;
      billing_class?: string;
      service_code?: string[];
      expiration_date?: string;
    }>;
    provider_groups?: Array<{ tin?: { value?: string }; npi?: number[] }>;
    provider_references?: number[];
  }>;
}

/** Pull the rates out of one in-network record. */
export function extractRates(record: RawInNetwork, source: string): RateRecord[] {
  const billingCode = normalizeCode(record.billing_code ?? "");
  if (!billingCode) return [];
  const out: RateRecord[] = [];

  for (const group of record.negotiated_rates ?? []) {
    const providerRef =
      group.provider_groups?.map((g) => g.tin?.value ?? (g.npi ?? []).join("/")).filter(Boolean).join(",") ||
      (group.provider_references ?? []).join(",") ||
      "(unidentified)";

    for (const price of group.negotiated_prices ?? []) {
      if (typeof price.negotiated_rate !== "number" || !Number.isFinite(price.negotiated_rate)) continue;
      out.push({
        billingCode,
        billingCodeType: (record.billing_code_type ?? "").toUpperCase(),
        description: record.name ?? record.description ?? "",
        negotiatedType: (price.negotiated_type ?? "negotiated") as NegotiatedType,
        billingClass: (price.billing_class ?? "professional") as BillingClass,
        rate: price.negotiated_rate,
        serviceCodes: price.service_code ?? [],
        expirationDate: price.expiration_date ?? "",
        providerRef,
        source,
      });
    }
  }
  return out;
}

/**
 * Stream a file's chunks and keep only the codes the practice bills.
 *
 * The filter is the point. A payer file covers every code in the book for every
 * provider in the network; a practice bills a few dozen. Filtering during ingest
 * turns an unopenable file into a table of a few thousand rows, and doing it
 * afterwards would require storing the file first, which is the thing that
 * cannot be done.
 */
export async function ingestRates(
  chunks: AsyncIterable<string> | Iterable<string>,
  options: IngestOptions,
): Promise<IngestResult> {
  const wanted = new Set(options.codes.map(normalizeCode));
  const streamer = new ObjectStreamer(options.maxRecordBytes);
  const rates: RateRecord[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  let truncated = false;

  for await (const chunk of chunks as AsyncIterable<string>) {
    for (const text of streamer.push(chunk)) {
      let record: RawInNetwork;
      try {
        record = JSON.parse(text) as RawInNetwork;
      } catch {
        // A record that will not parse is one record, not the file.
        skipped++;
        continue;
      }
      if (!record.billing_code) continue;
      if (wanted.size > 0 && !wanted.has(normalizeCode(record.billing_code))) {
        skipped++;
        continue;
      }
      rates.push(...extractRates(record, options.source));
      if (options.limit && rates.length >= options.limit) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  if (streamer.pending && !truncated) {
    warnings.push(
      "The file ended part-way through a record. It was truncated in transit or the download did not finish — the rates below are whatever arrived, not the file.",
    );
  }
  if (streamer.stats.oversize > 0) {
    warnings.push(
      `${streamer.stats.oversize} record(s) exceeded the per-record buffer and were skipped. That usually means a single popular code carrying tens of thousands of provider rates; raise max_record_bytes if those codes matter.`,
    );
  }
  if (wanted.size === 0) {
    warnings.push(
      "No code filter was given, so everything was kept. On a real payer file that is the case this module exists to avoid.",
    );
  }
  if (truncated) {
    warnings.push(`Stopped at the ${options.limit} rate limit. There is more in the file.`);
  }

  return { rates, skipped, stats: streamer.stats, warnings, truncated };
}

/** Split a string into fixed-size chunks — for feeding a whole-string source through the streamer. */
export function* chunked(text: string, size = 64 * 1024): Generator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

export function renderIngest(result: IngestResult): string {
  const codes = new Set(result.rates.map((r) => r.billingCode));
  const lines = [
    `Read ${(result.stats.consumed / 1_000_000).toFixed(1)} MB, found ${result.rates.length} rate(s) across ${codes.size} code(s).`,
    `${result.stats.emitted} record(s) examined, ${result.skipped} skipped as codes this practice does not bill.`,
    `Peak memory for a single record: ${(result.stats.peakRecordBytes / 1024).toFixed(0)} KB — the file itself was never held.`,
  ];
  if (result.warnings.length > 0) lines.push("", ...result.warnings.map((w) => `⚠ ${w}`));
  return lines.join("\n");
}
