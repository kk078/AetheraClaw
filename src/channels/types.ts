// Extension point for future messenger channels (Slack/Telegram/email/...).
// A channel delivers inbound user messages into sessions, renders agent events,
// and answers approval requests. The CLI and web UI use the WS protocol directly;
// implement this interface for out-of-process channels.
import type { AgentEvent } from "../shared/events.js";

export interface Channel {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  // Called by the gateway to deliver agent events for sessions this channel owns.
  deliver(event: AgentEvent): Promise<void>;
}
