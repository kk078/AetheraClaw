import type { ToolSpec } from "../providers/types.js";

// ── Choosing which tools the model is actually shown ─────────────────────────
//
// 163 of 227 tools are deferred behind tool_search on the default provider,
// because a model that takes 64 definitions per request cannot be handed 227.
// That part is unavoidable. What was avoidable is WHICH 64 — until now the
// direct set was whatever came first in registration order, so a question about
// a denial could arrive with the denial tools deferred and the wRVU tools
// loaded.
//
// The failure that produces is specific and bad: a model asked about CARC 197
// looks at its tools, does not see denial_explain, and answers from memory —
// fluently, confidently, and from exactly the recall this product exists to
// replace. It does not say "I could search for a tool"; it just answers. The
// deferral is invisible to the user and to the model's own sense of certainty.
//
// So the direct set is now chosen for the QUESTION. This is a ranker, not a
// classifier: it never removes a tool from reach — everything still resolves
// through tool_search — it only decides what gets shipped without asking.
//
// Deliberately rules rather than a model call. A pre-turn classifier round-trip
// adds latency to every message and a second thing that can be wrong, and the
// signal here is mostly lexical: the words people use for denials are the words
// in the denial tools' descriptions.

export interface RoutedTool {
  name: string;
  score: number;
}

/**
 * Domain vocabulary that does not appear in the tool names.
 *
 * A biller says "CARC 197" and "timely filing"; the tools are called
 * `denial_explain` and `filing_deadline_check`. Without a bridge, lexical
 * matching finds neither. Each entry is a phrase somebody actually types mapped
 * to the substring that identifies the tools that answer it.
 */
const DOMAIN_HINTS: Array<{ pattern: RegExp; tools: string[] }> = [
  { pattern: /\b(carc|rarc|denial|denied|rejection|reason code)\b/i, tools: ["denial", "appeal", "carc"] },
  { pattern: /\b(appeal|reconsideration|redetermination)\b/i, tools: ["appeal", "denial"] },
  { pattern: /\b(timely filing|filing deadline|late claim|past the deadline)\b/i, tools: ["filing", "deadline", "timely"] },
  { pattern: /\b(eligib|coverage|benefit|270|271|active insurance)\b/i, tools: ["eligib", "coverage", "benefit"] },
  { pattern: /\b(ncci|bundl|mue|unit limit|edit pair|modifier 59)\b/i, tools: ["ncci", "mue", "bundl", "modifier"] },
  { pattern: /\b(e\/m|em level|992\d\d|documentation level|downcod)\b/i, tools: ["em_", "downcod", "level"] },
  { pattern: /\b(remit|835|era|payment posting|paid amount|allowed amount)\b/i, tools: ["era", "remit", "835", "post"] },
  { pattern: /\b(837|submit|clearinghouse|claim file|scrub)\b/i, tools: ["submit", "scrub", "837", "claim"] },
  { pattern: /\b(276|277|claim status|acknowledg)\b/i, tools: ["status", "277", "ack"] },
  { pattern: /\b(underpay|variance|contracted rate|fee schedule|expected)\b/i, tools: ["variance", "rate", "fee", "underpay"] },
  { pattern: /\b(icd|diagnosis|dx code)\b/i, tools: ["icd", "diagnos"] },
  { pattern: /\b(cpt|hcpcs|procedure code)\b/i, tools: ["cpt", "hcpcs", "code"] },
  { pattern: /\b(prior auth|preauth|pa |authorization required)\b/i, tools: ["auth", "pa_", "dtr", "crd"] },
  { pattern: /\b(cob|secondary|coordination of benefits|msp)\b/i, tools: ["cob", "secondary", "msp"] },
  { pattern: /\b(forecast|cash|projection|scenario)\b/i, tools: ["forecast", "cash", "simul"] },
  { pattern: /\b(kpi|days in a\/?r|dashboard|collection rate|metrics)\b/i, tools: ["kpi", "analytic", "report"] },
  { pattern: /\b(worklist|queue|what should i work|priorit)\b/i, tools: ["worklist", "priorit"] },
  { pattern: /\b(audit|integrity|chain|tamper)\b/i, tools: ["audit", "integrity"] },
  { pattern: /\b(email|inbox|mail|correspondence|letter)\b/i, tools: ["email", "mail"] },
  { pattern: /\b(portal|availity|payer website|log ?in)\b/i, tools: ["portal", "browser"] },
  { pattern: /\b(document|upload|pdf|attachment|scanned)\b/i, tools: ["document", "archive", "ocr"] },
  { pattern: /\b(cdi|query|clinical documentation)\b/i, tools: ["cdi", "query"] },
  { pattern: /\b(ncd|lcd|coverage policy|medicare policy|article)\b/i, tools: ["ncd", "lcd", "coverage", "policy"] },
];

/** Words too common to carry signal. Matching on these ranks everything equally. */
const STOP = new Set([
  "the", "a", "an", "and", "or", "for", "with", "this", "that", "what", "which", "how", "why", "when",
  "is", "are", "was", "were", "do", "does", "did", "can", "should", "would", "i", "me", "my", "we",
  "it", "to", "of", "in", "on", "at", "by", "from", "about", "please", "tell", "show", "give", "need",
  "claim", "claims", "code", "codes", "patient", "payer",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9/]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/**
 * Score every tool against one message.
 *
 * Three signals, weighted by how much each is worth:
 *
 *   6  a domain hint fired and this tool's name contains the mapped substring.
 *      The strongest signal, because the mapping was written by someone who
 *      knows both vocabularies.
 *   3  a message token appears in the tool NAME. Names are terse and chosen, so
 *      a hit is rarely accidental.
 *   1  a message token appears in the DESCRIPTION. Descriptions are prose and
 *      share words with everything, so this only breaks ties.
 *
 * Pure and deterministic. Two identical messages must produce the same tool set
 * or the same question answered twice gets different capability, which is the
 * kind of inconsistency nobody can debug.
 */
export function scoreTools(message: string, specs: ToolSpec[]): RoutedTool[] {
  const words = tokens(message);
  const hinted = new Set<string>();
  for (const h of DOMAIN_HINTS) {
    if (h.pattern.test(message)) for (const t of h.tools) hinted.add(t.toLowerCase());
  }

  const scored = specs.map((s) => {
    const name = s.name.toLowerCase();
    const description = (s.description ?? "").toLowerCase();
    let score = 0;
    for (const h of hinted) if (name.includes(h)) score += 6;
    for (const w of words) {
      if (name.includes(w)) score += 3;
      else if (description.includes(w)) score += 1;
    }
    return { name: s.name, score };
  });

  // Sorted by score, then by name — the tiebreak matters. Sorting by score
  // alone leaves equal-scoring tools in whatever order the registry happened to
  // produce, which reintroduces the arbitrariness this function exists to
  // remove.
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export interface RouteOptions {
  /** The user's message. Without one there is nothing to rank against. */
  message: string;
  /** Names the session pinned. Always loaded, ahead of anything scored. */
  pinned?: string[];
  /** How many scored tools to promote. */
  take?: number;
}

/**
 * The tools this turn should have loaded directly, in priority order.
 *
 * Returns NAMES rather than specs so the caller decides what to do with them —
 * selectTools has its own rules about the base set and the provider's cap, and
 * this function should not be making those decisions from a distance.
 *
 * A zero score is not promoted. Loading ten unrelated tools because the message
 * was "hello" spends the budget on noise, and the base set already covers the
 * general case.
 */
export function routeTools(specs: ToolSpec[], opts: RouteOptions): string[] {
  const take = opts.take ?? 10;
  const pinned = (opts.pinned ?? []).filter((n) => specs.some((s) => s.name === n));
  const seen = new Set(pinned);
  const promoted = scoreTools(opts.message, specs)
    .filter((t) => t.score > 0 && !seen.has(t.name))
    .slice(0, take)
    .map((t) => t.name);
  return [...pinned, ...promoted];
}
