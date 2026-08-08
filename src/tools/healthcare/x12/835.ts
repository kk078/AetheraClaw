import { z } from "zod";
import { defineTool } from "../../registry.js";
import { explainDenial } from "../denial-codes.js";
import { parseX12 } from "./segments.js";
import { newId } from "../../../shared/ids.js";
import type { MemoryStore } from "../../../memory/store.js";
import { denialCandidates, renderIngest, type IngestSummary } from "../prediction/intake.js";

export interface EraAdjustment {
  group: string; // CO, PR, OA, PI
  carc: string;
  amount: number;
}

export interface EraServiceLine {
  procedure: string;
  charged: number;
  paid: number;
  units: number;
  adjustments: EraAdjustment[];
  rarcs: string[];
}

export interface EraClaim {
  claimId: string;
  statusCode: string; // 1=paid primary, 2=paid secondary, 4=denied, 22=reversal
  charged: number;
  paid: number;
  patientResponsibility: number;
  payerControlNumber: string;
  lines: EraServiceLine[];
}

export interface Era {
  payer: string;
  payee: string;
  checkOrEftAmount: number;
  claims: EraClaim[];
}

export function parse835(text: string): Era {
  const segments = parseX12(text);
  const era: Era = { payer: "", payee: "", checkOrEftAmount: 0, claims: [] };
  let claim: EraClaim | null = null;
  let line: EraServiceLine | null = null;
  let inPayerLoop = false;

  for (const s of segments) {
    switch (s.id) {
      case "BPR":
        era.checkOrEftAmount = Number(s.elements[1] ?? 0);
        break;
      case "N1":
        if (s.elements[0] === "PR") {
          era.payer = s.elements[1] ?? "";
          inPayerLoop = true;
        } else if (s.elements[0] === "PE") {
          era.payee = s.elements[1] ?? "";
          inPayerLoop = false;
        }
        break;
      case "CLP":
        claim = {
          claimId: s.elements[0] ?? "",
          statusCode: s.elements[1] ?? "",
          charged: Number(s.elements[2] ?? 0),
          paid: Number(s.elements[3] ?? 0),
          patientResponsibility: Number(s.elements[4] ?? 0),
          payerControlNumber: s.elements[6] ?? "",
          lines: [],
        };
        era.claims.push(claim);
        line = null;
        break;
      case "SVC": {
        if (!claim) break;
        const proc = (s.elements[0] ?? "").split(":").slice(1).join(":") || (s.elements[0] ?? "");
        line = {
          procedure: proc,
          charged: Number(s.elements[1] ?? 0),
          paid: Number(s.elements[2] ?? 0),
          units: Number(s.elements[4] ?? 1),
          adjustments: [],
          rarcs: [],
        };
        claim.lines.push(line);
        break;
      }
      case "CAS": {
        const target = line ?? null;
        const group = s.elements[0] ?? "";
        // CAS repeats triplets: reason, amount, quantity
        for (let i = 1; i + 1 < s.elements.length + 1; i += 3) {
          const carc = s.elements[i];
          const amount = Number(s.elements[i + 1] ?? 0);
          if (!carc) break;
          const adj: EraAdjustment = { group, carc, amount };
          if (target) target.adjustments.push(adj);
          else if (claim) {
            // claim-level adjustment: attach to a synthetic line-less bucket
            claim.lines.push({ procedure: "(claim level)", charged: 0, paid: 0, units: 0, adjustments: [adj], rarcs: [] });
          }
        }
        break;
      }
      case "LQ":
        if (line && s.elements[0] === "HE" && s.elements[1]) line.rarcs.push(s.elements[1]);
        break;
      default:
        break;
    }
  }
  void inPayerLoop;
  return era;
}

export function summarizeEra(era: Era): string {
  const out: string[] = [
    `Payer: ${era.payer}  Payee: ${era.payee}  Payment: $${era.checkOrEftAmount.toFixed(2)}`,
    `Claims: ${era.claims.length}`,
  ];
  for (const c of era.claims) {
    const status =
      c.statusCode === "1" ? "PAID (primary)" : c.statusCode === "2" ? "PAID (secondary)" : c.statusCode === "4" ? "DENIED" : `status ${c.statusCode}`;
    out.push(`\nClaim ${c.claimId} — ${status}: charged $${c.charged.toFixed(2)}, paid $${c.paid.toFixed(2)}, patient resp $${c.patientResponsibility.toFixed(2)}`);
    for (const l of c.lines) {
      out.push(`  ${l.procedure}: charged $${l.charged.toFixed(2)} paid $${l.paid.toFixed(2)}`);
      for (const a of l.adjustments) {
        out.push(`    ${a.group}-${a.carc}: -$${a.amount.toFixed(2)}`);
        out.push(
          explainDenial(a.carc, l.rarcs)
            .split("\n")
            .map((x) => `      ${x}`)
            .join("\n"),
        );
      }
    }
  }
  return out.join("\n");
}

/**
 * Open a worklist item per denial, skipping ones already open.
 *
 * Deduplication is on the claim+CARC key rather than on a row id, so parsing the
 * same remittance twice — which happens routinely, since a clearinghouse
 * download and an email attachment are the same file — adds nothing. Only OPEN
 * items suppress: an item somebody already worked and closed should reappear if
 * the payer denies the same claim again.
 */
function ingestDenials(store: MemoryStore, era: Era, now: number): IngestSummary {
  const candidates = denialCandidates(era);
  const adjustmentCount = era.claims.reduce(
    (n, c) => n + c.lines.reduce((m, l) => m + l.adjustments.length, 0),
    0,
  );

  const find = store.db.prepare(
    "SELECT id FROM worklist_items WHERE kind = 'denial' AND status IN ('open','in_progress') AND json_extract(detail_json, '$.key') = ?",
  );
  const insert = store.db.prepare(
    `INSERT INTO worklist_items (id, kind, title, detail_json, status, priority, created_at, updated_at)
     VALUES (?, 'denial', ?, ?, 'open', 0, ?, ?)`,
  );

  let opened = 0;
  let alreadyOpen = 0;
  let totalCents = 0;
  store.db.transaction(() => {
    for (const c of candidates) {
      if (find.get(c.key)) {
        alreadyOpen++;
        continue;
      }
      insert.run(
        newId("wl"),
        c.title,
        JSON.stringify({
          key: c.key,
          claim_id: c.claimId,
          payer: c.payer,
          carc: c.carc,
          procedure: c.procedure,
          amount_cents: c.amountCents,
          source: "era_parse_835",
        }),
        now,
        now,
      );
      opened++;
      totalCents += c.amountCents;
    }
  })();

  return {
    opened,
    alreadyOpen,
    skippedNonRecoverable: Math.max(0, adjustmentCount - candidates.length),
    totalCents,
  };
}

export const eraParse835Tool = defineTool({
  name: "era_parse_835",
  description:
    "Parse an X12 835 electronic remittance advice (ERA): payments, adjustments, and denials per claim and service line, with CARC/RARC codes explained.",
  schema: z.object({ era_text: z.string().describe("Raw 835 file contents") }),
  execute: async (input, ctx) => {
    const era = parse835(input.era_text);
    const store = (ctx.services.store ?? null) as MemoryStore | null;
    if (!store?.db) return { content: summarizeEra(era) };

    const now = Date.now();
    store.db
      .prepare("INSERT INTO remittances (id, payer, era_json, received_at) VALUES (?, ?, ?, ?)")
      .run(newId("era"), era.payer, JSON.stringify(era), now);

    // Denials become worklist rows here rather than waiting for someone to read
    // the summary and open them by hand — which is how the small ones never got
    // opened at all. The queue computes priority from live rows, so there is no
    // stored score to invalidate; getting the rows in IS the event handling.
    const summary = ingestDenials(store, era, now);
    return { content: summarizeEra(era) + renderIngest(summary, era.payer || "this payer") };
  },
});
