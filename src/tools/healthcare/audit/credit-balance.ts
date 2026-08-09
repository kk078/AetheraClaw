import { z } from "zod";
import { defineTool } from "../../registry.js";
import { newId } from "../../../shared/ids.js";
import { loadEras } from "../analytics.js";
import type { MemoryStore } from "../../../memory/store.js";
import type { Era } from "../x12/835.js";
import { describeDeadline, formatYmd, nextCms838Due, refundDeadline, todayYmd } from "./deadlines.js";

function db(ctx: { services: Record<string, unknown> }) {
  const store = ctx.services.store as MemoryStore | undefined;
  if (!store) throw new Error("store service unavailable");
  return store.db;
}

const REASONS = [
  "duplicate_payment",
  "cob_primary_paid",
  "retroactive_termination",
  "billing_error",
  "payer_error",
  "patient_overpayment",
  "other",
] as const;

const STATUSES = ["identified", "investigating", "refund_sent", "adjusted_by_payer", "appealed", "written_off"] as const;

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const toCents = (dollars: number) => Math.round(dollars * 100);

// ── Overpayment detection ────────────────────────────────────────────────────

export interface CreditCandidate {
  kind: "duplicate_payment" | "paid_over_charged" | "likely_reparse";
  payer: string;
  claimId: string;
  amountCents: number;
  detail: string;
}

/**
 * Scan parsed remittances for likely overpayments.
 *
 * `era_parse_835` does not dedupe, so parsing the same file twice would make every
 * claim in it look duplicate-paid. The payer's own control number disambiguates:
 * the same claim ID paid twice under the SAME control number is one remittance
 * seen twice; a DIFFERENT control number is a genuine second payment.
 */
export function detectCreditBalances(eras: Array<{ payer: string; era: Era }>): CreditCandidate[] {
  const out: CreditCandidate[] = [];
  // Keyed by claim AND payer: a different payer paying the same claim is
  // coordination of benefits (the repo reuses the claim id as the secondary's
  // patient control number, so both 835s echo it), NOT a duplicate. Reversals
  // (CLP02=22, negative paid) are KEPT so they can net against the payment they
  // cancel, and secondary payments (CLP02=2) are excluded from the duplicate test.
  const seen = new Map<string, Array<{ payer: string; control: string; paid: number; status: string }>>();
  const KEY = (claimId: string, payer: string) => `${claimId} ${payer}`;

  for (const { payer, era } of eras) {
    for (const claim of era.claims) {
      const who = payer || era.payer;
      if (claim.statusCode !== "2") {
        const key = KEY(claim.claimId, who);
        seen.set(key, [
          ...(seen.get(key) ?? []),
          { payer: who, control: claim.payerControlNumber, paid: claim.paid, status: claim.statusCode },
        ]);
      }

      // Payment exceeding the billed amount at claim level.
      if (claim.charged > 0 && claim.paid > claim.charged) {
        out.push({
          kind: "paid_over_charged",
          payer: payer || era.payer,
          claimId: claim.claimId,
          amountCents: toCents(claim.paid - claim.charged),
          detail: `Claim paid ${money(toCents(claim.paid))} against ${money(toCents(claim.charged))} charged`,
        });
      }

      // And at line level (a claim total can net out while one line is overpaid).
      for (const line of claim.lines) {
        if (line.procedure === "(claim level)") continue;
        if (line.charged > 0 && line.paid > line.charged) {
          out.push({
            kind: "paid_over_charged",
            payer: payer || era.payer,
            claimId: claim.claimId,
            amountCents: toCents(line.paid - line.charged),
            detail: `Line ${line.procedure} paid ${money(toCents(line.paid))} against ${money(toCents(line.charged))} charged`,
          });
        }
      }
    }
  }

  for (const [key, payments] of seen) {
    if (payments.length < 2) continue;
    const claimId = key.slice(0, key.lastIndexOf(" "));
    const payer = payments[0].payer;

    // Drop exact-identical payment tuples first — those are one remittance parsed
    // more than once. Then NET by control number, so a status-22 reversal cancels
    // the payment it reverses instead of looking like a second payment. A genuine
    // duplicate is 2+ control numbers each still carrying positive cash after
    // netting.
    const unique = new Map<string, { control: string; paid: number }>();
    for (const p of payments) unique.set(`${p.control} ${p.paid} ${p.status}`, p);
    const netByControl = new Map<string, number>();
    for (const p of unique.values()) netByControl.set(p.control, (netByControl.get(p.control) ?? 0) + p.paid);
    const positive = [...netByControl.entries()].filter(([, amt]) => amt > 0.005);

    if (positive.length >= 2) {
      const extra = positive.slice(1).reduce((sum, [, a]) => sum + a, 0);
      out.push({
        kind: "duplicate_payment",
        payer,
        claimId,
        amountCents: toCents(extra),
        detail: `Paid ${positive.length}× by ${payer} under distinct control numbers (${positive.map(([c]) => c).join(", ")}) — likely duplicate payment of ${money(toCents(extra))}`,
      });
    }

    if (payments.length > unique.size) {
      out.push({
        kind: "likely_reparse",
        payer,
        claimId,
        amountCents: 0,
        detail: `Appears ${payments.length}× but only ${unique.size} are distinct — the repeats are most likely the same 835 parsed more than once, not additional payments.`,
      });
    }
  }

  return out;
}

// ── Tools ────────────────────────────────────────────────────────────────────

interface CreditRow {
  id: string;
  payer: string;
  claim_id: string;
  patient_ref: string;
  amount_cents: number;
  identified_date: string;
  reason: string;
  status: string;
  resolved_date: string | null;
  resolution: string;
  notes: string;
}

export const creditBalanceDetectTool = defineTool({
  name: "credit_balance_detect",
  description:
    "Scan parsed remittances for likely overpayments: the same claim paid twice under different payer control numbers, and payments exceeding the amount charged. REPORTS ONLY — it does not create ledger entries, because the 60-day report-and-return clock starts at identification, which requires reasonable diligence. Review each candidate, then record confirmed ones with credit_balance_add.",
  schema: z.object({}),
  execute: async (_input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    if (!store) return { content: "store service unavailable", isError: true };
    const candidates = detectCreditBalances(loadEras(store));
    if (candidates.length === 0) return { content: "No overpayment candidates found in stored remittances." };

    const real = candidates.filter((c) => c.kind !== "likely_reparse");
    const reparse = candidates.filter((c) => c.kind === "likely_reparse");
    const total = real.reduce((sum, c) => sum + c.amountCents, 0);

    const out: string[] = [];
    if (real.length) {
      out.push(`${real.length} candidate overpayment(s), ${money(total)} total:`);
      out.push(...real.map((c) => `  ${c.claimId}  [${c.kind}]  ${c.payer || "—"}  ${money(c.amountCents)}\n    ${c.detail}`));
    } else {
      out.push("No genuine overpayment candidates found.");
    }
    if (reparse.length) {
      out.push("", `${reparse.length} likely re-parsed remittance(s) — not overpayments:`);
      out.push(...reparse.map((c) => `  ${c.claimId}: ${c.detail}`));
    }
    out.push(
      "",
      "Nothing has been recorded. Confirm each candidate against the payer's remittance and your posting records, then use credit_balance_add — the 60-day clock starts when you identify and quantify the overpayment.",
    );
    return { content: out.join("\n") };
  },
});

export const creditBalanceAddTool = defineTool({
  name: "credit_balance_add",
  description:
    "Record a confirmed overpayment in the credit-balance ledger. Sets the ACA 60-day report-and-return clock from the identification date and opens a worklist item. Use the date the overpayment was actually identified and quantified — not today's date, unless they are the same.",
  schema: z.object({
    payer: z.string(),
    amount: z.number().positive().describe("Overpaid amount in dollars"),
    identified_date: z.string().describe("YYYYMMDD the overpayment was identified and quantified"),
    reason: z.enum(REASONS),
    claim_id: z.string().default(""),
    patient_ref: z.string().default("").describe("De-identified patient reference"),
    notes: z.string().default(""),
  }),
  assessRisk: (input) => ({ level: "confirm", reason: `record ${input.amount} overpayment from ${input.payer}` }),
  execute: async (input, ctx) => {
    const id = newId("cb");
    const now = Date.now();
    const cents = toCents(input.amount);
    const deadline = refundDeadline(input.identified_date);

    db(ctx)
      .prepare(
        "INSERT INTO credit_balances (id, payer, claim_id, patient_ref, amount_cents, identified_date, reason, status, resolution, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'identified', '', ?, ?, ?)",
      )
      .run(id, input.payer, input.claim_id, input.patient_ref, cents, input.identified_date, input.reason, input.notes, now, now);

    const dueMs = Date.UTC(
      Number(deadline.dueDate.slice(0, 4)),
      Number(deadline.dueDate.slice(4, 6)) - 1,
      Number(deadline.dueDate.slice(6, 8)),
    );
    db(ctx)
      .prepare(
        "INSERT INTO worklist_items (id, kind, title, detail_json, status, priority, due_at, created_at, updated_at) VALUES (?, 'compliance', ?, ?, 'open', ?, ?, ?, ?)",
      )
      .run(
        newId("wl"),
        `Return ${money(cents)} overpayment to ${input.payer} (${input.reason})`,
        JSON.stringify({ credit_balance_id: id, claim_id: input.claim_id }),
        95,
        dueMs,
        now,
        now,
      );

    return {
      content: [
        `Recorded credit balance ${id}: ${money(cents)} owed to ${input.payer} (${input.reason})`,
        describeDeadline(deadline),
        "Worklist item opened.",
      ].join("\n"),
    };
  },
});

export const creditBalanceListTool = defineTool({
  name: "credit_balance_list",
  description:
    "List overpayments in the ledger with 60-day return countdowns, aging, and total exposure. Overdue items are called out — retaining an identified overpayment past 60 days creates False Claims Act exposure. Also shows the next CMS-838 quarterly report due date.",
  schema: z.object({
    status: z.enum(STATUSES).optional().describe("Filter by status; omit for unresolved items"),
    payer: z.string().optional(),
  }),
  execute: async (input, ctx) => {
    const unresolved = "('identified','investigating','appealed')";
    const rows = (
      input.status
        ? db(ctx).prepare("SELECT * FROM credit_balances WHERE status = ? ORDER BY identified_date ASC").all(input.status)
        : db(ctx).prepare(`SELECT * FROM credit_balances WHERE status IN ${unresolved} ORDER BY identified_date ASC`).all()
    ) as CreditRow[];

    const filtered = input.payer
      ? rows.filter((r) => r.payer.toLowerCase().includes(input.payer!.toLowerCase()))
      : rows;

    if (filtered.length === 0) {
      return { content: `No credit balances match.\n\n${describeDeadline(nextCms838Due())}` };
    }

    const today = todayYmd();
    const TERMINAL = new Set(["refund_sent", "adjusted_by_payer", "written_off"]);
    const total = filtered.reduce((sum, r) => sum + r.amount_cents, 0);
    let overdueCount = 0;
    const lines = filtered.map((r) => {
      const d = refundDeadline(r.identified_date, today);
      // A resolved balance has met (or ended) the 60-day obligation, so the
      // deadline countdown does not apply to it — flagging a balance refunded on
      // day 19 as "past the 60-day deadline" once 60 days elapse since
      // identification is a false FCA-exposure alarm on money returned on time.
      const resolved = TERMINAL.has(r.status);
      if (!resolved && d.overdue) overdueCount++;
      const flag = resolved
        ? `  (resolved${r.resolved_date ? ` ${formatYmd(r.resolved_date)}` : ""})`
        : d.overdue
          ? `  ** ${Math.abs(d.daysRemaining)} DAY(S) PAST THE 60-DAY DEADLINE **`
          : `  (${d.daysRemaining} day(s) to return)`;
      return `${r.id}  ${money(r.amount_cents)}  ${r.payer || "—"}  ${r.reason}  status=${r.status}\n    identified ${formatYmd(r.identified_date)}, due ${formatYmd(d.dueDate)}${flag}${r.claim_id ? `\n    claim ${r.claim_id}` : ""}`;
    });

    return {
      content: [
        `${filtered.length} credit balance(s), ${money(total)} total exposure${overdueCount ? ` — ${overdueCount} PAST DEADLINE` : ""}:`,
        ...lines,
        "",
        describeDeadline(nextCms838Due(today)),
      ].join("\n"),
    };
  },
});

export const creditBalanceResolveTool = defineTool({
  name: "credit_balance_resolve",
  description:
    "Update a credit balance's status — refund sent, adjusted by the payer (recouped against future payments), appealed if you dispute it, or written off. Records the resolution date for the audit trail.",
  schema: z.object({
    id: z.string(),
    status: z.enum(STATUSES),
    resolution: z.string().default("").describe("How it was resolved, e.g. 'check #1042 mailed 2025-07-10'"),
    resolved_date: z.string().optional().describe("YYYYMMDD; defaults to today for terminal statuses"),
  }),
  assessRisk: (input) => ({ level: "confirm", reason: `resolve credit balance ${input.id} as ${input.status}` }),
  execute: async (input, ctx) => {
    const terminal = ["refund_sent", "adjusted_by_payer", "written_off"].includes(input.status);
    const resolvedDate = input.resolved_date ?? (terminal ? todayYmd() : null);
    const res = db(ctx)
      .prepare("UPDATE credit_balances SET status = ?, resolution = ?, resolved_date = ?, updated_at = ? WHERE id = ?")
      .run(input.status, input.resolution, resolvedDate, Date.now(), input.id);
    if (!res.changes) return { content: `No credit balance ${input.id}`, isError: true };
    return {
      content: `${input.id} → ${input.status}${resolvedDate ? ` on ${formatYmd(resolvedDate)}` : ""}${input.resolution ? `\n${input.resolution}` : ""}`,
    };
  },
});
