import { describe, expect, it } from "vitest";
import {
  describeScreen,
  findDeixis,
  redactScreenLabels,
  resolveDeixis,
  type DeixisResolution,
  type ScreenContext,
  type ScreenRow,
} from "../src/speech/deixis.js";

// Every screen here is three or four synthetic rows. That is the point of taking
// the screen as a parameter: these rules are about what happens when the words
// do not pick exactly one row, and that has to be provable against rows chosen to
// sit in known positions rather than against whatever a browser happened to
// render.

function row(id: string, label: string, index: number, kind?: string): ScreenRow {
  return kind === undefined ? { id, label, index } : { id, label, index, kind };
}

const WORKLIST: ScreenRow[] = [
  row("CLM-1001", "Aetna CO-97 bundled", 0, "denial"),
  row("CLM-1002", "Cigna CO-16 missing modifier", 1, "denial"),
  row("CLM-1003", "UHC CO-29 timely filing", 2, "denial"),
];

function screen(over: Partial<ScreenContext> = {}): ScreenContext {
  return { view: "worklist", title: "Denial worklist", rows: WORKLIST, ...over };
}

/** Assert the status and narrow to it, so the assertions below can read the payload. */
function expectStatus<S extends DeixisResolution["status"]>(
  result: DeixisResolution,
  status: S,
): Extract<DeixisResolution, { status: S }> {
  expect(result.status).toBe(status);
  return result as Extract<DeixisResolution, { status: S }>;
}

/**
 * What the calling pipeline is obliged to do with a resolution.
 *
 * Written out here rather than assumed, because rule 1 is a statement about the
 * CALLER: a `none` must leave the utterance untouched, and the only way to test
 * that is to run the branch the caller would run.
 */
function apply(text: string, context: ScreenContext): string {
  const resolved = resolveDeixis(text, context);
  return resolved.status === "resolved" ? resolved.text : text;
}

// ── findDeixis ───────────────────────────────────────────────────────────────

describe("findDeixis", () => {
  it("finds bare demonstratives", () => {
    expect(findDeixis("appeal that one")).toEqual(["that one"]);
    expect(findDeixis("open this one")).toEqual(["this one"]);
    expect(findDeixis("why was that claim denied")).toEqual(["that claim"]);
    expect(findDeixis("write up this denial")).toEqual(["this denial"]);
  });

  it("finds ordinals, including the last one", () => {
    expect(findDeixis("appeal the second one")).toEqual(["the second one"]);
    expect(findDeixis("open the third")).toEqual(["the third"]);
    expect(findDeixis("show me the last one")).toEqual(["the last one"]);
    expect(findDeixis("the first claim please")).toEqual(["the first claim"]);
    expect(findDeixis("work the 2nd one")).toEqual(["the 2nd one"]);
  });

  it("finds 'it' after an action verb, and in a passive question", () => {
    expect(findDeixis("appeal it")).toEqual(["it"]);
    expect(findDeixis("resubmit it today")).toEqual(["it"]);
    expect(findDeixis("why was it denied")).toEqual(["it"]);
    expect(findDeixis("has it been paid")).toEqual(["it"]);
  });

  it("does NOT treat a copular 'it' as a row reference", () => {
    // The whole conservative-'it' rule in one test. Each of these is a complete,
    // correct utterance today; treating any of them as a reference would rewrite
    // a sentence that needed no help, and the speaker would never see it happen.
    expect(findDeixis("what is it")).toEqual([]);
    expect(findDeixis("is it billable")).toEqual([]);
    expect(findDeixis("is it urgent")).toEqual([]);
    expect(findDeixis("what was it")).toEqual([]);
  });

  it("does NOT treat a complementizer 'that' or a non-row ordinal as pointing", () => {
    expect(findDeixis("I think that the payer bundled the line")).toEqual([]);
    expect(findDeixis("make sure that the modifier goes on")).toEqual([]);
    expect(findDeixis("the last time we appealed it was denied")).toEqual([]);
    expect(findDeixis("get me the second opinion")).toEqual([]);
    expect(findDeixis("hang on a second")).toEqual([]);
  });

  it("returns nothing for an utterance that names its own subject", () => {
    expect(findDeixis("appeal claim 10024")).toEqual([]);
    expect(findDeixis("what is the timely filing limit for Aetna")).toEqual([]);
  });
});

// ── Rule 1: no reference, no rewrite ─────────────────────────────────────────

describe("resolveDeixis — rule 1, nothing pointed at", () => {
  it("reports none and leaves the text byte-identical", () => {
    const utterances = [
      "appeal claim 10024",
      "what is it",
      "is it billable",
      "I think that the payer bundled the line",
      "what is the timely filing limit for Aetna",
    ];
    for (const said of utterances) {
      const result = resolveDeixis(said, screen());
      expect(result).toEqual({ status: "none" });
      // Byte-identical, not merely equal after trimming: the caller passes this
      // straight to the model, and a stray space here is a diff in the prompt.
      expect(apply(said, screen())).toBe(said);
    }
  });

  it("carries no text field at all on a none, so there is nothing to misuse", () => {
    expect(Object.keys(resolveDeixis("appeal claim 10024", screen()))).toEqual(["status"]);
  });
});

// ── Rule 2: a demonstrative rides on the selection ───────────────────────────

describe("resolveDeixis — rule 2, demonstrative plus a selection", () => {
  it("resolves to the selected row and rewrites only the phrase", () => {
    const result = expectStatus(resolveDeixis("please appeal that one today", screen({ selectedId: "CLM-1002" })), "resolved");
    expect(result.row.id).toBe("CLM-1002");
    expect(result.phrase).toBe("that one");
    expect(result.text).toBe("please appeal Cigna CO-16 missing modifier (CLM-1002) today");
  });

  it("rewrites a bare 'it' in place, leaving the verb and the rest alone", () => {
    const result = expectStatus(resolveDeixis("why was it denied", screen({ selectedId: "CLM-1003" })), "resolved");
    expect(result.text).toBe("why was UHC CO-29 timely filing (CLM-1003) denied");
  });

  it("ignores a stale selection that is no longer among the rows", () => {
    // The list was refiltered under the selection. Honouring the id would act on
    // a row that is not on screen — the exact failure the membership check is
    // there for — so this falls through to the ambiguous rule instead.
    const result = expectStatus(resolveDeixis("appeal that one", screen({ selectedId: "CLM-9999" })), "ambiguous");
    expect(result.candidates.map((c) => c.id)).toEqual(["CLM-1001", "CLM-1002", "CLM-1003"]);
  });
});

// ── Rule 3: several rows, nothing selected ───────────────────────────────────

describe("resolveDeixis — rule 3, ambiguous", () => {
  it("refuses rather than defaulting to the first row", () => {
    const result = expectStatus(resolveDeixis("appeal that one", screen()), "ambiguous");
    expect(result.phrase).toBe("that one");
    expect(result.candidates.map((c) => c.id)).toEqual(["CLM-1001", "CLM-1002", "CLM-1003"]);
    expect(result.why).toContain("3 rows");
    expect(result.why).toContain("No row was chosen");
    // Nothing in the result is a usable rewrite: there is no text field, so a
    // caller cannot accidentally send a guessed utterance.
    expect(result).not.toHaveProperty("text");
  });

  it("caps the candidate list and says how many were elided", () => {
    const many = Array.from({ length: 9 }, (_, i) => row(`CLM-20${i}`, `Denial ${i}`, i));
    const result = expectStatus(resolveDeixis("appeal that one", screen({ rows: many })), "ambiguous");
    expect(result.candidates).toHaveLength(5);
    expect(result.why).toContain("9 rows");
    expect(result.why).toContain("4 more were left out");
  });
});

// ── Rule 4: exactly one row ──────────────────────────────────────────────────

describe("resolveDeixis — rule 4, a single row", () => {
  it("resolves without a selection, because there is no second reading", () => {
    const only = [row("CLM-1001", "Aetna CO-97 bundled", 0, "denial")];
    const result = expectStatus(resolveDeixis("appeal it", screen({ rows: only })), "resolved");
    expect(result.row.id).toBe("CLM-1001");
    expect(result.text).toBe("appeal Aetna CO-97 bundled (CLM-1001)");
  });
});

// ── Rule 5: ordinals ─────────────────────────────────────────────────────────

describe("resolveDeixis — rule 5, ordinals", () => {
  it("counts from one, in screen order", () => {
    expect(expectStatus(resolveDeixis("appeal the first one", screen()), "resolved").row.id).toBe("CLM-1001");
    expect(expectStatus(resolveDeixis("appeal the second one", screen()), "resolved").row.id).toBe("CLM-1002");
    expect(expectStatus(resolveDeixis("appeal the third", screen()), "resolved").row.id).toBe("CLM-1003");
  });

  it("reads 'the last one' as the final row", () => {
    expect(expectStatus(resolveDeixis("open the last one", screen()), "resolved").row.id).toBe("CLM-1003");
  });

  it("counts screen order, not the caller's own row index", () => {
    // The caller's index survives a filter; screen order does not. "The second
    // one" is about what the speaker can see, so it must follow the array.
    const filtered = [row("CLM-4004", "UHC CO-29", 7), row("CLM-4009", "Aetna CO-97", 12)];
    const result = expectStatus(resolveDeixis("appeal the second one", screen({ rows: filtered })), "resolved");
    expect(result.row.id).toBe("CLM-4009");
    expect(result.row.index).toBe(12);
  });

  it("beats a selection, because a position was named out loud", () => {
    const result = expectStatus(resolveDeixis("appeal the first one", screen({ selectedId: "CLM-1003" })), "resolved");
    expect(result.row.id).toBe("CLM-1001");
  });

  it("is ambiguous past the end, and says how many rows there actually are", () => {
    const result = expectStatus(resolveDeixis("appeal the fourth one", screen()), "ambiguous");
    expect(result.phrase).toBe("the fourth one");
    expect(result.why).toContain("row 4");
    expect(result.why).toContain("only 3 rows");
    expect(result.candidates).toHaveLength(3);
  });
});

// ── Rule 6: nothing on screen ────────────────────────────────────────────────

describe("resolveDeixis — rule 6, no screen", () => {
  it("reports no-context and tells the speaker to name the claim", () => {
    const result = expectStatus(resolveDeixis("appeal that one", { rows: [] }), "no-context");
    expect(result.phrase).toBe("that one");
    expect(result.why).toContain("Name the claim");
  });

  it("applies to ordinals and pronouns as well as demonstratives", () => {
    expect(resolveDeixis("appeal the second one", { rows: [] }).status).toBe("no-context");
    expect(resolveDeixis("why was it denied", { rows: [] }).status).toBe("no-context");
  });
});

// ── Only the leftmost phrase is rewritten ────────────────────────────────────

describe("resolveDeixis — one rewrite per utterance", () => {
  it("names the row once and lets the later pronoun refer to it", () => {
    const result = expectStatus(
      resolveDeixis("appeal that one and tell me why it was denied", screen({ selectedId: "CLM-1001" })),
      "resolved",
    );
    expect(result.text).toBe("appeal Aetna CO-97 bundled (CLM-1001) and tell me why it was denied");
  });
});

// ── redactScreenLabels ───────────────────────────────────────────────────────

describe("redactScreenLabels", () => {
  it("runs labels and the title through the shared redaction", () => {
    const dirty: ScreenContext = {
      title: "Denials — SSN 123-45-6789",
      rows: [
        row("CLM-1", "Alvarez, Maria 123-45-6789 CO-97", 0),
        row("CLM-2", "Chen, Wei DOB: 04/12/1955 CO-16", 1),
      ],
      selectedId: "CLM-2",
    };
    const clean = redactScreenLabels(dirty);
    expect(clean.rows[0].label).toBe("Alvarez, Maria [REDACTED-SSN] CO-97");
    expect(clean.rows[1].label).toBe("Chen, Wei [REDACTED-DOB] CO-16");
    expect(clean.title).toBe("Denials — SSN [REDACTED-SSN]");
    // Ids are the resolution key, not rendered patient text. Redacting them
    // would break the one thing the preamble exists to enable.
    expect(clean.rows.map((r) => r.id)).toEqual(["CLM-1", "CLM-2"]);
    expect(clean.selectedId).toBe("CLM-2");
    // The caller's own context is untouched — this is a copy, not a scrub in
    // place, so the screen the user is looking at keeps showing what it showed.
    expect(dirty.rows[0].label).toBe("Alvarez, Maria 123-45-6789 CO-97");
  });

  it("redacts the label before it can enter a rewritten utterance", () => {
    // The transcript gate has already run by the time deixis resolves, so a raw
    // label spliced into the text here would never be seen by it.
    const rows = [row("CLM-1", "Alvarez, Maria 123-45-6789", 0)];
    const result = expectStatus(resolveDeixis("appeal that one", { rows }), "resolved");
    expect(result.text).toBe("appeal Alvarez, Maria [REDACTED-SSN] (CLM-1)");
    expect(result.row.label).toBe("Alvarez, Maria [REDACTED-SSN]");
  });
});

// ── describeScreen ───────────────────────────────────────────────────────────

describe("describeScreen", () => {
  it("names the screen, numbers the rows and names the selection", () => {
    const text = describeScreen(screen({ selectedId: "CLM-1002" }));
    expect(text).toContain(`[The user is looking at "Denial worklist" — 3 rows on screen.]`);
    expect(text).toContain("1. Aetna CO-97 bundled — row id CLM-1001 (denial)");
    expect(text).toContain("Selected: 2. Cigna CO-16 missing modifier — row id CLM-1002");
    expect(text).not.toContain("more row");
  });

  it("respects the row cap and reports the elision rather than dropping it", () => {
    const many = Array.from({ length: 12 }, (_, i) => row(`CLM-30${i}`, `Denial ${i}`, i));
    const text = describeScreen({ title: "Big worklist", rows: many }, { maxRows: 3 });
    const lines = text.split("\n");
    expect(lines.filter((l) => /^\d+\. /.test(l))).toHaveLength(3);
    expect(text).toContain("12 rows on screen");
    expect(text).toContain("…and 9 more rows not listed.");
    expect(text).not.toContain("Denial 3");
  });

  it("defaults to ten rows", () => {
    const many = Array.from({ length: 25 }, (_, i) => row(`CLM-40${i}`, `Denial ${i}`, i));
    const text = describeScreen({ rows: many });
    expect(text.split("\n").filter((l) => /^\d+\. /.test(l))).toHaveLength(10);
    expect(text).toContain("…and 15 more rows not listed.");
  });

  it("still names a selection the cap elided", () => {
    const many = Array.from({ length: 12 }, (_, i) => row(`CLM-50${i}`, `Denial ${i}`, i));
    const text = describeScreen({ rows: many, selectedId: "CLM-507" }, { maxRows: 2 });
    expect(text).toContain("Selected: 8. Denial 7 — row id CLM-507");
  });

  it("says so when the selection is no longer in the list", () => {
    expect(describeScreen(screen({ selectedId: "CLM-9999" }))).toContain("treat nothing as selected");
  });

  it("redacts labels on the way into the preamble", () => {
    const text = describeScreen({ rows: [row("CLM-1", "Alvarez, Maria 123-45-6789", 0)] });
    expect(text).toContain("[REDACTED-SSN]");
    expect(text).not.toContain("123-45-6789");
  });

  it("is empty when nothing is on screen, so the turn looks like any other", () => {
    expect(describeScreen({ rows: [] })).toBe("");
  });
});
