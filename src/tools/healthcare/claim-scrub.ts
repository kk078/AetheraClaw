import { z } from "zod";
import { defineTool } from "../registry.js";
import { npiLuhnValid } from "./npi.js";
import { ClaimSchema, type ClaimInput } from "./x12/837.js";
import { buildClaimScrubView } from "../../views/build.js";
import { boxForRule, buildCms1500View } from "../../views/cms1500.js";
import { autohealClaim } from "./autoheal.js";
import { checkNcci, ncciDataNotice } from "./datasets.js";
import type { ScrubFinding } from "./finding.js";
import { checkGlobalPeriod } from "./compliance/global-period.js";
import { checkIncidentTo } from "./compliance/incident-to.js";
import { checkTelehealthLine, loadTelehealthPolicy, type TelehealthPolicy } from "./compliance/telehealth.js";
import type { MemoryStore } from "../../memory/store.js";
import { evaluateRules, type PolicyRule } from "../../compliance/rule-dsl.js";
import { loadActiveRules } from "../../compliance/rule-store.js";

export type { ScrubFinding } from "./finding.js";

const ICD10_FORMAT = /^[A-TV-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/;

export interface ScrubOptions {
  /** Payer telehealth policy; omitted means "assume Medicare rules and say so". */
  telehealthPolicy?: TelehealthPolicy;
  telehealthPolicyWasStored?: boolean;
  /**
   * Accepted policy rules compiled from coverage documents. Only rules a person
   * has moved to 'active' reach here — a draft never affects a claim.
   */
  policyRules?: PolicyRule[];
}

export function scrubClaim(claim: ClaimInput, options: ScrubOptions = {}): ScrubFinding[] {
  const findings: ScrubFinding[] = [];
  const add = (severity: ScrubFinding["severity"], rule: string, message: string) =>
    findings.push({ severity, rule, message });

  // NPI checks
  if (!npiLuhnValid(claim.billing_provider_npi))
    add("error", "npi-billing", `Billing provider NPI ${claim.billing_provider_npi} fails check-digit validation`);
  if (claim.rendering_provider_npi && !npiLuhnValid(claim.rendering_provider_npi))
    add("error", "npi-rendering", `Rendering provider NPI fails check-digit validation`);

  // Diagnosis format
  claim.diagnoses.forEach((dx, i) => {
    if (!ICD10_FORMAT.test(dx.toUpperCase()))
      add("error", "dx-format", `Diagnosis ${i + 1} "${dx}" is not a validly formatted ICD-10-CM code`);
  });

  // Service line checks
  const procsOnDate = new Map<string, string[]>();
  claim.service_lines.forEach((line, i) => {
    const n = i + 1;
    if (!line.dx_pointers || line.dx_pointers.length === 0)
      add("error", "dx-pointer-missing", `Line ${n} (${line.cpt_hcpcs}) has no diagnosis pointers`);
    for (const p of line.dx_pointers ?? []) {
      if (p < 1 || p > claim.diagnoses.length)
        add("error", "dx-pointer-range", `Line ${n} points to diagnosis ${p}, but only ${claim.diagnoses.length} diagnoses are listed`);
    }
    if (!/^\d{8}$/.test(line.service_date))
      add("error", "date-format", `Line ${n} service_date must be YYYYMMDD`);
    else if (line.service_date > new Date().toISOString().slice(0, 10).replace(/-/g, ""))
      add("warning", "date-future", `Line ${n} service date is in the future`);
    if (line.units <= 0) add("error", "units", `Line ${n} has non-positive units`);
    if (line.charge < 0) add("error", "charge", `Line ${n} has a negative charge`);

    // Modifier sanity
    const mods = line.modifiers ?? [];
    if (mods.includes("25") && !/^99\d{3}$/.test(line.cpt_hcpcs))
      add("warning", "modifier-25", `Line ${n}: modifier 25 (significant, separate E/M) on non-E/M code ${line.cpt_hcpcs}`);
    if (mods.includes("59"))
      add("info", "modifier-59", `Line ${n}: modifier 59 asserts a distinct procedural service — ensure documentation supports it (consider X{EPSU} subset modifiers)`);

    // Compliance rule pack: telehealth, global surgical period, incident-to/split-shared.
    const policy = options.telehealthPolicy ?? loadTelehealthPolicy(undefined, claim.payer_name);
    findings.push(...checkTelehealthLine(line, n, policy, claim.compliance, options.telehealthPolicyWasStored ?? false));
    findings.push(...checkGlobalPeriod(line, n, claim.compliance?.prior_procedures ?? []));
    findings.push(...checkIncidentTo(line, n, claim.compliance));

    const key = line.service_date;
    procsOnDate.set(key, [...(procsOnDate.get(key) ?? []), line.cpt_hcpcs]);
  });

  // NCCI PTP/MUE checks run per distinct service date — bundling is a same-day
  // question. The missing-data notice does NOT belong in that loop: it is a fact
  // about the installation, and repeating it per date group made a three-date
  // claim report the same warning three times.
  for (const [date, procs] of procsOnDate) {
    findings.push(...checkNcci(procs, claim.service_lines.filter((l) => l.service_date === date)));
  }
  const ncciNotice = ncciDataNotice();
  if (ncciNotice) findings.push(ncciNotice);

  // Accepted policy rules, compiled from coverage documents.
  if (options.policyRules?.length) findings.push(...evaluateRules(claim, options.policyRules));

  // Duplicate-line check
  const seen = new Set<string>();
  for (const line of claim.service_lines) {
    const key = `${line.cpt_hcpcs}|${line.service_date}|${(line.modifiers ?? []).join(",")}`;
    if (seen.has(key)) add("warning", "duplicate-line", `Duplicate service line ${key} — payer may deny as duplicate (CARC 18)`);
    seen.add(key);
  }

  if (findings.length === 0) add("info", "clean", "No scrub findings — claim passes structural checks");
  return findings;
}

export const claimScrubTool = defineTool({
  name: "claim_scrub",
  description:
    "Scrub a claim (structured JSON) before submission: code format, dx-pointer linkage, NPI validity, modifier/POS consistency, NCCI bundling & MUE unit checks, duplicates, any accepted policy rules compiled from coverage documents, plus the compliance rule pack — telehealth (payer-specific POS/modifier rules), global surgical periods (modifier 24/25/57/58/78/79), and incident-to / split-shared billing. Supply the optional `compliance` block for the compliance rules to fire. Returns findings with severity.",
  schema: ClaimSchema,
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    const payerKey = input.payer_name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const stored = store
      ? (store.db.prepare("SELECT 1 FROM payer_policies WHERE kind = 'telehealth' AND payer_key = ?").get(payerKey) as unknown)
      : undefined;

    // Merge any recorded procedure history into the global-period check.
    const claim = { ...input };
    if (store && claim.compliance?.patient_ref) {
      const rows = store.db
        .prepare("SELECT code, service_date, global_days FROM procedure_history WHERE patient_ref = ? ORDER BY service_date DESC LIMIT 50")
        .all(claim.compliance.patient_ref) as Array<{ code: string; service_date: string; global_days: number | null }>;
      claim.compliance = {
        ...claim.compliance,
        prior_procedures: [
          ...(claim.compliance.prior_procedures ?? []),
          ...rows.map((r) => ({ code: r.code, date: r.service_date, global_days: r.global_days ?? undefined })),
        ],
      };
    }

    const findings = scrubClaim(claim, {
      telehealthPolicy: loadTelehealthPolicy(store, input.payer_name),
      telehealthPolicyWasStored: Boolean(stored),
      policyRules: store ? loadActiveRules(store) : [],
    });
    const lines = findings.map((f) => `[${f.severity.toUpperCase()}] ${f.rule}: ${f.message}`);
    const errors = findings.filter((f) => f.severity === "error").length;
    lines.push(`\nResult: ${errors === 0 ? "PASS (no errors)" : `${errors} error(s) must be fixed before submission`}`);
    return {
      content: lines.join("\n"),
      // The text above is what the model reads. This is the same run rendered as
      // a line-item form for the person reading the transcript.
      view: { kind: "claim_scrub", data: buildClaimScrubView(claim, findings, { autoheal: autohealClaim(claim) }) },
    };
  },
});

// ── The claim as the paper form ──────────────────────────────────────────────

export const claimForm1500Tool = defineTool({
  name: "claim_form_1500",
  description:
    "Render a claim as the CMS-1500 (02/12) form with every scrub finding attributed to the box it belongs to — 24A dates, 24B place of service, 24D procedure and modifiers, 24E diagnosis pointer, 24G units, 33a billing NPI. The same rules as claim_scrub; this is the layout a biller reads. Findings that belong to no box on the form (credentialing, missing reference data) are listed separately rather than pinned to a plausible-looking field.",
  schema: ClaimSchema,
  execute: async (input, ctx) => {
    const store = ctx.services.store as MemoryStore | undefined;
    const findings = scrubClaim(input, {
      telehealthPolicy: loadTelehealthPolicy(store, input.payer_name),
      policyRules: store ? loadActiveRules(store) : [],
    });
    const errors = findings.filter((f) => f.severity === "error").length;
    const warnings = findings.filter((f) => f.severity === "warning").length;
    const view = buildCms1500View(input, findings, {
      verdict: errors > 0 ? "hold" : warnings > 0 ? "review" : "clear",
    });

    // The model reads the prose, as with every other tool. The box attribution
    // is for the person, and repeating the whole grid here would pay for it
    // twice with no benefit.
    const text = [
      `CMS-1500 for claim ${view.claimId} (${view.payer}) — ${view.lines.length} service line(s), $${view.totalCharge.toFixed(2)}.`,
      ...findings.map((f) => {
        const box = boxForRule(f.rule);
        return `[${f.severity.toUpperCase()}] ${box ? `box ${box}` : "no box"} — ${f.rule}: ${f.message}`;
      }),
      "",
      errors === 0 ? "No errors. The form is ready as it stands." : `${errors} error(s) must be fixed before submission.`,
    ];
    return { content: text.join("\n"), view: { kind: "cms1500", data: view } };
  },
});
