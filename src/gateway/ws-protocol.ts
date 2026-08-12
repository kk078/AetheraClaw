import { z } from "zod";

// Client → server messages.
export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user_message"),
    sessionId: z.string(),
    text: z.string().min(1),
    // Set by voice.js when the transcript came from a spoken utterance, so
    // SessionManager knows to follow up with a persona-paraphrased spoken
    // reply instead of leaving speech to read the written text verbatim.
    source: z.enum(["voice"]).optional(),
  }),
  z.object({ type: z.literal("approval_response"), approvalId: z.string(), approved: z.boolean() }),
  z.object({ type: z.literal("clarify_response"), clarifyId: z.string(), answer: z.string() }),
  z.object({ type: z.literal("subscribe"), sessionId: z.string() }),
  z.object({ type: z.literal("cancel"), sessionId: z.string() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// Server → client messages mirror AgentEvent plus protocol-level acks/errors.
export interface ServerMessage {
  type: string;
  [key: string]: unknown;
}
