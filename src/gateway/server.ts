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
import { PROFILES, PROVIDER_TOOL_LIMITS, selectTools } from "../tools/profiles.js";
import { resolveOllamaTarget } from "../providers/openai.js";
import type { ToolRegistry } from "../tools/registry.js";
import { computeExecutiveKpis } from "../reports/kpi.js";
import { loadAcks } from "../reports/kpi-tools.js";
import { loadClaims, loadEras } from "../reports/tools.js";
import { extractDocument } from "../ingest/extract.js";
import { saveDocument } from "../ingest/store.js";
import { credentialsPath, loadCredentials, maskKey, removeCredential, resolveKey, setCredential, shapeWarning } from "../config/credentials.js";
import { discoverLocal } from "../providers/discover.js";
import type { ProviderName } from "../config/config.js";

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
  // 32 MB: an EOB batch PDF runs to a few megabytes and a year-end remittance
  // spreadsheet more. Fastify's 1 MB default would refuse both with a message
  // about the body being too large, which reads as a bug rather than a limit.
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });

  // Uploads arrive as raw bytes, under a CATCH-ALL content type.
  //
  // Listing the Office and PDF types individually was tried and is wrong: a
  // browser sends whatever the OS says a file is, and an unregistered type is
  // refused by Fastify with a bare 415 before any route sees it. A photo of an
  // EOB — the single most likely thing somebody uploads — came back as
  // "Unsupported Media Type" instead of the sentence explaining that there is
  // no OCR here and what to do instead. Every file reaches the route; the route
  // decides what it is from the CONTENT and answers in words.
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  // `text/plain` has a BUILT-IN parser that wins over the catch-all and hands
  // back a string, so every CSV and .txt upload arrived as an empty body. It is
  // overridden here; `application/json` deliberately is NOT, because the session
  // routes need it parsed.
  app.addContentTypeParser("text/plain", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, { root: findWebRoot(), prefix: "/" });

  app.get("/healthz", async () => ({ ok: true, name: "aetheraclaw" }));

  app.get("/api/sessions", async () => store.listSessions());

  /** The module map and the live tool catalogue — what the UI renders as capability. */
  app.get("/api/modules", async () => {
    const specs = registry?.specs() ?? [];
    const selection = selectTools(specs, config.toolProfile, config.provider, config.toolLimits[config.provider]);
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
    const countWhere = (table: string, where: string): number => {
      try {
        return (store.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get() as { c: number }).c;
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
        // Surfaced in the header ticker: mail held at the PHI boundary is work
        // nobody can see from any other screen, and some of it has a clock.
        heldMail: countWhere("inbound_mail", "quarantined = 1 AND status = 'new'"),
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

  // ── Document upload ────────────────────────────────────────────────────────
  // Raw bytes with the filename in the query string, rather than multipart.
  // Multipart would mean a parser dependency to read a boundary-delimited body
  // for one field, and the browser can POST a File object directly.
  //
  // The file is extracted and STORED — this deployment persists document text —
  // and the response carries the extraction, not the bytes. Nothing is written
  // to the workspace: an upload is not a file drop, and a filename arriving from
  // a browser is attacker-controlled input that should never reach a path.
  app.post("/api/upload", async (req, reply) => {
    const q = req.query as { session?: string; filename?: string };
    const sessionId = String(q.session ?? "");
    if (!sessionId || !store.getSession(sessionId)) return reply.code(400).send({ error: "unknown session" });

    // A string or a parsed object can still arrive when a built-in parser wins
    // over the catch-all, and losing an upload to a type-check is a worse failure
    // than re-encoding one. `application/json` is deliberately left on Fastify's
    // JSON parser (the session routes need it parsed), so a .json document upload
    // — a FHIR bundle, an exported record — reaches here as an OBJECT; re-serialize
    // it rather than reject a valid, non-empty file as "empty body".
    const raw = req.body;
    const body = Buffer.isBuffer(raw)
      ? raw
      : typeof raw === "string"
        ? Buffer.from(raw, "utf8")
        : raw && typeof raw === "object"
          ? Buffer.from(JSON.stringify(raw), "utf8")
          : null;
    if (!body || body.length === 0) return reply.code(400).send({ error: "empty body" });

    // Only the base name is kept, and separators are stripped rather than
    // resolved — this string is displayed and stored, never opened.
    const filename = String(q.filename ?? "upload").split(/[\\/]/).pop()!.slice(0, 200) || "upload";

    const extraction = extractDocument(filename, body);
    const doc = saveDocument(store, sessionId, extraction);
    return {
      id: doc.id,
      filename: doc.filename,
      kind: doc.kind,
      sizeBytes: doc.sizeBytes,
      readable: doc.readable,
      refusal: doc.refusal,
      characters: doc.text.length,
      sections: doc.sections.length,
      phi: doc.phi,
      notes: doc.notes,
    };
  });


  // ── Providers and keys ─────────────────────────────────────────────────────
  // Entering a key in the console rather than a terminal. Two rules hold here:
  // a key is never sent BACK (the mask is all the UI ever sees), and the routes
  // exist only because the gateway binds 127.0.0.1 — this is a local settings
  // screen, not an admin API.

  app.get("/api/providers", async () => {
    const { credentials, warnings } = loadCredentials();
    const rows = (["anthropic", "openai", "gemini", "ollama"] as const).map((name) => {
      const r = resolveKey(name, { store: credentials });
      return {
        name,
        source: r.source,
        masked: r.key ? maskKey(r.key) : "",
        envVar: r.envVar,
        model: name === "ollama" ? resolveOllamaTarget(config.providers.ollama, process.env.OLLAMA_API_KEY).model : config.providers[name].model,
        active: config.provider === name,
        // Stated per provider because it is the one thing that genuinely differs
        // between them, and the UI should not imply otherwise.
        toolCap: PROVIDER_TOOL_LIMITS[name],
      };
    });
    return { providers: rows, warnings, credentialsPath: credentialsPath() };
  });

  app.post("/api/providers/key", async (req, reply) => {
    const body = (req.body ?? {}) as { provider?: string; key?: string; note?: string };
    const name = String(body.provider ?? "") as ProviderName;
    if (!["anthropic", "openai", "gemini", "ollama"].includes(name)) {
      return reply.code(400).send({ error: "unknown provider" });
    }
    const key = String(body.key ?? "").trim();
    if (!key) return reply.code(400).send({ error: "empty key" });

    const warning = shapeWarning(name, key);
    setCredential(name, key, body.note);
    // The mask goes back, never the key. A settings screen that echoes the
    // value it just stored puts it in the DOM, in a screenshot, and in the
    // browser's memory for as long as the tab is open.
    return { ok: true, masked: maskKey(key), warning: warning ?? "" };
  });

  app.delete("/api/providers/key/:provider", async (req, reply) => {
    const { provider } = req.params as { provider: string };
    if (!["anthropic", "openai", "gemini", "ollama"].includes(provider)) {
      return reply.code(400).send({ error: "unknown provider" });
    }
    return { ok: true, removed: removeCredential(provider as ProviderName) };
  });

  app.get("/api/providers/local", async () => ({ servers: await discoverLocal() }));

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
