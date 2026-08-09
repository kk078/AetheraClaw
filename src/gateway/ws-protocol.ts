import { z } from "zod";

// Client → server messages.
export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user_message"), sessionId: z.string(), text: z.string().min(1) }),
  z.object({ type: z.literal("approval_response"), approvalId: z.string(), approved: z.boolean() }),
  z.object({ type: z.literal("subscribe"), sessionId: z.string() }),
  z.object({ type: z.literal("cancel"), sessionId: z.string() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// Server → client messages mirror AgentEvent plus protocol-level acks/errors.
export interface ServerMessage {
  type: string;
  [key: string]: unknown;
}
