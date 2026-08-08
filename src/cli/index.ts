#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { loadConfig, configDir, apiKeyFor } from "../config/config.js";
import { PROFILES, PROVIDER_TOOL_LIMITS, renderProfiles, selectTools } from "../tools/profiles.js";
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

const program = new Command();
program.name("aetheraclaw").description("Self-hosted AI assistant for healthcare RCM and medical billing & coding");

export function buildRegistry(config: ReturnType<typeof loadConfig>, store: MemoryStore): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createShellTool(config.shell));
  registry.registerAll([readFileTool, writeFileTool, listDirTool, webFetchTool]);
  if (config.provider !== "anthropic") registry.register(webSearchFallbackTool);
  registerHealthcareTools(registry, { config, store });
  registry.registerAll([
    emailPollTool,
    emailListTool,
    emailRouteTool,
    emailDraftTool,
    emailSendTool,
    emailIngestTool,
    reportGenerateTool,
    portalListTool,
    portalLoginTool,
    portalNavigateTool,
    portalReadTool,
    portalFieldsTool,
    portalFillTool,
    portalClickTool,
    portalScreenshotTool,
    portalCloseTool,
    portalAuditTool,
    swarmTrackTool,
    swarmBoardTool,
    swarmPlanTool,
    swarmAdvanceTool,
    swarmFailTool,
    swarmHistoryTool,
    swarmPipelineTool,
    policyCompileTool,
    policyRuleAddTool,
    policyRuleListTool,
    policyRuleReviewTool,
    policyRuleTestTool,
    sentinelRunTool,
    sentinelHistoryTool,
    auditRecordTool,
    auditVerifyTool,
    auditAnchorTool,
    auditLogTool,
    revenueModelFitTool,
    cashForecastTool,
    simulateScenarioTool,
    forecastChartTool,
    forecastHistoryTool,
    patientBalanceAddTool,
    patientOutreachTool,
    patientLetterTool,
    callPolicyTool,
    callStartTool,
    callListenTool,
    callSayTool,
    callPressTool,
    callNavigateTool,
    callEndTool,
    callTranscriptTool,
    callHistoryTool,
    ivrMapSetTool,
    ivrMapListTool,
    rafCalculateTool,
    hccRecaptureTool,
    suspectConditionsTool,
    suspectListTool,
    suspectReviewTool,
    qualityMeasuresTool,
    rateIngestTool,
    rateBenchmarkTool,
    ratePositionTool,
    negotiationBriefTool,
    idrEvaluateTool,
    idrTrackTool,
    paRequirementCheckTool,
    paRuleSetTool,
    paRulesLearnTool,
    dtrQuestionnaireAddTool,
    dtrPrefillTool,
    dtrAnswerTool,
    paSubmitTool,
    paStatusTool,
    paResponseRecordTool,
    a2aKeySetupTool,
    a2aAttestTool,
    a2aVerifyTool,
    a2aOpenTool,
    a2aSendTool,
    a2aShowTool,
    a2aReconcileTool,
    cdiRuleAddTool,
    cdiAnalyzeTool,
    cdiQueryDraftTool,
    cdiQueryFromFindingTool,
    cdiQueryListTool,
    cdiQueryRespondTool,
    greenlightCheckTool,
    trainingCaseAddTool,
    trainingDrillTool,
    trainingAnswerTool,
    trainingProgressTool,
  ]);
  return registry;
}

program
  .command("serve")
  .description("Start the AetheraClaw gateway (HTTP + WebSocket + web UI)")
  .option("--port <port>", "port to listen on")
  .option("--host <host>", "host to bind (default 127.0.0.1)")
  .option("--provider <name>", "anthropic | openai | gemini | ollama")
  .option("--profile <name>", "tool profile — see `aetheraclaw providers`")
  .action(async (opts: { port?: string; host?: string; provider?: string; profile?: string }) => {
    const config = loadConfig();
    if (opts.port) config.gateway.port = Number(opts.port);
    if (opts.host) config.gateway.host = opts.host;
    if (opts.provider) config.provider = opts.provider as typeof config.provider;
    if (opts.profile) config.toolProfile = opts.profile;

    if (!apiKeyFor(config.provider) && config.provider !== "ollama") {
      console.error(
        `No API key for provider "${config.provider}". Set ${config.provider.toUpperCase()}_API_KEY, or pass --provider with one you have. \`aetheraclaw providers\` shows what is configured.`,
      );
      process.exit(1);
    }
    const store = new MemoryStore(path.join(configDir(), "aetheraclaw.db"));
    const registry = buildRegistry(config, store);
    const sessions = new SessionManager(store, registry, config, { store, config });
    const app = await buildServer({ config, store, sessions });

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
    const picked = selectTools(registry.specs(), config.toolProfile, config.provider);
    console.log(`Tools: ${picked.specs.length} of ${registry.specs().length} (profile "${config.toolProfile}")`);
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
  .command("audit")
  .description("Verify the tamper-evident audit log")
  .argument("<action>", "verify")
  .action((action: string) => {
    if (action !== "verify") {
      console.error(`Unknown audit action "${action}". The only action is: verify`);
      process.exit(2);
    }
    const store = new MemoryStore(path.join(configDir(), "aetheraclaw.db"));
    const anchors = loadAnchors(store);
    const result = verifyChain(loadChain(store), anchors);
    console.log(renderVerify(result, anchors.length));
    // Exit non-zero on failure so this can run in a cron job or a pre-commit
    // hook and actually stop something.
    process.exit(result.ok ? 0 : 1);
  });

program
  .command("providers")
  .description("Show which model providers are usable here, and how many tools each can take")
  .action(() => {
    const config = loadConfig();
    const store = new MemoryStore(path.join(configDir(), "aetheraclaw.db"));
    const all = buildRegistry(config, store).specs();

    console.log(`Registry: ${all.length} tools.\n`);
    const width = 11;
    console.log(
      ["provider".padEnd(width), "key", "model".padEnd(22), "cap", ...PROFILES.map((p) => p.name.slice(0, 6).padStart(7))].join("  "),
    );
    for (const name of ["anthropic", "openai", "gemini", "ollama"] as const) {
      const key = apiKeyFor(name) ? " set " : name === "ollama" ? "local" : " --  ";
      const counts = PROFILES.map((p) => {
        const s = selectTools(all, p.name, name);
        return `${s.specs.length}${s.droppedByLimit.length ? "*" : ""}`.padStart(7);
      });
      console.log(
        [
          (config.provider === name ? `\u2192 ${name}` : `  ${name}`).padEnd(width),
          key,
          config.providers[name].model.padEnd(22),
          String(PROVIDER_TOOL_LIMITS[name]).padStart(3),
          ...counts,
        ].join("  "),
      );
    }
    console.log("\n* some tools were dropped to fit the cap \u2014 pick a narrower profile.\n");
    console.log(renderProfiles());
    console.log(
      `\nActive: provider "${config.provider}", profile "${config.toolProfile}". Override per run with \`serve --provider X --profile Y\`.`,
    );
    store.close();
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
