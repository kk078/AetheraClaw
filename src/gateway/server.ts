import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "../config/config.js";
import type { MemoryStore } from "../memory/store.js";
import { SessionManager } from "./session-manager.js";
import { ClientMessageSchema } from "./ws-protocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function findWebRoot(): string {
  // dist/gateway → ../../web/public ; src/gateway (tsx dev) → ../../web/public
  const candidates = [path.join(here, "../../web/public"), path.join(here, "../../../web/public")];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

export async function buildServer(opts: {
  config: Config;
  store: MemoryStore;
  sessions: SessionManager;
}) {
  const { config, store, sessions } = opts;
  const app = Fastify({ logger: false });

  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, { root: findWebRoot(), prefix: "/" });

  app.get("/healthz", async () => ({ ok: true, name: "aetheraclaw" }));

  app.get("/api/sessions", async () => store.listSessions());

  app.post("/api/sessions", async (req) => {
    const body = (req.body ?? {}) as { title?: string; provider?: string };
    return store.createSession(body.title ?? "", body.provider ?? config.provider);
  });

  app.get("/api/sessions/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getSession(id)) return reply.code(404).send({ error: "not found" });
    return store.loadMessages(id).map((m) => ({
      id: m.id,
      seq: m.seq,
      role: m.role,
      content: JSON.parse(m.content_json),
      stopReason: m.stop_reason,
      createdAt: m.created_at,
    }));
  });

  app.get("/ws", { websocket: true }, (socket, req) => {
    const url = new URL(req.url ?? "/ws", "http://localhost");
    const initialSession = url.searchParams.get("session");
    if (initialSession) sessions.subscribe(initialSession, socket);

    socket.on("message", (raw: Buffer) => {
      let parsed;
      try {
        parsed = ClientMessageSchema.parse(JSON.parse(raw.toString("utf8")));
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "invalid message" }));
        return;
      }
      switch (parsed.type) {
        case "subscribe":
          sessions.subscribe(parsed.sessionId, socket);
          socket.send(JSON.stringify({ type: "subscribed", sessionId: parsed.sessionId }));
          break;
        case "user_message":
          sessions.subscribe(parsed.sessionId, socket);
          void sessions.handleUserMessage(parsed.sessionId, parsed.text);
          break;
        case "approval_response":
          sessions.resolveApproval(parsed.approvalId, parsed.approved);
          break;
        case "cancel":
          // v1: cancel is best-effort — surfaced but the in-flight provider call completes.
          sessions.broadcast(parsed.sessionId, {
            type: "error",
            sessionId: parsed.sessionId,
            message: "cancel requested — the current model call will finish, then the turn stops",
          });
          break;
      }
    });
  });

  return app;
}
