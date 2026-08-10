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
  announceWorklistStart,
  applyCommand,
  parseWorklistCommand,
  startWorklist,
  type WorklistSession,
} from "../speech/worklist-mode.js";
import { icd10Table, loadDataJson } from "../tools/healthcare/datasets.js";

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
  const processArchive = async (archiveId: string, sessionId: string, expansion: ArchiveExpansion): Promise<void> => {
    const total = expansion.entries.length;
    let processed = 0;
    let failed = 0;
    let ocrCount = 0;

    const push = (current: string, status: string) =>
      sessions.broadcast(sessionId, {
        type: "archive_progress",
        archiveId,
        done: processed,
        total,
        failed,
        ocr: ocrCount,
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
        saveDocument(store, sessionId, after, Date.now(), archiveId);
        if (!after.readable) failed += 1;
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
      void processArchive(archive.id, sessionId, expansion).catch((err) => {
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
      configured: Boolean(process.env.AETHERACLAW_VOICE_AUTH_PHRASE),
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
    const secret = process.env.AETHERACLAW_VOICE_AUTH_PHRASE ?? "";
    if (!secret) {
      return reply
        .code(503)
        .send({ ok: false, why: "No authorization phrase is configured. Set AETHERACLAW_VOICE_AUTH_PHRASE to use spoken authorization." });
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
