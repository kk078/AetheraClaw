// ── Twin verdict parsing ─────────────────────────────────────────────────────
// The twin answers in a fixed format so its prediction can be stored and scored
// later rather than re-typed by a human. Parsing is tolerant of the ways a model
// drifts from a template — extra prose, missing sections, different casing — but
// it never guesses a verdict it could not find.
//
// That last part matters more than it looks. Defaulting an unparsed response to
// PAY would silently wave through exactly the claims the twin exists to catch,
// and the failure would be invisible: a clean gauntlet run and a denial later.

export type Verdict = "PAY" | "PARTIAL" | "DENY";
export type Confidence = "low" | "medium" | "high";

export interface TwinVerdict {
  /** Null when the response could not be parsed — never assumed. */
  verdict: Verdict | null;
  confidence: Confidence | null;
  predictedCarcs: string[];
  rationale: string;
  remediation: string;
  /** The raw response, kept so a parse failure can be investigated. */
  raw: string;
  parseProblems: string[];
}

const VERDICT_LINE = /^\s*VERDICT\s*[:\-]\s*(PAY|PARTIAL|DENY)\b/im;
const CONFIDENCE_LINE = /^\s*CONFIDENCE\s*[:\-]\s*(low|medium|high)\b/im;
const CARC_LINE = /^\s*PREDICTED_CARCS?\s*[:\-]\s*(.*)$/im;

/** Pull a labelled block out, running to the next known label or the end. */
function section(text: string, label: string, nextLabels: string[]): string {
  const start = new RegExp(`^\\s*${label}\\s*[:\\-]\\s*`, "im");
  const match = start.exec(text);
  if (!match) return "";
  const from = match.index + match[0].length;
  const rest = text.slice(from);
  let end = rest.length;
  for (const next of nextLabels) {
    const m = new RegExp(`^\\s*${next}\\s*[:\\-]`, "im").exec(rest);
    if (m && m.index < end) end = m.index;
  }
  return rest.slice(0, end).trim();
}

/** CARC codes are short alphanumerics; prose and "none" must not become codes. */
export function parseCarcList(raw: string): string[] {
  const cleaned = raw.trim();
  if (!cleaned || /^(none|n\/a|empty|-)$/i.test(cleaned)) return [];
  const out = new Set<string>();
  for (const token of cleaned.split(/[,;/]|\s+and\s+/)) {
    const code = token.trim().replace(/^CARC\s*/i, "").replace(/[.)\]]+$/, "").toUpperCase();
    if (/^[A-Z]?\d{1,3}[A-Z]?$/.test(code)) out.add(code);
  }
  return [...out];
}

export function parseTwinVerdict(raw: string): TwinVerdict {
  const problems: string[] = [];

  const verdictMatch = VERDICT_LINE.exec(raw);
  const verdict = verdictMatch ? (verdictMatch[1].toUpperCase() as Verdict) : null;
  if (!verdict) problems.push("No VERDICT line was found. The response is not being read as a prediction.");

  const confidenceMatch = CONFIDENCE_LINE.exec(raw);
  const confidence = confidenceMatch ? (confidenceMatch[1].toLowerCase() as Confidence) : null;
  if (!confidence) problems.push("No CONFIDENCE line was found.");

  const carcMatch = CARC_LINE.exec(raw);
  const predictedCarcs = carcMatch ? parseCarcList(carcMatch[1]) : [];
  if (verdict && verdict !== "PAY" && predictedCarcs.length === 0) {
    problems.push(
      `Verdict is ${verdict} but no CARC codes were predicted, so this prediction cannot be scored against a remittance.`,
    );
  }

  const rationale = section(raw, "RATIONALE", ["REMEDIATION"]);
  const remediation = section(raw, "REMEDIATION", ["RATIONALE"]);

  return { verdict, confidence, predictedCarcs, rationale, remediation, raw, parseProblems: problems };
}

export function isClean(v: TwinVerdict): boolean {
  return v.verdict === "PAY";
}

export function renderVerdict(v: TwinVerdict): string {
  const lines = [
    `Verdict: ${v.verdict ?? "UNREADABLE"}${v.confidence ? ` (${v.confidence} confidence)` : ""}`,
  ];
  if (v.predictedCarcs.length) lines.push(`Predicted CARCs: ${v.predictedCarcs.join(", ")}`);
  if (v.rationale) lines.push("", "Why the payer would push back:", v.rationale);
  if (v.remediation) lines.push("", "What would survive re-adjudication:", v.remediation);
  if (v.parseProblems.length) {
    lines.push(
      "",
      "The twin's response did not follow the expected format:",
      ...v.parseProblems.map((p) => `  ${p}`),
      "Treat this as NO prediction rather than a clean claim — an unreadable answer is not a PAY.",
    );
  }
  return lines.join("\n");
}
