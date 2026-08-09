// ── Finding a local model server ─────────────────────────────────────────────
// "Use a local LLM if one is available" is a question the tool can answer for
// itself: local servers listen on well-known ports and every one of them serves
// a model list over HTTP. Asking the user to know their own port number, when
// the answer is four HTTP requests away, is making them do the machine's job.
//
// All four speak the OpenAI-compatible chat API, which is why the existing
// OpenAIProvider drives every one of them with nothing but a base URL — no new
// adapter, no new dependency.

export interface LocalServer {
  /** What is running: "Ollama", "LM Studio", … */
  name: string;
  /** The OpenAI-compatible base URL to configure. */
  baseUrl: string;
  /** Models the server reports. Empty means it answered but has nothing pulled. */
  models: string[];
  /** Set when the port answered but the response made no sense. */
  note?: string;
}

export interface Candidate {
  name: string;
  port: number;
  /** Path that lists models, relative to the origin. */
  modelsPath: string;
  baseUrlPath: string;
}

/**
 * The servers worth probing, in the order a user is likeliest to have them.
 *
 * Ollama first because it is the one this project already supports natively and
 * the one the config names. The rest are here because they all present the same
 * API, so supporting them costs a row in this table rather than a provider.
 */
export const LOCAL_CANDIDATES: Candidate[] = [
  { name: "Ollama", port: 11434, modelsPath: "/v1/models", baseUrlPath: "/v1" },
  { name: "LM Studio", port: 1234, modelsPath: "/v1/models", baseUrlPath: "/v1" },
  { name: "llama.cpp", port: 8080, modelsPath: "/v1/models", baseUrlPath: "/v1" },
  { name: "vLLM", port: 8000, modelsPath: "/v1/models", baseUrlPath: "/v1" },
  { name: "text-generation-webui", port: 5000, modelsPath: "/v1/models", baseUrlPath: "/v1" },
];

/**
 * Model ids out of an OpenAI-style `/v1/models` body.
 *
 * Pure, so the shape handling is testable without a server: the response is
 * `{data: [{id}]}` everywhere, but llama.cpp has shipped builds that return a
 * bare array, and a reader that assumes one shape reports a live server as
 * having no models.
 */
export function parseModelList(body: unknown): string[] {
  const rows = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown })?.data) ? (body as { data: unknown[] }).data : [];
  return rows
    .map((r) => (typeof r === "string" ? r : typeof (r as { id?: unknown })?.id === "string" ? (r as { id: string }).id : ""))
    .filter(Boolean);
}

/** How long to wait for a local port. Local means fast; a slow answer is a wrong port. */
export const PROBE_TIMEOUT_MS = 1200;

async function probe(candidate: Candidate, host: string): Promise<LocalServer | null> {
  const origin = `http://${host}:${candidate.port}`;
  try {
    const res = await fetch(`${origin}${candidate.modelsPath}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const models = parseModelList(body);
    return {
      name: candidate.name,
      baseUrl: `${origin}${candidate.baseUrlPath}`,
      models,
      ...(models.length === 0 ? { note: "Answered, but reports no models — pull or load one first." } : {}),
    };
  } catch {
    // Nothing listening, or it is not an OpenAI-compatible server. Either way
    // there is nothing here to offer, and a connection refused is the normal
    // case rather than an error worth surfacing.
    return null;
  }
}

/**
 * Every local model server that answers, probed in parallel.
 *
 * Parallel because serial probing of five ports at a 1.2 s timeout is a six
 * second wait to be told nothing is running, and this runs on a path where the
 * user is waiting.
 */
export async function discoverLocal(host = "127.0.0.1"): Promise<LocalServer[]> {
  const found = await Promise.all(LOCAL_CANDIDATES.map((c) => probe(c, host)));
  return found.filter((f): f is LocalServer => f !== null);
}

/**
 * Render for the CLI. Says what to do next, not just what was found — a list of
 * URLs is only useful to somebody who already knows which flag takes one.
 */
export function renderDiscovery(servers: LocalServer[]): string {
  if (servers.length === 0) {
    return [
      "No local model server is listening.",
      `Probed ${LOCAL_CANDIDATES.map((c) => `${c.name} (${c.port})`).join(", ")} on 127.0.0.1.`,
      "",
      "Start one — `ollama serve` is the usual choice — or configure a hosted provider with `aetheraclaw auth set <provider>`.",
    ].join("\n");
  }

  const lines = ["Local model server(s) found:", ""];
  for (const s of servers) {
    lines.push(`  ${s.name}  ${s.baseUrl}`);
    if (s.note) lines.push(`      ${s.note}`);
    for (const m of s.models.slice(0, 12)) lines.push(`      ${m}`);
    if (s.models.length > 12) lines.push(`      … and ${s.models.length - 12} more`);
    lines.push("");
  }
  const first = servers[0];
  const model = first.models[0];
  lines.push("Use one with:");
  lines.push(`  aetheraclaw auth local --base-url ${first.baseUrl}${model ? ` --model ${model}` : " --model <name>"}`);
  lines.push("");
  lines.push("No API key is needed for a local server. Nothing leaves this machine — which is the reason to prefer one for anything touching a real document.");
  return lines.join("\n");
}
