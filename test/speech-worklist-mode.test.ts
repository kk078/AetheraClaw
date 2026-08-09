import { describe, expect, it } from "vitest";
import {
  DEADLINE_SOON_DAYS,
  WORKLIST_PROMPT,
  announceItem,
  announceWorklistStart,
  applyCommand,
  describeWorklistState,
  parseWorklistCommand,
  speakIdentifier,
  startWorklist,
  type WorklistItem,
  type WorklistSession,
} from "../src/speech/worklist-mode.js";

// A pronoun in an instruction sent to the agent is the whole failure this mode
// has to avoid: the model resolves "it" against whatever claim it last saw, and
// the resolution is invisible when it goes wrong.
const PRONOUN = /\b(it|its|this|that|these|those|them|they|he|she|him|her|his|there|same)\b/i;

const ITEMS: WorklistItem[] = [
  {
    id: "wl_1",
    claimId: "CLM-1042",
    label: "Aetna office visit denial",
    reason: "CARC 97 bundled into the primary service",
    amount: 412.5,
    dueInDays: 3,
  },
  { id: "wl_2", claimId: "CLM-2087", label: "BCBS lab panel", reason: "CARC 50 medical necessity", amount: 96 },
  { id: "wl_3", claimId: "A2211", label: "UHC imaging", amount: 1234.56, dueInDays: 60 },
];

function session(): WorklistSession {
  return startWorklist(ITEMS);
}

// ── parseWorklistCommand: the closed grammar ─────────────────────────────────

describe("parseWorklistCommand — the six words", () => {
  it("accepts the natural variants of next", () => {
    for (const said of [
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
    ]) {
      expect(parseWorklistCommand(said), said).toEqual({ kind: "next" });
    }
  });

  it("accepts the variants of previous", () => {
    for (const said of ["previous", "previous one", "previous claim", "back", "go back", "back up", "last one"]) {
      expect(parseWorklistCommand(said), said).toEqual({ kind: "previous" });
    }
  });

  it("accepts the variants of repeat", () => {
    for (const said of ["repeat", "repeat that", "say that again", "again", "one more time", "come again"]) {
      expect(parseWorklistCommand(said), said).toEqual({ kind: "repeat" });
    }
  });

  it("accepts the variants of why", () => {
    for (const said of [
      "why",
      "why this one",
      "why was it denied",
      "why was this denied",
      "why denied",
      "what was the denial",
      "what's the reason",
      "whats the reason",
      "reason",
    ]) {
      expect(parseWorklistCommand(said), said).toEqual({ kind: "why" });
    }
  });

  it("accepts the variants of each action", () => {
    for (const said of ["appeal", "appeal it", "appeal this", "file an appeal", "start an appeal"]) {
      expect(parseWorklistCommand(said), said).toEqual({ kind: "act", action: "appeal" });
    }
    for (const said of ["write off", "write-off", "write it off", "write this off", "adjust it off"]) {
      expect(parseWorklistCommand(said), said).toEqual({ kind: "act", action: "write-off" });
    }
    for (const said of ["rebill", "rebill it", "resubmit", "resubmit it", "correct and resubmit"]) {
      expect(parseWorklistCommand(said), said).toEqual({ kind: "act", action: "rebill" });
    }
    for (const said of ["note", "note it", "add a note", "make a note", "leave a note"]) {
      expect(parseWorklistCommand(said), said).toEqual({ kind: "act", action: "note" });
    }
  });

  it("accepts the variants of skip", () => {
    for (const said of ["skip", "skip it", "skip this one", "leave it", "leave this one", "pass", "not now"]) {
      expect(parseWorklistCommand(said), said).toEqual({ kind: "skip" });
    }
  });

  it("accepts the variants of stop", () => {
    for (const said of ["stop", "exit", "quit", "quit worklist", "exit worklist", "end worklist", "i'm done"]) {
      expect(parseWorklistCommand(said), said).toEqual({ kind: "stop" });
    }
  });

  it("accepts the variants of where", () => {
    for (const said of [
      "where am I",
      "where are we",
      "how many left",
      "how many are left",
      "how many more",
      "what's left",
      "status",
    ]) {
      expect(parseWorklistCommand(said), said).toEqual({ kind: "where" });
    }
  });

  it("reads a spoken position as a one-based index", () => {
    expect(parseWorklistCommand("go to number three")).toEqual({ kind: "goto", index: 3 });
    expect(parseWorklistCommand("go to three")).toEqual({ kind: "goto", index: 3 });
    expect(parseWorklistCommand("go to item 3")).toEqual({ kind: "goto", index: 3 });
    expect(parseWorklistCommand("jump to number twelve")).toEqual({ kind: "goto", index: 12 });
    expect(parseWorklistCommand("number 3")).toEqual({ kind: "goto", index: 3 });
    expect(parseWorklistCommand("go back to number two")).toEqual({ kind: "goto", index: 2 });
  });

  it("ignores punctuation, casing and leading politeness", () => {
    // A recognizer sprinkles punctuation and capitals unpredictably; none of
    // those differences is a different instruction. Neither is "okay".
    expect(parseWorklistCommand("Next.")).toEqual({ kind: "next" });
    expect(parseWorklistCommand("  NEXT ONE!  ")).toEqual({ kind: "next" });
    expect(parseWorklistCommand("okay next please")).toEqual({ kind: "next" });
    expect(parseWorklistCommand("um, skip it")).toEqual({ kind: "skip" });
  });
});

describe("parseWorklistCommand — everything else is unrecognized", () => {
  it("refuses an utterance that merely contains a command word", () => {
    // The load-bearing case. A keyword matcher reads "appeal the next one" as
    // an appeal on the claim under the cursor — the opposite of what was said,
    // on the wrong claim, with money attached.
    expect(parseWorklistCommand("appeal the next one")).toEqual({
      kind: "unrecognized",
      heard: "appeal the next one",
    });
    expect(parseWorklistCommand("don't appeal it")).toMatchObject({ kind: "unrecognized" });
    expect(parseWorklistCommand("not this one, skip to the appeal")).toMatchObject({ kind: "unrecognized" });
    expect(parseWorklistCommand("next time write it off")).toMatchObject({ kind: "unrecognized" });
  });

  it("refuses a hedge, because a hedge is not a command", () => {
    expect(parseWorklistCommand("maybe next")).toMatchObject({ kind: "unrecognized" });
    expect(parseWorklistCommand("i think we should appeal")).toMatchObject({ kind: "unrecognized" });
    expect(parseWorklistCommand("probably skip")).toMatchObject({ kind: "unrecognized" });
  });

  it("refuses ordinary dictation and prose", () => {
    expect(parseWorklistCommand("the patient came in on Tuesday")).toMatchObject({ kind: "unrecognized" });
    expect(parseWorklistCommand("what is the allowed amount on this fee schedule")).toMatchObject({
      kind: "unrecognized",
    });
  });

  it("refuses an empty or whitespace utterance", () => {
    expect(parseWorklistCommand("")).toEqual({ kind: "unrecognized", heard: "" });
    expect(parseWorklistCommand("   ")).toEqual({ kind: "unrecognized", heard: "" });
    expect(parseWorklistCommand(null as unknown as string)).toEqual({ kind: "unrecognized", heard: "" });
  });

  it("refuses a position it cannot resolve rather than guessing one", () => {
    // "fifty seven" is not in the number table. A goto with a guessed index is
    // a cursor move onto a claim nobody named.
    expect(parseWorklistCommand("go to number fifty seven")).toMatchObject({ kind: "unrecognized" });
    expect(parseWorklistCommand("go to the one about the lab")).toMatchObject({ kind: "unrecognized" });
  });

  it("hands back what was heard, not the normalized form", () => {
    // The only use for `heard` is a human deciding whether the recognizer or
    // the speaker was at fault, and normalizing throws that evidence away.
    expect(parseWorklistCommand("  Appeal the NEXT one!  ")).toEqual({
      kind: "unrecognized",
      heard: "Appeal the NEXT one!",
    });
  });
});

// ── startWorklist ────────────────────────────────────────────────────────────

describe("startWorklist", () => {
  it("opens at the first item with nothing recorded", () => {
    const s = session();
    expect(s.cursor).toBe(0);
    expect(s.done).toEqual([]);
    expect(s.skipped).toEqual([]);
    expect(s.active).toBe(true);
    expect(s.items).toHaveLength(3);
  });

  it("copies the caller's array so a later push cannot change the run", () => {
    const live: WorklistItem[] = [ITEMS[0]];
    const s = startWorklist(live);
    live.push(ITEMS[1]);
    expect(s.items).toHaveLength(1);
  });

  it("starts an empty worklist inactive, because there is no session to be in", () => {
    expect(startWorklist([])).toEqual({ items: [], cursor: 0, done: [], skipped: [], active: false });
  });
});

// ── applyCommand: the state transitions ──────────────────────────────────────

describe("applyCommand — next", () => {
  it("moves forward one item and announces it", () => {
    const step = applyCommand(session(), { kind: "next" });
    expect(step.session.cursor).toBe(1);
    expect(step.say).toMatch(/^2 of 3\./);
    expect(step.ended).toBeFalsy();
  });

  it("ends at the end rather than wrapping around", () => {
    // Rule 1. A list that silently restarts is indistinguishable from a list
    // with more items on it, and the coder works the first claims twice.
    let s = session();
    s = applyCommand(s, { kind: "next" }).session;
    s = applyCommand(s, { kind: "next" }).session;
    expect(s.cursor).toBe(2);

    const off = applyCommand(s, { kind: "next" });
    expect(off.ended).toBe(true);
    expect(off.session.active).toBe(false);
    expect(off.session.cursor).not.toBe(0);
    expect(off.session.cursor).toBe(3);
    expect(off.say).toMatch(/end of the worklist/i);
  });

  it("says how many were worked and how many skipped when it ends", () => {
    let step = applyCommand(session(), { kind: "act", action: "appeal" });
    step = applyCommand(step.session, { kind: "next" });
    step = applyCommand(step.session, { kind: "skip" });
    step = applyCommand(step.session, { kind: "next" });

    expect(step.ended).toBe(true);
    expect(step.say).toMatch(/1 worked/);
    expect(step.say).toMatch(/1 skipped/);
    expect(step.say).toMatch(/1 not touched/);
  });
});

describe("applyCommand — previous and repeat", () => {
  it("steps back one item", () => {
    const forward = applyCommand(session(), { kind: "next" });
    const back = applyCommand(forward.session, { kind: "previous" });
    expect(back.session.cursor).toBe(0);
    expect(back.say).toMatch(/^1 of 3\./);
  });

  it("does not wrap to the last item from the first", () => {
    const step = applyCommand(session(), { kind: "previous" });
    expect(step.session.cursor).toBe(0);
    expect(step.say).toMatch(/first item/i);
    // The refusal still leaves the listener knowing where they are.
    expect(step.say).toMatch(/1 of 3/);
  });

  it("repeats the current item without moving", () => {
    const s = applyCommand(session(), { kind: "next" }).session;
    const step = applyCommand(s, { kind: "repeat" });
    expect(step.session.cursor).toBe(1);
    expect(step.say).toBe(announceItem(ITEMS[1], 2, 3));
  });
});

describe("applyCommand — why", () => {
  it("speaks the reason on record and asks the agent for the full one", () => {
    const step = applyCommand(session(), { kind: "why" });
    expect(step.session.cursor).toBe(0);
    expect(step.say).toMatch(/C A R C nine seven/);
    expect(step.send).toContain("CLM-1042");
  });

  it("names the claim in the message to the agent and uses no pronoun", () => {
    const step = applyCommand(session(), { kind: "why" });
    expect(step.send).toBeTruthy();
    expect(step.send).not.toMatch(PRONOUN);
  });

  it("says so when there is no reason on record instead of inventing one", () => {
    const s = startWorklist([ITEMS[2]]);
    const step = applyCommand(s, { kind: "why" });
    expect(step.say).toMatch(/no denial reason on record/i);
    expect(step.send).toContain("A2211");
  });
});

describe("applyCommand — act", () => {
  it("does NOT advance the cursor", () => {
    // Rule 2. Advancing would put an item behind the cursor before the appeal
    // was actually drafted, and an item behind the cursor is one nobody looks
    // at again — so a failed action would vanish silently.
    const step = applyCommand(session(), { kind: "act", action: "appeal" });
    expect(step.session.cursor).toBe(0);
    expect(step.ended).toBeFalsy();
    expect(step.session.active).toBe(true);
  });

  it("names the claim id explicitly in every action and never uses a pronoun", () => {
    for (const action of ["appeal", "write-off", "rebill", "note"] as const) {
      const step = applyCommand(session(), { kind: "act", action });
      expect(step.send, action).toBeTruthy();
      expect(step.send, action).toContain("CLM-1042");
      expect(step.send, action).not.toMatch(PRONOUN);
    }
  });

  it("sends the claim id written, not spelled for speech", () => {
    // `send` goes to a model. "C L M dash one zero four two" is not a claim id.
    const step = applyCommand(session(), { kind: "act", action: "appeal" });
    expect(step.send).toContain("CLM-1042");
    expect(step.send).not.toMatch(/C L M/);
    // `say` goes to a speaker, and there it must be spelled.
    expect(step.say).toContain("C L M dash one zero four two");
  });

  it("records the item as worked without touching the other items", () => {
    const step = applyCommand(session(), { kind: "act", action: "write-off" });
    expect(step.session.done).toEqual(["wl_1"]);
    expect(step.session.skipped).toEqual([]);
    expect(step.session.items).toEqual(ITEMS);
  });

  it("does not record the same item twice", () => {
    let step = applyCommand(session(), { kind: "act", action: "appeal" });
    step = applyCommand(step.session, { kind: "act", action: "rebill" });
    expect(step.session.done).toEqual(["wl_1"]);
  });

  it("takes an item out of skipped when it is acted on", () => {
    // Otherwise the closing count reports more items than the worklist had.
    let step = applyCommand(session(), { kind: "skip" });
    expect(step.session.skipped).toEqual(["wl_1"]);
    step = applyCommand(step.session, { kind: "goto", index: 1 });
    step = applyCommand(step.session, { kind: "act", action: "appeal" });
    expect(step.session.skipped).toEqual([]);
    expect(step.session.done).toEqual(["wl_1"]);
  });
});

describe("applyCommand — skip", () => {
  it("records the id and advances", () => {
    // Rule 3.
    const step = applyCommand(session(), { kind: "skip" });
    expect(step.session.skipped).toEqual(["wl_1"]);
    expect(step.session.cursor).toBe(1);
    expect(step.say).toMatch(/^2 of 3\./);
  });

  it("does not un-work an item that was already acted on", () => {
    // "appeal it… skip" is an appeal followed by "move on". Recording the skip
    // over the top of it would erase the appeal from the closing tally.
    let step = applyCommand(session(), { kind: "act", action: "appeal" });
    step = applyCommand(step.session, { kind: "skip" });
    expect(step.session.done).toEqual(["wl_1"]);
    expect(step.session.skipped).toEqual([]);
    expect(step.session.cursor).toBe(1);
  });

  it("does not record the same skip twice", () => {
    let step = applyCommand(session(), { kind: "skip" });
    step = applyCommand(step.session, { kind: "goto", index: 1 });
    step = applyCommand(step.session, { kind: "skip" });
    expect(step.session.skipped).toEqual(["wl_1"]);
  });

  it("ends the session when the last item is skipped", () => {
    let s = session();
    s = applyCommand(s, { kind: "goto", index: 3 }).session;
    const step = applyCommand(s, { kind: "skip" });
    expect(step.session.skipped).toEqual(["wl_3"]);
    expect(step.ended).toBe(true);
    expect(step.session.active).toBe(false);
  });
});

describe("applyCommand — stop", () => {
  it("closes the session and summarises", () => {
    // Rule 4.
    let step = applyCommand(session(), { kind: "act", action: "appeal" });
    step = applyCommand(step.session, { kind: "next" });
    step = applyCommand(step.session, { kind: "stop" });

    expect(step.session.active).toBe(false);
    expect(step.ended).toBe(true);
    expect(step.say).toMatch(/1 worked, 0 skipped, 2 not touched/);
  });

  it("answers an already-closed session without reopening it", () => {
    const closed = applyCommand(session(), { kind: "stop" }).session;
    const again = applyCommand(closed, { kind: "next" });
    expect(again.session.active).toBe(false);
    expect(again.session.cursor).toBe(closed.cursor);
    expect(again.ended).toBe(true);
  });
});

describe("applyCommand — unrecognized", () => {
  it("leaves the session byte-identical", () => {
    // Rule 5, and the reason the grammar is closed at all: the failure this
    // prevents is an action landing on a claim the coder was not talking about.
    let s = session();
    s = applyCommand(s, { kind: "act", action: "appeal" }).session;
    s = applyCommand(s, { kind: "next" }).session;
    s = applyCommand(s, { kind: "skip" }).session;

    const before = structuredClone(s);
    const step = applyCommand(s, { kind: "unrecognized", heard: "appeal the next one" });

    expect(step.session).toEqual(before);
    expect(step.session).toBe(s);
    expect(s).toEqual(before);
    expect(step.ended).toBeFalsy();
    expect(step.send).toBeUndefined();
  });

  it("re-prompts with the valid commands", () => {
    const step = applyCommand(session(), { kind: "unrecognized", heard: "hmm" });
    expect(step.prompt).toBe(WORKLIST_PROMPT);
    expect(step.prompt).toMatch(/next/);
    expect(step.prompt).toMatch(/why/);
    expect(step.prompt).toMatch(/appeal/);
    expect(step.prompt).toMatch(/skip/);
    expect(step.prompt).toMatch(/stop/);
  });

  it("does not read the misheard utterance back out loud", () => {
    // The microphone is live in a room with patients in it. Repeating whatever
    // was heard is the one thing worse than not understanding it.
    const step = applyCommand(session(), { kind: "unrecognized", heard: "Margaret Ellis date of birth" });
    expect(step.say).not.toMatch(/Margaret/i);
  });

  it("changes nothing even on a session that has already ended", () => {
    const closed = applyCommand(session(), { kind: "stop" }).session;
    const step = applyCommand(closed, { kind: "unrecognized", heard: "what" });
    expect(step.session).toBe(closed);
  });
});

describe("applyCommand — goto", () => {
  it("moves to the spoken one-based position", () => {
    const step = applyCommand(session(), { kind: "goto", index: 3 });
    expect(step.session.cursor).toBe(2);
    expect(step.say).toMatch(/^3 of 3\./);
  });

  it("does not move when the position is out of range, and says the real range", () => {
    // Rule 6. Clamping to an end obeys an instruction nobody gave; the coder
    // who asked for item twelve of a three-item list has the wrong worklist in
    // mind and only finds out if they are told the size of the real one.
    const s = applyCommand(session(), { kind: "next" }).session;
    for (const index of [0, -1, 4, 12]) {
      const step = applyCommand(s, { kind: "goto", index });
      expect(step.session.cursor, String(index)).toBe(1);
      expect(step.session).toEqual(s);
      expect(step.say, String(index)).toMatch(/3 items/);
      expect(step.prompt, String(index)).toBe("Say a number between 1 and 3.");
    }
  });

  it("gets the singular right on a one-item worklist", () => {
    const step = applyCommand(startWorklist([ITEMS[0]]), { kind: "goto", index: 5 });
    expect(step.say).toMatch(/is 1 item/);
    expect(step.prompt).toBe("Say a number between 1 and 1.");
  });
});

describe("applyCommand — the empty worklist", () => {
  it("ends immediately and says so rather than presenting nothing", () => {
    // Rule 7. Silence leaves the coder talking to a session with no items in it.
    for (const command of [
      { kind: "next" },
      { kind: "why" },
      { kind: "act", action: "appeal" },
      { kind: "where" },
      { kind: "stop" },
    ] as const) {
      const step = applyCommand(startWorklist([]), command);
      expect(step.ended, command.kind).toBe(true);
      expect(step.session.active, command.kind).toBe(false);
      expect(step.say, command.kind).toMatch(/worklist is empty/i);
      expect(step.send, command.kind).toBeUndefined();
    }
  });
});

describe("applyCommand — purity", () => {
  it("never mutates the session it was given", () => {
    const s = session();
    const before = structuredClone(s);
    for (const command of [
      { kind: "next" },
      { kind: "skip" },
      { kind: "act", action: "appeal" },
      { kind: "goto", index: 2 },
      { kind: "stop" },
      { kind: "where" },
      { kind: "why" },
    ] as const) {
      applyCommand(s, command);
      expect(s, command.kind).toEqual(before);
    }
  });
});

// ── announceItem ─────────────────────────────────────────────────────────────

describe("announceItem", () => {
  it("leads with the position and the claim, then the reason, then the money", () => {
    const said = announceItem(ITEMS[0], 1, 3);
    expect(said.indexOf("Claim")).toBeLessThan(said.indexOf("Denied"));
    expect(said.indexOf("Denied")).toBeLessThan(said.indexOf("Balance"));
    expect(said).toMatch(/^1 of 3\. Claim /);
  });

  it("spells a CARC code the spoken way", () => {
    // A bare "97" is read as "ninety seven" by every engine, and the general
    // literal expander deliberately leaves short integers alone because "5
    // units" is five units. The CARC label is the evidence these digits are a
    // code.
    const said = announceItem(ITEMS[0], 1, 3);
    expect(said).toMatch(/C A R C nine seven/);
    expect(said).not.toMatch(/\b97\b/);
    expect(said).not.toMatch(/ninety seven/);
  });

  it("spells a RARC code too", () => {
    const said = announceItem(
      { id: "x", claimId: "CLM-1", label: "L", reason: "RARC N130 consult plan benefit documents" },
      1,
      1,
    );
    expect(said).toMatch(/R A R C N one three zero/);
  });

  it("says a dollar amount the spoken way", () => {
    expect(announceItem(ITEMS[2], 3, 3)).toMatch(
      /Balance one thousand two hundred thirty four dollars and fifty six cents/,
    );
    expect(announceItem(ITEMS[0], 1, 3)).toMatch(/Balance four hundred twelve dollars and fifty cents/);
    expect(announceItem(ITEMS[1], 2, 3)).toMatch(/Balance ninety six dollars\b/);
  });

  it("keeps the minus on a credit balance", () => {
    // Written as "-$50.00" and left to the literal expander, the pattern would
    // match from the dollar sign and read a takeback out as a payment.
    const said = announceItem({ id: "x", claimId: "C1", label: "L", amount: -50 }, 1, 1);
    expect(said).toMatch(/Balance minus fifty dollars/);
  });

  it("spells the claim id instead of letting it be read as a number", () => {
    expect(announceItem(ITEMS[0], 1, 3)).toMatch(/Claim C L M dash one zero four two/);
    expect(announceItem(ITEMS[2], 3, 3)).toMatch(/Claim A two two one one/);
  });

  it("mentions a deadline only when it is close", () => {
    // A deadline on every item is noise, and noise on every item is what stops
    // the sentence being heard on the claim that is two days from the limit.
    expect(announceItem(ITEMS[0], 1, 3)).toMatch(/Due in 3 days/);
    expect(announceItem(ITEMS[2], 3, 3)).not.toMatch(/Due/); // 60 days out
    expect(announceItem({ ...ITEMS[0], dueInDays: DEADLINE_SOON_DAYS }, 1, 1)).toMatch(/Due in 7 days/);
    expect(announceItem({ ...ITEMS[0], dueInDays: DEADLINE_SOON_DAYS + 1 }, 1, 1)).not.toMatch(/Due/);
  });

  it("gets the deadline singular, today and overdue cases right", () => {
    expect(announceItem({ ...ITEMS[0], dueInDays: 1 }, 1, 1)).toMatch(/Due in 1 day\./);
    expect(announceItem({ ...ITEMS[0], dueInDays: 0 }, 1, 1)).toMatch(/Due today/);
    expect(announceItem({ ...ITEMS[0], dueInDays: -1 }, 1, 1)).toMatch(/deadline passed 1 day ago/);
    expect(announceItem({ ...ITEMS[0], dueInDays: -9 }, 1, 1)).toMatch(/deadline passed 9 days ago/);
  });

  it("says an overdue deadline however far past it is", () => {
    // It changes the action from "appeal" to "appeal with a timely-filing
    // argument", so distance is no reason to leave it out.
    expect(announceItem({ ...ITEMS[0], dueInDays: -400 }, 1, 1)).toMatch(/deadline passed 400 days ago/);
  });

  it("strips markdown and links out of a pasted reason", () => {
    const said = announceItem(
      {
        id: "x",
        claimId: "C1",
        label: "**Aetna**",
        reason: "See [the policy](https://example.com/lcd/L12345) — CARC 45 exceeds the fee schedule",
      },
      1,
      1,
    );
    expect(said).not.toMatch(/https?:/);
    expect(said).not.toMatch(/\*\*/);
    expect(said).toMatch(/C A R C four five/);
  });

  it("says there is no reason rather than leaving a gap", () => {
    const said = announceItem({ id: "x", claimId: "C1", label: "L" }, 1, 1);
    expect(said).toMatch(/No denial reason on record/);
    expect(said).not.toMatch(/Balance/);
  });

  it("never doubles a full stop between clauses", () => {
    expect(announceItem(ITEMS[0], 1, 3)).not.toMatch(/\.\s*\./);
    expect(announceItem(ITEMS[0], 1, 3).endsWith(".")).toBe(true);
  });
});

// ── describeWorklistState ────────────────────────────────────────────────────

describe("describeWorklistState", () => {
  it("says where the cursor is, what has been recorded, and what is ahead", () => {
    const s = applyCommand(session(), { kind: "next" }).session;
    expect(describeWorklistState(s)).toBe(
      "Item 2 of 3, claim C L M dash two zero eight seven. 0 worked, 0 skipped. 1 after this one.",
    );
  });

  it("counts the worked and skipped items", () => {
    let step = applyCommand(session(), { kind: "act", action: "appeal" });
    step = applyCommand(step.session, { kind: "next" });
    step = applyCommand(step.session, { kind: "skip" });
    expect(describeWorklistState(step.session)).toMatch(/1 worked, 1 skipped/);
  });

  it("says the worklist is empty when it is", () => {
    expect(describeWorklistState(startWorklist([]))).toBe("The worklist is empty.");
  });

  it("says the mode is off once the session has ended", () => {
    const closed = applyCommand(session(), { kind: "stop" }).session;
    expect(describeWorklistState(closed)).toMatch(/^Worklist mode is off/);
  });

  it("is what the where command answers with", () => {
    const s = applyCommand(session(), { kind: "next" }).session;
    const step = applyCommand(s, { kind: "where" });
    expect(step.say).toBe(describeWorklistState(s));
    expect(step.session.cursor).toBe(1);
  });
});

// ── speakIdentifier and the opening line ─────────────────────────────────────

describe("speakIdentifier", () => {
  it("spells letters and digits and keeps the separator", () => {
    // An id repeated back to a payer without its separator is a different id.
    expect(speakIdentifier("CLM-1042")).toBe("C L M dash one zero four two");
    expect(speakIdentifier("a2211")).toBe("A two two one one");
  });

  it("does not read the tail of a hyphenated id as a CPT modifier", () => {
    expect(speakIdentifier("CLM-25")).not.toMatch(/modifier/);
  });

  it("returns nothing for nothing", () => {
    expect(speakIdentifier("")).toBe("");
    expect(speakIdentifier("   ")).toBe("");
  });
});

describe("announceWorklistStart", () => {
  it("says how many there are and reads the first item", () => {
    expect(announceWorklistStart(session())).toBe(`3 items on the worklist. ${announceItem(ITEMS[0], 1, 3)}`);
  });

  it("gets the singular right", () => {
    expect(announceWorklistStart(startWorklist([ITEMS[0]]))).toMatch(/^1 item on the worklist\./);
  });

  it("says an empty worklist is empty", () => {
    expect(announceWorklistStart(startWorklist([]))).toMatch(/worklist is empty/i);
  });
});
