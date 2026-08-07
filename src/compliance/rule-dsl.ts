import { finding, type ScrubFinding } from "../tools/healthcare/finding.js";
import type { ClaimInput } from "../tools/healthcare/x12/837.js";

// ── Regulation as code ───────────────────────────────────────────────────────
// Payer policy arrives as prose and gets applied as arithmetic. The gap between
// those two is where compliance programs actually fail: somebody reads an LCD,
// tells the billing team what it says, and eighteen months later nobody can say
// which sentence of which document a scrub rule came from or whether that
// sentence still exists.
//
// So a rule here is data, and it carries its source with it. A rule without the
// paragraph it came from is not auditable — you cannot re-check it when the
// policy is revised, and you cannot defend it when a payer asks why you billed
// the way you did. The evaluator refuses to run rules that lost their source.
//
// The DSL is deliberately small. Every predicate is decidable from a claim plus
// prior claim history, which is exactly the information a scrubber has. A rule
// that needs the medical record cannot be checked before submission at all, and
// is recorded as a documentation obligation rather than pretending otherwise.

export type RuleKind =
  | "requires_diagnosis"
  | "excluded_diagnosis"
  | "requires_modifier"
  | "prohibited_modifier"
  | "frequency_limit"
  | "place_of_service"
  | "not_covered"
  | "requires_documentation";

export type RuleStatus = "draft" | "active" | "rejected" | "retired";

/** Where a rule came from. Every field here exists so the rule can be re-checked later. */
export interface RuleSource {
  /** The document — "LCD L33822", "CMS Pub 100-04 Ch.12 §30.6", a payer bulletin title. */
  document: string;
  /** Section, group or paragraph reference inside that document. */
  citation: string;
  /** The sentence(s) the rule was drawn from, quoted rather than paraphrased. */
  quote: string;
  /** YYYYMMDD the policy took effect, when the document states one. */
  effective: string;
  url: string;
}

export interface PolicyRule {
  id: string;
  kind: RuleKind;
  /** Procedure codes the rule governs. A trailing "*" makes it a prefix. */
  codes: string[];
  /** ICD-10-CM codes for requires_diagnosis / excluded_diagnosis. Category codes cover their children. */
  diagnoses: string[];
  modifiers: string[];
  placesOfService: string[];
  /** frequency_limit: the most that may be reported in `period`. */
  maxUnits: number;
  period: "claim" | "day" | "month" | "year" | "lifetime";
  severity: ScrubFinding["severity"];
  /** What to tell the biller. The rule's own words, not the policy's. */
  message: string;
  /** "" applies to every payer. Otherwise a normalized payer key. */
  payer: string;
  status: RuleStatus;
  source: RuleSource;
}

/** One previously-billed line, for the period rules that cannot be decided from a single claim. */
export interface HistoricalLine {
  code: string;
  serviceDate: string;
  units: number;
}

export interface EvaluateOptions {
  /**
   * Prior lines for this patient. Absent history is not the same as no prior
   * services, and the evaluator says which one it had.
   */
  history?: HistoricalLine[];
  /** Today, as YYYYMMDD. Only used to bound the lookback for annual limits. */
  asOf?: string;
}

export function normalizeCode(code: string): string {
  return code.replace(/[.\s]/g, "").toUpperCase();
}

export function payerKey(payer: string): string {
  return payer.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Does a procedure code fall under this rule?
 *
 * Exact unless the rule writes a trailing "*". Prefix matching without the
 * marker would make a rule about 97110 silently cover 971100 — which is not a
 * real code today, but code sets gain digits and a rule should not widen itself
 * when they do.
 */
export function codeMatches(patterns: string[], code: string): boolean {
  const target = normalizeCode(code);
  return patterns.some((raw) => {
    const pattern = normalizeCode(raw);
    if (pattern.endsWith("*")) return target.startsWith(pattern.slice(0, -1));
    return target === pattern;
  });
}

/**
 * Does a claim diagnosis satisfy a listed policy diagnosis?
 *
 * Coverage lists mix billable codes with categories: an LCD that lists M17 means
 * every osteoarthritis-of-knee code beneath it. So a listed code covers its own
 * descendants — but not the other way round. A policy listing M17.11 does not
 * cover M17.12, and treating the claim code as the prefix would make it.
 */
export function diagnosisMatches(listed: string[], claimDx: string): boolean {
  const target = normalizeCode(claimDx);
  return listed.some((raw) => target.startsWith(normalizeCode(raw)));
}

export function ruleApplies(rule: PolicyRule, claim: ClaimInput): boolean {
  if (rule.status !== "active") return false;
  if (rule.payer && rule.payer !== payerKey(claim.payer_name)) return false;
  return true;
}

/** A rule that lost its provenance cannot be defended, so it is not run. */
export function sourceIsUsable(source: RuleSource): boolean {
  return source.document.trim().length > 0 && source.quote.trim().length > 0;
}

function cite(rule: PolicyRule): string {
  const where = [rule.source.document, rule.source.citation].filter(Boolean).join(" ");
  return where ? ` [${where}]` : "";
}

/**
 * Run the active rule set against a claim.
 *
 * Pure: everything it needs is an argument, including prior history. The tool
 * layer loads that history; this decides what it means.
 */
export function evaluateRules(
  claim: ClaimInput,
  rules: PolicyRule[],
  options: EvaluateOptions = {},
): ScrubFinding[] {
  const out: ScrubFinding[] = [];
  const applicable = rules.filter((r) => ruleApplies(r, claim));

  for (const rule of applicable) {
    if (!sourceIsUsable(rule.source)) {
      out.push(
        finding(
          "warning",
          "policy-rule-unsourced",
          `Rule ${rule.id} was skipped: it has no source document or quoted text. A rule that cannot be traced to the policy it came from cannot be re-checked when that policy changes, and cannot be defended if the payer asks. Re-import it with its source.`,
        ),
      );
      continue;
    }

    switch (rule.kind) {
      case "requires_diagnosis":
      case "excluded_diagnosis":
        out.push(...checkDiagnosisRule(rule, claim));
        break;
      case "requires_modifier":
      case "prohibited_modifier":
        out.push(...checkModifierRule(rule, claim));
        break;
      case "place_of_service":
        out.push(...checkPlaceOfService(rule, claim));
        break;
      case "not_covered":
        out.push(...checkNotCovered(rule, claim));
        break;
      case "frequency_limit":
        out.push(...checkFrequency(rule, claim, options));
        break;
      case "requires_documentation":
        out.push(...checkDocumentation(rule, claim));
        break;
    }
  }

  return out;
}

/**
 * Medical-necessity diagnosis rules are checked against the diagnoses the LINE
 * points at, not every diagnosis on the claim.
 *
 * This is the whole substance of the check. A claim can carry twelve diagnoses;
 * a coverage policy is about what supports *this* service. Checking against the
 * claim-level list would pass a claim whose line points only at an unsupported
 * diagnosis — which is exactly the claim the payer denies.
 */
function checkDiagnosisRule(rule: PolicyRule, claim: ClaimInput): ScrubFinding[] {
  const out: ScrubFinding[] = [];
  claim.service_lines.forEach((line, i) => {
    if (!codeMatches(rule.codes, line.cpt_hcpcs)) return;
    const pointed = (line.dx_pointers ?? [])
      .map((p) => claim.diagnoses[p - 1])
      .filter((dx): dx is string => Boolean(dx));

    if (pointed.length === 0) {
      out.push(
        finding(
          "error",
          `policy-${rule.kind}`,
          `Line ${i + 1} (${line.cpt_hcpcs}) points at no diagnosis, so coverage under ${rule.source.document} cannot be established.${cite(rule)}`,
        ),
      );
      return;
    }

    if (rule.kind === "requires_diagnosis") {
      if (!pointed.some((dx) => diagnosisMatches(rule.diagnoses, dx))) {
        out.push(
          finding(
            rule.severity,
            "policy-requires-diagnosis",
            `Line ${i + 1} (${line.cpt_hcpcs}) points at ${pointed.join(", ")}, none of which is on the covered list. ${rule.message}${cite(rule)}`,
          ),
        );
      }
      return;
    }

    const hit = pointed.filter((dx) => diagnosisMatches(rule.diagnoses, dx));
    if (hit.length > 0) {
      out.push(
        finding(
          rule.severity,
          "policy-excluded-diagnosis",
          `Line ${i + 1} (${line.cpt_hcpcs}) points at ${hit.join(", ")}, which the policy excludes. ${rule.message}${cite(rule)}`,
        ),
      );
    }
  });
  return out;
}

function checkModifierRule(rule: PolicyRule, claim: ClaimInput): ScrubFinding[] {
  const out: ScrubFinding[] = [];
  claim.service_lines.forEach((line, i) => {
    if (!codeMatches(rule.codes, line.cpt_hcpcs)) return;
    const mods = (line.modifiers ?? []).map((m) => m.toUpperCase());
    const wanted = rule.modifiers.map((m) => m.toUpperCase());

    if (rule.kind === "requires_modifier" && !wanted.some((m) => mods.includes(m))) {
      out.push(
        finding(
          rule.severity,
          "policy-requires-modifier",
          `Line ${i + 1} (${line.cpt_hcpcs}) carries ${mods.length ? mods.join(", ") : "no modifiers"} but the policy requires one of ${wanted.join(", ")}. ${rule.message}${cite(rule)}`,
        ),
      );
    }
    if (rule.kind === "prohibited_modifier") {
      const bad = wanted.filter((m) => mods.includes(m));
      if (bad.length > 0) {
        out.push(
          finding(
            rule.severity,
            "policy-prohibited-modifier",
            `Line ${i + 1} (${line.cpt_hcpcs}) carries modifier ${bad.join(", ")}, which the policy does not allow on this code. ${rule.message}${cite(rule)}`,
          ),
        );
      }
    }
  });
  return out;
}

function checkPlaceOfService(rule: PolicyRule, claim: ClaimInput): ScrubFinding[] {
  const out: ScrubFinding[] = [];
  claim.service_lines.forEach((line, i) => {
    if (!codeMatches(rule.codes, line.cpt_hcpcs)) return;
    const pos = (line.place_of_service ?? "").padStart(2, "0");
    if (!rule.placesOfService.map((p) => p.padStart(2, "0")).includes(pos)) {
      out.push(
        finding(
          rule.severity,
          "policy-place-of-service",
          `Line ${i + 1} (${line.cpt_hcpcs}) is billed at place of service ${pos}; the policy allows only ${rule.placesOfService.join(", ")}. ${rule.message}${cite(rule)}`,
        ),
      );
    }
  });
  return out;
}

function checkNotCovered(rule: PolicyRule, claim: ClaimInput): ScrubFinding[] {
  const out: ScrubFinding[] = [];
  claim.service_lines.forEach((line, i) => {
    if (!codeMatches(rule.codes, line.cpt_hcpcs)) return;
    out.push(
      finding(
        rule.severity,
        "policy-not-covered",
        `Line ${i + 1} (${line.cpt_hcpcs}) is not covered under this policy. ${rule.message} If the patient is to be held responsible, an ABN has to be signed before the service — not after the denial.${cite(rule)}`,
      ),
    );
  });
  return out;
}

/**
 * A documentation obligation cannot be checked from a claim, and saying nothing
 * would let it read as satisfied. It is reported as a standing requirement so
 * the reason the claim can lose an audit is at least visible before submission.
 */
function checkDocumentation(rule: PolicyRule, claim: ClaimInput): ScrubFinding[] {
  const out: ScrubFinding[] = [];
  const hits = claim.service_lines
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => codeMatches(rule.codes, line.cpt_hcpcs));
  for (const { line, n } of hits) {
    out.push(
      finding(
        "info",
        "policy-documentation",
        `Line ${n} (${line.cpt_hcpcs}) carries a documentation requirement that no scrub can verify — the record either has it or does not. ${rule.message}${cite(rule)}`,
      ),
    );
  }
  return out;
}

function yearsBack(date: string, years: number): string {
  const y = Number(date.slice(0, 4)) - years;
  return `${String(y).padStart(4, "0")}${date.slice(4)}`;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Last day of a month, leap years included — the 31st minus a month is not the 31st. */
function lastDay(year: number, month: number): number {
  if (month !== 2) return DAYS_IN_MONTH[month - 1];
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
}

function monthsBack(date: string, months: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(4, 6));
  const d = Number(date.slice(6, 8));
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const nd = Math.min(d, lastDay(ny, nm));
  return `${String(ny).padStart(4, "0")}${String(nm).padStart(2, "0")}${String(nd).padStart(2, "0")}`;
}

/**
 * Frequency limits.
 *
 * "claim" and "day" are decidable from the claim in hand. "month", "year" and
 * "lifetime" are not, and the honest failure mode matters here: reporting
 * nothing when there is no history would tell a biller the limit is satisfied
 * when it was never checked. So an unchecked period rule says so.
 */
function checkFrequency(rule: PolicyRule, claim: ClaimInput, options: EvaluateOptions): ScrubFinding[] {
  const out: ScrubFinding[] = [];
  const matching = claim.service_lines
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => codeMatches(rule.codes, line.cpt_hcpcs));
  if (matching.length === 0) return out;

  const label = matching.map((m) => m.line.cpt_hcpcs).join(", ");

  if (rule.period === "claim" || rule.period === "day") {
    const byDate = new Map<string, number>();
    for (const { line } of matching) {
      const key = rule.period === "day" ? line.service_date : "";
      byDate.set(key, (byDate.get(key) ?? 0) + line.units);
    }
    for (const [date, units] of byDate) {
      if (units > rule.maxUnits) {
        out.push(
          finding(
            rule.severity,
            "policy-frequency",
            `${label}: ${units} unit(s) reported${date ? ` on ${date}` : " on this claim"}, above the policy limit of ${rule.maxUnits} per ${rule.period}. ${rule.message}${cite(rule)}`,
          ),
        );
      }
    }
    return out;
  }

  const history = options.history;
  if (!history) {
    out.push(
      finding(
        "info",
        "policy-frequency-unchecked",
        `${label} carries a ${rule.period} limit of ${rule.maxUnits} that was NOT checked — no prior history was available. This claim alone cannot show whether the limit is already used up.${cite(rule)}`,
      ),
    );
    return out;
  }

  const asOf = options.asOf ?? matching[0].line.service_date;
  const floor = rule.period === "year" ? yearsBack(asOf, 1) : rule.period === "month" ? monthsBack(asOf, 1) : "";
  const priorUnits = history
    .filter((h) => codeMatches(rule.codes, h.code) && h.serviceDate > floor && h.serviceDate <= asOf)
    .reduce((sum, h) => sum + h.units, 0);
  const claimUnits = matching.reduce((sum, m) => sum + m.line.units, 0);
  const total = priorUnits + claimUnits;

  if (total > rule.maxUnits) {
    out.push(
      finding(
        rule.severity,
        "policy-frequency",
        `${label}: ${priorUnits} unit(s) already billed in the ${rule.period === "year" ? "past year" : rule.period === "month" ? "past month" : "patient's history"} plus ${claimUnits} on this claim is ${total}, above the policy limit of ${rule.maxUnits}. ${rule.message}${cite(rule)}`,
      ),
    );
  }
  return out;
}

/** A rule the reviewer can read back — the source is the point, so it is printed. */
export function renderRule(rule: PolicyRule): string {
  const parts = [`${rule.id}  [${rule.status}]  ${rule.kind}  severity: ${rule.severity}`];
  parts.push(`  codes: ${rule.codes.join(", ") || "(none)"}${rule.payer ? `   payer: ${rule.payer}` : "   payer: all"}`);
  if (rule.diagnoses.length) parts.push(`  diagnoses: ${rule.diagnoses.join(", ")}`);
  if (rule.modifiers.length) parts.push(`  modifiers: ${rule.modifiers.join(", ")}`);
  if (rule.placesOfService.length) parts.push(`  place of service: ${rule.placesOfService.join(", ")}`);
  if (rule.kind === "frequency_limit") parts.push(`  limit: ${rule.maxUnits} per ${rule.period}`);
  parts.push(`  says: ${rule.message}`);
  parts.push(
    `  source: ${[rule.source.document, rule.source.citation].filter(Boolean).join(" ")}${rule.source.effective ? ` (effective ${rule.source.effective})` : ""}`,
  );
  parts.push(`  quote: "${rule.source.quote.trim()}"`);
  if (rule.source.url) parts.push(`  url: ${rule.source.url}`);
  return parts.join("\n");
}
