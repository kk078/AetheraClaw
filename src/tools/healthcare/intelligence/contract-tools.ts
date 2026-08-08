import { z } from "zod";
import { defineTool } from "../../registry.js";
import type { MemoryStore } from "../../../memory/store.js";
import { newId } from "../../../shared/ids.js";
import { checkRate, payerKey, rateFor, type ContractRate } from "./contract.js";

interface Row {
  payer_key: string;
  payer: string;
  code: string;
  modifier: string;
  allowed: number;
  effective_from: string;
  effective_to: string;
  source: string;
}

const toRate = (r: Row): ContractRate => ({
  payerKey: r.payer_key,
  payer: r.payer,
  code: r.code,
  modifier: r.modifier,
  allowed: r.allowed,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  source: r.source,
});

export function loadContractRates(store: MemoryStore, payer?: string): ContractRate[] {
  const rows = payer
    ? (store.db.prepare("SELECT * FROM contract_rates WHERE payer_key = ?").all(payerKey(payer)) as Row[])
    : (store.db.prepare("SELECT * FROM contract_rates").all() as Row[]);
  return rows.map(toRate);
}

export const contractRateSetTool = defineTool({
  name: "contract_rate_set",
  description:
    "Record contracted allowed amounts from the practice's signed fee schedule, so payment_variance can measure payments against what the payer actually agreed to rather than against Medicare or against the payer's own habit. Rates are dated: a fee schedule amendment is normally why a payment changed, and an undated rate would be applied to claims it never governed. A source citation is required — a rate nobody can trace to a signed schedule cannot support a recovery claim. LIMIT: one flat allowed amount per code, date and modifier. Carve-outs, per-diems, percent-of-charge, lesser-of and case rates cannot be recorded here, and a line governed by one of those will be measured against the wrong number.",
  schema: z.object({
    payer: z.string(),
    source: z.string().describe("Document and section, e.g. 'Aetna PAR agreement 2026, Exhibit A p.4'"),
    effective_from: z.string().regex(/^\d{8}$/).describe("YYYYMMDD"),
    effective_to: z.string().regex(/^\d{8}$/).optional().describe("YYYYMMDD; omit while the rate is in force"),
    rates: z
      .array(
        z.object({
          code: z.string(),
          modifier: z.string().default("").describe("Modifier-specific rate; omit for the base rate"),
          allowed: z.number().describe("Contracted allowed amount PER UNIT"),
        }),
      )
      .min(1),
  }),
  assessRisk: (input) => ({
    level: "confirm",
    reason: `record ${input.rates.length} contracted rate(s) for ${input.payer}`,
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "No database configured.", isError: true };

    const rejected: string[] = [];
    const accepted: Array<{ code: string; modifier: string; allowed: number }> = [];
    for (const r of input.rates) {
      const check = checkRate({
        allowed: r.allowed,
        effectiveFrom: input.effective_from,
        effectiveTo: input.effective_to ?? "",
        code: r.code,
        source: input.source,
      });
      if (check.ok) accepted.push(r);
      else rejected.push(`${r.code}${r.modifier ? `-${r.modifier}` : ""}: ${check.reason}`);
    }

    if (accepted.length === 0) {
      return { content: `No rates recorded.\n${rejected.join("\n")}`, isError: true };
    }

    const insert = store.db.prepare(
      `INSERT OR REPLACE INTO contract_rates
         (id, payer_key, payer, code, modifier, allowed, effective_from, effective_to, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    store.db.transaction(() => {
      for (const r of accepted) {
        insert.run(
          newId("rate"),
          payerKey(input.payer),
          input.payer,
          r.code.trim().toUpperCase(),
          r.modifier.trim().toUpperCase(),
          r.allowed,
          input.effective_from,
          input.effective_to ?? "",
          input.source,
          now,
        );
      }
    })();

    const lines = [
      `Recorded ${accepted.length} contracted rate(s) for ${input.payer}, effective ${input.effective_from}${input.effective_to ? ` through ${input.effective_to}` : " onward"}.`,
    ];
    if (rejected.length > 0) lines.push("", `${rejected.length} rejected:`, ...rejected.map((r) => `  ${r}`));
    lines.push(
      "",
      'Run payment_variance with basis="contract" to measure adjudicated lines against these. Rates that never governed a claim will simply find nothing, which is not the same as finding no underpayment — the coverage figure in that output says which is which.',
    );
    return { content: lines.join("\n") };
  },
});

export const contractRateListTool = defineTool({
  name: "contract_rate_list",
  description:
    "Show recorded contracted rates, optionally for one payer or one code, and which rate is in force on a given date of service.",
  schema: z.object({
    payer: z.string().optional(),
    code: z.string().optional(),
    as_of: z.string().regex(/^\d{8}$/).optional().describe("Show only rates in force on this date of service"),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "No database configured.", isError: true };

    let rates = loadContractRates(store, input.payer);
    if (input.code) {
      const code = input.code.trim().toUpperCase();
      rates = rates.filter((r) => r.code.toUpperCase() === code);
    }
    if (input.as_of) {
      const on = input.as_of;
      rates = rates.filter((r) => r.effectiveFrom <= on && (r.effectiveTo === "" || r.effectiveTo >= on));
    }
    if (rates.length === 0) {
      return {
        content:
          "No contracted rates match. Record them with contract_rate_set. Without them, payment_variance still works — basis \"payer_history\" measures each payer against its own established median and needs no contract at all — but it can only report that a payment is unusual, never that it breaches an agreement.",
      };
    }

    const lines = rates
      .sort((a, b) => a.payer.localeCompare(b.payer) || a.code.localeCompare(b.code) || a.effectiveFrom.localeCompare(b.effectiveFrom))
      .map(
        (r) =>
          `${r.payer.padEnd(20)} ${r.code}${r.modifier ? `-${r.modifier}` : ""}`.padEnd(34) +
          `$${r.allowed.toFixed(2)}  ${r.effectiveFrom}–${r.effectiveTo || "present"}  [${r.source}]`,
      );

    const parts = [`${rates.length} contracted rate(s):`, "", ...lines];
    if (input.payer && input.code && input.as_of) {
      const winner = rateFor(loadContractRates(store), {
        payer: input.payer,
        code: input.code,
        serviceDate: input.as_of,
      });
      parts.push(
        "",
        winner
          ? `In force on ${input.as_of}: $${winner.allowed.toFixed(2)} (${winner.source}).`
          : `No rate is in force on ${input.as_of}.`,
      );
    }
    return { content: parts.join("\n") };
  },
});
