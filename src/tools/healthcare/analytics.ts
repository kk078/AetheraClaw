import { z } from "zod";
import { defineTool } from "../registry.js";
import type { MemoryStore } from "../../memory/store.js";
import type { Era } from "./x12/835.js";
import { CARC } from "./denial-codes.js";

function loadEras(store: MemoryStore): Array<{ payer: string; era: Era; receivedAt: number }> {
  const rows = store.db.prepare("SELECT payer, era_json, received_at FROM remittances ORDER BY received_at ASC").all() as Array<{
    payer: string;
    era_json: string;
    received_at: number;
  }>;
  return rows.map((r) => ({ payer: r.payer, era: JSON.parse(r.era_json) as Era, receivedAt: r.received_at }));
}

export function computeKpis(store: MemoryStore) {
  const eras = loadEras(store);
  let claims = 0;
  let denied = 0;
  let charged = 0;
  let paid = 0;
  const byCarc = new Map<string, { count: number; amount: number }>();
  const byPayer = new Map<string, { claims: number; denied: number }>();

  for (const { era } of eras) {
    for (const c of era.claims) {
      claims++;
      charged += c.charged;
      paid += c.paid;
      const payerStats = byPayer.get(era.payer) ?? { claims: 0, denied: 0 };
      payerStats.claims++;
      if (c.statusCode === "4") {
        denied++;
        payerStats.denied++;
      }
      byPayer.set(era.payer, payerStats);
      for (const l of c.lines) {
        for (const a of l.adjustments) {
          if (a.group === "CO" || a.group === "PI") {
            const slot = byCarc.get(a.carc) ?? { count: 0, amount: 0 };
            slot.count++;
            slot.amount += a.amount;
            byCarc.set(a.carc, slot);
          }
        }
      }
    }
  }
  return { claims, denied, charged, paid, byCarc, byPayer };
}

export const analyticsQueryTool = defineTool({
  name: "analytics_query",
  description:
    "RCM KPIs computed from parsed 835 remittances stored locally: claim/denial counts, denial rate, paid-vs-charged, top denial reasons (CARC) with dollars, per-payer denial rates.",
  schema: z.object({}),
  execute: async (_input, ctx) => {
    const store = ctx.services.store as MemoryStore;
    const k = computeKpis(store);
    if (k.claims === 0) return { content: "No remittance data yet — parse 835 files with era_parse_835 first." };
    const topCarcs = [...k.byCarc.entries()]
      .sort((a, b) => b[1].amount - a[1].amount)
      .slice(0, 10)
      .map(([carc, v]) => `  CARC ${carc} (${CARC[carc]?.desc ?? "?"}): ${v.count}× · $${v.amount.toFixed(2)}`);
    const payers = [...k.byPayer.entries()].map(
      ([p, v]) => `  ${p || "(unknown)"}: ${v.claims} claims, ${((v.denied / Math.max(v.claims, 1)) * 100).toFixed(1)}% denied`,
    );
    return {
      content: [
        `Claims: ${k.claims} · Denied: ${k.denied} (${((k.denied / k.claims) * 100).toFixed(1)}%)`,
        `Charged: $${k.charged.toFixed(2)} · Paid: $${k.paid.toFixed(2)} (${((k.paid / Math.max(k.charged, 1)) * 100).toFixed(1)}% of charges)`,
        `Top adjustment reasons by dollars:`,
        ...topCarcs,
        `Per payer:`,
        ...payers,
      ].join("\n"),
    };
  },
});

export const denialRiskTool = defineTool({
  name: "denial_risk_score",
  description:
    "Score a claim's denial risk BEFORE submission using this practice's own 835 history (payer × procedure denial frequencies) plus static risk rules. Returns the top risk factors, not a black box.",
  schema: z.object({
    payer: z.string(),
    procedure_codes: z.array(z.string()).min(1),
    has_prior_auth: z.boolean().optional(),
    diagnosis_codes: z.array(z.string()).optional(),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore;
    const eras = loadEras(store).filter((e) => !input.payer || e.payer.toLowerCase().includes(input.payer.toLowerCase()));
    const factors: string[] = [];
    let score = 0.05; // base

    for (const code of input.procedure_codes) {
      let seen = 0;
      let deniedAdj = 0;
      for (const { era } of eras) {
        for (const c of era.claims) {
          for (const l of c.lines) {
            if (!l.procedure.startsWith(code)) continue;
            seen++;
            if (c.statusCode === "4" || l.adjustments.some((a) => ["50", "96", "197", "97"].includes(a.carc))) deniedAdj++;
          }
        }
      }
      if (seen >= 3) {
        const rate = deniedAdj / seen;
        if (rate > 0.15) {
          score += rate * 0.5;
          factors.push(`${code}: historical denial/adjustment rate ${(rate * 100).toFixed(0)}% with this payer (${deniedAdj}/${seen})`);
        }
      }
    }
    if (input.has_prior_auth === false) {
      score += 0.25;
      factors.push("No prior authorization recorded — CARC 197 risk if the payer requires PA for these codes");
    }
    score = Math.min(score, 0.95);
    const band = score > 0.5 ? "HIGH" : score > 0.25 ? "MODERATE" : "LOW";
    return {
      content: [
        `Denial risk: ${band} (${(score * 100).toFixed(0)}%)`,
        ...(factors.length ? ["Risk factors:", ...factors.map((f) => `  - ${f}`)] : ["No elevated risk factors found in local history."]),
        eras.length === 0 ? "Note: no 835 history for this payer yet — score is baseline only." : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
});
