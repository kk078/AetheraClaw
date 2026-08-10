import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "../tools/registry.js";
import { confinePath } from "../tools/path-guard.js";
import type { MemoryStore } from "../memory/store.js";
import { describeExtraction, extractDocument } from "./extract.js";
import { buildDocumentView } from "../views/document.js";
import { listDocuments, loadDocument, saveDocument } from "./store.js";

/** Files above this are refused rather than read into memory whole. */
const MAX_BYTES = 32 * 1024 * 1024;

export const documentExtractTool = defineTool({
  name: "document_extract",
  description:
    "Read a PDF, Word (.docx), Excel (.xlsx), CSV or text file and return its text — an EOB, a denial or ADR letter, an appeal determination, a remittance spreadsheet. Give either `document_id` for something already uploaded or `path` for a file in the workspace. PDF text is decoded through each font's own character map and a reading with gaps in it is REFUSED rather than returned, because a partial reading of a remittance is worse than none. Scanned PDFs and images cannot be read at all: there is no OCR here. X12 envelopes are sent to era_parse_835 / ack_parse_277ca instead of being read as prose.",
  schema: z.object({
    document_id: z.string().optional().describe("Id of a document already uploaded in this session"),
    path: z.string().optional().describe("Workspace-relative path to a file"),
    max_characters: z
      .number()
      .int()
      .min(500)
      .max(200000)
      .default(40000)
      .describe("Truncate the returned text at this many characters"),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "No database in this context.", isError: true };

    let doc;
    if (input.document_id) {
      doc = loadDocument(store, input.document_id);
      if (!doc) return { content: `No document with id ${input.document_id}. Use document_list to see what is uploaded.`, isError: true };
    } else if (input.path) {
      const p = confinePath(ctx.workspaceRoot, input.path);
      if (!fs.existsSync(p)) return { content: `File not found in the workspace: ${input.path}`, isError: true };
      const stat = fs.statSync(p);
      if (stat.isDirectory()) return { content: `${input.path} is a directory.`, isError: true };
      if (stat.size > MAX_BYTES) {
        return { content: `${input.path} is ${(stat.size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_BYTES / 1024 / 1024} MB limit.`, isError: true };
      }
      const extraction = extractDocument(path.basename(p), fs.readFileSync(p));
      doc = saveDocument(store, ctx.sessionId, extraction);
    } else {
      return { content: "Give either document_id or path.", isError: true };
    }

    const view = buildDocumentView(doc);

    if (!doc.readable) {
      // The refusal IS the answer, and it goes to the model in full so it can
      // tell the user what to do instead rather than reporting an empty read.
      return { content: `${describeExtraction({ ...doc, refusal: doc.refusal } as never)}\n\n${doc.refusal}`, view: { kind: "document", data: view } };
    }

    const truncated = doc.text.length > input.max_characters;
    const body = truncated ? `${doc.text.slice(0, input.max_characters)}\n\n[truncated at ${input.max_characters} of ${doc.text.length} characters]` : doc.text;

    const header = [
      `${doc.filename} — ${doc.kind}, ${doc.sections.length} section(s), ${doc.text.length} characters. Document id ${doc.id}.`,
      ...doc.notes,
      doc.phi.length > 0
        ? `IDENTIFIER-SHAPED TEXT IS PRESENT: ${doc.phi.map((p) => `${p.kind} ×${p.count}`).join(", ")}. This content is stored. Do not repeat identifiers back in your answer beyond what the user needs to act on.`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    return { content: `${header}\n\n${body}`, view: { kind: "document", data: view } };
  },
});

export const documentListTool = defineTool({
  name: "document_list",
  description:
    "List the documents uploaded in this session — id, filename, kind, size, and whether each could be read. Does NOT return their text, so choosing which one to open does not disclose all of them; call document_extract with the id for that.",
  schema: z.object({
    all_sessions: z.boolean().default(false).describe("List documents from every session rather than this one"),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "No database in this context.", isError: true };

    const rows = listDocuments(store, input.all_sessions ? undefined : ctx.sessionId);
    if (rows.length === 0) return { content: input.all_sessions ? "No documents stored." : "No documents uploaded in this session." };

    const lines = rows.map((d) => {
      const kb = (d.sizeBytes / 1024).toFixed(1);
      const state = d.readable ? `${d.kind}` : `${d.kind}, NOT READABLE`;
      const phi = d.phi.length > 0 ? `  [identifiers: ${d.phi.map((p) => p.kind).join(", ")}]` : "";
      return `  ${d.id}  ${d.filename} — ${state}, ${kb} KB${phi}`;
    });

    const withPhi = rows.filter((d) => d.phi.length > 0).length;
    return {
      content: [
        `${rows.length} document(s):`,
        ...lines,
        "",
        withPhi > 0
          ? `${withPhi} carry identifier-shaped text and their content is stored. \`orion documents purge\` empties this table.`
          : "None carry identifier-shaped text.",
      ].join("\n"),
    };
  },
});
