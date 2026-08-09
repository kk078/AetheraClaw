// ── Codes, money and dates as a human would say them ─────────────────────────
// A billing assistant that talks has one problem before it has any others: the
// alphabet of this domain is not English. Handed "99213", every text-to-speech
// engine says "ninety-nine thousand two hundred thirteen" — a number no coder
// has ever heard spoken and cannot map back to a code without stopping to
// think. Handed "E11.65" it says "E eleven sixty-five" or "E eleven point six
// five" depending on the engine, and handed "$1,234.56" it may say "one two
// three four dollars".
//
// The inverse is just as bad. A coder says "nine nine two one three" and the
// recognizer returns those five words. Anything downstream looking for a CPT
// code finds none, and the assistant answers a question nobody asked.
//
// So both directions live here, as pure string functions over plain data: the
// renderers that make a code sayable, and the parser that turns an utterance
// back into a code. The parser is deliberately the more timid of the two —
// see parseSpokenCode.

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];

const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Day-of-month ordinals, written out rather than derived from a suffix rule.
 *
 * The naive rule — "st" for 1, "nd" for 2, "rd" for 3, "th" otherwise — gets
 * 11, 12 and 13 wrong ("eleventh", not "eleven-first"), and the word forms are
 * irregular anyway ("twelfth", "twentieth", "thirty first"). A month has 31
 * days; listing them is shorter than the rule that would generate them.
 */
const DAY_ORDINALS = [
  "",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
  "twentieth",
  "twenty first",
  "twenty second",
  "twenty third",
  "twenty fourth",
  "twenty fifth",
  "twenty sixth",
  "twenty seventh",
  "twenty eighth",
  "twenty ninth",
  "thirtieth",
  "thirty first",
];

function underThousand(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const rest = n % 10;
    return rest === 0 ? TENS[Math.floor(n / 10)] : `${TENS[Math.floor(n / 10)]} ${ONES[rest]}`;
  }
  const rest = n % 100;
  const hundreds = `${ONES[Math.floor(n / 100)]} hundred`;
  return rest === 0 ? hundreds : `${hundreds} ${underThousand(rest)}`;
}

/**
 * An integer in words.
 *
 * No "and" before the tens ("one hundred five", not "one hundred and five"):
 * American English omits it, and a spoken "and" in a dollar amount is the word
 * that separates dollars from cents — reusing it inside the dollar figure makes
 * "$105.00" and "$100.05" sound alike, which is exactly the confusion a spoken
 * remittance cannot afford.
 */
export function speakNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const whole = Math.trunc(n);
  if (whole < 0) return `minus ${speakNumber(-whole)}`;
  if (whole === 0) return "zero";

  const parts: string[] = [];
  let rest = whole;
  for (const [size, name] of [
    [1_000_000_000, "billion"],
    [1_000_000, "million"],
    [1_000, "thousand"],
  ] as const) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      parts.push(`${underThousand(count)} ${name}`);
      rest -= count * size;
    }
  }
  if (rest > 0) parts.push(underThousand(rest));
  return parts.join(" ");
}

/** Digits, letters and the decimal point, one symbol at a time. */
function spellOut(segment: string): string {
  const parts: string[] = [];
  for (const ch of segment) {
    if (ch >= "0" && ch <= "9") parts.push(ONES[Number(ch)]);
    else if (ch === ".") parts.push("point");
    else if (/[A-Z]/.test(ch)) parts.push(ch);
    else if (/\s/.test(ch)) continue;
    else parts.push(ch);
  }
  return parts.join(" ");
}

/**
 * Render a CPT, HCPCS, ICD-10 code or modifier for speech.
 *
 * Every code family is spelled symbol by symbol, because none of them is a
 * number. "99213" is five digits that happen to look like ninety-nine thousand;
 * "0469T" is not four hundred sixty-nine of anything. The one piece of
 * structure kept is the decimal point in ICD-10, spoken as "point" — a coder
 * hearing "E one one six five" cannot tell E11.65 from E116.5.
 *
 * A trailing modifier is announced as one ("99213-25" → "... modifier two
 * five") so the listener knows the digits that follow are not more of the code.
 */
export function speakCode(code: string): string {
  const raw = code.trim().toUpperCase();
  if (!raw) return "";

  const segments = raw.split("-");
  const spoken: string[] = [];
  segments.forEach((segment, i) => {
    if (!segment) return; // leading "-59": the empty head just marks a bare modifier
    spoken.push(i === 0 ? spellOut(segment) : `modifier ${spellOut(segment)}`);
  });
  return spoken.join(" ").trim();
}

/**
 * Render a dollar amount for speech.
 *
 * Whole dollars drop the cents entirely: "one hundred dollars and zero cents"
 * is how a machine reads an allowed amount, and three extra words on every line
 * of a remittance is the difference between a summary someone listens to and
 * one they skip. Singulars are respected for the same reason — "one dollars"
 * is the tell that a summary was generated rather than written.
 */
export function speakMoney(amount: number | string): string {
  let numeric: number;
  if (typeof amount === "number") {
    numeric = amount;
  } else {
    // Stripping the currency symbols out of "not money" leaves an empty string,
    // and Number("") is 0 — so a caller that passed prose by mistake would hear
    // a confident "zero dollars" instead of the words they passed in.
    const digits = String(amount).replace(/[^0-9.\-]/g, "");
    if (!/\d/.test(digits)) return String(amount);
    numeric = Number(digits);
  }
  if (!Number.isFinite(numeric)) return String(amount);

  const negative = numeric < 0;
  const totalCents = Math.round(Math.abs(numeric) * 100);
  const dollars = Math.floor(totalCents / 100);
  const cents = totalCents % 100;

  const dollarWords = `${speakNumber(dollars)} ${dollars === 1 ? "dollar" : "dollars"}`;
  const centWords = `${speakNumber(cents)} ${cents === 1 ? "cent" : "cents"}`;

  let body: string;
  if (dollars === 0 && cents === 0) body = "zero dollars";
  else if (dollars === 0) body = centWords; // "fifty six cents", not "zero dollars and ..."
  else if (cents === 0) body = dollarWords;
  else body = `${dollarWords} and ${centWords}`;

  return negative && totalCents > 0 ? `minus ${body}` : body;
}

/**
 * Years the way people say them.
 *
 * The 2000s are the exception that forces this to be a rule rather than a
 * digit-pair split: 2006 is "two thousand six", never "twenty oh six", while
 * 2026 is "twenty twenty six" and never "two thousand twenty six" in speech.
 * 1905 needs the "oh" that a plain pair split would drop, and 1900 is
 * "nineteen hundred".
 */
function speakYear(year: number): string {
  if (year < 1000 || year > 9999) return speakNumber(year);
  if (year >= 2000 && year <= 2009) {
    const unit = year - 2000;
    return unit === 0 ? "two thousand" : `two thousand ${ONES[unit]}`;
  }
  const high = Math.floor(year / 100);
  const low = year % 100;
  if (low === 0) return `${underThousand(high)} hundred`;
  if (low < 10) return `${underThousand(high)} oh ${ONES[low]}`;
  return `${underThousand(high)} ${underThousand(low)}`;
}

/**
 * Render a date for speech from either the ISO form the system stores or the
 * US form a payer portal shows. Anything else is handed back untouched: a date
 * that cannot be parsed is far better read literally than guessed at, because
 * the two forms disagree on which number is the month and a silently swapped
 * date of service is an unappealable timely-filing denial.
 */
export function speakDate(iso: string): string {
  const text = String(iso).trim();
  let year: number;
  let month: number;
  let day: number;

  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const usMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (isoMatch) {
    year = Number(isoMatch[1]);
    month = Number(isoMatch[2]);
    day = Number(isoMatch[3]);
  } else if (usMatch) {
    month = Number(usMatch[1]);
    day = Number(usMatch[2]);
    year = Number(usMatch[3]);
  } else {
    return text;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return text;
  return `${MONTHS[month - 1]} ${DAY_ORDINALS[day]}, ${speakYear(year)}`;
}

// ── The inverse: an utterance back into a code ───────────────────────────────

const DIGIT_WORDS: Record<string, string> = {
  zero: "0",
  oh: "0", // recognizers return "oh" for a spoken zero far more often than "zero"
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

const TEEN_WORDS: Record<string, string> = {
  ten: "10",
  eleven: "11",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19",
};

const TENS_WORDS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const POINT_WORDS = new Set(["point", "dot", "decimal"]);

/** Words a speaker puts in front of a code. They carry no digits of their own. */
const LABEL_WORDS = new Set([
  "cpt",
  "hcpcs",
  "hcpc",
  "icd",
  "code",
  "codes",
  "procedure",
  "diagnosis",
  "dx",
  "modifier",
  "modifiers",
  "mod",
]);

const MODIFIER_LABELS = new Set(["modifier", "modifiers", "mod"]);

/** Every token that can legitimately appear inside a spoken code. */
const NUMBER_TOKENS = new Set<string>([
  ...Object.keys(DIGIT_WORDS),
  ...Object.keys(TEEN_WORDS),
  ...Object.keys(TENS_WORDS),
  ...POINT_WORDS,
]);

// Shapes a parse is allowed to produce. Anything else is not a code, and the
// parser says so rather than inventing one.
const CPT_SHAPE = /^\d{5}$/;
const CPT_CATEGORY_III_SHAPE = /^\d{4}[A-Z]$/;
const HCPCS_SHAPE = /^[A-Z]\d{4}$/;
const ICD10_SHAPE = /^[A-Z]\d{2}(?:\.[0-9A-Z]{1,4})?$/;
const MODIFIER_SHAPE = /^(?:\d{2}|[A-Z]{2})$/;

function splitUtterance(text: string): string[] {
  return text
    .trim()
    .split(/[\s,–—-]+/)
    // Trailing sentence punctuation only: the decimal inside "E11.65" is not at
    // the end of its token, so stripping the tail never eats a code separator.
    .map((t) => t.replace(/[.!?;:]+$/, ""))
    .filter(Boolean);
}

/**
 * Turn a spoken code back into its written form, or return null.
 *
 * Conservative on purpose. A recognizer mishears constantly, and the cost of
 * the two failure modes is nowhere near symmetric: returning null makes the
 * assistant ask again, while guessing turns "ninety nine two thirteen" into a
 * code that gets billed. So an unrecognised token aborts the whole parse rather
 * than being skipped, and the assembled digits must land on a real code shape —
 * five digits, a HCPCS letter and four digits, four digits and a category III
 * letter, or an ICD-10 chapter letter and its subdivisions.
 *
 * Both readings of a five-digit code are accepted, because coders use both:
 * digit by digit ("nine nine two one three") and in the grouped shorthand
 * ("ninety nine two thirteen").
 */
export function parseSpokenCode(text: string): string | null {
  if (!text || !text.trim()) return null;
  const tokens = splitUtterance(text);
  if (tokens.length === 0) return null;

  let i = 0;
  let isModifier = false;

  // Labels only at the front. A label in the middle ("ninety nine code two")
  // means the utterance was not a single code, and guessing which half to keep
  // is the kind of cleverness this function exists to avoid.
  while (i < tokens.length && LABEL_WORDS.has(tokens[i].toLowerCase())) {
    const word = tokens[i].toLowerCase();
    if (MODIFIER_LABELS.has(word)) isModifier = true;
    i += 1;
    // "ICD 10" / "ICD ten" is two tokens of label, not a label and a number.
    if (word === "icd" && i < tokens.length && /^(?:10|ten|9|nine)$/.test(tokens[i].toLowerCase())) {
      i += 1;
    }
  }

  const pieces: string[] = [];
  while (i < tokens.length) {
    const word = tokens[i].toLowerCase();

    if (POINT_WORDS.has(word)) {
      pieces.push(".");
      i += 1;
      continue;
    }
    if (word in DIGIT_WORDS) {
      pieces.push(DIGIT_WORDS[word]);
      i += 1;
      continue;
    }
    if (word in TEEN_WORDS) {
      pieces.push(TEEN_WORDS[word]);
      i += 1;
      continue;
    }
    if (word in TENS_WORDS) {
      // "ninety nine" is 99, not 90 followed by 9 — concatenating would yield
      // "909" and a five-digit code would come out six digits long.
      const next = i + 1 < tokens.length ? tokens[i + 1].toLowerCase() : "";
      const unit = next in DIGIT_WORDS ? Number(DIGIT_WORDS[next]) : 0;
      if (unit >= 1 && unit <= 9) {
        pieces.push(String(TENS_WORDS[word] + unit));
        i += 2;
      } else {
        pieces.push(String(TENS_WORDS[word]));
        i += 1;
      }
      continue;
    }
    if (/^\d+$/.test(tokens[i])) {
      pieces.push(tokens[i]);
      i += 1;
      continue;
    }
    if (/^[A-Za-z]$/.test(tokens[i])) {
      pieces.push(tokens[i].toUpperCase());
      i += 1;
      continue;
    }
    return null; // an unrecognised word: this was prose, not a code
  }

  const candidate = pieces.join("");
  if (!candidate) return null;

  if (isModifier) return MODIFIER_SHAPE.test(candidate) ? `-${candidate}` : null;
  if (candidate.includes(".")) return ICD10_SHAPE.test(candidate) ? candidate : null;
  if (CPT_SHAPE.test(candidate)) return candidate;
  if (HCPCS_SHAPE.test(candidate)) return candidate;
  if (CPT_CATEGORY_III_SHAPE.test(candidate)) return candidate;
  if (ICD10_SHAPE.test(candidate)) return candidate;
  return null;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /[A-Za-z]+|\d+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return out;
}

/**
 * Rewrite the spoken codes inside a sentence, leaving everything else alone.
 *
 * A dictated note is mostly prose with a code or two in it, so this scans for
 * runs of code-shaped tokens and hands each run to parseSpokenCode, longest
 * window first. Two restrictions keep ordinary English out of the results:
 *
 *  - a run needs at least two tokens, so "we sent one claim" is untouched;
 *  - a bare letter only counts as a code letter when it is capitalised in the
 *    source. Without that, "a nine nine two one three" parses the article as an
 *    ICD chapter and yields A9921 — a real-looking HCPCS code assembled out of
 *    an English article and part of a CPT code.
 *
 * A leading label is preserved rather than absorbed, so "CPT ninety nine two
 * one three" becomes "CPT 99213" and the reader keeps the word that says which
 * code set is meant.
 */
export function normalizeSpokenCodes(text: string): string {
  if (!text) return text;

  const tokens = tokenize(text);
  const isLabel = (t: Token) => LABEL_WORDS.has(t.text.toLowerCase());
  const isCodeWord = (t: Token) =>
    NUMBER_TOKENS.has(t.text.toLowerCase()) || /^\d+$/.test(t.text) || /^[A-Z]$/.test(t.text);
  const inRun = (t: Token) => isLabel(t) || isCodeWord(t);

  const out: string[] = [];
  let cursor = 0;
  let i = 0;

  while (i < tokens.length) {
    if (!inRun(tokens[i])) {
      i += 1;
      continue;
    }
    let runEnd = i;
    while (runEnd < tokens.length && inRun(tokens[runEnd])) runEnd += 1;

    let k = i;
    while (k < runEnd) {
      let hit = -1;
      let code: string | null = null;
      for (let j = runEnd; j - k >= 2; j--) {
        const source = text.slice(tokens[k].start, tokens[j - 1].end);
        const parsed = parseSpokenCode(source);
        if (parsed) {
          hit = j;
          code = parsed;
          break;
        }
      }
      if (code === null) {
        k += 1;
        continue;
      }

      let lead = k;
      while (lead < hit && isLabel(tokens[lead])) lead += 1;
      const label = lead > k ? text.slice(tokens[k].start, tokens[lead - 1].end) : "";
      // "modifier -25" reads as two negatives; the label already says modifier.
      const replacement = label ? `${label} ${code.replace(/^-/, "")}` : code;

      out.push(text.slice(cursor, tokens[k].start), replacement);
      cursor = tokens[hit - 1].end;
      k = hit;
    }
    i = runEnd;
  }

  out.push(text.slice(cursor));
  return out.join("");
}
