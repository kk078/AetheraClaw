import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { confinePath } from "./path-guard.js";
import { defineTool } from "./registry.js";

const READ_CAP = 256 * 1024;

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read a text file from the workspace. Paths are relative to the workspace root. Large files are truncated; use offset/limit to page.",
  schema: z.object({
    path: z.string().describe("Path relative to the workspace root"),
    offset: z.number().int().min(0).optional().describe("Byte offset to start reading from"),
    limit: z.number().int().min(1).optional().describe("Max bytes to read (default 256KB)"),
  }),
  execute: async (input, ctx) => {
    const p = confinePath(ctx.workspaceRoot, input.path);
    if (!fs.existsSync(p)) return { content: `File not found: ${input.path}`, isError: true };
    const stat = fs.statSync(p);
    if (stat.isDirectory()) return { content: `${input.path} is a directory — use list_dir`, isError: true };
    const limit = Math.min(input.limit ?? READ_CAP, READ_CAP);
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(limit);
      const read = fs.readSync(fd, buf, 0, limit, input.offset ?? 0);
      let content = buf.subarray(0, read).toString("utf8");
      if ((input.offset ?? 0) + read < stat.size) content += `\n[truncated — file is ${stat.size} bytes]`;
      return { content };
    } finally {
      fs.closeSync(fd);
    }
  },
});

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Write (create or overwrite) a text file in the workspace. Parent directories are created automatically. Requires user approval by default.",
  schema: z.object({
    path: z.string().describe("Path relative to the workspace root"),
    content: z.string().describe("Full file contents to write"),
  }),
  assessRisk: (input) => ({ level: "confirm", reason: `write file: ${input.path} (${input.content.length} bytes)` }),
  execute: async (input, ctx) => {
    const p = confinePath(ctx.workspaceRoot, input.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, input.content);
    return { content: `Wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}` };
  },
});

export const listDirTool = defineTool({
  name: "list_dir",
  description: "List files and directories at a workspace path (non-recursive).",
  schema: z.object({
    path: z.string().default(".").describe("Directory path relative to the workspace root"),
  }),
  execute: async (input, ctx) => {
    const p = confinePath(ctx.workspaceRoot, input.path ?? ".");
    if (!fs.existsSync(p)) return { content: `Not found: ${input.path}`, isError: true };
    const entries = fs.readdirSync(p, { withFileTypes: true });
    const lines = entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`);
    return { content: lines.join("\n") || "(empty)" };
  },
});
