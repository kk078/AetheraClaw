import { z } from "zod";
import { defineTool } from "../../registry.js";
import type { MemoryStore } from "../../../memory/store.js";
import { dataDir, loadDataJson } from "../datasets.js";
import { loadEras } from "../analytics.js";
import {
  DEFAULT_CONVERSION_FACTOR,
  NATIONAL_GPCI,
  estimateAllowed,
  isFacilitySetting,
  renderEstimate,
  type Gpci,
  type RvuRow,
} from "./fee-schedule.js";
import {
  collectPaidLines,
  detectRateDrift,
  detectVariance,
  payerBaselines,
  renderVariance,
  type PaidLine,
} from "./variance.js";
import { rateCoverage, rateFor, renderCoverage } from "./contract.js";
import { buildVarianceWaterfall } from "../../../views/build.js";
import { loadContractRates } from "./contract-tools.js";
import { loadClaims } from "../../../reports/tools.js";
import { earliestServiceDate } from "../../../reports/aggregate.js";

type MpfsTable = Record<string, RvuRow>;

function conversionFactor(): number {
  return loadDataJson<{ cf: number }>("mpfs-cf.json")?.cf ?? DEFAULT_CONVERSION_FACTOR;
}

/** Locality GPCIs, keyed however the user names their localities in gpci.json. */
function gpciFor(locality: string | undefined): { gpci: Gpci; note: string } {
  if (!locality) return { gpci: NATIONAL_GPCI, note: "national (unadjusted) GPCIs" };
  const table = loadDataJson<Record<string, Gpci>>("gpci.json");
  const row = table?.[locality] ?? table?.[locality.toUpperCase()];
  if (!row) {
    return {
      gpci: NATIONAL_GPCI,
      note: `national (unadjusted) GPCIs — locality "${locality}" is not in gpci.json, so this estimate is NOT locality-accurate`,
    };
  }
  return { gpci: row, note: `GPCIs for locality "${locality}" (work ${row.work}, PE ${row.pe}, MP ${row.mp})` };
}

export const reimbursementEstimateTool = defineTool({
  name: "reimbursement_estimate",
  description:
    "Estimate the Medicare allowed amount for a procedure using the official MPFS formula — [(work RVU × work GPCI) + (PE RVU × PE GPCI) + (MP RVU × MP GPCI)] × conversion factor — then apply the payment rules that actually decide the number: facility vs non-facility practice expense (place of service), modifier adjustments checked against the code's own MPFS policy indicators (bilateral 50, multiple-procedure reduction, assistant at surgery 80/81/82/AS at 16%, co-surgery 62 at 62.5%), the 85% rate for a PA/NP billing under their own NPI, and 2% sequestration on the Medicare share. Requires mpfs.json; gpci.json and mpfs-cf.json refine it.",
  schema: z.object({
    code: z.string(),
    units: z.number().int().min(1).default(1),
    place_of_service: z.string().default("11").describe("Drives facility vs non-facility practice expense"),
    modifiers: z.array(z.string()).default([]),
    locality: z.string().optional().describe("Key into gpci.json; omit for national unadjusted rates"),
    multiple_procedure_rank: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe("1 for the highest-valued procedure on the claim, 2+ for subsequent ones"),
    rendered_by_npp: z.boolean().default(false).describe("Billed under a PA/NP/CNS's own NPI"),
    apply_sequestration: z.boolean().default(true).describe("Medicare only — commercial payers are not sequestered"),
  }),
  execute: async (input) => {
    const mpfs = loadDataJson<MpfsTable>("mpfs.json");
    if (!mpfs) {
      return {
        content: `MPFS RVU data not installed — drop mpfs.json into ${dataDir()}. Each entry is {"CODE": {"work": n, "pe": n, "facilityPe": n, "mp": n, "bilateral": "1", "multipleProcedure": "2", "assistantSurgery": "1", "coSurgery": "0"}}; only work, pe and mp are required.`,
      };
    }
    const code = input.code.trim().toUpperCase();
    const row = mpfs[code];
    if (!row) return { content: `No RVU data for ${code} in mpfs.json.` };

    const { gpci, note } = gpciFor(input.locality);
    const cf = conversionFactor();
    const estimate = estimateAllowed({
      code,
      row,
      units: input.units,
      placeOfService: input.place_of_service,
      gpci,
      conversionFactor: cf,
      modifiers: input.modifiers,
      multipleProcedureRank: input.multiple_procedure_rank,
      renderedByNpp: input.rendered_by_npp,
      applySequestration: input.apply_sequestration,
    });

    const notes = [`Using ${note}, conversion factor $${cf}.`];
    if (row.facilityPe === undefined && isFacilitySetting(input.place_of_service)) {
      notes.push(
        "This code has no separate facility PE RVU in the installed data, so the non-facility value was used — the estimate will read high for a facility setting.",
      );
    }
    return { content: [renderEstimate(estimate), "", ...notes].join("\n") };
  },
});

export const paymentVarianceTool = defineTool({
  name: "payment_variance",
  description:
    "Find underpaid lines across stored remittances. Recovers what each payer actually allowed (paid + patient responsibility + sequestration, since CARC 253 is a reduction to the federal payment rather than to the allowed amount) and compares it two ways. 'payer_history' measures each payer against its own established median for that code and works for any payer without knowing the contract. 'fee_schedule' compares against the Medicare MPFS and is meaningful for Medicare; commercial payers pay a contracted percentage of Medicare, so expect apparent variance there.",
  schema: z.object({
    basis: z.enum(["payer_history", "fee_schedule", "contract"]).default("payer_history"),
    payer: z.string().optional().describe("Substring filter on payer name"),
    tolerance_pct: z.number().min(0).max(1).default(0.02).describe("Ignore shortfalls under this share of expected"),
    min_dollars: z.number().min(0).default(1),
    min_sample: z.number().int().min(2).default(3).describe("Lines needed before a payer's own history is a baseline"),
    locality: z.string().optional(),
    apply_sequestration: z.boolean().default(true).describe("fee_schedule basis only"),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore;
    const eras = loadEras(store);
    if (eras.length === 0) {
      return { content: "No remittance data yet — parse 835 files with era_parse_835 first." };
    }
    let lines = collectPaidLines(eras);
    if (input.payer) {
      const needle = input.payer.toLowerCase();
      lines = lines.filter((l) => l.payer.toLowerCase().includes(needle));
    }
    if (lines.length === 0) return { content: "No adjudicated service lines matched." };

    let expectedByCode: Map<string, number> | undefined;
    let expectedFor: ((line: PaidLine) => { expected: number; note: string } | undefined) | undefined;
    const notes: string[] = [];

    if (input.basis === "contract") {
      const rates = loadContractRates(store);
      if (rates.length === 0) {
        return {
          content:
            'No contracted rates on file. Record them with contract_rate_set, or use basis="payer_history", which measures each payer against its own established median and needs no contract — it can show that a payment is unusual, though never that it breaches an agreement.',
          isError: true,
        };
      }

      // Rate selection is by DATE OF SERVICE, which the remittance does not
      // carry — so it is looked up from the stored claim. Using the remittance
      // date instead would apply an amendment to claims serviced before it took
      // effect, and near a rate change that is most of them.
      const serviceDates = new Map<string, string>();
      for (const stored of loadClaims({ services: ctx.services })) {
        serviceDates.set(stored.claimId.trim().toUpperCase(), earliestServiceDate(stored.claim));
      }

      let undated = 0;
      expectedFor = (line) => {
        const serviceDate = serviceDates.get(line.claimId.trim().toUpperCase());
        if (!serviceDate) {
          undated++;
          return undefined;
        }
        const rate = rateFor(rates, {
          payer: line.payer,
          code: line.code,
          modifiers: line.modifiers,
          serviceDate,
        });
        return rate ? { expected: rate.allowed, note: `the contracted rate (${rate.source})` } : undefined;
      };

      const billed = lines.flatMap((l) => {
        const serviceDate = serviceDates.get(l.claimId.trim().toUpperCase());
        return serviceDate ? [{ payer: l.payer, code: l.code, serviceDate }] : [];
      });
      notes.push(renderCoverage(rateCoverage(rates, billed)));
      if (undated > 0) {
        notes.push(
          `${undated} adjudicated line(s) belong to claims not stored here, so their date of service is unknown and no contracted rate could be selected for them. They were skipped rather than measured against today's rate.`,
        );
      }
    }

    if (input.basis === "fee_schedule") {
      const mpfs = loadDataJson<MpfsTable>("mpfs.json");
      if (!mpfs) {
        return {
          content: `The fee_schedule basis needs mpfs.json in ${dataDir()}. Use basis="payer_history" to run against each payer's own established rate instead — that needs no fee schedule at all.`,
          isError: true,
        };
      }
      const { gpci, note } = gpciFor(input.locality);
      const cf = conversionFactor();
      expectedByCode = new Map();
      for (const code of new Set(lines.map((l) => l.code))) {
        const row = mpfs[code];
        if (!row) continue;
        // Per-unit, non-facility, no modifier rules: the remittance does not say
        // which setting or ranking applied, so the comparison is deliberately the
        // simple one and the output says so.
        const e = estimateAllowed({
          code,
          row,
          units: 1,
          gpci,
          conversionFactor: cf,
          applySequestration: input.apply_sequestration,
        });
        expectedByCode.set(code, e.allowed);
      }
      notes.push(
        `Expected amounts use ${note} at the non-facility rate with no modifier adjustments — the remittance does not report the setting or the multiple-procedure ranking, so a facility service or a reduced subsequent procedure will look underpaid here.`,
        `${expectedByCode.size} of ${new Set(lines.map((l) => l.code)).size} billed code(s) had RVU data; the rest were skipped.`,
      );
    }

    const findings = detectVariance(lines, {
      basis: input.basis,
      expectedByCode,
      expectedFor,
      baselines: input.basis === "payer_history" ? payerBaselines(lines) : undefined,
      tolerancePct: input.tolerance_pct,
      minSample: input.min_sample,
      minDollars: input.min_dollars,
    });

    if (input.basis === "payer_history" && findings.length > 0) {
      // A median spanning a reprice sits between two rates, so every line at the
      // newer rate reads as underpaid. That is a contract change to renegotiate,
      // not a batch of claims to dispute one by one — different remedy entirely.
      const drifted = new Set(
        detectRateDrift(lines).map((d) => `${d.payer.toUpperCase()}|${d.code.toUpperCase()}`),
      );
      const affected = findings.filter((f) => drifted.has(`${f.payer.toUpperCase()}|${f.code.toUpperCase()}`));
      if (affected.length > 0) {
        const combos = [...new Set(affected.map((f) => `${f.payer} ${f.code}`))];
        notes.push(
          `${affected.length} of these shortfalls are on payer/code combinations that show a sustained rate drop (${combos.join(", ")}). The median for those straddles the old and new rates, so the individual "shortfalls" are one reprice rather than separate underpayments — run fee_schedule_drift and take it up as a contract question, not claim by claim.`,
        );
      }
    }

    const content = [
      renderVariance(findings, { linesExamined: lines.length, basis: input.basis }),
      ...(notes.length ? ["", ...notes.map((n) => `Note: ${n}`)] : []),
    ].join("\n");
    return {
      content,
      view: {
        kind: "money_waterfall",
        data: buildVarianceWaterfall(findings, { basis: input.basis, linesExamined: lines.length }),
      },
    };
  },
});

export const feeScheduleDriftTool = defineTool({
  name: "fee_schedule_drift",
  description:
    "Detect a payer quietly repricing a code. Splits each payer × code payment history at its midpoint by remittance date and compares the medians — a step down that holds is a fee schedule change nobody sent a letter about, and it keeps costing money on every claim until someone notices. Needs enough history per code to be meaningful.",
  schema: z.object({
    payer: z.string().optional(),
    threshold_pct: z.number().min(0).max(1).default(0.05).describe("Report drops larger than this"),
    min_per_half: z.number().int().min(2).default(3).describe("Lines required on each side of the split"),
  }),
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore;
    const eras = loadEras(store);
    if (eras.length === 0) {
      return { content: "No remittance data yet — parse 835 files with era_parse_835 first." };
    }
    let lines = collectPaidLines(eras);
    if (input.payer) {
      const needle = input.payer.toLowerCase();
      lines = lines.filter((l) => l.payer.toLowerCase().includes(needle));
    }

    const drifts = detectRateDrift(lines, {
      minPerHalf: input.min_per_half,
      thresholdPct: input.threshold_pct,
    });
    if (drifts.length === 0) {
      return {
        content: `No downward rate drift over ${(input.threshold_pct * 100).toFixed(0)}% found across ${lines.length} adjudicated line(s). This needs at least ${input.min_per_half * 2} payments for the same payer and code before it can compare anything, so a quiet history may simply mean not enough data yet.`,
      };
    }
    const total = drifts.length;
    return {
      content: [
        `${total} payer/code combination(s) are being paid materially less than they were:`,
        "",
        ...drifts.map((d) => `  ${d.message}`),
        "",
        "Compare each against the fee schedule attached to that contract before disputing — a reprice you agreed to looks identical to one you did not.",
      ].join("\n"),
    };
  },
});
