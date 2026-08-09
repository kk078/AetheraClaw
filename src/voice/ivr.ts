// ── IVR navigation ───────────────────────────────────────────────────────────
// A payer phone tree is a state machine nobody documents and everybody changes.
// The learned map is therefore the interesting artefact: which prompt led to
// which digit, and when that stopped being true.
//
// The governing rule is that a wrong digit is expensive and silent. Press the
// wrong option and the call does not fail — it succeeds into the wrong queue,
// waits twenty minutes, and reaches somebody who cannot help. So this module
// never guesses. A prompt that does not match confidently returns no digit at
// all, and the caller escalates to an operator or hangs up and tells a person,
// which are both better outcomes than a confident wrong turn.

export interface IvrOption {
  /** The digit to press. "0" conventionally reaches an operator. */
  digit: string;
  /** Phrases that identify this option in the spoken menu, lower-cased. */
  phrases: string[];
  /** What this option is for, in the practice's words. */
  intent: string;
}

export interface IvrMap {
  payer: string;
  /** Free-text label for the menu level, e.g. "main menu" or "claims submenu". */
  level: string;
  options: IvrOption[];
  /** When this map was last confirmed to match a live prompt. */
  lastConfirmedAt: number;
  /** Consecutive times a live prompt failed to match this map. */
  misses: number;
}

/** Consecutive misses after which a map is treated as stale rather than trusted. */
export const STALE_AFTER_MISSES = 2;
/** Minimum score a match needs before a digit is pressed. */
export const MIN_MATCH_SCORE = 0.5;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How well a phrase matches what the menu actually said.
 *
 * Word-overlap on the phrase's own words: every word of "claim status" has to
 * appear for a full score. Substring matching would let "status" alone match
 * "claim status", "enrollment status" and "authorization status" equally, which
 * is exactly the confusion that sends a call to the wrong department.
 */
export function phraseScore(phrase: string, prompt: string): number {
  const words = normalize(phrase).split(" ").filter(Boolean);
  if (words.length === 0) return 0;
  const heard = new Set(normalize(prompt).split(" ").filter(Boolean));
  const hits = words.filter((w) => heard.has(w)).length;
  return hits / words.length;
}

export interface IvrChoice {
  digit: string;
  intent: string;
  score: number;
  /** Why this option and not another — printed, because a wrong turn is silent. */
  reason: string;
}

export interface IvrDecision {
  choice: IvrChoice | null;
  /** Runners-up, so a near-tie is visible rather than resolved silently. */
  alternatives: IvrChoice[];
  stale: boolean;
  /**
   * Whether the MENU still matched the map — which is a different question from
   * whether a digit was chosen, and the only one that says anything about the
   * tree having changed.
   *
   * "You did not say what you wanted" and "this map has no option for pharmacy"
   * are both refusals, and neither is evidence the payer changed their phone
   * system. Counting them as misses marked a perfectly good map stale after two
   * ordinary calls.
   */
  promptMatched: boolean;
  advice: string;
}

/**
 * Choose a digit for a spoken menu prompt.
 *
 * The thing that makes this harder than it looks: a real IVR reads the WHOLE
 * menu in one breath. "For eligibility press 1, for claim status press 2, for
 * prior authorization press 3" contains every option's phrases at once, so
 * scoring options by how well they match the prompt makes all of them win.
 *
 * So the intent decides and the prompt confirms. The caller says what it is
 * trying to reach; the map says which digit that is; and the prompt is checked
 * to confirm the menu still offers it. A menu that no longer mentions the thing
 * being asked for is a tree that changed, which is a miss rather than a guess.
 */
export function chooseOption(prompt: string, map: IvrMap, wantedIntent = ""): IvrDecision {
  const stale = map.misses >= STALE_AFTER_MISSES;

  const presence = (option: IvrOption): number => Math.max(0, ...option.phrases.map((p) => phraseScore(p, prompt)));
  const asChoice = (option: IvrOption, score: number, reason: string): IvrChoice => ({
    digit: option.digit,
    intent: option.intent,
    score,
    reason,
  });

  if (stale) {
    return {
      choice: null,
      alternatives: map.options.map((o) => asChoice(o, presence(o), "")).slice(0, 3),
      stale: true,
      promptMatched: true,
      advice: `This menu map has missed ${map.misses} time(s) in a row, so the tree has probably changed. Pressing a digit from a stale map lands the call in the wrong queue — and the call does not fail, it just wastes the hold. Ask for an operator, then re-record the menu with ivr_map_set.`,
    };
  }

  if (wantedIntent) {
    const wanted = normalize(wantedIntent);
    const matches = map.options
      .map((option) => ({ option, intentScore: phraseScore(wanted, option.intent) }))
      .filter((m) => m.intentScore >= MIN_MATCH_SCORE)
      .sort((a, b) => b.intentScore - a.intentScore);

    if (matches.length === 0) {
      return {
        choice: null,
        alternatives: map.options.map((o) => asChoice(o, presence(o), o.intent)).slice(0, 3),
        stale: false,
        promptMatched: true,
        advice: `This map has no option for "${wantedIntent}". It knows: ${map.options.map((o) => o.intent).join(", ")}. Press 0 for an operator rather than picking the nearest-sounding one.`,
      };
    }
    if (matches.length > 1 && matches[0].intentScore - matches[1].intentScore < 0.15) {
      return {
        choice: null,
        alternatives: matches.slice(0, 3).map((m) => asChoice(m.option, m.intentScore, m.option.intent)),
        stale: false,
        promptMatched: true,
        advice: `"${matches[0].option.intent}" and "${matches[1].option.intent}" both answer to "${wantedIntent}". That is a coin flip, not a decision — say which one, or press 0.`,
      };
    }

    const winner = matches[0].option;
    const heard = presence(winner);
    if (heard < MIN_MATCH_SCORE) {
      return {
        choice: null,
        alternatives: map.options.map((o) => asChoice(o, presence(o), o.intent)).slice(0, 3),
        stale: false,
        promptMatched: false,
        advice: `The map puts "${winner.intent}" on ${winner.digit}, but the menu that just played does not mention it (${(heard * 100).toFixed(0)}% match). The tree has probably changed. Press 0 and re-record the menu rather than pressing a digit that used to be right.`,
      };
    }
    return {
      choice: asChoice(
        winner,
        heard,
        `Asked for "${wantedIntent}", the map puts that on ${winner.digit}, and the menu still offers it (${(heard * 100).toFixed(0)}% of the phrase heard).`,
      ),
      alternatives: [],
      stale: false,
      promptMatched: true,
      advice: "",
    };
  }

  // No intent given. A full menu offers several things, and picking one of them
  // unprompted is guessing about what the caller wanted.
  const offered = map.options
    .map((option) => ({ option, score: presence(option) }))
    .filter((o) => o.score >= MIN_MATCH_SCORE)
    .sort((a, b) => b.score - a.score);

  if (offered.length === 0) {
    return {
      choice: null,
      alternatives: map.options.map((o) => asChoice(o, presence(o), o.intent)).slice(0, 3),
      stale: false,
      promptMatched: false,
      advice: `Nothing in the map matched what the menu said. Do not guess — a wrong digit succeeds into the wrong department. Press 0 for an operator, or have a person listen to the menu once and re-record it.`,
    };
  }
  if (offered.length > 1) {
    return {
      choice: null,
      alternatives: offered.slice(0, 3).map((o) => asChoice(o.option, o.score, o.option.intent)),
      stale: false,
      promptMatched: true,
      advice: `This menu offers ${offered.length} of the mapped options (${offered.map((o) => o.option.intent).join(", ")}). Say which one is wanted — choosing for you would be guessing at the reason for the call.`,
    };
  }

  const only = offered[0];
  return {
    choice: asChoice(only.option, only.score, `"${only.option.intent}" was the only mapped option this menu offered.`),
    alternatives: [],
    stale: false,
    promptMatched: true,
    advice: "",
  };
}

/** Record whether a live prompt matched, so a drifting tree announces itself. */
export function recordOutcome(map: IvrMap, matched: boolean, now: number): IvrMap {
  return matched
    ? { ...map, misses: 0, lastConfirmedAt: now }
    : { ...map, misses: map.misses + 1 };
}

// ── Entering data into a tree ────────────────────────────────────────────────

export type DtmfField = "member_id" | "claim_number" | "npi" | "tax_id" | "date_of_birth" | "menu_digit";

export interface DtmfVerdict {
  allowed: boolean;
  reason: string;
}

/**
 * What the model is allowed to send as DTMF.
 *
 * Only menu digits. Everything else — the member ID, the date of birth, the tax
 * ID — is looked up and typed by the tool layer from the claim being worked, the
 * same way portal credentials are. The reason is the same too: a value the model
 * produced is a value that can be wrong or invented, and an IVR will accept a
 * plausible member ID belonging to someone else without comment.
 */
export function checkDtmf(field: DtmfField, digits: string): DtmfVerdict {
  if (field === "menu_digit") {
    if (!/^[0-9*#]$/.test(digits)) {
      return { allowed: false, reason: `"${digits}" is not a single menu key. Send one of 0-9, * or #.` };
    }
    return { allowed: true, reason: "" };
  }
  return {
    allowed: false,
    reason: `${field.replace(/_/g, " ")} is not something to be typed from a chat turn. The tool layer reads it from the claim on the call and enters it directly — a value produced here could be plausible and belong to somebody else, and an IVR would accept it without comment.`,
  };
}

export function renderMap(map: IvrMap): string {
  const lines = [
    `${map.payer} — ${map.level}${map.misses >= STALE_AFTER_MISSES ? "  ** STALE **" : ""}`,
    map.lastConfirmedAt
      ? `  last confirmed ${new Date(map.lastConfirmedAt).toISOString().slice(0, 10)}${map.misses ? `, ${map.misses} miss(es) since` : ""}`
      : "  never confirmed against a live call",
  ];
  for (const o of map.options) {
    lines.push(`  press ${o.digit} — ${o.intent}   [${o.phrases.join(" | ")}]`);
  }
  return lines.join("\n");
}
