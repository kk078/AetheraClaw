import { z } from "zod";
import { defineTool } from "../registry.js";
import type { MemoryStore } from "../../memory/store.js";
import type { Era } from "./x12/835.js";
import { CARC } from "./denial-codes.js";

export function loadEras(store: MemoryStore): Array<{ payer: string; era: Era; receivedAt: number }> {
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
