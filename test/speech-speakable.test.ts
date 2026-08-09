import { describe, expect, it } from "vitest";
import {
  normalizeSpokenCodes,
  parseSpokenCode,
  speakCode,
  speakDate,
  speakMoney,
  speakNumber,
} from "../src/speech/spoken-codes.js";
import {
  SPOKEN_ABBREVIATIONS,
  applySpokenAbbreviations,
  expandSpeakableLiterals,
  speakableSummary,
  toSpeakable,
} from "../src/speech/speakable.js";

// ── speakNumber ──────────────────────────────────────────────────────────────

describe("speakNumber", () => {
  it("writes out the small cases", () => {
    expect(speakNumber(0)).toBe("zero");
    expect(speakNumber(7)).toBe("seven");
    expect(speakNumber(13)).toBe("thirteen");
    expect(speakNumber(20)).toBe("twenty");
    expect(speakNumber(21)).toBe("twenty one");
    expect(speakNumber(99)).toBe("ninety nine");
  });

  it("omits the British 'and' inside a hundreds figure", () => {
    // "one hundred and five" collides with the "and" that separates dollars
    // from cents, which would make $105.00 and $100.05 sound identical.
    expect(speakNumber(100)).toBe("one hundred");
    expect(speakNumber(105)).toBe("one hundred five");
    expect(speakNumber(999)).toBe("nine hundred ninety nine");
  });

  it("handles thousands and millions up to the stated range", () => {
    expect(speakNumber(1000)).toBe("one thousand");
    expect(speakNumber(1234)).toBe("one thousand two hundred thirty four");
    expect(speakNumber(1_000_000)).toBe("one million");
    expect(speakNumber(999_999_999)).toBe(
      "nine hundred ninety nine million nine hundred ninety nine thousand nine hundred ninety nine",
    );
  });

  it("says minus rather than dropping the sign", () => {
    // A dropped sign on a takeback turns a recoupment into a payment.
    expect(speakNumber(-42)).toBe("minus forty two");
  });
});

// ── speakMoney ───────────────────────────────────────────────────────────────

describe("speakMoney", () => {
  it("reads the same amount from a string or a number", () => {
    const expected = "one thousand two hundred thirty four dollars and fifty six cents";
    expect(speakMoney("$1,234.56")).toBe(expected);
    expect(speakMoney(1234.56)).toBe(expected);
  });

  it("drops 'and zero cents' on a whole-dollar amount", () => {
    // Three extra words on every line is the difference between a remittance
    // summary someone listens to and one they stop listening to.
    expect(speakMoney(100)).toBe("one hundred dollars");
    expect(speakMoney("$73.00")).toBe("seventy three dollars");
  });

  it("gets the singulars right", () => {
    expect(speakMoney(1)).toBe("one dollar");
    expect(speakMoney(0.01)).toBe("one cent");
    expect(speakMoney(1.01)).toBe("one dollar and one cent");
  });

  it("says zero dollars rather than nothing at all", () => {
    expect(speakMoney(0)).toBe("zero dollars");
    expect(speakMoney("$0.00")).toBe("zero dollars");
  });

  it("reads a sub-dollar amount as cents alone", () => {
    expect(speakMoney(0.56)).toBe("fifty six cents");
    expect(speakMoney("$0.99")).toBe("ninety nine cents");
  });

  it("announces a negative amount as minus", () => {
    // Negative amounts on an 835 are takebacks; silence about the sign is how
    // a recoupment gets read out as a payment.
    expect(speakMoney(-50)).toBe("minus fifty dollars");
    expect(speakMoney("-$1.25")).toBe("minus one dollar and twenty five cents");
  });

  it("hands back anything that is not an amount", () => {
    expect(speakMoney("not money")).toBe("not money");
  });
});

// ── speakDate ────────────────────────────────────────────────────────────────

describe("speakDate", () => {
  it("reads both the stored form and the portal form the same way", () => {
    expect(speakDate("2026-03-14")).toBe("March fourteenth, twenty twenty six");
    expect(speakDate("03/14/2026")).toBe("March fourteenth, twenty twenty six");
    expect(speakDate("3/14/2026")).toBe("March fourteenth, twenty twenty six");
  });

  it("gets the irregular ordinals right", () => {
    // The naive st/nd/rd/th suffix rule is wrong for 11, 12 and 13, and the
    // word forms are irregular besides ("twelfth", "twentieth").
    expect(speakDate("2026-01-01")).toMatch(/^January first,/);
    expect(speakDate("2026-01-02")).toMatch(/^January second,/);
    expect(speakDate("2026-01-03")).toMatch(/^January third,/);
    expect(speakDate("2026-01-11")).toMatch(/^January eleventh,/);
    expect(speakDate("2026-01-12")).toMatch(/^January twelfth,/);
    expect(speakDate("2026-01-13")).toMatch(/^January thirteenth,/);
    expect(speakDate("2026-01-20")).toMatch(/^January twentieth,/);
    expect(speakDate("2026-01-21")).toMatch(/^January twenty first,/);
    expect(speakDate("2026-01-22")).toMatch(/^January twenty second,/);
    expect(speakDate("2026-01-23")).toMatch(/^January twenty third,/);
    expect(speakDate("2026-01-30")).toMatch(/^January thirtieth,/);
    expect(speakDate("2026-01-31")).toMatch(/^January thirty first,/);
  });

  it("says the 2000s as 'two thousand N' and everything else in pairs", () => {
    expect(speakDate("2006-05-04")).toBe("May fourth, two thousand six");
    expect(speakDate("2000-05-04")).toBe("May fourth, two thousand");
    expect(speakDate("2009-05-04")).toBe("May fourth, two thousand nine");
    expect(speakDate("2010-05-04")).toBe("May fourth, twenty ten");
    expect(speakDate("1999-05-04")).toBe("May fourth, nineteen ninety nine");
    expect(speakDate("1905-05-04")).toBe("May fourth, nineteen oh five");
    expect(speakDate("1900-05-04")).toBe("May fourth, nineteen hundred");
  });

  it("returns anything it cannot parse untouched", () => {
    // The two written forms disagree about which number is the month, so a
    // guessed date of service is an unappealable timely-filing denial.
    expect(speakDate("last Tuesday")).toBe("last Tuesday");
    expect(speakDate("2026-13-40")).toBe("2026-13-40");
    expect(speakDate("")).toBe("");
  });
});

// ── speakCode ────────────────────────────────────────────────────────────────

describe("speakCode", () => {
  it("spells a CPT code digit by digit", () => {
    // The whole reason this module exists: unaided TTS says "ninety-nine
    // thousand two hundred thirteen", which is not a code anyone recognises.
    expect(speakCode("99213")).toBe("nine nine two one three");
  });

  it("keeps the letter in a HCPCS code and a category III code", () => {
    expect(speakCode("J1885")).toBe("J one eight eight five");
    expect(speakCode("0469T")).toBe("zero four six nine T");
  });

  it("says the decimal point in an ICD-10 code", () => {
    // Without "point", E11.65 and E116.5 are the same utterance.
    expect(speakCode("E11.65")).toBe("E one one point six five");
  });

  it("announces a bare modifier as a modifier", () => {
    expect(speakCode("-59")).toBe("modifier five nine");
    expect(speakCode("-XU")).toBe("modifier X U");
  });

  it("announces a modifier appended to a code", () => {
    // Otherwise the listener hears seven digits and reads them as one code.
    expect(speakCode("99213-25")).toBe("nine nine two one three modifier two five");
  });

  it("accepts lower case from a transcript", () => {
    expect(speakCode("j1885")).toBe("J one eight eight five");
    expect(speakCode("e11.65")).toBe("E one one point six five");
    expect(speakCode(" 0469t ")).toBe("zero four six nine T");
  });

  it("returns nothing for nothing", () => {
    expect(speakCode("")).toBe("");
    expect(speakCode("   ")).toBe("");
  });
});

// ── parseSpokenCode ──────────────────────────────────────────────────────────

describe("parseSpokenCode", () => {
  it("reads a CPT code spoken digit by digit", () => {
    expect(parseSpokenCode("nine nine two one three")).toBe("99213");
  });

  it("reads the grouped shorthand coders actually use", () => {
    // "ninety nine" must become 99, not 90 followed by 9 — concatenating the
    // two would produce a six-digit "909213".
    expect(parseSpokenCode("ninety nine two thirteen")).toBe("99213");
    expect(parseSpokenCode("ninety nine two fourteen")).toBe("99214");
  });

  it("ignores a leading code-set label, hyphenated or not", () => {
    expect(parseSpokenCode("CPT ninety-nine two one three")).toBe("99213");
    expect(parseSpokenCode("procedure code nine nine two one three")).toBe("99213");
    expect(parseSpokenCode("HCPCS J one eight eight five")).toBe("J1885");
  });

  it("reads an ICD-10 code including its point", () => {
    expect(parseSpokenCode("E eleven point six five")).toBe("E11.65");
    expect(parseSpokenCode("ICD 10 E eleven point six five")).toBe("E11.65");
    expect(parseSpokenCode("icd ten E eleven point six five")).toBe("E11.65");
  });

  it("reads a modifier and writes it with the leading dash", () => {
    expect(parseSpokenCode("modifier twenty five")).toBe("-25");
    expect(parseSpokenCode("modifier five nine")).toBe("-59");
    expect(parseSpokenCode("mod X U")).toBe("-XU");
  });

  it("reads a category III code and a spoken 'oh' for zero", () => {
    expect(parseSpokenCode("zero four six nine T")).toBe("0469T");
    expect(parseSpokenCode("oh four six nine T")).toBe("0469T");
  });

  it("returns null for ordinary prose", () => {
    // A wrong code silently substituted is far worse than a null that makes
    // the assistant ask again.
    expect(parseSpokenCode("the claim was denied for medical necessity")).toBeNull();
    expect(parseSpokenCode("please send the records by Friday")).toBeNull();
  });

  it("returns null for the empty and whitespace cases", () => {
    expect(parseSpokenCode("")).toBeNull();
    expect(parseSpokenCode("   ")).toBeNull();
  });

  it("returns null for digits that do not land on a code shape", () => {
    expect(parseSpokenCode("five units")).toBeNull();
    expect(parseSpokenCode("twenty five")).toBeNull(); // a modifier needs its label
    expect(parseSpokenCode("one two three")).toBeNull();
    expect(parseSpokenCode("nine nine two one three four five")).toBeNull();
  });

  it("aborts on an unrecognised word rather than skipping it", () => {
    // Skipping "and" here would join two separate codes into one invented code.
    expect(parseSpokenCode("nine nine two and one three")).toBeNull();
    expect(parseSpokenCode("ninety nine code two thirteen")).toBeNull();
  });
});

// ── normalizeSpokenCodes ─────────────────────────────────────────────────────

describe("normalizeSpokenCodes", () => {
  it("rewrites the codes and leaves the sentence around them alone", () => {
    expect(normalizeSpokenCodes("Bill CPT ninety-nine two one three with modifier twenty five.")).toBe(
      "Bill CPT 99213 with modifier 25.",
    );
    expect(normalizeSpokenCodes("The diagnosis is E eleven point six five.")).toBe(
      "The diagnosis is E11.65.",
    );
  });

  it("keeps the label word instead of swallowing it", () => {
    // "CPT" tells the reader which code set is meant; dropping it to make room
    // for the digits loses the only disambiguating word in the sentence.
    expect(normalizeSpokenCodes("Use CPT nine nine two one three")).toBe("Use CPT 99213");
  });

  it("leaves ordinary numbers in prose alone", () => {
    const prose = "We shipped five units and nine boxes.";
    expect(normalizeSpokenCodes(prose)).toBe(prose);
  });

  it("does not build a code out of an English article", () => {
    // "a nine nine two one" parses to A9921, a plausible-looking HCPCS code
    // assembled from an article and part of a CPT code. Requiring a capital
    // letter is what stops it.
    expect(normalizeSpokenCodes("a nine nine two one three claim")).toBe("a 99213 claim");
  });

  it("leaves codes that are already written correctly untouched", () => {
    expect(normalizeSpokenCodes("Report 99213 with modifier 25 and E11.65.")).toBe(
      "Report 99213 with modifier 25 and E11.65.",
    );
  });

  it("handles the empty string", () => {
    expect(normalizeSpokenCodes("")).toBe("");
  });

  it("rewrites more than one code in the same sentence", () => {
    expect(
      normalizeSpokenCodes("Bill nine nine two one three then J one eight eight five today."),
    ).toBe("Bill 99213 then J1885 today.");
  });
});

// ── SPOKEN_ABBREVIATIONS ─────────────────────────────────────────────────────

describe("SPOKEN_ABBREVIATIONS", () => {
  const REQUIRED = [
    "NCCI", "MUE", "PTP", "CARC", "RARC", "NPI", "TIN", "MBI", "EOB", "ERA",
    "RVU", "wRVU", "MPFS", "GPCI", "HCPCS", "CPT", "ICD", "LCD", "NCD", "MAC",
    "RAC", "ABN", "COB", "MSP", "PHI", "DME", "POS", "EM", "E&M", "E/M",
    "835", "837P", "277CA", "276", "999", "TAT", "AR", "A/R", "DSO", "NSA",
    "IDR", "PA", "DTR", "CRD", "PAS", "FHIR", "X12",
  ];

  it("covers every term the voice channel is expected to say", () => {
    for (const key of REQUIRED) expect(SPOKEN_ABBREVIATIONS[key], key).toBeTruthy();
  });

  it("spells initialisms letter by letter", () => {
    expect(SPOKEN_ABBREVIATIONS.NCCI).toBe("N C C I");
    expect(SPOKEN_ABBREVIATIONS.CARC).toBe("C A R C");
    expect(SPOKEN_ABBREVIATIONS.NPI).toBe("N P I");
  });

  it("reads transaction numbers in pair-groups, not as cardinals", () => {
    // An 835 is "an eight thirty five" to everyone who works with one; "eight
    // hundred thirty five" is the tell that a machine wrote the summary.
    expect(SPOKEN_ABBREVIATIONS["835"]).toBe("eight thirty five");
    expect(SPOKEN_ABBREVIATIONS["837P"]).toBe("eight thirty seven P");
    expect(SPOKEN_ABBREVIATIONS["277CA"]).toBe("two seventy seven C A");
    expect(SPOKEN_ABBREVIATIONS["276"]).toBe("two seventy six");
  });

  it("expands the abbreviations that are ambiguous as letters", () => {
    expect(SPOKEN_ABBREVIATIONS["A/R"]).toBe("accounts receivable");
    expect(SPOKEN_ABBREVIATIONS.AR).toBe("accounts receivable");
    expect(SPOKEN_ABBREVIATIONS["E/M"]).toBe("evaluation and management");
    expect(SPOKEN_ABBREVIATIONS["E&M"]).toBe("evaluation and management");
    expect(SPOKEN_ABBREVIATIONS.EM).toBe("evaluation and management");
  });
});

describe("applySpokenAbbreviations", () => {
  it("replaces jargon that stands alone", () => {
    expect(applySpokenAbbreviations("Check the NPI and the TIN.")).toBe(
      "Check the N P I and the T I N.",
    );
  });

  it("does not corrupt a longer word that merely contains an acronym", () => {
    // MACRA begins with MAC; CARCASS contains CARC. Both were mangled before
    // the word boundaries were added.
    expect(applySpokenAbbreviations("MACRA changed the rules")).toBe("MACRA changed the rules");
    expect(applySpokenAbbreviations("PASTE the CPTS list")).toBe("PASTE the CPTS list");
  });

  it("is case sensitive, because half the keys are ordinary English words", () => {
    // "a new era", "the tin of", "on the cob" — matching case-insensitively
    // turned each of these into an acronym.
    expect(applySpokenAbbreviations("a new era of tin and pa")).toBe("a new era of tin and pa");
  });

  it("prefers the longer key when two overlap", () => {
    expect(applySpokenAbbreviations("the 837P and the 835")).toBe(
      "the eight thirty seven P and the eight thirty five",
    );
    expect(applySpokenAbbreviations("a 277CA came back")).toBe("a two seventy seven C A came back");
  });

  it("leaves a transaction number alone when it is part of a bigger number", () => {
    expect(applySpokenAbbreviations("line 1835 of the file")).toBe("line 1835 of the file");
    expect(applySpokenAbbreviations("we billed $835.00")).toBe("we billed $835.00");
  });
});

describe("expandSpeakableLiterals", () => {
  it("renders codes, money and dates but leaves plain counts alone", () => {
    expect(expandSpeakableLiterals("Billed 5 units of J1885 on 2026-03-14 for $120.00.")).toBe(
      "Billed 5 units of J one eight eight five on March fourteenth, twenty twenty six for one hundred twenty dollars.",
    );
  });

  it("does not turn a quantity into a code", () => {
    // "5 units" is five units. A renderer that spelled every integer would
    // read unit counts and page numbers digit by digit.
    expect(expandSpeakableLiterals("5 units")).toBe("5 units");
    expect(expandSpeakableLiterals("12 claims in 4 batches")).toBe("12 claims in 4 batches");
  });

  it("says 'modifier' once when the word is already there", () => {
    expect(expandSpeakableLiterals("append modifier 25")).toBe("append modifier two five");
  });
});

// ── toSpeakable ──────────────────────────────────────────────────────────────

describe("toSpeakable — code blocks", () => {
  it("drops a fenced block and says how big it was", () => {
    // Reading an 837P segment aloud is two minutes of "N M one star eight
    // five star two" and conveys nothing.
    const md = ["Here is the claim.", "", "```", ...Array.from({ length: 12 }, (_, i) => `line ${i}`), "```", "", "Done."].join("\n");
    const out = toSpeakable(md);
    expect(out.omitted).toEqual(["a 12-line code block"]);
    expect(out.text).toBe("Here is the claim. Done.");
  });

  it("treats an unclosed fence as running to the end of the reply", () => {
    // A truncated model reply routinely leaves the closing fence off; without
    // this the raw X12 gets read out.
    const md = "Intro.\n\n```\nNM1*85*2\nCLM*A*100\n";
    const out = toSpeakable(md);
    expect(out.omitted).toEqual(["a 2-line code block"]);
    expect(out.text).toBe("Intro.");
  });

  it("lets a longer fence contain a shorter one", () => {
    // An agent explaining how to write a fenced block nests them; closing the
    // outer block at the inner fence would read the rest of it aloud.
    const md = ["Example.", "````", "```", "inner", "```", "````", "End."].join("\n");
    const out = toSpeakable(md);
    expect(out.omitted).toEqual(["a 3-line code block"]);
    expect(out.text).toBe("Example. End.");
  });

  it("counts each block separately", () => {
    const md = "```\na\n```\ntext\n```\nb\nc\n```";
    const out = toSpeakable(md);
    expect(out.omitted).toEqual(["a 1-line code block", "a 2-line code block"]);
  });
});

describe("toSpeakable — tables", () => {
  it("summarises a table instead of reading it cell by cell", () => {
    // By row three the listener has lost the header and cannot tell whether
    // the number they just heard was a charge or an allowed amount.
    const md = [
      "| code | charge | allowed |",
      "| --- | --- | --- |",
      "| 99213 | $120.00 | $73.97 |",
      "| 99214 | $180.00 | $105.00 |",
      "| 99215 | $240.00 | $148.00 |",
      "| 99212 | $90.00 | $56.00 |",
      "| 99211 | $50.00 | $24.00 |",
    ].join("\n");
    const out = toSpeakable(md);
    expect(out.text).toBe("a table of 5 rows, columns: code, charge, allowed.");
    expect(out.text).not.toMatch(/99213/);
  });

  it("counts an escaped pipe as part of its cell, not as a column break", () => {
    // Splitting on it inflates the column count, and the column count is the
    // whole of what the listener is being told.
    const md = ["| carc | note |", "| --- | --- |", "| 45 | charge \\| exceeds fee schedule |"].join("\n");
    const out = toSpeakable(md);
    expect(out.text).toBe("a table of 1 rows, columns: carc, note.");
  });

  it("handles a table with no separator row", () => {
    const md = ["| a | b |", "| 1 | 2 |"].join("\n");
    expect(toSpeakable(md).text).toBe("a table of 1 rows, columns: a, b.");
  });
});

describe("toSpeakable — markdown syntax", () => {
  it("strips headings, emphasis and bullets and makes each a sentence", () => {
    const md = ["## Summary", "", "- **NCCI** edit on line 2", "- Add _documentation_", ""].join("\n");
    expect(toSpeakable(md).text).toBe("Summary. N C C I edit on line 2. Add documentation.");
  });

  it("keeps the link text and drops the URL", () => {
    // A spoken URL is a minute of "h t t p s colon slash slash" nobody can use.
    const md = "See [the LCD](https://example.com/lcd/L12345) for details.";
    expect(toSpeakable(md).text).toBe("See the L C D for details.");
  });

  it("drops a bare URL and a horizontal rule", () => {
    const md = "Read https://cms.gov/x now.\n\n---\n\nEnd.";
    expect(toSpeakable(md).text).toBe("Read now. End.");
  });

  it("unwraps inline code and blockquotes", () => {
    expect(toSpeakable("> Use `99213` here").text).toBe("Use nine nine two one three here.");
  });

  it("gives every sentence terminal punctuation for prosody", () => {
    // Without it a TTS engine runs two list items together into one clause.
    const out = toSpeakable("- first item\n- second item").text;
    expect(out).toBe("first item. second item.");
    expect(out.endsWith(".")).toBe(true);
  });

  it("returns an empty result for empty input", () => {
    expect(toSpeakable("")).toEqual({ text: "", truncated: false, omitted: [] });
    expect(toSpeakable("   \n\n  ")).toEqual({ text: "", truncated: false, omitted: [] });
  });
});

describe("toSpeakable — code expansion", () => {
  it("renders codes, money and dates by default", () => {
    const out = toSpeakable("Paid 99213 on 2026-03-14 for $1,234.56.").text;
    expect(out).toBe(
      "Paid nine nine two one three on March fourteenth, twenty twenty six for one thousand two hundred thirty four dollars and fifty six cents.",
    );
  });

  it("leaves the literals written when expandCodes is off", () => {
    const out = toSpeakable("Paid 99213 for $1,234.56.", { expandCodes: false }).text;
    expect(out).toBe("Paid 99213 for $1,234.56.");
  });

  it("still leaves a plain quantity as a number", () => {
    expect(toSpeakable("Billed 5 units.").text).toBe("Billed 5 units.");
  });

  it("applies the abbreviations before the codes", () => {
    expect(toSpeakable("The 835 posted CPT 99213.").text).toBe(
      "The eight thirty five posted C P T nine nine two one three.",
    );
  });
});

describe("toSpeakable — length", () => {
  const md = "Alpha one. Beta two. Gamma three. Delta four. Epsilon five.";

  it("does not truncate when the text lands exactly on the limit", () => {
    const full = toSpeakable(md).text;
    const exact = toSpeakable(md, { maxChars: full.length });
    expect(exact.truncated).toBe(false);
    expect(exact.text).toBe(full);
  });

  it("truncates one character under the limit, at a sentence boundary", () => {
    const full = toSpeakable(md).text;
    const cut = toSpeakable(md, { maxChars: full.length - 1 });
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe("Alpha one. Beta two. Gamma three. Delta four.");
  });

  it("cuts at a sentence end, never mid-sentence", () => {
    // A half-read "this claim will not" is heard as the opposite of what it
    // said, and speech has no visible ellipsis to warn the listener.
    const cut = toSpeakable(md, { maxChars: 25 });
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe("Alpha one. Beta two.");
  });

  it("falls back to a word boundary when there is no sentence end in range", () => {
    const cut = toSpeakable("Averylongfirstword and then some more words here", { maxChars: 22 });
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe("Averylongfirstword and");
    expect(cut.text).not.toMatch(/the$/);
  });

  it("still reports the omitted blocks when it truncates", () => {
    const out = toSpeakable("```\nx\n```\nOne. Two. Three.", { maxChars: 10 });
    expect(out.omitted).toEqual(["a 1-line code block"]);
    expect(out.truncated).toBe(true);
  });
});

// ── speakableSummary ─────────────────────────────────────────────────────────

describe("speakableSummary", () => {
  const long = [
    "## Findings",
    "",
    "The claim was denied under CARC 97.",
    "The bundled service is 99213.",
    "A corrected claim is due by 2026-03-14.",
    "There are four other lines with the same problem.",
  ].join("\n");

  it("leads with the first sentence or two, already speakable", () => {
    const lead = speakableSummary(long);
    expect(lead.startsWith("Findings.")).toBe(true);
    expect(lead).toMatch(/C A R C/);
    expect(lead).not.toMatch(/##/);
  });

  it("stays inside the limit and ends on punctuation", () => {
    const lead = speakableSummary(long, 60);
    expect(lead.length).toBeLessThanOrEqual(60);
    expect(lead).toMatch(/[.!?]$/);
  });

  it("returns nothing for nothing", () => {
    expect(speakableSummary("")).toBe("");
    expect(speakableSummary("   ")).toBe("");
  });

  it("returns the whole thing when the reply is already short", () => {
    expect(speakableSummary("All clean.")).toBe("All clean.");
  });
});

describe("normalizeSpokenCodes refuses to manufacture an identifier", () => {
  // Found by the voice eval harness, and it is a PHI leak rather than a
  // cosmetic bug. A spoken MRN reaches the transcript as WORDS, so the
  // identifier gate — which matches digit patterns — sees nothing to redact
  // and passes it. Normalization then turned those words into "00918": a
  // patient identifier, past the gate, shaped exactly like a CPT code and
  // indistinguishable from one downstream.
  it("leaves a spoken medical record number as words", () => {
    expect(normalizeSpokenCodes("the medical record number is zero zero nine one eight")).toBe(
      "the medical record number is zero zero nine one eight",
    );
  });

  it("leaves a spoken member id, social and account number alone", () => {
    for (const said of [
      "member id nine nine two one three",
      "the social is one two three four five",
      "account number four four one seven",
    ]) {
      expect(normalizeSpokenCodes(said), said).toBe(said);
    }
  });

  it("does not weld a claim prefix onto dictated digits", () => {
    // "claim C L M four four one seven" produced "claim C L M4417" — neither
    // the claim number nor a real code, just a HCPCS-shaped string.
    expect(normalizeSpokenCodes("claim C L M four four one seven")).toBe("claim C L M four four one seven");
  });

  it("still normalizes a genuinely dictated code", () => {
    // The guard must not cost the feature it protects.
    expect(normalizeSpokenCodes("scrub CPT nine nine two one three")).toBe("scrub CPT 99213");
    expect(normalizeSpokenCodes("check E eleven point six five and modifier twenty five")).toBe(
      "check E11.65 and modifier 25",
    );
    expect(normalizeSpokenCodes("code ninety nine two thirteen please")).toBe("code 99213 please");
  });
});
