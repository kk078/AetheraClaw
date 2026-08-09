import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "../../registry.js";
import { confinePath } from "../../path-guard.js";
import { newId } from "../../../shared/ids.js";
import type { MemoryStore } from "../../../memory/store.js";
import {
  ADR_RESPONSE_DAYS,
  adrDeadline,
  appealDeadline,
  appealLadder,
  describeDeadline,
  formatYmd,
  recoupmentTimeline,
  todayYmd,
  type AppealLevel,
} from "./deadlines.js";

function db(ctx: { services: Record<string, unknown> }) {
  const store = ctx.services.store as MemoryStore | undefined;
  if (!store) throw new Error("store service unavailable");
  return store.db;
}

const AUDIT_TYPES = ["RAC", "MAC_ADR", "TPE", "UPIC", "SMRC", "CERT", "commercial", "OIG"] as const;
const AUDIT_STATUSES = [
  "received",
  "gathering_records",
  "responded",
  "determination_received",
  "appealing",
  "closed_favorable",
  "closed_unfavorable",
  "closed_partial",
] as const;

/** Default response window by audit type. Commercial payers set their own — the notice controls. */
export function defaultResponseDays(auditType: string): number {
  switch (auditType) {
    case "RAC":
    case "MAC_ADR":
    case "SMRC":
    case "TPE":
    case "CERT":
      return ADR_RESPONSE_DAYS;
    default:
      return 30; // commercial/OIG: conservative placeholder, override from the notice
  }
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

interface AuditRow {
  id: string;
  audit_type: string;
  contractor: string;
  received_date: string;
  response_due_date: string;
  claim_refs_json: string;
  amount_at_risk_cents: number;
  status: string;
  determination_date: string | null;
  demand_letter_date: string | null;
  appeal_level: number;
  outcome: string;
  notes: string;
}

export const auditTrackTool = defineTool({
  name: "audit_track",
  description:
    "Record an incoming payer or contractor audit (RAC, MAC ADR, TPE, UPIC, SMRC, CERT, commercial, OIG). Computes the documentation-response deadline from the audit type when you do not supply one, and opens a worklist item so it surfaces before the window closes. Response windows are short — record audits the day they arrive.",
  schema: z.object({
    audit_type: z.enum(AUDIT_TYPES),
    contractor: z.string().default("").describe("Reviewing entity, e.g. 'Palmetto GBA' or 'Cotiviti'"),
    received_date: z.string().describe("YYYYMMDD the request was received"),
    response_due_days: z.number().int().min(1).optional().describe("Override the default window with the date stated on the notice"),
    claim_refs: z.array(z.string()).default([]).describe("Claim IDs under review"),
    amount_at_risk: z.number().default(0).describe("Dollars at risk"),
    notes: z.string().default(""),
  }),
  assessRisk: (input) => ({ level: "confirm", reason: `record ${input.audit_type} audit received ${input.received_date}` }),
  execute: async (input, ctx) => {
    const days = input.response_due_days ?? defaultResponseDays(input.audit_type);
    const deadline = adrDeadline(input.received_date, days);
    const id = newId("aud");
    const now = Date.now();

    db(ctx)
      .prepare(
        "INSERT INTO audit_requests (id, audit_type, contractor, received_date, response_due_date, claim_refs_json, amount_at_risk_cents, status, appeal_level, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'received', 0, ?, ?, ?)",
      )
      .run(
        id,
        input.audit_type,
        input.contractor,
        input.received_date,
        deadline.dueDate,
        JSON.stringify(input.claim_refs),
        Math.round(input.amount_at_risk * 100),
        input.notes,
        now,
        now,
      );

    db(ctx)
      .prepare(
        "INSERT INTO worklist_items (id, kind, title, detail_json, status, priority, due_at, created_at, updated_at) VALUES (?, 'audit', ?, ?, 'open', ?, ?, ?, ?)",
      )
      .run(
        newId("wl"),
        `${input.audit_type} records due — ${input.contractor || "contractor"} (${input.claim_refs.length} claim(s))`,
        JSON.stringify({ detail: `Audit ${id}. ${input.notes}`, audit_id: id }),
        input.amount_at_risk > 0 ? Math.min(input.amount_at_risk / 100, 100) : 10,
        Date.now() + deadline.daysRemaining * 86_400_000,
        now,
        now,
      );

    return {
      content: [
        `Recorded audit ${id}: ${input.audit_type}${input.contractor ? ` from ${input.contractor}` : ""}`,
        `Claims under review: ${input.claim_refs.length ? input.claim_refs.join(", ") : "(none listed)"}`,
        `Amount at risk: ${money(Math.round(input.amount_at_risk * 100))}`,
        describeDeadline(deadline),
        "Worklist item opened. Verify the due date against the notice itself — the notice controls.",
      ].join("\n"),
    };
  },
});

export const auditListTool = defineTool({
  name: "audit_list",
  description:
    "List tracked audits with response-deadline countdowns and total dollars at risk, most urgent first. Overdue responses are called out.",
  schema: z.object({
    status: z.string().optional().describe("Filter by status; omit for all still-open audits"),
    include_closed: z.boolean().default(false),
  }),
  execute: async (input, ctx) => {
    const rows = (
      input.status
        ? db(ctx).prepare("SELECT * FROM audit_requests WHERE status = ? ORDER BY response_due_date ASC").all(input.status)
        : input.include_closed
          ? db(ctx).prepare("SELECT * FROM audit_requests ORDER BY response_due_date ASC").all()
          : db(ctx)
              .prepare("SELECT * FROM audit_requests WHERE status NOT LIKE 'closed_%' ORDER BY response_due_date ASC")
              .all()
    ) as AuditRow[];

    if (rows.length === 0) return { content: "No audits tracked." };

    const today = todayYmd();
    const totalAtRisk = rows.reduce((sum, r) => sum + r.amount_at_risk_cents, 0);
    const lines = rows.map((r) => {
      const d = adrDeadline(r.received_date, undefined, today);
      // The stored due date is authoritative; recompute the countdown against it.
      const due = r.response_due_date;
      const remaining = Math.round(
        (Date.UTC(Number(due.slice(0, 4)), Number(due.slice(4, 6)) - 1, Number(due.slice(6, 8))) -
          Date.UTC(Number(today.slice(0, 4)), Number(today.slice(4, 6)) - 1, Number(today.slice(6, 8)))) /
          86_400_000,
      );
      void d;
      const claims = JSON.parse(r.claim_refs_json) as string[];
      const urgency =
        r.status === "responded" || r.status.startsWith("closed_")
          ? ""
          : remaining < 0
            ? `  ** RESPONSE OVERDUE by ${Math.abs(remaining)} day(s) **`
            : `  (${remaining} day(s) to respond)`;
      return `${r.id}  [${r.audit_type}] ${r.contractor || "—"}  status=${r.status}  at risk ${money(r.amount_at_risk_cents)}  due ${formatYmd(due)}${urgency}\n    ${claims.length} claim(s)${claims.length ? `: ${claims.slice(0, 6).join(", ")}${claims.length > 6 ? "…" : ""}` : ""}`;
    });

    return { content: [`${rows.length} audit(s), ${money(totalAtRisk)} total at risk:`, ...lines].join("\n") };
  },
});

export const auditUpdateTool = defineTool({
  name: "audit_update",
  description:
    "Update an audit's status or record its determination. When you record an unfavorable determination (and the demand letter date), this computes the appeal-ladder filing deadline and the §935 recoupment timeline — the day those clocks actually start — and files them as worklist items.",
  schema: z.object({
    audit_id: z.string(),
    status: z.enum(AUDIT_STATUSES).optional(),
    determination_date: z.string().optional().describe("YYYYMMDD the determination was received"),
    demand_letter_date: z.string().optional().describe("YYYYMMDD of the overpayment demand letter — starts recoupment"),
    appeal_level: z.number().int().min(0).max(5).optional().describe("Level just decided; the next level's deadline is computed from it"),
    outcome: z.string().optional(),
    notes: z.string().optional(),
  }),
  assessRisk: (input) => ({ level: "confirm", reason: `update audit ${input.audit_id}` }),
  execute: async (input, ctx) => {
    const row = db(ctx).prepare("SELECT * FROM audit_requests WHERE id = ?").get(input.audit_id) as AuditRow | undefined;
    if (!row) return { content: `No audit ${input.audit_id}`, isError: true };

    const next = {
      status: input.status ?? row.status,
      determination_date: input.determination_date ?? row.determination_date,
      demand_letter_date: input.demand_letter_date ?? row.demand_letter_date,
      appeal_level: input.appeal_level ?? row.appeal_level,
      outcome: input.outcome ?? row.outcome,
      notes: input.notes ?? row.notes,
    };
    db(ctx)
      .prepare(
        "UPDATE audit_requests SET status = ?, determination_date = ?, demand_letter_date = ?, appeal_level = ?, outcome = ?, notes = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        next.status,
        next.determination_date,
        next.demand_letter_date,
        next.appeal_level,
        next.outcome,
        next.notes,
        Date.now(),
        input.audit_id,
      );

    const out: string[] = [`Audit ${input.audit_id} → status=${next.status}`];
    const now = Date.now();
    const addWorklist = (title: string, dueYmd: string, priority: number) => {
      // Skip if an open item with this exact title already exists for the audit.
      // The appeal/recoupment blocks key off the MERGED row, so once a
      // determination or demand-letter date is stored, EVERY later audit_update —
      // even one editing only notes — re-fired these inserts, burying the queue in
      // duplicate priority-90/100 items.
      const already = db(ctx)
        .prepare(
          "SELECT id FROM worklist_items WHERE kind = 'audit' AND status IN ('open','in_progress') AND title = ? AND json_extract(detail_json, '$.audit_id') = ?",
        )
        .get(title, input.audit_id);
      if (already) return;
      const dueMs = Date.UTC(Number(dueYmd.slice(0, 4)), Number(dueYmd.slice(4, 6)) - 1, Number(dueYmd.slice(6, 8)));
      db(ctx)
        .prepare(
          "INSERT INTO worklist_items (id, kind, title, detail_json, status, priority, due_at, created_at, updated_at) VALUES (?, 'audit', ?, ?, 'open', ?, ?, ?, ?)",
        )
        .run(newId("wl"), title, JSON.stringify({ audit_id: input.audit_id }), priority, dueMs, now, now);
    };

    const unfavorable = next.status === "closed_unfavorable" || next.status === "closed_partial" || next.status === "determination_received";
    if (unfavorable && next.determination_date) {
      const decidedLevel = (next.appeal_level ?? 0) as number;
      const nextLevel = Math.min(decidedLevel + 1, 5) as AppealLevel;
      const appeal = appealDeadline(nextLevel, next.determination_date);
      out.push("", "Appeal deadline:", describeDeadline(appeal));
      addWorklist(`File ${appeal.label} for audit ${input.audit_id}`, appeal.dueDate, 90);

      const remaining = appealLadder(next.determination_date, nextLevel).slice(1);
      if (remaining.length) {
        out.push("", "Later levels (clocks start when each decision arrives):");
        out.push(...remaining.map((d) => `  ${d.label} — ${d.note}`));
      }
    }

    if (next.demand_letter_date) {
      const rc = recoupmentTimeline(next.demand_letter_date);
      out.push(
        "",
        `Recoupment timeline (demand letter ${formatYmd(rc.demandLetterDate)}):`,
        describeDeadline(rc.stayByRedetermination),
        describeDeadline(rc.recoupmentBegins),
        `    ${rc.stayByReconsiderationNote}`,
      );
      addWorklist(`Stay recoupment on audit ${input.audit_id} (file redetermination)`, rc.stayByRedetermination.dueDate, 100);
    }

    return { content: out.join("\n") };
  },
});

export const auditResponseDraftTool = defineTool({
  name: "audit_response_draft",
  description:
    "Draft a response letter to a records request or audit determination, with a records-enclosed checklist and policy citations. Writes Markdown into the workspace for review. Look up supporting NCD/LCD language with the coverage tools first and pass the citations in.",
  schema: z.object({
    audit_id: z.string().optional().describe("Pull audit details from the tracker when supplied"),
    contractor: z.string(),
    audit_type: z.string().default("records request"),
    reference_number: z.string().default("").describe("The contractor's letter/case reference"),
    claim_refs: z.array(z.string()).default([]),
    records_enclosed: z.array(z.string()).default([]).describe("Documents being sent, e.g. 'Office note 2025-06-13', 'Signed order'"),
    argument: z.string().describe("De-identified narrative: why the services were reasonable, necessary, and correctly coded"),
    policy_citations: z.array(z.string()).default([]),
    output_path: z.string().default("audits/audit-response.md").describe("Workspace-relative output file"),
  }),
  assessRisk: (input) => ({ level: "confirm", reason: `write audit response to ${input.output_path}` }),
  execute: async (input, ctx) => {
    let received = "";
    let dueDate = "";
    let atRisk = "";
    if (input.audit_id) {
      const row = db(ctx).prepare("SELECT * FROM audit_requests WHERE id = ?").get(input.audit_id) as AuditRow | undefined;
      if (row) {
        received = formatYmd(row.received_date);
        dueDate = formatYmd(row.response_due_date);
        atRisk = money(row.amount_at_risk_cents);
      }
    }

    const claims = input.claim_refs.length ? input.claim_refs : ["(list claims under review)"];
    const letter = `# Response to ${input.audit_type} — ${input.contractor}

**To:** ${input.contractor} — Medical Review
${input.reference_number ? `**Reference:** ${input.reference_number}\n` : ""}${received ? `**Request received:** ${received}\n` : ""}${dueDate ? `**Response due:** ${dueDate}\n` : ""}${atRisk ? `**Amount under review:** ${atRisk}\n` : ""}
To Whom It May Concern:

This letter responds to your ${input.audit_type} regarding the claim(s) listed below. The requested documentation is enclosed, and we believe the records support that the services billed were reasonable and necessary and were coded correctly.

## Claims under review

${claims.map((c) => `- ${c}`).join("\n")}

## Documentation enclosed

${(input.records_enclosed.length ? input.records_enclosed : ["(itemize every document enclosed — an incomplete response is treated as no response)"]).map((r) => `- ${r}`).join("\n")}

## Basis for payment

${input.argument}

## Applicable policy

${(input.policy_citations.length ? input.policy_citations : ["(attach the applicable NCD/LCD or payer policy language)"]).map((c) => `- ${c}`).join("\n")}

## Request

We respectfully request that the claim(s) be found payable as billed. Please contact the undersigned if any additional documentation would assist your review.

Sincerely,

_${"{billing office signature block}"}_
`;

    const p = confinePath(ctx.workspaceRoot, input.output_path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, letter);
    return {
      content: `Audit response drafted at ${input.output_path}. Send it so it ARRIVES before the deadline — postmark generally does not count.\n\n${letter.slice(0, 1200)}`,
    };
  },
});

export const deadlineCalculatorTool = defineTool({
  name: "audit_deadline_calculator",
  description:
    "Compute Medicare audit and appeal deadlines from a date: documentation-response window, the five-level appeal ladder, the §935 recoupment timeline, the ACA 60-day report-and-return clock, and the next CMS-838 quarterly credit balance report. Use when you have a notice in hand and need to know what is due when.",
  schema: z.object({
    kind: z.enum(["documentation_response", "appeal", "recoupment", "report_and_return", "cms838"]),
    date: z.string().optional().describe("YYYYMMDD anchor date — the notice, determination, demand letter, or identification date"),
    appeal_level_just_decided: z.number().int().min(0).max(5).default(0).describe("For kind=appeal: 0 = initial determination"),
    response_days: z.number().int().optional().describe("For kind=documentation_response: override the 45-day default"),
  }),
  execute: async (input) => {
    const date = input.date ?? todayYmd();
    switch (input.kind) {
      case "documentation_response":
        return { content: describeDeadline(adrDeadline(date, input.response_days)) };
      case "appeal": {
        const next = Math.min(input.appeal_level_just_decided + 1, 5) as AppealLevel;
        const ladder = appealLadder(date, next);
        return { content: ["Appeal ladder from " + formatYmd(date) + ":", ...ladder.map(describeDeadline)].join("\n") };
      }
      case "recoupment": {
        const rc = recoupmentTimeline(date);
        return {
          content: [
            `Recoupment timeline from demand letter ${formatYmd(rc.demandLetterDate)}:`,
            describeDeadline(rc.stayByRedetermination),
            describeDeadline(rc.recoupmentBegins),
            `    ${rc.stayByReconsiderationNote}`,
          ].join("\n"),
        };
      }
      case "report_and_return": {
        const { refundDeadline } = await import("./deadlines.js");
        return { content: describeDeadline(refundDeadline(date)) };
      }
      case "cms838": {
        const { nextCms838Due } = await import("./deadlines.js");
        return { content: describeDeadline(nextCms838Due(date)) };
      }
    }
  },
});
