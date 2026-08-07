#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { loadConfig, configDir } from "../config/config.js";
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
  ]);
  return registry;
}

program
  .command("serve")
  .description("Start the AetheraClaw gateway (HTTP + WebSocket + web UI)")
  .option("--port <port>", "port to listen on")
  .option("--host <host>", "host to bind (default 127.0.0.1)")
  .action(async (opts: { port?: string; host?: string }) => {
    const config = loadConfig();
    if (opts.port) config.gateway.port = Number(opts.port);
    if (opts.host) config.gateway.host = opts.host;
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

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
