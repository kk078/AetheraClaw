import type { ModelProvider } from "../providers/types.js";
import { DEFAULT_PERSONA, personaSystemPrompt, type Persona } from "./persona.js";

const DEFAULT_TIMEOUT_MS = 12_000;

export interface PersonaReplyOptions {
  persona?: Persona;
  timeoutMs?: number;
}

/**
 * Paraphrase an already-computed written reply into the spoken persona's voice.
 *
 * A SECOND, independent provider.streamTurn() call with its own short system
 * prompt (personaSystemPrompt) — never buildSystemPrompt's cached string,
 * never the main turn's message history. The written reply is treated as
 * frozen fact; only its register changes.
 *
 * Every failure mode — the provider throwing, the stream running long, empty
 * output — resolves null rather than rejecting or hanging. SessionManager
 * calls this fire-and-forget after a turn has already completed; a broken
 * paraphrase must never surface as a turn error, and the caller falls back to
 * speaking the original written reply when this returns null.
 */
export async function personaReply(
  provider: ModelProvider,
  writtenReply: string,
  opts: PersonaReplyOptions = {},
): Promise<string | null> {
  const trimmed = writtenReply.trim();
  if (!trimmed) return null;

  const persona = opts.persona ?? DEFAULT_PERSONA;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const system = personaSystemPrompt(persona);

  const run = async (): Promise<string> => {
    let out = "";
    for await (const event of provider.streamTurn({
      system,
      messages: [{ role: "user", content: [{ type: "text", text: trimmed }] }],
      tools: [],
      maxTokens: 500,
    })) {
      if (event.type === "text_delta") out += event.text;
    }
    return out.trim();
  };

  try {
    const result = await Promise.race([
      run(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return result && result.length > 0 ? result : null;
  } catch {
    return null;
  }
}
