import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { defineTool } from "../tools/registry.js";
import { newId } from "../shared/ids.js";
import { confinePath } from "../tools/path-guard.js";
import type { Config } from "../config/config.js";
import type { MemoryStore } from "../memory/store.js";
import type { ClaimInput } from "../tools/healthcare/x12/837.js";
import type { Era } from "../tools/healthcare/x12/835.js";
import type { StoredClaim, StoredEra } from "../reports/aggregate.js";
import { fitModel, renderModel, type PracticeModel } from "./model.js";
import { compare, forecast, renderComparison, renderForecast } from "./monte-carlo.js";
import { BASELINE, checkScenario, describeScenario, scenario, type Scenario } from "./scenarios.js";
import {
  account,
  draftPatientLetter,
  planOutreach,
  renderOutreach,
  scorePropensity,
  type PatientAccount,
} from "./patient-comms.js";
import { renderFanChart } from "./chart.js";

type Ctx = { services: Record<string, unknown> };

function store(ctx: Ctx): MemoryStore {
  return ctx.services.store as MemoryStore;
}

function loadClaims(ctx: Ctx): StoredClaim[] {
  const rows = store(ctx)
    .db.prepare("SELECT id, payer, claim_json, status, created_at FROM claims")
    .all() as Array<{ id: string; payer: string; claim_json: string; status: string; created_at: number }>;
  return rows.flatMap((r) => {
    try {
      const claim = JSON.parse(r.claim_json) as ClaimInput;
      return [{ claimId: claim.claim_id ?? r.id, payer: r.payer, claim, createdAt: r.created_at, status: r.status }];
    } catch {
      return [];
    }
  });
}

function loadEras(ctx: Ctx): StoredEra[] {
  const rows = store(ctx)
    .db.prepare("SELECT payer, era_json, received_at FROM remittances")
    .all() as Array<{ payer: string; era_json: string; received_at: number }>;
  return rows.flatMap((r) => {
    try {
      return [{ era: JSON.parse(r.era_json) as Era, receivedAt: r.received_at, payer: r.payer }];
    } catch {
      return [];
    }
  });
}

function buildModel(ctx: Ctx): PracticeModel {
  return fitModel(loadClaims(ctx), loadEras(ctx), Date.now());
}

export const revenueModelFitTool = defineTool({
  name: "revenue_model_fit",
  description:
    "Fit a model of the practice from its own claims and remittances: payer mix, collection ratio, denial rate, patient share, and how long each payer actually takes to pay. Claims still outstanding are carried into the timing fit as censored observations rather than dropped — fitting only from claims that have paid fits only the fast ones and reports a practice that gets paid sooner than it does. Says what it could not fit instead of quietly averaging over it.",
  schema: z.object({}),
  execute: async (_input, ctx) => ({ content: renderModel(buildModel(ctx)) }),
});

const ScenarioSchema = z.object({
  kind: z
    .enum(["baseline", "drop_payer", "rate_change", "volume_change", "add_provider", "denial_rate_change"])
    .default("baseline"),
  payer: z.string().default("").describe("Which payer the change applies to. Empty means all of them."),
  change: z.number().default(0).describe("Proportional change, e.g. -0.03 for a 3% cut"),
  productivity: z.number().default(0).describe("add_provider: output as a share of an average existing provider"),
  start_day: z.number().int().min(0).default(0).describe("Days from now the change takes effect"),
  ramp_days: z.number().int().min(0).default(90).describe("add_provider: days to reach full productivity"),
});

function toScenario(input: z.infer<typeof ScenarioSchema>): Scenario {
  return scenario({
    kind: input.kind,
    payer: input.payer,
    change: input.change,
    productivity: input.productivity,
    startDay: input.start_day,
    rampDays: input.ramp_days,
  });
}

const ForecastOptionsSchema = {
  horizon_days: z.number().int().min(7).max(730).default(90),
  paths: z.number().int().min(50).max(5000).default(400),
  seed: z.number().int().default(1).describe("Same seed reproduces the same simulation"),
  payer_shock_sd: z
    .number()
    .min(0)
    .max(1)
    .default(0.15)
    .describe("Dispersion of the per-payer shock. Set to 0 to sample claims independently — narrower bands, and wrong."),
  patient_collection_rate: z.number().min(0).max(1).default(0.5),
  patient_lag_days: z.number().int().min(0).max(365).default(45),
};

function recordRun(ctx: Ctx, scen: Scenario, f: ReturnType<typeof forecast>, report: string): string {
  const id = newId("fcst");
  const end = f.total[f.horizonDays];
  store(ctx)
    .db.prepare(
      `INSERT INTO forecast_runs (id, scenario, scenario_json, horizon_days, paths, seed, p10_cents, p50_cents, p90_cents, report, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      scen.kind,
      JSON.stringify(scen),
      f.horizonDays,
      f.paths,
      f.seed,
      Math.round(end.p10 * 100),
      Math.round(end.p50 * 100),
      Math.round(end.p90 * 100),
      report,
      Date.now(),
    );
  return id;
}

export const cashForecastTool = defineTool({
  name: "cash_forecast",
  description:
    "Forecast cash over the coming weeks from the fitted model, as a range rather than a number. Claims already submitted are simulated on the remaining part of their timing curve — a ninety-day-old claim is not a fresh one — and future work is billed then paid on the lag. Insurance and patient cash are separate lines because a dollar assigned to a patient is not a dollar collected. Bands cover per-claim timing, denials and a per-payer shock, and are stated as a floor on uncertainty rather than a range.",
  schema: z.object({ ...ForecastOptionsSchema, save: z.boolean().default(true) }),
  execute: async (input, ctx) => {
    const model = buildModel(ctx);
    const f = forecast(model, BASELINE, {
      horizonDays: input.horizon_days,
      paths: input.paths,
      seed: input.seed,
      payerShockSd: input.payer_shock_sd,
      patientCollectionRate: input.patient_collection_rate,
      patientLagDays: input.patient_lag_days,
    });
    const report = renderForecast(f);
    const id = input.save ? recordRun(ctx, BASELINE, f, report) : "";
    return { content: id ? `${report}\n\nRun ${id}.` : report };
  },
});

export const simulateScenarioTool = defineTool({
  name: "simulate_scenario",
  description:
    "Run a what-if against the baseline: drop a payer, change rates or volume, add a provider, or move the denial rate. Scenarios change work not yet done — claims already submitted still pay out, so dropping a payer shows the tail running dry rather than a cliff on day one, and adding a provider shows the cash ramp trailing the charge ramp by however long that payer takes to pay. That gap is usually the answer someone is actually looking for.",
  schema: z.object({ ...ScenarioSchema.shape, ...ForecastOptionsSchema }),
  execute: async (input, ctx) => {
    const model = buildModel(ctx);
    const scen = toScenario(input);
    const check = checkScenario(scen, model);
    if (!check.ok) return { content: check.problems.join("\n"), isError: true };

    const options = {
      horizonDays: input.horizon_days,
      paths: input.paths,
      seed: input.seed,
      payerShockSd: input.payer_shock_sd,
      patientCollectionRate: input.patient_collection_rate,
      patientLagDays: input.patient_lag_days,
    };
    const baseline = forecast(model, BASELINE, options);
    const alternative = forecast(model, scen, options);
    const report = renderComparison(compare(baseline, alternative));
    recordRun(ctx, scen, alternative, report);
    return { content: report };
  },
});

export const forecastChartTool = defineTool({
  name: "forecast_chart",
  description:
    "Write the cash forecast as a standalone HTML page with a fan chart — the P10-P90 band drawn as a widening envelope, which is the honest way to look at a projection. Opens in a browser with no server and no chart library.",
  schema: z.object({
    ...ScenarioSchema.shape,
    ...ForecastOptionsSchema,
    output: z.string().default("forecast.html").describe("Workspace-relative path"),
  }),
  assessRisk: (input) => ({ level: "confirm" as const, reason: `write forecast chart to ${input.output}` }),
  execute: async (input, ctx) => {
    const model = buildModel(ctx);
    const scen = toScenario(input);
    const check = checkScenario(scen, model);
    if (!check.ok) return { content: check.problems.join("\n"), isError: true };

    const f = forecast(model, scen, {
      horizonDays: input.horizon_days,
      paths: input.paths,
      seed: input.seed,
      payerShockSd: input.payer_shock_sd,
      patientCollectionRate: input.patient_collection_rate,
      patientLagDays: input.patient_lag_days,
    });

    const config = ctx.services.config as Config;
    const target = confinePath(config.workspaceRoot, input.output);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, renderFanChart(f, model), "utf8");
    return { content: `Wrote ${input.output}.\n\n${renderForecast(f)}` };
  },
});

// ── Patient balances ─────────────────────────────────────────────────────────

interface AccountRow {
  patient_ref: string;
  balance_cents: number;
  balance_since: string;
  insurance_adjudicated: number;
  prior_payments: number;
  prior_paid_cents: number;
  broken_plans: number;
  on_payment_plan: number;
  financial_assistance_screened: number;
  statements_sent: number;
}

function ageDays(since: string, now: number): number {
  if (!/^\d{8}$/.test(since)) return 0;
  const ms = Date.UTC(Number(since.slice(0, 4)), Number(since.slice(4, 6)) - 1, Number(since.slice(6, 8)));
  return Math.max(0, Math.floor((now - ms) / 86_400_000));
}

function toAccount(row: AccountRow, now: number): PatientAccount {
  return account({
    patientRef: row.patient_ref,
    balanceCents: row.balance_cents,
    balanceAgeDays: ageDays(row.balance_since, now),
    insuranceAdjudicated: row.insurance_adjudicated === 1,
    priorPayments: row.prior_payments,
    priorPaidCents: row.prior_paid_cents,
    brokenPlans: row.broken_plans,
    onPaymentPlan: row.on_payment_plan === 1,
    financialAssistanceScreened: row.financial_assistance_screened === 1,
    statementsSent: row.statements_sent,
  });
}

export const patientBalanceAddTool = defineTool({
  name: "patient_balance_add",
  description:
    "Record a patient balance for outreach planning. Use a de-identified reference, never a name or member ID. The fields are limited to what the account has done — payments, plans, balance size and age — and there is deliberately nowhere to put demographics: scoring people on those would be discrimination with a revenue-cycle label on it.",
  schema: z.object({
    patient_ref: z.string().describe("De-identified reference"),
    balance: z.number().min(0).describe("Patient's share, in dollars"),
    balance_since: z.string().default("").describe("YYYYMMDD the balance became the patient's"),
    insurance_adjudicated: z.boolean().default(true).describe("Has the payer finished with it?"),
    prior_payments: z.number().int().min(0).default(0),
    prior_paid: z.number().min(0).default(0).describe("Dollars this account has paid, ever"),
    broken_plans: z.number().int().min(0).default(0),
    on_payment_plan: z.boolean().default(false),
    financial_assistance_screened: z.boolean().default(false),
    statements_sent: z.number().int().min(0).default(0),
    note: z.string().default(""),
  }),
  execute: async (input, ctx) => {
    const now = Date.now();
    store(ctx)
      .db.prepare(
        `INSERT INTO patient_accounts (patient_ref, balance_cents, balance_since, insurance_adjudicated,
           prior_payments, prior_paid_cents, broken_plans, on_payment_plan, financial_assistance_screened,
           statements_sent, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(patient_ref) DO UPDATE SET
           balance_cents = excluded.balance_cents, balance_since = excluded.balance_since,
           insurance_adjudicated = excluded.insurance_adjudicated, prior_payments = excluded.prior_payments,
           prior_paid_cents = excluded.prior_paid_cents, broken_plans = excluded.broken_plans,
           on_payment_plan = excluded.on_payment_plan,
           financial_assistance_screened = excluded.financial_assistance_screened,
           statements_sent = excluded.statements_sent, note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(
        input.patient_ref,
        Math.round(input.balance * 100),
        input.balance_since,
        input.insurance_adjudicated ? 1 : 0,
        input.prior_payments,
        Math.round(input.prior_paid * 100),
        input.broken_plans,
        input.on_payment_plan ? 1 : 0,
        input.financial_assistance_screened ? 1 : 0,
        input.statements_sent,
        input.note,
        now,
        now,
      );

    const row = store(ctx).db.prepare("SELECT * FROM patient_accounts WHERE patient_ref = ?").get(input.patient_ref) as AccountRow;
    const score = scorePropensity(toAccount(row, now));
    return { content: `${input.patient_ref} recorded. Score ${score.score.toFixed(2)} — ${score.reason}` };
  },
});

export const patientOutreachTool = defineTool({
  name: "patient_outreach_plan",
  description:
    "Work out what to do with each patient balance. Accounts where insurance has not finished are held back rather than billed — that balance is not the patient's yet, and asking for it is the fastest way to earn a complaint that is justified. Large unscreened balances go to financial-assistance screening BEFORE a demand, because a bill nobody can pay collects nothing; small ones are written off because chasing them costs more than they are worth.",
  schema: z.object({}),
  execute: async (_input, ctx) => {
    const now = Date.now();
    const rows = store(ctx).db.prepare("SELECT * FROM patient_accounts").all() as AccountRow[];
    if (rows.length === 0) return { content: "No patient balances recorded. Add them with patient_balance_add." };
    return { content: renderOutreach(planOutreach(rows.map((r) => toAccount(r, now)))) };
  },
});

export const patientLetterTool = defineTool({
  name: "patient_letter_draft",
  description:
    "Draft a patient billing letter in plain language: what the service was, what insurance did, what is left, and the options — including a payment plan and financial assistance, because a patient who does not know they can ask does not ask. No threats and no invented deadlines. It is a draft and stays one until a person sends it.",
  schema: z.object({
    patient_ref: z.string(),
    practice_name: z.string(),
    service_description: z.string().describe("Plain words, not a CPT code"),
    service_date: z.string(),
    insurance_paid: z.number().min(0).default(0),
    adjustment: z.number().min(0).default(0).describe("Contractual write-off, which the patient does not owe"),
    contact: z.string().describe("How to reach the billing office"),
    plan_months: z.number().int().min(2).max(36).default(6),
    output: z.string().default("").describe("Workspace-relative file to write the draft to"),
  }),
  assessRisk: () => ({ level: "confirm" as const, reason: "draft a letter addressed to a patient" }),
  execute: async (input, ctx) => {
    const now = Date.now();
    const row = store(ctx).db.prepare("SELECT * FROM patient_accounts WHERE patient_ref = ?").get(input.patient_ref) as
      | AccountRow
      | undefined;
    if (!row) return { content: `No account ${input.patient_ref}. Add it with patient_balance_add.`, isError: true };

    const acct = toAccount(row, now);
    const score = scorePropensity(acct);
    if (!acct.insuranceAdjudicated) {
      return {
        content: `Insurance has not finished with ${input.patient_ref}, so there is no patient balance to bill yet. Sending this would bill them for money the payer may still owe.`,
        isError: true,
      };
    }

    const letter = draftPatientLetter(acct, score, {
      practiceName: input.practice_name,
      serviceDescription: input.service_description,
      serviceDate: input.service_date,
      insurancePaidCents: Math.round(input.insurance_paid * 100),
      adjustmentCents: Math.round(input.adjustment * 100),
      contact: input.contact,
      planMonths: input.plan_months,
    });

    if (input.output) {
      const config = ctx.services.config as Config;
      const target = confinePath(config.workspaceRoot, input.output);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, letter, "utf8");
      return { content: `Draft written to ${input.output}.\n\n${letter}` };
    }
    return { content: letter };
  },
});

export const forecastHistoryTool = defineTool({
  name: "forecast_history",
  description:
    "Past forecast runs with their seeds and scenarios, so a projection can be held up against what actually arrived. A forecast nobody checks afterwards never gets any better.",
  schema: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
  execute: async (input, ctx) => {
    const rows = store(ctx)
      .db.prepare("SELECT * FROM forecast_runs ORDER BY created_at DESC LIMIT ?")
      .all(input.limit) as Array<{
      id: string;
      scenario: string;
      scenario_json: string;
      horizon_days: number;
      seed: number;
      p10_cents: number;
      p50_cents: number;
      p90_cents: number;
      created_at: number;
    }>;
    if (rows.length === 0) return { content: "No forecasts run yet." };
    return {
      content: rows
        .map((r) => {
          const scen = JSON.parse(r.scenario_json) as Scenario;
          return (
            `${new Date(r.created_at).toISOString().slice(0, 10)}  ${r.id}  ${r.horizon_days}d  seed ${r.seed}\n` +
            `    ${describeScenario(scen)}\n` +
            `    $${(r.p50_cents / 100).toLocaleString("en-US")} (range $${(r.p10_cents / 100).toLocaleString("en-US")} to $${(r.p90_cents / 100).toLocaleString("en-US")})`
          );
        })
        .join("\n"),
    };
  },
});
