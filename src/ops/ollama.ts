// ── Local inference telemetry ────────────────────────────────────────────────
// When a turn takes ninety seconds, the question is whether the model is
// thrashing or the application is. Ollama can answer part of that and cannot
// answer the rest, and being precise about which is which is the difference
// between a useful panel and a dashboard that invents numbers.
//
// WHAT OLLAMA REPORTS: /api/ps lists loaded models with their total size, the
// portion resident in VRAM, the context length they were loaded with, and when
// each expires from memory. That is enough to answer the two questions that
// actually matter — is the model spilling to system RAM, and is the context
// window smaller than what is being sent.
//
// WHAT IT DOES NOT REPORT: GPU utilisation percentage, temperature, or
// per-request token rates. There is no endpoint for them. A telemetry tool that
// showed a GPU utilisation figure would have to invent it or shell out to
// nvidia-smi and pretend that a machine-wide number describes this process. It
// reports what the API returns and names the gap.

export interface LoadedModel {
  name: string;
  sizeBytes: number;
  /** Bytes resident on the GPU. Less than `sizeBytes` means the rest is in system RAM. */
  vramBytes: number;
  contextLength: number;
  expiresAt: string;
}

export interface OllamaSnapshot {
  reachable: boolean;
  baseUrl: string;
  cloud: boolean;
  models: LoadedModel[];
  /** Round-trip for the telemetry call itself — a floor on request latency. */
  probeMs: number;
  error?: string;
}

/** Below this share resident on the GPU, generation falls off a cliff. */
export const VRAM_RESIDENT_WARN = 0.9;

export interface TelemetryFinding {
  severity: "critical" | "warning" | "info";
  detail: string;
  remedy: string;
}

export function parsePs(payload: unknown): LoadedModel[] {
  const models = (payload as { models?: unknown[] })?.models;
  if (!Array.isArray(models)) return [];
  return models.map((raw) => {
    const m = raw as Record<string, unknown>;
    const details = (m.details ?? {}) as Record<string, unknown>;
    return {
      name: String(m.name ?? m.model ?? "(unnamed)"),
      sizeBytes: Number(m.size ?? 0),
      vramBytes: Number(m.size_vram ?? 0),
      contextLength: Number(m.context_length ?? details.context_length ?? 0),
      expiresAt: String(m.expires_at ?? ""),
    };
  });
}

export function analyzeTelemetry(snapshot: OllamaSnapshot, contextTokenBudget: number): TelemetryFinding[] {
  const out: TelemetryFinding[] = [];

  if (!snapshot.reachable) {
    out.push({
      severity: "critical",
      detail: `Ollama is not reachable at ${snapshot.baseUrl}${snapshot.error ? ` — ${snapshot.error}` : ""}.`,
      remedy: snapshot.cloud
        ? "Check OLLAMA_API_KEY and outbound access to ollama.com. Every turn will fail until this resolves."
        : "Start the local server (`ollama serve`). Every turn will fail until it is up.",
    });
    return out;
  }

  if (snapshot.cloud) {
    out.push({
      severity: "info",
      detail: "Running against Ollama Cloud, so there is no local GPU to report on.",
      remedy: "Resource questions here are about the provider's capacity and network latency, not this machine's. The probe time below is the useful number.",
    });
  }

  if (snapshot.models.length === 0) {
    out.push({
      severity: "info",
      detail: "No model is currently loaded.",
      remedy: "The first request after an idle period pays the load cost — typically several seconds for a large model. A slow first turn after quiet is this, not a fault.",
    });
  }

  for (const m of snapshot.models) {
    if (m.sizeBytes > 0) {
      const resident = m.vramBytes / m.sizeBytes;
      if (resident < VRAM_RESIDENT_WARN) {
        out.push({
          severity: resident < 0.5 ? "critical" : "warning",
          detail: `${m.name}: ${(resident * 100).toFixed(0)}% of ${(m.sizeBytes / 1e9).toFixed(1)} GB is resident in VRAM; the remainder is running from system RAM.`,
          remedy:
            "This is the usual cause of a model that answers in minutes rather than seconds — layers in system RAM are an order of magnitude slower. Use a smaller quantisation, reduce num_gpu layers, or free VRAM. No amount of application tuning compensates.",
        });
      }
    }
    if (m.contextLength > 0 && m.contextLength < contextTokenBudget) {
      out.push({
        severity: "warning",
        detail: `${m.name} was loaded with a ${m.contextLength}-token context, but contextTokenBudget is ${contextTokenBudget}.`,
        remedy:
          "The application will build a conversation larger than the model can hold, and Ollama will silently truncate it — the model then answers about a conversation it cannot fully see. Lower contextTokenBudget to match, or load the model with a larger context.",
      });
    }
  }

  return out;
}

export function renderTelemetry(snapshot: OllamaSnapshot, findings: TelemetryFinding[]): string {
  const lines = [
    `Ollama — ${snapshot.cloud ? "Cloud" : "local"} at ${snapshot.baseUrl}`,
    `  Reachable: ${snapshot.reachable ? "yes" : "NO"} · probe round-trip ${snapshot.probeMs} ms`,
  ];

  if (snapshot.models.length > 0) {
    lines.push("", "Loaded models:");
    for (const m of snapshot.models) {
      const resident = m.sizeBytes > 0 ? `${((m.vramBytes / m.sizeBytes) * 100).toFixed(0)}% in VRAM` : "size unknown";
      lines.push(
        `  ${m.name}  ${(m.sizeBytes / 1e9).toFixed(1)} GB · ${resident}${m.contextLength ? ` · ${m.contextLength}-token context` : ""}${m.expiresAt ? ` · unloads ${m.expiresAt}` : ""}`,
      );
    }
  }

  if (findings.length > 0) {
    lines.push("");
    for (const f of findings) lines.push(`  [${f.severity}] ${f.detail}`, `      ${f.remedy}`);
  }

  lines.push(
    "",
    "GPU utilisation percentage, temperature and per-request token rates are NOT shown because Ollama's API does not expose them. Reading them from nvidia-smi would report the whole machine rather than this process, which is a different number wearing the same label. Resident-VRAM share and context length are the two figures that actually explain slow generation, and both are real.",
  );
  return lines.join("\n");
}
