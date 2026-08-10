import { describe, expect, it } from "vitest";
import { MAX_ARCHIVE_ROWS, buildArchiveView } from "../src/views/archive.js";
import type { ArchiveEntryInput, ArchiveRowStatus, ArchiveViewData } from "../src/views/archive.js";
import { summarize } from "../src/views/verdict.js";
import type { ToolView } from "../src/views/types.js";

const entry = (over: Partial<ArchiveEntryInput> = {}): ArchiveEntryInput => ({
  filename: "eob.pdf",
  kind: "pdf",
  status: "read",
  characters: 1200,
  ...over,
});

const build = (entries: ArchiveEntryInput[], over: Partial<Parameters<typeof buildArchiveView>[0]> = {}) =>
  buildArchiveView({
    archiveId: "arc_1",
    filename: "june-correspondence.zip",
    status: "completed",
    entries,
    ...over,
  });

const view = (data: ArchiveViewData): ToolView => ({ kind: "archive_manifest", data });

/** n entries that read cleanly, named so a test can tell them apart. */
const clean = (n: number, prefix = "ok"): ArchiveEntryInput[] =>
  Array.from({ length: n }, (_, i) => entry({ filename: `${prefix}-${i}.pdf` }));

describe("archive manifest view", () => {
  it("counts every entry but lists at most MAX_ARCHIVE_ROWS", () => {
    const v = build(clean(MAX_ARCHIVE_ROWS + 12));

    // The counts describe the ARCHIVE; the rows describe what fits on a screen.
    // Deriving the first from the second is how a manifest ends up claiming the
    // archive held fifty files.
    expect(v.total).toBe(MAX_ARCHIVE_ROWS + 12);
    expect(v.read).toBe(MAX_ARCHIVE_ROWS + 12);
    expect(v.rows).toHaveLength(MAX_ARCHIVE_ROWS);
  });

  it("reports the remainder the cap left out instead of dropping it", () => {
    expect(build(clean(MAX_ARCHIVE_ROWS + 214)).truncated).toBe(214);
    // A table that is whole says so with a zero, not with a flag somebody has
    // to interpret.
    expect(build(clean(3)).truncated).toBe(0);
    expect(build(clean(MAX_ARCHIVE_ROWS)).truncated).toBe(0);
  });

  it("counts entries that the cap cut out of the row list", () => {
    // The three failures are at the END of the input, past the cap. If counting
    // ran over `rows` they would vanish from the panel entirely.
    const v = build([
      ...clean(MAX_ARCHIVE_ROWS + 20),
      entry({ filename: "locked.pdf", status: "refused", detail: "Encrypted." }),
      entry({ filename: "scan.tif", status: "ocr", characters: 90 }),
      entry({ filename: "junk.bin", status: "skipped", detail: "Unsupported compression method." }),
    ]);

    expect(v.total).toBe(MAX_ARCHIVE_ROWS + 23);
    expect(v.refused).toBe(1);
    expect(v.ocr).toBe(1);
    expect(v.skipped).toBe(1);
    expect(v.read).toBe(MAX_ARCHIVE_ROWS + 20);
    expect(v.total).toBe(v.read + v.ocr + v.refused + v.skipped);
  });

  it("puts refused and skipped first, then ocr, then read", () => {
    const v = build([
      entry({ filename: "a-read.pdf", status: "read" }),
      entry({ filename: "b-ocr.pdf", status: "ocr" }),
      entry({ filename: "c-refused.pdf", status: "refused" }),
      entry({ filename: "d-read.pdf", status: "read" }),
      entry({ filename: "e-skipped.bin", status: "skipped" }),
    ]);

    expect(v.rows.map((r) => r.filename)).toEqual([
      "c-refused.pdf",
      "e-skipped.bin",
      "b-ocr.pdf",
      "a-read.pdf",
      "d-read.pdf",
    ]);
  });

  it("keeps the three failures visible when they would otherwise fall past the cap", () => {
    // The whole reason the ordering exists: a fifty-row cap spent on successes
    // is the wrong fifty.
    const v = build([
      ...clean(MAX_ARCHIVE_ROWS + 5),
      entry({ filename: "locked.pdf", status: "refused", detail: "Encrypted." }),
      entry({ filename: "corrupt.bin", status: "skipped", detail: "Damaged central directory." }),
    ]);

    expect(v.rows.slice(0, 2).map((r) => r.filename)).toEqual(["locked.pdf", "corrupt.bin"]);
    expect(v.rows).toHaveLength(MAX_ARCHIVE_ROWS);
  });

  it("preserves archive order within a rank", () => {
    const v = build([
      entry({ filename: "second.pdf", status: "refused" }),
      entry({ filename: "first.bin", status: "skipped" }),
      entry({ filename: "third.pdf", status: "refused" }),
    ]);
    expect(v.rows.map((r) => r.filename)).toEqual(["second.pdf", "first.bin", "third.pdf"]);
  });

  it("does not count an OCR'd entry as read", () => {
    // The characters came from a machine's guess at pixels. An operator
    // reconciling against that text is doing something different from one
    // reading extracted text, and the table has to say which.
    const v = build([entry({ filename: "fax.tif", status: "ocr", characters: 800 }), entry({ filename: "clean.pdf" })]);

    expect(v.ocr).toBe(1);
    expect(v.read).toBe(1);
    expect(v.rows.find((r) => r.filename === "fax.tif")!.status).toBe("ocr");
  });

  it("carries PHI signal KINDS and nothing else — no counts, no values", () => {
    const v = build([
      entry({
        filename: "eob.pdf",
        phi: [
          { kind: "ssn", count: 3, hint: "line 4" },
          { kind: "mbi", count: 1, hint: "line 9" },
        ] as ReadonlyArray<{ kind: string; count: number; hint: string }>,
      }),
    ]);

    const row = v.rows[0]!;
    expect(row.phi).toEqual(["ssn", "mbi"]);
    // Serialised, the row must contain no count and no hint that could lead
    // back to a value.
    const json = JSON.stringify(row);
    expect(json).not.toMatch(/count/);
    expect(json).not.toMatch(/hint/);
    expect(json).not.toMatch(/line 4/);
  });

  it("accepts bare kind strings and deduplicates them", () => {
    const v = build([entry({ phi: ["ssn", "ssn", "dob"] })]);
    expect(v.rows[0]!.phi).toEqual(["ssn", "dob"]);
  });

  it("leaves optional fields off rather than filling them with empty strings", () => {
    const row = build([entry()]).rows[0]!;
    expect(row.detail).toBeUndefined();
    expect(row.routeTo).toBeUndefined();
    expect(row.documentId).toBeUndefined();
    expect(row.phi).toEqual([]);
  });

  it("carries the routing decision and the refusal reason through", () => {
    const v = build([
      entry({ filename: "era.835", kind: "x12", classification: "remittance", routeTo: "era_parse_835", documentId: "doc_9" }),
      entry({ filename: "locked.pdf", status: "refused", detail: "Encrypted — no password supplied." }),
    ]);

    const refused = v.rows[0]!;
    const era = v.rows[1]!;
    expect(refused.detail).toBe("Encrypted — no password supplied.");
    expect(era.routeTo).toBe("era_parse_835");
    expect(era.classification).toBe("remittance");
    expect(era.documentId).toBe("doc_9");
  });

  it("reports an empty archive as empty rather than as clean", () => {
    const v = build([]);
    expect(v.total).toBe(0);
    expect(v.rows).toEqual([]);
    expect(v.truncated).toBe(0);
    expect(summarize(view(v))!.because).toMatch(/not a statement/);
  });
});

describe("archive manifest card", () => {
  const withStatuses = (statuses: ArchiveRowStatus[], over = {}) =>
    build(statuses.map((status, i) => entry({ filename: `f-${i}`, status })), over);

  it("clears an archive where everything came out with text", () => {
    const c = summarize(view(withStatuses(["read", "read", "ocr"])))!;
    expect(c.verdict).toBe("clear");
    expect(c.verdictLabel).toBe("CLEAR");
    // CLEAR must not quietly swallow the fact that some of the text is a guess.
    expect(c.because).toMatch(/OCR/);
  });

  it("only REVIEWS refusals — the entry is accounted for", () => {
    const c = summarize(view(withStatuses(["read", "refused"])))!;
    expect(c.verdict).toBe("review");
  });

  it("HOLDs when an entry could not be decoded at all", () => {
    // A file the operator believes they delivered is not in the system.
    const c = summarize(view(withStatuses(["read", "read", "skipped"])))!;
    expect(c.verdict).toBe("hold");
    expect(c.because).toMatch(/could not be decoded/);
  });

  it("HOLDs a skipped entry even when refusals are also present", () => {
    expect(summarize(view(withStatuses(["refused", "skipped"])))!.verdict).toBe("hold");
  });

  it("HOLDs a failed run even when every entry it did reach was read", () => {
    const c = summarize(view(withStatuses(["read", "read"], { status: "failed" })))!;
    expect(c.verdict).toBe("hold");
    expect(c.because).toMatch(/partial/);
  });

  it("says a processing archive is still running without changing the badge", () => {
    const c = summarize(view(withStatuses(["read"], { status: "processing" })))!;
    expect(c.verdict).toBe("clear");
    expect(c.because).toMatch(/still running/);
  });

  it("leads with the files needing attention, not with the total", () => {
    const c = summarize(view(withStatuses(["read", "read", "refused", "skipped"])))!;
    expect(c.facts[0]!.label).toBe("Needs attention");
    expect(c.facts[0]!.value).toMatch(/^2 —/);
    // The total comes last, and reports what the table could not show.
    expect(c.facts.at(-1)!.label).toBe("Entries");
  });

  it("says on the card how many entries the table does not list", () => {
    const c = summarize(view(build(clean(MAX_ARCHIVE_ROWS + 9))))!;
    expect(c.facts.at(-1)!.value).toBe(`${MAX_ARCHIVE_ROWS + 9} (9 not listed below)`);
  });

  it("shows the OCR fact even at zero", () => {
    const c = summarize(view(withStatuses(["read"])))!;
    expect(c.facts.map((f) => f.label)).toContain("Machine-read (OCR)");
    expect(c.facts.find((f) => f.label === "Machine-read (OCR)")!.value).toBe("none");
  });

  it("titles the card with the archive filename, and carries no subject", () => {
    const c = summarize(view(build(clean(1))))!;
    expect(c.title).toBe("Archive — june-correspondence.zip");
    expect(c.subject).toBeUndefined();
  });
});
