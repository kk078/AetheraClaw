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
    await app.listen({ host: config.gateway.host, port: config.gateway.port });
    console.log(`AetheraClaw gateway: http://${config.gateway.host}:${config.gateway.port}`);
    console.log(`Provider: ${config.provider} · Workspace: ${config.workspaceRoot}`);
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

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
