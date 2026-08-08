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
import { groupIntoModules } from "../tools/modules.js";
import { PROFILES, selectTools } from "../tools/profiles.js";
import { resolveOllamaTarget } from "../providers/openai.js";
import type { ToolRegistry } from "../tools/registry.js";
import { computeExecutiveKpis } from "../reports/kpi.js";
import { loadAcks } from "../reports/kpi-tools.js";
import { loadClaims, loadEras } from "../reports/tools.js";

/**
 * Above this many rows, the overview does not compute KPIs.
 *
 * They need every claim and every remittance parsed out of JSON, and this
 * endpoint is hit on every page load. A dashboard that takes four seconds to
 * paint is one people stop opening, which costs more than the tiles are worth —
 * so past the bound it says so and points at kpi_dashboard, which is where
 * somebody who actually wants the number goes anyway.
 */
const OVERVIEW_KPI_MAX_ROWS = 20_000;

interface OverviewKpis {
  daysInAr: number | null;
  acceptanceRate: number | null;
  netCollectionRate: number | null;
  /** Why a figure is null, per figure. Never rendered as a zero. */
  notes: { daysInAr: string; acceptanceRate: string; netCollectionRate: string };
  skipped?: string;
}

function overviewKpis(store: MemoryStore): OverviewKpis | null {
  try {
    const rows =
      (store.db.prepare("SELECT COUNT(*) AS c FROM claims").get() as { c: number }).c +
      (store.db.prepare("SELECT COUNT(*) AS c FROM remittances").get() as { c: number }).c;
    if (rows === 0) return null;
    if (rows > OVERVIEW_KPI_MAX_ROWS) {
      return {
        daysInAr: null,
        acceptanceRate: null,
        netCollectionRate: null,
        notes: { daysInAr: "", acceptanceRate: "", netCollectionRate: "" },
        skipped: `${rows.toLocaleString()} rows — past the ${OVERVIEW_KPI_MAX_ROWS.toLocaleString()} bound this page computes inline. Run kpi_dashboard.`,
      };
    }

    // The same loaders kpi_dashboard uses. Two claim↔ERA joins normalizing ids
    // differently would let the dashboard and the tool disagree about what is
    // outstanding, and nobody would be able to say which one was right.
    const ctx = { services: { store } };
    const k = computeExecutiveKpis(loadClaims(ctx), loadEras(ctx), loadAcks(store), Date.now());
    return {
      daysInAr: k.daysInAr.days,
      acceptanceRate: k.cleanClaim.acceptanceRate,
      netCollectionRate: k.netCollection.rate,
      notes: {
        daysInAr: k.daysInAr.note,
        acceptanceRate: k.cleanClaim.note,
        netCollectionRate: k.netCollection.note,
      },
    };
  } catch {
    // A widget row is not worth failing the whole overview for.
    return null;
  }
}

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
  registry?: ToolRegistry;
}) {
  const { config, store, sessions, registry } = opts;
  const app = Fastify({ logger: false });

  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, { root: findWebRoot(), prefix: "/" });

  app.get("/healthz", async () => ({ ok: true, name: "aetheraclaw" }));

  app.get("/api/sessions", async () => store.listSessions());

  /** The module map and the live tool catalogue — what the UI renders as capability. */
  app.get("/api/modules", async () => {
    const specs = registry?.specs() ?? [];
    const selection = selectTools(specs, config.toolProfile, config.provider);
    const direct = new Set(selection.specs.map((s) => s.name));
    return {
      total: specs.length,
      loadedDirectly: selection.specs.length,
      deferred: selection.deferred.length,
      profile: config.toolProfile,
      profiles: PROFILES.map((p) => ({ name: p.name, description: p.description })),
      modules: groupIntoModules(specs).map((m) => ({
        ...m,
        tools: m.tools.map((t) => ({ ...t, loaded: direct.has(t.name) })),
      })),
    };
  });

  /**
   * Runtime state plus what is actually in the database.
   *
   * The counts matter more than they look: almost every analytic in this system
   * needs stored claims or parsed remittances, and a practice wondering why the
   * forecast is empty is usually looking at zeroes here.
   */
  app.get("/api/overview", async () => {
    const count = (table: string): number => {
      try {
        return (store.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
      } catch {
        return 0;
      }
    };
    const ollama = resolveOllamaTarget(config.providers.ollama, process.env.OLLAMA_API_KEY);
    return {
      provider: config.provider,
      model: config.provider === "ollama" ? ollama.model : config.providers[config.provider].model,
      endpoint: config.provider === "ollama" ? (ollama.cloud ? "Ollama Cloud" : "local") : "",
      driver: store.db.driver,
      profile: config.toolProfile,
      approvalPolicy: config.approvalPolicy,
      workspace: config.workspaceRoot,
      counts: {
        sessions: count("sessions"),
        messages: count("messages"),
        claims: count("claims"),
        remittances: count("remittances"),
        worklist: count("worklist_items"),
        suggestions: count("code_suggestions"),
        audit: count("audit_chain"),
      },
      kpis: overviewKpis(store),
    };
  });

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

  // Views live outside the message stream, so replaying a session needs a second
  // fetch. Keyed by tool_use_id, which is what the message blocks carry.
  app.get("/api/sessions/:id/views", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getSession(id)) return reply.code(404).send({ error: "not found" });
    return store.loadToolViews(id);
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
