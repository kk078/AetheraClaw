import { spawn } from "node:child_process";
import { z } from "zod";
import { defineTool } from "./registry.js";
import { mentionsSecretFile } from "../config/secrets.js";

// Read-only command prefixes that are auto-approved under "unsafe-only" policy.
const SAFE_PREFIXES = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "grep",
  "find",
  "git status",
  "git log",
  "git diff",
  "git show",
  "echo",
  "which",
  "date",
];

const DANGEROUS_PATTERNS = [/\bsudo\b/, /\brm\s+-rf\b/, /curl[^|]*\|\s*(ba)?sh/, /\bmkfs\b/, /\bdd\s+if=/];

// Anything that lets a SECOND command run under `bash -lc`: the shell control
// operators and redirects, plus the newline and carriage return. The line
// breaks are the ones that were missed — bash treats `\n` as a full command
// separator identical to `;`, and it sits between the first token and the first
// space, so a scan that began after the first space (as this once did) stepped
// straight over it and classified `ls\nrm -rf ~` as a read-only `ls`.
const COMMAND_SEPARATORS = /[;&|<>`$\n\r]/;

// `find` earns its place on the read-only list for `find . -name …`, but find
// is a small language of its own: `-delete` removes files and
// `-exec`/`-execdir`/`-ok`/`-okdir` run an arbitrary program — neither uses a
// single shell metacharacter, so both slip past COMMAND_SEPARATORS. A find that
// can act is pulled back out of "safe" and made to ask.
const FIND_ACTIONS = /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprintf?|fls)\b/;

export function assessCommandRisk(command: string): { level: "safe" | "confirm"; reason: string } {
  const trimmed = command.trim();
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) return { level: "confirm", reason: `potentially destructive command: ${trimmed}` };
  }

  // `cat` is on the auto-approved list below, so `cat ~/.orion/credentials.json`
  // used to run with no prompt at all. The VALUES are redacted from the result
  // either way (see config/secrets.ts), which is the control that actually
  // holds — but redaction is silent, and a credential read should be something
  // a person finds out about rather than something contained quietly.
  if (mentionsSecretFile(trimmed)) {
    return { level: "confirm", reason: `command names a credentials file: ${trimmed.slice(0, 200)}` };
  }

  // A separator anywhere means there is a second command, and its safety is not
  // decided by the first token — so it always asks. Checked before the prefix
  // match, over the whole string, because the whole point is that `ls; rm` is
  // not an `ls`.
  if (COMMAND_SEPARATORS.test(trimmed)) {
    return { level: "confirm", reason: `run shell command: ${trimmed.slice(0, 200)}` };
  }

  const matchedPrefix = SAFE_PREFIXES.find(
    (p) => trimmed === p || (trimmed.startsWith(p) && /\s/.test(trimmed.charAt(p.length))),
  );
  const findCanAct = matchedPrefix === "find" && FIND_ACTIONS.test(trimmed);
  if (matchedPrefix && !findCanAct) {
    return { level: "safe", reason: "read-only command" };
  }
  return { level: "confirm", reason: `run shell command: ${trimmed.slice(0, 200)}` };
}

export function createShellTool(opts: { defaultTimeoutS: number; maxOutputKb: number }) {
  return defineTool({
    name: "run_command",
    description:
      "Run a shell command inside the workspace directory. Use for git, scripts, file inspection, and small utilities. Output is captured (stdout+stderr) and truncated if large. Commands that modify state require user approval.",
    schema: z.object({
      command: z.string().describe("The shell command to run (bash, or cmd.exe on Windows)"),
      timeout_s: z.number().int().min(1).max(300).optional().describe("Timeout in seconds (default 30)"),
    }),
    assessRisk: (input) => assessCommandRisk(input.command),
    execute: async (input, ctx) => {
      const timeoutMs = (input.timeout_s ?? opts.defaultTimeoutS) * 1000;
      const maxBytes = opts.maxOutputKb * 1024;
      return new Promise((resolve) => {
        // Windows has no bash: cmd.exe is what every Windows Node install has.
        const [shell, shellArgs] =
          process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c"]] : ["bash", ["-lc"]];
        const child = spawn(shell, [...shellArgs, input.command], {
          cwd: ctx.workspaceRoot,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let truncated = false;
        const append = (chunk: Buffer) => {
          if (out.length < maxBytes) out += chunk.toString("utf8");
          if (out.length >= maxBytes) truncated = true;
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ content: `${out.slice(0, maxBytes)}\n[command timed out after ${timeoutMs / 1000}s]`, isError: true });
        }, timeoutMs);
        child.on("close", (code) => {
          clearTimeout(timer);
          let content = out.slice(0, maxBytes);
          if (truncated) content += `\n[output truncated at ${opts.maxOutputKb}KB]`;
          if (code !== 0) content += `\n[exit code ${code}]`;
          resolve({ content: content || "(no output)", isError: code !== 0 });
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({ content: `spawn error: ${err.message}`, isError: true });
        });
      });
    },
  });
}
