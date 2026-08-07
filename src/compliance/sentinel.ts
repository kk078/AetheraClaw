import { finding, type ScrubFinding } from "../tools/healthcare/finding.js";
import { scrubClaim } from "../tools/healthcare/claim-scrub.js";
import type { ClaimInput } from "../tools/healthcare/x12/837.js";
import { evaluateRules, type PolicyRule } from "./rule-dsl.js";

// ── Compliance sentinel ──────────────────────────────────────────────────────
// Sample your own claims, audit them the way a contractor would, and find out
// what your error rate is before somebody else measures it for you.
//
// The statistics are the substance here, not the sampling. An internal audit
// that reports "2 of 30 claims had findings, so our error rate is 6.7%" is worse
// than no audit: 2/30 is consistent with a true rate anywhere from about 1% to
// about 22%, and the practice has just written down a number it will be held to.
// So every rate is reported with the interval around it, and the module refuses
// to extrapolate a dollar figure from a sample too small to support one.
//
// The 50% line is not arbitrary. A Medicare contractor may not extrapolate an
// overpayment unless it finds a sustained or high level of payment error, and
// "high" is defined as 50% or greater. That makes it the one threshold a
// practice can measure itself against and act on — which is the entire reason
// to run a self-audit rather than wait.

/** Lower bound of a one-sided 90% confidence interval — the CMS convention for extrapolated overpayments. */
export const CMS_ONE_SIDED_90_Z = 1.2816;
/** Two-sided 95%, for reporting an ordinary interval around a rate. */
export const TWO_SIDED_95_Z = 1.96;

/** "High level of payment error" for extrapolation purposes. */
export const HIGH_ERROR_RATE_THRESHOLD = 0.5;

/**
 * Below this, a sample supports a direction and nothing more. Extrapolation is
 * refused rather than produced with a caveat nobody reads.
 */
export const MIN_SAMPLE_FOR_EXTRAPOLATION = 30;

/** ACA §6402(a) report-and-return, once an overpayment is identified. */
export const REPORT_AND_RETURN_DAYS = 60;
/**
 * The deadline is suspended while a timely, good-faith investigation into
 * RELATED overpayments runs — until the investigation concludes or 180 days
 * from the initial identification, whichever comes first.
 */
export const RELATED_INVESTIGATION_MAX_DAYS = 180;
/** Overpayments identified within six years of receipt must be reported and returned. */
export const LOOKBACK_YEARS = 6;

export interface Interval {
  point: number;
  lower: number;
  upper: number;
}

/**
 * Wilson score interval.
 *
 * Not the textbook normal approximation: at the rates a clean practice actually
 * sees — nought or one finding in thirty — the normal approximation produces
 * intervals that include impossible values or collapse to zero width, which is
 * exactly where an audit result gets over-read.
 */
export function wilsonInterval(successes: number, n: number, z: number = TWO_SIDED_95_Z): Interval {
  if (n <= 0) return { point: 0, lower: 0, upper: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half = (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { point: p, lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}

/** Deterministic PRNG. A sample nobody can redraw is not a defensible audit. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Draw a simple random sample without replacement.
 *
 * Seeded, so the same population and seed always yield the same claims — a
 * contractor asks how the sample was drawn, and "randomly" is not an answer.
 * The population is sorted by id first so an upstream ordering change cannot
 * quietly change which claims a given seed selects.
 */
export function drawSample<T extends { id: string }>(population: T[], size: number, seed: number): T[] {
  const pool = [...population].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rand = mulberry32(seed);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(size, pool.length));
}

// ── OIG priority areas ───────────────────────────────────────────────────────

export interface SampledClaim {
  id: string;
  claim: ClaimInput;
  /** Paid amount in cents when known, for the exposure estimate. */
  paidCents: number;
}

export interface AreaContext {
  /** Global period in days for a procedure code, when the MPFS dataset is loaded. */
  globalDays?: (code: string) => number | undefined;
  /** Every claim in the sample, for the checks that only exist across claims. */
  sample: SampledClaim[];
}

export interface PriorityArea {
  key: string;
  label: string;
  /** Why this is where audits land. Printed with the findings — a finding without it is just a rule. */
  why: string;
  check: (claim: ClaimInput, ctx: AreaContext) => ScrubFinding[];
}

const EM_CODE = /^992\d{2}$/;
const SURGICAL_RANGE = /^([1-6]\d{4})$/;
const UNBUNDLING_MODIFIERS = ["59", "XE", "XP", "XS", "XU"];
const HIGH_LEVEL_EM = ["99205", "99215", "99245", "99285"];
const NEW_PATIENT_EM = ["99202", "99203", "99204", "99205"];
/** A patient is "new" only if not seen by the group in three years. */
export const NEW_PATIENT_YEARS = 3;

function isMinorProcedure(code: string, ctx: AreaContext): "yes" | "no" | "unknown" {
  if (!SURGICAL_RANGE.test(code)) return "no";
  const days = ctx.globalDays?.(code);
  if (days === undefined) return "unknown";
  return days === 0 || days === 10 ? "yes" : "no";
}

export const PRIORITY_AREAS: PriorityArea[] = [
  {
    key: "modifier_25",
    label: "E/M on the same day as a minor procedure",
    why: "The OIG has an open project examining E/M services paid on the same day as a minor surgical procedure. Both directions are exposure: with modifier 25 the E/M is only payable if the record shows a significant, separately identifiable service, and without it the E/M is bundled into the procedure and should not have been paid at all.",
    check: (claim, ctx) => {
      const out: ScrubFinding[] = [];
      const byDate = new Map<string, typeof claim.service_lines>();
      for (const line of claim.service_lines) {
        byDate.set(line.service_date, [...(byDate.get(line.service_date) ?? []), line]);
      }
      for (const [date, lines] of byDate) {
        const em = lines.filter((l) => EM_CODE.test(l.cpt_hcpcs));
        if (em.length === 0) continue;
        const minor = lines.filter((l) => isMinorProcedure(l.cpt_hcpcs, ctx) === "yes");
        const unknown = lines.filter((l) => isMinorProcedure(l.cpt_hcpcs, ctx) === "unknown");

        for (const e of em) {
          const mods = e.modifiers ?? [];
          if (minor.length > 0 && mods.includes("25")) {
            out.push(
              finding(
                "warning",
                "sentinel-modifier-25",
                `${e.cpt_hcpcs} with modifier 25 on ${date}, same day as ${minor.map((l) => l.cpt_hcpcs).join(", ")}. Payable only if the record documents a significant, separately identifiable E/M beyond the usual pre- and post-operative work. Pull the note.`,
              ),
            );
          } else if (minor.length > 0) {
            out.push(
              finding(
                "error",
                "sentinel-modifier-25-missing",
                `${e.cpt_hcpcs} billed on ${date} alongside ${minor.map((l) => l.cpt_hcpcs).join(", ")} with no modifier 25. The E/M is bundled into the procedure. If this was paid, it is an overpayment.`,
              ),
            );
          }
          if (unknown.length > 0) {
            out.push(
              finding(
                "info",
                "sentinel-modifier-25-unknown",
                `${e.cpt_hcpcs} on ${date} sits alongside ${unknown.map((l) => l.cpt_hcpcs).join(", ")}, whose global period is unknown — no MPFS global-period data is loaded, so this claim was NOT checked for the same-day E/M rule. Load global-periods.json to check it.`,
              ),
            );
          }
        }
      }
      return out;
    },
  },
  {
    key: "unbundling_modifier",
    label: "Distinct-service modifiers",
    why: "Modifier 59 and the X{EPSU} subset override a bundling edit by asserting a separate site, session or encounter. The assertion is the provider's, and it is the first thing a reviewer tests against the record.",
    check: (claim) => {
      const out: ScrubFinding[] = [];
      claim.service_lines.forEach((line, i) => {
        const used = (line.modifiers ?? []).filter((m) => UNBUNDLING_MODIFIERS.includes(m.toUpperCase()));
        if (used.length === 0) return;
        out.push(
          finding(
            "warning",
            "sentinel-unbundling",
            `Line ${i + 1} (${line.cpt_hcpcs}) uses modifier ${used.join(", ")} to report a distinct service. The record has to name the separate site, session or encounter. ${used.includes("59") ? "Where an X{EPSU} modifier fits, it says which one and reviews better than a bare 59." : ""}`,
          ),
        );
      });
      return out;
    },
  },
  {
    key: "high_level_em",
    label: "Highest-level E/M",
    why: "Level 4 and 5 concentration is the single most common trigger for a payer to open a review, because it is visible in claims data without reading a chart.",
    check: (claim) => {
      const hits = claim.service_lines.filter((l) => HIGH_LEVEL_EM.includes(l.cpt_hcpcs));
      if (hits.length === 0) return [];
      return [
        finding(
          "info",
          "sentinel-high-level-em",
          `${hits.map((h) => h.cpt_hcpcs).join(", ")} — highest-level E/M. Check the note supports the MDM claimed: number and complexity of problems, data reviewed, and risk.`,
        ),
      ];
    },
  },
  {
    key: "repeat_new_patient",
    label: "New-patient E/M for a returning patient",
    why: "A new-patient visit pays substantially more than an established one, and the definition is objective: nobody in the group may have billed a face-to-face service in three years. It is a cross-claim error, so a per-claim scrub can never see it.",
    check: (claim, ctx) => {
      const newLines = claim.service_lines.filter((l) => NEW_PATIENT_EM.includes(l.cpt_hcpcs));
      const patient = claim.compliance?.patient_ref;
      if (newLines.length === 0 || !patient) return [];

      const priorVisits = ctx.sample
        .filter((s) => s.claim.compliance?.patient_ref === patient && s.claim.claim_id !== claim.claim_id)
        .flatMap((s) => s.claim.service_lines.filter((l) => EM_CODE.test(l.cpt_hcpcs)).map((l) => l.service_date));

      const out: ScrubFinding[] = [];
      for (const line of newLines) {
        const cutoff = `${Number(line.service_date.slice(0, 4)) - NEW_PATIENT_YEARS}${line.service_date.slice(4)}`;
        const recent = priorVisits.filter((d) => d < line.service_date && d > cutoff);
        if (recent.length > 0) {
          out.push(
            finding(
              "error",
              "sentinel-repeat-new-patient",
              `${line.cpt_hcpcs} billed as a new patient on ${line.service_date}, but this patient reference has E/M services on ${recent.sort().join(", ")} — inside the three-year window. If those were the same group and specialty, this should have been an established-patient code and the difference is an overpayment.`,
            ),
          );
        }
      }
      return out;
    },
  },
];

// ── Running an audit ─────────────────────────────────────────────────────────

export interface ClaimAudit {
  id: string;
  claimRef: string;
  payer: string;
  paidCents: number;
  findings: ScrubFinding[];
  /** A claim is "in error" for rate purposes only on an error-severity finding. */
  inError: boolean;
}

export interface AreaTally {
  key: string;
  label: string;
  why: string;
  claims: number;
  findings: number;
}

export interface SentinelReport {
  seed: number;
  populationSize: number;
  sampleSize: number;
  audits: ClaimAudit[];
  claimsInError: number;
  /** Two-sided 95% interval around the error rate. */
  errorRate: Interval;
  /** Lower bound of the one-sided 90% interval — the conservative figure CMS itself uses. */
  conservativeLowerBound: number;
  /** True when even the conservative bound reaches the 50% extrapolation threshold. */
  highErrorRate: boolean;
  /** True when the point estimate reaches it but the lower bound does not. */
  highErrorRatePossible: boolean;
  areas: AreaTally[];
  sampleErrorCents: number;
  extrapolation: Extrapolation;
}

export type Extrapolation =
  | { available: false; reason: string }
  | { available: true; perClaimLowerCents: number; populationLowerCents: number; note: string };

export interface AuditOptions {
  rules?: PolicyRule[];
  globalDays?: (code: string) => number | undefined;
  areas?: PriorityArea[];
}

/**
 * Audit a drawn sample.
 *
 * Every claim goes through the ordinary scrub — the rules already exist and
 * re-implementing them for the sentinel would let the two drift — plus the
 * priority areas, which are the checks that need the whole sample rather than
 * one claim.
 */
export function auditSample(
  sample: SampledClaim[],
  populationSize: number,
  seed: number,
  options: AuditOptions = {},
): SentinelReport {
  const areas = options.areas ?? PRIORITY_AREAS;
  const ctx: AreaContext = { globalDays: options.globalDays, sample };
  const audits: ClaimAudit[] = [];
  const areaTallies = new Map<string, AreaTally>(
    areas.map((a) => [a.key, { key: a.key, label: a.label, why: a.why, claims: 0, findings: 0 }]),
  );

  for (const entry of sample) {
    const scrub = scrubClaim(entry.claim).filter((f) => f.rule !== "clean");
    const policy = options.rules?.length ? evaluateRules(entry.claim, options.rules) : [];
    const areaFindings: ScrubFinding[] = [];
    for (const area of areas) {
      const hits = area.check(entry.claim, ctx);
      if (hits.length === 0) continue;
      const tally = areaTallies.get(area.key)!;
      tally.claims++;
      tally.findings += hits.length;
      areaFindings.push(...hits);
    }
    const findings = [...scrub, ...policy, ...areaFindings];
    audits.push({
      id: entry.id,
      claimRef: entry.claim.claim_id,
      payer: entry.claim.payer_name,
      paidCents: entry.paidCents,
      findings,
      inError: findings.some((f) => f.severity === "error"),
    });
  }

  const claimsInError = audits.filter((a) => a.inError).length;
  const n = audits.length;
  const errorRate = wilsonInterval(claimsInError, n, TWO_SIDED_95_Z);
  const oneSided = wilsonInterval(claimsInError, n, CMS_ONE_SIDED_90_Z);
  const sampleErrorCents = audits.filter((a) => a.inError).reduce((sum, a) => sum + a.paidCents, 0);

  return {
    seed,
    populationSize,
    sampleSize: n,
    audits,
    claimsInError,
    errorRate,
    conservativeLowerBound: oneSided.lower,
    highErrorRate: oneSided.lower >= HIGH_ERROR_RATE_THRESHOLD,
    highErrorRatePossible: errorRate.point >= HIGH_ERROR_RATE_THRESHOLD && oneSided.lower < HIGH_ERROR_RATE_THRESHOLD,
    areas: [...areaTallies.values()].filter((a) => a.findings > 0).sort((a, b) => b.claims - a.claims),
    sampleErrorCents,
    extrapolation: extrapolate(sampleErrorCents, n, claimsInError, populationSize),
  };
}

/**
 * Estimate exposure across the population, conservatively or not at all.
 *
 * The estimate uses the lower bound of a one-sided 90% interval on the error
 * rate, which is the direction CMS itself extrapolates in — deliberately
 * favouring the provider, because a point estimate from a sample of thirty is
 * not a number anybody should repay against.
 */
export function extrapolate(
  sampleErrorCents: number,
  sampleSize: number,
  claimsInError: number,
  populationSize: number,
): Extrapolation {
  if (sampleSize < MIN_SAMPLE_FOR_EXTRAPOLATION) {
    return {
      available: false,
      reason: `A sample of ${sampleSize} is too small to estimate exposure from. Below ${MIN_SAMPLE_FOR_EXTRAPOLATION} the interval around any figure is wider than the figure, and a number written down is a number you will be held to. Sample more claims, or treat the findings as findings and not as an amount.`,
    };
  }
  if (claimsInError === 0) {
    return {
      available: false,
      reason: "No claim in the sample had an error, so there is nothing to project. That is not the same as an error rate of zero — see the interval above.",
    };
  }
  const avgErrorPerBadClaim = sampleErrorCents / claimsInError;
  const rateLower = wilsonInterval(claimsInError, sampleSize, CMS_ONE_SIDED_90_Z).lower;
  const perClaimLowerCents = avgErrorPerBadClaim * rateLower;
  return {
    available: true,
    perClaimLowerCents,
    populationLowerCents: perClaimLowerCents * populationSize,
    note: "Lower bound of a one-sided 90% interval, the basis CMS uses for extrapolated overpayment demands. It is an internal estimate for deciding whether to investigate, not a repayment figure — the Program Integrity Manual requires a qualified statistician for a sampling design that will be relied on.",
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function renderReport(report: SentinelReport): string {
  const lines: string[] = [
    `Self-audit: ${report.sampleSize} claim(s) sampled from ${report.populationSize}, seed ${report.seed}.`,
    `Re-run with the same seed to draw the same claims — a sample nobody can redraw is not a defensible audit.`,
    "",
    `Claims with at least one error-severity finding: ${report.claimsInError} of ${report.sampleSize} (${pct(report.errorRate.point)}).`,
    `95% interval: ${pct(report.errorRate.lower)} to ${pct(report.errorRate.upper)}.`,
  ];

  if (report.sampleSize > 0 && report.sampleSize < MIN_SAMPLE_FOR_EXTRAPOLATION) {
    lines.push(
      `That interval is wide because the sample is small. ${report.claimsInError}/${report.sampleSize} tells you a direction, not a rate.`,
    );
  }

  lines.push("");
  if (report.highErrorRate) {
    lines.push(
      `Even the conservative bound (${pct(report.conservativeLowerBound)}) is at or above the 50% "high level of payment error" threshold. That is the finding that lets a contractor extrapolate an overpayment across the whole population rather than demanding back only the claims it reviewed. Treat this as urgent.`,
    );
  } else if (report.highErrorRatePossible) {
    lines.push(
      `The measured rate is at or above 50%, though the conservative bound (${pct(report.conservativeLowerBound)}) is not. 50% is the "high level of payment error" line that permits a contractor to extrapolate. A larger sample would settle which side of it you are on, and that is worth knowing before someone else measures it.`,
    );
  } else {
    lines.push(`Conservative bound ${pct(report.conservativeLowerBound)}, below the 50% extrapolation threshold.`);
  }

  if (report.areas.length > 0) {
    lines.push("", "Where the findings are:");
    for (const area of report.areas) {
      lines.push(
        "",
        `  ${area.label} — ${area.claims} claim(s), ${area.findings} finding(s)`,
        `    ${area.why}`,
      );
    }
  }

  const worst = report.audits.filter((a) => a.inError).slice(0, 10);
  if (worst.length > 0) {
    lines.push("", `Claims with errors — showing ${worst.length} of ${report.claimsInError}:`);
    for (const audit of worst) {
      lines.push(`  ${audit.claimRef} (${audit.payer}):`);
      for (const f of audit.findings.filter((x) => x.severity === "error")) {
        lines.push(`    ${f.rule}: ${f.message}`);
      }
    }
  }

  lines.push("", "Exposure:");
  if (report.extrapolation.available) {
    lines.push(
      `  Paid on the sampled claims that had errors: ${money(report.sampleErrorCents)}.`,
      `  Conservative projection across ${report.populationSize} claims: ${money(report.extrapolation.populationLowerCents)}.`,
      `  ${report.extrapolation.note}`,
    );
  } else {
    lines.push(`  ${report.extrapolation.reason}`);
  }

  if (report.claimsInError > 0) {
    lines.push(
      "",
      "If any of these turn out to be overpayments, the clock has started.",
      `  Report and return within ${REPORT_AND_RETURN_DAYS} days of IDENTIFYING an overpayment. Identification is knowing you have it — since the 2024 revision, working out the exact amount is no longer part of identifying it, so the clock does not wait for the arithmetic.`,
      `  Investigating whether related overpayments exist from the same cause suspends that deadline, but only until the investigation concludes or ${RELATED_INVESTIGATION_MAX_DAYS} days from the first identification, whichever comes first.`,
      `  The obligation reaches back ${LOOKBACK_YEARS} years from the date each overpayment was received.`,
      "  Record confirmed overpayments with credit_balance_add — this report identifies candidates and deliberately does not start anyone's clock on its own.",
    );
  }

  return lines.join("\n");
}
