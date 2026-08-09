import { describe, expect, it } from "vitest";
import {
  describeSnap,
  editDistance,
  loadInstalledUniverse,
  snapCode,
  snapSpokenCode,
  type CodeKind,
  type CodeUniverse,
  type SnapResult,
} from "../src/speech/snap.js";

// Every universe here is synthetic and tiny. That is the point of taking the
// code universe as a parameter: these rules are about what happens when two
// codes are equally close, and that has to be provable against a handful of
// codes chosen to sit at known distances rather than against whichever 74,000
// ICD-10 codes happen to be installed on the machine running the suite.
function universe(parts: Partial<Record<CodeKind, string[]>>): CodeUniverse {
  return {
    cpt: new Set(parts.cpt ?? []),
    hcpcs: new Set(parts.hcpcs ?? []),
    icd10: new Set(parts.icd10 ?? []),
  };
}

/** Assert the status and narrow to it, so the assertions below can read the payload. */
function expectStatus<S extends SnapResult["status"]>(result: SnapResult, status: S): Extract<SnapResult, { status: S }> {
  expect(result.status).toBe(status);
  return result as Extract<SnapResult, { status: S }>;
}

// ── editDistance ─────────────────────────────────────────────────────────────

describe("editDistance", () => {
  it("is zero for identical strings and symmetric otherwise", () => {
    expect(editDistance("99213", "99213")).toBe(0);
    expect(editDistance("99213", "99214")).toBe(editDistance("99214", "99213"));
  });

  it("counts one substituted digit as one edit", () => {
    expect(editDistance("99214", "99215")).toBe(1);
    expect(editDistance("J1885", "J1985")).toBe(1);
  });

  it("counts an adjacent transposition as ONE edit, not two", () => {
    // The whole reason this is Damerau and not plain Levenshtein: a swap is the
    // signature recognizer error, and Levenshtein scores it 2, which puts it
    // outside the default budget and makes the assistant refuse a code the user
    // clearly said.
    expect(editDistance("99213", "99231")).toBe(1);
    expect(editDistance("ab", "ba")).toBe(1);
  });

  it("counts an insertion and a deletion as one edit each", () => {
    expect(editDistance("9921", "99213")).toBe(1);
    expect(editDistance("992133", "99213")).toBe(1);
  });

  it("agrees with the textbook cases", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "99213")).toBe(5);
    expect(editDistance("99213", "")).toBe(5);
  });

  it("caps long input instead of computing it, and the cap never understates the distance", () => {
    // A recognizer that returns a paragraph must not put the gateway inside an
    // O(n·m) loop per installed code. The cap returns max(length), which is a
    // true upper bound — it can suppress a snap, never cause one.
    const long = "a".repeat(100);
    expect(editDistance(long, long)).toBe(0); // equality still short-circuits
    expect(editDistance(long, "a".repeat(99))).toBe(100);
    expect(editDistance(long, "99213")).toBeGreaterThanOrEqual(editDistance("a".repeat(10), "99213"));
  });
});

// ── Rule 1: an exact match is never "corrected" ──────────────────────────────

describe("snapCode — a code that exists is returned as it was said", () => {
  it("returns exact for a member of the universe", () => {
    const hit = expectStatus(snapCode("99214", universe({ cpt: ["99213", "99214"] })), "exact");
    expect(hit.code).toBe("99214");
    expect(hit.kind).toBe("cpt");
  });

  it("still returns exact when a real neighbour sits one edit away", () => {
    // Without the exact-first short circuit this would score 99213 against
    // 99215 and come back as a question about a code that was said correctly.
    const hit = expectStatus(snapCode("99214", universe({ cpt: ["99213", "99214", "99215"] })), "exact");
    expect(hit.code).toBe("99214");
  });

  it("trims and upper-cases before comparing, so casing is not a mishearing", () => {
    const hit = expectStatus(snapCode("  j1885 ", universe({ hcpcs: ["J1885"] })), "exact");
    expect(hit.code).toBe("J1885");
    expect(hit.kind).toBe("hcpcs");
  });
});

// ── Rule 2 and 6: a lone near miss, reported so a person can act on it ───────

describe("snapCode — a single candidate within the budget", () => {
  it("reads a one-edit miss as the only installed code near it", () => {
    const hit = expectStatus(snapCode("99215", universe({ cpt: ["99214"] })), "snapped");
    expect(hit.code).toBe("99214");
    expect(hit.kind).toBe("cpt");
    expect(hit.from).toBe("99215");
    expect(hit.distance).toBe(1);
  });

  it("names the original and the substitution in why", () => {
    const hit = expectStatus(snapCode("99215", universe({ cpt: ["99214"] })), "snapped");
    expect(hit.why).toContain("99215");
    expect(hit.why).toContain("99214");
  });

  it("treats a transposition as a one-edit miss", () => {
    const hit = expectStatus(snapCode("99231", universe({ cpt: ["99213"] })), "snapped");
    expect(hit.code).toBe("99213");
    expect(hit.distance).toBe(1);
  });

  it("snaps a HCPCS mishearing within the HCPCS set", () => {
    const hit = expectStatus(snapCode("J1985", universe({ hcpcs: ["J1885"] })), "snapped");
    expect(hit.code).toBe("J1885");
    expect(hit.kind).toBe("hcpcs");
  });
});

// ── Rule 3: the load-bearing one — a tie is a question, never a pick ─────────

describe("snapCode — a tie is ambiguous, never a pick", () => {
  it("refuses to choose between two codes at the same distance", () => {
    // 99210 is one edit from both. Nothing about the audio distinguishes a
    // level-3 visit from a level-4 one, and picking either is an upcoding or a
    // downcoding finding that nobody will ever trace back to the microphone.
    const tie = expectStatus(snapCode("99210", universe({ cpt: ["99213", "99214"] })), "ambiguous");
    expect(tie.candidates.map((c) => c.code)).toEqual(["99213", "99214"]);
    expect(tie.candidates.every((c) => c.distance === 1)).toBe(true);
  });

  it("lists every tied candidate, not just the first two", () => {
    const tie = expectStatus(
      snapCode("99210", universe({ cpt: ["99211", "99212", "99213", "99214", "99215"] })),
      "ambiguous",
    );
    expect(tie.candidates).toHaveLength(5);
  });

  it("names the original and every candidate in why", () => {
    const tie = expectStatus(snapCode("99210", universe({ cpt: ["99213", "99214"] })), "ambiguous");
    expect(tie.why).toContain("99210");
    expect(tie.why).toContain("99213");
    expect(tie.why).toContain("99214");
  });

  it("does not fall back to the first, the shortest or the nearest-sorting candidate", () => {
    const result = snapCode("99210", universe({ cpt: ["99213", "99214"] }));
    expect(result.status).not.toBe("snapped");
    expect("code" in result).toBe(false);
  });

  it("treats a string that is a real code in two code sets as a tie at distance 0", () => {
    // E1165 is a real HCPCS code (a wheelchair) AND the undotted spelling of a
    // real ICD-10 code. Two exact hits is still no information about which was
    // meant, so it asks rather than preferring a table.
    const tie = expectStatus(snapCode("E1165", universe({ hcpcs: ["E1165"], icd10: ["E11.65"] })), "ambiguous");
    expect(tie.candidates.map((c) => c.code).sort()).toEqual(["E11.65", "E1165"]);
    expect(tie.candidates.every((c) => c.distance === 0)).toBe(true);
  });

  it("resolves that collision when the caller says which code set is being dictated", () => {
    const u = universe({ hcpcs: ["E1165"], icd10: ["E11.65"] });
    expect(expectStatus(snapCode("E1165", u, { kind: "icd10" }), "exact").code).toBe("E11.65");
    expect(expectStatus(snapCode("E1165", u, { kind: "hcpcs" }), "exact").code).toBe("E1165");
  });
});

// ── Rule 2: the distance budget ──────────────────────────────────────────────

describe("snapCode — maxDistance", () => {
  it("rejects a two-edit miss by default", () => {
    // At distance 2 a five-digit code is close to dozens of others, so
    // "nearest" stops being evidence about what was spoken.
    const miss = expectStatus(snapCode("99244", universe({ cpt: ["99213"] })), "unknown");
    expect(miss.from).toBe("99244");
    expect(miss.why).toContain("1 edit");
  });

  it("accepts it only when the caller widens the budget, and reports how far it reached", () => {
    const hit = expectStatus(snapCode("99244", universe({ cpt: ["99213"] }), { maxDistance: 2 }), "snapped");
    expect(hit.code).toBe("99213");
    expect(hit.distance).toBe(2);
  });

  it("admits nothing but exact matches at maxDistance 0", () => {
    const u = universe({ cpt: ["99213"] });
    expect(snapCode("99214", u, { maxDistance: 0 }).status).toBe("unknown");
    expect(snapCode("99213", u, { maxDistance: 0 }).status).toBe("exact");
  });
});

// ── Rule 4: shape decides which table is searched, and no shape means no search ──

describe("snapCode — shape gates the search", () => {
  it("does not fuzzy-match a string of no known code shape", () => {
    // "992134" is one edit from 99213, and matching it anyway is how a six-digit
    // recognizer artefact becomes a billed code.
    const u = universe({ cpt: ["99213"] });
    const long = expectStatus(snapCode("992134", u), "unknown");
    expect(long.why).toContain("not shaped like");
    expect("code" in long).toBe(false);
    expect(snapCode("9921", u).status).toBe("unknown");
    expect(snapCode("hello there", u).status).toBe("unknown");
  });

  it("returns unknown for empty input instead of throwing", () => {
    expect(snapCode("", universe({ cpt: ["99213"] })).status).toBe("unknown");
    expect(snapCode("   ", universe({ cpt: ["99213"] })).status).toBe("unknown");
  });

  it("says a Category II/III code is uncovered rather than unrecognisable", () => {
    // 0054T is a real CPT code; there is simply no table for it here. Saying
    // "that is not a code" about a code would send the reader looking for a
    // typo that does not exist.
    const out = expectStatus(snapCode("0054T", universe({ cpt: ["99213"] })), "unknown");
    expect(out.why).toContain("Category");
  });
});

// ── Rule 5: never snap across kinds ──────────────────────────────────────────

describe("snapCode — kinds are never crossed", () => {
  it("never turns a HCPCS-shaped code into a CPT code", () => {
    // "J1885" is one substitution from "11885". A drug code becoming a surgical
    // code is the single worst substitution this module can make, so the CPT
    // set is not even reachable from a candidate that starts with a letter.
    const out = expectStatus(snapCode("J1885", universe({ cpt: ["11885"] })), "unknown");
    expect(out.from).toBe("J1885");
    expect(JSON.stringify(out)).not.toContain("11885");
  });

  it("never turns a CPT-shaped code into a HCPCS code", () => {
    expect(snapCode("99213", universe({ hcpcs: ["J9213"] })).status).toBe("unknown");
  });

  it("still finds the right answer in the right set when both are installed", () => {
    const u = universe({ cpt: ["11885"], hcpcs: ["J1885"] });
    expect(expectStatus(snapCode("J1985", u), "snapped").code).toBe("J1885");
    expect(expectStatus(snapCode("11985", u), "snapped").code).toBe("11885");
  });

  it("refuses a candidate whose shape contradicts an explicitly named kind", () => {
    const out = expectStatus(snapCode("99213", universe({ cpt: ["99213"] }), { kind: "icd10" }), "unknown");
    expect(out.why).toContain("ICD-10");
    expect("code" in out).toBe(false);
  });
});

// ── ICD-10, with and without the decimal point ───────────────────────────────

describe("snapCode — ICD-10 spelling", () => {
  it("matches a code dictated with the decimal point", () => {
    expect(expectStatus(snapCode("E11.65", universe({ icd10: ["E11.65"] })), "exact").code).toBe("E11.65");
  });

  it("matches the same code dictated without it, answering in the dotted spelling", () => {
    // CMS's own order file omits the dot and every coder types it. Both have to
    // find the one code, and the answer is the spelling that goes on a claim.
    const hit = expectStatus(snapCode("E1165", universe({ icd10: ["E11.65"] }), { kind: "icd10" }), "exact");
    expect(hit.code).toBe("E11.65");
  });

  it("does not spend the edit budget on the missing decimal point", () => {
    // "E1166" is one real digit wrong. If the absent dot counted as an edit it
    // would be two, fall outside the default budget, and a plain mishearing
    // would come back as an unknown code.
    const hit = expectStatus(snapCode("E1166", universe({ icd10: ["E11.65"] }), { kind: "icd10" }), "snapped");
    expect(hit.code).toBe("E11.65");
    expect(hit.distance).toBe(1);
  });

  it("accepts the categories whose third character is a letter", () => {
    // C7A, D3A, M1A and Z3A are real ICD-10-CM categories; a `\d{2}` shape rule
    // would report several hundred real codes as not codes at all.
    const u = universe({ icd10: ["M1A.0110", "Z3A.01"] });
    expect(expectStatus(snapCode("M1A0110", u, { kind: "icd10" }), "exact").code).toBe("M1A.0110");
    expect(expectStatus(snapCode("Z3A.01", u, { kind: "icd10" }), "exact").code).toBe("Z3A.01");
  });
});

// ── Nothing installed ────────────────────────────────────────────────────────

describe("snapCode — an empty universe", () => {
  it("returns unknown rather than throwing, for every code shape", () => {
    const empty = universe({});
    for (const candidate of ["99213", "J1885", "E11.65"]) {
      const out = expectStatus(snapCode(candidate, empty), "unknown");
      expect(out.from).toBe(candidate);
    }
  });

  it("says the code set may simply not be installed, rather than that the code is wrong", () => {
    // "Not a valid code" would be a lie about a code that is perfectly valid in
    // a table this installation has never been given.
    const out = expectStatus(snapCode("99213", universe({})), "unknown");
    expect(out.why).toContain("installed");
  });
});

// ── The whole path from an utterance ─────────────────────────────────────────

describe("snapSpokenCode", () => {
  it("validates a spoken code against the universe", () => {
    const hit = expectStatus(snapSpokenCode("nine nine two one three", universe({ cpt: ["99213"] })), "exact");
    expect(hit.code).toBe("99213");
  });

  it("accepts the grouped shorthand coders actually use", () => {
    expect(expectStatus(snapSpokenCode("ninety nine two thirteen", universe({ cpt: ["99213"] })), "exact").code).toBe("99213");
  });

  it("snaps a spoken near miss to the one code near it", () => {
    const hit = expectStatus(snapSpokenCode("nine nine two one five", universe({ cpt: ["99214"] })), "snapped");
    expect(hit.code).toBe("99214");
    expect(hit.from).toBe("99215");
  });

  it("refuses a spoken tie the same way a written one is refused", () => {
    const tie = expectStatus(snapSpokenCode("nine nine two one zero", universe({ cpt: ["99213", "99214"] })), "ambiguous");
    expect(tie.candidates).toHaveLength(2);
  });

  it("says an utterance did not sound like a code at all", () => {
    const out = expectStatus(snapSpokenCode("let us talk about the weather", universe({ cpt: ["99213"] })), "unknown");
    expect(out.why).toContain("did not sound like a code");
    expect(out.from).toBe("let us talk about the weather");
  });

  it("does not invent a code from an empty utterance", () => {
    expect(snapSpokenCode("", universe({ cpt: ["99213"] })).status).toBe("unknown");
  });
});

// ── The line a person hears ──────────────────────────────────────────────────

describe("describeSnap", () => {
  it("phrases the ambiguous case as a QUESTION naming the codes", () => {
    // This is what the interface does with an ambiguous result: it asks. A
    // statement ("2 candidates found") gets read out and ignored.
    const line = describeSnap(snapCode("99210", universe({ cpt: ["99213", "99214"] })));
    expect(line).toContain("did you mean 99213 or 99214");
    expect(line.endsWith("?")).toBe(true);
  });

  it("uses an or-list for three or more tied codes and still ends in a question mark", () => {
    const line = describeSnap(snapCode("99210", universe({ cpt: ["99213", "99214", "99215"] })));
    expect(line).toContain("did you mean 99213, 99214, or 99215?");
    expect(line.endsWith("?")).toBe(true);
  });

  it("asks for a digit-by-digit reading when too many codes tie to read back", () => {
    const many = universe({ cpt: ["99211", "99212", "99213", "99214", "99215", "99216", "99217"] });
    const line = describeSnap(snapCode("99210", many));
    expect(line).toContain("digit by digit");
    expect(line.endsWith("?")).toBe(true);
  });

  it("states the exact case plainly, without a question", () => {
    const line = describeSnap(snapCode("99214", universe({ cpt: ["99214"] })));
    expect(line).toContain("99214");
    expect(line.endsWith("?")).toBe(false);
  });

  it("names both what was heard and the code used when it snapped", () => {
    const line = describeSnap(snapCode("99215", universe({ cpt: ["99214"] })));
    expect(line).toContain("99215");
    expect(line).toContain("99214");
  });

  it("explains an unknown without proposing a code", () => {
    const line = describeSnap(snapCode("J1885", universe({ cpt: ["11885"] })));
    expect(line).toContain("J1885");
    expect(line).not.toContain("11885");
  });
});

// ── The loader ───────────────────────────────────────────────────────────────

describe("loadInstalledUniverse", () => {
  it("degrades to empty sets when no data is installed, rather than throwing", () => {
    // The suite's AETHERACLAW_HOME is an empty temp directory (test/setup.ts),
    // so this exercises exactly the case that matters: a voice interface must
    // not crash on a dataset that was never installed.
    const u = loadInstalledUniverse();
    expect(u.cpt.size).toBe(0);
    expect(u.hcpcs.size).toBe(0);
    expect(u.icd10.size).toBe(0);
    expect(snapCode("99213", u).status).toBe("unknown");
  });

  it("returns the memoised universe on a second call", () => {
    expect(loadInstalledUniverse()).toBe(loadInstalledUniverse());
  });
});
