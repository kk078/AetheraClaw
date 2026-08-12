import type { Config } from "../config/config.js";
import { resolveKey } from "../config/credentials.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { OllamaProvider, OpenAIProvider } from "./openai.js";
import type { ModelProvider } from "./types.js";

export const KNOWN_PROVIDERS = ["anthropic", "openai", "gemini", "ollama"] as const;

// ── Where a key comes from, in ONE place ─────────────────────────────────────
// Every provider used to read its own environment variable and nothing else,
// while the console's Providers & keys screen writes to credentials.json. So a
// key typed into the console was stored, masked, echoed back as "stored on this
// machine" — and never used by anything.
//
// Three of the four at least failed loudly ("GEMINI_API_KEY is not set").
// Ollama had a plausible-looking fallback to the string "ollama", the
// placeholder a LOCAL server accepts, so it sent `Authorization: Bearer ollama`
// to Ollama Cloud and got 401 — the same status a revoked key produces, which
// sends the investigation to the wrong place entirely.
//
// resolveKey checks the environment first and the credentials file second, so
// an operator can use either and a deployment can keep using env vars.
function keyFor(which: Config["provider"]): string | undefined {
  return resolveKey(which).key;
}

export function createProvider(cfg: Config, override?: Config["provider"]): ModelProvider {
  const which = override ?? cfg.provider;
  const key = keyFor(which);
  switch (which) {
    case "anthropic":
      return new AnthropicProvider(cfg.providers.anthropic.model, undefined, key);
    case "openai":
      return new OpenAIProvider(cfg.providers.openai.model, {
        baseURL: cfg.providers.openai.baseUrl,
        apiKey: key,
      });
    case "gemini":
      return new GeminiProvider(cfg.providers.gemini.model, key);
    case "ollama":
      return new OllamaProvider(cfg.providers.ollama, key);
    default:
      // The value reaches here unvalidated from POST /api/sessions {provider}.
      // Without this default the switch fell through to undefined and the first
      // `provider.name` deref threw a bare "Cannot read properties of undefined",
      // naming nothing. Fail with a message that names the bad value and the
      // valid set.
      throw new Error(
        `Unknown provider "${String(which)}". Valid providers are: ${KNOWN_PROVIDERS.join(", ")}.`,
      );
  }
}
