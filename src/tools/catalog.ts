import type { ToolSpec } from "../providers/types.js";

// ── Tool catalogue ───────────────────────────────────────────────────────────
// Sending every tool definition on every turn does not scale past a provider
// that caches them. 174 definitions are ~145 KB, about 37,000 tokens, and only
// Anthropic charges for that once — everywhere else it is paid on every turn
// and competes with the conversation for the context window.
//
// So the definitions stop being the delivery mechanism. A handful of meta-tools
// go on the wire, the catalogue stays here, and the model searches it. Every
// tool remains reachable; what changes is that the model asks for the ones it
// needs instead of being handed all of them.
//
// The cost is honest and worth stating: discovery becomes a step the model has
// to take, and a tool it cannot find is a tool it cannot use — which is worse
// than absence, because the catalogue says it exists. Search quality is the
// whole game, so it is a scored, testable, pure function rather than a
// substring match.

export interface CatalogEntry {
  name: string;
  description: string;
  /** First sentence — enough to choose by, without the full description. */
  summary: string;
}

function firstSentence(text: string): string {
  const at = text.search(/\.\s/);
  const head = at > 0 ? text.slice(0, at + 1) : text;
  return head.length > 200 ? `${head.slice(0, 197)}...` : head;
}

export function buildCatalog(specs: ToolSpec[]): CatalogEntry[] {
  return specs.map((s) => ({ name: s.name, description: s.description, summary: firstSentence(s.description) }));
}

/** Words too common in this domain to discriminate between tools. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "by", "is", "it", "with", "from", "that", "this",
  "what", "which", "how", "when", "do", "does", "can", "i", "my", "we", "you", "claim", "claims", "code", "codes",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export interface ScoredEntry extends CatalogEntry {
  score: number;
}

/**
 * Rank the catalogue against a query.
 *
 * A name match outweighs a description match by a lot: tool names in this
 * project are the domain term itself (`timely_filing_check`, `era_parse_835`),
 * so a query hitting a name is almost always the tool wanted, while a
 * description hit is frequently incidental — half the descriptions mention
 * "denial" somewhere.
 */
export function searchCatalog(catalog: CatalogEntry[], query: string, limit = 12): ScoredEntry[] {
  const terms = tokenize(query);
  if (terms.length === 0) return catalog.slice(0, limit).map((e) => ({ ...e, score: 0 }));

  const scored = catalog.map((entry) => {
    const nameTokens = new Set(tokenize(entry.name));
    const descTokens = new Set(tokenize(entry.description));
    const name = entry.name.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (nameTokens.has(term)) score += 10;
      else if (name.includes(term)) score += 6;
      if (descTokens.has(term)) score += 2;
    }
    // Reward covering more of the query rather than hitting one term hard, so
    // "timely filing deadline" beats a tool that only matches "deadline".
    const covered = terms.filter((t) => nameTokens.has(t) || name.includes(t) || descTokens.has(t)).length;
    score += covered * 3;
    return { ...entry, score };
  });

  return scored
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function renderSearch(results: ScoredEntry[], query: string, total: number): string {
  if (results.length === 0) {
    return [
      `Nothing in the ${total} available tools matches "${query}".`,
      "Try the domain word rather than the action — 'remittance' not 'read the payment file', 'timely filing' not 'is it too late'. tool_search with an empty query lists everything.",
    ].join("\n");
  }
  return [
    `${results.length} of ${total} tools match "${query}":`,
    "",
    ...results.map((r) => `  ${r.name}\n      ${r.summary}`),
    "",
    "Call tool_describe with the names you want to see full input schemas, then tool_invoke to run one. tool_invoke validates against the real schema either way, so a wrong guess is rejected rather than silently mis-run.",
  ].join("\n");
}

export function renderDescribe(specs: ToolSpec[], missing: string[]): string {
  const parts: string[] = [];
  for (const spec of specs) {
    parts.push(`## ${spec.name}\n${spec.description}\n\nInput schema:\n${JSON.stringify(spec.inputSchema, null, 2)}`);
  }
  if (missing.length > 0) {
    parts.push(`Not found: ${missing.join(", ")}. Use tool_search to find the right name.`);
  }
  return parts.join("\n\n");
}
