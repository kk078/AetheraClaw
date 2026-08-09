#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import { loadConfig, configDir, apiKeyFor, envVarFor, expandHome, resolveProvider, type ProviderName } from "../config/config.js";
import { PROFILES, PROVIDER_TOOL_LIMITS, renderProfiles, resolveToolLimit, selectTools } from "../tools/profiles.js";
import { buildBudget, renderBudget } from "../tools/budget.js";
import { resolveOllamaTarget } from "../providers/openai.js";
import { createProvider } from "../providers/index.js";
import { CASES } from "../eval/cases.js";
import { renderReport, runEval } from "../eval/run.js";
import { describeManifest, installReference, managedDbPath, readManifest, verifyInstalled, writeManifest } from "../tools/healthcare/reference-store.js";
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
import { listDocuments, purgeDocuments } from "../ingest/store.js";
import { ALL_PROVIDERS, evaluateSet, importFromEnv, promptHidden, renderList } from "./auth.js";
import { credentialsPath, knownSecretValues, maskKey, removeCredential, setCredential } from "../config/credentials.js";
import { redactSecrets } from "../config/secrets.js";
import { discoverLocal, renderDiscovery } from "../providers/discover.js";
import { writeLocalProvider } from "../config/write.js";
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
  .option("--workspace <path>", "where files are written this run — overrides workspaceRoot in config.json5")
  .action(async (opts: { port?: string; host?: string; provider?: string; profile?: string; tenant?: string; workspace?: string }) => {
    const config = loadConfig();
    if (opts.port) config.gateway.port = Number(opts.port);
    if (opts.host) config.gateway.host = opts.host;
    if (opts.profile) config.toolProfile = opts.profile;
    // The workspace is WHERE THE USER SAYS, not a fixed ~/aetheraclaw-workspace.
    // Point it at the practice's real folder and generated appeals, superbills
    // and posting files land where somebody will actually look for them.
    //
    // What does NOT move is the confinement. Everything the model writes still
    // has to resolve inside this root — path-guard.ts blocks ../, absolute
    // paths and symlink escapes. Choosing the root is the user's; escaping it
    // is nobody's, because "write wherever the prompt says" is one injected
    // instruction away from writing anywhere on the disk.
    if (opts.workspace) {
      // Resolved to an absolute path before anything uses it. A relative root
      // is a confinement root that moves with the working directory, and it
      // also makes the console footer read "./practice-folder", which tells
      // nobody where their appeals actually landed.
      config.workspaceRoot = path.resolve(expandHome(opts.workspace));
      fs.mkdirSync(config.workspaceRoot, { recursive: true });
    }

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
    const picked = selectTools(registry.specs(), config.toolProfile, config.provider, config.toolLimits[config.provider]);
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
        const s = selectTools(forProvider, p.name, name, config.toolLimits[name]);
        const mark = s.droppedByLimit.length ? "*" : s.deferred.length ? "+" : "";
        return `${s.specs.length}${mark}`.padStart(7);
      });
      // The EFFECTIVE limit, not the shipped default. Once toolLimits exists the
      // two differ, and a table whose "cap" column said 64 beside an "all"
      // column reading 224 is a table contradicting itself.
      const decided = resolveToolLimit(name, config.toolLimits[name]);
      const capCell = `${decided.limit}${decided.note ? "!" : config.toolLimits[name] ? "\u00b7" : ""}`;
      console.log(
        [
          (config.provider === name ? `\u2192 ${name}` : `  ${name}`).padEnd(width),
          key,
          modelFor(config, name).padEnd(22),
          capCell.padStart(4),
          ...counts,
        ].join("  "),
      );
    }
    console.log("\n+ loaded directly; the rest reachable via tool_search / tool_invoke, so every tool is usable.\n* dropped outright \u2014 not reachable at all.\n\u00b7 cap raised in config; ! requested above the provider's hard API limit and clamped.\n");
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


// ── documents ────────────────────────────────────────────────────────────────
// This deployment persists the text extracted from uploads, so it needs a way
// to empty that. A store of document content with no purge is a liability that
// only grows, and "delete the database" is not a retention policy.

const documents = program.command("documents").description("Uploaded document text held in the database");

documents
  .command("list")
  .description("What is stored, and which entries carry identifier-shaped text")
  .action(() => {
    const config = loadConfig();
    const { store } = resolveStore(config);
    const rows = listDocuments(store);
    if (rows.length === 0) {
      console.log("No documents stored.");
      return;
    }
    for (const d of rows) {
      const when = new Date(d.createdAt).toISOString().slice(0, 16).replace("T", " ");
      const phi = d.phi.length > 0 ? `  identifiers: ${d.phi.map((p) => `${p.kind}×${p.count}`).join(", ")}` : "";
      console.log(`${d.id}  ${when}  ${d.filename} — ${d.kind}${d.readable ? "" : " (not readable)"}${phi}`);
    }
    const withPhi = rows.filter((d) => d.phi.length > 0).length;
    console.log(`\n${rows.length} document(s), ${withPhi} carrying identifier-shaped text.`);
  });

documents
  .command("purge")
  .description("Delete stored document text")
  .option("--older-than <days>", "Only entries older than this many days")
  .option("--session <id>", "Only entries from one session")
  .option("--yes", "Do it, rather than reporting what would go")
  .action((opts: { olderThan?: string; session?: string; yes?: boolean }) => {
    const config = loadConfig();
    const { store } = resolveStore(config);
    // Validate before computing a cutoff. A non-numeric value like "30d" made
    // Number() return NaN, so `!olderThanMs` was true (deleting EVERYTHING) and
    // the cutoff was dropped as falsy, purging every document during a run meant
    // to trim ones older than 30 days — an irreversible delete of the only copy.
    let olderThanMs: number | undefined;
    if (opts.olderThan !== undefined) {
      const days = Number(opts.olderThan);
      if (!Number.isFinite(days) || days < 0) {
        console.error(`--older-than must be a number of days (e.g. 30), got "${opts.olderThan}". Nothing was deleted.`);
        process.exitCode = 1;
        return;
      }
      olderThanMs = Date.now() - days * 86_400_000;
    }

    // A dry run by default. This deletes the only copy of text somebody may
    // still need, and the flag costs one word.
    const scope = listDocuments(store).filter(
      (d) => (!olderThanMs || d.createdAt <= olderThanMs) && (!opts.session || d.sessionId === opts.session),
    );
    if (!opts.yes) {
      console.log(`${scope.length} document(s) would be deleted. Re-run with --yes to do it.`);
      for (const d of scope.slice(0, 20)) console.log(`  ${d.id}  ${d.filename}`);
      if (scope.length > 20) console.log(`  … and ${scope.length - 20} more`);
      return;
    }
    const r = purgeDocuments(store, { ...(olderThanMs ? { olderThanMs } : {}), ...(opts.session ? { sessionId: opts.session } : {}) });
    console.log(`Deleted ${r.deleted} document(s), ${r.charactersRemoved.toLocaleString()} characters of extracted text.`);
    console.log("Each delete is recorded in the PHI access log and anchored to the audit chain.");
  });


// ── auth ─────────────────────────────────────────────────────────────────────
// Keys used to arrive only as environment variables, which means re-exporting
// them in every shell and on every reboot — and the commonest way people make
// that stick is pasting a key into a dotfile that later gets committed.


// ── tools ────────────────────────────────────────────────────────────────────

const toolsCmd = program.command("tools").description("The tool catalogue and what sending it costs");

toolsCmd
  .command("budget")
  .description("What each tool-limit setting costs in context, measured from the real registry")
  .option("--provider <name>", "which provider's limits to report against")
  .option("--context <tokens>", "the model's context window (default 128000)")
  .action((opts: { provider?: string; context?: string }) => {
    const config = loadConfig();
    const provider = (opts.provider ?? config.provider) as ProviderName;
    const contextWindow = Number(opts.context ?? 128000);
    const store = new MemoryStore(path.join(configDir(), "aetheraclaw.db"));
    const specs = buildRegistry({ ...config, provider }, store).specs();
    const decision = resolveToolLimit(provider, config.toolLimits[provider]);
    console.log(renderBudget(buildBudget(specs, contextWindow), { provider, contextWindow, current: decision.limit }));
    if (decision.note) console.log(`\n! ${decision.note}`);
    store.close();
  });

const auth = program.command("auth").description("Provider API keys and local model servers");

auth
  .command("set [provider]")
  .description("Store an API key for a provider (prompts without echoing)")
  .option("--key <key>", "the key, non-interactively — WARNING: this lands in your shell history")
  .option("--note <text>", "a reminder of which key this is")
  .option("--all", "walk through every provider in turn")
  .action(async (provider: string | undefined, opts: { key?: string; note?: string; all?: boolean }) => {
    const targets = opts.all ? ALL_PROVIDERS : provider ? [provider as ProviderName] : [];
    if (targets.length === 0) {
      console.error("Name a provider, or pass --all. Choices: " + ALL_PROVIDERS.join(", "));
      process.exit(2);
    }
    for (const p of targets) {
      if (!ALL_PROVIDERS.includes(p)) {
        console.error(`Unknown provider "${p}". Choices: ${ALL_PROVIDERS.join(", ")}`);
        process.exit(2);
      }
    }
    if (opts.key && targets.length > 1) {
      console.error("--key sets one provider; drop --all or set them one at a time.");
      process.exit(2);
    }

    for (const p of targets) {
      let key = opts.key ?? "";
      if (opts.key) {
        console.log("! --key was given on the command line, so this key is now in your shell history.");
        console.log(`  Clear it, or prefer the prompt: aetheraclaw auth set ${p}`);
      } else {
        if (p === "ollama") {
          console.log("Ollama needs a key ONLY for Ollama Cloud. For a local server leave this blank and press Enter.");
        }
        key = await promptHidden(`${p} API key (input hidden, Enter to skip): `);
        if (!key) {
          console.log(`  skipped ${p}`);
          continue;
        }
      }
      const outcome = evaluateSet(p, key);
      for (const m of outcome.messages) console.log(`  ${m}`);
      if (!outcome.stored) continue;
      const setResult = setCredential(p, key, opts.note);
      for (const w of setResult.warnings) console.log(`  ⚠ ${w}`);
      console.log(`  stored ${p} (${maskKey(key)}) in ${credentialsPath()}`);
    }
    console.log("\nNothing above printed your key back. `aetheraclaw auth list` shows the mask.");
  });

auth
  .command("list")
  .description("Which providers have a key, where it came from, and nothing more of it")
  .action(() => console.log(renderList()));

auth
  .command("remove <provider>")
  .description("Delete a stored key")
  .action((provider: string) => {
    if (!ALL_PROVIDERS.includes(provider as ProviderName)) {
      console.error(`Unknown provider "${provider}". Choices: ${ALL_PROVIDERS.join(", ")}`);
      process.exit(2);
    }
    const gone = removeCredential(provider as ProviderName);
    console.log(gone ? `Removed the stored ${provider} key.` : `No stored key for ${provider}.`);
    const still = process.env[provider === "anthropic" ? "ANTHROPIC_API_KEY" : `${provider.toUpperCase()}_API_KEY`];
    if (still) console.log("Note: an environment variable still provides a key for this provider in this shell.");
  });

auth
  .command("import-env")
  .description("Store every key already exported in this shell, so you can delete the exports")
  .action(() => {
    const { imported, skipped } = importFromEnv();
    if (imported.length === 0) {
      console.log("No provider keys are exported in this shell, so nothing was imported.");
      return;
    }
    console.log(`Imported: ${imported.join(", ")}`);
    if (skipped.length) console.log(`Not set in this environment: ${skipped.join(", ")}`);
    console.log(`\nStored in ${credentialsPath()} (mode 600).`);
    console.log("The environment still WINS while those variables are exported — remove them from your shell profile to use the stored copies.");
  });

auth
  .command("discover")
  .description("Find a local model server — Ollama, LM Studio, llama.cpp, vLLM")
  .option("--host <host>", "host to probe (default 127.0.0.1)")
  .action(async (opts: { host?: string }) => {
    const servers = await discoverLocal(opts.host ?? "127.0.0.1");
    console.log(renderDiscovery(servers));
  });

auth
  .command("local")
  .description("Point AetheraClaw at a local model server and make it the active provider")
  .option("--base-url <url>", "OpenAI-compatible base URL, e.g. http://127.0.0.1:11434/v1")
  .option("--model <name>", "model the server should serve")
  .action(async (opts: { baseUrl?: string; model?: string }) => {
    let baseUrl = opts.baseUrl;
    let model = opts.model;

    // Discover rather than demand: if the user did not say, look, and only ask
    // when looking found nothing.
    if (!baseUrl) {
      const servers = await discoverLocal();
      if (servers.length === 0) {
        console.error(renderDiscovery(servers));
        process.exit(1);
      }
      baseUrl = servers[0].baseUrl;
      model = model ?? servers[0].models[0];
      console.log(`Found ${servers[0].name} at ${baseUrl}.`);
    }
    if (!model) {
      console.error("No model named, and the server reported none. Pull or load a model, then pass --model.");
      process.exit(1);
    }

    writeLocalProvider(baseUrl, model);
    console.log(`Config updated: provider "ollama", model "${model}", baseUrl "${baseUrl}".`);
    console.log("No key is stored — a local server needs none, and nothing leaves this machine.");
    console.log("\nStart it with: aetheraclaw serve");
  });

auth
  .command("test [provider]")
  .description("Actually call the provider and report what came back")
  .action(async (provider: string | undefined) => {
    const config = loadConfig();
    const targets = provider ? [provider as ProviderName] : ALL_PROVIDERS.filter((p) => Boolean(apiKeyFor(p)) || p === "ollama");
    if (targets.length === 0) {
      console.log("No provider has a key. Add one with `aetheraclaw auth set <provider>`.");
      return;
    }
    for (const p of targets) {
      const started = Date.now();
      try {
        const prov = createProvider({ ...config, provider: p }, p);
        let text = "";
        for await (const ev of prov.streamTurn({
          system: "Reply with the single word: ready",
          messages: [{ role: "user", content: [{ type: "text", text: "ready?" }] }],
          tools: [],
          maxTokens: 32,
        })) {
          if (ev.type === "text_delta") text += ev.text;
        }
        console.log(`  ${p.padEnd(10)} OK    ${Date.now() - started}ms  ${JSON.stringify(text.trim().slice(0, 40))}`);
      } catch (err) {
        // The message can carry the key in a URL or a header echo, so it goes
        // through the same scrub that protects tool output.
        const raw = err instanceof Error ? err.message : String(err);
        const msg = redactSecrets(raw, knownSecretValues().map((value) => ({ value, label: "api-key" })));
        console.log(`  ${p.padEnd(10)} FAIL  ${Date.now() - started}ms  ${msg.slice(0, 160)}`);
      }
    }
  });

const reference = program.command("reference").description("Manage the attached reference code database");

reference
  .command("install <file>")
  .description("Copy a SQLite reference database into the installation, compacting and recording it")
  .option("--note <text>", "What this file is and where it came from")
  .option("--edition <pairs>", "Editions you have verified, e.g. icd10cm=20251001,hcpcs=20260101")
  .action((file: string, opts: { note?: string; edition?: string }) => {
    const editions: Record<string, string> = {};
    for (const pair of (opts.edition ?? "").split(",").filter(Boolean)) {
      const [k, v] = pair.split("=");
      if (k && v) editions[k.trim()] = v.trim();
    }
    console.log(`Reading ${path.resolve(file)} …`);
    console.log("Copying with VACUUM INTO — this compacts the file and fails on a corrupt source rather than copying the corruption.\n");
    try {
      const m = installReference(file, { note: opts.note, editions: editions as never });
      console.log(describeManifest(m));
      console.log("");
      console.log("The original is untouched; delete it when you are satisfied. Nothing was written to the repository — this file is not committed, and CPT content in it cannot be redistributed.");
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

reference
  .command("status")
  .description("What is installed, when it was imported, and which code sets are past their release date")
  .action(() => {
    const m = readManifest();
    if (!m) {
      console.log(`Nothing installed at ${managedDbPath()}.`);
      console.log("Install one with `aetheraclaw reference install <file>`, or leave a file where it is and set healthcare.referenceDbPath to read it in place.");
      return;
    }
    console.log(describeManifest(m));
  });

reference
  .command("verify")
  .description("Check the installed database still matches the manifest recorded at import")
  .action(() => {
    const r = verifyInstalled();
    console.log(r.message);
    process.exit(r.ok ? 0 : 1);
  });

reference
  .command("edition <pairs>")
  .description("Record which edition a code set in the installed file is, e.g. icd10cm=20251001")
  .action((pairs: string) => {
    const m = readManifest();
    if (!m) {
      console.error("Nothing installed. Run `aetheraclaw reference install <file>` first.");
      process.exit(1);
    }
    for (const pair of pairs.split(",").filter(Boolean)) {
      const [k, v] = pair.split("=");
      if (!k || !v) continue;
      // Recorded, not verified. This is somebody asserting what they checked,
      // and the staleness report says so rather than implying the file was read.
      (m.editions as Record<string, string>)[k.trim()] = v.trim();
    }
    writeManifest(m);
    console.log(describeManifest(m));
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
