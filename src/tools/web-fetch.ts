import dns from "node:dns/promises";
import net from "node:net";
import { z } from "zod";
import { defineTool } from "./registry.js";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return true;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

// SSRF guard: the model chooses URLs and the gateway may sit near internal services.
export async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("only http(s) URLs allowed");
  if (net.isIP(url.hostname)) {
    if (isPrivateIp(url.hostname)) throw new Error("refusing to fetch private/loopback address");
    return;
  }
  const result = await dns.lookup(url.hostname, { all: true });
  for (const addr of result) {
    if (isPrivateIp(addr.address)) throw new Error("hostname resolves to a private address");
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/** Hosts whose content this project reaches through a real API instead of scraping. */
const API_ALTERNATIVES: Array<{ host: RegExp; advice: string }> = [
  {
    host: /(^|\.)cms\.gov$/i,
    advice:
      "cms.gov blocks automated page fetches. Use the coverage tools instead — coverage_search_national, coverage_search_local and sad_exclusion_check call the CMS Coverage API directly and return structured results.",
  },
  { host: /(^|\.)nih\.gov$/i, advice: "For ICD-10 lookups use icd10_search, which calls the NLM Clinical Tables API." },
  { host: /(^|\.)npiregistry\.cms\.hhs\.gov$/i, advice: "Use npi_lookup or npi_search, which call the NPPES API." },
];

/**
 * Turn an HTTP failure into something a model can act on.
 *
 * A bare "HTTP 403" reads as transient, so a model retries it, then retries a
 * different URL on the same host, and burns a conversation discovering that the
 * site simply does not serve robots. Saying so once, and naming the tool that
 * does have the data, ends it on the first attempt.
 */
export function httpFailure(status: number, url: URL): string {
  const alt = API_ALTERNATIVES.find((a) => a.host.test(url.hostname));
  const base = `HTTP ${status} from ${url.hostname}`;
  if (status === 403 || status === 401 || status === 406 || status === 429) {
    const why =
      status === 429
        ? "the host is rate-limiting this client"
        : "the host refuses automated access from a non-browser client";
    return `${base} — ${why}. This is the site's access decision, not a transient error; do not retry it or try to look like a browser.${alt ? ` ${alt.advice}` : " If the data exists behind a public API, use the tool that calls it."}`;
  }
  if (status === 404) return `${base} — the page does not exist. Check the URL rather than retrying.`;
  return base;
}

export async function fetchTextGuarded(rawUrl: string): Promise<string> {
  const url = new URL(rawUrl);
  await assertPublicHost(url);
  const res = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      "user-agent": "AetheraClaw/0.1 (+self-hosted RCM assistant)",
      // Some origins reject a request with no Accept/Accept-Language outright.
      // Sending them is ordinary HTTP politeness, not disguise: the User-Agent
      // above still says exactly what this is. Rotating it to impersonate a
      // browser would be evasion of a site's stated access decision, and a
      // healthcare compliance tool is the last place to build that in.
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(httpFailure(res.status, url));
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total > MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }
  }
  const body = Buffer.concat(chunks).toString("utf8");
  const type = res.headers.get("content-type") ?? "";
  return type.includes("html") ? stripHtml(body) : body;
}

export const webFetchTool = defineTool({
  name: "web_fetch",
  description:
    "Fetch a public URL (GET only) and return its text content. HTML is stripped to readable text; responses are capped at 2MB. Private/internal addresses are blocked.",
  schema: z.object({ url: z.string().describe("Absolute http(s) URL to fetch") }),
  execute: async (input) => {
    try {
      const text = await fetchTextGuarded(input.url);
      return { content: text.slice(0, 100_000) || "(empty response)" };
    } catch (err) {
      return { content: `fetch failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
});

// Fallback web search for non-Anthropic providers (Anthropic uses its server-side tool):
// DuckDuckGo HTML endpoint, no API key.
export const webSearchFallbackTool = defineTool({
  name: "web_search",
  description: "Search the web and return top result titles, URLs, and snippets.",
  schema: z.object({ query: z.string().describe("Search query") }),
  execute: async (input) => {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
      const text = await fetchTextGuarded(url);
      return { content: text.slice(0, 20_000) || "(no results)" };
    } catch (err) {
      return { content: `search failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
});
