import { z } from "zod";
import { defineTool } from "../registry.js";
import { npiLuhnValid } from "./npi.js";
import { ClaimSchema, type ClaimInput } from "./x12/837.js";
import { checkNcci } from "./datasets.js";

export interface ScrubFinding {
  severity: "error" | "warning" | "info";
  rule: string;
  message: string;
}

const ICD10_FORMAT = /^[A-TV-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/;

export function scrubClaim(claim: ClaimInput): ScrubFinding[] {
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
    if (mods.includes("95") && !["02", "10"].includes(line.place_of_service))
      add("warning", "telehealth-pos", `Line ${n}: modifier 95 (telehealth) but POS ${line.place_of_service} is not 02 (facility telehealth) or 10 (patient home)`);
    if (["02", "10"].includes(line.place_of_service) && !mods.includes("95") && !mods.includes("93"))
      add("warning", "telehealth-modifier", `Line ${n}: telehealth POS ${line.place_of_service} without modifier 95/93 — many payers require it`);

    const key = line.service_date;
    procsOnDate.set(key, [...(procsOnDate.get(key) ?? []), line.cpt_hcpcs]);
  });

  // NCCI PTP/MUE checks (from bundled/loaded data when available)
  for (const [date, procs] of procsOnDate) {
    const ncci = checkNcci(procs, claim.service_lines.filter((l) => l.service_date === date));
    findings.push(...ncci);
  }

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
    "Scrub a claim (structured JSON) before submission: code format, dx-pointer linkage, NPI validity, modifier/POS consistency (incl. telehealth), NCCI bundling & MUE unit checks, duplicates. Returns findings with severity.",
  schema: ClaimSchema,
  execute: async (input) => {
    const findings = scrubClaim(input);
    const lines = findings.map((f) => `[${f.severity.toUpperCase()}] ${f.rule}: ${f.message}`);
    const errors = findings.filter((f) => f.severity === "error").length;
    lines.push(`\nResult: ${errors === 0 ? "PASS (no errors)" : `${errors} error(s) must be fixed before submission`}`);
    return { content: lines.join("\n") };
  },
});
