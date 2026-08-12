import type { ToolView } from "../views/types.js";

// Events emitted by the agent runner and fanned out to all connected clients.
export type AgentEvent =
  | { type: "turn_started"; sessionId: string }
  | { type: "text_delta"; sessionId: string; text: string }
  | { type: "thinking_delta"; sessionId: string; text: string }
  | { type: "tool_call"; sessionId: string; toolUseId: string; toolName: string; input: unknown }
  | {
      type: "tool_result";
      sessionId: string;
      toolUseId: string;
      /** The tool that ran. For tool_invoke this is the INNER tool, not the wrapper. */
      toolName: string;
      summary: string;
      isError: boolean;
      /**
       * The model finding its way around its own catalogue rather than doing
       * work. Decided here, not in the browser: whether a call is plumbing is a
       * judgement, and one made in the UI cannot be tested.
       */
      plumbing: boolean;
      /** Structured payload for the UI. Absent for tools that only return text. */
      view?: ToolView;
    }
  | {
      type: "approval_request";
      sessionId: string;
      approvalId: string;
      toolName: string;
      description: string;
      input: unknown;
    }
  | { type: "approval_resolved"; sessionId: string; approvalId: string; approved: boolean }
  | {
      type: "clarify_request";
      sessionId: string;
      clarifyId: string;
      question: string;
      context?: string;
    }
  | { type: "clarify_resolved"; sessionId: string; clarifyId: string; answer: string | null }
  /**
   * A distinct, persona-paraphrased spoken reply for a voice-originated turn.
   * Fired after turn_completed, not through it — SessionManager broadcasts
   * this once the second, independent persona-paraphrase call finishes, which
   * is why it carries its own sessionId/text rather than riding on the
   * turn's own event stream.
   */
  | { type: "persona_reply"; sessionId: string; text: string }
  | { type: "turn_completed"; sessionId: string; stopReason: string }
  | { type: "refusal"; sessionId: string }
  | { type: "error"; sessionId: string; message: string };
