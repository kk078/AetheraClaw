import { classifyPos } from "../tools/healthcare/pos.js";
import type { ClaimInput } from "../tools/healthcare/x12/837.js";
import type { ScrubFinding } from "../tools/healthcare/finding.js";
import type { AutohealResult } from "../tools/healthcare/autoheal.js";
import type { EmRisk } from "../tools/healthcare/presubmit.js";
import type { VarianceFinding } from "../tools/healthcare/intelligence/variance.js";
import type { KpiSet } from "../reports/kpi.js";
import type {
  ClaimFindingView,
  ClaimLineView,
  ClaimScrubView,
  EmMeterView,
  KpiTilesView,
  LineSeverity,
  MoneyWaterfallView,
  WaterfallStep,
} from "./types.js";

// Pure builders. Every domain judgement — which line a finding belongs to, which
// severity wins, whether a repair may be offered as a button — is decided here
// where it can be tested, not in the browser where it cannot.

const SEVERITY_RANK: Record<LineSeverity, number> = { error: 3, warning: 2, info: 1, clean: 0 };

function worst(a: LineSeverity, b: LineSeverity): LineSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function toSeverity(raw: string): LineSeverity {
  return raw === "error" || raw === "warning" || raw === "info" ? raw : "info";
}

/**
 * Which line a finding is about.
 *
 * The scrub engine writes line numbers into message text ("Line 2 (99214) has
 * no diagnosis pointers") rather than carrying them as a field. Parsing prose is
 * fragile and it is the honest description of what is happening here: a finding
 * whose line cannot be recovered goes to the claim level rather than being
 * attached to line 1, because attaching it to the wrong line is worse than
 * showing it above the table.
 */
export function lineNumberOf(message: string): number | undefined {
  const m = /\bLine\s+(\d+)\b/i.exec(message);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function buildClaimScrubView(
  claim: ClaimInput,
  findings: ScrubFinding[],
  opts: {
    autoheal?: AutohealResult;
    blindSpots?: string[];
    verdict?: ClaimScrubView["verdict"];
  } = {},
): ClaimScrubView {
  const lines: ClaimLineView[] = claim.service_lines.map((l, i) => {
    const pos = classifyPos(l.place_of_service);
    return {
      index: i + 1,
      code: l.cpt_hcpcs,
      modifiers: l.modifiers ?? [],
      units: l.units ?? 1,
      charge: l.charge,
      serviceDate: l.service_date,
      pos: l.place_of_service,
      posName: pos.entry?.name ?? (pos.status === "unassigned" ? "unassigned code" : "not a POS code"),
      dxPointers: l.dx_pointers ?? [],
      severity: "clean",
      findings: [],
    };
  });

  const claimFindings: ClaimFindingView[] = [];
  const attach = (f: ClaimFindingView, lineNo: number | undefined) => {
    const line = lineNo ? lines[lineNo - 1] : undefined;
    if (!line) {
      claimFindings.push(f);
      return;
    }
    line.findings.push(f);
    line.severity = worst(line.severity, f.severity);
  };

  // Deduplicate identical findings. The engines run some checks per service-date
  // group, and a rule that reports a fact about the SYSTEM rather than about the
  // group will fire once per group — a three-date claim then showed the same
  // "NCCI data not installed" notice three times. That root cause is fixed in
  // claim-scrub.ts; this is the guard that stops the next one reaching a coder's
  // screen, where repetition reads as three separate problems.
  const seen = new Set<string>();
  for (const f of findings) {
    // "clean" is the engine's way of saying it found nothing; it is a fact about
    // the run, not a finding to render on a line.
    if (f.rule === "clean") continue;
    const key = `${f.rule}|${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    attach({ severity: toSeverity(f.severity), rule: f.rule, message: f.message }, lineNumberOf(f.message));
  }

  // Auto-heal repairs and questions ride the same rows, so a coder sees one list
  // per line rather than reconciling two tools' output.
  for (const r of opts.autoheal?.applied ?? []) {
    attach(
      {
        severity: "info",
        rule: r.rule,
        message: r.detail,
        fix: { from: r.from ?? "", to: r.to ?? "", describe: r.detail },
      },
      r.line,
    );
  }
  for (const r of opts.autoheal?.needsReview ?? []) {
    attach({ severity: "warning", rule: r.rule, message: r.detail, question: r.question }, r.line);
  }

  const counts: Record<LineSeverity, number> = { error: 0, warning: 0, info: 0, clean: 0 };
  for (const l of lines) counts[l.severity]++;

  return {
    claimId: claim.claim_id,
    payer: claim.payer_name,
    totalCharge: claim.service_lines.reduce((s, l) => s + l.charge * (l.units ?? 1), 0),
    lines,
    claimFindings,
    counts,
    blindSpots: opts.blindSpots ?? [],
    verdict: opts.verdict,
  };
}

/**
 * Billed → allowed → paid, with the shortfall named.
 *
 * The waterfall deliberately separates the contractual write-off from the
 * shortfall. A contractual adjustment is money that was never collectable and
 * showing it as a loss makes every clean claim look like a leak; the shortfall
 * beneath the expected allowed amount is the only step anyone can act on.
 */
export function buildVarianceWaterfall(
  findings: VarianceFinding[],
  opts: { basis: string; linesExamined: number },
): MoneyWaterfallView {
  const expected = findings.reduce((s, f) => s + f.expectedPerUnit * f.units, 0);
  const actual = findings.reduce((s, f) => s + f.actualPerUnit * f.units, 0);
  const shortfall = findings.reduce((s, f) => s + f.shortfall, 0);

  const steps: WaterfallStep[] = [
    {
      label: "Expected allowed",
      amount: expected,
      kind: "start",
      note: `What ${opts.basis === "contract" ? "the contract" : opts.basis === "fee_schedule" ? "Medicare" : "this payer's own median"} says these lines should have allowed.`,
    },
    { label: "Shortfall", amount: -shortfall, kind: "reduction", note: `Across ${findings.length} line(s).` },
    { label: "Actually allowed", amount: actual, kind: "end", note: "What the remittance shows." },
  ];

  return {
    title: `Underpayment — ${findings.length} of ${opts.linesExamined} line(s)`,
    steps,
    reclaimable: findings.length > 0 ? Math.round(shortfall * 100) / 100 : null,
    reclaimableLabel: "Reclaimable",
    caveat:
      opts.basis === "contract"
        ? "Measured against the recorded contract, so this is a contractual claim. Lines with no rate on file were not checked at all."
        : opts.basis === "fee_schedule"
          ? "Measured against Medicare. A commercial payer pays a contracted percentage of Medicare, so apparent variance here is expected and is NOT a recovery claim."
          : "Measured against this payer's own established median — a description of its habit, not its obligation. A payer that has underpaid since the contract was signed has a median that IS the underpayment, so this basis will not find it.",
  };
}

export function buildEmMeter(risk: EmRisk, elements: Array<{ label: string; level: string }>): EmMeterView {
  const ladder = risk.billedCode.startsWith("9920")
    ? ["99202", "99203", "99204", "99205"]
    : ["99212", "99213", "99214", "99215"];
  return {
    ladder,
    billedCode: risk.billedCode,
    supportedCode: risk.supportedCode,
    direction: risk.direction,
    distance: risk.distance,
    severity: risk.severity,
    elements,
    message: risk.message,
    remedy: risk.remedy,
  };
}

export function buildKpiTiles(kpis: KpiSet): KpiTilesView {
  const { daysInAr, cleanClaim, netCollection } = kpis;
  return {
    tiles: [
      {
        label: "Days in A/R",
        value: daysInAr.days,
        unit: "days",
        // 60 days is a common upper bound in MGMA reporting; the ring shows
        // position against it rather than implying a target.
        fraction: daysInAr.days === null ? undefined : Math.min(daysInAr.days / 60, 1),
        detail: `$${daysInAr.totalAr.toFixed(0)} outstanding`,
        note: daysInAr.note,
      },
      {
        label: "First-pass acceptance",
        value: cleanClaim.acceptanceRate,
        unit: "percent",
        fraction: cleanClaim.acceptanceRate === null ? undefined : cleanClaim.acceptanceRate / 100,
        detail: `${cleanClaim.acceptedFirstPass} of ${cleanClaim.acknowledged} acknowledged`,
        note: "Did the clearinghouse take it. Separate from whether the payer paid it.",
      },
      {
        label: "First-pass payment",
        value: cleanClaim.firstPassPaymentRate,
        unit: "percent",
        fraction: cleanClaim.firstPassPaymentRate === null ? undefined : cleanClaim.firstPassPaymentRate / 100,
        detail: `${cleanClaim.paidFirstPass} of ${cleanClaim.adjudicated} adjudicated`,
        note: "Adjudicated without a denial. High acceptance with low payment here is a coding problem.",
      },
      {
        label: "Net collection",
        value: netCollection.rate,
        unit: "percent",
        fraction: netCollection.rate === null ? undefined : Math.min(netCollection.rate / 100, 1),
        detail: `${netCollection.claimsMeasured} settled claim(s)`,
        note: netCollection.note,
      },
    ],
  };
}
