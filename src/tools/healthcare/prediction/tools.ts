import { z } from "zod";
import { defineTool } from "../../registry.js";
import { newId } from "../../../shared/ids.js";
import type { MemoryStore } from "../../../memory/store.js";
import { loadEras } from "../analytics.js";
import { todayYmd } from "../audit/deadlines.js";
import { collectOutcomes, indexHistory, renderRiskScore, scoreDenialRisk } from "./risk.js";
import { prioritize, renderQueue, type WorkItem } from "./prioritize.js";
import {
  DEFAULT_FILING_WINDOWS,
  MEDICARE_FILING_EXCEPTIONS,
  TIMELY_FILING_CARC,
  filingStatus,
  medicareExceptionDeadline,
  payerKey,
  proofGuidance,
  type FilingProof,
  type FilingWindow,
} from "./timely-filing.js";

function db(ctx: { services: Record<string, unknown> }) {
  const store = ctx.services.store as MemoryStore | undefined;
  if (!store) throw new Error("store service unavailable");
  return store.db;
}

/** Seeded defaults overlaid with whatever the practice has stored. */
function filingTable(ctx: { services: Record<string, unknown> }): Record<string, FilingWindow> {
  const rows = db(ctx)
    .prepare("SELECT payer_key, policy_json FROM payer_policies WHERE kind = 'timely_filing'")
    .all() as Array<{ payer_key: string; policy_json: string }>;
  const table: Record<string, FilingWindow> = { ...DEFAULT_FILING_WINDOWS };
  for (const row of rows) {
    try {
      table[row.payer_key] = JSON.parse(row.policy_json) as FilingWindow;
    } catch {
      // A malformed override should not take the seeded window down with it.
    }
  }
  return table;
}

export const denialRiskTool = defineTool({
  name: "denial_risk_score",
  description:
    "Score a claim's denial risk before submission from this practice's own remittance history. Rates are shrunk toward the practice's observed baseline in proportion to how much evidence supports them, so three claims with one denial does not read as a 33% denial rate. Every factor's contribution is reported in percentage points — the score is a list of reasons, not a black box.",
  schema: z.object({
    payer: z.string(),
    procedure_codes: z.array(z.string()).min(1),
    has_prior_auth: z.boolean().optional().describe("Pass explicitly — 'unknown' is scored differently from 'no'"),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore;
    const index = indexHistory(collectOutcomes(loadEras(store)));
    const score = scoreDenialRisk(
      { payer: input.payer, codes: input.procedure_codes, hasPriorAuth: input.has_prior_auth },
      index,
    );
    return { content: renderRiskScore(score) };
  },
});

export const timelyFilingTool = defineTool({
  name: "timely_filing_check",
  description:
    "Compute the filing deadline for a date of service and report whether proof of timely filing is already on file. Medicare fee-for-service is one calendar year from the date of service by statute (ACA §6404), with three narrow exceptions at 42 CFR 424.44(b); commercial windows come from the contract and are editable with timely_filing_set. Proof means an ACCEPTANCE report, not a submission log — acceptances banked from 277CA acknowledgments are looked up automatically.",
  schema: z.object({
    payer: z.string(),
    service_date: z.string().regex(/^\d{8}$/).describe("YYYYMMDD date of service"),
    claim_id: z.string().optional().describe("Look up banked proof of timely filing for this claim"),
    filing_limit_days: z.number().int().optional().describe("Override the window with the contract's own limit"),
    as_of: z.string().regex(/^\d{8}$/).optional(),
  }),
  execute: async (input, ctx) => {
    const status = filingStatus(input.payer, input.service_date, {
      table: filingTable(ctx),
      overrideDays: input.filing_limit_days,
      asOf: input.as_of,
    });
    if ("error" in status) return { content: status.error, isError: true };

    const lines = [
      `${status.window?.label ?? input.payer} — DOS ${input.service_date}`,
      status.message,
    ];
    if (status.window) lines.push(`Window: ${status.window.note}`);

    if (input.claim_id) {
      const row = db(ctx)
        .prepare(
          "SELECT claim_id, accepted_on, payer_claim_number, source FROM filing_proof WHERE claim_id = ? ORDER BY accepted_on ASC LIMIT 1",
        )
        .get(input.claim_id) as
        | { claim_id: string; accepted_on: string; payer_claim_number: string; source: string }
        | undefined;
      const proof: FilingProof | null = row
        ? {
            claimId: row.claim_id,
            acceptedOn: row.accepted_on,
            payerClaimNumber: row.payer_claim_number,
            source: row.source,
          }
        : null;
      lines.push("", proofGuidance(proof, status.deadline));
    } else if (status.expired) {
      lines.push("", proofGuidance(null, status.deadline));
    }

    if (status.expired && payerKey(input.payer).includes("medicare")) {
      lines.push(
        "",
        "Medicare allows late filing only under 42 CFR 424.44(b):",
        ...Object.entries(MEDICARE_FILING_EXCEPTIONS).map(([k, v]) => `  ${k}: ${v}`),
        "If one applies, the deadline extends through the last day of the sixth month following the month you received notice — compute it with timely_filing_exception.",
      );
    }
    return { content: lines.join("\n") };
  },
});

export const timelyFilingSetTool = defineTool({
  name: "timely_filing_set",
  description:
    "Record a payer's filing window from the contract, replacing the seeded default. Windows are per-contract and vary by plan within the same carrier, so the seeded values are starting points only.",
  schema: z.object({
    payer: z.string(),
    label: z.string().optional(),
    days: z.number().int().min(1).optional(),
    calendar_years: z.number().int().min(1).optional(),
    note: z.string().optional().describe("Where this came from, e.g. the contract section"),
  }),
  execute: async (input, ctx) => {
    if ((input.days === undefined) === (input.calendar_years === undefined)) {
      return { content: "Supply exactly one of days or calendar_years.", isError: true };
    }
    const key = payerKey(input.payer);
    const window: FilingWindow = {
      payerKey: key,
      label: input.label ?? input.payer,
      days: input.days,
      calendarYears: input.calendar_years,
      note: input.note ?? "Set from the contract.",
    };
    db(ctx)
      .prepare(
        `INSERT INTO payer_policies (payer_key, kind, policy_json, updated_at) VALUES (?, 'timely_filing', ?, ?)
         ON CONFLICT(payer_key, kind) DO UPDATE SET policy_json = excluded.policy_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(window), Date.now());
    return {
      content: `Filing window for ${window.label} set to ${input.days ? `${input.days} days` : `${input.calendar_years} calendar year(s)`} from the date of service.`,
    };
  },
});

export const timelyFilingExceptionTool = defineTool({
  name: "timely_filing_exception",
  description:
    "Compute the extended Medicare filing deadline under a 42 CFR 424.44(b) exception. The extension runs through the last day of the sixth month following the month the provider received notice of the error or the retroactive entitlement.",
  schema: z.object({
    notice_date: z.string().regex(/^\d{8}$/).describe("YYYYMMDD the provider received notice"),
    reason: z.enum(["administrative_error", "retroactive_entitlement", "retroactive_medicaid_recoupment"]),
  }),
  execute: async (input) => {
    const deadline = medicareExceptionDeadline(input.notice_date);
    return {
      content: [
        `Exception: ${MEDICARE_FILING_EXCEPTIONS[input.reason]}`,
        `Notice received ${input.notice_date} — extended filing deadline ${deadline} (last day of the sixth month following the month of notice).`,
        "Document when and how notice was received; the contractor will ask for it, and the extension is measured from that date rather than from the date of service.",
      ].join("\n"),
    };
  },
});

export const filingProofRecordTool = defineTool({
  name: "filing_proof_record",
  description:
    "Record evidence that a payer received a claim, for use in a timely-filing appeal. 277CA acknowledgments bank this automatically; use this for proof from another source — a clearinghouse acceptance report, a payer portal confirmation, or a certified-mail receipt. A submission log is not proof: it shows the claim was sent, not that it was received.",
  schema: z.object({
    claim_id: z.string(),
    accepted_on: z.string().regex(/^\d{8}$/).describe("YYYYMMDD the payer acknowledged receipt"),
    payer: z.string().optional(),
    payer_claim_number: z.string().optional(),
    source: z.string().describe("Where the proof came from, e.g. 'Availity acceptance report'"),
  }),
  execute: async (input, ctx) => {
    db(ctx)
      .prepare(
        `INSERT OR IGNORE INTO filing_proof (id, claim_id, accepted_on, payer, payer_claim_number, source, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("fp"),
        input.claim_id,
        input.accepted_on,
        input.payer ?? "",
        input.payer_claim_number ?? "",
        input.source,
        Date.now(),
      );
    return { content: `Proof of timely filing recorded for ${input.claim_id}: received ${input.accepted_on} (${input.source}).` };
  },
});

interface WorklistRow {
  id: string;
  kind: string;
  title: string;
  detail_json: string;
  due_at: number | null;
  created_at: number;
}

export const worklistPrioritizeTool = defineTool({
  name: "worklist_prioritize",
  description:
    "Rank the open denial worklist by expected recovery per hour of work, weighted by how soon each item stops being recoverable. Sorting by dollars alone loses money: an item worth $50 that expires tomorrow outranks one worth $5,000 due in ninety days, because the second will still be there next week. Items already past their deadline are pulled out of the queue rather than left to absorb effort that cannot pay off.",
  schema: z.object({
    kind: z.string().optional().describe("Filter to one worklist kind, e.g. 'denial' or 'rejection'"),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  execute: async (input, ctx) => {
    const rows = db(ctx)
      .prepare(
        `SELECT id, kind, title, detail_json, due_at, created_at FROM worklist_items
         WHERE status = 'open' ${input.kind ? "AND kind = ?" : ""}`,
      )
      .all(...(input.kind ? [input.kind] : [])) as WorklistRow[];

    if (rows.length === 0) return { content: "No open worklist items." };

    let missingAmounts = 0;
    const items: WorkItem[] = rows.map((r) => {
      let detail: { amount_cents?: number; amount?: number; carc?: string; payer?: string } = {};
      try {
        detail = JSON.parse(r.detail_json) as typeof detail;
      } catch {
        // A malformed detail blob should not drop the item from the queue.
      }
      const amountCents = detail.amount_cents ?? (detail.amount !== undefined ? Math.round(detail.amount * 100) : 0);
      if (amountCents === 0) missingAmounts++;
      return {
        id: r.id,
        kind: r.kind,
        title: r.title,
        amountCents,
        carc: detail.carc,
        payer: detail.payer,
        dueAt: r.due_at,
        createdAt: r.created_at,
      };
    });

    const result = prioritize(items, { now: Date.now() });
    let content = renderQueue(result, input.limit);
    if (missingAmounts > 0) {
      content += `\n\n${missingAmounts} item(s) carry no dollar amount, so they rank at the bottom regardless of how recoverable they are. Add amounts with worklist_add so the ordering means something.`;
    }
    return { content };
  },
});

export const filingSweepTool = defineTool({
  name: "timely_filing_sweep",
  description:
    "Check every recorded claim against its payer's filing window and report the ones closing soon or already closed, worst first. This is the check that catches a claim sitting unsubmitted in a queue nobody watches.",
  schema: z.object({
    within_days: z.number().int().min(1).max(365).default(45),
    as_of: z.string().regex(/^\d{8}$/).optional(),
  }),
  execute: async (input, ctx) => {
    const asOf = input.as_of ?? todayYmd();
    const table = filingTable(ctx);
    const rows = db(ctx)
      .prepare("SELECT id, payer, claim_json, status FROM claims")
      .all() as Array<{ id: string; payer: string; claim_json: string; status: string }>;
    if (rows.length === 0) {
      return { content: "No claims recorded yet — claim_build_837p records them as they are built." };
    }

    const results: Array<{ claimId: string; payer: string; status: string; days: number; message: string }> = [];
    let unknownPayer = 0;

    for (const row of rows) {
      let claim: { claim_id?: string; payer_name?: string; service_lines?: Array<{ service_date?: string }> };
      try {
        claim = JSON.parse(row.claim_json) as typeof claim;
      } catch {
        continue;
      }
      const dates = (claim.service_lines ?? []).map((l) => l.service_date ?? "").filter(Boolean).sort();
      const earliest = dates[0];
      if (!earliest) continue;
      const payer = row.payer || claim.payer_name || "";

      const status = filingStatus(payer, earliest, { table, asOf });
      if ("error" in status) {
        unknownPayer++;
        continue;
      }
      if (status.daysRemaining > input.within_days) continue;
      results.push({
        claimId: claim.claim_id ?? row.id,
        payer,
        status: row.status,
        days: status.daysRemaining,
        message: status.message,
      });
    }

    results.sort((a, b) => a.days - b.days);
    const lines: string[] = [];
    if (results.length === 0) {
      lines.push(`No claims are within ${input.within_days} days of their filing deadline as of ${asOf}.`);
    } else {
      const expired = results.filter((r) => r.days < 0);
      const closing = results.filter((r) => r.days >= 0);
      if (expired.length) {
        lines.push(`PAST DEADLINE — ${expired.length} claim(s):`);
        for (const r of expired) lines.push(`  ${r.claimId} (${r.payer}, status ${r.status}) — ${r.message}`);
        lines.push("");
      }
      if (closing.length) {
        lines.push(`CLOSING within ${input.within_days} days — ${closing.length} claim(s):`);
        for (const r of closing) lines.push(`  ${r.claimId} (${r.payer}, status ${r.status}) — ${r.message}`);
      }
    }
    if (unknownPayer > 0) {
      lines.push(
        "",
        `${unknownPayer} claim(s) were skipped because their payer has no filing window on file. Add them with timely_filing_set — a claim with no window is not being watched at all.`,
      );
    }
    return { content: lines.join("\n") };
  },
});
