import { z } from "zod";
import { defineTool } from "../registry.js";
import { fetchTextGuarded } from "../web-fetch.js";
import { openDatabase } from "../../memory/sqlite.js";
import { catalogueFor, type ReferenceDbConfig } from "./reference-db.js";
import { resolveRoute } from "./reference-routes.js";

const CMS = "https://api.coverage.cms.gov/v1";

async function cms(pathAndQuery: string): Promise<string> {
  const body = await fetchTextGuarded(`${CMS}${pathAndQuery}`);
  return body.slice(0, 12_000);
}

/**
 * Same call, parsed instead of truncated.
 *
 * `cms()` clips to 12 KB so a large report cannot flood the context, which is
 * right for text handed to a model and fatal for anything that then parses it —
 * the clip lands mid-string and JSON.parse throws on a response that was
 * perfectly valid. Parsing callers need the whole body.
 */
async function cmsJson<T>(pathAndQuery: string): Promise<T> {
  return JSON.parse(await fetchTextGuarded(`${CMS}${pathAndQuery}`)) as T;
}

export const coverageSearchNationalTool = defineTool({
  name: "coverage_search_national",
  description:
    "Search Medicare NATIONAL coverage documents (NCDs) by keyword via the CMS Coverage API. Use for 'does Medicare cover X' questions — check national policy first, then local (LCD).",
  schema: z.object({ keyword: z.string().describe("Service, procedure, or condition keyword") }),
  execute: async (input) => ({
    content: await cms(`/reports/national-coverage-ncd?keyword=${encodeURIComponent(input.keyword)}`),
  }),
});

export const coverageSearchLocalTool = defineTool({
  name: "coverage_search_local",
  description:
    "Search Medicare LOCAL coverage documents (LCDs/articles) by keyword, optionally filtered by state, via the CMS Coverage API. LCDs are contractor(MAC)-specific medical-necessity policy.",
  schema: z.object({
    keyword: z.string(),
    state: z.string().optional().describe("Two-letter state code to scope to the applicable MAC"),
  }),
  execute: async (input) => {
    const q = new URLSearchParams({ keyword: input.keyword });
    if (input.state) q.set("state", input.state);
    return { content: await cms(`/reports/local-coverage-final-lcds?${q.toString()}`) };
  },
});

/**
 * List Medicare contractors.
 *
 * This asked `/metadata/contractors?state=XX` for years and got a 400 on every
 * call: that path does not exist, and the CMS Coverage API has no state→MAC
 * mapping at all — `/data/contractor` returns all 144 contracts with no state
 * field on any of them. So the tool no longer claims to answer "which MAC
 * serves my state", because the data behind that claim was never there.
 *
 * The workflow that does work is the other direction: search LCDs for the
 * service and read the contractor off the results, which is how you find the
 * policy that actually binds you anyway.
 */

// ── MAC jurisdictions ────────────────────────────────────────────────────────

interface MacRow {
  code: string;
  name: string;
  jurisdiction: string;
  states: string;
  type: string;
}

/**
 * State lists are written every way a spreadsheet allows.
 *
 * Comma, slash, semicolon and plain spaces all appear, so the list is split on
 * any of them and matched whole. Substring matching would make "IN" hit
 * "INDIANA", "MINNESOTA" and "VIRGINIA", and sending a claim to the wrong
 * jurisdiction is not a cosmetic error.
 */
export function splitStates(raw: string): string[] {
  return String(raw ?? "")
    .split(/[,;/|]|\s+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z]{2}$/.test(s));
}

function allMacRows(cfg: ReferenceDbConfig): MacRow[] | null {
  const catalogue = catalogueFor(cfg);
  if ("error" in catalogue) return null;
  const resolved = resolveRoute(catalogue, "mac");
  if (!resolved) return null;
  const db = openDatabase(catalogue.path, { readonly: true });
  try {
    const rows = db.prepare(`SELECT * FROM "${resolved.table.replace(/"/g, '""')}"`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      code: String(r.code ?? ""),
      name: String(r.name ?? ""),
      jurisdiction: String(r.jurisdiction ?? ""),
      states: String(r.states ?? ""),
      type: String(r.type ?? ""),
    }));
  } finally {
    db.close();
  }
}

export const macLookupTool = defineTool({
  name: "mac_lookup",
  description:
    "Find the Medicare Administrative Contractor for a state, or list contractors and their contract numbers. The CMS Coverage API publishes no state field, so a state lookup is answered from an attached reference database when one carries a MAC table — and says plainly when it cannot, rather than guessing a jurisdiction.",
  schema: z.object({
    name: z.string().default("").describe("Optional case-insensitive filter on contractor name, e.g. 'Novitas'"),
    state: z.string().default("").describe("Two-letter state code, e.g. 'TX'. Needs an attached reference database with a MAC table."),
  }),
  execute: async (input, ctx) => {
    // The state question is the one people actually ask, and until now the
    // honest answer was that it could not be answered at all. A reference
    // database carrying a MAC table with a states column answers it; without
    // one, the refusal below is unchanged.
    if (input.state.trim()) {
      const cfg = (ctx.services.config as { healthcare?: ReferenceDbConfig } | undefined)?.healthcare ?? {};
      const macs = allMacRows(cfg);
      if (!macs) {
        return {
          content: `No reference database with a MAC table is attached, and the CMS Coverage API carries no state field — so which MAC serves ${input.state.toUpperCase()} cannot be looked up here. Run coverage_search_local for the service and read contractor_name off the matching LCDs: that finds the policy that binds you, which is the useful answer anyway.`,
        };
      }
      const wanted = input.state.trim().toUpperCase();
      // Word-boundary match on the state list. A substring match would make
      // "IN" hit "INDIANA" and every other state containing those letters, and
      // routing a claim to the wrong jurisdiction is not a cosmetic error.
      const hits = macs.filter((m) => splitStates(m.states).includes(wanted));
      if (hits.length === 0) {
        return { content: `No MAC in the attached table lists ${wanted}. That is a gap in the table rather than proof no contractor serves the state — check the table's own coverage before relying on it.` };
      }
      return {
        content: [
          ...hits.map((m) => `${m.name}${m.jurisdiction ? `  (${m.jurisdiction})` : ""}${m.type ? `  [${m.type}]` : ""}\n      contract ${m.code}\n      states: ${m.states}`),
          "",
          hits.length > 1
            ? "More than one contractor serves this state — Part A/B and DME are separate jurisdictions, so read the type before assuming which one adjudicates your claim."
            : "",
          `Source: the attached reference database. Confirm against the contractor's own jurisdiction page before acting on it.`,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    const parsed = await cmsJson<{
      data?: Array<{ contractor_id: number; contractor_name: string; contract_number: string }>;
    }>("/data/contractor");
    const rows = (parsed.data ?? []).filter(
      (r) => !input.name || r.contractor_name.toLowerCase().includes(input.name.toLowerCase()),
    );
    if (rows.length === 0) {
      return { content: `No contractor matches "${input.name}".`, isError: true };
    }
    const byName = new Map<string, string[]>();
    for (const r of rows) {
      const list = byName.get(r.contractor_name) ?? [];
      list.push(`${r.contract_number} (id ${r.contractor_id})`);
      byName.set(r.contractor_name, list);
    }
    return {
      content: [
        `${rows.length} contract(s) across ${byName.size} contractor(s).`,
        "",
        ...[...byName.entries()].map(([n, c]) => `  ${n}\n      ${c.join(", ")}`),
        "",
        "The API carries no state field. Pass `state` to answer by jurisdiction from an attached reference database, or run coverage_search_local to find the policy that binds a service in your area.",
      ].join("\n"),
    };
  },
});

/**
 * The SAD exclusion list is licence-gated, and the failure was opaque.
 *
 * `/reports/sad-exclusion-list` does not exist; the real report is
 * `local-coverage-sad-exclusion-list`, and it answers 401 with the AMA CPT
 * licence agreement attached. That is not a bug to route around — the list
 * carries CPT/HCPCS descriptors, and reading them requires accepting the
 * licence and presenting the resulting token. Saying so is more use than the
 * bare "HTTP 400" this produced before.
 */
export const sadExclusionTool = defineTool({
  name: "sad_exclusion_check",
  description:
    "Check the Medicare Self-Administered Drug (SAD) exclusion list — drugs excluded from Part B because they are usually self-administered, and therefore a Part D question rather than a Part B one. Requires a CMS Coverage API licence token, since the list carries AMA-licensed code descriptors.",
  schema: z.object({ keyword: z.string().default("").describe("Optional drug name filter") }),
  execute: async (input) => {
    const q = new URLSearchParams();
    if (input.keyword) q.set("keyword", input.keyword);
    try {
      const body = await cms(`/reports/local-coverage-sad-exclusion-list${q.size ? `?${q}` : ""}`);
      return { content: body };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/401|403/.test(message)) {
        return {
          content: [
            "The SAD exclusion list needs a CMS Coverage API licence token and none is configured.",
            "The list embeds AMA-licensed CPT/HCPCS descriptors, so CMS gates it behind accepting the licence agreement at https://api.coverage.cms.gov — this is a licensing requirement, not a transient failure, and it will not clear by retrying.",
            "",
            "What the answer would tell you: a drug ON this list cannot be billed to Part B, because it is usually self-administered and belongs to Part D. That is a common reason a J-code denies.",
          ].join("\n"),
          isError: true,
        };
      }
      throw err;
    }
  },
});
