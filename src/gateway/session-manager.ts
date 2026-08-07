import type { WebSocket } from "ws";
import type { Config } from "../config/config.js";
import type { MemoryStore } from "../memory/store.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { AgentEvent } from "../shared/events.js";
import { createProvider } from "../providers/index.js";
import { runTurn } from "../agent/runner.js";
import { ApprovalRegistry } from "./approvals.js";

interface SessionState {
  subscribers: Set<WebSocket>;
  running: boolean;
}

// Owns session lifecycle: one in-flight agent run per session, and fan-out of every
// agent event to all subscribed clients (CLI + browser can watch the same session).
export class SessionManager {
  private sessions = new Map<string, SessionState>();
  readonly approvals = new ApprovalRegistry();

  constructor(
    private store: MemoryStore,
    private registry: ToolRegistry,
    private config: Config,
    private services: Record<string, unknown> = {},
  ) {}

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { subscribers: new Set(), running: false };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  subscribe(sessionId: string, ws: WebSocket): void {
    this.state(sessionId).subscribers.add(ws);
    ws.on("close", () => this.state(sessionId).subscribers.delete(ws));
  }

  broadcast(sessionId: string, event: AgentEvent | Record<string, unknown>): void {
    const payload = JSON.stringify(event);
    for (const ws of this.state(sessionId).subscribers) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  isRunning(sessionId: string): boolean {
    return this.state(sessionId).running;
  }

  resolveApproval(approvalId: string, approved: boolean): boolean {
    return this.approvals.resolve(approvalId, approved);
  }

  // Inject a message into a session and run the agent. Used by WS clients, channels,
  // and the scheduler alike.
  async handleUserMessage(sessionId: string, text: string): Promise<void> {
    const state = this.state(sessionId);
    if (state.running) {
      this.broadcast(sessionId, { type: "error", sessionId, message: "a turn is already running in this session" });
      return;
    }
    const session = this.store.getSession(sessionId);
    if (!session) {
      this.broadcast(sessionId, { type: "error", sessionId, message: "unknown session" });
      return;
    }
    state.running = true;
    try {
      const provider = createProvider(this.config, session.provider as Config["provider"]);
      await runTurn(
        {
          provider,
          registry: this.registry,
          store: this.store,
          config: this.config,
          services: this.services,
          emit: (event) => this.broadcast(sessionId, event),
          requestApproval: async ({ toolName, description, input }) => {
            const { approvalId, decision } = this.approvals.request((id) => {
              this.broadcast(sessionId, {
                type: "approval_request",
                sessionId,
                approvalId: id,
                toolName,
                description,
                input,
              });
            });
            const approved = await decision;
            this.broadcast(sessionId, { type: "approval_resolved", sessionId, approvalId, approved });
            return approved;
          },
        },
        sessionId,
        text,
      );
    } finally {
      state.running = false;
    }
  }
}
