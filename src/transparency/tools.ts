import { z } from "zod";
import { createReadStream } from "node:fs";
import { defineTool } from "../tools/registry.js";
import { newId } from "../shared/ids.js";
import { confinePath } from "../tools/path-guard.js";
import type { Config } from "../config/config.js";
import type { MemoryStore } from "../memory/store.js";
import { collectPaidLines } from "../tools/healthcare/intelligence/variance.js";
import { loadEras } from "../tools/healthcare/analytics.js";
import { appendAudit } from "../audit/store.js";
import { chunked, ingestRates, renderIngest, type RateRecord } from "./ingest.js";
import {
  MIN_RATES_FOR_BENCHMARK,
  buildBenchmarks,
  groupRates,
  positionAgainst,
  renderBenchmarks,
} from "./rates.js";
import {
  MAX_BATCH_LINE_ITEMS,
  disputeEconomics,
  idrDeadlines,
  renderDispute,
} from "./idr.js";

type Ctx = { services: Record<string, unknown> };
const store = (ctx: Ctx) => ctx.services.store as MemoryStore;

/** Read a file as chunks without ever holding it. */
async function* fileChunks(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 256 * 1024 });
  for await (const chunk of stream) yield chunk as string;
}

function storeRates(ctx: Ctx, rates: RateRecord[]): number {
  const now = Date.now();
  const insert = store(ctx).db.prepare(
    `INSERT INTO market_rates (id, billing_code, billing_code_type, description, negotiated_type, billing_class,
       rate, service_codes, expiration_date, provider_ref, source, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const run = store(ctx).db.transaction((rows: RateRecord[]) => {
    for (const r of rows) {
      insert.run(
        newId("mkt"),
        r.billingCode,
        r.billingCodeType,
        r.description.slice(0, 300),
        r.negotiatedType,
        r.billingClass,
        r.rate,
        r.serviceCodes.join(","),
        r.expirationDate,
        r.providerRef.slice(0, 200),
        r.source,
        now,
      );
    }
  });
  run(rates);
  return rates.length;
}

function loadStoredRates(ctx: Ctx, codes: string[]): RateRecord[] {
  const rows = (
    codes.length > 0
      ? store(ctx)
          .db.prepare(
            `SELECT * FROM market_rates WHERE billing_code IN (${codes.map(() => "?").join(",")})`,
          )
          .all(...codes.map((c) => c.replace(/[.\s]/g, "").toUpperCase()))
      : store(ctx).db.prepare("SELECT * FROM market_rates").all()
  ) as Array<{
    billing_code: string;
    billing_code_type: string;
    description: string;
    negotiated_type: string;
    billing_class: string;
    rate: number;
    service_codes: string;
    expiration_date: string;
    provider_ref: string;
    source: string;
  }>;
  return rows.map((r) => ({
    billingCode: r.billing_code,
    billingCodeType: r.billing_code_type,
    description: r.description,
    negotiatedType: r.negotiated_type as RateRecord["negotiatedType"],
    billingClass: r.billing_class as RateRecord["billingClass"],
    rate: r.rate,
    serviceCodes: r.service_codes ? r.service_codes.split(",") : [],
    expirationDate: r.expiration_date,
    providerRef: r.provider_ref,
    source: r.source,
  }));
}

/** Codes this practice actually bills, from its own remittances. */
function billedCodes(ctx: Ctx): string[] {
  const lines = collectPaidLines(loadEras(store(ctx)));
  return [...new Set(lines.map((l) => l.code.replace(/[.\s]/g, "").toUpperCase()))].filter(Boolean);
}

export const rateIngestTool = defineTool({
  name: "rate_ingest",
  description:
    "Read a payer Transparency in Coverage file or a hospital machine-readable file and keep only the codes this practice bills. These files run to tens of gigabytes; the file is streamed and never held, with peak memory bounded to a single in-network record. Without a code filter it keeps everything, which is the case this tool exists to avoid — pass use_billed_codes to filter to what your own remittances show you billing.",
  schema: z.object({
    file: z.string().describe("Workspace-relative path to the JSON file"),
    codes: z.array(z.string()).default([]).describe("Billing codes to keep"),
    use_billed_codes: z.boolean().default(false).describe("Filter to the codes your remittances show you billing"),
    source: z.string().default("").describe("A label for where this file came from, e.g. 'Aetna TiC 2026-07'"),
    limit: z.number().int().min(1).max(500_000).default(50_000),
    max_record_bytes: z.number().int().min(64_000).max(64_000_000).default(8_000_000),
    save: z.boolean().default(true),
  }),
  assessRisk: (input) => ({ level: "confirm" as const, reason: `read and ingest ${input.file}` }),
  execute: async (input, ctx) => {
    const config = ctx.services.config as Config;
    const path = confinePath(config.workspaceRoot, input.file);
    const codes = input.use_billed_codes ? [...input.codes, ...billedCodes(ctx)] : input.codes;

    if (input.use_billed_codes && codes.length === 0) {
      return {
        content:
          "No billed codes found in stored remittances, so there is nothing to filter to. Parse some 835s first, or pass codes explicitly.",
        isError: true,
      };
    }

    const result = await ingestRates(fileChunks(path), {
      codes,
      source: input.source || input.file,
      limit: input.limit,
      maxRecordBytes: input.max_record_bytes,
    });

    let saved = 0;
    if (input.save && result.rates.length > 0) {
      saved = storeRates(ctx, result.rates);
      appendAudit(store(ctx), {
        kind: "rate_ingest",
        actor: "rate_ingest",
        summary: `Ingested ${saved} rate(s) from ${input.file}`,
        payload: { file: input.file, codes: codes.length, saved },
      });
    }

    return { content: [renderIngest(result), saved > 0 ? `\n${saved} rate(s) stored.` : ""].filter(Boolean).join("\n") };
  },
});

export const rateBenchmarkTool = defineTool({
  name: "rate_benchmark",
  description:
    "Show the published market distribution for the codes you bill. Rates are segregated by negotiated type and billing class before anything is compared: a rate of 250 means $250 under 'negotiated' and 250% of Medicare under 'percentage', and a professional rate and a facility rate for the same CPT price different things. Groups with too few comparable rates are shown as thin rather than quoted as a market.",
  schema: z.object({
    codes: z.array(z.string()).default([]),
    include_thin: z.boolean().default(true),
  }),
  execute: async (input, ctx) => {
    const rates = loadStoredRates(ctx, input.codes);
    if (rates.length === 0) {
      return { content: "No market rates stored. Ingest a payer or hospital file with rate_ingest first." };
    }
    const benchmarks = buildBenchmarks(rates).filter((b) => input.include_thin || !b.thin);
    return { content: renderBenchmarks(benchmarks) };
  },
});

export const ratePositionTool = defineTool({
  name: "rate_position",
  description:
    "Compare what this practice is actually paid for a code against the published market, using its own remittance history for the 'ours' figure when one is not supplied. Reports the percentile and says plainly when a code is already in the top quartile — a negotiation spent on a code you are already well paid for is a negotiation wasted.",
  schema: z.object({
    code: z.string(),
    ours: z.number().min(0).default(0).describe("Your allowed amount. Taken from remittance history when 0."),
    billing_class: z.enum(["professional", "institutional"]).default("professional"),
  }),
  execute: async (input, ctx) => {
    const code = input.code.replace(/[.\s]/g, "").toUpperCase();
    const rates = loadStoredRates(ctx, [code]);
    if (rates.length === 0) {
      return { content: `No market rates stored for ${code}. Ingest a file with rate_ingest first.` };
    }

    let ours = input.ours;
    let oursSource = "supplied";
    if (ours <= 0) {
      // Per UNIT, because a published rate is a unit price and a line's allowed
      // amount is that price times the units on it. Comparing the line total to a
      // unit rate makes every multi-unit code look generously paid.
      const paid = collectPaidLines(loadEras(store(ctx))).filter(
        (l) => l.code.replace(/[.\s]/g, "").toUpperCase() === code && l.derived.allowedPerUnit > 0,
      );
      if (paid.length === 0) {
        return {
          content: `No allowed amount supplied and none found in remittance history for ${code}. Pass ours explicitly.`,
          isError: true,
        };
      }
      const sorted = paid.map((l) => l.derived.allowedPerUnit).sort((a, b) => a - b);
      ours = sorted[Math.floor(sorted.length / 2)];
      oursSource = `median of ${paid.length} paid line(s) in your own remittances`;
    }

    const groups = groupRates(rates).filter(
      (g) => g.billingClass === input.billing_class && g.negotiatedType !== "percentage" && g.negotiatedType !== "per diem",
    );
    if (groups.length === 0) {
      return {
        content: `${code} has market rates stored, but none of them are dollar-denominated ${input.billing_class} rates. Comparing your dollar rate to a percentage-of-Medicare rate would produce a number that means nothing.`,
        isError: true,
      };
    }

    const biggest = groups.sort((a, b) => b.rates.length - a.rates.length)[0];
    const position = positionAgainst(ours, biggest);
    return {
      content: [
        `${code} — you are paid $${ours.toFixed(2)} (${oursSource}).`,
        `Market ${position.benchmark.negotiatedType}/${position.benchmark.billingClass}, n=${position.benchmark.n}: $${position.benchmark.min.toFixed(2)} — [$${position.benchmark.median.toFixed(2)}] — $${position.benchmark.max.toFixed(2)}`,
        `Your percentile: ${(position.percentileRank * 100).toFixed(0)}%.`,
        "",
        position.verdict,
        position.benchmark.thin
          ? ""
          : position.gapToMedian > 0
            ? `Gap to the median: $${position.gapToMedian.toFixed(2)} per unit of service.`
            : `You are $${Math.abs(position.gapToMedian).toFixed(2)} per unit ABOVE the published median — there is no gap to close here.`,
        "",
        "Before this goes into a negotiation, check the providers behind those rates are comparable in setting and size. That is the first thing the other side will question, and it is usually right to.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});

export const negotiationBriefTool = defineTool({
  name: "negotiation_brief",
  description:
    "Build a negotiation brief: which codes this practice is underpaid on relative to the published market, ranked by the annual dollars at stake rather than by the percentage gap. A 40% gap on a code billed twice a year is not worth an agenda item; a 6% gap on the code you bill four hundred times is.",
  schema: z.object({
    payer: z.string().default("").describe("Restrict to one payer's remittance history"),
    top: z.number().int().min(1).max(50).default(10),
  }),
  execute: async (input, ctx) => {
    const eras = loadEras(store(ctx)).filter(
      (e) => !input.payer || e.payer.toLowerCase().includes(input.payer.toLowerCase()),
    );
    const paid = collectPaidLines(eras).filter((l) => l.derived.allowedPerUnit > 0);
    if (paid.length === 0) return { content: "No paid lines in remittance history to compare.", isError: true };

    const byCode = new Map<string, { allowed: number[]; units: number }>();
    for (const line of paid) {
      const code = line.code.replace(/[.\s]/g, "").toUpperCase();
      const slot = byCode.get(code) ?? { allowed: [], units: 0 };
      slot.allowed.push(line.derived.allowedPerUnit);
      slot.units += line.derived.units || 1;
      byCode.set(code, slot);
    }

    const rates = loadStoredRates(ctx, [...byCode.keys()]);
    if (rates.length === 0) {
      return { content: "No market rates stored for the codes you bill. Ingest a payer file with rate_ingest first." };
    }
    const groups = groupRates(rates).filter(
      (g) => g.billingClass === "professional" && (g.negotiatedType === "negotiated" || g.negotiatedType === "fee schedule" || g.negotiatedType === "derived"),
    );

    interface Row {
      code: string;
      ours: number;
      median: number;
      gap: number;
      units: number;
      annual: number;
      n: number;
      thin: boolean;
    }
    const rows: Row[] = [];
    for (const group of groups) {
      const mine = byCode.get(group.billingCode);
      if (!mine) continue;
      const sorted = [...mine.allowed].sort((a, b) => a - b);
      const ours = sorted[Math.floor(sorted.length / 2)];
      const position = positionAgainst(ours, group);
      if (position.gapToMedian <= 0) continue;
      rows.push({
        code: group.billingCode,
        ours,
        median: position.benchmark.median,
        gap: position.gapToMedian,
        units: mine.units,
        annual: position.gapToMedian * mine.units,
        n: position.benchmark.n,
        thin: position.benchmark.thin,
      });
    }

    if (rows.length === 0) {
      return {
        content:
          "No code where you sit below the published median. That is a real answer: the negotiation to have may be about terms rather than rates.",
      };
    }

    // Ranked by dollars, not by percentage — the whole point.
    rows.sort((a, b) => b.annual - a.annual);
    const top = rows.slice(0, input.top);
    const total = rows.reduce((s, r) => s + r.annual, 0);

    const lines = [
      `Negotiation brief${input.payer ? ` — ${input.payer}` : ""}`,
      `${rows.length} code(s) below the published median, worth $${total.toFixed(2)} over the volume in your remittance history.`,
      "",
      "Ranked by dollars at stake rather than by the size of the gap — a 40% gap on a code billed twice a year is not an agenda item, and a 6% gap on the code you bill four hundred times is:",
      "",
    ];
    for (const r of top) {
      lines.push(
        `  ${r.code}  $${r.annual.toFixed(2)} at stake${r.thin ? "  ** thin evidence **" : ""}`,
        `    paid $${r.ours.toFixed(2)} vs market median $${r.median.toFixed(2)} (gap $${r.gap.toFixed(2)} × ${r.units} unit(s), n=${r.n})`,
      );
    }
    if (rows.some((r) => r.thin)) {
      lines.push(
        "",
        `Rows marked thin rest on fewer than ${MIN_RATES_FOR_BENCHMARK} comparable published rates. Taking one of those into a meeting is worse than taking nothing: it invites a question about the sample that has no good answer, and it costs credibility on the rows that are solid.`,
      );
    }
    lines.push(
      "",
      "Volume comes from your own remittances, so it reflects the period those cover rather than a calendar year. Scale it before quoting an annual figure.",
    );
    return { content: lines.join("\n") };
  },
});

export const idrEvaluateTool = defineTool({
  name: "idr_evaluate",
  description:
    "Work out whether a No Surprises Act dispute is worth filing, and compute the deadlines. Federal IDR is baseball arbitration — one offer each and the arbitrator picks one outright — and the loser pays the arbitrator, so this is an economic decision first. Evaluated at the TOP of the published fee range on purpose: which arbitrator you get is not something you control, and a decision that only works with the cheapest one is not a decision. Batching up to 50 line items is the biggest lever there is.",
  schema: z.object({
    amount_in_dispute: z.number().min(0).describe("Dollars between what you can justify and what was paid"),
    line_items: z.number().int().min(1).default(1).describe("Line items to batch together"),
    win_probability: z.number().min(0).max(1).default(0.5),
    initial_payment_on: z.string().default("").describe("YYYYMMDD of the initial payment or denial"),
    prior_determination_on: z.string().default("").describe("YYYYMMDD of a prior determination with the same party"),
    initiated_on: z.string().default("").describe("YYYYMMDD; defaults to today. Decides the administrative fee."),
  }),
  execute: async (input) => {
    const initiatedOn = input.initiated_on || new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const economics = disputeEconomics({
      amountInDisputeCents: Math.round(input.amount_in_dispute * 100),
      lineItems: input.line_items,
      winProbability: input.win_probability,
      initiatedOn,
    });
    const deadlines = /^\d{8}$/.test(input.initial_payment_on)
      ? idrDeadlines(input.initial_payment_on, {
          priorDeterminationOn: /^\d{8}$/.test(input.prior_determination_on) ? input.prior_determination_on : undefined,
        })
      : undefined;
    return {
      content: [
        renderDispute(economics, deadlines),
        deadlines ? "" : "\nNo initial payment date given, so no deadlines were computed. Supply initial_payment_on — the initiation window is four business days wide and there is no late filing.",
        input.line_items >= MAX_BATCH_LINE_ITEMS ? "" : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});

export const idrTrackTool = defineTool({
  name: "idr_track",
  description:
    "Record a No Surprises Act dispute with its computed deadlines, so the four-business-day initiation window is a diary entry rather than something remembered. Lists open disputes with days remaining.",
  schema: z.object({
    action: z.enum(["add", "list"]).default("list"),
    payer: z.string().default(""),
    claim_refs: z.array(z.string()).default([]),
    line_items: z.number().int().min(1).default(1),
    amount_in_dispute: z.number().min(0).default(0),
    offer: z.number().min(0).default(0).describe("The offer you intend to submit"),
    initial_payment_on: z.string().default(""),
    notes: z.string().default(""),
  }),
  execute: async (input, ctx) => {
    if (input.action === "add") {
      if (!/^\d{8}$/.test(input.initial_payment_on)) {
        return { content: "initial_payment_on must be YYYYMMDD — every deadline here counts from it.", isError: true };
      }
      const deadlines = idrDeadlines(input.initial_payment_on);
      const now = Date.now();
      const id = newId("idr");
      store(ctx)
        .db.prepare(
          `INSERT INTO idr_disputes (id, payer, claim_refs, line_items, amount_in_dispute_cents, offer_cents,
             initial_payment_on, open_negotiation_ends, initiation_opens, initiation_closes, status, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open_negotiation', ?, ?, ?)`,
        )
        .run(
          id,
          input.payer,
          input.claim_refs.join(","),
          input.line_items,
          Math.round(input.amount_in_dispute * 100),
          Math.round(input.offer * 100),
          input.initial_payment_on,
          deadlines.openNegotiationEnds,
          deadlines.initiationOpens,
          deadlines.initiationCloses,
          input.notes,
          now,
          now,
        );
      return {
        content: [
          `Dispute ${id} recorded${input.payer ? ` against ${input.payer}` : ""}.`,
          `  Open negotiation ends ${deadlines.openNegotiationEnds}`,
          `  Other party's portal response due ${deadlines.responseDue}`,
          `  Initiation window ${deadlines.initiationOpens} → ${deadlines.initiationCloses}`,
          "",
          ...deadlines.notes,
        ].join("\n"),
      };
    }

    const rows = store(ctx)
      .db.prepare("SELECT * FROM idr_disputes ORDER BY initiation_closes LIMIT 100")
      .all() as Array<{
      id: string;
      payer: string;
      line_items: number;
      amount_in_dispute_cents: number;
      initiation_opens: string;
      initiation_closes: string;
      status: string;
    }>;
    if (rows.length === 0) return { content: "No disputes tracked." };

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return {
      content: rows
        .map((r) => {
          const state =
            today > r.initiation_closes
              ? "WINDOW CLOSED"
              : today >= r.initiation_opens
                ? "WINDOW OPEN — file now"
                : `opens ${r.initiation_opens}`;
          return `${r.id}  ${r.payer || "(payer unset)"}  ${r.line_items} item(s)  $${(r.amount_in_dispute_cents / 100).toFixed(2)}  ${r.status}  ${state} (closes ${r.initiation_closes})`;
        })
        .join("\n"),
    };
  },
});
