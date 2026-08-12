import type { WebSocket } from "ws";
import type { Config } from "../config/config.js";
import type { MemoryStore } from "../memory/store.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { AgentEvent } from "../shared/events.js";
import { createProvider } from "../providers/index.js";
import { runTurn } from "../agent/runner.js";
import { ApprovalRegistry } from "./approvals.js";
import { ClarifyRegistry } from "./clarify.js";
import { personaReply } from "../speech/persona-reply.js";
import { phiVerdict, scanText } from "../compliance/phi-detect.js";
import { recordAccess } from "../tenancy/store.js";

interface SessionState {
  subscribers: Set<WebSocket>;
  running: boolean;
}

// Owns session lifecycle: one in-flight agent run per session, and fan-out of every
// agent event to all subscribed clients (CLI + browser can watch the same session).
export class SessionManager {
  private sessions = new Map<string, SessionState>();
  readonly approvals = new ApprovalRegistry();
  // Built in the constructor body, not as a field initializer, because its
  // timeout comes from config — and field initializers run before parameter
  // properties are guaranteed assigned.
  readonly clarifications: ClarifyRegistry;

  constructor(
    private store: MemoryStore,
    private registry: ToolRegistry,
    private config: Config,
    private services: Record<string, unknown> = {},
  ) {
    // Optional chaining rather than a bare `config.clarify.timeoutMs`: a caller
    // that constructs this loosely (test/gateway-cli.test.ts casts a partial
    // object through `as never`) must not throw at construction time over a
    // field it never touches. ClarifyRegistry's own default parameter takes
    // over when this is undefined.
    this.clarifications = new ClarifyRegistry(config?.clarify?.timeoutMs);
  }

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { subscribers: new Set(), running: false };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  subscribe(sessionId: string, ws: WebSocket): void {
    const subs = this.state(sessionId).subscribers;
    if (subs.has(ws)) return; // already subscribed — do not stack another close listener
    subs.add(ws);
    // One close listener per socket, not one per subscribe. The gateway calls
    // subscribe on connect, on each "subscribe" message, AND on every
    // "user_message", so a chatty tab accumulated a listener per message until
    // Node warned about a leak and memory climbed for the life of the connection.
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

  resolveClarification(clarifyId: string, answer: string): boolean {
    return this.clarifications.resolve(clarifyId, answer);
  }

  // Inject a message into a session and run the agent. Used by WS clients, channels,
  // and the scheduler alike.
  async handleUserMessage(sessionId: string, text: string, opts: { source?: "voice" } = {}): Promise<void> {
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

    // ── The PHI gate, before anything ──────────────────────────────────────
    // Here rather than inside runTurn, because runTurn's first act is to
    // persist the user message. Screening after that point would mean the
    // identifier had already been written to the transcript, replicated into
    // the WAL and carried into the next snapshot — and deleting it afterwards
    // does not unwrite any of that. The bytes having arrived is precisely what
    // the agreement is about.
    //
    // What the two modes do differs in one place only: whether a MEDIUM
    // confidence shape — a date beside the word "patient", a phone number — is
    // enough to stop. A high-confidence identifier is refused in both, because
    // an education deployment that lets a labelled SSN into a transcript is not
    // educating anyone about anything.
    const verdict = phiVerdict(scanText(text), this.config.healthcare.phiMode);
    if (!verdict.allow) {
      // Reference only, and recordCount 0 — nothing was read, nothing was
      // stored. The row exists because "somebody pasted an identifier into the
      // chat box" is exactly the event an incident review needs to find, and
      // the gate working is what stops it leaving any other trace.
      //
      // The KINDS are logged, never the text. A log that quoted what it refused
      // would be the second copy of the record that src/tenancy/access-log.ts
      // exists to prevent.
      recordAccess(this.store, {
        action: "write",
        resourceType: "chat_message",
        resourceRef: `session:${sessionId}`,
        actor: "operator",
        tenantSlug: "",
        sourceAddress: "",
        recordCount: 0,
        at: Date.now(),
      });
      this.broadcast(sessionId, {
        type: "phi_blocked",
        sessionId,
        why: verdict.why,
        kinds: verdict.kinds,
        mode: this.config.healthcare.phiMode,
      });
      return;
    }

    state.running = true;
    // Accumulated only from the emit wrapper below, never re-derived from the
    // stored transcript afterward: this is exactly the text that streamed to
    // every subscriber as text_delta, so the persona paraphrase (fired below,
    // once the turn is over) is guaranteed to be paraphrasing what was
    // actually shown, not a slightly different read of the database.
    let assistantText = "";
    try {
      const provider = createProvider(this.config, session.provider as Config["provider"]);
      await runTurn(
        {
          provider,
          registry: this.registry,
          store: this.store,
          config: this.config,
          services: this.services,
          emit: (event) => {
            if (event.type === "text_delta") assistantText += event.text;
            this.broadcast(sessionId, event);
          },
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
          requestClarification: this.config.clarify?.enabled ?? true
            ? async ({ question, context }) => {
                const { clarifyId, answer } = this.clarifications.request((id) => {
                  this.broadcast(sessionId, { type: "clarify_request", sessionId, clarifyId: id, question, context });
                });
                const resolved = await answer;
                this.broadcast(sessionId, { type: "clarify_resolved", sessionId, clarifyId, answer: resolved });
                return resolved;
              }
            : undefined,
        },
        sessionId,
        text,
      );
    } finally {
      state.running = false;
    }

    // Fire-and-forget, deliberately not inside the try/finally above: a new
    // turn can start the moment this one's turn_completed fires, and the
    // paraphrase (a second, independent model call) arrives 1-3s later as its
    // own persona_reply event whenever it's ready. Only for a voice-originated
    // turn — a typed message gets no persona call and no added latency.
    if (opts.source === "voice") void this.speakPersonaReply(sessionId, assistantText).catch(() => {});
  }

  private async speakPersonaReply(sessionId: string, writtenReply: string): Promise<void> {
    if (!this.config.speech?.enabled || !this.config.speech?.persona?.enabled) return;
    if (!writtenReply.trim()) return;
    const session = this.store.getSession(sessionId);
    const provider = createProvider(this.config, session?.provider as Config["provider"]);
    const text = await personaReply(provider, writtenReply);
    if (text) this.broadcast(sessionId, { type: "persona_reply", sessionId, text });
  }
}
