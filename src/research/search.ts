import { stripHtml } from "../tools/web-fetch.js";
import { DEFAULT_TIER_ORDER, hostOf, registrableDomain, sourceTier, tierRank, type Tier } from "./credibility.js";

// ── Search-result parsing ────────────────────────────────────────────────────
// The existing web_search tool hands the model the DuckDuckGo results page as
// stripped text and hopes it reads the URLs out correctly. It mostly does, and
// "mostly" is the problem: the URLs on that page are not the destinations. Every
// result link is wrapped in DDG's own redirector,
//
//   //duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.cms.gov%2F…&rut=…
//
// so a model reading the page either cites duckduckgo.com or reconstructs the
// destination by eye. Unwrapping it is a parse, not a judgement call, which
// makes it something a pure function should do once rather than something a
// model should do per result.

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 1-based position in the engine's own ordering, preserved through dedupe and re-ranking. */
  rank: number;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/** Named, decimal and hex character references. HTML tags are left alone — that is `stripHtml`'s job. */
export function decodeEntities(text: string): string {
  return (text ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => codePoint(Number(dec)))
    .replace(/&([a-z][a-z0-9]*);/gi, (whole: string, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

function codePoint(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return "";
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}

/** Tag text → readable text: strip markup first, then resolve what is left. */
function textOf(html: string): string {
  return decodeEntities(stripHtml(html)).replace(/\s+/g, " ").trim();
}

const TRACKING_PARAM = /^(?:utm_[a-z0-9_]*|fbclid|gclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|ref_src)$/i;

/**
 * Unwrap DuckDuckGo's redirector to the real destination.
 *
 * Anything that is not a redirect is returned as-is (with entities resolved and
 * a protocol-relative href given a scheme), so this is safe to call on every
 * href without first testing what kind it is.
 */
export function unwrapDdgRedirect(href: string): string {
  const decoded = decodeEntities((href ?? "").trim());
  const wrapped = /[?&]uddg=([^&#]+)/.exec(decoded);
  if (wrapped) {
    try {
      const target = decodeURIComponent(wrapped[1]);
      return target.startsWith("//") ? `https:${target}` : target;
    } catch {
      // A malformed percent-escape means the wrapper is unusable; fall through
      // and return the redirect URL rather than a half-decoded guess.
    }
  }
  return decoded.startsWith("//") ? `https:${decoded}` : decoded;
}

function attr(attrs: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  if (!m) return "";
  return m[1] ?? m[2] ?? m[3] ?? "";
}

function hasClass(attrs: string, className: string): boolean {
  return attr(attrs, "class").split(/\s+/).includes(className);
}

interface Located {
  at: number;
  attrs: string;
  inner: string;
}

/**
 * Content of an element, counting nested tags of the same name.
 *
 * A non-greedy `<div>…</div>` regex looks like it does this and does not: it
 * matches the outer wrapper against the first inner `</div>`, swallowing every
 * result on the page in one match. Depth counting is the smallest thing that is
 * actually correct here.
 */
function innerHtml(html: string, tag: string, from: number): string {
  const scan = new RegExp(`</?${tag}\\b[^>]*>`, "gi");
  scan.lastIndex = from;
  let depth = 1;
  for (let m = scan.exec(html); m !== null; m = scan.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(from, m.index);
  }
  return html.slice(from);
}

const OPEN_TAG = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;

function collect(html: string, className: string, tags?: Set<string>): Located[] {
  const out: Located[] = [];
  OPEN_TAG.lastIndex = 0;
  for (let m = OPEN_TAG.exec(html); m !== null; m = OPEN_TAG.exec(html)) {
    const tag = m[1].toLowerCase();
    if (tags && !tags.has(tag)) continue;
    if (!hasClass(m[2], className)) continue;
    out.push({ at: m.index, attrs: m[2], inner: innerHtml(html, tag, OPEN_TAG.lastIndex) });
  }
  return out;
}

/**
 * Parse the html.duckduckgo.com results page.
 *
 * Falls back to `parseResultsFromText` when no result markup is present, which
 * is not a hypothetical: `fetchTextGuarded` strips HTML from any text/html
 * response before returning it, and that guard is worth more than raw markup is.
 * So this copes with both forms and says so rather than returning nothing and
 * letting the caller conclude the search found no results.
 */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const source = html ?? "";
  const links = collect(source, "result__a", new Set(["a"]));
  if (links.length === 0) return parseResultsFromText(source);
  const snippets = collect(source, "result__snippet");

  const results: SearchResult[] = [];
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const nextAt = links[i + 1]?.at ?? Number.MAX_SAFE_INTEGER;
    const url = unwrapDdgRedirect(attr(link.attrs, "href"));
    if (url.length === 0 || !/^https?:/i.test(url)) continue;
    // DDG's own pages (the redirector itself, "more results") are navigation, not answers.
    if (registrableDomain(hostOf(url)) === "duckduckgo.com") continue;
    const snippet = snippets.find((s) => s.at > link.at && s.at < nextAt);
    results.push({
      title: textOf(link.inner),
      url,
      snippet: snippet ? textOf(snippet.inner) : "",
      rank: results.length + 1,
    });
  }
  return results;
}

const BARE_URL = /\bhttps?:\/\/[^\s"'<>)\]]+|\bwww\.[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^\s"'<>)\]]*)?/gi;

/**
 * Best-effort recovery of results from a results page whose markup is gone.
 *
 * Titles are unavailable in this form — the host stands in for one — so a caller
 * should treat these as leads rather than as cited sources.
 */
export function parseResultsFromText(text: string): SearchResult[] {
  const flat = decodeEntities(text ?? "").replace(/\s+/g, " ");
  const out: SearchResult[] = [];
  for (let m = BARE_URL.exec(flat); m !== null; m = BARE_URL.exec(flat)) {
    const raw = m[0].replace(/[.,;:]+$/, "");
    const url = raw.toLowerCase().startsWith("www.") ? `https://${raw}` : raw;
    const host = hostOf(url);
    if (host.length === 0) continue;
    const domain = registrableDomain(host);
    if (domain === "duckduckgo.com") continue;
    out.push({
      title: host,
      url,
      snippet: flat.slice(m.index + m[0].length, m.index + m[0].length + 200).trim(),
      rank: out.length + 1,
    });
  }
  BARE_URL.lastIndex = 0;
  return out;
}

// ── Dedupe and ranking ───────────────────────────────────────────────────────

/**
 * Comparison key for "the same page".
 *
 * Scheme, `www.`, a trailing slash and campaign parameters all vary between two
 * links to one document — a payer's own PDF routinely arrives once bare and once
 * with `?utm_source=newsletter`. Fetching both costs a request and, worse, makes
 * a claim look corroborated by two sources when it has one.
 */
export function normalizeUrl(raw: string): string {
  const input = (raw ?? "").trim();
  if (input.length === 0) return "";
  let parsed: URL;
  try {
    parsed = new URL(input.startsWith("//") ? `https:${input}` : input);
  } catch {
    return input.toLowerCase().replace(/\/+$/, "");
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.replace(/\/+$/, "");
  const query = parsed.searchParams.toString();
  return `${host}${path}${query.length > 0 ? `?${query}` : ""}`;
}

/** First occurrence wins, so the engine's own ordering survives dedupe. */
export function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const key = normalizeUrl(r.url);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Order by source tier, then by the engine's original rank.
 *
 * `tiers` is the tier priority, so a caller researching one payer's own policy
 * can pass ["payer", "primary", …] and get that payer's site first. Rank breaks
 * ties within a tier because relevance inside a tier is still the engine's job.
 */
export function rankResults(results: SearchResult[], tiers: Tier[] = DEFAULT_TIER_ORDER): SearchResult[] {
  return [...results].sort((a, b) => {
    const ta = tierRank(sourceTier(a.url).tier, tiers);
    const tb = tierRank(sourceTier(b.url).tier, tiers);
    return ta - tb || a.rank - b.rank;
  });
}

function domainMatches(url: string, pattern: string): boolean {
  const wanted = pattern.trim().toLowerCase().replace(/^\*?\./, "").replace(/\/.*$/, "");
  if (wanted.length === 0) return false;
  const host = hostOf(url);
  return host === wanted || host.endsWith(`.${wanted}`);
}

/** Include wins the question "is this in scope"; exclude wins the question "is this out". */
export function filterByDomains(
  results: SearchResult[],
  opts: { include?: string[]; exclude?: string[] } = {},
): SearchResult[] {
  const include = (opts.include ?? []).filter((d) => d.trim().length > 0);
  const exclude = (opts.exclude ?? []).filter((d) => d.trim().length > 0);
  return results.filter((r) => {
    if (exclude.some((d) => domainMatches(r.url, d))) return false;
    if (include.length > 0 && !include.some((d) => domainMatches(r.url, d))) return false;
    return true;
  });
}

/** The DDG endpoint this project already uses for its fallback web search. */
export function duckDuckGoUrl(query: string): string {
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}
