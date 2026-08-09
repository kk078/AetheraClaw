import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configDir } from "../../../config/config.js";
import { defineTool } from "../../registry.js";
import { finding, type ScrubFinding } from "../finding.js";
import type { PriorProcedure } from "./context.js";
import type { MemoryStore } from "../../../memory/store.js";
import { newId } from "../../../shared/ids.js";

// ── Global surgical package ──────────────────────────────────────────────────
// MPFS assigns each procedure a global-period indicator: 000 (same day only),
// 010 (minor, 10 post-op days), 090 (major, 1 pre-op day + 90 post-op days),
// XXX (concept does not apply), ZZZ (add-on), YYY (contractor-priced), MMM
// (maternity). Services inside another procedure's global period are bundled
// unless the right modifier says why they are separately payable.

export function parseYmd(ymd: string): Date | null {
  if (!/^\d{8}$/.test(ymd)) return null;
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}

export function daysBetween(fromYmd: string, toYmd: string): number | null {
  const a = parseYmd(fromYmd);
  const b = parseYmd(toYmd);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

let globalDaysCache: Record<string, number> | null | undefined;

export function lookupGlobalDays(code: string): number | undefined {
  if (globalDaysCache === undefined) {
    const p = path.join(configDir(), "data", "global-periods.json");
    try {
      globalDaysCache = fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, number>) : null;
    } catch {
      globalDaysCache = null;
    }
  }
  return globalDaysCache?.[code.toUpperCase()];
}

/** Reset the cached MPFS global-period table (tests and post-update refresh). */
export function resetGlobalDaysCache(): void {
  globalDaysCache = undefined;
}

export function isEmCode(code: string): boolean {
  const n = Number(code);
  return /^\d{5}$/.test(code) && n >= 99202 && n <= 99499;
}

const POSTOP_EM_MODIFIER = "24";
const DECISION_FOR_SURGERY_MODIFIER = "57";
const SAME_DAY_EM_MODIFIER = "25";
const STAGED_MODIFIERS = ["58", "78", "79"];

export interface GlobalPeriodLine {
  cpt_hcpcs: string;
  modifiers?: string[];
  service_date: string;
}

export function checkGlobalPeriod(
  line: GlobalPeriodLine,
  lineNumber: number,
  priors: PriorProcedure[],
): ScrubFinding[] {
  const out: ScrubFinding[] = [];
  const mods = (line.modifiers ?? []).map((m) => m.toUpperCase());
  const L = `Line ${lineNumber} (${line.cpt_hcpcs})`;
  const isEm = isEmCode(line.cpt_hcpcs);
  let matchedAnyGlobal = false;
  let missingGlobalData = false;

  for (const prior of priors) {
    const globalDays = prior.global_days ?? lookupGlobalDays(prior.code);
    if (globalDays === undefined) {
      missingGlobalData = true;
      continue;
    }
    const offset = daysBetween(prior.date, line.service_date);
    if (offset === null) {
      out.push(finding("error", "global-date-format", `${L}: prior procedure ${prior.code} has an invalid date "${prior.date}" (expected YYYYMMDD)`));
      continue;
    }

    // Major surgery carries a 1-day pre-operative day.
    const isMajor = globalDays >= 90;
    if (isMajor && isEm && (offset === -1 || offset === 0)) {
      if (!mods.includes(DECISION_FOR_SURGERY_MODIFIER)) {
        out.push(
          finding(
            "warning",
            "global-decision-for-surgery",
            `${L}: E/M on ${offset === 0 ? "the day of" : "the day before"} major surgery ${prior.code} (90-day global). If this visit was the decision for surgery, append modifier 57; otherwise it falls in the pre-operative period and is bundled.`,
          ),
        );
      }
      matchedAnyGlobal = true;
      continue;
    }

    const inPostOp = offset >= 0 && offset <= globalDays;
    if (!inPostOp) continue;
    matchedAnyGlobal = true;

    // Same-day minor procedure: an E/M needs 25 to be separately payable.
    if (offset === 0 && !isMajor && isEm) {
      if (!mods.includes(SAME_DAY_EM_MODIFIER)) {
        out.push(
          finding(
            "error",
            "global-same-day-em",
            `${L}: E/M on the same day as minor procedure ${prior.code} (${globalDays}-day global) is bundled unless it was significant and separately identifiable — append modifier 25 or remove the line (CARC 97).`,
          ),
        );
      }
      continue;
    }

    if (isEm) {
      if (!mods.includes(POSTOP_EM_MODIFIER)) {
        out.push(
          finding(
            "error",
            "global-postop-em",
            `${L}: E/M on post-op day ${offset} of ${prior.code}'s ${globalDays}-day global period. Routine post-op care is bundled; if this visit was unrelated to the surgery, append modifier 24 (CARC 97 otherwise).`,
          ),
        );
      }
    } else {
      const hasStaged = STAGED_MODIFIERS.some((m) => mods.includes(m));
      if (!hasStaged) {
        out.push(
          finding(
            "error",
            "global-postop-procedure",
            `${L}: procedure on post-op day ${offset} of ${prior.code}'s ${globalDays}-day global period. Append 58 (staged/planned), 78 (unplanned return to the OR for a related problem), or 79 (unrelated procedure) — otherwise it is bundled.`,
          ),
        );
      }
    }
  }

  // Modifiers that assert a global-period relationship with no global period in sight.
  if (!matchedAnyGlobal) {
    if (mods.includes(POSTOP_EM_MODIFIER)) {
      out.push(
        finding(
          "warning",
          "global-modifier-24-unneeded",
          `${L}: modifier 24 asserts an unrelated E/M during a post-op period, but no prior procedure with an open global period was supplied. Remove it or record the prior surgery.`,
        ),
      );
    }
    for (const m of STAGED_MODIFIERS) {
      if (mods.includes(m)) {
        out.push(
          finding(
            "warning",
            `global-modifier-${m}-unneeded`,
            `${L}: modifier ${m} relates a service to a prior procedure's global period, but none was supplied. Remove it or record the prior surgery.`,
          ),
        );
      }
    }
  }

  if (missingGlobalData && priors.length > 0) {
    out.push(
      finding(
        "info",
        "global-data-missing",
        `${L}: global-period length unknown for one or more prior procedures. Supply global_days, or install global-periods.json ({"CODE": 90}) from the MPFS relative value file in ${path.join(configDir(), "data")}.`,
      ),
    );
  }

  return out;
}

// ── Tools ────────────────────────────────────────────────────────────────────

function store(ctx: { services: Record<string, unknown> }): MemoryStore {
  const s = ctx.services.store as MemoryStore | undefined;
  if (!s) throw new Error("store service unavailable");
  return s;
}

export const globalPeriodRecordTool = defineTool({
  name: "global_period_record",
  description:
    "Record a performed procedure so later claims can be checked against its global surgical period. Use a stable de-identified patient reference (no real identifiers).",
  schema: z.object({
    patient_ref: z.string().describe("De-identified patient reference used to group procedures"),
    code: z.string().describe("Procedure code performed"),
    date: z.string().describe("YYYYMMDD"),
    global_days: z.number().int().optional().describe("0, 10, or 90 — looked up from local MPFS data when omitted"),
    surgeon_npi: z.string().optional(),
  }),
  assessRisk: (input) => ({ level: "confirm", reason: `record procedure ${input.code} for ${input.patient_ref}` }),
  execute: async (input, ctx) => {
    const globalDays = input.global_days ?? lookupGlobalDays(input.code);
    store(ctx)
      .db.prepare(
        "INSERT INTO procedure_history (id, patient_ref, code, service_date, global_days, surgeon_npi, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(newId("proc"), input.patient_ref, input.code.toUpperCase(), input.date, globalDays ?? null, input.surgeon_npi ?? null, Date.now());
    return {
      content:
        `Recorded ${input.code} on ${input.date} for ${input.patient_ref}` +
        (globalDays === undefined
          ? " (global period unknown — supply global_days or install global-periods.json)"
          : ` with a ${globalDays}-day global period.`),
    };
  },
});

export const globalPeriodCheckTool = defineTool({
  name: "global_period_check",
  description:
    "Check whether a service falls inside a prior procedure's global surgical period and which modifier it needs (24 unrelated post-op E/M, 25 same-day E/M with a minor procedure, 57 decision for surgery, 58 staged, 78 unplanned return to the OR, 79 unrelated procedure). Uses recorded procedure history when a patient_ref is given.",
  schema: z.object({
    procedure_code: z.string().describe("Code being billed now"),
    service_date: z.string().describe("YYYYMMDD"),
    modifiers: z.array(z.string()).default([]),
    patient_ref: z.string().optional().describe("Look up recorded prior procedures for this patient"),
    prior_procedures: z
      .array(
        z.object({
          code: z.string(),
          date: z.string(),
          global_days: z.number().int().optional(),
        }),
      )
      .optional()
      .describe("Prior procedures supplied inline (merged with any recorded history)"),
  }),
  execute: async (input, ctx) => {
    const priors: PriorProcedure[] = [...(input.prior_procedures ?? [])];
    if (input.patient_ref) {
      const s = ctx.services.store as MemoryStore | undefined;
      const rows = (s?.db
        .prepare("SELECT code, service_date, global_days FROM procedure_history WHERE patient_ref = ? ORDER BY service_date DESC LIMIT 50")
        .all(input.patient_ref) ?? []) as Array<{ code: string; service_date: string; global_days: number | null }>;
      for (const r of rows) {
        priors.push({ code: r.code, date: r.service_date, global_days: r.global_days ?? undefined });
      }
    }
    if (priors.length === 0) {
      return { content: "No prior procedures supplied or recorded — nothing to check. Record surgeries with global_period_record as they are performed." };
    }
    const findings = checkGlobalPeriod(
      { cpt_hcpcs: input.procedure_code, modifiers: input.modifiers, service_date: input.service_date },
      1,
      priors,
    );
    if (findings.length === 0) {
      return { content: `${input.procedure_code} on ${input.service_date} is outside every supplied global period (${priors.length} prior procedure(s) checked) — no global-period modifier needed.` };
    }
    return { content: findings.map((f) => `[${f.severity.toUpperCase()}] ${f.rule}: ${f.message}`).join("\n") };
  },
});
