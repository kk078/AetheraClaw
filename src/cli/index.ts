#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { loadConfig, configDir, apiKeyFor, envVarFor, resolveProvider } from "../config/config.js";
import { PROFILES, PROVIDER_TOOL_LIMITS, renderProfiles, selectTools } from "../tools/profiles.js";
import { resolveOllamaTarget } from "../providers/openai.js";
import { createProvider } from "../providers/index.js";
import { CASES } from "../eval/cases.js";
import { renderReport, runEval } from "../eval/run.js";
import { MemoryStore } from "../memory/store.js";
import { ToolRegistry } from "../tools/registry.js";
import { createShellTool } from "../tools/shell.js";
import { listDirTool, readFileTool, writeFileTool } from "../tools/fs.js";
import { webFetchTool, webSearchFallbackTool } from "../tools/web-fetch.js";
import { registerHealthcareTools } from "../tools/healthcare/index.js";
import {
  emailDraftTool,
  emailIngestTool,
  emailListTool,
  emailPollTool,
  emailRouteTool,
  emailSendTool,
} from "../channels/email/tools.js";
import { EmailChannel } from "../channels/email/channel.js";
import { reportGenerateTool } from "../reports/tools.js";
import {
  policyCompileTool,
  policyRuleAddTool,
  policyRuleListTool,
  policyRuleReviewTool,
  policyRuleTestTool,
  sentinelHistoryTool,
  sentinelRunTool,
} from "../compliance/tools.js";
import { auditAnchorTool, auditLogTool, auditRecordTool, auditVerifyTool } from "../audit/tools.js";
import {
  idrEvaluateTool,
  idrTrackTool,
  negotiationBriefTool,
  rateBenchmarkTool,
  rateIngestTool,
  ratePositionTool,
} from "../transparency/tools.js";
import {
  dtrAnswerTool,
  dtrPrefillTool,
  dtrQuestionnaireAddTool,
  paRequirementCheckTool,
  paResponseRecordTool,
  paRuleSetTool,
  paRulesLearnTool,
  paStatusTool,
  paSubmitTool,
} from "../fhir/tools.js";
import {
  a2aAttestTool,
  a2aKeySetupTool,
  a2aOpenTool,
  a2aReconcileTool,
  a2aSendTool,
  a2aShowTool,
  a2aVerifyTool,
} from "../a2a/tools.js";
import {
  cdiAnalyzeTool,
  cdiQueryDraftTool,
  cdiQueryFromFindingTool,
  cdiQueryListTool,
  cdiQueryRespondTool,
  cdiRuleAddTool,
  greenlightCheckTool,
} from "../cdi/tools.js";
import {
  trainingAnswerTool,
  trainingCaseAddTool,
  trainingDrillTool,
  trainingProgressTool,
} from "../training/tools.js";
import {
  hccRecaptureTool,
  qualityMeasuresTool,
  rafCalculateTool,
  suspectConditionsTool,
  suspectListTool,
  suspectReviewTool,
} from "../vbc/tools.js";
import {
  callEndTool,
  callHistoryTool,
  callListenTool,
  callNavigateTool,
  callPolicyTool,
  callPressTool,
  callSayTool,
  callStartTool,
  callTranscriptTool,
  ivrMapListTool,
  ivrMapSetTool,
} from "../voice/tools.js";
import {
  cashForecastTool,
  forecastChartTool,
  forecastHistoryTool,
  patientBalanceAddTool,
  patientLetterTool,
  patientOutreachTool,
  revenueModelFitTool,
  simulateScenarioTool,
} from "../simulation/tools.js";
import { renderVerify, verifyChain } from "../audit/chain.js";
import { loadAnchors, loadChain } from "../audit/store.js";
import {
  swarmAdvanceTool,
  swarmBoardTool,
  swarmFailTool,
  swarmHistoryTool,
  swarmPipelineTool,
  swarmPlanTool,
  swarmTrackTool,
} from "../swarm/tools.js";
import {
  portalAuditTool,
  portalClickTool,
  portalCloseTool,
  portalFieldsTool,
  portalFillTool,
  portalListTool,
  portalLoginTool,
  portalNavigateTool,
  portalReadTool,
  portalScreenshotTool,
} from "../tools/browser/tools.js";
import { SessionManager } from "../gateway/session-manager.js";
import { buildServer } from "../gateway/server.js";
import { startChat } from "./chat.js";
import { buildRegistry } from "../tools/build-registry.js";
import { resolveStore, tenancyRoot } from "../tenancy/resolve.js";
import { TenantRegistry } from "../tenancy/registry.js";
import { checkSlug, tenantDbPath } from "../tenancy/tenant.js";
import { retentionPlan } from "../support/tool-log.js";
import { VIEW_RETAIN_DAYS, viewRetentionPlan } from "../views/retention.js";

const program = new Command();
program.name("aetheraclaw").description("Self-hosted AI assistant for healthcare RCM and medical billing & coding");


program
  .command("serve")
  .description("Start the AetheraClaw gateway (HTTP + WebSocket + web UI)")
  .option("--port <port>", "port to listen on")
  .option("--host <host>", "host to bind (default 127.0.0.1)")
  .option("--provider <name>", "anthropic | openai | gemini | ollama")
  .option("--profile <name>", "tool profile — see `aetheraclaw providers`")
  .option("--tenant <slug>", "tenant to serve (multi-tenant installs only)")
  .action(async (opts: { port?: string; host?: string; provider?: string; profile?: string; tenant?: string }) => {
    const config = loadConfig();
    if (opts.port) config.gateway.port = Number(opts.port);
    if (opts.host) config.gateway.host = opts.host;
    if (opts.profile) config.toolProfile = opts.profile;

    const choice = resolveProvider(config, { explicit: opts.provider });
    if (choice.error) {
      console.error(choice.error);
      console.error("`aetheraclaw providers` shows which keys are present here.");
      process.exit(1);
    }
    config.provider = choice.provider;
    if (choice.substitutedFrom) {
      // Announced, not silent. Serving a different model than the config names
      // without saying so is how somebody debugs the wrong provider for an hour.
      console.log(
        `Provider: config says "${choice.substitutedFrom}" but ${envVarFor(choice.substitutedFrom)} is not set — using "${choice.provider}" instead.`,
      );
      console.log(`  Set provider: "${choice.provider}" in ~/.aetheraclaw/config.json5 to make it permanent, or pass --provider to override.`);
    }
    let resolved;
    try {
      resolved = resolveStore(config, opts.tenant);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    const { store, tenant } = resolved;
    const registry = buildRegistry(config, store);
    // The catalogue tools need the registry to search and invoke through it.
    // `tenant` is passed as a service, not as tool input — nothing the model
    // emits can reach it, which is the whole point of the binding.
    const sessions = new SessionManager(store, registry, config, { store, config, registry, tenant });
    const app = await buildServer({ config, store, sessions, registry });

    const email = new EmailChannel({
      config,
      store,
      handleUserMessage: (sessionId, text) => sessions.handleUserMessage(sessionId, text),
    });
    await email.start();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => void email.stop());
    }

    await app.listen({ host: config.gateway.host, port: config.gateway.port });
    console.log(`AetheraClaw gateway: http://${config.gateway.host}:${config.gateway.port}`);
    console.log(`Provider: ${config.provider} · Workspace: ${config.workspaceRoot}`);
    console.log(`SQLite: ${store.db.driver}`);
    // Amortized retention: once at startup rather than on every tool call, so
    // the log's cost does not scale with the log's size.
    const pruned = store.pruneToolCalls(retentionPlan(Date.now()));
    if (pruned > 0) console.log(`Tool log: pruned ${pruned} row(s) past retention`);
    const views = store.pruneToolViews(viewRetentionPlan(Date.now()));
    if (views.total > 0) {
      console.log(
        `Tool views: pruned ${views.total} row(s)` +
          ` (${views.orphaned} orphaned by deleted sessions, ${views.aged} past ${VIEW_RETAIN_DAYS}d, ${views.overCeiling} over the ceiling)`,
      );
    }
    if (config.tenancy.enabled) console.log(`Tenant: ${tenant.name} (${tenant.slug}) — isolated database`);
    const picked = selectTools(registry.specs(), config.toolProfile, config.provider);
    console.log(
      `Tools: ${picked.specs.length} loaded directly` +
        (picked.deferred.length > 0 ? ` + ${picked.deferred.length} via tool_search` : "") +
        ` of ${registry.specs().length} (profile "${config.toolProfile}")`,
    );
    for (const note of picked.notes) console.log(`  ! ${note}`);
    if (config.email.enabled) console.log(`Email channel: ${config.email.imap.user}@${config.email.imap.host}`);
  });

program
  .command("chat")
  .description("Interactive chat with the agent (requires a running gateway)")
  .option("--session <id>", "resume an existing session")
  .option("--new", "start a new session")
  .option("--gateway <url>", "gateway base URL (default from config)")
  .action(async (opts: { session?: string; new?: boolean; gateway?: string }) => {
    const config = loadConfig();
    const base = opts.gateway ?? `http://${config.gateway.host}:${config.gateway.port}`;
    await startChat({ base, sessionId: opts.session, forceNew: opts.new ?? false });
  });

program
  .command("sessions")
  .description("List sessions")
  .option("--gateway <url>", "gateway base URL")
  .action(async (opts: { gateway?: string }) => {
    const config = loadConfig();
    const base = opts.gateway ?? `http://${config.gateway.host}:${config.gateway.port}`;
    const res = await fetch(`${base}/api/sessions`);
    const rows = (await res.json()) as Array<{ id: string; title: string; updated_at: number }>;
    for (const row of rows) {
      console.log(`${row.id}  ${new Date(row.updated_at).toISOString()}  ${row.title || "(untitled)"}`);
    }
  });

program
  .command("tenants")
  .description("Manage tenants (multi-tenant installs). Each tenant is an isolated database file.")
  .argument("<action>", "list | create | suspend | activate")
  .argument("[slug]", "tenant slug — lowercase letters, digits and hyphens")
  .option("--name <name>", "display name (create only)")
  .action((action: string, slug: string | undefined, opts: { name?: string }) => {
    const config = loadConfig();
    if (!config.tenancy.enabled) {
      console.error(
        "Tenancy is disabled. Set tenancy.enabled in config.json5 to turn it on.\n" +
          "Turning it on does NOT move your existing data: the single-tenant database stays at its current path and tenants get new ones under tenants/<slug>/. There is no automatic migration, because a migration that guesses which practice owns which row is worse than none.",
      );
      process.exit(1);
    }
    const registry = new TenantRegistry(tenancyRoot());
    try {
      switch (action) {
        case "list": {
          const rows = registry.list();
          if (rows.length === 0) {
            console.log("No tenants. Create one with `aetheraclaw tenants create <slug> --name \"Practice name\"`.");
            break;
          }
          for (const t of rows) console.log(`${t.slug.padEnd(24)} ${t.status.padEnd(10)} ${t.name}`);
          break;
        }
        case "create": {
          if (!slug) throw new Error("A slug is required: `aetheraclaw tenants create <slug>`.");
          const check = checkSlug(slug);
          if (!check.ok) throw new Error(check.reason);
          const t = registry.create(opts.name ?? slug, check.slug);
          console.log(`Created ${t.slug} (${t.name}). Its database is at ${tenantDbPath(tenancyRoot(), t.slug)}.`);
          console.log("Serve it with: aetheraclaw serve --tenant " + t.slug);
          break;
        }
        case "suspend":
        case "activate": {
          if (!slug) throw new Error(`A slug is required: \`aetheraclaw tenants ${action} <slug>\`.`);
          if (!registry.bySlug(slug)) throw new Error(`No tenant with slug "${slug}".`);
          registry.setStatus(slug, action === "suspend" ? "suspended" : "active");
          console.log(
            action === "suspend"
              ? `${slug} suspended. No data is served for it — not even read-only, because read-only still discloses. Its database file is left on disk untouched.`
              : `${slug} activated.`,
          );
          break;
        }
        default:
          throw new Error(`Unknown action "${action}". Actions: list, create, suspend, activate.`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      registry.close();
    }
  });

program
  .command("audit")
  .description("Verify the tamper-evident audit log")
  .argument("<action>", "verify")
  .option("--tenant <slug>", "tenant whose log to verify (multi-tenant installs only)")
  .action((action: string, opts: { tenant?: string }) => {
    if (action !== "verify") {
      console.error(`Unknown audit action "${action}". The only action is: verify`);
      process.exit(2);
    }
    const { store } = resolveStore(loadConfig(), opts.tenant);
    const anchors = loadAnchors(store);
    const result = verifyChain(loadChain(store), anchors);
    console.log(renderVerify(result, anchors.length));
    // Exit non-zero on failure so this can run in a cron job or a pre-commit
    // hook and actually stop something.
    process.exit(result.ok ? 0 : 1);
  });

/** What model each provider would actually use right now. */
function modelFor(config: ReturnType<typeof loadConfig>, name: "anthropic" | "openai" | "gemini" | "ollama"): string {
  if (name !== "ollama") return config.providers[name].model;
  const target = resolveOllamaTarget(config.providers.ollama, process.env.OLLAMA_API_KEY);
  return `${target.model} (${target.cloud ? "cloud" : "local"})`;
}

program
  .command("providers")
  .description("Show which model providers are usable here, and how many tools each can take")
  .action(() => {
    const config = loadConfig();
    const store = new MemoryStore(path.join(configDir(), "aetheraclaw.db"));
    const all = buildRegistry(config, store).specs();

    // Stated per provider, because the registry size genuinely differs by one:
    // Anthropic has a server-side web search, so web_search is not registered
    // for it. One number here would be wrong for three of the four rows below.
    console.log(`Registry: ${all.length} tools under the configured provider ("${config.provider}").`);
    console.log("Anthropic is one smaller than the rest — it has a server-side web search, so web_search is not registered for it.\n");
    const width = 11;
    console.log(
      ["provider".padEnd(width), "key", "model".padEnd(22), "cap", ...PROFILES.map((p) => p.name.slice(0, 6).padStart(7))].join("  "),
    );
    for (const name of ["anthropic", "openai", "gemini", "ollama"] as const) {
      const key = apiKeyFor(name) ? " set " : name === "ollama" ? "local" : " --  ";
      // The registry is provider-dependent: web_search is registered only for
      // providers that lack a server-side one, i.e. everything except Anthropic.
      // Counting every row against the CONFIGURED provider's registry made this
      // table off by one for every other row — under-reporting on a machine
      // configured for Anthropic, over-reporting on one configured for anything
      // else. Each row is now counted against the registry that provider would
      // actually get.
      const forProvider = buildRegistry({ ...config, provider: name }, store).specs();
      const counts = PROFILES.map((p) => {
        const s = selectTools(forProvider, p.name, name);
        const mark = s.droppedByLimit.length ? "*" : s.deferred.length ? "+" : "";
        return `${s.specs.length}${mark}`.padStart(7);
      });
      console.log(
        [
          (config.provider === name ? `\u2192 ${name}` : `  ${name}`).padEnd(width),
          key,
          modelFor(config, name).padEnd(22),
          String(PROVIDER_TOOL_LIMITS[name]).padStart(3),
          ...counts,
        ].join("  "),
      );
    }
    console.log("\n+ loaded directly; the rest reachable via tool_search / tool_invoke, so every tool is usable.\n* dropped outright \u2014 not reachable at all.\n");
    console.log(renderProfiles());
    console.log(
      `\nActive: provider "${config.provider}", profile "${config.toolProfile}". Override per run with \`serve --provider X --profile Y\`.`,
    );
    store.close();
  });

program
  .command("eval")
  .description("Measure whether the model reaches the right tool — especially the ones deferred behind tool_search")
  .option("--provider <name>", "anthropic | openai | gemini | ollama")
  .option("--profile <name>", "tool profile")
  .option("--case <id>", "run one case by id")
  .action(async (opts: { provider?: string; profile?: string; case?: string }) => {
    const config = loadConfig();
    if (opts.profile) config.toolProfile = opts.profile;
    const choice = resolveProvider(config, { explicit: opts.provider });
    if (choice.error) {
      console.error(choice.error);
      process.exit(1);
    }
    config.provider = choice.provider;

    const store = new MemoryStore(path.join(configDir(), "aetheraclaw.db"));
    const registry = buildRegistry(config, store);
    const provider = createProvider(config, config.provider);
    const cases = opts.case ? CASES.filter((c) => c.id === opts.case) : CASES;
    if (cases.length === 0) {
      console.error(`No case "${opts.case}". Available: ${CASES.map((c) => c.id).join(", ")}`);
      process.exit(2);
    }

    console.log(`Evaluating ${cases.length} case(s) against ${config.provider} / ${modelFor(config, config.provider)}.`);
    console.log("Only tool_search and tool_describe execute; every other tool is stubbed.\n");
    const report = await runEval(
      { provider, registry, config, services: { store, config, registry } },
      cases,
      // Streamed as they finish rather than held to the end: a serial run against
      // a slow local model takes minutes, and a silent terminal reads as a hang.
      (r) => console.log(`${r.passed ? "pass" : "FAIL"}  ${r.case.id.padEnd(24)} ${String(r.ms).padStart(6)}ms  ${r.reached.join(" → ") || "(no tool)"}`),
    );
    console.log(renderReport(report));
    store.close();
    process.exit(report.passed === report.total ? 0 : 1);
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
