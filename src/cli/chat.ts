import readline from "node:readline";
import WebSocket from "ws";
import { render } from "./render.js";

export async function startChat(opts: { base: string; sessionId?: string; forceNew: boolean }): Promise<void> {
  let sessionId = opts.sessionId;
  if (!sessionId || opts.forceNew) {
    const res = await fetch(`${opts.base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }).catch(() => {
      throw new Error(`Cannot reach gateway at ${opts.base} — start it with: aetheraclaw serve`);
    });
    const session = (await res.json()) as { id: string };
    sessionId = session.id;
    console.log(`New session: ${sessionId}`);
  }

  const wsUrl = `${opts.base.replace(/^http/, "ws")}/ws?session=${sessionId}`;
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(new Error(`WebSocket failed: ${err.message}`)));
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
  let pendingApproval: string | null = null;
  let turnRunning = false;

  ws.on("message", (raw: Buffer) => {
    const event = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    const outcome = render(event);
    if (outcome === "approval") {
      pendingApproval = event.approvalId as string;
      rl.setPrompt("approve? [y/N]> ");
      rl.prompt();
    } else if (outcome === "turn_done") {
      turnRunning = false;
      rl.setPrompt("you> ");
      rl.prompt();
    }
  });

  ws.on("close", () => {
    console.log("\n[gateway connection closed]");
    process.exit(0);
  });

  console.log(`Connected. Session ${sessionId}. Ctrl+C to exit.`);
  rl.prompt();

  rl.on("line", (line) => {
    const text = line.trim();
    if (pendingApproval) {
      const approved = /^y(es)?$/i.test(text);
      ws.send(JSON.stringify({ type: "approval_response", approvalId: pendingApproval, approved }));
      pendingApproval = null;
      rl.setPrompt(turnRunning ? "" : "you> ");
      return;
    }
    if (!text) {
      rl.prompt();
      return;
    }
    turnRunning = true;
    ws.send(JSON.stringify({ type: "user_message", sessionId, text }));
  });

  let sigints = 0;
  rl.on("SIGINT", () => {
    sigints++;
    if (sigints >= 2 || !turnRunning) {
      ws.close();
      process.exit(0);
    }
    ws.send(JSON.stringify({ type: "cancel", sessionId }));
    console.log("\n[cancel requested — Ctrl+C again to exit]");
  });
}
