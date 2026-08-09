import { z } from "zod";
import { defineTool } from "../../registry.js";
import { newId } from "../../../shared/ids.js";
import type { MemoryStore } from "../../../memory/store.js";
import { baseProcedureCode, composite, parseX12 } from "./segments.js";

// ── 277CA Health Care Claim Acknowledgment ───────────────────────────────────
// The payer/clearinghouse answer to an 837, sent BEFORE adjudication. A claim
// rejected here never entered the payer's system: there is nothing to appeal,
// no remittance will ever arrive, and the timely-filing clock keeps running.
// Front-end rejections are the ones that quietly age out, which is why parsing
// these promptly matters more than their small size suggests.

/** STC01-1 — Health Care Claim Status Category Code. */
export const STATUS_CATEGORIES: Record<string, { desc: string; accepted: boolean }> = {
  A0: { desc: "Acknowledgement — forwarded to the next entity", accepted: true },
  A1: { desc: "Acknowledgement — receipt confirmed", accepted: true },
  A2: { desc: "Acknowledgement — accepted into the adjudication system", accepted: true },
  A3: { desc: "Acknowledgement — RETURNED AS UNPROCESSABLE", accepted: false },
  A4: { desc: "Acknowledgement — not found", accepted: false },
  A5: { desc: "Acknowledgement — split claim", accepted: true },
  A6: { desc: "Acknowledgement — REJECTED for missing information", accepted: false },
  A7: { desc: "Acknowledgement — REJECTED for invalid information", accepted: false },
  A8: { desc: "Acknowledgement — REJECTED, relational field in error", accepted: false },
  E0: { desc: "Response not possible — error on submitted request data", accepted: false },
  E1: { desc: "Response not possible — system status", accepted: false },
  E3: { desc: "Correction required — relational fields in error", accepted: false },
  P0: { desc: "Pending — in process", accepted: true },
  P1: { desc: "Pending — in process, awaiting adjudication", accepted: true },
  P2: { desc: "Pending — payer review", accepted: true },
  P3: { desc: "Pending — provider requested information", accepted: true },
  P4: { desc: "Pending — patient requested information", accepted: true },
  P5: { desc: "Pending — payer administrative/system hold", accepted: true },
  F0: { desc: "Finalized — the claim has completed adjudication", accepted: true },
  F1: { desc: "Finalized/Payment — the claim has been paid", accepted: true },
  F2: { desc: "Finalized/Denial — the claim has been denied", accepted: true },
  F3: { desc: "Finalized/Revised — adjudication information has changed", accepted: true },
  D0: { desc: "Data search unsuccessful", accepted: false },
  R1: { desc: "Request for additional information — entity", accepted: true },
  R3: { desc: "Request for additional information — claim/line", accepted: true },
};

/** STC01-2 — Health Care Claim Status Code (common subset of the X12 list). */
export const STATUS_CODES: Record<string, { desc: string; fix: string }> = {
  "16": { desc: "Claim/encounter has been forwarded to entity", fix: "No action — the claim was routed onward." },
  "19": { desc: "Entity acknowledges receipt of claim/encounter", fix: "No action — receipt confirmed." },
  "20": { desc: "Accepted for processing into the adjudication system", fix: "No action — awaiting adjudication." },
  "21": { desc: "Missing or invalid information", fix: "Read the paired entity code to see WHICH party's data is wrong, correct it, and resubmit." },
  "24": { desc: "Entity not approved as an electronic submitter", fix: "Enrollment issue — complete EDI enrollment with this payer before resubmitting." },
  "26": { desc: "Entity not found", fix: "Verify the identifier for the flagged entity against the payer's records." },
  "33": { desc: "Subscriber and subscriber ID not found", fix: "Verify member ID and name against the card; run an eligibility check before resubmitting." },
  "35": { desc: "Claim/encounter not found", fix: "The payer has no record — verify it was actually transmitted before resubmitting." },
  "88": { desc: "Entity not eligible for benefits for the submitted dates of service", fix: "Verify coverage dates; bill the correct payer or the patient." },
  "109": { desc: "Entity not eligible for encounter submission", fix: "Confirm the provider is contracted for this line of business." },
  "116": { desc: "Claim submitted to incorrect payer", fix: "Identify the correct payer (run eligibility / COB), then submit there. Timely filing keeps running." },
  "145": { desc: "Entity's specialty/taxonomy code", fix: "Correct the taxonomy code on the billing or rendering provider loop." },
  "146": { desc: "Entity's date of birth", fix: "Correct the date of birth to match the payer's member record." },
  "153": { desc: "Entity's ID number", fix: "Correct the flagged entity's identifier." },
  "187": { desc: "Date(s) of service", fix: "Correct the service date — check format, ordering, and that it falls within the coverage period." },
  "188": { desc: "Statement from/through date", fix: "Correct the statement date range." },
  "206": { desc: "National Provider Identifier — missing", fix: "Supply the NPI for the flagged provider loop." },
  "207": { desc: "National Provider Identifier — invalid format", fix: "Verify the NPI passes check-digit validation (npi_validate)." },
  "208": { desc: "National Provider Identifier — not matched", fix: "The NPI is valid but unknown to this payer — verify enrollment and the exact registered name." },
  "218": { desc: "NDC number", fix: "Supply or correct the NDC for the drug billed." },
  "234": { desc: "Patient relationship to subscriber", fix: "Correct the relationship code in the subscriber/patient loop." },
  "247": { desc: "Line information", fix: "A service line is malformed — check the line the status is attached to." },
  "249": { desc: "Place of service", fix: "Correct the POS code for the setting where the service was furnished." },
  "255": { desc: "Diagnosis code", fix: "Correct the diagnosis — check ICD-10 validity and specificity (icd10_validate)." },
  "285": { desc: "Facility admission date", fix: "Supply or correct the admission date." },
  "306": { desc: "Detailed description of service", fix: "Supply a description for the unlisted or NOC procedure billed." },
  "400": { desc: "Claim is out of balance", fix: "Line charges must sum to the claim total — recheck the math, especially on secondary claims." },
  "453": { desc: "Procedure code for services rendered", fix: "Correct the procedure code." },
  "454": { desc: "Procedure code for services rendered — modifier", fix: "Correct or supply the modifier." },
  "455": { desc: "Revenue code for services rendered", fix: "Correct the revenue code (institutional claims)." },
  "496": { desc: "Submitted charges", fix: "Correct the charge amount — it must be greater than zero and match the line sum." },
  "509": { desc: "Entity's Blue Cross provider ID", fix: "Supply the plan-assigned provider identifier." },
  "560": { desc: "Entity's additional/secondary identifier", fix: "Supply the secondary identifier the payer requires." },
  "562": { desc: "Entity's National Provider Identifier (NPI)", fix: "Verify the NPI for the flagged entity — validate the check digit and confirm payer enrollment." },
  "630": { desc: "Referring provider identifier", fix: "Supply the referring provider's NPI." },
  "634": { desc: "Remark code", fix: "See the accompanying free-form message for detail." },
  "732": { desc: "Information submitted inconsistent with billing guidelines", fix: "A relational edit failed — the fields are individually valid but contradict each other." },
  "746": { desc: "Duplicate submission", fix: "Do not resubmit — check the status of the original claim first." },
};

/** STC01-3 — Entity Identifier Code: which party the problem is attached to. */
export const ENTITY_CODES: Record<string, string> = {
  "1P": "Provider",
  "2B": "Third-party administrator",
  "36": "Employer",
  "40": "Receiver",
  "41": "Submitter",
  "45": "Drop-off location",
  "71": "Attending physician",
  "72": "Operating physician",
  "73": "Other physician",
  "77": "Service location",
  "82": "Rendering provider",
  "85": "Billing provider",
  "87": "Pay-to provider",
  DK: "Ordering physician",
  DN: "Referring provider",
  DQ: "Supervising physician",
  IL: "Insured / subscriber",
  PR: "Payer",
  QB: "Purchase service provider",
  QC: "Patient",
  TT: "Transfer-to facility",
};

export interface AckStatus {
  category: string;
  categoryDesc: string;
  accepted: boolean;
  statusCode: string;
  statusDesc: string;
  fix: string;
  entity: string;
  entityDesc: string;
}

export interface AckServiceLine {
  procedure: string;
  charged: number;
  statuses: AckStatus[];
}

export interface AckClaim {
  claimId: string; // patient control number from the original 837
  payerClaimNumber: string;
  statuses: AckStatus[];
  charged: number;
  serviceDate: string;
  lines: AckServiceLine[];
  accepted: boolean;
  freeText: string;
}

export interface Acknowledgment {
  /** YYYYMMDD the acknowledgment was produced (BHT04) — the date that proves receipt. */
  ackDate: string;
  payer: string;
  submitter: string;
  provider: string;
  batchStatuses: AckStatus[];
  acceptedCount: number | null;
  rejectedCount: number | null;
  claims: AckClaim[];
}

function decodeStatus(raw: string | undefined): AckStatus | null {
  const parts = composite(raw);
  const category = (parts[0] ?? "").toUpperCase();
  if (!category) return null;
  const statusCode = parts[1] ?? "";
  const entity = (parts[2] ?? "").toUpperCase();
  const cat = STATUS_CATEGORIES[category];
  const st = STATUS_CODES[statusCode];
  return {
    category,
    categoryDesc: cat?.desc ?? `category ${category} — not in bundled dataset; consult the X12 claim status category code list`,
    // Unknown category defaults to NOT accepted. Defaulting to accepted banked a
    // timely-filing proof and skipped the rejection worklist for a claim the
    // payer never actually acknowledged — a bogus proof that could later anchor a
    // losing appeal. An unknown code is a claim a person should look at, not one
    // to quietly mark good.
    accepted: cat?.accepted ?? false,
    statusCode,
    statusDesc: st?.desc ?? (statusCode ? `status code ${statusCode} — not in bundled dataset; consult the X12 claim status code list` : ""),
    fix: st?.fix ?? (statusCode ? "Look up this status code in the X12 list to determine the correction." : ""),
    entity,
    entityDesc: entity ? (ENTITY_CODES[entity] ?? `entity ${entity}`) : "",
  };
}

/** STC carries up to three status composites: STC01, STC10, STC11. */
function statusesFrom(elements: string[]): AckStatus[] {
  return [elements[0], elements[9], elements[10]]
    .map(decodeStatus)
    .filter((s): s is AckStatus => s !== null);
}

export function parse277ca(text: string): Acknowledgment {
  const segments = parseX12(text);
  const ack: Acknowledgment = {
    ackDate: "",
    payer: "",
    submitter: "",
    provider: "",
    batchStatuses: [],
    acceptedCount: null,
    rejectedCount: null,
    claims: [],
  };

  let claim: AckClaim | null = null;
  let line: AckServiceLine | null = null;

  for (const s of segments) {
    switch (s.id) {
      case "BHT":
        // BHT04 is the date this acknowledgment was created. Claim-level STC02
        // dates repeat it, so the header is the single source.
        if (/^\d{8}$/.test(s.elements[3] ?? "")) ack.ackDate = s.elements[3];
        break;
      case "NM1": {
        const role = s.elements[0];
        const name = s.elements[2] ?? "";
        if (role === "PR" && !ack.payer) ack.payer = name;
        else if (role === "41" && !ack.submitter) ack.submitter = name;
        else if (role === "85" && !ack.provider) ack.provider = name;
        break;
      }
      case "TRN":
        // TRN01 = 2 marks a referenced trace number: the patient control number
        // from the original 837, i.e. the start of a claim's status block.
        if (s.elements[0] === "2") {
          claim = {
            claimId: s.elements[1] ?? "",
            payerClaimNumber: "",
            statuses: [],
            charged: 0,
            serviceDate: "",
            lines: [],
            accepted: true,
            freeText: "",
          };
          ack.claims.push(claim);
          line = null;
        }
        break;
      case "STC": {
        const statuses = statusesFrom(s.elements);
        const charge = Number(s.elements[3] ?? 0);
        const freeText = s.elements[11] ?? "";
        if (line) {
          line.statuses.push(...statuses);
        } else if (claim) {
          claim.statuses.push(...statuses);
          if (charge) claim.charged = charge;
          if (freeText) claim.freeText = freeText;
        } else {
          ack.batchStatuses.push(...statuses);
        }
        break;
      }
      case "QTY":
        // 90 = accepted quantity, AA = rejected quantity (batch totals).
        if (s.elements[0] === "90") ack.acceptedCount = Number(s.elements[1] ?? 0);
        else if (s.elements[0] === "AA") ack.rejectedCount = Number(s.elements[1] ?? 0);
        break;
      case "REF":
        // 1K = payer claim control number assigned to an accepted claim.
        if (claim && (s.elements[0] === "1K" || s.elements[0] === "D9")) {
          claim.payerClaimNumber = claim.payerClaimNumber || (s.elements[1] ?? "");
        }
        break;
      case "DTP":
        if (claim && s.elements[0] === "472") claim.serviceDate = s.elements[2] ?? "";
        break;
      case "SVC":
        if (claim) {
          line = {
            procedure: baseProcedureCode(s.elements[0] ?? ""),
            charged: Number(s.elements[1] ?? 0),
            statuses: [],
          };
          claim.lines.push(line);
        }
        break;
      case "HL":
        // A new hierarchical level ends any open claim/line context.
        line = null;
        break;
      default:
        break;
    }
  }

  for (const c of ack.claims) {
    const all = [...c.statuses, ...c.lines.flatMap((l) => l.statuses)];
    c.accepted = all.length === 0 ? true : all.every((s) => s.accepted);
  }
  return ack;
}

export function summarizeAck(ack: Acknowledgment): string {
  const rejected = ack.claims.filter((c) => !c.accepted);
  const accepted = ack.claims.filter((c) => c.accepted);
  const out: string[] = [
    `277CA from ${ack.payer || "(payer)"}${ack.submitter ? ` to ${ack.submitter}` : ""}${ack.provider ? ` for ${ack.provider}` : ""}`,
    `${ack.claims.length} claim(s): ${accepted.length} accepted, ${rejected.length} REJECTED` +
      (ack.acceptedCount !== null || ack.rejectedCount !== null
        ? `  (batch totals report ${ack.acceptedCount ?? "?"} accepted / ${ack.rejectedCount ?? "?"} rejected)`
        : ""),
  ];

  if (ack.batchStatuses.length) {
    out.push("", "Batch-level status:");
    for (const s of ack.batchStatuses) out.push(`  ${s.category} ${s.categoryDesc}`);
  }

  if (rejected.length) {
    out.push("", "REJECTED — these never entered adjudication:");
    for (const c of rejected) {
      out.push(
        `  ${c.claimId}${c.charged ? `  $${c.charged.toFixed(2)}` : ""}${c.serviceDate ? `  DOS ${c.serviceDate}` : ""}`,
      );
      for (const s of c.statuses) {
        out.push(`    ${s.category}:${s.statusCode}${s.entity ? `:${s.entity}` : ""} — ${s.statusDesc || s.categoryDesc}`);
        if (s.entityDesc) out.push(`      Party at fault: ${s.entityDesc}`);
        if (s.fix) out.push(`      Fix: ${s.fix}`);
      }
      for (const l of c.lines) {
        for (const s of l.statuses) {
          out.push(`    line ${l.procedure}: ${s.category}:${s.statusCode} — ${s.statusDesc || s.categoryDesc}`);
          if (s.fix) out.push(`      Fix: ${s.fix}`);
        }
      }
      if (c.freeText) out.push(`    Payer message: ${c.freeText}`);
    }
    out.push(
      "",
      "A rejected claim was never adjudicated: there are no appeal rights, no remittance will arrive, and the timely-filing clock is still running. Correct and resubmit — do not appeal.",
    );
  }

  if (accepted.length) {
    out.push("", "Accepted:");
    for (const c of accepted) {
      const status = c.statuses[0];
      out.push(
        `  ${c.claimId}${c.payerClaimNumber ? `  payer claim # ${c.payerClaimNumber}` : ""}${status ? `  (${status.category} ${status.categoryDesc})` : ""}`,
      );
    }
  }
  return out.join("\n");
}

export const ackParse277caTool = defineTool({
  name: "ack_parse_277ca",
  description:
    "Parse an X12 277CA claim acknowledgment — the payer or clearinghouse response to an 837, sent before adjudication. Splits accepted from rejected claims, decodes each status category/status/entity triplet into what is wrong and which party's data caused it, and opens worklist items for rejections. Front-end rejections never enter the payer's system: they cannot be appealed, no remittance will follow, and timely filing keeps running — so work them immediately.",
  schema: z.object({
    ack_text: z.string().describe("Raw 277CA file contents"),
    create_worklist_items: z.boolean().default(true).describe("Open a worklist item per rejected claim"),
  }),
  execute: async (input, ctx) => {
    const ack = parse277ca(input.ack_text);
    const store = ctx.services.store as MemoryStore | undefined;
    const rejected = ack.claims.filter((c) => !c.accepted);
    let worklisted = 0;
    let statusUpdated = 0;
    let proofBanked = 0;

    if (store) {
      const now = Date.now();
      for (const c of ack.claims) {
        // Reflect the acknowledgment on any claim we recorded at build time.
        const res = store.db
          .prepare("UPDATE claims SET status = ?, updated_at = ? WHERE json_extract(claim_json, '$.claim_id') = ?")
          .run(c.accepted ? "submitted" : "rejected", now, c.claimId);
        statusUpdated += Number(res.changes);

        // Bank the acceptance as proof of timely filing. A timely-filing denial
        // can arrive many months later, and by then the acknowledgment that
        // would have won the appeal is usually long gone.
        if (c.accepted && ack.ackDate) {
          store.db
            .prepare(
              `INSERT OR IGNORE INTO filing_proof (id, claim_id, accepted_on, payer, payer_claim_number, source, recorded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(newId("fp"), c.claimId, ack.ackDate, ack.payer, c.payerClaimNumber, "277CA acknowledgment", now);
          proofBanked++;
        }
      }
      if (input.create_worklist_items) {
        for (const c of rejected) {
          const reason = c.statuses[0];
          // Skip a claim that already has an open rejection item. Reparsing the
          // same 277CA is routine — a clearinghouse download and an email
          // attachment are the same file — and without this each reparse opened
          // a second identical item, double-counting the work queue. The sibling
          // 835 denial path (ingestDenials) dedupes the same way.
          const already = store.db
            .prepare(
              "SELECT id FROM worklist_items WHERE kind = 'rejection' AND status IN ('open','in_progress') AND json_extract(detail_json, '$.claim_id') = ?",
            )
            .get(c.claimId);
          if (already) continue;
          store.db
            .prepare(
              "INSERT INTO worklist_items (id, kind, title, detail_json, status, priority, due_at, created_at, updated_at) VALUES (?, 'rejection', ?, ?, 'open', ?, ?, ?, ?)",
            )
            .run(
              newId("wl"),
              `Correct and resubmit ${c.claimId} — ${reason?.statusDesc ?? reason?.categoryDesc ?? "front-end rejection"}`,
              JSON.stringify({
                claim_id: c.claimId,
                payer: ack.payer,
                statuses: c.statuses.map((s) => `${s.category}:${s.statusCode}:${s.entity}`),
                fix: reason?.fix ?? "",
              }),
              80,
              null,
              now,
              now,
            );
          worklisted++;
        }
      }
    }

    const footer: string[] = [];
    if (worklisted) footer.push(`${worklisted} worklist item(s) opened for the rejected claims.`);
    if (statusUpdated) footer.push(`${statusUpdated} recorded claim(s) updated with their acknowledgment status.`);
    if (proofBanked)
      footer.push(
        `${proofBanked} acceptance(s) banked as proof of timely filing (dated ${ack.ackDate}). If any of these later denies for timely filing, that acknowledgment is the evidence the appeal needs.`,
      );
    return { content: [summarizeAck(ack), ...(footer.length ? ["", ...footer] : [])].join("\n") };
  },
});
