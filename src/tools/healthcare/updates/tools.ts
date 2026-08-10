import { z } from "zod";
import { defineTool } from "../../registry.js";
import { newId } from "../../../shared/ids.js";
import type { MemoryStore } from "../../../memory/store.js";
import { fetchTextGuarded } from "../../web-fetch.js";
import { dataDir, loadDataJson } from "../datasets.js";
import { todayYmd } from "../audit/deadlines.js";
import type { ClaimInput } from "../x12/837.js";
import type { Era } from "../x12/835.js";
import {
  CODE_SETS,
  assessStaleness,
  describeUpcoming,
  editionLabel,
  nextRelease,
  upcomingReleases,
  type CodeSetId,
} from "./release-calendar.js";
import {
  assessCodeImpact,
  collectCodeUsage,
  diffCodeSets,
  renderImpactReport,
  type CodeSnapshot,
} from "./code-diff.js";
import {
  filterPolicyChanges,
  parseWhatsNewLocal,
  parseWhatsNewNational,
  renderPolicyChanges,
  type PolicyChange,
} from "./policy-watch.js";

const CODE_SET_IDS = Object.keys(CODE_SETS) as [CodeSetId, ...CodeSetId[]];

function db(ctx: { services: Record<string, unknown> }) {
  const store = ctx.services.store as MemoryStore | undefined;
  if (!store) throw new Error("store service unavailable");
  return store.db;
}

interface VersionRow {
  code_set: string;
  effective_date: string;
  label: string;
  code_count: number;
  source: string;
}

/** Everything this practice has billed, from submitted claims and parsed remittances. */
function practiceUsage(ctx: { services: Record<string, unknown> }) {
  const claims = (db(ctx).prepare("SELECT claim_json FROM claims").all() as Array<{ claim_json: string }>).flatMap(
    (r) => {
      try {
        return [JSON.parse(r.claim_json) as ClaimInput];
      } catch {
        return [];
      }
    },
  );
  const eras = (db(ctx).prepare("SELECT era_json FROM remittances").all() as Array<{ era_json: string }>).flatMap(
    (r) => {
      try {
        return [JSON.parse(r.era_json) as Era];
      } catch {
        return [];
      }
    },
  );
  return collectCodeUsage(claims, eras);
}

// ── Release calendar ─────────────────────────────────────────────────────────

export const codeUpdateCalendarTool = defineTool({
  name: "code_update_calendar",
  description:
    "Show upcoming code-set releases and whether the locally installed data has fallen behind. Covers ICD-10-CM/PCS (October 1 main release, April 1 mid-year), HCPCS Level II (January and July for items and services, quarterly for drugs and biologicals), NCCI PTP/MUE (quarterly), and CPT and the MPFS (annual January 1). Which edition applies to a claim is decided by the date of service, not the submission date.",
  schema: z.object({
    horizon_days: z.number().int().min(1).max(730).default(120).describe("How far ahead to look"),
    as_of: z.string().optional().describe("YYYYMMDD to evaluate against; defaults to today"),
  }),
  execute: async (input, ctx) => {
    const asOf = input.as_of ?? todayYmd();
    const upcoming = upcomingReleases(asOf, input.horizon_days);
    const installed = db(ctx).prepare("SELECT * FROM code_set_versions").all() as VersionRow[];

    const lines: string[] = [`Code-set release calendar as of ${asOf}`, ""];

    if (upcoming.length === 0) {
      lines.push(`No releases scheduled within ${input.horizon_days} days.`);
    } else {
      lines.push(`Upcoming within ${input.horizon_days} days:`);
      for (const r of upcoming) lines.push(`  ${describeUpcoming(r)}`);
    }

    lines.push("", "Installed editions:");
    if (installed.length === 0) {
      lines.push(
        `  Nothing registered. Run code_set_register after installing a dataset in ${dataDir()} so staleness can be tracked.`,
      );
    } else {
      for (const row of installed) {
        if (!(row.code_set in CODE_SETS)) continue;
        const s = assessStaleness(row.code_set as CodeSetId, row.effective_date, asOf);
        lines.push(`  ${s.stale ? "STALE" : "current"} — ${s.message}`);
      }
      const missing = CODE_SET_IDS.filter((id) => !installed.some((r) => r.code_set === id));
      if (missing.length) {
        lines.push(`  Not registered: ${missing.map((id) => CODE_SETS[id].label).join(", ")}`);
      }
    }

    lines.push(
      "",
      "Release dates are the published CMS/AMA schedule. CMS does issue off-cycle replacement files (NCCI especially), so treat this as the expected calendar rather than a guarantee.",
    );
    return { content: lines.join("\n") };
  },
});

export const codeSetRegisterTool = defineTool({
  name: "code_set_register",
  description:
    "Record which edition of a code set is installed locally, so code_update_calendar can report how far behind it has fallen. Supply the effective date of the edition you installed (e.g. 20261001 for ICD-10-CM FY2027).",
  schema: z.object({
    code_set: z.enum(CODE_SET_IDS),
    effective_date: z.string().regex(/^\d{8}$/).describe("YYYYMMDD the installed edition took effect"),
    label: z.string().optional().describe("Free-form edition label; defaults to the computed FY/CY name"),
    code_count: z.number().int().min(0).default(0),
    source: z.string().optional().describe("Where the file came from, e.g. a CMS release URL"),
  }),
  execute: async (input, ctx) => {
    const label = input.label ?? editionLabel(input.code_set, input.effective_date);
    db(ctx)
      .prepare(
        `INSERT INTO code_set_versions (code_set, effective_date, label, code_count, source, installed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(code_set) DO UPDATE SET
           effective_date = excluded.effective_date,
           label = excluded.label,
           code_count = excluded.code_count,
           source = excluded.source,
           installed_at = excluded.installed_at`,
      )
      .run(input.code_set, input.effective_date, label, input.code_count, input.source ?? "", Date.now());

    const staleness = assessStaleness(input.code_set, input.effective_date);
    return {
      content: [
        `Registered ${CODE_SETS[input.code_set].label} ${label} (effective ${input.effective_date}).`,
        staleness.message,
        `Next scheduled release: ${nextRelease(input.code_set)}.`,
      ].join("\n"),
    };
  },
});

// ── Release diff ─────────────────────────────────────────────────────────────

const SnapshotSchema = z.object({
  file: z.string().optional().describe(`Filename inside ${"~/.orion/data"} holding the edition`),
  codes: z.record(z.string()).optional().describe("Inline code → description map"),
  effective: z.string().regex(/^\d{8}$/).optional(),
  label: z.string().optional(),
});

type SnapshotInput = z.infer<typeof SnapshotSchema>;

/**
 * A snapshot file may be a bare code→description map or a wrapper carrying its
 * own label and effective date. The wrapper wins when present.
 */
export function resolveSnapshot(input: SnapshotInput, fallbackLabel: string): CodeSnapshot | string {
  let raw: unknown = input.codes;
  if (input.file) {
    raw = loadDataJson<unknown>(input.file);
    if (raw === null) return `${input.file} not found (or not valid JSON) in ${dataDir()}`;
  }
  if (!raw || typeof raw !== "object") return "Supply either a data-directory filename or an inline codes map.";

  const wrapper = raw as { codes?: Record<string, string>; effective?: string; label?: string };
  if (wrapper.codes && typeof wrapper.codes === "object") {
    return {
      label: input.label ?? wrapper.label ?? fallbackLabel,
      effective: input.effective ?? wrapper.effective ?? "",
      codes: wrapper.codes,
    };
  }
  return {
    label: input.label ?? fallbackLabel,
    effective: input.effective ?? "",
    codes: raw as Record<string, string>,
  };
}

export const codeUpdateDiffTool = defineTool({
  name: "code_update_diff",
  description:
    "Diff two editions of a code set and report only what touches codes this practice actually bills, drawn from stored claims and remittances. Flags deleted codes still in use, reworded codes, and — for ICD-10 — codes that gained children and so became non-billable headers, which is the most common way established codes start rejecting on October 1. Supply each edition as a data-directory filename or an inline code → description map.",
  schema: z.object({
    code_set: z.enum(CODE_SET_IDS).default("icd10cm"),
    previous: SnapshotSchema,
    next: SnapshotSchema,
    create_worklist_items: z.boolean().default(false).describe("Open a worklist item per breaking change"),
    max_listed: z.number().int().min(1).max(200).default(50),
  }),
  execute: async (input, ctx) => {
    const spec = CODE_SETS[input.code_set];
    const previous = resolveSnapshot(input.previous, `${spec.label} (previous)`);
    if (typeof previous === "string") return { content: previous, isError: true };
    const next = resolveSnapshot(input.next, `${spec.label} (next)`);
    if (typeof next === "string") return { content: next, isError: true };

    const diff = diffCodeSets(previous, next);
    const usage = practiceUsage(ctx);
    // Diagnosis sets are matched against billed diagnoses, everything else
    // against billed procedure codes.
    const relevant = input.code_set === "icd10cm" || input.code_set === "icd10pcs" ? usage.diagnoses : usage.procedures;

    // Do NOT invent nextRelease(today) when the snapshot carries no effective
    // date — for a release that already took effect (diffing last year's edition
    // against this year's), that named a future April date six months too late
    // and told the operator to keep billing deleted codes until then. ICD-10 FY
    // editions take effect Oct 1 of the prior calendar year, derivable from the
    // "FYyyyy" label; otherwise fall back to nextRelease but flag it as an
    // estimate the operator should confirm.
    let effective = next.effective;
    let effectiveNote = "";
    if (!effective) {
      const fy = /FY\s*(\d{4})/i.exec(next.label ?? "")?.[1];
      if ((input.code_set === "icd10cm" || input.code_set === "icd10pcs") && fy) {
        effective = `${Number(fy) - 1}1001`;
      } else {
        effective = nextRelease(input.code_set);
        effectiveNote = `No effective date was supplied for this edition, so ${effective} is the NEXT scheduled release, not necessarily this edition's — confirm the real effective date before relying on the deadlines below.`;
      }
    }
    const report = assessCodeImpact(diff, relevant, {
      setLabel: `${spec.label} ${next.label}`,
      effective,
      hierarchical: spec.hierarchical,
      previousCodes: Object.keys(previous.codes),
    });

    const truncated = report.impacts.length > input.max_listed;
    const shown = { ...report, impacts: report.impacts.slice(0, input.max_listed) };
    let content = renderImpactReport(shown, diff);
    if (effectiveNote) content += `\n\n⚠ ${effectiveNote}`;
    if (truncated) {
      content += `\n\nListed the ${input.max_listed} highest-impact of ${report.impacts.length} affected codes — raise max_listed to see the rest.`;
    }

    let filed = 0;
    if (input.create_worklist_items) {
      const now = Date.now();
      const stmt = db(ctx).prepare(
        "INSERT INTO worklist_items (id, kind, title, detail_json, status, priority, due_at, created_at, updated_at) VALUES (?, 'compliance', ?, ?, 'open', ?, ?, ?, ?)",
      );
      for (const impact of report.impacts.filter((i) => i.severity === "error")) {
        stmt.run(
          newId("wl"),
          `${impact.code} stops working ${effective} — ${spec.label}`,
          JSON.stringify({ detail: impact.message, code: impact.code, kind: impact.kind, effective }),
          90,
          null,
          now,
          now,
        );
        filed++;
      }
      content += `\n\n${filed} worklist item(s) opened for breaking changes.`;
    }

    if (report.billedCodesChecked === 0) {
      content +=
        "\n\nNo billed-code history yet, so nothing could be cross-referenced — every change is reported as unaffecting. Build claims with claim_build_837p or parse remittances with era_parse_835 first for this to mean anything.";
    }
    return { content };
  },
});

// ── Policy watch ─────────────────────────────────────────────────────────────

const CMS = "https://api.coverage.cms.gov/v1";

async function fetchWhatsNew(scope: "national" | "local"): Promise<unknown> {
  const body = await fetchTextGuarded(`${CMS}/reports/whats-new/${scope}`);
  return JSON.parse(body) as unknown;
}

export const policyWatchTool = defineTool({
  name: "policy_watch",
  description:
    "Check the CMS Coverage 'what's new' feeds for national (NCD/NCA) and local (LCD/Article) policy changes, filtered by contractor, document type, keyword and date. Scores each change by how it tends to surface: a retired billing-and-coding Article is the one practices miss, because nothing announces it on the claim. Only changes not already reported are shown, so re-running it answers 'what moved since last time'. The feed carries titles and change notes, not code lists — a keyword hit says which document to open, not that a code you bill is affected.",
  schema: z.object({
    scope: z.enum(["national", "local", "both"]).default("both"),
    since: z.string().regex(/^\d{8}$/).optional().describe("YYYYMMDD; only changes updated on or after this date"),
    contractor: z.string().optional().describe("MAC name substring, e.g. 'Palmetto' or 'Novitas'"),
    document_types: z.array(z.string()).optional().describe("e.g. ['LCD','Article'] or ['NCD','NCA']"),
    keywords: z.array(z.string()).optional().describe("Match against title and change note"),
    include_seen: z.boolean().default(false).describe("Also show changes already reported in a previous run"),
    create_worklist_items: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  execute: async (input, ctx) => {
    const scopes: Array<"national" | "local"> =
      input.scope === "both" ? ["national", "local"] : [input.scope];

    let all: PolicyChange[] = [];
    const failures: string[] = [];
    for (const scope of scopes) {
      try {
        const payload = await fetchWhatsNew(scope);
        all = all.concat(scope === "national" ? parseWhatsNewNational(payload) : parseWhatsNewLocal(payload));
      } catch (err) {
        failures.push(`${scope}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (all.length === 0 && failures.length > 0) {
      return { content: `Could not reach the CMS Coverage change feed — ${failures.join("; ")}`, isError: true };
    }

    const total = all.length;
    let matched = filterPolicyChanges(all, {
      since: input.since,
      contractor: input.contractor,
      documentTypes: input.document_types,
      keywords: input.keywords,
    });

    const seenStmt = db(ctx).prepare(
      "SELECT 1 FROM policy_alerts WHERE scope = ? AND document_id = ? AND document_version = ?",
    );
    let suppressed = 0;
    if (!input.include_seen) {
      matched = matched.filter((c) => {
        const seen = seenStmt.get(c.scope, c.documentId, c.version) !== undefined;
        if (seen) suppressed++;
        return !seen;
      });
    }

    matched.sort((a, b) => b.updatedOn.localeCompare(a.updatedOn));
    const shown = matched.slice(0, input.limit);

    // Record what was shown so the next run reports only newer movement.
    const now = Date.now();
    const insert = db(ctx).prepare(
      `INSERT OR IGNORE INTO policy_alerts
         (id, scope, document_id, document_version, display_id, document_type, title, change_note, contractor, updated_on, effective_date, url, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of shown) {
      insert.run(
        newId("pa"),
        c.scope,
        c.documentId,
        c.version,
        c.displayId,
        c.documentType,
        c.title,
        c.changeNote,
        c.contractor,
        c.updatedOn,
        c.effectiveDate,
        c.url,
        now,
      );
    }

    let content = renderPolicyChanges(shown, { since: input.since, total });
    if (matched.length > shown.length) {
      content += `\n\nShowing the ${shown.length} most recent of ${matched.length} new change(s) — raise limit to see the rest.`;
    }
    if (suppressed > 0) {
      content += `\n${suppressed} change(s) already reported in an earlier run were suppressed; pass include_seen to show them.`;
    }
    if (failures.length > 0) {
      content += `\nOne feed could not be read — ${failures.join("; ")}. Results above cover the other feed only.`;
    }

    if (input.create_worklist_items && shown.length > 0) {
      const stmt = db(ctx).prepare(
        "INSERT INTO worklist_items (id, kind, title, detail_json, status, priority, due_at, created_at, updated_at) VALUES (?, 'compliance', ?, ?, 'open', ?, ?, ?, ?)",
      );
      let filed = 0;
      for (const c of shown) {
        stmt.run(
          newId("wl"),
          `Policy change: ${c.displayId || c.documentId} — ${c.title}`.slice(0, 200),
          JSON.stringify({ detail: c.changeNote, url: c.url, contractor: c.contractor, effective: c.effectiveDate }),
          60,
          null,
          now,
          now,
        );
        filed++;
      }
      content += `\n${filed} worklist item(s) opened.`;
    }
    return { content };
  },
});
