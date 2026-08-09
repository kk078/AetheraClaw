import { z } from "zod";
import { defineTool } from "../../registry.js";
import { loadEras } from "../analytics.js";
import type { MemoryStore } from "../../../memory/store.js";
import { parse835All } from "../x12/835.js";
import {
  matchRecoupments,
  reconcileEra,
  renderReconciliation,
  renderRecoupmentMatches,
  type OpenCredit,
} from "../../../reports/reconcile.js";

// Thin wrappers. Every rule lives in src/reports/reconcile.ts, where it is pure
// and tested; these do database I/O and formatting and nothing else.

export const eraReconcileTool = defineTool({
  name: "era_reconcile",
  description:
    "Tie a remittance's cheque amount to the claims and provider-level adjustments on it: BPR = claim payments − PLB. Reports recoupments (money the payer took back), forwarding balances (carried to the next remittance, NOT lost), and any residual the file does not explain. Run this before posting an 835 — a deposit that does not tie to the claims is the single way money disappears without anybody being told.",
  schema: z.object({
    era_text: z.string().optional().describe("Raw 835 contents. Omit to reconcile every stored remittance."),
  }),
  execute: async (input, ctx) => {
    if (input.era_text) {
      // Reconcile per transaction set: a batched file carries several cheques,
      // each of which must tie out on its own — aggregating them first would let
      // one cheque's shortfall hide behind another's surplus.
      const reports = parse835All(input.era_text).map(reconcileEra);
      const out = reports.map(renderReconciliation);
      if (reports.length > 1) {
        const unbalanced = reports.filter((r) => !r.balanced).length;
        out.push(
          "",
          unbalanced === 0
            ? `All ${reports.length} remittance(s) in this file balance.`
            : `${unbalanced} of ${reports.length} remittance(s) in this file DO NOT balance.`,
        );
      }
      return { content: out.join("\n\n") };
    }
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store?.db) return { content: "No 835 supplied and no store available. Pass era_text.", isError: true };
    const eras = loadEras(store);
    if (eras.length === 0) return { content: "No stored remittances. Parse 835 files with era_parse_835 first, or pass era_text." };

    const reports = eras.map(({ era }) => reconcileEra(era));
    const unbalanced = reports.filter((r) => !r.balanced);
    const out = reports.map(renderReconciliation);
    out.push(
      "",
      unbalanced.length === 0
        ? `All ${reports.length} stored remittance(s) balance.`
        : `${unbalanced.length} of ${reports.length} stored remittance(s) DO NOT balance. Those deposits are not fully explained by the claims and adjustments on them.`,
    );
    return { content: out.join("\n\n") };
  },
});

export const creditBalanceRecoupmentsTool = defineTool({
  name: "credit_balance_recoupments",
  description:
    "Find open credit balances the payer has ALREADY recouped through a PLB overpayment recovery on a later remittance. Those are refunds the ledger is still waiting to send that will never be sent, because the money has already gone back. REPORTS ONLY — resolving one closes a 60-day report-and-return obligation, which is not something to do from a parse.",
  schema: z.object({}),
  execute: async (_input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store?.db) return { content: "store service unavailable", isError: true };

    const open = store.db
      .prepare("SELECT id, claim_id, amount_cents, payer FROM credit_balances WHERE status IN ('identified','investigating','appealed')")
      .all() as Array<{ id: string; claim_id: string; amount_cents: number; payer: string }>;
    if (open.length === 0) return { content: "No open credit balances on the ledger." };

    const credits: OpenCredit[] = open.map((r) => ({ id: r.id, claimId: r.claim_id, amountCents: r.amount_cents, payer: r.payer }));
    const reports = loadEras(store).map(({ era }) => reconcileEra(era));
    return { content: renderRecoupmentMatches(matchRecoupments(reports, credits)) };
  },
});

export const RECONCILE_TOOLS = [eraReconcileTool, creditBalanceRecoupmentsTool];
