import { describe, expect, it } from "vitest";
import {
  DEFAULT_HINT_LIMIT,
  MAX_HINT_LENGTH,
  PROMPT_TOKEN_BUDGET,
  buildHintVocabulary,
  describeVocabulary,
  estimateTokens,
  isUsableHint,
  looksLikePhi,
  normalizeHint,
  renderVocabularyPrompt,
  sanitizeHints,
} from "../src/speech/vocabulary.js";

/** Repeat a term n times, the way a claims query returns one row per claim. */
function billed(code: string, times: number): string[] {
  return Array.from({ length: times }, () => code);
}

/** Deterministic shuffle — a fixed permutation, so a failure reproduces. */
function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ── Admission ────────────────────────────────────────────────────────────────

describe("normalizeHint and isUsableHint", () => {
  it("collapses whitespace so no hint can carry a newline into a request", () => {
    // A CR or LF surviving into a multipart body forges a header; into argv it
    // becomes a second argument. Neither shape has to think about it because
    // this does.
    expect(normalizeHint("  Blue\r\nCross \t Blue  Shield ")).toBe("Blue Cross Blue Shield");
    expect(normalizeHint("\n\t  ")).toBe("");
  });

  it("rejects the entries that cannot help and only cost budget", () => {
    expect(isUsableHint("")).toBe(false);
    expect(isUsableHint("J")).toBe(false); // single character biases every letter
    expect(isUsableHint("---")).toBe(false); // pure punctuation matches nothing
    expect(isUsableHint("&&&")).toBe(false);
    expect(isUsableHint("x".repeat(MAX_HINT_LENGTH + 1))).toBe(false); // a sentence, not a token
    expect(isUsableHint("x".repeat(MAX_HINT_LENGTH))).toBe(true);
    expect(isUsableHint("J1885")).toBe(true);
    expect(isUsableHint("Blue Cross Blue Shield of Massachusetts")).toBe(true);
  });
});

describe("buildHintVocabulary — the things it drops", () => {
  it("drops empty, whitespace, single-character, punctuation-only and over-long entries", () => {
    const hints = buildHintVocabulary({
      extra: ["", "   ", "\t\n", "J", "-", "!!!", "x".repeat(200), "Availity"],
    });
    expect(hints).toEqual(["Availity"]);
  });

  it("returns an empty list for empty input rather than throwing", () => {
    expect(buildHintVocabulary({})).toEqual([]);
    expect(buildHintVocabulary({ codes: [], payers: [], providers: [], extra: [] })).toEqual([]);
    expect(() => buildHintVocabulary({ codes: undefined })).not.toThrow();
  });
});

// ── Casing ───────────────────────────────────────────────────────────────────

describe("case-insensitive dedupe that keeps the best casing", () => {
  it("keeps one entry per term regardless of how it was spelled", () => {
    const hints = buildHintVocabulary({ payers: ["Aetna", "aetna", "AETNA", "AeTnA"] });
    expect(hints).toHaveLength(1);
  });

  it("preserves the casing that appears most often", () => {
    // A hint list of "aetna" helps less than one of "Aetna": the decoder biases
    // toward the literal string, and the transcript comes back with the casing
    // the hint had.
    expect(buildHintVocabulary({ payers: ["aetna", "aetna", "aetna", "Aetna"] })).toEqual(["aetna"]);
    expect(buildHintVocabulary({ payers: ["Aetna", "Aetna", "Aetna", "aetna"] })).toEqual(["Aetna"]);
  });

  it("breaks a casing tie toward the name-shaped spelling, not toward input order", () => {
    // Same counts, opposite input order — the answer must not move.
    expect(buildHintVocabulary({ payers: ["aetna", "Aetna"] })).toEqual(["Aetna"]);
    expect(buildHintVocabulary({ payers: ["Aetna", "aetna"] })).toEqual(["Aetna"]);
    expect(buildHintVocabulary({ payers: ["AETNA", "Aetna"] })).toEqual(["Aetna"]);
    expect(buildHintVocabulary({ payers: ["AETNA", "aetna"] })).toEqual(["AETNA"]);
  });

  it("counts spellings across fields toward the same term", () => {
    const hints = buildHintVocabulary({ payers: ["Availity"], extra: ["availity", "availity"] });
    expect(hints).toEqual(["availity"]);
  });
});

// ── Ranking ──────────────────────────────────────────────────────────────────

describe("ranking", () => {
  it("puts a frequently billed code above one billed once", () => {
    const hints = buildHintVocabulary({ codes: [...billed("J1885", 40), "A4649"] });
    expect(hints[0]).toBe("J1885");
    expect(hints).toContain("A4649");
  });

  it("puts a specific proper noun above a generic lowercase word", () => {
    const hints = buildHintVocabulary({ extra: ["Availity", "claim"] });
    expect(hints).toEqual(["Availity", "claim"]);
  });

  it("puts codes and payers above free-text extras at equal frequency", () => {
    const hints = buildHintVocabulary({ codes: ["99213"], payers: ["Cigna"], extra: ["Widget"] });
    expect(hints.indexOf("99213")).toBeLessThan(hints.indexOf("Widget"));
    expect(hints.indexOf("Cigna")).toBeLessThan(hints.indexOf("Widget"));
  });

  it("is deterministic: the same input twice gives an identical list", () => {
    const source = {
      codes: [...billed("99213", 12), ...billed("J1885", 12), ...billed("A4649", 3)],
      payers: [...billed("Aetna", 12), ...billed("Cigna", 12), "UHC"],
      providers: ["Nguyen", "Okonkwo", "Ramaswamy"],
      extra: ["uhcprovider", "Availity", "navinet"],
    };
    expect(buildHintVocabulary(source)).toEqual(buildHintVocabulary(source));
  });

  it("is deterministic under shuffling: same frequencies, different order, same list", () => {
    // Ties are the common case — most codes are billed the same handful of
    // times — and Array.prototype.sort is stable, so ties left unbroken would
    // fall through to insertion order. That would mean the hint list changed
    // with the row order a query happened to return, and a recognition
    // regression nobody could reproduce.
    const codes = [...billed("99213", 5), ...billed("J1885", 5), ...billed("A4649", 5), ...billed("G0463", 5)];
    const payers = [...billed("Aetna", 5), ...billed("Cigna", 5), ...billed("Humana", 5)];
    const baseline = buildHintVocabulary({ codes, payers });

    for (const seed of [1, 7, 99, 12345]) {
      const scrambled = buildHintVocabulary({ codes: shuffle(codes, seed), payers: shuffle(payers, seed * 3) });
      expect(scrambled).toEqual(baseline);
    }
  });

  it("applies the limit AFTER ranking, so the cap drops the least valuable entries", () => {
    const source = {
      codes: [...billed("J1885", 50), ...billed("99213", 40), ...billed("A4649", 30)],
      extra: ["padding-one", "padding-two", "padding-three"],
    };
    const top = buildHintVocabulary(source, { limit: 2 });
    expect(top).toEqual(["J1885", "99213"]);
    // Ranking first then slicing — not slicing the input then ranking, which
    // would have kept whichever three rows the query returned first.
    expect(buildHintVocabulary(source, { limit: 100 }).slice(0, 3)).toEqual(["J1885", "99213", "A4649"]);
  });

  it("defaults the limit to 100 and honours a smaller one", () => {
    const many = Array.from({ length: 400 }, (_, i) => `Code${String(i).padStart(4, "0")}`);
    expect(buildHintVocabulary({ codes: many })).toHaveLength(DEFAULT_HINT_LIMIT);
    expect(buildHintVocabulary({ codes: many }, { limit: 25 })).toHaveLength(25);
    expect(buildHintVocabulary({ codes: many }, { limit: 0 })).toEqual([]);
  });
});

// ── PHI ──────────────────────────────────────────────────────────────────────

describe("patient identifiers never enter a hint list", () => {
  const identifiers = [
    "123-45-6789", // SSN
    "1EG4-TE5-MK73", // MBI, as the card prints it
    "1EG4TE5MK73", // MBI, unbroken
    "123456789A", // legacy HICN
    "DOB: 04/11/1957", // labelled date of birth
  ];

  it("drops each identifier shape while keeping the legitimate terms around it", () => {
    for (const identifier of identifiers) {
      expect(looksLikePhi(identifier)).toBe(true);
      const hints = buildHintVocabulary({ extra: ["Availity", identifier, "J1885"] });
      expect(hints).not.toContain(identifier);
      expect(hints).toContain("Availity");
      expect(hints).toContain("J1885");
    }
  });

  it("does not mistake the billing vocabulary itself for an identifier", () => {
    // A false positive here silently removes the terms the feature exists for.
    for (const term of ["J1885", "99213", "A4649", "G0463", "E11.65", "Availity", "uhcprovider", "1500"]) {
      expect(looksLikePhi(term)).toBe(false);
    }
    const hints = buildHintVocabulary({ codes: ["J1885", "99213", "A4649", "G0463", "E11.65"] });
    expect(hints).toHaveLength(5);
  });

  it("strips identifiers at the render boundary too, whoever assembled the list", () => {
    // renderVocabularyPrompt is the last function before a hint list becomes
    // part of a request, so it gates rather than trusting its caller — a list
    // built by hand, or read from a config file, gets the same treatment.
    const dirty = ["Aetna", "123-45-6789", "1EG4-TE5-MK73"];
    expect(renderVocabularyPrompt(dirty, "prompt")).toBe("Aetna");
    expect(renderVocabularyPrompt(dirty, "keyterm")).toEqual(["Aetna"]);
    expect(renderVocabularyPrompt(dirty, "grammar")).not.toContain("123-45-6789");
    expect(describeVocabulary(dirty)).not.toContain("123-45-6789");
  });

  it("sanitizeHints filters and dedupes without reordering", () => {
    // Order IS the ranking by the time a list gets here, and the engine's cap
    // eats the tail — resorting would silently discard the wrong entries.
    expect(sanitizeHints(["J1885", "Aetna", "123-45-6789", "j1885", "-", "Availity"])).toEqual([
      "J1885",
      "Aetna",
      "Availity",
    ]);
  });
});

// ── Prompt shape ─────────────────────────────────────────────────────────────

describe('renderVocabularyPrompt("prompt")', () => {
  it("joins with commas, in rank order", () => {
    expect(renderVocabularyPrompt(["J1885", "Aetna", "Availity"], "prompt")).toBe("J1885, Aetna, Availity");
  });

  it("returns an empty string for an empty list", () => {
    expect(renderVocabularyPrompt([], "prompt")).toBe("");
    expect(renderVocabularyPrompt(["", "  ", "-"], "prompt")).toBe("");
  });

  it("truncates within the token cap and always on an entry boundary", () => {
    // Past OpenAI's 224-token prompt cap the tail is dropped by the vendor,
    // mid-entry, at a point we did not choose — so the truncation happens here
    // and lands between entries.
    const hints = Array.from({ length: 300 }, (_, i) => `PayerName${String(i).padStart(3, "0")}`);
    const prompt = renderVocabularyPrompt(hints, "prompt");

    expect(estimateTokens(prompt)).toBeLessThanOrEqual(PROMPT_TOKEN_BUDGET);
    expect(prompt.length).toBeGreaterThan(0);

    const rendered = prompt.split(", ");
    // Every rendered piece is a whole input entry — no half of "PayerName123".
    for (const piece of rendered) expect(hints).toContain(piece);
    // And it is a prefix of the ranked list, not an arbitrary subset.
    expect(rendered).toEqual(renderVocabularyPrompt(hints, "keyterm").slice(0, rendered.length));
    expect(rendered.length).toBeLessThan(hints.length);
    expect(prompt.endsWith(",")).toBe(false);
  });

  it("drops the first entry that will not fit whole instead of cutting it in half", () => {
    // The precise boundary claim: what is emitted fits the budget, and adding
    // the very next ranked entry would not. That is only true if truncation
    // stops between entries — a mid-entry cut would land exactly on the cap.
    const hints = Array.from({ length: 60 }, (_, i) => `Blue Cross Blue Shield of State${String(i).padStart(2, "0")}`);
    const prompt = renderVocabularyPrompt(hints, "prompt");
    const kept = prompt.split(", ");
    const nextEntry = renderVocabularyPrompt(hints, "keyterm")[kept.length]!;

    expect(kept.length).toBeGreaterThan(1);
    expect(kept.length).toBeLessThan(hints.length);
    expect(estimateTokens(prompt)).toBeLessThanOrEqual(PROMPT_TOKEN_BUDGET);
    expect(estimateTokens(`${prompt}, ${nextEntry}`)).toBeGreaterThan(PROMPT_TOKEN_BUDGET);
    // The entry that did not fit is absent entirely, and the string ends on a
    // complete entry rather than on a fragment of the one that was dropped.
    expect(prompt).not.toContain(nextEntry);
    expect(hints).toContain(kept.at(-1));
  });
});

// ── Deepgram shape ───────────────────────────────────────────────────────────

describe('renderVocabularyPrompt("keyterm")', () => {
  it("returns the list as an array, untouched apart from the gate", () => {
    expect(renderVocabularyPrompt(["J1885", "Blue Cross & Blue Shield"], "keyterm")).toEqual([
      "J1885",
      "Blue Cross & Blue Shield",
    ]);
  });

  it("returns an empty array, not an array with an empty string", () => {
    expect(renderVocabularyPrompt([], "keyterm")).toEqual([]);
    expect(renderVocabularyPrompt(["  "], "keyterm")).toEqual([]);
  });

  it("does not apply the prompt token cap — Deepgram has no prompt to overflow", () => {
    const many = Array.from({ length: 300 }, (_, i) => `Term${String(i).padStart(3, "0")}`);
    expect(renderVocabularyPrompt(many, "keyterm")).toHaveLength(300);
  });
});

// ── JSGF shape ───────────────────────────────────────────────────────────────

describe('renderVocabularyPrompt("grammar")', () => {
  it("emits a JSGF grammar the browser will accept", () => {
    const grammar = renderVocabularyPrompt(["Aetna", "J1885"], "grammar");
    expect(grammar).toBe("#JSGF V1.0; grammar orion; public <billing> = Aetna | J1885;");
  });

  it("quotes anything that is not a bare word, so an operator cannot break the parse", () => {
    // SpeechGrammarList.addFromString throws on a malformed grammar, taking
    // every other term down with the one bad entry — so "Blue Cross" (a space),
    // "A | B" (the alternation operator) and "E11.65" (a dot) are all quoted.
    const grammar = renderVocabularyPrompt(
      ["Blue Cross & Blue Shield", "E11.65", "UHC", 'He said "hi"', "back\\slash"],
      "grammar",
    );
    expect(grammar).toContain('"Blue Cross & Blue Shield"');
    expect(grammar).toContain('"E11.65"');
    // A bare alphanumeric word needs no quoting and gets none.
    expect(grammar).toContain("| UHC |");
    expect(grammar).toContain('"He said \\"hi\\""');
    expect(grammar).toContain('"back\\\\slash"');
    expect(grammar.startsWith("#JSGF V1.0;")).toBe(true);
    expect(grammar.endsWith(";")).toBe(true);
  });

  it("returns an empty string for an empty list rather than an invalid empty rule", () => {
    // "public <billing> = ;" is not an empty grammar, it is a parse error.
    expect(renderVocabularyPrompt([], "grammar")).toBe("");
    expect(renderVocabularyPrompt(["!"], "grammar")).toBe("");
  });
});

// ── Status line ──────────────────────────────────────────────────────────────

describe("describeVocabulary", () => {
  it("is one line and names the count, the fit and an example", () => {
    const line = describeVocabulary(["J1885", "Aetna", "Availity"]);
    expect(line).not.toContain("\n");
    expect(line).toContain("3 hints");
    expect(line).toContain("J1885");
    expect(line).toContain(String(PROMPT_TOKEN_BUDGET));
  });

  it("says how many the prompt cap dropped — the number the size alone hides", () => {
    const many = Array.from({ length: 300 }, (_, i) => `PayerName${String(i).padStart(3, "0")}`);
    const line = describeVocabulary(many);
    expect(line).toContain("300 hints");
    expect(line).toMatch(/\d+ dropped/);
    expect(line).not.toContain("\n");
  });

  it("says plainly when there is no vocabulary at all", () => {
    const line = describeVocabulary([]);
    expect(line).toContain("none");
    expect(line).not.toContain("\n");
  });
});
