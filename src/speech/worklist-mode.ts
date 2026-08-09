import { speakMoney, speakNumber } from "./spoken-codes.js";
import { speakableSummary } from "./speakable.js";

// ── Clearing a denial worklist without touching the keyboard ─────────────────
// The person this module is for has both hands in a chart. They are working
// down a list of denials, and the whole interaction is meant to fit in about six
// words: "next", "why", "appeal it", "skip", "stop". Every tool the actions need
// already exists. What did not exist is the thing in the middle — a cursor over
// the list, and a grammar small enough to be spoken reliably.
//
// This file is that middle, and it is deliberately inert: no I/O, no tool calls,
// no clock. `applyCommand` takes a session and a command and returns the next
// session plus what to say. The caller owns the tools; when a command needs one,
// the step comes back with `send` — a sentence for the AGENT, not for the ear.
//
// Two things make voice worklist mode different from voice anything-else, and
// both of them are about being wrong on the WRONG CLAIM:
//
//  1. A misparse here is not a bad answer, it is an action on someone else's
//     claim. So the grammar is CLOSED. An utterance either is one of the known
//     commands or it is `unrecognized`; there is no fuzzy nearest match, because
//     "appeal it" and "adjust it off" are one recognizer slip apart and they are
//     opposite decisions about the same money.
//  2. Everything the module says out loud is a claim number, a denial code, a
//     dollar figure and a date — the four things a speech engine reads worst.
//     So all of it goes through the spoken-code renderers rather than being
//     handed to the synthesiser raw.

export interface WorklistItem {
  /** The worklist row's own id. Machine-side only — never spoken. */
  id: string;
  /** What the coder says and hears: the claim this row is about. */
  claimId: string;
  label: string;
  reason?: string;
  amount?: number;
  dueInDays?: number;
}

export interface WorklistSession {
  items: WorklistItem[];
  cursor: number;
  /** Worklist ids an action was requested on. */
  done: string[];
  /** Worklist ids deliberately passed over. */
  skipped: string[];
  active: boolean;
}

export type WorklistCommand =
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "repeat" }
  | { kind: "why" }
  | { kind: "act"; action: "appeal" | "write-off" | "rebill" | "note" }
  | { kind: "skip" }
  | { kind: "stop" }
  | { kind: "where" }
  | { kind: "goto"; index: number }
  | { kind: "unrecognized"; heard: string };

export interface WorklistStep {
  session: WorklistSession;
  say: string;
  prompt?: string;
  /** A message to send to the agent, when the command needs the agent rather than the cursor. */
  send?: string;
  ended?: boolean;
}

/**
 * The whole grammar, in one sentence, said back whenever nothing matched.
 *
 * Five commands, because a spoken menu longer than that is not remembered and
 * the sixth option is the one that gets misspoken. `previous`, `repeat`,
 * `where` and `goto` are understood but not advertised: they are recovery
 * moves, and someone who needs one already knows to ask for it.
 */
export const WORKLIST_PROMPT = "Say next, why, appeal it, skip, or stop.";

/**
 * How near a filing deadline has to be before it is worth a sentence.
 *
 * A deadline read out on every item is noise, and noise on every item is what
 * trains a listener to stop hearing the sentence — including on the one claim
 * that is two days from the timely-filing limit. Saying it only when it is
 * close is what keeps it audible when it matters.
 */
export const DEADLINE_SOON_DAYS = 7;

// ── Saying an identifier ─────────────────────────────────────────────────────

/**
 * Spell a claim number the way a person reads one aloud.
 *
 * Handed "CLM-1042" every speech engine says "C-L-M dash one thousand
 * forty two", and a coder cannot match that against anything on their screen or
 * write it on a sticky note. The separator is kept and spoken ("dash") rather
 * than dropped, because a claim id is a thing the listener may have to repeat
 * back to a payer, and an id repeated back without its separator is a different
 * id.
 *
 * `speakCode` is deliberately not reused here: it reads the segment after a
 * hyphen as a CPT modifier, so "CLM-1042" would come out as "C L M modifier one
 * zero four two" — an announcement that invents a modifier out of a claim
 * number.
 */
export function speakIdentifier(id: string): string {
  const raw = String(id ?? "").trim().toUpperCase();
  if (!raw) return "";

  const parts: string[] = [];
  for (const ch of raw) {
    if (ch >= "0" && ch <= "9") parts.push(speakNumber(Number(ch)));
    else if (ch === "-" || ch === "_" || ch === "/") parts.push("dash");
    else if (ch === ".") parts.push("point");
    else if (/\s/.test(ch)) continue;
    else parts.push(ch);
  }
  return parts.join(" ");
}

/**
 * Spell the digits of a denial code that follows its label.
 *
 * `expandSpeakableLiterals` deliberately leaves short integers alone, because
 * "5 units" is five units and a renderer that spelled every number would read
 * page counts digit by digit. That rule is right in general and wrong here: a
 * CARC is one to three digits, so CARC 97 arrives as a bare "97" and is read as
 * "ninety seven" — which is how a denial for bundling gets confused with a
 * denial for a deductible over a speaker. The label in front of it is the
 * evidence that these particular digits are a code, so this only fires when the
 * label is there.
 */
function spellDenialCodes(text: string): string {
  return text.replace(
    /\b(CARC|RARC)\s*#?\s*([A-Za-z]?\d{1,4}[A-Za-z]?)\b/gi,
    (_all, label: string, code: string) =>
      `${label.toUpperCase()} ${code
        .toUpperCase()
        .split("")
        .map((ch) => (/\d/.test(ch) ? speakNumber(Number(ch)) : ch))
        .join(" ")}`,
  );
}

/** Join clauses into speakable sentences without doubling up the full stops. */
function sentences(parts: Array<string | null | undefined>): string {
  const kept = parts
    .map((p) => (p ?? "").trim().replace(/\s*\.\s*$/, "").trim())
    .filter(Boolean);
  return kept.length === 0 ? "" : `${kept.join(". ")}.`;
}

// ── What the cursor says when it lands ───────────────────────────────────────

/**
 * The one thing spoken when the cursor moves onto an item.
 *
 * Ordered by what decides the action, not by what the record looks like: the
 * claim, then why it was denied, then the money, then the deadline if one is
 * near. A coder who hears the reason and the balance can say "appeal it" or
 * "write it off" without hearing the rest, and in a list of forty denials the
 * sentences they do not have to listen to are the whole productivity story.
 *
 * The free-text fields go through `speakableSummary`, which is both the
 * markdown stripper and the length limit: a worklist detail pasted from a payer
 * portal can be a paragraph with a URL in it, and a paragraph read aloud
 * between every item turns a two-minute pass into fifteen.
 *
 * The amount is rendered with `speakMoney` directly rather than written as
 * "$412.50" and left to the literal expander. The expander's money pattern
 * starts at the dollar sign, so a negative balance written "-$50.00" would be
 * matched from the "$" and read out as "fifty dollars" — a takeback announced
 * as a payment.
 */
export function announceItem(item: WorklistItem, position: number, total: number): string {
  const claim = speakIdentifier(item.claimId);
  const label = speakableSummary(item.label ?? "", 80);
  const head = label ? `${position} of ${total}. Claim ${claim}, ${label}` : `${position} of ${total}. Claim ${claim}`;

  const reason = item.reason ? speakableSummary(spellDenialCodes(item.reason), 160) : "";
  const denial = reason ? `Denied: ${reason}` : "No denial reason on record";

  // Labelled, because a bare figure between two sentences is a number with no
  // noun attached, and the listener has to guess whether they just heard the
  // billed charge, the allowed amount or what is still outstanding.
  const money = typeof item.amount === "number" && Number.isFinite(item.amount)
    ? `Balance ${speakMoney(item.amount)}`
    : "";

  return sentences([head, denial, money, deadlineClause(item.dueInDays)]);
}

function deadlineClause(dueInDays?: number): string {
  if (typeof dueInDays !== "number" || !Number.isFinite(dueInDays)) return "";
  const days = Math.trunc(dueInDays);

  // A deadline already gone is said whatever its distance: it changes the
  // action from "appeal" to "appeal with a timely-filing argument", and a
  // listener who is not told will pick the wrong one.
  if (days < 0) {
    const late = -days;
    return `The deadline passed ${late} ${late === 1 ? "day" : "days"} ago`;
  }
  if (days === 0) return "Due today";
  if (days <= DEADLINE_SOON_DAYS) return `Due in ${days} ${days === 1 ? "day" : "days"}`;
  return "";
}

/** Where the cursor is, in one sentence, for "where am I" and for the logs. */
export function describeWorklistState(session: WorklistSession): string {
  const total = session.items.length;
  if (total === 0) return "The worklist is empty.";

  const tally = `${session.done.length} worked, ${session.skipped.length} skipped`;
  if (!session.active) return sentences(["Worklist mode is off", tally]);
  if (session.cursor >= total) return sentences(["Past the end of the worklist", tally]);

  const item = session.items[session.cursor];
  const ahead = total - session.cursor - 1;
  return sentences([
    `Item ${session.cursor + 1} of ${total}, claim ${speakIdentifier(item.claimId)}`,
    tally,
    `${ahead} after this one`,
  ]);
}

// ── The command grammar ──────────────────────────────────────────────────────

/**
 * Words with no content that a speaker puts in front of a command.
 *
 * Stripping these is not the near-guessing the rest of this file refuses:
 * "okay next" and "next" are the same instruction, and none of these words can
 * change which claim is acted on. Anything with actual meaning stays, so
 * "maybe next" is still unrecognized — a hedge is not a command.
 */
const FILLER_WORDS = new Set(["ok", "okay", "alright", "please", "um", "uh", "er", "yeah"]);

/**
 * Every accepted utterance, matched WHOLE.
 *
 * Whole-utterance matching is the load-bearing decision. A substring or
 * keyword match would read "not this one, appeal the next one" as an appeal on
 * the item under the cursor, which is the exact opposite of what was said. If
 * the speaker adds words, the answer is "say that again", not a best effort.
 */
const COMMAND_PHRASES: Record<string, WorklistCommand> = {};

function register(command: WorklistCommand, phrases: string[]): void {
  for (const phrase of phrases) COMMAND_PHRASES[phrase] = command;
}

register({ kind: "next" }, [
  "next",
  "next one",
  "next item",
  "next claim",
  "next denial",
  "move on",
  "go on",
  "keep going",
  "carry on",
  "continue",
  "onward",
]);

register({ kind: "previous" }, [
  "previous",
  "previous one",
  "previous item",
  "previous claim",
  "back",
  "go back",
  "back one",
  "back up",
  "last one",
]);

register({ kind: "repeat" }, [
  "repeat",
  "repeat that",
  "say that again",
  "again",
  "one more time",
  "come again",
  "what was that",
]);

register({ kind: "why" }, [
  "why",
  "why this one",
  "why was it denied",
  "why was this denied",
  "why did it deny",
  "why denied",
  "what was the denial",
  "what is the reason",
  "what's the reason",
  "whats the reason",
  "reason",
  "what happened",
]);

// The action phrases are the shortest lists in the file, on purpose. Every
// phrase added here is a phrase a recognizer can produce by accident.
register({ kind: "act", action: "appeal" }, [
  "appeal",
  "appeal it",
  "appeal this",
  "appeal that",
  "appeal this one",
  "appeal the claim",
  "file an appeal",
  "file the appeal",
  "start an appeal",
]);

register({ kind: "act", action: "write-off" }, [
  "write off",
  "write it off",
  "write this off",
  "write off the balance",
  "adjust it off",
  "adjust off",
]);

register({ kind: "act", action: "rebill" }, [
  "rebill",
  "rebill it",
  "rebill this",
  "resubmit",
  "resubmit it",
  "correct and resubmit",
  "correct and rebill",
]);

register({ kind: "act", action: "note" }, [
  "note",
  "note it",
  "add a note",
  "make a note",
  "leave a note",
]);

register({ kind: "skip" }, [
  "skip",
  "skip it",
  "skip this",
  "skip this one",
  "leave it",
  "leave this one",
  "pass",
  "not now",
  "come back to it",
]);

register({ kind: "stop" }, [
  "stop",
  "exit",
  "quit",
  "stop worklist",
  "exit worklist",
  "quit worklist",
  "end worklist",
  "stop the worklist",
  "i'm done",
  "im done",
  "that's enough",
  "thats enough",
]);

register({ kind: "where" }, [
  "where am i",
  "where are we",
  "where was i",
  "how many left",
  "how many are left",
  "how many more",
  "what's left",
  "whats left",
  "how far along are we",
  "status",
]);

/**
 * Spoken positions, one through twenty.
 *
 * Twenty is not arbitrary: past that people say the digits ("go to number
 * thirty two" is rare, "go to thirty two" rarer still), and a compound
 * number-word parser is exactly the kind of cleverness that turns "go to
 * twenty" plus a stray "one" into item twenty-one.
 */
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};

const GOTO_RE =
  /^(?:go(?:\s+back)?\s+to|goto|jump\s+to|skip\s+to|take\s+me\s+to)\s+(?:the\s+)?(?:number|item|claim|line|#)?\s*([a-z0-9]+)$/;
const BARE_INDEX_RE = /^(?:number|item)\s+([a-z0-9]+)$/;

function parseIndex(token: string): number | null {
  if (/^\d{1,3}$/.test(token)) return Number(token);
  return NUMBER_WORDS[token] ?? null;
}

/**
 * Reduce an utterance to the form the phrase table is written in.
 *
 * Punctuation goes because a recognizer sprinkles it unpredictably — "next."
 * and "next" and "Next!" are one command. The apostrophe stays, because "what's
 * left" and "whats left" are both things engines return and only one of them
 * survives naive punctuation stripping.
 */
function normalizeUtterance(text: string): string {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'#\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  let start = 0;
  let end = words.length;
  while (start < end && FILLER_WORDS.has(words[start])) start += 1;
  while (end > start && FILLER_WORDS.has(words[end - 1])) end -= 1;
  return words.slice(start, end).join(" ");
}

/**
 * Turn an utterance into a worklist command, or into `unrecognized`.
 *
 * The closed grammar is the safety property of this whole mode. Elsewhere in
 * the product a misparse costs a round trip; here it files an appeal on a claim
 * the coder was not looking at, or writes off a balance they meant to fight.
 * There is no similarity scoring and no partial credit: an utterance is in the
 * table, matches the one `goto` pattern, or is handed back with what was heard
 * so the caller can ask again.
 *
 * `heard` carries the ORIGINAL text rather than the normalized form, because
 * the only use for it is a human deciding whether the recognizer or the speaker
 * was at fault, and the normalized form has already thrown away the evidence.
 */
export function parseWorklistCommand(text: string): WorklistCommand {
  const heard = String(text ?? "").trim();
  const utterance = normalizeUtterance(heard);
  if (!utterance) return { kind: "unrecognized", heard };

  const direct = COMMAND_PHRASES[utterance];
  if (direct) return direct;

  const goto = GOTO_RE.exec(utterance) ?? BARE_INDEX_RE.exec(utterance);
  if (goto) {
    const index = parseIndex(goto[1]);
    // A number word this parser does not know ("go to number fifty seven") is
    // not a goto with a guessed index — it is an utterance nobody has confirmed
    // the meaning of, and moving the cursor on a guess is moving the claim.
    if (index !== null) return { kind: "goto", index };
  }

  return { kind: "unrecognized", heard };
}

// ── The state machine ────────────────────────────────────────────────────────

/**
 * Open a session over a list of items.
 *
 * The array is copied. Sharing the caller's array would let a later push change
 * the length of a run already in progress — the coder hears "3 of 7", works
 * three more items, and is told there are nine.
 *
 * An empty list starts inactive, because there is no session to be in.
 */
export function startWorklist(items: WorklistItem[]): WorklistSession {
  const copied = [...(items ?? [])];
  return { items: copied, cursor: 0, done: [], skipped: [], active: copied.length > 0 };
}

/**
 * What the agent is told to do, with the claim number written out every time.
 *
 * "Appeal it" is what the coder says and it is exactly what the agent must
 * never be handed. A pronoun makes the model resolve a referent from whatever
 * context it happens to have — the last claim mentioned, the one in the
 * previous turn, the one in a tool result — and the resolution is invisible
 * when it goes wrong. Naming the claim in every clause makes the instruction
 * true on its own, with no conversation attached.
 *
 * These strings go to a model, so the id stays WRITTEN. The spoken spelling
 * belongs to `say`; a claim id spelled "C L M dash one zero four two" in a tool
 * argument is not a claim id at all.
 */
const ACTION_INSTRUCTIONS: Record<"appeal" | "write-off" | "rebill" | "note", (claimId: string) => string> = {
  appeal: (id) =>
    `Start an appeal on claim ${id}. Use the denial reason already recorded on claim ${id}. Do not act on any other claim.`,
  "write-off": (id) =>
    `Post an adjustment write-off on claim ${id}, and record the denial reason against claim ${id}. Do not act on any other claim.`,
  rebill: (id) =>
    `Correct and rebill claim ${id}, fixing only the errors recorded on claim ${id}. Do not act on any other claim.`,
  note: (id) =>
    `Add a note to claim ${id} from the coder's dictation, attached to claim ${id} alone. Do not act on any other claim.`,
};

const ACTION_SAID: Record<"appeal" | "write-off" | "rebill" | "note", string> = {
  appeal: "Appealing claim",
  "write-off": "Writing off claim",
  rebill: "Rebilling claim",
  note: "Noting claim",
};

function tally(session: WorklistSession): string {
  const untouched = session.items.length - session.done.length - session.skipped.length;
  return `${session.done.length} worked, ${session.skipped.length} skipped, ${untouched} not touched`;
}

function endSession(session: WorklistSession, cursor: number, opener: string): WorklistStep {
  const ended: WorklistSession = { ...session, cursor, active: false };
  return { session: ended, say: sentences([opener, tally(ended)]), ended: true };
}

/**
 * `done` and `skipped` are kept disjoint, and work wins.
 *
 * An item cannot be both worked and passed over: letting it sit in both lists
 * makes the closing count add up to more items than the worklist ever had, and
 * that count is the number the coder repeats to their lead.
 *
 * Which list wins is not symmetric. An action supersedes an earlier pass — the
 * coder came back to the claim and did something about it. A pass never
 * supersedes an action: "appeal it… skip" is an appeal followed by "move on",
 * and recording that as a skip would erase the appeal from the tally.
 */
function markWorked(session: WorklistSession, id: string): Pick<WorklistSession, "done" | "skipped"> {
  return {
    done: session.done.includes(id) ? session.done : [...session.done, id],
    skipped: session.skipped.filter((x) => x !== id),
  };
}

function markSkipped(session: WorklistSession, id: string): Pick<WorklistSession, "done" | "skipped"> {
  const alreadyCounted = session.done.includes(id) || session.skipped.includes(id);
  return {
    done: session.done,
    skipped: alreadyCounted ? session.skipped : [...session.skipped, id],
  };
}

function landOn(session: WorklistSession, cursor: number): WorklistStep {
  const item = session.items[cursor];
  return {
    session: { ...session, cursor },
    say: announceItem(item, cursor + 1, session.items.length),
  };
}

/**
 * Move to `cursor`, or finish.
 *
 * Running off the end ENDS the session; it does not wrap. Wrapping is the
 * tempting behaviour and it is the wrong one — a list that silently restarts
 * looks identical to a list that has more items on it, and the coder works the
 * first five claims a second time before anything tells them otherwise.
 */
function advanceTo(session: WorklistSession, cursor: number): WorklistStep {
  if (cursor >= session.items.length) {
    return endSession(session, session.items.length, "That is the end of the worklist");
  }
  return landOn(session, cursor);
}

/**
 * Apply one command to one session.
 *
 * Pure: the session passed in is never mutated, and every branch returns either
 * a fresh session or — for `unrecognized` — the very object it was given.
 */
export function applyCommand(session: WorklistSession, command: WorklistCommand): WorklistStep {
  // First, before any other rule can qualify it. An utterance nobody
  // understood must not move the cursor, must not mark anything worked or
  // skipped, and must not end the session: the failure this prevents is an
  // action landing on a claim the coder was not talking about, and the only
  // way to be sure of that is to change nothing at all and ask again.
  if (command.kind === "unrecognized") {
    return {
      session,
      // What was heard is deliberately not read back. It is a live microphone in
      // a room with patients in it, and the one thing worse than not
      // understanding an utterance is repeating it out loud.
      say: "I didn't catch a worklist command.",
      prompt: WORKLIST_PROMPT,
    };
  }

  // An empty worklist says so and closes, rather than presenting nothing and
  // leaving the coder talking to a session with no items in it.
  if (session.items.length === 0) {
    return {
      session: { ...session, cursor: 0, active: false },
      say: "The worklist is empty. There is nothing to work.",
      ended: true,
    };
  }

  if (!session.active) {
    return { session, say: sentences(["Worklist mode is off", tally(session)]), ended: true };
  }

  const cursor = Math.min(Math.max(session.cursor, 0), session.items.length - 1);
  const item = session.items[cursor];

  switch (command.kind) {
    case "next":
      return advanceTo(session, cursor + 1);

    case "previous":
      // The first item does not wrap to the last for the same reason the end
      // does not wrap to the start, and the current item is re-announced so the
      // refusal still leaves the coder knowing where they are.
      if (cursor === 0) {
        return {
          session: { ...session, cursor },
          say: sentences([
            "That is the first item",
            announceItem(item, 1, session.items.length),
          ]),
        };
      }
      return landOn(session, cursor - 1);

    case "repeat":
      return landOn(session, cursor);

    case "why":
      // The short reason is spoken immediately so the coder is not waiting on a
      // tool, and the agent is asked for the real explanation in parallel. The
      // cursor does not move: "why" is a question about the item under it.
      return {
        session: { ...session, cursor },
        say: item.reason
          ? sentences([`Claim ${speakIdentifier(item.claimId)}`, speakableSummary(spellDenialCodes(item.reason), 200)])
          : sentences([`No denial reason on record for claim ${speakIdentifier(item.claimId)}`, "Checking the denial now"]),
        send:
          `Explain the denial on claim ${item.claimId} in two sentences: the CARC and RARC reason, ` +
          `and the single best next step for claim ${item.claimId}.`,
      };

    case "act": {
      // The cursor deliberately stays put. Advancing here would mark the item
      // behind before the appeal has actually been drafted or the write-off
      // posted — and an item the coder has moved past is an item nobody looks
      // at again, so a failed action would disappear silently.
      return {
        session: { ...session, cursor, ...markWorked(session, item.id) },
        say: sentences([
          `${ACTION_SAID[command.action]} ${speakIdentifier(item.claimId)}`,
          "Say next when you are ready to move on",
        ]),
        send: ACTION_INSTRUCTIONS[command.action](item.claimId),
      };
    }

    case "skip":
      return advanceTo({ ...session, ...markSkipped(session, item.id) }, cursor + 1);

    case "stop":
      return endSession(session, cursor, "Worklist mode off");

    case "where":
      return { session: { ...session, cursor }, say: describeWorklistState({ ...session, cursor }) };

    case "goto": {
      // Spoken positions are one-based, because "number three" means the third
      // item to everyone who has ever said it out loud.
      const target = command.index - 1;
      if (target < 0 || target >= session.items.length) {
        // The real range is said rather than the cursor being clamped to an
        // end. Clamping obeys an instruction nobody gave, and the coder who
        // asked for item twelve of a seven-item list has confused this worklist
        // with another one — which they only find out if they are told the size
        // of the one they are actually in.
        return {
          session: { ...session, cursor },
          say: `There ${session.items.length === 1 ? "is 1 item" : `are ${session.items.length} items`} on the worklist.`,
          prompt: `Say a number between 1 and ${session.items.length}.`,
        };
      }
      return landOn(session, target);
    }
  }
}

/**
 * A spoken opening line for the session.
 *
 * Exported because the first thing said when worklist mode starts has the same
 * problem as everything else here — it is a count and a claim number — and a
 * caller writing it by hand writes it without the renderers.
 */
export function announceWorklistStart(session: WorklistSession): string {
  if (session.items.length === 0) return "The worklist is empty. There is nothing to work.";
  const total = session.items.length;
  return sentences([
    `${total} ${total === 1 ? "item" : "items"} on the worklist`,
    announceItem(session.items[Math.min(session.cursor, total - 1)], session.cursor + 1, total),
  ]);
}
