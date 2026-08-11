import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { configDir, type Config } from "../config/config.js";
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
import { detectKind, extractDocument, type Extraction } from "../ingest/extract.js";
import { expandArchive, type ArchiveExpansion } from "../ingest/archive.js";
import { needsOcr, ocrUnavailableNote, runOcr, withOcrText } from "../ingest/ocr.js";
import { createArchive, saveDocument, updateArchive } from "../ingest/store.js";
import { credentialsPath, loadCredentials, maskKey, removeCredential, resolveKey, setCredential, shapeWarning } from "../config/credentials.js";
import { discoverLocal } from "../providers/discover.js";
import { configPath as providerConfigPath, writeProviderSettings } from "../config/write.js";
import type { ProviderName } from "../config/config.js";
import { createSpeechProvider, speechStatus } from "../speech/providers/index.js";
import { speakableSummary, toSpeakable } from "../speech/speakable.js";
import { accessEventForTranscript } from "../speech/transcript-gate.js";
import { recordAccess } from "../tenancy/store.js";
import { loadInstalledUniverse } from "../speech/snap.js";
import { refineTranscript } from "../speech/refine.js";
import { buildHintVocabulary, renderVocabularyPrompt } from "../speech/vocabulary.js";
import { narrateTool, shouldNarrate } from "../speech/narrate.js";
import { describePrefetch, prefetchCodes } from "../speech/prefetch.js";
import type { ScreenContext } from "../speech/deixis.js";
import { matchWake } from "../speech/wake.js";
import {
  describeAuthState,
  initialAuthState,
  isAuthorized,
  issueChallenge,
  requiresAuthorization,
  verifyResponse,
  type AuthState,
} from "../speech/authorization.js";
import {
  actorFor,
  authorizeRequest,
  classifyBind,
  isPublicAccess,
  isUnauthenticatedPath,
  type Identity,
} from "./auth.js";
import { readEnv } from "../config/legacy.js";
import { assessSnapshot, readSnapshotStatus } from "../ops/snapshot-status.js";
import { resolvePosture, screenIngress } from "../config/posture.js";
import { uploadGate } from "../compliance/upload-gate.js";
import {
  announceWorklistStart,
  applyCommand,
  parseWorklistCommand,
  startWorklist,
  type WorklistSession,
} from "../speech/worklist-mode.js";
import { icd10Table, loadDataJson } from "../tools/healthcare/datasets.js";
import {
  DEFAULT_LIMIT,
  costOf,
  newBucket,
  renderMetrics,
  rateLimitKey,
  securityHeaders,
  shouldTrustForwardedFor,
  spend,
  type Bucket,
  type MetricSample,
} from "./hardening.js";

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

  // ── The door ───────────────────────────────────────────────────────────────
  // Registered before every route, including the static file handler and the
  // WebSocket upgrade, because a control that covers most of the surface covers
  // none of it: the console's own JavaScript is what calls the admin routes, and
  // an unauthenticated /app.js is enough to learn what to call.
  //
  // On loopback this is a no-op and local use is unchanged. Off loopback it is
  // the only thing standing in front of an admin API over PHI.
  const exposure = classifyBind(config.gateway.host);
  const gatewayToken = readEnv("GATEWAY_TOKEN") ?? "";
  // Resolved ONCE at startup rather than per request. The posture is a property
  // of the deployment, and re-reading the environment per request would let a
  // long-running process change what it accepts halfway through a session with
  // nothing recording that it had.
  const posture = resolvePosture({ exposure });
  // Serve anyone who reaches the edge. Read once, reported once, and OFF
  // unless the deployment explicitly asked — see src/gateway/auth.ts for what
  // it gives away.
  const publicAccess = isPublicAccess(readEnv("PUBLIC"));
  // ── Response headers, on everything ────────────────────────────────────────
  // Set in onSend so they land on static files and error responses too. A CSP
  // that covers the routes and not index.html covers nothing.
  const headers = securityHeaders(exposure);
  app.addHook("onSend", async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(headers)) reply.header(k, v);
    return payload;
  });

  // ── Rate limiting ──────────────────────────────────────────────────────────
  // Per identity where there is one, per address otherwise: per address alone
  // would let one authenticated user behind a NAT exhaust the budget for a whole
  // practice. Static assets and /healthz cost nothing — throttling a health
  // check makes a monitoring system look like an attack.
  const buckets = new Map<string, Bucket>();
  let rateLimited = 0;

  app.addHook("onRequest", async (req, reply) => {
    const cost = costOf(req.method, req.url);
    if (cost > 0) {
      // NOT req.ip. Behind Cloudflare that is the edge, not the caller, and
      // keying on it meant the limiter refused nothing in production while
      // passing every local test. See rateLimitKey for why a forwarded header
      // is trusted only when something in front overwrites it.
      const key = rateLimitKey({
        identity: (req as { identity?: { name?: string } }).identity?.name,
        headers: req.headers as Record<string, string | string[] | undefined>,
        socketIp: req.ip,
        trustForwardedFor: shouldTrustForwardedFor(
          readEnv("TRUST_PROXY") ?? "",
          exposure,
          req.headers as Record<string, string | string[] | undefined>,
        ),
      });
      const now = Date.now();
      const decision = spend(buckets.get(key) ?? newBucket(DEFAULT_LIMIT, now), DEFAULT_LIMIT, cost, now);
      buckets.set(key, decision.bucket);
      if (!decision.allowed) {
        rateLimited++;
        await reply
          .code(429)
          .header("retry-after", String(decision.retryAfterSeconds))
          .send({ error: decision.reason });
        return;
      }
      // Bounded, so a long-running gateway does not accumulate a bucket per
      // address seen. Evicting full buckets only: a full bucket carries no
      // state worth keeping, and evicting a depleted one would hand a caller a
      // fresh budget for free.
      if (buckets.size > 5000) {
        for (const [k, b] of buckets) {
          if (b.tokens >= DEFAULT_LIMIT.burst) buckets.delete(k);
          if (buckets.size <= 2500) break;
        }
      }
    }
    if (isUnauthenticatedPath(req.url)) return;
    const decision = authorizeRequest({ exposure, headers: req.headers, expectedToken: gatewayToken, publicAccess });
    if (decision.ok) {
      // Carried on the request so PHI rows can name a person rather than a
      // socket. Anything that logs an access reads this instead of guessing.
      (req as { identity?: Identity }).identity = decision.identity;
      return;
    }
    // `why` is populated only for the misconfiguration case, and that one is
    // the operator's own deployment talking to them. An unauthenticated caller
    // gets a bare status with no hint about what is missing.
    await reply.code(decision.status).send(decision.why === "" ? { error: "unauthorized" } : { error: decision.why });
  });

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

  app.get("/healthz", async () => ({ ok: true, name: "orion" }));

  /**
   * Is this deployment persisting?
   *
   * A question the console could not answer. On 2026-08-11 rows written half an
   * hour before a restart were gone afterwards and the same day-old database
   * came back twice, while /healthz said "ok", the deploy was green and every
   * page rendered — the evidence was in a container log unreachable without a
   * Cloudflare session. A DEPLOYMENT THAT SILENTLY STOPS PERSISTING LOOKS
   * EXACTLY LIKE A HEALTHY ONE, so health has to be asked about the checkpoint
   * itself rather than inferred from the process being up.
   *
   * Times and byte counts only, so it is safe on a public hostname: it says
   * whether bytes reached R2, never what was in them.
   */
  app.get("/api/ops/snapshot", async (_req, reply) => {
    const assessment = assessSnapshot(readSnapshotStatus(configDir()), Date.now());
    // 200 even when the verdict is bad. This endpoint reports a state; a 5xx
    // would make a monitoring system treat "persistence is broken" as "the
    // status check is broken", which is the same confusion the endpoint exists
    // to remove.
    return reply.send(assessment);
  });

  /**
   * Prometheus metrics.
   *
   * COUNTS AND DURATIONS ONLY. No claim number, no member id, no session id, no
   * filename. A metrics endpoint is scraped by systems with a different
   * retention policy and a different access list from the database, and it is
   * the easiest place in a product to leak PHI without anybody noticing — a
   * label is just a string, and claim_id="CLM-1042" looks perfectly ordinary in
   * a dashboard. renderMetrics drops identifier-shaped label values rather than
   * trusting the caller.
   */
  app.get("/metrics", async (_req, reply) => {
    const count = (table: string): number => {
      try {
        return (store.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
      } catch {
        return 0;
      }
    };
    const samples: MetricSample[] = [
      { name: "orion_up", value: 1, help: "The gateway is serving.", type: "gauge" },
      { name: "orion_sessions_total", value: count("sessions"), help: "Conversations stored.", type: "gauge" },
      { name: "orion_claims_total", value: count("claims"), help: "Claims stored.", type: "gauge" },
      { name: "orion_remittances_total", value: count("remittances"), help: "Remittance batches stored.", type: "gauge" },
      { name: "orion_worklist_open", value: count("worklist_items"), help: "Worklist items.", type: "gauge" },
      { name: "orion_rate_limited_total", value: rateLimited, help: "Requests refused by the rate limiter since start.", type: "counter" },
      {
        name: "orion_mail_held",
        value: (() => {
          try {
            return (store.db.prepare("SELECT COUNT(*) AS c FROM inbound_mail WHERE quarantined = 1 AND status = 'new'").get() as { c: number }).c;
          } catch {
            return 0;
          }
        })(),
        // Worth a metric precisely because held mail is invisible to every
        // other surface. A number that climbs and never falls is a queue
        // nobody is working.
        help: "Messages held at the PHI boundary and not yet resolved.",
        type: "gauge",
      },
      {
        name: "orion_jobs_dead",
        value: (() => {
          try {
            return (store.db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE status = 'dead'").get() as { c: number }).c;
          } catch {
            return 0;
          }
        })(),
        help: "Dead-lettered jobs awaiting a human decision. A claim_submit here means a claim's fate is unknown.",
        type: "gauge",
      },
    ];

    // ── Persistence ──────────────────────────────────────────────────────────
    // The gauge to alert on. orion_up says the process is serving, which was
    // true throughout the day this deployment was quietly losing every write.
    const snap = assessSnapshot(readSnapshotStatus(configDir()), Date.now());
    samples.push(
      {
        name: "orion_snapshot_persisting",
        value: snap.persisting ? 1 : 0,
        // 0 covers stale, failing, disabled and unmeasured alike. An operator
        // does not need the distinction to know something is wrong, and
        // collapsing them means no verdict is accidentally left un-alerted.
        help: "1 when a checkpoint has recently landed in R2. 0 means a restart would lose data.",
        type: "gauge",
      },
      {
        name: "orion_snapshot_age_seconds",
        // -1, not 0, when nothing has ever landed. Zero is the value of a
        // checkpoint that just succeeded — the best possible state — and using
        // it for "never" would make the worst state look like the best.
        value: snap.ageSeconds ?? -1,
        help: "Seconds since the last checkpoint R2 accepted. -1 when there has never been one.",
        type: "gauge",
      },
      {
        name: "orion_snapshot_bytes",
        value: snap.lastBytes,
        help: "Size of the last accepted checkpoint.",
        type: "gauge",
      },
      {
        name: "orion_snapshot_failures",
        value: snap.consecutiveFailures,
        help: "Checkpoint failures since the last success.",
        type: "gauge",
      },
    );
    return reply.type("text/plain; version=0.0.4").send(renderMetrics(samples));
  });

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

  // ── The three pages whose backends already existed ────────────────────────
  //
  // analytics_query, cash_forecast and swarm_board have been callable from the
  // console since they were written and have never had a screen. That is a real
  // gap: a KPI you have to know the name of a tool to see is a KPI nobody looks
  // at, and the swarm's stage board is the one thing an operator needs to glance
  // at rather than ask about.
  //
  // Built as VIEWS in the existing console rather than as standalone HTML pages.
  // Three separate pages would each need their own copy of the auth handling,
  // the posture banner and the header, and the Phase 1 history in this file is
  // three rounds of a bug that came from duplicated view logic. Sharing the
  // shell is the cheaper mistake.
  //
  // Every verdict is computed HERE. The browser paints what it is told — the
  // same rule the tool-view cards follow, and for the same reason: two places
  // deciding what "underpaid" means is two places that can disagree.

  app.get("/api/analytics", async () => {
    try {
      const ctx = { services: { store } };
      const claims = loadClaims(ctx);
      const eras = loadEras(ctx);
      if (claims.length === 0 && eras.length === 0) {
        return { empty: true, note: "No claims or remittances are stored yet, so there is nothing to compute." };
      }
      const k = computeExecutiveKpis(claims, eras, loadAcks(store), Date.now());
      // Payer mix from the remittances, because that is where the money
      // actually landed. Computing it from claims would report what was BILLED
      // by payer, which is a different question and reads the same on a chart.
      const byPayer = new Map<string, { paid: number; charged: number; claims: number }>();
      for (const { payer, era } of eras) {
        for (const c of era.claims) {
          const row = byPayer.get(payer) ?? { paid: 0, charged: 0, claims: 0 };
          row.paid += c.paid;
          row.charged += c.charged;
          row.claims += 1;
          byPayer.set(payer, row);
        }
      }
      return {
        empty: false,
        kpis: {
          daysInAr: { value: k.daysInAr.days, note: k.daysInAr.note },
          acceptanceRate: { value: k.cleanClaim.acceptanceRate, note: k.cleanClaim.note },
          netCollectionRate: { value: k.netCollection.rate, note: k.netCollection.note },
        },
        payers: [...byPayer.entries()]
          .map(([payer, r]) => ({
            payer,
            claims: r.claims,
            charged: r.charged,
            paid: r.paid,
            // Null rather than 0 when nothing was charged. A zero here would
            // render as "this payer pays nothing", which is a different and
            // much more alarming claim than "there is no data".
            rate: r.charged > 0 ? r.paid / r.charged : null,
          }))
          .sort((a, b) => b.paid - a.paid)
          .slice(0, 25),
        counts: { claims: claims.length, remittances: eras.length },
      };
    } catch (err) {
      return { empty: true, note: err instanceof Error ? err.message : "Analytics could not be computed." };
    }
  });

  app.get("/api/forecast", async () => {
    try {
      const ctx = { services: { store } };
      const eras = loadEras(ctx);
      if (eras.length < 2) {
        // Said plainly rather than drawn as a flat line. A forecast from one
        // data point is a straight line through one point, and it looks exactly
        // as authoritative as a real one.
        return {
          empty: true,
          note: `Cash forecasting needs a history to extrapolate from. ${eras.length} remittance batch(es) are stored; at least 2 are needed, and the projection is not worth reading under about 8.`,
        };
      }
      // Weekly buckets of money actually received.
      const weekly = new Map<string, number>();
      for (const { era, receivedAt } of eras) {
        const week = new Date(receivedAt - (new Date(receivedAt).getUTCDay() * 86_400_000))
          .toISOString()
          .slice(0, 10);
        const paid = era.claims.reduce((n, c) => n + c.paid, 0);
        weekly.set(week, (weekly.get(week) ?? 0) + paid);
      }
      const series = [...weekly.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([week, paid]) => ({ week, paid }));
      const recent = series.slice(-8);
      const mean = recent.reduce((n, p) => n + p.paid, 0) / recent.length;
      return {
        empty: false,
        series,
        projection: {
          weeklyMean: mean,
          basis: recent.length,
          // The honesty that makes this usable: a mean over eight weeks of a
          // practice's real receipts is a defensible expectation; it is not a
          // model, and calling it one would invite decisions it cannot carry.
          note:
            `A mean of the last ${recent.length} week(s) of posted payments — not a model. It assumes next week ` +
            "looks like recent weeks, which is exactly the assumption that fails around a payer change, a holiday, " +
            "or a fee-schedule update.",
        },
      };
    } catch (err) {
      return { empty: true, note: err instanceof Error ? err.message : "Forecast could not be computed." };
    }
  });

  app.get("/api/swarm", async () => {
    try {
      const rows = store.db
        .prepare(
          `SELECT id, claim_ref, payer, stage, amount_cents, attempts, last_error, note, updated_at
           FROM blackboard ORDER BY updated_at DESC LIMIT 200`,
        )
        .all() as Array<{
          id: string; claim_ref: string; payer: string; stage: string;
          amount_cents: number; attempts: number; last_error: string; note: string; updated_at: number;
        }>;
      const byStage = new Map<string, { count: number; cents: number }>();
      for (const r of rows) {
        const cur = byStage.get(r.stage) ?? { count: 0, cents: 0 };
        cur.count += 1;
        cur.cents += r.amount_cents;
        byStage.set(r.stage, cur);
      }
      return {
        empty: rows.length === 0,
        note: rows.length === 0 ? "Nothing has been tracked on the swarm board yet." : "",
        // Money per stage, not just a count. Ten claims stuck in appeal is a
        // different morning depending on whether it is $400 or $40,000.
        stages: [...byStage.entries()].map(([stage, v]) => ({ stage, count: v.count, amount: v.cents / 100 })),
        items: rows.slice(0, 100).map((r) => ({
          id: r.id,
          claimRef: r.claim_ref,
          payer: r.payer,
          stage: r.stage,
          amount: r.amount_cents / 100,
          attempts: r.attempts,
          note: r.note,
        })),
        // Failures listed rather than counted, for the same reason dead-lettered
        // jobs are: a number tells nobody which claim stopped moving.
        failed: rows
          .filter((r) => r.last_error !== "")
          .map((r) => ({ id: r.id, claimRef: r.claim_ref, payer: r.payer, stage: r.stage, error: r.last_error, attempts: r.attempts })),
      };
    } catch (err) {
      return { empty: true, note: err instanceof Error ? err.message : "The swarm board could not be read." };
    }
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
  // ── OCR, applied at the door ───────────────────────────────────────────────
  // Type is detected first; only a document that came back unreadable BECAUSE
  // it has no text layer — a scan, or a photo of a remittance — is sent to OCR.
  // A short-but-real document is left alone: replacing a correct answer with a
  // machine's guess at the same words is a loss, not a gain.
  //
  // The provenance rides into the stored document, because a coder reading an
  // OCR'd allowed amount needs to know the digits were recognised rather than
  // read.
  const readable = async (extraction: Extraction, bytes: Buffer): Promise<Extraction> => {
    if (config.ingest.ocr === "off" || !needsOcr(extraction)) return extraction;
    try {
      const ocr = await runOcr(bytes, extraction.kind);
      return withOcrText(extraction, ocr);
    } catch {
      // Not installed, or it failed on this file. Keep the original refusal and
      // add the install hint — never return empty text as though the document
      // were blank, which is how a scanned EOB silently becomes nothing.
      return ocrUnavailableNote(extraction);
    }
  };

  /**
   * Work an archive's entries, pushing progress as it goes.
   *
   * `sessions.broadcast` rather than a new AgentEvent member: this happens with
   * no turn running, and AgentEvent is the vocabulary of a turn. ServerMessage
   * is already an open `{ type, ... }`, and the gateway already pushes an
   * ad-hoc frame this way for cancel.
   */
  const processArchive = async (
    archiveId: string,
    sessionId: string,
    expansion: ArchiveExpansion,
    actor: string,
  ): Promise<void> => {
    const total = expansion.entries.length;
    let processed = 0;
    let failed = 0;
    let ocrCount = 0;
    // Entries turned away by the PHI posture. Named separately from `failed`
    // because they are a different fact about the batch: a refusal is the gate
    // working, an unreadable file is the reader not managing, and a manifest
    // that conflates them tells an operator to go and fix the wrong thing.
    const refused: Array<{ name: string; kinds: string[] }> = [];

    const push = (current: string, status: string) =>
      sessions.broadcast(sessionId, {
        type: "archive_progress",
        archiveId,
        done: processed,
        total,
        failed,
        ocr: ocrCount,
        refused: refused.length,
        current,
        status,
      });

    push("", "processing");
    for (const entry of expansion.entries) {
      try {
        const before = entry.extraction;
        // `readable` returns the SAME object when it did nothing, so identity is
        // the cheapest honest test for "was this one OCR'd" — no flag to keep in
        // step, and it cannot drift from what actually happened.
        const after = await readable(before, entry.bytes);
        if (after !== before && after.readable) ocrCount += 1;
        // Screened per ENTRY, not per archive. A batch is exactly where a real
        // record slips in among synthetic ones, and refusing the whole zip
        // because one file of forty carried an identifier would push people
        // toward splitting the archive up until it went through — which is the
        // gate teaching them how to get around it.
        const entryScreen = screenIngress(after.phi, posture.posture);
        if (!entryScreen.accept) {
          refused.push({ name: entry.name, kinds: entryScreen.kinds });
          failed += 1;
        } else {
          saveDocument(store, sessionId, after, Date.now(), archiveId, actor);
          if (!after.readable) failed += 1;
        }
      } catch {
        // One bad entry must not abandon the other thirty-nine.
        failed += 1;
      }
      processed += 1;
      updateArchive(store, archiveId, { processed, failed, ocrCount });
      push(entry.name, "processing");
    }

    updateArchive(store, archiveId, { status: "completed", processed, failed, ocrCount });
    push("", "completed");
  };

  // What this deployment will and will not hold. Read by the console on load so
  // the banner states it before anyone uploads anything, rather than after —
  // a prospect learning the rule from a refusal has already handed over the file.
  app.get("/api/posture", async () => ({
    posture: posture.posture,
    source: posture.source,
    why: posture.why,
    // Reported, not hidden. A console served to anyone should say so on its own
    // face — the alternative is a visitor assuming they are inside something
    // private because it looks like an internal tool.
    publicAccess,
  }));

  app.post("/api/upload", async (req, reply) => {
    const q = req.query as { session?: string; filename?: string; ack?: string };
    const sessionId = String(q.session ?? "");
    if (!sessionId || !store.getSession(sessionId)) return reply.code(400).send({ error: "unknown session" });

    // ── Per-file acknowledgment, in production mode only ───────────────────
    // Before the body is read, let alone extracted or stored. A gate that runs
    // after extraction has already had the chart in memory and in a temporary
    // buffer, which is most of what it was meant to prevent.
    //
    // 428 rather than 403: the upload is permitted, once somebody says so. A
    // 403 would tell the client it was forbidden and a 400 would send a
    // developer hunting for a bug in their own code.
    const ack = uploadGate({
      mode: config.healthcare.phiMode,
      acknowledged: String(q.ack ?? "") === "1",
      filename: String(q.filename ?? "this file"),
    });
    if (!ack.allow) {
      return reply.code(ack.status).send({ error: ack.why, needsAcknowledgement: true });
    }

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

    // ── An archive expands to many documents ─────────────────────────────────
    // Returned 202 rather than processed inline: with OCR a scanned page costs
    // seconds, so forty of them is minutes and the browser's fetch would time
    // out long before the work finished. The console follows the run over the
    // socket it already has open.
    if (detectKind(filename, body) === "archive") {
      const expansion = expandArchive(body, { maxEntries: config.ingest.maxArchiveEntries });
      if (expansion.entries.length === 0) {
        return reply.code(400).send({
          error: "No readable documents in that archive.",
          skipped: expansion.skipped,
          notes: expansion.notes,
        });
      }
      // Captured from the REQUEST, before the background work starts. Reading
      // it later would be reading a request that has already been answered.
      const archiveActor = actorFor((req as { identity?: Identity }).identity);
      const archive = createArchive(
        store,
        sessionId,
        filename,
        expansion.entries.length,
        expansion.skipped,
        expansion.notes,
      );
      // Deliberately not awaited: the response goes out now and the work
      // continues. Errors are captured onto the archive row rather than
      // surfacing as an unhandled rejection that kills the gateway.
      void processArchive(archive.id, sessionId, expansion, archiveActor).catch((err) => {
        updateArchive(store, archive.id, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return reply.code(202).send({
        archiveId: archive.id,
        filename,
        total: expansion.entries.length,
        skipped: expansion.skipped.length,
        status: "processing",
      });
    }

    const extraction = await readable(extractDocument(filename, body), body);

    // Screened BEFORE saveDocument, which is the only thing that makes this a
    // refusal rather than a deletion. Storing it and removing it afterwards
    // would still mean the text was written to disk, replicated into the WAL,
    // and carried into the next R2 snapshot — the bytes having arrived is
    // precisely what the agreement is about.
    const screen = screenIngress(extraction.phi, posture.posture);
    if (!screen.accept) {
      return reply.code(422).send({
        error: screen.reason,
        refusedKinds: screen.kinds,
        filename,
        stored: false,
        posture: posture.posture,
      });
    }

    // The person, not the software. `identity` was put on the request by the
    // auth hook after Cloudflare Access verified the session; on loopback it is
    // absent and the store falls back to the agent, which is what a
    // single-operator laptop actually means. In public mode there is no person
    // to name, and `actorFor` writes "anonymous" rather than letting the row
    // read as though the agent did it.
    const actor = actorFor((req as { identity?: Identity }).identity);
    const doc = saveDocument(store, sessionId, extraction, Date.now(), "", actor);
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

  // ── Speech ─────────────────────────────────────────────────────────────────
  // Three engines sit behind one interface, and which one runs decides WHERE the
  // audio goes. The browser engine never reaches these routes at all — it
  // captures, recognises and speaks entirely in the page — so a request arriving
  // here under `engine: "browser"` is a misconfiguration worth naming rather
  // than quietly serving.

  /**
   * What the browser needs to know before it opens a microphone.
   *
   * Deliberately includes the PHI posture as a field rather than leaving the UI
   * to infer it from the engine name. The browser engine ships audio to Google,
   * and a console that does not say so on the screen where consent is given is
   * not obtaining consent to the thing that actually happens.
   */
  app.get("/api/speech/config", async () => {
    const s = config.speech;
    return {
      enabled: s.enabled,
      engine: s.engine,
      // The browser only does capture/playback itself for the browser engine;
      // otherwise it posts audio here and plays back what it gets.
      runsInBrowser: s.engine === "browser",
      mode: s.mode,
      wakeWord: s.wakeWord,
      speakReplies: s.speakReplies,
      maxSpokenChars: s.maxSpokenChars,
      requireAcknowledgement: s.consent.requireAcknowledgement,
      retainAudio: s.consent.retainAudio,
      status: speechStatus(s, process.env),
    };
  });

  /**
   * The hint vocabulary, built once and reused.
   *
   * Generic speech recognition has never heard of "Availity" or "J1885". The
   * practice's own billed codes and payers are the vocabulary that matters, and
   * they are already in the database — so the hint list is derived rather than
   * configured, and cannot drift from what the practice actually does.
   */
  let hintCache: { at: number; hints: string[] } | null = null;
  const HINT_TTL_MS = 5 * 60_000;
  const speechHints = (): string[] => {
    if (hintCache && Date.now() - hintCache.at < HINT_TTL_MS) return hintCache.hints;

    const codes: string[] = [];
    const payers: string[] = [];
    const providers: string[] = [];
    try {
      // loadClaims rather than a second hand-written query. Two loaders reading
      // the claim JSON differently is how the dashboard and a tool end up
      // disagreeing about what was billed, and the first version of this did
      // exactly that — it selected a `data` column that does not exist, and the
      // catch turned a schema mistake into a silently empty hint list.
      for (const row of loadClaims({ services: { store } })) {
        if (row.payer) payers.push(row.payer);
        if (row.claim.payer_name) payers.push(row.claim.payer_name);
        if (row.claim.billing_provider_name) providers.push(row.claim.billing_provider_name);
        for (const line of row.claim.service_lines ?? []) if (line.cpt_hcpcs) codes.push(line.cpt_hcpcs);
        for (const dx of row.claim.diagnoses ?? []) if (dx) codes.push(dx);
      }
    } catch {
      // An install with no claims yet is the common case, not an error. The
      // hint list is an optimisation and must never be able to break
      // transcription by being unavailable.
    }

    // Codes, payers and the BILLING provider only. Patient name, subscriber id
    // and date of birth are on the same claim record and are deliberately not
    // read: a hint list is sent to whichever engine is configured, and under
    // the browser and cloud engines that means handing a patient's surname to
    // a third party to improve its transcription. The identifier scan inside
    // buildHintVocabulary catches SSN and MBI shapes, but a surname has no
    // shape to catch — so it is excluded here, at the source, rather than
    // relied on to be filtered later.
    const hints = buildHintVocabulary({ codes, payers, providers });
    hintCache = { at: Date.now(), hints };
    return hints;
  };

  /** Gate, normalize and validate — then log the access if an identifier was spoken. */
  const refined = (text: string, sessionId: string, screen?: ScreenContext) => {
    const result = refineTranscript(text, {
      engine: config.speech.engine,
      universe: loadInstalledUniverse(),
      screen,
    });
    const event = accessEventForTranscript(result.gate, {
      sessionId: sessionId || "unknown",
      actor: "voice",
      engine: config.speech.engine,
    });
    if (event) {
      try {
        recordAccess(store, event);
      } catch {
        // Never fail the utterance because the log write failed; the console
        // surfaces chain gaps separately and losing the turn helps nobody.
      }
    }
    return { text: result.text, ask: result.ask, blocked: result.blocked, why: result.why };
  };

  /**
   * The browser engine recognises in the page, so its transcript would
   * otherwise skip the identifier gate and the code validation entirely — the
   * one engine that most needs both, since its audio has already left.
   */
  app.post("/api/speech/refine", async (req, reply) => {
    const raw = req.body;
    // A JSON body carries the screen with the utterance; a plain string is just
    // the utterance. Both are accepted so the simple case stays simple.
    let text = "";
    let screen: ScreenContext | undefined;
    if (Buffer.isBuffer(raw)) text = raw.toString("utf8");
    else if (typeof raw === "string") text = raw;
    else if (raw && typeof raw === "object") {
      const body = raw as { text?: string; screen?: ScreenContext };
      text = String(body.text ?? "");
      screen = body.screen;
    }
    if (!text.trim()) return reply.code(400).send({ error: "empty body" });
    const q = req.query as { session?: string };
    return refined(text, String(q.session ?? ""), screen);
  });

  // ── Worklist mode ──────────────────────────────────────────────────────────
  // A cursor over the open worklist, driven by about six words. The state
  // machine is pure and tested; this holds one session per conversation and
  // does the I/O. Sessions live in memory on purpose — a half-finished pass
  // through a worklist is not something to resume days later from a database,
  // because the worklist itself will have moved underneath it.

  const worklists = new Map<string, WorklistSession>();

  app.post("/api/speech/worklist/start", async (req) => {
    const q = req.query as { session?: string };
    const key = String(q.session ?? "default");
    let rows: Array<{ id: string; title: string; detail_json: string; due_at: number | null; kind: string }> = [];
    try {
      rows = store.db
        .prepare(
          "SELECT id, title, detail_json, due_at, kind FROM worklist_items WHERE status = 'open' ORDER BY priority DESC, COALESCE(due_at, 9e15) ASC LIMIT 50",
        )
        .all() as typeof rows;
    } catch {
      rows = [];
    }
    const now = Date.now();
    const session = startWorklist(
      rows.map((r) => {
        // The claim, the reason and the money live in detail_json; the row id is
        // internal. Speaking the row id spells out "S Y N dash W L dash S Y N
        // dash C L M dash one zero five eight" — an announcement nobody can
        // match against anything on screen, and the claim number is the one
        // thing a coder needs to hear.
        let detail: { claimId?: string; carc?: string; reason?: string; amount?: number } = {};
        try {
          detail = JSON.parse(r.detail_json || "{}");
        } catch {
          /* a row with unreadable detail still belongs on the list */
        }
        const reason = detail.carc && detail.reason ? `${detail.carc} ${detail.reason}` : (detail.reason ?? "");
        return {
          id: r.id,
          claimId: detail.claimId || r.id,
          label: r.title,
          reason,
          amount: typeof detail.amount === "number" ? detail.amount : undefined,
          dueInDays: r.due_at ? Math.round((r.due_at - now) / 86_400_000) : undefined,
        };
      }),
    );
    worklists.set(key, session);
    return { say: announceWorklistStart(session), active: session.active, total: session.items.length };
  });

  app.post("/api/speech/worklist/command", async (req, reply) => {
    const q = req.query as { session?: string };
    const key = String(q.session ?? "default");
    const session = worklists.get(key);
    if (!session) return reply.code(409).send({ error: "no worklist session — start one first" });
    const raw = req.body;
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : typeof raw === "string" ? raw : "";
    const step = applyCommand(session, parseWorklistCommand(text));
    if (step.ended) worklists.delete(key);
    else worklists.set(key, step.session);
    return { say: step.say, send: step.send, ended: step.ended ?? false, prompt: step.prompt };
  });

  /**
   * A code lookup from a PARTIAL utterance, while the speaker is still talking.
   *
   * Strictly local reads: a membership test against tables already in memory
   * plus a description from the same public CMS files the console already
   * serves. No tool runs, nothing is written, and a result about a code the
   * speaker turns out not to have said is simply discarded.
   */
  app.post("/api/speech/prefetch", async (req, reply) => {
    if (!config.speech.enabled || !config.speech.prefetch) return { hits: [], hint: "" };
    const raw = req.body;
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : typeof raw === "string" ? raw : "";
    if (!text.trim()) return reply.code(400).send({ error: "empty body" });
    const icd10 = icd10Table();
    const hcpcs = loadDataJson<Record<string, string>>("hcpcs.json");
    const hits = prefetchCodes(text, loadInstalledUniverse(), {
      describe: (code, kind) =>
        kind === "icd10" ? (icd10?.billable?.[code] ?? icd10?.headers?.[code]) : (hcpcs?.[code] ?? undefined),
    });
    return { hits, hint: describePrefetch(hits) };
  });

  // ── Spoken authorization ───────────────────────────────────────────────────
  // A voice interface removes the keyboard as an implicit factor: anyone in the
  // room can speak, and "approve" is one word. This gates the risky ones behind
  // a challenge.
  //
  // It authenticates KNOWLEDGE OF A PHRASE, not a voice. There is no acoustic
  // model here and nothing in this codebase claims one — anyone who overhears
  // the phrase can repeat it. It is a real factor against the person who
  // wandered past an unattended desk, and no defence at all against someone who
  // was in the room. The screen remains the authority either way.

  const authStates = new Map<string, AuthState>();
  const authFor = (key: string): AuthState => authStates.get(key) ?? initialAuthState();

  app.get("/api/speech/authorization", async (req) => {
    const q = req.query as { session?: string; tool?: string; risk?: string };
    const key = String(q.session ?? "default");
    const state = authFor(key);
    const needed = q.tool ? requiresAuthorization(String(q.risk ?? ""), String(q.tool)) : false;
    return {
      required: needed,
      authorized: isAuthorized(state, Date.now()),
      status: describeAuthState(state, Date.now()),
      // The secret lives where every other secret in this project lives: an env
      // var named in config, never in the database and never returned here.
      configured: Boolean(process.env.ORION_VOICE_AUTH_PHRASE),
    };
  });

  app.post("/api/speech/authorization/challenge", async (req) => {
    const q = req.query as { session?: string; kind?: string };
    const key = String(q.session ?? "default");
    const kind = q.kind === "digits" ? "digits" : "passphrase";
    const challenge = issueChallenge(kind, Date.now());
    authStates.set(key, { ...authFor(key), challenge });
    return { prompt: challenge.prompt, expiresAt: challenge.expiresAt };
  });

  app.post("/api/speech/authorization/verify", async (req, reply) => {
    const q = req.query as { session?: string };
    const key = String(q.session ?? "default");
    const raw = req.body;
    const spoken = Buffer.isBuffer(raw) ? raw.toString("utf8") : typeof raw === "string" ? raw : "";
    const secret = process.env.ORION_VOICE_AUTH_PHRASE ?? "";
    if (!secret) {
      return reply
        .code(503)
        .send({ ok: false, why: "No authorization phrase is configured. Set ORION_VOICE_AUTH_PHRASE to use spoken authorization." });
    }
    const result = verifyResponse(authFor(key), spoken, secret, Date.now());
    authStates.set(key, result.state);
    return { ok: result.ok, why: result.why };
  });

  /**
   * Does this utterance start with the wake word?
   *
   * Server-side so the tolerance rules — which decide whether a microphone
   * opens itself in a room with a patient in it — live beside their tests
   * rather than being reimplemented in the page. Called on FINAL recognition
   * results only, not on every interim revision.
   */
  app.post("/api/speech/wake", async (req, reply) => {
    const raw = req.body;
    const heard = Buffer.isBuffer(raw) ? raw.toString("utf8") : typeof raw === "string" ? raw : "";
    if (!heard.trim()) return reply.code(400).send({ error: "empty body" });
    return matchWake(heard, config.speech.wakeWord);
  });

  /** The recognizer hint list, in the shape the browser's SpeechGrammarList takes. */
  app.get("/api/speech/vocabulary", async () => {
    const hints = speechHints();
    return { count: hints.length, grammar: renderVocabularyPrompt(hints, "grammar") };
  });

  /**
   * One spoken clause for a tool call.
   *
   * Server-side because the verb map lives beside its tests, and because the
   * rule that tool ARGUMENTS are never spoken has to be enforced somewhere a
   * test can see it — an argument can carry an identifier and this ends up
   * coming out of a speaker in a room with other people in it.
   */
  app.get("/api/speech/narrate", async (req, reply) => {
    const q = req.query as { tool?: string };
    const tool = String(q.tool ?? "");
    if (!tool) return reply.code(400).send({ error: "no tool named" });
    if (!shouldNarrate(tool)) return { narrate: false, text: "" };
    return { narrate: true, text: narrateTool(tool) };
  });

  app.post("/api/speech/transcribe", async (req, reply) => {
    if (!config.speech.enabled) return reply.code(400).send({ error: "speech is disabled — set speech.enabled in config.json5" });
    const raw = req.body;
    const audio = Buffer.isBuffer(raw) ? raw : null;
    if (!audio || audio.length === 0) return reply.code(400).send({ error: "empty body" });
    const q = req.query as { mime?: string };
    try {
      const provider = createSpeechProvider(config.speech);
      if (provider.runsInBrowser) {
        return reply.code(400).send({ error: "engine is 'browser' — recognition happens in the page and must not be posted here" });
      }
      const result = await provider.transcribe(audio, String(q.mime ?? "audio/webm"), speechHints());
      if (result.error) return reply.code(502).send({ error: result.error });
      // Same pipeline the browser engine gets through /api/speech/refine. One
      // implementation, so a rule cannot hold on one path and not the other.
      return refined(result.text, String((req.query as { session?: string }).session ?? ""));
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/speech/synthesize", async (req, reply) => {
    if (!config.speech.enabled) return reply.code(400).send({ error: "speech is disabled — set speech.enabled in config.json5" });
    const raw = req.body;
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : typeof raw === "string" ? raw : "";
    if (!text.trim()) return reply.code(400).send({ error: "empty body" });
    try {
      const provider = createSpeechProvider(config.speech);
      if (provider.runsInBrowser) {
        return reply.code(400).send({ error: "engine is 'browser' — speech synthesis happens in the page" });
      }
      // Speak the SPOKEN form, not the markdown. Reading "**99213**" aloud as
      // "star star ninety-nine thousand two hundred thirteen" is the failure
      // this normalization exists to prevent.
      const spoken = toSpeakable(text, { maxChars: config.speech.maxSpokenChars });
      const result = await provider.synthesize(spoken.text);
      if ("error" in result) return reply.code(502).send({ error: result.error });
      return reply.header("content-type", result.mimeType).send(result.audio);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Markdown in, speech-ready text out — with no audio involved.
   *
   * The browser engine synthesises locally but must not speak raw markdown, and
   * the normalization is domain logic (a CPT code is read digit by digit) that
   * belongs on the server beside its tests rather than reimplemented in JS in
   * the page where nothing checks it.
   */
  app.post("/api/speech/speakable", async (req, reply) => {
    const raw = req.body;
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : typeof raw === "string" ? raw : "";
    if (!text.trim()) return reply.code(400).send({ error: "empty body" });
    const q = req.query as { verbosity?: string };
    // Brief is the default for SPEECH only — the screen still shows everything,
    // so this trades nothing away. A reply that is right and four paragraphs
    // long is, out loud, a reply nobody listened to the end of.
    const brief = (q.verbosity ?? config.speech.verbosity) === "brief";
    const full = toSpeakable(text, { maxChars: config.speech.maxSpokenChars });
    if (!brief) return full;
    const lead = speakableSummary(full.text);
    return {
      text: lead,
      truncated: lead.length < full.text.length,
      omitted: full.omitted,
      /** The console offers "tell me more"; there is no point offering it when there is no more. */
      hasMore: lead.length < full.text.length,
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
    return {
      providers: rows,
      warnings,
      credentialsPath: credentialsPath(),
      active: config.provider,
      // The ollama slot alone has an endpoint and a second catalogue, and both
      // are things somebody setting this up on their own machine has to be able
      // to change without a text editor.
      ollama: {
        baseUrl: config.providers.ollama.baseUrl ?? "",
        cloudModel: config.providers.ollama.cloudModel ?? "",
        model: config.providers.ollama.model,
      },
      configPath: providerConfigPath(),
    };
  });

  /**
   * Change which provider is active, and what model each one uses.
   *
   * Written to config.json5 AND applied to the running gateway. Applying it
   * live is possible because SessionManager builds a provider per turn from
   * this same config object rather than holding one from startup — so the next
   * turn uses the new setting, and nobody has to restart a server to try a
   * different model.
   *
   * Existing sessions keep the provider they were created with. That is
   * deliberate: a conversation whose model changes underneath it produces a
   * transcript where two different models answered, and no way to tell which
   * said what.
   */
  app.post("/api/providers/settings", async (req, reply) => {
    const body = (req.body ?? {}) as {
      provider?: string;
      models?: Record<string, string>;
      ollama?: { baseUrl?: string; cloudModel?: string };
    };
    const names: ProviderName[] = ["anthropic", "openai", "gemini", "ollama"];
    if (body.provider && !names.includes(body.provider as ProviderName)) {
      return reply.code(400).send({ error: `unknown provider "${body.provider}"` });
    }
    for (const name of Object.keys(body.models ?? {})) {
      if (!names.includes(name as ProviderName)) return reply.code(400).send({ error: `unknown provider "${name}"` });
    }

    try {
      writeProviderSettings(body);
    } catch (err) {
      return reply.code(500).send({ error: `could not write config: ${err instanceof Error ? err.message : String(err)}` });
    }

    // Mutate the live object too. Re-reading the file here would also pick up
    // any hand edits made since startup, which is a different and larger
    // change than the one the user asked for.
    for (const [name, model] of Object.entries(body.models ?? {})) {
      if (model.trim()) config.providers[name as ProviderName].model = model.trim();
    }
    if (body.ollama?.baseUrl !== undefined) config.providers.ollama.baseUrl = body.ollama.baseUrl.trim();
    // Empty is meaningful rather than missing: resolveOllamaTarget falls back
    // to `model` when cloudModel is falsy, which is exactly what "use the same
    // model on the cloud" should do.
    if (body.ollama?.cloudModel !== undefined) config.providers.ollama.cloudModel = body.ollama.cloudModel.trim();
    if (body.provider) config.provider = body.provider as ProviderName;

    return {
      ok: true,
      active: config.provider,
      applied: "New sessions use this immediately. Sessions already open keep the provider they started with.",
    };
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

  // ── The upgrade, and the 500 it used to be able to produce ────────────────
  //
  // OBSERVED ON THE LIVE DEPLOYMENT, recorded before it was forgotten: WebSocket
  // connections opened in quick succession while an agent turn is in flight
  // intermittently failed the UPGRADE with HTTP 500. Spaced-out connections
  // succeeded every time and plain HTTP stayed 200 throughout, so it is
  // saturation of the single container rather than a broken route.
  //
  // WHAT THIS CHANGE IS AND IS NOT. It does not claim to have found that root
  // cause — reproducing it needs the load the container was under. What it does
  // is remove this handler as a possible source and make the failure legible if
  // it is elsewhere: anything thrown while setting up a connection now closes
  // the socket with a stated reason instead of escalating into a 500 on the
  // upgrade, which is the least debuggable outcome available. A client that is
  // told "server busy" reconnects sensibly; a client that gets a 500 on an
  // upgrade retries in a loop.
  const MAX_SOCKETS = 200;
  let openSockets = 0;

  app.get("/ws", { websocket: true }, (socket, req) => {
    openSockets++;
    socket.on("close", () => {
      openSockets--;
    });
    if (openSockets > MAX_SOCKETS) {
      // 1013 is "try again later" — the code a browser's WebSocket client is
      // meant to back off on. A cap that is stated is a limit; a cap that
      // manifests as a 500 is a bug report.
      socket.close(1013, `too many open connections (${MAX_SOCKETS})`);
      return;
    }

    let initialSession: string | null = null;
    try {
      initialSession = new URL(req.url ?? "/ws", "http://localhost").searchParams.get("session");
    } catch {
      // A malformed query string is not a reason to fail the connection. The
      // client can still subscribe by message.
      initialSession = null;
    }
    try {
      if (initialSession) sessions.subscribe(initialSession, socket);
    } catch (err) {
      socket.close(1011, err instanceof Error ? err.message.slice(0, 120) : "subscribe failed");
      return;
    }

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
