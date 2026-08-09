import { z } from "zod";
import { defineTool } from "../tools/registry.js";
import type { MemoryStore } from "../memory/store.js";
import { computeExecutiveKpis } from "./kpi.js";
import { loadAcks } from "./kpi-tools.js";
import { loadClaims, loadEras } from "./tools.js";
import { buildBriefing, FILING_JEOPARDY_DAYS } from "./briefing.js";
import { DEFAULT_FILING_WINDOWS, type FilingWindow } from "../tools/healthcare/prediction/timely-filing.js";

// I/O and formatting only. Every decision about what goes in the briefing and
// in what order lives in buildBriefing, where it can be tested over plain data
// rather than over a database.

function db(ctx: { services: Record<string, unknown> }) {
  const store = ctx.services.store as MemoryStore | undefined;
  if (!store) throw new Error("store service unavailable");
  return store.db;
}

/** Seeded windows overlaid with whatever the practice has stored for its own contracts. */
function filingWindows(ctx: { services: Record<string, unknown> }): Record<string, FilingWindow> {
  const table: Record<string, FilingWindow> = { ...DEFAULT_FILING_WINDOWS };
  const rows = db(ctx)
    .prepare("SELECT payer_key, policy_json FROM payer_policies WHERE kind = 'timely_filing'")
    .all() as Array<{ payer_key: string; policy_json: string }>;
  for (const row of rows) {
    try {
      table[row.payer_key] = JSON.parse(row.policy_json) as FilingWindow;
    } catch {
      // A malformed override must not take the seeded window down with it.
    }
  }
  return table;
}

export const briefingDailyTool = defineTool({
  name: "briefing_daily",
  description:
    "The two-minute morning briefing: what is about to be lost, what changed overnight, and what needs a person — ordered by what becomes unrecoverable if it is ignored rather than by category, so a filing window closing this week outranks a KPI that moved a point. Figures that cannot be computed are reported as gaps with the reason, never as zeros; 'net collection rate: 0%' because no remittances are loaded is the failure this refuses to commit. Ask for the spoken version to get it phrased for the ear and capped at roughly two minutes, cutting whole items and saying how many were left unread.",
  schema: z.object({
    spoken: z
      .boolean()
      .default(false)
      .describe("Return the version written for the ear — short sentences, codes and money pronounced, no tables or URLs, capped at about two minutes."),
    horizonDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe(`How near a filing deadline must be to count as critical. Default ${FILING_JEOPARDY_DAYS} days.`),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "No database configured.", isError: true };

    const claims = loadClaims(ctx);
    const eras = loadEras(ctx);
    if (claims.length === 0 && eras.length === 0) {
      return {
        content:
          "Nothing to brief on: no claims and no remittances are stored. This briefing is assembled from what the practice actually billed and was actually paid — build claims with claim_build_837p and parse remittances with era_parse_835 first. An empty briefing means no data, not a quiet morning.",
      };
    }

    const now = Date.now();
    const briefing = buildBriefing(
      {
        kpis: computeExecutiveKpis(claims, eras, loadAcks(store), now),
        claims,
        eras,
        filingWindows: filingWindows(ctx),
        now,
      },
      { jeopardyDays: input.horizonDays },
    );

    return { content: input.spoken ? briefing.spoken : briefing.written };
  },
});

export const briefingTools = [briefingDailyTool];
