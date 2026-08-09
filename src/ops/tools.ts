import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "../tools/registry.js";
import type { Config } from "../config/config.js";
import type { MemoryStore } from "../memory/store.js";
import { dataDir, datasetStatuses } from "../tools/healthcare/datasets.js";
import { loadEras } from "../tools/healthcare/analytics.js";
import { TenantRegistry } from "../tenancy/registry.js";
import { tenancyRoot } from "../tenancy/resolve.js";
import { tenantDbPath } from "../tenancy/tenant.js";
import { resolveOllamaTarget } from "../providers/openai.js";
import { analyzeBoundary, analyzeTenant, renderIntegrity, type IntegrityFinding, type TenantDbFacts } from "./integrity.js";
import { analyzeDataset, hashOf, renderHealth, type DatasetFacts, type HealthFinding } from "./dataset-health.js";
import { analyzeTelemetry, parsePs, renderTelemetry, type OllamaSnapshot } from "./ollama.js";
import { collectDenialObservations, detectPolicyDrift, renderDrift, withDenominators } from "./drift.js";
import type { CodeSetId } from "../tools/healthcare/updates/release-calendar.js";
import { openDatabase } from "../memory/sqlite.js";
import { confinePath } from "../tools/path-guard.js";
import { ClaimSchema, type ClaimInput } from "../tools/healthcare/x12/837.js";
import { batchHeal, renderBatchHeal } from "./batch-heal.js";
import {
  analyzeRejections,
  renderRejectionAnalysis,
  type AcceptanceObservation,
  type RejectionObservation,
} from "./rejection-analysis.js";
import { buildRca, diagnoseTrace, renderTicketNote } from "./rca.js";
import { classifyFailure, diagnoseRecord, type Diagnosis } from "../support/fmea.js";
import { assembleTrace, type TraceResult } from "../support/trace.js";
import { collectTraceEvents } from "../support/tools.js";
import { WRAPPER_TOOLS } from "../support/tool-log.js";
import { buildBatchHealView } from "../views/batch-heal.js";

// Ops tools are read-only by construction. Nothing here writes to a tenant
// database, restarts a process, or mutates a dataset — a diagnostic tool that
// can also change things is one the support team has to think twice about
// running during an incident, which is exactly when it needs to be reflexive.

/** Tables the schema is expected to have created; a sample, not the full list. */
const EXPECTED_TABLES = ["sessions", "messages", "claims", "remittances", "worklist_items", "audit_chain", "phi_access_log", "tool_views"];

function pragmaValue(db: ReturnType<typeof openDatabase>, sql: string): unknown {
  try {
    const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
    return row ? Object.values(row)[0] : undefined;
  } catch {
    return undefined;
  }
}

function inspectDb(slug: string, dbPath: string): TenantDbFacts {
  const facts: TenantDbFacts = {
    slug,
    path: dbPath,
    exists: fs.existsSync(dbPath),
    mode: null,
    sizeBytes: 0,
    walBytes: 0,
    integrity: "ok",
    foreignKeyViolations: 0,
    pageCount: 0,
    freelistCount: 0,
    missingTables: [],
  };
  if (!facts.exists) return facts;

  const stat = fs.statSync(dbPath);
  facts.sizeBytes = stat.size;
  // Windows does not model POSIX permissions, so reporting a mode there would be
  // reporting an artefact of the emulation rather than a fact about the file.
  facts.mode = process.platform === "win32" ? null : stat.mode;
  const wal = `${dbPath}-wal`;
  if (fs.existsSync(wal)) facts.walBytes = fs.statSync(wal).size;

  // Opened read-only through the same adapter the app uses, so a driver
  // difference cannot make the sweep disagree with production.
  const db = openDatabase(dbPath);
  try {
    facts.integrity = String(pragmaValue(db, "PRAGMA integrity_check") ?? "unknown");
    facts.pageCount = Number(pragmaValue(db, "PRAGMA page_count") ?? 0);
    facts.freelistCount = Number(pragmaValue(db, "PRAGMA freelist_count") ?? 0);
    try {
      facts.foreignKeyViolations = (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length;
    } catch {
      facts.foreignKeyViolations = 0;
    }
    const present = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name),
    );
    facts.missingTables = EXPECTED_TABLES.filter((t) => !present.has(t));
  } finally {
    db.close();
  }
  return facts;
}

export const tenantIntegrityTool = defineTool({
  name: "ops_tenant_integrity_check",
  description:
    "Sweep every tenant database for corruption, schema drift, foreign-key violations, WAL growth, page fragmentation and — most importantly — the isolation boundary itself: file permissions, and whether two tenants resolve to the same file. In the database-per-tenant design the boundary IS the filesystem, so a world-readable file or a shared path is a disclosure no amount of correct application code prevents. Read-only.",
  schema: z.object({
    tenant: z.string().optional().describe("Check one tenant; omit for all"),
  }),
  execute: async (input, ctx) => {
    const config = ctx.services.config as Config | undefined;
    const findings: IntegrityFinding[] = [];

    if (!config?.tenancy.enabled) {
      const store = ctx.services.store as MemoryStore | undefined;
      if (!store) return { content: "No database in this context.", isError: true };
      // Single-tenant still benefits from the corruption and permission checks;
      // there is simply no boundary to verify.
      const single = inspectDb("primary", path.join(tenancyRoot(), "aetheraclaw.db"));
      findings.push(...analyzeTenant(single));
      return {
        content: [
          renderIntegrity({ tenantsChecked: 1, findings }),
          "",
          "Tenancy is disabled, so there is one database and no isolation boundary to verify. The corruption, permission and fragmentation checks above still apply.",
        ].join("\n"),
      };
    }

    const registry = new TenantRegistry(tenancyRoot());
    try {
      const tenants = registry.list().filter((t) => !input.tenant || t.slug === input.tenant);
      if (tenants.length === 0) {
        return { content: input.tenant ? `No tenant with slug "${input.tenant}".` : "No tenants registered.", isError: Boolean(input.tenant) };
      }
      const paths = tenants.map((t) => ({ slug: t.slug, path: tenantDbPath(tenancyRoot(), t.slug) }));
      findings.push(...analyzeBoundary(paths, path.join(tenancyRoot(), "tenants")));
      for (const p of paths) findings.push(...analyzeTenant(inspectDb(p.slug, p.path)));
      return { content: renderIntegrity({ tenantsChecked: tenants.length, findings }) };
    } finally {
      registry.close();
    }
  },
});

/** Which release cadence governs each installed file, where one does. */
const GOVERNED_BY: Record<string, CodeSetId> = {
  "ncci-ptp.json": "ncci",
  "mue.json": "ncci",
  "hcpcs.json": "hcpcs",
  "mpfs.json": "mpfs",
  "mpfs-cf.json": "mpfs",
  "gpci.json": "mpfs",
};

export const datasetHealthTool = defineTool({
  name: "ops_dataset_health",
  description:
    "Check the installed reference datasets: size, SHA-256, modification date, and whether each predates the edition currently in effect per the published CMS release cadence. Hashes detect change between your own snapshots — they are NOT verification against CMS, which publishes no manifest hash and refuses automated fetches, so a tool claiming to check upstream would be checking nothing while looking like proof.",
  schema: z.object({
    as_of: z.string().regex(/^\d{8}$/).optional().describe("YYYYMMDD; defaults to today"),
    record_hashes: z
      .boolean()
      .default(false)
      .describe("Store the current hashes as the known-good baseline, so the next sweep reports drift from here"),
  }),
  assessRisk: (input) => ({
    level: input.record_hashes ? "confirm" : "safe",
    reason: input.record_hashes ? "record current dataset hashes as the baseline" : "read-only dataset scan",
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    const asOf = input.as_of ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const known = store ? loadKnownHashes(store) : {};
    const findings: HealthFinding[] = [];
    const current: Record<string, string> = {};
    let checked = 0;

    for (const ds of datasetStatuses()) {
      const p = path.join(dataDir(), ds.file);
      const facts: DatasetFacts = {
        file: ds.file,
        installed: ds.installed,
        sizeBytes: 0,
        modifiedAt: 0,
        sha256: "",
        knownSha256: known[ds.file],
        codeSet: GOVERNED_BY[ds.file],
      };
      if (ds.installed) {
        const stat = fs.statSync(p);
        facts.sizeBytes = stat.size;
        facts.modifiedAt = stat.mtimeMs;
        facts.sha256 = hashOf(fs.readFileSync(p));
        current[ds.file] = facts.sha256;
      }
      checked++;
      findings.push(...analyzeDataset(facts, asOf));
    }

    const parts = [renderHealth({ checked, findings, asOf })];
    if (input.record_hashes && store) {
      saveKnownHashes(store, current);
      parts.push("", `Recorded ${Object.keys(current).length} hash(es) as the baseline. The next sweep reports any change from here.`);
    }
    return { content: parts.join("\n") };
  },
});

function loadKnownHashes(store: MemoryStore): Record<string, string> {
  try {
    const row = store.db.prepare("SELECT value FROM ops_baseline WHERE key = 'dataset_hashes'").get() as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveKnownHashes(store: MemoryStore, hashes: Record<string, string>): void {
  store.db
    .prepare("INSERT OR REPLACE INTO ops_baseline (key, value, updated_at) VALUES ('dataset_hashes', ?, ?)")
    .run(JSON.stringify(hashes), Date.now());
}

export const ollamaTelemetryTool = defineTool({
  name: "ops_ollama_telemetry",
  description:
    "Report what Ollama actually exposes about the running model: which models are loaded, how much of each is resident in VRAM versus spilled to system RAM, the context length it was loaded with, and the probe round-trip. Resident-VRAM share and context length are the two figures that explain slow generation. GPU utilisation and token rates are not shown because the API does not expose them — reading them from nvidia-smi would describe the whole machine rather than this process.",
  schema: z.object({}),
  execute: async (_input, ctx) => {
    const config = ctx.services.config as Config | undefined;
    const target = resolveOllamaTarget(config?.providers.ollama ?? { model: "qwen3" }, process.env.OLLAMA_API_KEY);
    // /api/ps sits beside the OpenAI-compatible /v1 path, not under it.
    const base = target.baseUrl.replace(/\/v1\/?$/, "");
    const snapshot: OllamaSnapshot = {
      reachable: false,
      baseUrl: base,
      cloud: target.cloud,
      models: [],
      probeMs: 0,
    };

    const started = Date.now();
    try {
      const res = await fetch(`${base}/api/ps`, {
        headers: process.env.OLLAMA_API_KEY ? { authorization: `Bearer ${process.env.OLLAMA_API_KEY}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      snapshot.probeMs = Date.now() - started;
      if (!res.ok) {
        snapshot.error = `HTTP ${res.status}`;
      } else {
        snapshot.reachable = true;
        snapshot.models = parsePs(await res.json());
      }
    } catch (err) {
      snapshot.probeMs = Date.now() - started;
      snapshot.error = err instanceof Error ? err.message : String(err);
    }

    const findings = analyzeTelemetry(snapshot, config?.contextTokenBudget ?? 150_000);
    return { content: renderTelemetry(snapshot, findings), isError: !snapshot.reachable };
  },
});

export const policyDriftTool = defineTool({
  name: "ops_policy_drift_check",
  description:
    "Detect a payer silently changing its edit rules, by comparing each payer/CARC pair's recent denial rate against its own earlier rate over the stored remittance history. Uses a two-proportion test with a minimum denominator in both periods, because with small counts ordinary variation is indistinguishable from a policy change — and an alerting tool nobody trusts gets muted, which is how the real change goes unnoticed too. Pairs too thin to test are counted and reported rather than silently dropped.",
  schema: z.object({
    payer: z.string().optional().describe("Substring filter on payer name"),
    with_denominators: z
      .boolean()
      .default(true)
      .describe("Measure each code as a RATE over all that payer's adjudicated claims. False counts occurrences only, which cannot see a code that stopped appearing."),
  }),
  execute: async (_input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "No database in this context.", isError: true };

    let eras = loadEras(store);
    if (_input.payer) {
      const needle = _input.payer.toLowerCase();
      eras = eras.filter((e) => e.payer.toLowerCase().includes(needle));
    }
    const observations = _input.with_denominators ? withDenominators(eras) : collectDenialObservations(eras);
    return { content: renderDrift(detectPolicyDrift(observations)) };
  },
});

export const batchHealPreviewTool = defineTool({
  name: "ops_batch_heal_preview",
  description:
    "Run the auto-heal engine across a whole batch of stored claims and report the capacity answer rather than a list of defects: how many go out as they are, how many a safe repair covers, and how many NEED A HUMAN — the last being the only number that is work. Repairs and review items are grouped by rule, because one rule hitting many claims is usually a single upstream fault rather than many independent ones. Nothing is written; there is deliberately no batch apply.",
  schema: z.object({
    status: z.string().optional().describe("Only claims with this stored status (e.g. 'draft', 'ready')"),
    limit: z.number().int().min(1).max(2000).default(500),
    show: z.number().int().min(1).max(100).default(15).describe("How many needs-review claim ids to list"),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "No database in this context.", isError: true };

    const rows = (
      input.status
        ? store.db.prepare("SELECT id, claim_json FROM claims WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(input.status, input.limit)
        : store.db.prepare("SELECT id, claim_json FROM claims ORDER BY created_at DESC LIMIT ?").all(input.limit)
    ) as Array<{ id: string; claim_json: string }>;

    const claims: ClaimInput[] = [];
    let unreadable = 0;
    for (const r of rows) {
      // A claim row that will not parse cannot be healed, and counting it as
      // clean would put it in the "goes out tonight" number — the one figure
      // somebody acts on without reading further.
      const parsed = ClaimSchema.safeParse(safeJson(r.claim_json));
      if (parsed.success) claims.push(parsed.data);
      else unreadable++;
    }

    if (claims.length === 0) {
      return {
        content: [
          input.status ? `No stored claims with status "${input.status}".` : "No stored claims.",
          unreadable > 0 ? `${unreadable} row(s) did not parse as a claim and were excluded rather than counted as clean.` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    const summary = batchHeal(claims);
    const truncated = rows.length === input.limit;
    const parts = [renderBatchHeal(summary, input.show)];
    if (unreadable > 0) {
      parts.push(
        "",
        `${unreadable} stored row(s) did not parse as a claim and are excluded from every number above — not counted as clean. Trace one with support_trace_claim to see what wrote it.`,
      );
    }
    if (truncated) {
      parts.push("", `Hit the ${input.limit}-claim limit, so the batch may be larger than what was previewed.`);
    }
    return {
      content: parts.join("\n"),
      view: {
        kind: "batch_heal",
        data: buildBatchHealView(summary, {
          scope: input.status ? `status ${input.status}` : "all stored claims",
          excluded: unreadable,
          truncated,
        }),
      },
    };
  },
});

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const rejectionAnalysisTool = defineTool({
  name: "ops_rejection_analysis",
  description:
    "Read every 277CA outcome together — acceptances banked to filing proof, rejections opened as worklist items — and detect EMERGING EDITS: a clearinghouse or payer front end that tightened a rule without announcing it. Grouped by payer and status code, tested with a minimum denominator in both halves so a spike below a real sample is not reported as a change. A status code that never appeared and now appears repeatedly is reported on its count alone, because applying a proportion test there would suppress exactly the case this exists for.",
  schema: z.object({
    payer: z.string().optional().describe("Substring filter on payer name"),
    days: z.number().int().min(1).max(1095).default(180).describe("How far back to read acknowledgments"),
    limit: z.number().int().min(1).max(50).default(12).describe("Rejection groups to list"),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "No database in this context.", isError: true };

    const since = Date.now() - input.days * 86_400_000;
    const needle = input.payer?.toLowerCase();
    const rejections: RejectionObservation[] = [];
    const acceptances: AcceptanceObservation[] = [];

    for (const r of store.db
      .prepare("SELECT detail_json, created_at FROM worklist_items WHERE kind = 'rejection' AND created_at >= ?")
      .all(since) as Array<{ detail_json: string; created_at: number }>) {
      const detail = safeJson(r.detail_json) as { payer?: string; statuses?: string[] } | null;
      if (!detail) continue;
      const payer = detail.payer || "(unnamed)";
      if (needle && !payer.toLowerCase().includes(needle)) continue;
      // The triplet is "category:statusCode:entity" — the status code is the
      // edit, the category only says it is a rejection, which we already know.
      for (const triplet of detail.statuses ?? []) {
        const [, statusCode = "", entity = ""] = triplet.split(":");
        if (!statusCode) continue;
        rejections.push({ payer, statusCode, entity, at: r.created_at });
      }
    }

    for (const r of store.db
      .prepare("SELECT payer, recorded_at FROM filing_proof WHERE source LIKE '%277CA%' AND recorded_at >= ?")
      .all(since) as Array<{ payer: string; recorded_at: number }>) {
      const payer = r.payer || "(unnamed)";
      if (needle && !payer.toLowerCase().includes(needle)) continue;
      acceptances.push({ payer, at: r.recorded_at });
    }

    return { content: renderRejectionAnalysis(analyzeRejections(rejections, acceptances), input.limit) };
  },
});

export const generateRcaTool = defineTool({
  name: "ops_generate_rca",
  description:
    "Compose a Root Cause Analysis document for an incident: the failing step, the classified root cause with the evidence quoted, the claim's lifecycle timeline including the stages that never happened, a severity derived from whether data is at risk or a filing clock is running, and remediation steps addressed to a named owner rather than a bare tier number. Emits a ticket-ready payload with a fingerprint derived from the CAUSE, so a recurrence updates the existing ticket instead of opening a duplicate. Markdown, optionally written to the workspace.",
  schema: z.object({
    claim_id: z.string().optional().describe("Include this claim's lifecycle timeline, and make it the incident subject"),
    failures: z.array(z.string()).optional().describe("Classify this text instead of reading the tool-call log"),
    hours: z.number().int().min(1).max(24 * 90).default(24).describe("How far back to read the tool-call log"),
    tool: z.string().optional().describe("Only this tool's failures"),
    output_path: z.string().optional().describe("Workspace-relative path to write the Markdown to"),
  }),
  assessRisk: (input) => ({
    level: input.output_path ? "confirm" : "safe",
    reason: input.output_path ? `write RCA document to ${input.output_path}` : "read-only analysis",
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    const now = Date.now();

    let diagnoses: Diagnosis[] = [];
    let affected = 0;
    if (input.failures && input.failures.length > 0) {
      diagnoses = input.failures.map(classifyFailure);
      affected = input.failures.length;
    } else if (store) {
      const since = now - input.hours * 3_600_000;
      const failed = store
        .loadToolCalls(since, { tool: input.tool, limit: 500 })
        .filter((r) => !r.ok && !WRAPPER_TOOLS.has(r.toolName));
      diagnoses = failed.map(diagnoseRecord);
      affected = failed.length;
    }

    let trace: TraceResult | undefined;
    let ambient: Diagnosis[] | undefined;
    if (input.claim_id && store) {
      trace = assembleTrace(input.claim_id, collectTraceEvents(store, input.claim_id));
      const fromClaim = diagnoseTrace(trace, now);
      if (fromClaim) {
        // The claim's own record outranks anything in the tool-call log. A claim
        // that sat ninety days unacknowledged is not a network incident because
        // Ollama was down that afternoon, and letting the log set the category
        // sends a billing problem to engineering.
        ambient = diagnoses;
        diagnoses = [fromClaim];
        affected = Math.max(1, trace.events.filter((e) => e.adverse).length);
      }
    }

    if (diagnoses.length === 0 && !trace) {
      return {
        content: [
          `Nothing to analyse: no failures in the last ${input.hours}h${input.tool ? ` for ${input.tool}` : ""}, and no claim named.`,
          "",
          "That is a real answer rather than an empty document. An RCA assembled from no evidence would read exactly like one assembled from evidence, which is the failure mode worth avoiding here. Pass `claim_id`, pass `failures`, or widen `hours`.",
        ].join("\n"),
      };
    }

    const report = buildRca({
      incidentRef: input.claim_id ?? `${input.tool ?? "all tools"}, last ${input.hours}h`,
      diagnoses,
      ambient,
      trace,
      affected,
      generatedAt: now,
    });

    const parts = [report.markdown, "", renderTicketNote(report.ticket)];
    if (input.output_path) {
      const p = confinePath(ctx.workspaceRoot, input.output_path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, report.markdown);
      parts.push("", `Written to ${input.output_path}.`);
    }
    return { content: parts.join("\n") };
  },
});

export const OPS_TOOLS = [
  tenantIntegrityTool,
  datasetHealthTool,
  ollamaTelemetryTool,
  policyDriftTool,
  batchHealPreviewTool,
  rejectionAnalysisTool,
  generateRcaTool,
];
