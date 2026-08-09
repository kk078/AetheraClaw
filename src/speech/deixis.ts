import { redact } from "../channels/email/classify.js";

// ── "Appeal that one" ────────────────────────────────────────────────────────
//
// A person looking at a denial worklist points with words. They say "appeal that
// one", "the second one", "why was it denied" — and every one of those utterances
// is missing the thing that makes it meaningful, because the thing is on the
// screen and not in the audio.
//
// There are three ways to handle that and only one of them is honest:
//
//   Do nothing, and the utterance reaches the model as "appeal that one". The
//   model has no screen. It either asks a vague question or, worse, picks.
//
//   Let the model resolve it from conversation history. This is the dangerous
//   one, because it usually works — and when it does not work it produces a
//   confident action on the WRONG CLAIM. Appealing the wrong denial is not a
//   cosmetic error: it burns one of a finite number of appeal levels on a claim
//   that did not need it, on a deadline clock that does not restart.
//
//   Resolve it HERE, from what the console actually knows is on screen and
//   selected, deterministically — and when the screen does not determine it,
//   refuse and say so.
//
// This is snap.ts's discipline applied to reference instead of to codes: an
// under-determined reference is a QUESTION, never a guess. In particular there is
// no "default to the first row" anywhere below. The first row is not what the
// speaker meant; it is what was convenient.
//
// Everything here is pure and takes the screen as a parameter, so the rules can
// be tested against three synthetic rows rather than against a live browser.

/**
 * One row the user can see, already flattened by the caller.
 *
 * `index` is the caller's own numbering — the line number inside a ToolView, a
 * paging offset — and it is deliberately NOT what ordinals resolve against. "The
 * second one" means the second thing the speaker can see, and after a filter or a
 * sort the caller's index and the screen order disagree. Screen order wins,
 * because screen order is the only one the speaker has access to. `index` is
 * carried through untouched so the caller can map a resolved row back into
 * whatever it came from.
 */
export interface ScreenRow {
  id: string;
  label: string;
  index: number;
  kind?: string;
}

export interface ScreenContext {
  view?: string;
  title?: string;
  /** In the order they appear on screen, top first. */
  rows: ScreenRow[];
  selectedId?: string;
}

export type DeixisResolution =
  | { status: "none" }
  | { status: "resolved"; row: ScreenRow; phrase: string; text: string }
  | { status: "ambiguous"; phrase: string; why: string; candidates: ScreenRow[] }
  | { status: "no-context"; phrase: string; why: string };

/**
 * How many candidate rows an ambiguous result carries.
 *
 * The result of this is read back to a person, usually out loud. Past half a
 * dozen it stops being a question anybody can answer and becomes a list they
 * ignore, so the rest are counted rather than named — and the count is stated, so
 * "5 candidates" is never mistaken for "5 rows on screen".
 */
const MAX_CANDIDATES = 5;

/** Default cap for describeScreen. See the doc comment there for why it exists. */
const DEFAULT_MAX_PREAMBLE_ROWS = 10;

// ── What counts as pointing ──────────────────────────────────────────────────

/**
 * The nouns a demonstrative may attach to.
 *
 * A closed list, because the alternative — treating any "that X" as a reference —
 * makes "that payer requires that modifier" into two row references. Everything
 * here is a thing a worklist row IS; nothing here is a thing a row HAS.
 */
const ROW_NOUNS = [
  "one",
  "row",
  "line",
  "item",
  "claim",
  "denial",
  "rejection",
  "appeal",
  "account",
  "encounter",
  "charge",
  "payment",
  "remit",
  "remittance",
  "note",
  "visit",
  "bill",
  "invoice",
];

const ROW_NOUN_SET = new Set(ROW_NOUNS);

/**
 * "that claim", "this one" — a demonstrative plus a row noun.
 *
 * The noun is REQUIRED. A bare "that" is overwhelmingly a complementizer in this
 * domain ("I think that the payer bundled it", "make sure that it goes out
 * today"), and rewriting one of those turns a fine sentence into nonsense
 * addressed to the wrong row.
 */
const DEMONSTRATIVE = new RegExp(`\\b(?:this|that)\\s+(?:${ROW_NOUNS.join("|")})\\b`, "gi");

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

/** Sentinel for "the last one" — resolved against the row count, not a position. */
const LAST = -1;

/**
 * "the second one", "the third", "the last one", "the 4th claim".
 *
 * "the" is required. Without it, "give me a second" and "wait a second" are
 * positional references, and the unit of time is far commoner in speech than the
 * ordinal. The trailing word is captured so it can be VETTED below: "the last
 * time we appealed" and "the second opinion" are not references to rows, and the
 * only thing distinguishing them from "the last one" is what follows.
 */
const ORDINAL = new RegExp(
  `\\bthe\\s+(${Object.keys(ORDINAL_WORDS).join("|")}|last|final|\\d{1,2}(?:st|nd|rd|th))\\b(?:\\s+([a-z]+))?`,
  "gi",
);

/**
 * Verbs after which "it" is a row.
 *
 * "it" is the whole reason this module needs a conservative rule rather than a
 * generous one. A false positive here does not fail to help — it REWRITES an
 * utterance that was already complete and correct. "What is it?" becomes "What is
 * claim 10024 (Aetna CO-97)?", "is it billable" becomes a question about a row
 * instead of about the code just discussed, and the speaker never sees the
 * substitution because it happens before the model is called.
 *
 * So: a closed list of RCM actions, matched immediately before "it", plus the
 * passive form below. Both fail safe — a verb that is not on the list produces no
 * rewrite, and no rewrite means the utterance goes through exactly as spoken,
 * which is what today already does. Being wrong in the other direction is not
 * recoverable by anything downstream.
 *
 * "is", "was" and "are" as copulas are absent on purpose, and that single
 * omission is what keeps "what is it" and "is it billable" out.
 */
const ACTION_VERBS = [
  "appeal",
  "resubmit",
  "rebill",
  "refile",
  "submit",
  "deny",
  "escalate",
  "void",
  "adjust",
  "correct",
  "fix",
  "work\\s+on",
  "work",
  "open",
  "show",
  "close",
  "check",
  "post",
  "bill",
  "send",
  "read",
  "hold",
  "release",
  "print",
  "pull",
  "drop",
  "write\\s+off",
  "follow\\s+up\\s+on",
  "look\\s+at",
];

const ACTION_PRONOUN = new RegExp(`\\b(${ACTION_VERBS.join("|")})(\\s+)it\\b`, "gi");

/**
 * "why was it denied", "has it been paid" — "it" as the subject of something that
 * happens to a claim.
 *
 * The participle list is as closed as the verb list, and for the same reason:
 * "is it billable" and "is it urgent" share this shape exactly, and only the word
 * after "it" separates a question about a row from a question about anything
 * else.
 */
const PASSIVE_PRONOUN = new RegExp(
  `\\b(was|were|is|has|had|did|does)(\\s+)it\\b\\s+(?:been\\s+)?(?:get\\s+)?` +
    `(denied|paid|billed|appealed|submitted|rejected|adjusted|posted|worked|sent|processed|closed|reopened|voided)\\b`,
  "gi",
);

type PhraseKind = "demonstrative" | "ordinal" | "pronoun";

interface DeicticMatch {
  kind: PhraseKind;
  /** Exactly as it appears in the utterance, original casing. */
  phrase: string;
  start: number;
  end: number;
  /** 1-based position, or LAST. Only on ordinals. */
  ordinal?: number;
}

function collect(text: string, pattern: RegExp, build: (m: RegExpExecArray) => DeicticMatch | null): DeicticMatch[] {
  const out: DeicticMatch[] = [];
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    // A zero-length match would spin here forever. No pattern above can produce
    // one, and this costs nothing to guarantee.
    if (m[0].length === 0) pattern.lastIndex++;
    const built = build(m);
    if (built) out.push(built);
  }
  return out;
}

function ordinalValue(word: string): number | null {
  const w = word.toLowerCase();
  if (w === "last" || w === "final") return LAST;
  if (w in ORDINAL_WORDS) return ORDINAL_WORDS[w];
  const digits = /^(\d{1,2})(?:st|nd|rd|th)$/.exec(w);
  if (digits) {
    const n = Number(digits[1]);
    return n >= 1 ? n : null;
  }
  return null;
}

function deicticMatches(text: string): DeicticMatch[] {
  const found: DeicticMatch[] = [
    ...collect(text, DEMONSTRATIVE, (m) => ({
      kind: "demonstrative",
      phrase: m[0],
      start: m.index,
      end: m.index + m[0].length,
    })),
    ...collect(text, ORDINAL, (m) => {
      const value = ordinalValue(m[1]);
      if (value === null) return null;
      const trailing = m[2]?.toLowerCase();
      // "the last time", "the second opinion", "the third party": an ordinal
      // followed by a word that is not a row noun is not pointing at a row, and
      // rewriting one of those produces a sentence nobody said. Only a row noun
      // ("the second claim") or nothing at all — end of utterance, a comma, a
      // full stop — counts as a reference.
      if (trailing !== undefined && !ROW_NOUN_SET.has(trailing)) return null;
      return { kind: "ordinal", phrase: m[0], start: m.index, end: m.index + m[0].length, ordinal: value };
    }),
    ...collect(text, ACTION_PRONOUN, (m) => {
      // Only "it" itself is the reference — the verb stays. Computed from the
      // group lengths rather than by searching for "it", because "submit it"
      // contains "it" inside the verb.
      const start = m.index + m[1].length + m[2].length;
      return { kind: "pronoun", phrase: text.slice(start, start + 2), start, end: start + 2 };
    }),
    ...collect(text, PASSIVE_PRONOUN, (m) => {
      const start = m.index + m[1].length + m[2].length;
      return { kind: "pronoun", phrase: text.slice(start, start + 2), start, end: start + 2 };
    }),
  ];

  found.sort((a, b) => a.start - b.start || b.end - a.end);

  // Overlaps happen where two patterns see the same words ("the last one" is an
  // ordinal, and a caller could extend the noun list until a demonstrative also
  // fires). The leftmost, longest match wins so the spans stay disjoint and a
  // replacement can never corrupt the utterance around it.
  const disjoint: DeicticMatch[] = [];
  for (const match of found) {
    const previous = disjoint[disjoint.length - 1];
    if (previous && match.start < previous.end) continue;
    disjoint.push(match);
  }
  return disjoint;
}

/**
 * The deictic phrases present in an utterance, in the order they were said.
 *
 * Exported mostly so the rule can be tested and inspected on its own: what this
 * module treats as pointing is the part most likely to be wrong, and it should be
 * possible to ask it without also handing it a screen.
 */
export function findDeixis(text: string): string[] {
  return deicticMatches(String(text ?? "")).map((m) => m.phrase);
}

// ── Rendering rows safely ────────────────────────────────────────────────────

/**
 * A row label comes off a rendered screen, and a rendered worklist row routinely
 * carries a member ID or a date of birth next to the claim number.
 *
 * Every row this module hands back, and every label it writes into an utterance
 * or a preamble, goes through the SAME redaction the mail channel uses — reused,
 * not reimplemented, so there is exactly one set of identifier patterns in this
 * codebase to keep current. The raw label stays where it already was: on the
 * user's own screen, where they are entitled to see it.
 */
function safeRow(row: ScreenRow): ScreenRow {
  const label = redact(String(row.label ?? ""));
  return row.kind === undefined
    ? { id: row.id, label, index: row.index }
    : { id: row.id, label, index: row.index, kind: row.kind };
}

/**
 * Replace row labels with redacted ones.
 *
 * Ids are left alone deliberately. An id is an opaque handle the console minted
 * for its own lookups, not rendered patient text, and redacting it would break
 * the one thing the preamble exists to enable — naming a row precisely enough to
 * act on it.
 */
export function redactScreenLabels(context: ScreenContext): ScreenContext {
  const out: ScreenContext = { rows: (context.rows ?? []).map(safeRow) };
  if (context.view !== undefined) out.view = context.view;
  // The title is rendered text from the same screen ("Denials — Maria Alvarez"),
  // so it gets the same treatment as a label rather than being trusted because it
  // sits in a different field.
  if (context.title !== undefined) out.title = redact(context.title);
  if (context.selectedId !== undefined) out.selectedId = context.selectedId;
  return out;
}

/**
 * How a resolved row is named inside the rewritten utterance.
 *
 * Label AND id, because either alone fails: a label is what the speaker
 * recognises but two rows can share one, and an id is unique but means nothing
 * read aloud. The label is redacted here because by this point the transcript
 * gate has already run — text injected after it would never be seen by it.
 */
function reference(row: ScreenRow): string {
  const label = redact(String(row.label ?? "")).trim();
  if (!label) return row.id;
  if (label.includes(row.id)) return label;
  return `${label} (${row.id})`;
}

function replaceSpan(text: string, match: DeicticMatch, with_: string): string {
  return `${text.slice(0, match.start)}${with_}${text.slice(match.end)}`;
}

function quote(phrase: string): string {
  return `"${phrase}"`;
}

function candidatesFor(rows: ScreenRow[]): ScreenRow[] {
  return rows.slice(0, MAX_CANDIDATES).map(safeRow);
}

function elision(rows: ScreenRow[]): string {
  const hidden = rows.length - Math.min(rows.length, MAX_CANDIDATES);
  return hidden > 0 ? ` ${Math.min(rows.length, MAX_CANDIDATES)} are listed and ${hidden} more were left out.` : "";
}

/**
 * Resolve a pointing word against what is on screen — or refuse.
 *
 * Only the LEFTMOST deictic phrase is resolved, and that is enough: once "appeal
 * that one" has become "appeal claim 10024 (Aetna CO-97)", a later "it" in the
 * same sentence has a perfectly good antecedent in the sentence itself. Resolving
 * every phrase independently would instead let one utterance quietly address two
 * different rows.
 */
export function resolveDeixis(text: string, context: ScreenContext): DeixisResolution {
  const said = String(text ?? "");
  const matches = deicticMatches(said);

  // Rule 1. Nothing was pointed at, so there is nothing to do — and the caller
  // gets no `text` field at all, which is the point: there is no rewritten
  // string to accidentally use in place of the original.
  if (matches.length === 0) return { status: "none" };

  const hit = matches[0];
  const rows = context.rows ?? [];

  // Rule 6. Nothing on screen. This is not ambiguity — there are no candidates
  // to choose badly between — it is a missing prerequisite, and the only way out
  // is for the speaker to name the thing.
  if (rows.length === 0) {
    return {
      status: "no-context",
      phrase: hit.phrase,
      why: `${quote(hit.phrase)} points at something on screen, but nothing is on screen to point at. Name the claim out loud — "appeal claim 10024" — rather than pointing at it.`,
    };
  }

  // Rule 5. An ordinal names a position, and a position outranks whatever
  // happens to be selected: someone who says "the second one" while row 4 is
  // highlighted means the second one.
  if (hit.kind === "ordinal" && hit.ordinal !== undefined) {
    const position = hit.ordinal === LAST ? rows.length : hit.ordinal;
    if (position > rows.length) {
      return {
        status: "ambiguous",
        phrase: hit.phrase,
        why: `${quote(hit.phrase)} asks for row ${position}, but there ${rows.length === 1 ? "is 1 row" : `are only ${rows.length} rows`} on screen. No row was chosen — say which one, or scroll the one you mean into view.${elision(rows)}`,
        candidates: candidatesFor(rows),
      };
    }
    const row = safeRow(rows[position - 1]);
    return { status: "resolved", row, phrase: hit.phrase, text: replaceSpan(said, hit, reference(row)) };
  }

  // Rule 2. A selection is the speaker's own most recent act of pointing, so a
  // demonstrative rides on it. The membership check matters: a selectedId that
  // is no longer among the rows is a STALE selection — the list was refiltered
  // or repaged under it — and honouring it would act on a row that is not on
  // screen any more. It falls through to the rules below instead.
  const selected = context.selectedId ? rows.find((r) => r.id === context.selectedId) : undefined;
  if (selected) {
    const row = safeRow(selected);
    return { status: "resolved", row, phrase: hit.phrase, text: replaceSpan(said, hit, reference(row)) };
  }

  // Rule 4. One row on screen and no selection. There is no second thing that
  // could have been meant, so resolving here is not a guess — it is the only
  // reading that exists.
  if (rows.length === 1) {
    const row = safeRow(rows[0]);
    return { status: "resolved", row, phrase: hit.phrase, text: replaceSpan(said, hit, reference(row)) };
  }

  // Rule 3, the load-bearing one. Several rows, nothing selected. Every ordering
  // available here — screen order, recency, dollar value — is a property of the
  // LIST, not of what was said, so none of them carries information about which
  // row was meant. Defaulting to rows[0] would look right most of the time and be
  // an appeal filed on the wrong claim the rest of the time.
  return {
    status: "ambiguous",
    phrase: hit.phrase,
    why: `${quote(hit.phrase)} could be any of the ${rows.length} rows on screen and none of them is selected, so nothing in what was said picks one. No row was chosen — select it, or say which one.${elision(rows)}`,
    candidates: candidatesFor(rows),
  };
}

// ── Telling the model what is on screen ──────────────────────────────────────

/**
 * A compact preamble describing the screen, in the shape attachmentPreamble()
 * uses in the web client: a bracketed statement of what the user is looking at, a
 * short list, and a line saying what to do with it.
 *
 * Bounded on purpose. This is prepended to EVERY turn taken while a list is open,
 * so it is paid for on every turn and re-read by the model on every turn. A
 * forty-row worklist pasted in full is both a standing token cost and a way to
 * bury the actual question in table rows — so the list is capped and the
 * remainder is COUNTED rather than dropped silently, because "…and 30 more" is
 * itself the fact that stops the model from reasoning as though it had seen
 * everything.
 *
 * Labels are redacted on the way through. The redaction is closed over here
 * rather than left to the caller because this is the one function whose output is
 * bound for a model, and a safety step a caller has to remember is a safety step
 * that eventually gets forgotten.
 */
export function describeScreen(context: ScreenContext, opts: { maxRows?: number } = {}): string {
  const safe = redactScreenLabels(context);
  const rows = safe.rows;
  // Nothing on screen produces an empty string, not "[0 rows]": an empty
  // preamble adds nothing to the turn, and a turn with no screen context should
  // look exactly like one taken before any list was ever opened.
  if (rows.length === 0) return "";

  const maxRows = Math.max(0, Math.floor(opts.maxRows ?? DEFAULT_MAX_PREAMBLE_ROWS));
  const shown = rows.slice(0, maxRows);
  const hidden = rows.length - shown.length;

  const what = safe.title ? `"${safe.title}"` : safe.view ? `the ${safe.view} view` : "a list";
  const lines: string[] = [
    `[The user is looking at ${what} — ${rows.length} row${rows.length === 1 ? "" : "s"} on screen.]`,
  ];
  for (const [i, row] of shown.entries()) {
    lines.push(`${i + 1}. ${row.label || row.id} — row id ${row.id}${row.kind ? ` (${row.kind})` : ""}`);
  }
  if (hidden > 0) lines.push(`…and ${hidden} more row${hidden === 1 ? "" : "s"} not listed.`);

  const selected = safe.selectedId ? rows.find((r) => r.id === safe.selectedId) : undefined;
  if (selected) {
    // Named even when the cap elided it: the selection is the single most likely
    // referent of anything the user says next, and dropping it because it sat at
    // position 14 would be the worst possible thing to omit.
    const at = rows.indexOf(selected) + 1;
    lines.push(`Selected: ${at}. ${selected.label || selected.id} — row id ${selected.id}`);
  } else if (safe.selectedId) {
    lines.push(`A row is selected that is no longer in this list (${safe.selectedId}) — treat nothing as selected.`);
  }

  lines.push(`Refer to rows by id. If it is not determined which row the user meant, ask — do not pick one.`);
  return lines.join("\n");
}
