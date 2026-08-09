import type { Config } from "../config/config.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { OllamaProvider, OpenAIProvider } from "./openai.js";
import type { ModelProvider } from "./types.js";

export const KNOWN_PROVIDERS = ["anthropic", "openai", "gemini", "ollama"] as const;

export function createProvider(cfg: Config, override?: Config["provider"]): ModelProvider {
  const which = override ?? cfg.provider;
  switch (which) {
    case "anthropic":
      return new AnthropicProvider(cfg.providers.anthropic.model);
    case "openai":
      return new OpenAIProvider(cfg.providers.openai.model, { baseURL: cfg.providers.openai.baseUrl });
    case "gemini":
      return new GeminiProvider(cfg.providers.gemini.model);
    case "ollama":
      return new OllamaProvider(cfg.providers.ollama);
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
