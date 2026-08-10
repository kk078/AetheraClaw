import type { ClaimInput } from "../tools/healthcare/x12/837.js";
import type { ScrubFinding } from "../tools/healthcare/finding.js";
import { scrubClaim } from "../tools/healthcare/claim-scrub.js";

// ── Correctness eval ─────────────────────────────────────────────────────────
//
// The routing eval in run.ts asks whether the model REACHED FOR the right tool.
// This asks a different and more consequential question: when the tool runs,
// does it get the right answer. Those come apart. A model can route perfectly to
// a scrubber that misses a bundling violation, and the claim still denies.
//
// THREE PROPERTIES, EACH DELIBERATE:
//
//   NO MODEL. Every case runs `scrubClaim` directly. That makes this offline,
//   free, deterministic, and runnable in CI — which is the only way a baseline
//   is worth committing. A model-in-the-loop eval that costs money and varies
//   between runs gets disabled the first week it flakes.
//
//   MISSES AND FALSE ALARMS ARE SCORED SEPARATELY. They are not
//   interchangeable. A MISS means a claim goes out with a defect the practice
//   was told it did not have. A FALSE ALARM means a coder spends time on a
//   clean claim. Both are bad; only the first one costs a denial, and averaging
//   them into a single accuracy number hides which way the tool is failing.
//
//   FORBIDDEN RULES ARE PART OF A CASE. Several of these claims are clean in a
//   specific way, and the assertion worth making is that the scrubber does NOT
//   raise a particular rule. Without that, a scrubber that flags everything
//   scores perfectly on recall.

export interface CorrectnessCase {
  id: string;
  /** What this case is actually testing, in a sentence a reviewer can check. */
  intent: string;
  claim: ClaimInput;
  /** Rules that MUST appear. A missing one is a miss. */
  expect: string[];
  /** Rules that must NOT appear. A present one is a false alarm. */
  forbid: string[];
}

export interface CaseScore {
  id: string;
  intent: string;
  passed: boolean;
  /** Expected rules the scrubber did not raise. The expensive failure. */
  missed: string[];
  /** Forbidden rules the scrubber raised anyway. */
  falseAlarms: string[];
  actual: string[];
}

export interface CorrectnessReport {
  cases: CaseScore[];
  passed: number;
  total: number;
  missed: number;
  falseAlarms: number;
}

const BILLING_NPI = "1999999984"; // passes the Luhn check
const BAD_NPI = "1234567890";

function claim(over: Partial<ClaimInput> = {}): ClaimInput {
  return {
    claim_id: "EV-0001",
    payer_name: "MOCK PAYER",
    payer_id: "87726",
    billing_provider_npi: BILLING_NPI,
    billing_provider_name: "EVAL CLINIC",
    subscriber_id: "SYN000111",
    patient_last: "TESTPATIENT",
    patient_first: "ALEX",
    patient_dob: "19800215",
    patient_sex: "U",
    diagnoses: ["E11.9"],
    service_lines: [
      {
        cpt_hcpcs: "99214",
        modifiers: [],
        charge: 225,
        units: 1,
        dx_pointers: [1],
        service_date: "20260115",
        place_of_service: "11",
      },
    ],
    ...over,
  };
}

export const CORRECTNESS_CASES: CorrectnessCase[] = [
  {
    id: "clean",
    intent: "An ordinary office visit raises no errors and is not invented into one",
    claim: claim(),
    expect: [],
    forbid: ["npi-billing", "dx-format", "dx-pointer-missing", "units", "charge", "duplicate-line"],
  },
  {
    id: "npi-check-digit",
    intent: "A billing NPI that fails its Luhn check is caught before the payer rejects it",
    claim: claim({ billing_provider_npi: BAD_NPI }),
    expect: ["npi-billing"],
    forbid: [],
  },
  {
    id: "dx-format",
    intent: "A malformed ICD-10 code is an error, not a warning — it cannot adjudicate",
    claim: claim({ diagnoses: ["E119Z9"] }),
    expect: ["dx-format"],
    forbid: [],
  },
  {
    id: "dx-pointer-out-of-range",
    intent: "A pointer past the end of the diagnosis list is caught rather than truncated",
    claim: claim({
      diagnoses: ["E11.9"],
      service_lines: [
        { cpt_hcpcs: "99214", modifiers: [], charge: 225, units: 1, dx_pointers: [3], service_date: "20260115", place_of_service: "11" },
      ],
    }),
    expect: ["dx-pointer-range"],
    forbid: [],
  },
  {
    id: "non-positive-units",
    intent: "Zero units is an error — a line billed for nothing is a rejection, not a rounding detail",
    claim: claim({
      service_lines: [
        { cpt_hcpcs: "99214", modifiers: [], charge: 225, units: 0, dx_pointers: [1], service_date: "20260115", place_of_service: "11" },
      ],
    }),
    expect: ["units"],
    forbid: [],
  },
  {
    id: "negative-charge",
    intent: "A negative charge is caught rather than netted against another line",
    claim: claim({
      service_lines: [
        { cpt_hcpcs: "99214", modifiers: [], charge: -50, units: 1, dx_pointers: [1], service_date: "20260115", place_of_service: "11" },
      ],
    }),
    expect: ["charge"],
    forbid: [],
  },
  {
    id: "malformed-date",
    intent: "A service date that is not YYYYMMDD is an error, and does not also raise the future-date warning",
    claim: claim({
      service_lines: [
        { cpt_hcpcs: "99214", modifiers: [], charge: 225, units: 1, dx_pointers: [1], service_date: "01/15/2026", place_of_service: "11" },
      ],
    }),
    expect: ["date-format"],
    // A string that is not a date cannot be compared to today. Raising both
    // would tell a biller to check a calendar about a field that is not a date.
    forbid: ["date-future"],
  },
  {
    id: "duplicate-line",
    intent: "The same code, date and modifiers twice is flagged as the duplicate a payer will deny (CARC 18)",
    claim: claim({
      service_lines: [
        { cpt_hcpcs: "99214", modifiers: [], charge: 225, units: 1, dx_pointers: [1], service_date: "20260115", place_of_service: "11" },
        { cpt_hcpcs: "99214", modifiers: [], charge: 225, units: 1, dx_pointers: [1], service_date: "20260115", place_of_service: "11" },
      ],
    }),
    expect: ["duplicate-line"],
    forbid: [],
  },
  {
    id: "not-a-duplicate-different-modifier",
    intent: "The same code twice with different modifiers is NOT a duplicate — this is how a legitimate repeat is billed",
    claim: claim({
      service_lines: [
        { cpt_hcpcs: "93000", modifiers: [], charge: 30, units: 1, dx_pointers: [1], service_date: "20260115", place_of_service: "11" },
        { cpt_hcpcs: "93000", modifiers: ["76"], charge: 30, units: 1, dx_pointers: [1], service_date: "20260115", place_of_service: "11" },
      ],
    }),
    expect: [],
    forbid: ["duplicate-line"],
  },
  {
    id: "not-a-duplicate-different-date",
    intent: "The same code on two different dates is two encounters, not a duplicate",
    claim: claim({
      service_lines: [
        { cpt_hcpcs: "99213", modifiers: [], charge: 150, units: 1, dx_pointers: [1], service_date: "20260115", place_of_service: "11" },
        { cpt_hcpcs: "99213", modifiers: [], charge: 150, units: 1, dx_pointers: [1], service_date: "20260220", place_of_service: "11" },
      ],
    }),
    expect: [],
    forbid: ["duplicate-line"],
  },
  {
    id: "modifier-25-on-non-em",
    intent: "Modifier 25 on a non-E/M code is a warning — it is a real billing pattern, but usually wrong",
    claim: claim({
      service_lines: [
        { cpt_hcpcs: "20610", modifiers: ["25"], charge: 90, units: 1, dx_pointers: [1], service_date: "20260115", place_of_service: "11" },
      ],
    }),
    expect: ["modifier-25"],
    forbid: [],
  },
  {
    id: "modifier-25-on-em-is-fine",
    intent: "Modifier 25 on an E/M code is the correct use and must not be flagged",
    claim: claim({
      service_lines: [
        { cpt_hcpcs: "99214", modifiers: ["25"], charge: 225, units: 1, dx_pointers: [1], service_date: "20260115", place_of_service: "11" },
      ],
    }),
    expect: [],
    forbid: ["modifier-25"],
  },
  {
    id: "modifier-59-is-informational",
    intent: "Modifier 59 is surfaced but is not an error — it is legitimate and heavily audited, which is exactly why it is said out loud",
    claim: claim({
      service_lines: [
        { cpt_hcpcs: "20610", modifiers: ["59"], charge: 90, units: 1, dx_pointers: [1], service_date: "20260115", place_of_service: "11" },
      ],
    }),
    expect: ["modifier-59"],
    forbid: [],
  },
  {
    id: "multiple-defects-all-reported",
    intent: "A claim with several defects reports all of them — a scrubber that stops at the first sends the biller round twice",
    claim: claim({
      billing_provider_npi: BAD_NPI,
      diagnoses: ["ZZZZZ"],
      service_lines: [
        { cpt_hcpcs: "99214", modifiers: [], charge: -1, units: 0, dx_pointers: [], service_date: "nope", place_of_service: "11" },
      ],
    }),
    expect: ["npi-billing", "dx-format", "charge", "units", "dx-pointer-missing", "date-format"],
    forbid: ["clean"],
  },
];

/** Score one case. Pure — takes the findings rather than running the scrubber. */
export function scoreCorrectness(c: CorrectnessCase, findings: ScrubFinding[]): CaseScore {
  const actual = [...new Set(findings.map((f) => f.rule))].sort();
  const missed = c.expect.filter((r) => !actual.includes(r));
  const falseAlarms = c.forbid.filter((r) => actual.includes(r));
  return {
    id: c.id,
    intent: c.intent,
    passed: missed.length === 0 && falseAlarms.length === 0,
    missed,
    falseAlarms,
    actual,
  };
}

/** Run every case. No I/O, no network, no model. */
export function runCorrectness(cases: CorrectnessCase[] = CORRECTNESS_CASES): CorrectnessReport {
  const scored = cases.map((c) => scoreCorrectness(c, scrubClaim(c.claim)));
  return {
    cases: scored,
    passed: scored.filter((s) => s.passed).length,
    total: scored.length,
    missed: scored.reduce((n, s) => n + s.missed.length, 0),
    falseAlarms: scored.reduce((n, s) => n + s.falseAlarms.length, 0),
  };
}

export function renderCorrectness(report: CorrectnessReport): string {
  const lines = [`Correctness: ${report.passed}/${report.total} cases`];
  for (const c of report.cases) {
    lines.push(`${c.passed ? "  ok  " : "  FAIL"} ${c.id} — ${c.intent}`);
    // Misses first and named as such: a missed rule means a claim goes out with
    // a defect the practice was told it did not have.
    if (c.missed.length) lines.push(`        MISSED: ${c.missed.join(", ")}`);
    if (c.falseAlarms.length) lines.push(`        false alarm: ${c.falseAlarms.join(", ")}`);
    if (!c.passed) lines.push(`        raised: ${c.actual.join(", ") || "(nothing)"}`);
  }
  if (report.missed > 0) {
    lines.push(
      `\n${report.missed} missed rule(s). A miss is not the same size of problem as a false alarm: it means a ` +
        "claim goes out with a defect the practice was told it did not have.",
    );
  }
  if (report.falseAlarms > 0) lines.push(`${report.falseAlarms} false alarm(s) — a coder's time on a clean claim.`);
  return lines.join("\n");
}
