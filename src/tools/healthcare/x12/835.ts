import { z } from "zod";
import { defineTool } from "../../registry.js";
import { explainDenial } from "../denial-codes.js";
import { parseX12, type Segment } from "./segments.js";
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

/**
 * A PLB — provider-level adjustment.
 *
 * Money in an 835 moves at two levels. The claims explain what was decided about
 * each bill; the PLB loop explains everything the payer did to the CHECK that has
 * nothing to do with any one claim on it — a recoupment of something paid three
 * months ago, interest owed, a levy, a balance carried forward.
 *
 * SIGN: a POSITIVE amount REDUCES the payment. That is the opposite of every
 * intuition about a positive number and it is the single easiest thing to get
 * backwards here, so it is encoded once, in `checkEffect` (src/reports/
 * reconcile.ts), and nowhere else.
 */
export interface EraProviderAdjustment {
  /** PLB01 — the provider the adjustment is against. */
  providerId: string;
  /** PLB02 — fiscal period end, CCYYMMDD. */
  fiscalPeriod: string;
  /** First half of the composite: WO, FB, L6, … */
  reasonCode: string;
  /** Second half: usually the claim or account the adjustment traces back to. */
  referenceId: string;
  /** As written in the file. Positive reduces the check. */
  amount: number;
}

export interface Era {
  payer: string;
  payee: string;
  checkOrEftAmount: number;
  claims: EraClaim[];
  providerAdjustments: EraProviderAdjustment[];
}

/** Parse one transaction set's segments into an Era. */
function segmentsToEra(segments: Segment[]): Era {
  const era: Era = { payer: "", payee: "", checkOrEftAmount: 0, claims: [], providerAdjustments: [] };
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
      case "PLB": {
        // PLB01 provider, PLB02 fiscal period, then up to six
        // (composite reason:reference, amount) PAIRS. Walking in twos rather
        // than assuming one adjustment per segment matters: a payer that
        // recoups four claims in one cheque commonly writes them as four pairs
        // in a single PLB, and reading only the first would understate the
        // takeback by three quarters while still producing a plausible number.
        const providerId = s.elements[0] ?? "";
        const fiscalPeriod = s.elements[1] ?? "";
        for (let i = 2; i + 1 < s.elements.length; i += 2) {
          const composite = s.elements[i];
          if (!composite) continue;
          const [reasonCode, ...ref] = composite.split(":");
          if (!reasonCode) continue;
          const amount = Number(s.elements[i + 1]);
          if (!Number.isFinite(amount)) continue;
          era.providerAdjustments.push({
            providerId,
            fiscalPeriod,
            reasonCode: reasonCode.toUpperCase(),
            referenceId: ref.join(":"),
            amount,
          });
        }
        break;
      }
      default:
        break;
    }
  }
  void inPayerLoop;
  return era;
}

/**
 * Every 835 transaction set in the file, one Era each.
 *
 * A payer routinely batches several remittances — each its own BPR/cheque and
 * its own ST…SE envelope — into a single interchange. Parsing the flat segment
 * list as ONE Era kept only the last BPR while accumulating every claim, so a
 * perfectly balanced batched file reported a phantom "-$100.00 DOES NOT BALANCE"
 * (and two cheques with offsetting errors could conversely net to a false
 * "balances"). Splitting on ST/SE keeps each cheque with its own claims.
 */
export function parse835All(text: string): Era[] {
  const segments = parseX12(text);
  const groups: Segment[][] = [];
  let current: Segment[] | null = null;
  for (const s of segments) {
    if (s.id === "ST") {
      current = [];
      groups.push(current);
    }
    if (current) current.push(s);
    if (s.id === "SE") current = null;
  }
  // No ST envelope at all (a bare 835 body) → the whole thing is one set.
  return groups.length === 0 ? [segmentsToEra(segments)] : groups.map(segmentsToEra);
}

export function parse835(text: string): Era {
  const eras = parse835All(text);
  if (eras.length <= 1) return eras[0] ?? { payer: "", payee: "", checkOrEftAmount: 0, claims: [], providerAdjustments: [] };
  // A batched file collapsed to one Era for the single-Era callers: sum the
  // cheques, concatenate the claims and provider adjustments, keep the distinct
  // payer/payee names. Per-cheque reconciliation uses parse835All instead, so
  // this aggregate never has to individually balance.
  const distinct = (xs: string[]) => [...new Set(xs.filter(Boolean))].join("; ");
  return {
    payer: distinct(eras.map((e) => e.payer)),
    payee: distinct(eras.map((e) => e.payee)),
    checkOrEftAmount: Math.round(eras.reduce((n, e) => n + e.checkOrEftAmount, 0) * 100) / 100,
    claims: eras.flatMap((e) => e.claims),
    providerAdjustments: eras.flatMap((e) => e.providerAdjustments),
  };
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
        // CAS amounts are signed and a POSITIVE amount reduces the payment, so
        // the effect on the cheque is its negation. A reversal remittance carries
        // a negative amount that INCREASES payment; the old unconditional "-$"
        // prefix rendered that as a garbled "-$-34.50" and read it as a
        // deduction. Show the sign of the effect, once.
        const effect = -a.amount;
        out.push(`    ${a.group}-${a.carc}: ${effect < 0 ? "-" : "+"}$${Math.abs(a.amount).toFixed(2)}`);
        out.push(
          explainDenial(a.carc, l.rarcs)
            .split("\n")
            .map((x) => `      ${x}`)
            .join("\n"),
        );
      }
    }
  }

  // Named here, at the top of what anybody reads after a parse, because a
  // provider-level adjustment is the one thing on a remittance that moves money
  // without appearing against any claim. Left unmentioned it is invisible: the
  // claim list looks complete and the deposit is quietly short.
  const plb = era.providerAdjustments ?? [];
  if (plb.length > 0) {
    const net = plb.reduce((s, a) => s - a.amount, 0);
    out.push(
      "",
      `${plb.length} provider-level adjustment(s) on this remittance, netting ${net < 0 ? "-" : ""}$${Math.abs(net).toFixed(2)} against the cheque: ${plb.map((a) => a.reasonCode).join(", ")}.`,
      "Run era_reconcile to tie the deposit to the claims — these dollars do not belong to any claim above.",
    );
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
