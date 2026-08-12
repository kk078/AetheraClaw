import { z } from "zod";
import { defineTool } from "./registry.js";

// ── Ask the user, don't guess ──────────────────────────────────────────────
// The one tool that calls ctx.requestClarification directly from inside its
// own execute(), the way swarm_advance calls ctx.requestApproval mid-execution
// (src/swarm/tools.ts) — not the registry-driven pre-execute gate every other
// tool goes through. assessRisk is deliberately left at its "safe" default:
// asking a question is not itself risky, and stacking the approval gate on
// top of the clarify gate would mean answering one prompt to be shown another.

export const askUserTool = defineTool({
  name: "ask_user",
  description:
    "Pause and ask the user a clarifying question before continuing. Use this when a required fact is genuinely " +
    "ambiguous or missing — which claim, which date range, which of two payers — rather than guessing or silently " +
    "picking the more likely reading. Not for approval to run a risky action; the approval gate handles that " +
    "automatically. The answer comes back as plain text; if nobody answers in time this reports that plainly " +
    "rather than inventing one.",
  schema: z.object({
    question: z.string().min(1).describe("The single question to ask, phrased plainly — it may be spoken aloud."),
    context: z
      .string()
      .optional()
      .describe("One short sentence of why you're asking, shown alongside the question. Never include PHI."),
  }),
  execute: async (input, ctx) => {
    if (!ctx.requestClarification) {
      return {
        content:
          "Clarifying questions are not available in this session (no clarification channel wired up). " +
          "State your assumption plainly and proceed, or ask in your final answer instead.",
        isError: true,
      };
    }
    const answer = await ctx.requestClarification({ question: input.question, context: input.context });
    if (answer === null) {
      return {
        content: `No answer was received to: "${input.question}" (timed out). Do not assume an answer — say so, or ask again differently.`,
        isError: true,
      };
    }
    return { content: `User answered: ${answer}` };
  },
});
