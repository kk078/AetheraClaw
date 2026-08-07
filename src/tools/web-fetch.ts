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

export async function fetchTextGuarded(rawUrl: string): Promise<string> {
  const url = new URL(rawUrl);
  await assertPublicHost(url);
  const res = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": "AetheraClaw/0.1 (+self-hosted RCM assistant)" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.hostname}`);
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
