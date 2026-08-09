import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "../tools/registry.js";
import { confinePath } from "../tools/path-guard.js";
import type { MemoryStore } from "../memory/store.js";
import type { ClaimInput } from "../tools/healthcare/x12/837.js";
import type { Era } from "../tools/healthcare/x12/835.js";
import { buildReport, type StoredClaim, type StoredEra } from "./aggregate.js";
import { arAgingCsv, denialsCsv, productionCsv, summaryMarkdown } from "./render.js";

function db(ctx: { services: Record<string, unknown> }) {
  const store = ctx.services.store as MemoryStore | undefined;
  if (!store) throw new Error("store service unavailable");
  return store.db;
}

export function loadClaims(ctx: { services: Record<string, unknown> }): StoredClaim[] {
  const rows = db(ctx).prepare("SELECT id, payer, claim_json, status, created_at FROM claims").all() as Array<{
    id: string;
    payer: string;
    claim_json: string;
    status: string;
    created_at: number;
  }>;
  return rows.flatMap((r) => {
    try {
      const claim = JSON.parse(r.claim_json) as ClaimInput;
      return [{ claimId: claim.claim_id ?? r.id, payer: r.payer, claim, createdAt: r.created_at, status: r.status }];
    } catch {
      return [];
    }
  });
}

export function loadEras(ctx: { services: Record<string, unknown> }): StoredEra[] {
  const rows = db(ctx).prepare("SELECT payer, era_json, received_at FROM remittances").all() as Array<{
    payer: string;
    era_json: string;
    received_at: number;
  }>;
  return rows.flatMap((r) => {
    try {
      return [{ era: JSON.parse(r.era_json) as Era, receivedAt: r.received_at, payer: r.payer }];
    } catch {
      return [];
    }
  });
}

export const reportGenerateTool = defineTool({
  name: "report_generate",
  description:
    "Produce the practice report: production billed, accounts receivable aged from the DATE OF SERVICE with the standard 30/60/90/120 buckets, and denials ranked by dollars rather than by count. Writes a Markdown summary plus CSVs that open in Excel. Computed from claims recorded at build time and remittances that have been parsed — claims submitted outside AetheraClaw are not in the numbers, and the report says so.",
  schema: z.object({
    output_dir: z.string().default("reports").describe("Workspace-relative directory"),
    title: z.string().default("Practice report"),
    formats: z.array(z.enum(["markdown", "csv"])).default(["markdown", "csv"]),
  }),
  assessRisk: (input) => ({ level: "confirm", reason: `write practice report to ${input.output_dir}` }),
  execute: async (input, ctx) => {
    const claims = loadClaims(ctx);
    const eras = loadEras(ctx);
    if (claims.length === 0 && eras.length === 0) {
      return {
        content:
          "Nothing to report on yet. Claims are recorded by claim_build_837p and remittances by era_parse_835; without either there is no data behind these numbers.",
      };
    }

    const report = buildReport(claims, eras, Date.now());
    const dir = confinePath(ctx.workspaceRoot, input.output_dir);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date(report.generatedAt).toISOString().slice(0, 10);
    const written: string[] = [];

    if (input.formats.includes("markdown")) {
      const file = path.join(dir, `report-${stamp}.md`);
      fs.writeFileSync(file, summaryMarkdown(report, input.title));
      written.push(path.join(input.output_dir, `report-${stamp}.md`));
    }
    if (input.formats.includes("csv")) {
      for (const [name, content] of [
        ["ar-aging", arAgingCsv(report)],
        ["denials", denialsCsv(report)],
        ["production", productionCsv(report)],
      ] as const) {
        const file = path.join(dir, `${name}-${stamp}.csv`);
        fs.writeFileSync(file, content);
        written.push(path.join(input.output_dir, `${name}-${stamp}.csv`));
      }
    }

    const stale = report.ar.byBucket["91-120"].amount + report.ar.byBucket["120+"].amount;
    return {
      content: [
        `Wrote ${written.length} file(s): ${written.join(", ")}.`,
        "",
        `Production: ${report.production.totalClaims} claim(s), $${report.production.totalCharges.toFixed(2)} charged.`,
        `AR: ${report.ar.rows.length} claim(s) outstanding, $${report.ar.total.toFixed(2)}, weighted average age ${report.ar.averageAgeDays} days.`,
        report.denials.lines > 0
          ? `Denials: ${report.denials.deniedLines} of ${report.denials.lines} line(s) (${(report.denials.denialRate * 100).toFixed(1)}%), top reason ${report.denials.byCarc[0]?.carc ?? "—"} at $${(report.denials.byCarc[0]?.amount ?? 0).toFixed(2)}.`
          : "Denials: no remittances parsed yet.",
        stale > 0
          ? `\n$${stale.toFixed(2)} of AR is over 90 days old. Check it against timely_filing_sweep before working anything newer — past the filing window it stops being recoverable at all.`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});
