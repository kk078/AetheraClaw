// ── CMS Coverage "what's new" ────────────────────────────────────────────────
// Coverage policy changes under practices without warning: an LCD is revised, or
// a billing-and-coding Article is retired, and claims that were paying start
// denying. The CMS Coverage API publishes both national and local change feeds;
// this module normalizes them into one shape and scores each change by how it is
// likely to bite.
//
// Honest limit, stated in the tool output as well as here: the change feeds
// carry titles and change notes, NOT code lists. A keyword hit is a triage
// signal for which documents to open, never proof that a policy touches a code
// you bill.

const MCD_BASE = "https://www.cms.gov/medicare-coverage-database";

export type PolicyScope = "national" | "local";

export interface PolicyChange {
  scope: PolicyScope;
  documentId: string;
  version: string;
  displayId: string;
  documentType: string;
  title: string;
  changeNote: string;
  contractor: string;
  /** YYYYMMDD */
  updatedOn: string;
  effectiveDate: string;
  retirementDate: string;
  url: string;
}

/** CMS returns dates as MM/DD/YYYY, alongside a YYYYMMDDHHMMSS sort key. */
export function toYmd(value: unknown, sortKey?: unknown): string {
  if (typeof sortKey === "string" && /^\d{8}/.test(sortKey)) return sortKey.slice(0, 8);
  if (typeof value !== "string") return "";
  const m = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}${m[1]}${m[2]}`;
  if (/^\d{8}$/.test(value)) return value;
  return "";
}

function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  // Contractor names arrive with embedded CRLF wrapping the MAC's part types.
  return String(value).replace(/\s*\r?\n\s*/g, " ").trim();
}

function absolutize(url: string): string {
  if (!url) return "";
  return url.startsWith("http") ? url : `${MCD_BASE}${url}`;
}

interface ApiEnvelope {
  data?: unknown;
}

function rows(payload: unknown): Array<Record<string, unknown>> {
  const data = (payload as ApiEnvelope)?.data;
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

export function parseWhatsNewNational(payload: unknown): PolicyChange[] {
  return rows(payload).map((r) => ({
    scope: "national" as const,
    documentId: str(r.document_id),
    version: str(r.document_version),
    displayId: str(r.document_display_id),
    documentType: str(r.document_type) || "NCD",
    title: str(r.title),
    changeNote: str(r.whats_new_description),
    contractor: "",
    updatedOn: toYmd(r.last_updated, r.last_updated_sort),
    effectiveDate: "",
    retirementDate: "",
    url: absolutize(str(r.url)),
  }));
}

export function parseWhatsNewLocal(payload: unknown): PolicyChange[] {
  return rows(payload).map((r) => ({
    scope: "local" as const,
    documentId: str(r.document_id),
    version: str(r.document_version),
    displayId: str(r.document_display_id),
    documentType: str(r.document_type) || "LCD",
    title: str(r.title),
    changeNote: str(r.note),
    contractor: str(r.contractor_name_type),
    updatedOn: toYmd(r.updated_on, r.updated_on_sort),
    effectiveDate: toYmd(r.effective_date),
    retirementDate: toYmd(r.retirement_date),
    url: absolutize(str(r.url)),
  }));
}

export interface PolicyFilter {
  /** Only changes updated on or after this YYYYMMDD. */
  since?: string;
  /** Substring match against the MAC name, e.g. "Palmetto". */
  contractor?: string;
  /** e.g. ["LCD", "Article"] */
  documentTypes?: string[];
  /** Any keyword matching the title or change note keeps the item. */
  keywords?: string[];
}

export function filterPolicyChanges(items: PolicyChange[], filter: PolicyFilter): PolicyChange[] {
  const types = filter.documentTypes?.map((t) => t.toLowerCase());
  const keywords = filter.keywords?.map((k) => k.toLowerCase()).filter((k) => k.length > 0);
  const contractor = filter.contractor?.toLowerCase();

  return items.filter((i) => {
    if (filter.since && i.updatedOn && i.updatedOn < filter.since) return false;
    if (types && types.length > 0 && !types.includes(i.documentType.toLowerCase())) return false;
    if (contractor && !i.contractor.toLowerCase().includes(contractor)) return false;
    if (keywords && keywords.length > 0) {
      const hay = `${i.title} ${i.changeNote}`.toLowerCase();
      if (!keywords.some((k) => hay.includes(k))) return false;
    }
    return true;
  });
}

export interface PolicyImpact {
  severity: "warning" | "info";
  reason: string;
}

/**
 * Score a change by how it tends to surface downstream.
 *
 * A retirement is the one people miss: nothing announces itself on the claim, the
 * guidance simply stops applying, and the denials that follow cite the underlying
 * policy rather than the withdrawn article.
 */
export function classifyPolicyChange(change: PolicyChange): PolicyImpact {
  const note = `${change.changeNote} ${change.title}`.toLowerCase();
  const retired = change.retirementDate !== "" || /retir/.test(note);
  if (retired) {
    return {
      severity: "warning",
      reason: `Retired${change.retirementDate ? ` ${change.retirementDate}` : ""} — the billing guidance in this document no longer applies. Claims coded to it lose their stated basis, and denials will cite the underlying policy instead.`,
    };
  }
  if (/^new\b|newly (added|posted)|proposed lcd/.test(note)) {
    return {
      severity: "warning",
      reason: "New coverage policy — medical-necessity criteria and covered code lists that did not previously exist now apply.",
    };
  }
  if (/revis|updat|reconsider|annual review/.test(note)) {
    return {
      severity: "warning",
      reason: "Revised — check the covered diagnosis and procedure code lists against what you bill; revisions routinely add or drop codes.",
    };
  }
  return { severity: "info", reason: "Change posted — open the document to see what moved." };
}

export function renderPolicyChanges(changes: PolicyChange[], opts: { since?: string; total: number }): string {
  if (changes.length === 0) {
    return `No coverage policy changes matched${opts.since ? ` since ${opts.since}` : ""} (${opts.total} change(s) in the feed).`;
  }
  const scored = changes.map((c) => ({ change: c, impact: classifyPolicyChange(c) }));
  const warn = scored.filter((s) => s.impact.severity === "warning");
  const info = scored.filter((s) => s.impact.severity === "info");

  const block = (entry: { change: PolicyChange; impact: PolicyImpact }) => {
    const c = entry.change;
    return [
      `  ${c.displayId || c.documentId} (${c.documentType}${c.version ? ` v${c.version}` : ""}) — ${c.title}`,
      c.contractor ? `    Contractor: ${c.contractor}` : "",
      `    Updated ${c.updatedOn || "?"}${c.effectiveDate ? ` · effective ${c.effectiveDate}` : ""}`,
      c.changeNote ? `    Change: ${c.changeNote}` : "",
      `    ${entry.impact.reason}`,
      c.url ? `    ${c.url}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  };

  const out: string[] = [
    `${changes.length} coverage policy change(s) to review${opts.since ? ` since ${opts.since}` : ""}, out of ${opts.total} in the feed.`,
    "",
  ];
  if (warn.length) {
    out.push(`ACT — ${warn.length} change(s) likely to affect claims:`, ...warn.map(block), "");
  }
  if (info.length) {
    out.push(`FYI — ${info.length} other change(s):`, ...info.map(block), "");
  }
  out.push(
    "The CMS change feed carries titles and change notes, not code lists — a keyword match tells you which document to open, not that a code you bill is affected. Confirm against the document itself before changing how you code.",
  );
  return out.join("\n");
}
