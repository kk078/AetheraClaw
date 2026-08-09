// ── Wake word ────────────────────────────────────────────────────────────────
//
// Always-on mode listens for a phrase. Two things make that harder than a
// string compare, and both are why this is a module rather than an `includes`
// call in the page:
//
//   A recognizer mangles a wake phrase more than ordinary speech, because it
//   arrives with no sentence around it to constrain the language model. "Hey
//   Aethera" comes back as "hey ethera", "hey aetheria", "a theora". An exact
//   match means the wake word works for the person who chose it and nobody
//   else.
//
//   The opposite failure is worse. A phrase matched too loosely fires on
//   ordinary conversation, and in a clinic that means a microphone opening
//   itself during a consultation. So the tolerance is bounded, measured per
//   word, and never allowed to match on a single short token.
//
// The remainder matters as much as the match: someone says the wake word and
// their request in one breath, and asking them to repeat it is the difference
// between a feature and a toy.

/** Strip punctuation and collapse whitespace; wake matching is about sounds, not typography. */
export function normalizeHeard(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Levenshtein distance, capped.
 *
 * Capped because the answer is only ever compared against a small threshold —
 * computing an exact distance of 40 for two unrelated words costs the same as
 * computing 2, and this runs on every interim recognition result.
 */
export function distance(a: string, b: string, cap = 4): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > cap) return cap + 1;
    prev = row;
  }
  return prev[b.length];
}

/**
 * How far one word may be from its target and still count.
 *
 * Proportional to length, because one wrong letter in "hey" is a different word
 * and one wrong letter in "aethera" is the same word misheard. A flat threshold
 * would either reject every real mishearing or accept "hen" for "hey".
 */
export function wordTolerance(word: string): number {
  if (word.length <= 3) return 0;
  if (word.length <= 5) return 1;
  return 2;
}

export interface WakeMatch {
  matched: boolean;
  /** Whatever was said AFTER the wake phrase — the request, when there is one. */
  remainder: string;
  /** Total edit distance across the matched words; 0 is exact. */
  drift: number;
  why: string;
}

/**
 * Look for the wake phrase at the START of what was heard.
 *
 * Anchored deliberately. A wake word accepted anywhere in an utterance fires on
 * someone saying the assistant's name in conversation — "I asked Aethera about
 * that yesterday" — which in a clinic opens a microphone mid-consultation. The
 * cost is that the phrase has to lead, which is how people address an assistant
 * anyway.
 */
export function matchWake(heard: string, wake: string, opts: { maxDrift?: number } = {}): WakeMatch {
  const said = normalizeHeard(heard).split(" ").filter(Boolean);
  const want = normalizeHeard(wake).split(" ").filter(Boolean);

  if (want.length === 0) return { matched: false, remainder: "", drift: 0, why: "no wake word is configured" };
  // A one-syllable wake word cannot be matched safely: at any useful tolerance
  // it collides with ordinary speech, and at zero tolerance it never fires.
  if (want.length === 1 && want[0].length <= 3) {
    return { matched: false, remainder: "", drift: 0, why: `"${wake}" is too short to use as a wake word` };
  }
  if (said.length < want.length) return { matched: false, remainder: "", drift: 0, why: "nothing that could be the wake word" };

  let drift = 0;
  for (let i = 0; i < want.length; i++) {
    const d = distance(said[i], want[i]);
    if (d > wordTolerance(want[i])) {
      return { matched: false, remainder: "", drift: 0, why: `heard "${said.slice(0, want.length).join(" ")}"` };
    }
    drift += d;
  }

  const maxDrift = opts.maxDrift ?? want.reduce((sum, w) => sum + wordTolerance(w), 0);
  if (drift > maxDrift) {
    return { matched: false, remainder: "", drift, why: "too far from the wake word taken as a whole" };
  }

  return {
    matched: true,
    remainder: said.slice(want.length).join(" "),
    drift,
    why: drift === 0 ? "exact" : `matched with ${drift} character${drift === 1 ? "" : "s"} of drift`,
  };
}
