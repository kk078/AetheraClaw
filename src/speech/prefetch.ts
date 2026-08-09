import { snapCode, type CodeUniverse } from "./snap.js";

// ── Speculative lookup ───────────────────────────────────────────────────────
//
// Interim recognition results arrive while someone is still speaking. When one
// already contains a code that unambiguously exists, there is no reason to wait
// for the sentence to end before saying what it is.
//
// The safety of this rests entirely on WHAT is allowed to run speculatively.
// Nothing here calls a tool, reaches the network, or writes anything — it is a
// membership test against tables already in memory plus a description lookup
// from the same public CMS files the console already serves. A speculative
// action that could be wrong would have to be undone; a speculative READ that
// turns out to be about a code the speaker did not say is simply discarded.

export interface PrefetchHit {
  code: string;
  kind: "cpt" | "hcpcs" | "icd10";
  /** Absent when the installation has no description for it — never invented. */
  description?: string;
}

/** Code-shaped tokens only. Deliberately the same shapes the refiner validates. */
const CODE_TOKEN = /\b(?:\d{5}|[A-Z]\d{4}|[A-Z]\d{2}(?:\.\d{1,4})?)\b/g;

export interface PrefetchOptions {
  /** Injected so the pure path never touches the filesystem. */
  describe?: (code: string, kind: PrefetchHit["kind"]) => string | undefined;
  max?: number;
}

/**
 * The codes in a partial utterance that certainly exist.
 *
 * Only `exact` results are returned. A near miss is exactly the case that must
 * NOT be resolved speculatively: the speaker is mid-sentence, the recognizer
 * has not finished revising, and showing them a correction to a code they are
 * still in the middle of saying is worse than showing nothing. Corrections are
 * the final transcript's job, where a human is there to answer.
 */
export function prefetchCodes(text: string, universe: CodeUniverse, opts: PrefetchOptions = {}): PrefetchHit[] {
  const max = opts.max ?? 4;
  const seen = new Set<string>();
  const hits: PrefetchHit[] = [];

  CODE_TOKEN.lastIndex = 0;
  for (const match of text.toUpperCase().matchAll(CODE_TOKEN)) {
    const token = match[0];
    if (seen.has(token)) continue;
    seen.add(token);

    const result = snapCode(token, universe);
    if (result.status !== "exact") continue;

    const description = opts.describe?.(result.code, result.kind);
    hits.push(description ? { code: result.code, kind: result.kind, description } : { code: result.code, kind: result.kind });
    if (hits.length >= max) break;
  }
  return hits;
}

/** One short line for the composer hint. Not spoken — the speaker is still talking. */
export function describePrefetch(hits: PrefetchHit[]): string {
  if (hits.length === 0) return "";
  return hits.map((h) => (h.description ? `${h.code} — ${h.description}` : `${h.code} (valid ${h.kind.toUpperCase()})`)).join(" · ");
}
