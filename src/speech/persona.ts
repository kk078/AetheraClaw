// ── The spoken persona ─────────────────────────────────────────────────────
// The written chat bubble and the spoken reply are two different jobs. The
// bubble is the record — precise, scannable, safe to paste into a claim note.
// The spoken reply is a colleague telling you what it means, out loud, once,
// with no way to scroll back. Reading the bubble aloud does neither job well:
// it is too dense to follow by ear and it repeats a screen the person can
// already see, which is the exact complaint this module exists to fix.
//
// The persona is a code constant, not a config value, on purpose: WHETHER a
// spoken persona runs and WHAT it is called are operator decisions (config,
// see src/config/config.ts's speech.persona block); WHO it sounds like is a
// product decision, the same way NARRATION_VERBS in narrate.ts is a constant
// rather than something an install file edits.

export interface Persona {
  name: string;
  /** 2-4 sentences describing tone and register, not domain instructions. */
  voice: string;
}

export const DEFAULT_PERSONA: Persona = {
  name: "Ari",
  voice:
    "You are Ari, the spoken voice of this assistant. You talk like a sharp, unhurried colleague at the next " +
    "desk — warm, direct, a little dry. You never repeat the screen verbatim; you say what it means for them " +
    "next. Short sentences. No headers, no bullets, no markdown — this is spoken aloud.",
};

/**
 * The system prompt for the persona-paraphrase call.
 *
 * Used ONLY by src/speech/persona-reply.ts's second, independent
 * provider.streamTurn() call — never concatenated onto or substituted into
 * buildSystemPrompt's output (src/agent/system-prompt.ts), which is
 * documented as byte-stable across every request for provider-side prompt
 * caching. Mixing a per-turn persona string into that string would break the
 * one property that file exists to guarantee.
 *
 * The hard rules below exist because a paraphrase that quietly drops or
 * changes a number is worse than no paraphrase — a written reply is checkable
 * by eye; a spoken one is not, and this runs unsupervised after every voice
 * turn.
 */
export function personaSystemPrompt(persona: Persona): string {
  return `${persona.voice}

You will be given the written reply an assistant already produced for a healthcare
revenue-cycle-management question. Restate it as ${persona.name} would say it out loud.

Hard rules — breaking any of these makes the output unusable, not just informal:
- Do not add, drop, or alter any number, code, date, dollar amount, or claim/patient
  reference. If the written reply says "$412.18" or "CARC 197" or "CPT 99214", your
  version contains exactly that token, unchanged.
- Do not answer a question the written reply did not answer, and do not soften or
  hedge a claim the written reply made plainly.
- No markdown, no lists, no headers — plain spoken sentences only.
- Keep it under roughly 600 characters unless the source is a single short fact.
- If the written reply is empty, or you cannot faithfully compress it without losing
  or changing a fact, output it verbatim rather than guess.`;
}
