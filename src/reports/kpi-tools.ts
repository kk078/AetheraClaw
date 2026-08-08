import { z } from "zod";
import { defineTool } from "../tools/registry.js";
import type { MemoryStore } from "../memory/store.js";
import { computeExecutiveKpis, computeNetCollectionRate, renderKpis, type AckRecord } from "./kpi.js";
import { buildKpiTiles } from "../views/build.js";
// Reused rather than reimplemented: two claim↔ERA loaders that normalize claim
// ids differently would make the report and the KPIs disagree about what is
// outstanding, which is exactly the kind of discrepancy nobody can explain.
import { loadClaims, loadEras } from "./tools.js";

/**
 * First-pass acknowledgment outcomes.
 *
 * Acceptances are banked in `filing_proof`; rejections open worklist items. Both
 * are needed — reading only `filing_proof` would produce a 100% acceptance rate
 * by construction, since nothing that failed is in that table.
 */
function loadAcks(store: MemoryStore): AckRecord[] {
  const accepted = store.db
    .prepare("SELECT claim_id, recorded_at FROM filing_proof WHERE source LIKE '%277CA%' ORDER BY recorded_at ASC")
    .all() as Array<{ claim_id: string; recorded_at: number }>;
  const rejected = store.db
    .prepare(
      "SELECT json_extract(detail_json, '$.claim_id') AS claim_id, created_at FROM worklist_items WHERE kind = 'rejection' ORDER BY created_at ASC",
    )
    .all() as Array<{ claim_id: string | null; created_at: number }>;

  return [
    ...accepted.map((r) => ({ claimId: r.claim_id, accepted: true, at: r.recorded_at })),
    ...rejected.filter((r) => r.claim_id).map((r) => ({ claimId: r.claim_id as string, accepted: false, at: r.created_at })),
  ]
    // Oldest first, so computeCleanClaimRate's first-submission rule sees the
    // real first outcome rather than whichever query ran first.
    .sort((a, b) => a.at - b.at)
    .map(({ claimId, accepted: ok }) => ({ claimId, accepted: ok }));
}

export const kpiDashboardTool = defineTool({
  name: "kpi_dashboard",
  description:
    "Days in A/R, clean claim rate and net collection rate from stored claims, remittances and acknowledgments. Each refuses to produce a number it cannot support: net collection rate is measured only over claims old enough to have finished paying, because including recent ones counts their charges without their payments; clean claim rate is reported as two separate figures (front-end acceptance and first-pass payment) because a blended number hides which half of the process is broken.",
  schema: z.object({
    settle_days: z
      .number()
      .int()
      .min(30)
      .max(730)
      .optional()
      .describe("How old a claim must be to count toward net collection rate. Default 120 — long enough that most of a cohort has stopped moving."),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "No database configured.", isError: true };

    const claims = loadClaims(ctx);
    const eras = loadEras(ctx);
    if (claims.length === 0 && eras.length === 0) {
      return {
        content:
          "No claims or remittances stored, so none of these can be computed. They are derived from what the practice actually billed and was actually paid — build claims with claim_build_837p and parse remittances with era_parse_835 first.",
      };
    }

    const kpis = computeExecutiveKpis(claims, eras, loadAcks(store), Date.now());
    const parts = [renderKpis(kpis)];
    if (input.settle_days !== undefined) {
      const alt = computeNetCollectionRate(claims, eras, Date.now(), input.settle_days);
      parts.push(
        "",
        `At a ${input.settle_days}-day settle window: ${alt.rate === null ? "not computable" : `${alt.rate.toFixed(1)}%`} over ${alt.claimsMeasured} claim(s).`,
        "A shorter window raises the claim count and lowers the rate, because it admits claims still being paid. If the two figures differ a lot, the longer one is the real one.",
      );
    }
    parts.push(
      "",
      `Computed from ${claims.length} stored claim(s) and ${eras.length} remittance(s). These describe what is in this database, not the practice — a claim never built here is invisible to all three.`,
    );
    return { content: parts.join("\n"), view: { kind: "kpi_tiles", data: buildKpiTiles(kpis) } };
  },
});
