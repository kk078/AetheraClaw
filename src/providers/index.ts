import type { Config } from "../config/config.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { OllamaProvider, OpenAIProvider } from "./openai.js";
import type { ModelProvider } from "./types.js";

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
      return new OllamaProvider(cfg.providers.ollama.model, cfg.providers.ollama.baseUrl);
  }
}
