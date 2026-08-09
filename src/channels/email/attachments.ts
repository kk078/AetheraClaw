import { detectPhi, type PhiSignal } from "./classify.js";

// ── Attachment triage ────────────────────────────────────────────────────────
// The classifier reads the body. The money is usually in the attachment: an 835
// arrives as a .txt nobody opens, a clearinghouse rejection summary as a CSV, an
// ADR as a PDF. Until now those were invisible — the mail was classified and the
// file went nowhere.
//
// This identifies what each attachment IS and names the tool that parses it. It
// deliberately does not parse anything itself: era_parse_835 and ack_parse_277ca
// already exist, are tested, and write to the right tables. A second X12 reader
// living in the mail path would drift from them.
//
// The honest limit, stated rather than papered over: there is NO PDF text
// extraction here. No PDF library is installed, and a tool that claimed to read
// PDFs while returning nothing — or worse, returning the few ASCII fragments
// visible in a raw PDF stream — would be far more damaging than one that says it
// cannot. An ADR arriving as a PDF is reported as a PDF, with its deadline taken
// from the email body where it almost always also appears.

export type AttachmentKind = "x12_835" | "x12_277" | "x12_837" | "x12_other" | "csv" | "pdf" | "text" | "unknown";

export interface AttachmentFacts {
  filename: string;
  sizeBytes: number;
  kind: AttachmentKind;
  /** The tool that parses this, or "" when nothing here can. */
  routeTo: string;
  /** Present only for kinds whose text was actually read. */
  text?: string;
  phi: PhiSignal[];
  note: string;
}

/** Enough bytes to see an ISA envelope or a PDF header without reading a whole file. */
const SNIFF_BYTES = 4096;

/**
 * Identify an attachment by CONTENT first, extension second.
 *
 * Extensions lie constantly in this domain — an 835 arrives as `.txt`, `.dat`,
 * `.era`, `.rmt` or with no extension at all, depending on the clearinghouse.
 * The ISA envelope does not lie, so it is checked first and the extension is
 * only a fallback.
 */
export function sniffAttachment(filename: string, content: Buffer): AttachmentFacts {
  const head = content.subarray(0, SNIFF_BYTES).toString("latin1");
  const base = { filename, sizeBytes: content.length, phi: [] as PhiSignal[] };

  if (head.startsWith("%PDF")) {
    return {
      ...base,
      kind: "pdf",
      routeTo: "",
      note: "PDF. No text extraction is available in this build — no PDF library is installed, and returning the ASCII fragments visible in a raw PDF stream would look like a reading and be worse than nothing. Open it, or take the deadline from the email body, where an ADR almost always states it too.",
    };
  }

  if (/^\s*ISA[*|^~]/.test(head)) {
    // The transaction set inside the envelope decides which parser, not the
    // envelope: one ISA can carry 835s or 277s and the filename says neither.
    const st = /\bST\s*[*|^~]\s*(\d{3})/.exec(head)?.[1];
    const text = content.toString("utf8");
    const phi = detectPhi(text);
    if (st === "835") return { ...base, kind: "x12_835", routeTo: "era_parse_835", text, phi, note: "835 remittance advice." };
    if (st === "277") return { ...base, kind: "x12_277", routeTo: "ack_parse_277ca", text, phi, note: "277 acknowledgment." };
    if (st === "837") {
      return {
        ...base,
        kind: "x12_837",
        routeTo: "",
        text,
        phi,
        note: "837 claim — this is something YOU sent, arriving back. Usually attached to a rejection explaining why; the reason is in the accompanying 277 or the body, not in here.",
      };
    }
    return { ...base, kind: "x12_other", routeTo: "", text, phi, note: `X12 envelope carrying ST${st ?? "?"}, which nothing here parses.` };
  }

  const lower = filename.toLowerCase();
  const text = content.toString("utf8");
  const phi = detectPhi(text);

  if (lower.endsWith(".csv") || (head.includes(",") && head.split("\n").length > 1 && /^[^,\n]{1,60}(,[^,\n]{0,60}){2,}/.test(head))) {
    return {
      ...base,
      kind: "csv",
      routeTo: "",
      text,
      phi,
      note: "CSV — usually a clearinghouse denial or rejection summary. There is no generic importer: column names differ per clearinghouse, and guessing which column is the claim id is how the wrong claims get worked. Read it and use the specific tool.",
    };
  }

  if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(head)) {
    return { ...base, kind: "text", routeTo: "", text, phi, note: "Plain text." };
  }

  return { ...base, kind: "unknown", routeTo: "", phi, note: "Binary content that is not a PDF and not an X12 envelope." };
}

export interface AttachmentTriage {
  attachments: AttachmentFacts[];
  /** Attachments a tool can take straight away. */
  actionable: AttachmentFacts[];
  /** Attachments carrying identifier-shaped text — held, never stored. */
  withPhi: AttachmentFacts[];
}

export function triageAttachments(files: Array<{ filename: string; content: Buffer }>): AttachmentTriage {
  const attachments = files.map((f) => sniffAttachment(f.filename, f.content));
  return {
    attachments,
    actionable: attachments.filter((a) => a.routeTo !== ""),
    withPhi: attachments.filter((a) => a.phi.length > 0),
  };
}

export function renderTriage(triage: AttachmentTriage): string {
  if (triage.attachments.length === 0) return "No attachments.";

  const lines = [`${triage.attachments.length} attachment(s):`, ""];
  for (const a of triage.attachments) {
    const kb = (a.sizeBytes / 1024).toFixed(1);
    lines.push(
      `  ${a.filename} — ${a.kind} (${kb} KB)${a.routeTo ? ` → ${a.routeTo}` : ""}${a.phi.length > 0 ? "  [HELD: identifier-shaped text]" : ""}`,
      `      ${a.note}`,
    );
  }

  if (triage.actionable.length > 0) {
    lines.push(
      "",
      `${triage.actionable.length} can be parsed now. The content is NOT included above — pass the file to the named tool, which writes to the tables the rest of the system reads.`,
    );
  }
  if (triage.withPhi.length > 0) {
    lines.push(
      "",
      `${triage.withPhi.length} attachment(s) carry identifier-shaped text and their content is held rather than stored. This deployment is not approved for PHI, and an attachment is where it arrives unasked.`,
    );
  }
  return lines.join("\n");
}
