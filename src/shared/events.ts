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
      summary: string;
      isError: boolean;
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
  | { type: "turn_completed"; sessionId: string; stopReason: string }
  | { type: "refusal"; sessionId: string }
  | { type: "error"; sessionId: string; message: string };
