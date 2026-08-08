import { envelope, parseX12, seg, serializeX12, type Segment } from "./segments.js";

// ── 276/277 claim status inquiry ─────────────────────────────────────────────
// The one transaction this system diagnosed the need for and could not perform.
// `support_trace_claim` and `ops_generate_rca` both end at the same sentence for
// a claim that was accepted and never paid — "chase the payer" — and there was
// nothing to chase with.
//
// 276 asks a payer where one specific claim is. 277 answers. It is NOT the same
// as the 277CA already in this codebase: that is an acknowledgment a
// clearinghouse pushes at you unprompted, saying whether a claim got through the
// front door. This is a question you ask, months later, about a claim that got
// through the front door and then went quiet.
//
// THE ANSWER THAT MATTERS MOST IS "NO RECORD". A payer replying that it has
// never heard of the claim is not a pending status and must never be rendered as
// one: it means the claim is not in adjudication, was never in adjudication, and
// every day spent waiting for a remittance was spent waiting for nothing. That
// is a resubmission, immediately, against a filing clock that has been running
// the whole time.
//
// THE SECOND THING PEOPLE GET WRONG IS PENDING. A claim sitting at "pending, in
// process" for two hundred days feels safe because the payer has it. Timely
// filing does not pause for adjudication, and appeal rights do not accrue while
// a claim is pending, because nothing has been determined. Pending is a status,
// not a protection.

export interface ClaimStatusRequest {
  payerId: string;
  payerName: string;
  providerNpi: string;
  providerName: string;
  subscriberId: string;
  patientLast: string;
  patientFirst: string;
  claimId: string;
  /** YYYYMMDD. The payer matches on this, so a wrong date returns "no record". */
  serviceDateFrom: string;
  serviceDateTo?: string;
  chargeAmount?: number;
}

/**
 * Health Care Claim Status Category Codes, grouped by what they mean for action.
 *
 * `settled` marks the categories where the claim has left the payer's queue —
 * finalized either way, or never in it. Anything else is still in flight, and
 * the distinction decides whether the next step is "wait" or "do something".
 */
export const STATUS_CATEGORY_276: Record<string, { desc: string; settled: boolean; action: string }> = {
  A0: { desc: "Acknowledgment — forwarded", settled: false, action: "The claim moved on to another entity. Ask again after that entity has had time to receive it." },
  A1: { desc: "Acknowledgment — receipt", settled: false, action: "The payer has it. Nothing to do yet, but the filing clock is still running." },
  A2: { desc: "Acknowledgment — acceptance", settled: false, action: "Accepted into adjudication. This is the status a clean claim sits at before a decision." },
  A3: { desc: "Acknowledgment — returned, not processed", settled: true, action: "NOT in adjudication. Correct whatever the status code names and resubmit; there is nothing to appeal, because nothing was decided." },
  A4: { desc: "Acknowledgment — not found", settled: true, action: "The payer has no record of this claim. Resubmit now — every day since submission was spent waiting for a decision that was never going to come." },
  A5: { desc: "Acknowledgment — split claim", settled: false, action: "The claim was split; expect more than one remittance. Reconcile against all of them before calling it underpaid." },
  A6: { desc: "Acknowledgment — rejected for missing information", settled: true, action: "Rejected before adjudication. Supply what the status code names and resubmit." },
  A7: { desc: "Acknowledgment — rejected for invalid information", settled: true, action: "Rejected before adjudication. Correct the named element and resubmit." },
  A8: { desc: "Acknowledgment — rejected for relational field errors", settled: true, action: "Two fields that must agree do not. Correct and resubmit." },
  P0: { desc: "Pending — awaiting further review", settled: false, action: "In the payer's queue. Timely filing does NOT pause for this, and no appeal rights accrue while it pends." },
  P1: { desc: "Pending — in process", settled: false, action: "Normal adjudication. Compare the elapsed time against this payer's own history before escalating." },
  P2: { desc: "Pending — payer review (medical necessity or similar)", settled: false, action: "Under review. Records may be requested next — check whether an ADR has arrived by another channel." },
  P3: { desc: "Pending — provider requested information", settled: false, action: "THE PAYER IS WAITING ON YOU. This one is not passive: it stops moving until something is sent, and it is the most commonly missed pending status." },
  P4: { desc: "Pending — patient requested information", settled: false, action: "Waiting on the patient (usually a COB or accident questionnaire). Contact them; the claim will not move otherwise." },
  P5: { desc: "Pending — payer administrative or system hold", settled: false, action: "Held on the payer's side. Worth a call if it persists beyond their normal turnaround." },
  F0: { desc: "Finalized", settled: true, action: "A decision exists. Expect a remittance; if none arrived, the ERA delivery path is the problem rather than the claim." },
  F1: { desc: "Finalized — payment made as primary", settled: true, action: "Paid as primary. Reconcile against the 835." },
  F2: { desc: "Finalized — payment made as secondary", settled: true, action: "Paid as secondary. Confirm the primary's adjudication carried over correctly." },
  F3: { desc: "Finalized — revised, adjudication changed", settled: true, action: "The decision was revised. There may be a second remittance, or a takeback." },
  F4: { desc: "Finalized — adjudication complete, NO payment", settled: true, action: "Denied. Appeal rights exist and their deadline runs from the determination date, not from today." },
  F5: { desc: "Finalized — no payment, patient responsibility", settled: true, action: "Assigned to the patient. Bill them only after confirming the determination is correct." },
  R0: { desc: "Requests for additional information — general", settled: false, action: "Send what is asked for; the claim is stopped until you do." },
  E0: { desc: "Response not possible — error in the request", settled: true, action: "The 276 itself was malformed. Fix the inquiry, not the claim." },
  E1: { desc: "Response not possible — system status", settled: true, action: "The payer's system could not answer. Retry later; this says nothing about the claim." },
  D0: { desc: "Data search unsuccessful — no record", settled: true, action: "The payer cannot find it on the identifiers given. Either the claim never arrived, or the search keys are wrong — check the subscriber id and service date before concluding it was lost." },
};

export function categoryInfo(code: string): { desc: string; settled: boolean; action: string } {
  const c = code.trim().toUpperCase();
  return (
    STATUS_CATEGORY_276[c] ?? {
      desc: "category not in the bundled table",
      settled: false,
      action: "Read the response — this category is not one the bundled table explains, and guessing would send the follow-up in the wrong direction.",
    }
  );
}

/** Categories meaning the payer does not have the claim in adjudication at all. */
const NOT_IN_ADJUDICATION = new Set(["A3", "A4", "A6", "A7", "A8", "D0"]);

export function build276(req: ClaimStatusRequest): string {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const body: Segment[] = [];

  body.push(seg("BHT", "0010", "13", req.claimId, ymd, now.toISOString().slice(11, 16).replace(":", "")));
  // 2100A payer, 2100B provider, 2100C subscriber, 2200D the claim itself.
  body.push(seg("HL", "1", "", "20", "1"));
  body.push(seg("NM1", "PR", "2", req.payerName, "", "", "", "", "PI", req.payerId));
  body.push(seg("HL", "2", "1", "21", "1"));
  body.push(seg("NM1", "41", "2", req.providerName, "", "", "", "", "XX", req.providerNpi));
  body.push(seg("HL", "3", "2", "22", "0"));
  body.push(seg("NM1", "IL", "1", req.patientLast, req.patientFirst, "", "", "", "MI", req.subscriberId));
  body.push(seg("TRN", "1", req.claimId));
  body.push(seg("REF", "1K", req.claimId));
  if (req.chargeAmount !== undefined) body.push(seg("AMT", "T3", req.chargeAmount.toFixed(2)));
  body.push(seg("DTP", "232", req.serviceDateTo ? "RD8" : "D8", req.serviceDateTo ? `${req.serviceDateFrom}-${req.serviceDateTo}` : req.serviceDateFrom));

  return serializeX12(
    envelope({
      senderId: req.providerNpi,
      receiverId: req.payerId,
      controlNumber: "1",
      functionalCode: "HR",
      transactionSetId: "276",
      date: ymd.slice(2),
      time: now.toISOString().slice(11, 16).replace(":", ""),
      body,
    }),
  );
}

export interface ClaimStatusLine {
  procedure: string;
  category: string;
  statusCode: string;
  amount?: number;
}

export interface ClaimStatus {
  claimId: string;
  payerClaimNumber: string;
  category: string;
  statusCode: string;
  /** YYYYMMDD when the payer states an effective date for the status. */
  effectiveDate: string;
  chargeAmount?: number;
  paidAmount?: number;
  lines: ClaimStatusLine[];
}

export interface ClaimStatusResponse {
  payer: string;
  statuses: ClaimStatus[];
  /** True when NOTHING in the response is a real claim status — a malformed or empty answer. */
  empty: boolean;
}

export function parse277(text: string): ClaimStatusResponse {
  const segments = parseX12(text);
  const out: ClaimStatusResponse = { payer: "", statuses: [], empty: true };
  let current: ClaimStatus | null = null;
  let inLine = false;

  const push = () => {
    if (current) out.statuses.push(current);
    current = null;
  };

  for (const s of segments) {
    const e = s.elements;
    switch (s.id) {
      case "NM1":
        if (e[0] === "PR") out.payer = e[2] ?? "";
        break;
      case "TRN":
        // A new tracking number starts a new claim status.
        push();
        inLine = false;
        current = {
          claimId: e[1] ?? "",
          payerClaimNumber: "",
          category: "",
          statusCode: "",
          effectiveDate: "",
          lines: [],
        };
        break;
      case "STC": {
        const parts = (e[0] ?? "").split(":");
        const category = parts[0] ?? "";
        const statusCode = parts[1] ?? "";
        if (!current) break;
        if (inLine && current.lines.length > 0) {
          const line = current.lines[current.lines.length - 1];
          line.category = category;
          line.statusCode = statusCode;
          if (e[3]) line.amount = Number(e[3]);
        } else {
          // The claim-level STC. Only the FIRST is taken as the claim's status:
          // a payer may repeat STC with supplementary codes, and letting a later
          // one overwrite would replace the decision with a footnote.
          if (!current.category) {
            current.category = category;
            current.statusCode = statusCode;
            current.effectiveDate = e[1] ?? "";
            if (e[3]) current.chargeAmount = Number(e[3]);
            if (e[4]) current.paidAmount = Number(e[4]);
          }
        }
        break;
      }
      case "REF":
        if (current && (e[0] === "1K" || e[0] === "BLT")) current.payerClaimNumber = e[1] ?? "";
        break;
      case "SVC":
        if (!current) break;
        inLine = true;
        current.lines.push({ procedure: (e[0] ?? "").split(":")[1] ?? e[0] ?? "", category: "", statusCode: "" });
        break;
      case "SE":
        push();
        break;
      default:
        break;
    }
  }
  push();

  out.empty = out.statuses.every((s) => !s.category);
  return out;
}

export interface StatusReading {
  status: ClaimStatus;
  desc: string;
  settled: boolean;
  action: string;
  /** The payer does not have this claim in adjudication. */
  notInAdjudication: boolean;
  /** Days from the service date, when one was supplied. */
  ageDays: number | null;
}

export function readStatus(status: ClaimStatus, serviceDate: string | undefined, now: number): StatusReading {
  const info = categoryInfo(status.category);
  let ageDays: number | null = null;
  if (serviceDate && /^\d{8}$/.test(serviceDate)) {
    const ms = Date.UTC(+serviceDate.slice(0, 4), +serviceDate.slice(4, 6) - 1, +serviceDate.slice(6, 8));
    ageDays = Math.floor((now - ms) / 86_400_000);
  }
  return {
    status,
    desc: info.desc,
    settled: info.settled,
    action: info.action,
    notInAdjudication: NOT_IN_ADJUDICATION.has(status.category.trim().toUpperCase()),
    ageDays,
  };
}

export function renderStatus(readings: StatusReading[], payer: string, simulated: boolean): string {
  if (readings.length === 0) {
    return "The 277 response carried no claim status. That is not the same as 'no record' — it is an unusable answer, and the inquiry is worth repeating before drawing any conclusion from it.";
  }

  const lines: string[] = [];
  if (simulated) {
    lines.push(
      "SIMULATED RESPONSE — no real payer connection is configured, so nothing below reflects what any payer actually holds. It exercises the workflow, not the claim.",
      "",
    );
  }
  lines.push(`Claim status from ${payer || "(payer not named)"}:`, "");

  for (const r of readings) {
    const s = r.status;
    lines.push(
      `  ${s.claimId || "(no id)"} — ${s.category}:${s.statusCode}  ${r.desc}` +
        (r.ageDays !== null ? `  ·  ${r.ageDays} day(s) since service` : ""),
    );
    if (s.payerClaimNumber) lines.push(`      payer claim number ${s.payerClaimNumber} — record this; it is what a call or an appeal is indexed by`);
    if (s.paidAmount !== undefined) lines.push(`      paid $${s.paidAmount.toFixed(2)}${s.chargeAmount !== undefined ? ` of $${s.chargeAmount.toFixed(2)}` : ""}`);
    lines.push(`      ${r.action}`);
    for (const l of s.lines) {
      if (!l.category) continue;
      lines.push(`      line ${l.procedure}: ${l.category}:${l.statusCode} — ${categoryInfo(l.category).desc}`);
    }
    lines.push("");
  }

  const lost = readings.filter((r) => r.notInAdjudication);
  if (lost.length > 0) {
    lines.push(
      `${lost.length} claim(s) are NOT in adjudication — the payer either never received them or returned them unprocessed.`,
      "Nothing was decided, so there are no appeal rights and nothing to appeal. Resubmit, and run timely_filing_check first: the deadline has been running throughout, and on a claim that has been waiting months there may be very little of it left.",
      "",
    );
  }

  const pending = readings.filter((r) => !r.settled);
  if (pending.length > 0) {
    lines.push(
      `${pending.length} still pending. Pending is a status, not a protection — timely filing does not pause for adjudication, and no appeal rights accrue while a claim pends, because nothing has been determined.`,
    );
    if (readings.some((r) => r.status.category.trim().toUpperCase() === "P3")) {
      lines.push("At least one is pending on INFORMATION FROM YOU (P3). That one will not move on its own, and it is the most commonly missed status here.");
    }
  }
  return lines.join("\n").trimEnd();
}

// ── Tool ─────────────────────────────────────────────────────────────────────

import { z } from "zod";
import { defineTool } from "../../registry.js";
import type { MemoryStore } from "../../../memory/store.js";

/**
 * A simulated 277, derived from the request rather than random.
 *
 * Deterministic on the claim id so the same inquiry gives the same answer twice
 * — a mock that changed its mind between calls would make the workflow look
 * broken. The distribution deliberately includes "no record" and "pending on
 * provider information", because those are the two answers that change what
 * somebody does, and a mock that only ever returned "in process" would let the
 * handling for them ship untested.
 */
function simulate277(req: ClaimStatusRequest): ClaimStatusResponse {
  const seed = [...req.claimId].reduce((a, c) => a + c.charCodeAt(0), 0);
  const pick = ["P1", "F1", "D0", "P3", "F4", "A2"][seed % 6];
  return {
    payer: req.payerName,
    empty: false,
    statuses: [
      {
        claimId: req.claimId,
        payerClaimNumber: `MOCK${seed}`,
        category: pick,
        statusCode: pick.startsWith("F") ? "65" : "20",
        effectiveDate: req.serviceDateFrom,
        chargeAmount: req.chargeAmount,
        paidAmount: pick === "F1" ? Number(((req.chargeAmount ?? 0) * 0.62).toFixed(2)) : undefined,
        lines: [],
      },
    ],
  };
}

export const claimStatusInquiryTool = defineTool({
  name: "claim_status_inquiry",
  description:
    "Ask a payer where one specific claim is (X12 276/277) and read the answer. This is what to run on a claim that was accepted and then went quiet — support_trace_claim and ops_generate_rca both diagnose that state and stop here. Not the same as ack_parse_277ca: that is an unprompted acknowledgment saying a claim got through the front door, this is a question about a claim that got through and then produced no remittance. The answer that matters most is NO RECORD — it means the claim is not in adjudication and never was, so every day spent waiting was spent for nothing and the filing clock ran the whole time.",
  schema: z.object({
    claim_id: z.string().describe("Patient control number of the claim to ask about"),
    payer_id: z.string().describe("Payer EDI id"),
    payer_name: z.string(),
    provider_npi: z.string(),
    provider_name: z.string(),
    subscriber_id: z.string().describe("Member id — synthetic/test data only"),
    patient_last: z.string(),
    patient_first: z.string(),
    service_date_from: z.string().regex(/^\d{8}$/).describe("YYYYMMDD. The payer matches on this — a wrong date returns 'no record' and looks like a lost claim."),
    service_date_to: z.string().regex(/^\d{8}$/).optional(),
    charge_amount: z.number().optional(),
    show_edi: z.boolean().default(false).describe("Include the generated 276 text"),
  }),
  execute: async (input, ctx) => {
    const req: ClaimStatusRequest = {
      payerId: input.payer_id,
      payerName: input.payer_name,
      providerNpi: input.provider_npi,
      providerName: input.provider_name,
      subscriberId: input.subscriber_id,
      patientLast: input.patient_last,
      patientFirst: input.patient_first,
      claimId: input.claim_id,
      serviceDateFrom: input.service_date_from,
      serviceDateTo: input.service_date_to,
      chargeAmount: input.charge_amount,
    };

    const edi = build276(req);
    // v1 has no real payer connection, exactly as with eligibility. The
    // response is simulated and labelled as such on every line of output — a
    // fabricated claim status presented as real would be the single most
    // damaging output this system could produce.
    const response = simulate277(req);
    const now = Date.now();
    const readings = response.statuses.map((s) => readStatus(s, input.service_date_from, now));

    const parts = [renderStatus(readings, response.payer, true)];

    // Nothing is written to the claim record. A simulated status must not become
    // a stored fact about a real claim — that is how a mock ends up in an appeal.
    parts.push(
      "",
      "Nothing was written to the claim record. A simulated status must not become a stored fact, and a real connector is a config change against the ClearinghouseConnector seam rather than a rewrite.",
    );
    if (input.show_edi) parts.push("", "Generated 276:", edi);

    void (ctx.services.store as MemoryStore | undefined);
    return { content: parts.join("\n") };
  },
});
