import type { Confidence, Verdict } from "./verdict.js";

// ── Twin calibration ─────────────────────────────────────────────────────────
// Scoring the twin against what the payer actually did. Three measures, because
// any one of them alone is misleading:
//
//   Accuracy is the number people quote and the least useful one here. If 90% of
//   claims pay, a twin that says PAY every time scores 90% and has never once
//   done its job.
//
//   Denial recall is what the twin is FOR: of the claims the payer actually
//   denied, how many did it warn about. A twin with poor recall is decorative.
//
//   Precision is the cost of that recall. A twin that flags everything catches
//   every denial and is ignored within a week, which makes it worse than nothing
//   because it also consumes the attention that would have caught the real ones.

export interface Prediction {
  claimId: string;
  payer: string;
  verdict: Verdict;
  confidence: Confidence | null;
  predictedCarcs: string[];
  createdAt: number;
}

export interface Outcome {
  claimId: string;
  denied: boolean;
  /** Non-patient-responsibility reason codes the payer actually used. */
  actualCarcs: string[];
}

export interface ScoredPrediction {
  claimId: string;
  payer: string;
  predicted: Verdict;
  confidence: Confidence | null;
  actualDenied: boolean;
  predictedCarcs: string[];
  actualCarcs: string[];
  carcHits: string[];
  /** The twin warned and the payer did push back. */
  truePositive: boolean;
  /** The twin warned and the payer paid clean. */
  falsePositive: boolean;
  /** The twin said PAY and the payer denied — the expensive kind of wrong. */
  falseNegative: boolean;
  trueNegative: boolean;
}

/** A prediction of anything other than PAY is a warning. */
export function isWarning(verdict: Verdict): boolean {
  return verdict !== "PAY";
}

export function scorePrediction(prediction: Prediction, outcome: Outcome): ScoredPrediction {
  const warned = isWarning(prediction.verdict);
  const actual = new Set(outcome.actualCarcs.map((c) => c.toUpperCase()));
  return {
    claimId: prediction.claimId,
    payer: prediction.payer,
    predicted: prediction.verdict,
    confidence: prediction.confidence,
    actualDenied: outcome.denied,
    predictedCarcs: prediction.predictedCarcs,
    actualCarcs: outcome.actualCarcs,
    carcHits: prediction.predictedCarcs.filter((c) => actual.has(c.toUpperCase())),
    truePositive: warned && outcome.denied,
    falsePositive: warned && !outcome.denied,
    falseNegative: !warned && outcome.denied,
    trueNegative: !warned && !outcome.denied,
  };
}

export interface ConfidenceBucket {
  confidence: Confidence;
  n: number;
  correct: number;
  accuracy: number;
}

export interface CalibrationReport {
  scored: number;
  accuracy: number;
  /** The share of claims the payer actually denied — the bar accuracy has to clear. */
  baseRate: number;
  /** Accuracy a twin would get by always predicting the commoner outcome. */
  trivialAccuracy: number;
  beatsTrivial: boolean;
  denialRecall: number;
  precision: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  carcPrecision: number;
  carcRecall: number;
  byConfidence: ConfidenceBucket[];
  confidenceOrdered: boolean;
  byPayer: Array<{ payer: string; n: number; recall: number; precision: number }>;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

const CONFIDENCE_ORDER: Confidence[] = ["low", "medium", "high"];

export function calibrate(scored: ScoredPrediction[]): CalibrationReport {
  const n = scored.length;
  const tp = scored.filter((s) => s.truePositive).length;
  const fp = scored.filter((s) => s.falsePositive).length;
  const fn = scored.filter((s) => s.falseNegative).length;
  const tn = scored.filter((s) => s.trueNegative).length;
  const denied = scored.filter((s) => s.actualDenied).length;

  const baseRate = ratio(denied, n);
  // Always guessing the commoner outcome — the score to beat before any of this
  // is worth running.
  const trivialAccuracy = Math.max(baseRate, 1 - baseRate);
  const accuracy = ratio(tp + tn, n);

  let carcHits = 0;
  let carcPredicted = 0;
  let carcActual = 0;
  for (const s of scored) {
    // Only claims the payer actually adjusted can contribute to CARC scoring;
    // predicting codes for a clean claim is already counted as a false positive.
    if (s.actualCarcs.length === 0 && s.predictedCarcs.length === 0) continue;
    carcHits += s.carcHits.length;
    carcPredicted += s.predictedCarcs.length;
    carcActual += s.actualCarcs.length;
  }

  const byConfidence: ConfidenceBucket[] = [];
  for (const level of CONFIDENCE_ORDER) {
    const bucket = scored.filter((s) => s.confidence === level);
    if (bucket.length === 0) continue;
    const correct = bucket.filter((s) => s.truePositive || s.trueNegative).length;
    byConfidence.push({ confidence: level, n: bucket.length, correct, accuracy: ratio(correct, bucket.length) });
  }
  // A confidence label is only worth reading if it tracks being right.
  const confidenceOrdered = byConfidence.every(
    (b, i) => i === 0 || b.accuracy >= byConfidence[i - 1].accuracy - 1e-9,
  );

  const payers = new Map<string, ScoredPrediction[]>();
  for (const s of scored) {
    const key = s.payer || "(unknown)";
    payers.set(key, [...(payers.get(key) ?? []), s]);
  }

  return {
    scored: n,
    accuracy,
    baseRate,
    trivialAccuracy,
    beatsTrivial: accuracy > trivialAccuracy,
    denialRecall: ratio(tp, tp + fn),
    precision: ratio(tp, tp + fp),
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    carcPrecision: ratio(carcHits, carcPredicted),
    carcRecall: ratio(carcHits, carcActual),
    byConfidence,
    confidenceOrdered,
    byPayer: [...payers.entries()]
      .map(([payer, list]) => {
        const ptp = list.filter((s) => s.truePositive).length;
        const pfp = list.filter((s) => s.falsePositive).length;
        const pfn = list.filter((s) => s.falseNegative).length;
        return { payer, n: list.length, recall: ratio(ptp, ptp + pfn), precision: ratio(ptp, ptp + pfp) };
      })
      .sort((a, b) => b.n - a.n),
  };
}

/** A miss worth remembering, phrased so it can be read back into a playbook. */
export function playbookNoteFor(s: ScoredPrediction): string | null {
  if (s.falseNegative) {
    return `Missed a denial on ${s.claimId}: the twin said PAY and ${s.payer} denied with ${s.actualCarcs.join(", ") || "no stated reason"}. Weight this pattern as a denial risk with this payer.`;
  }
  if (s.falsePositive) {
    return `Over-called ${s.claimId}: the twin predicted ${s.predicted} (${s.predictedCarcs.join(", ") || "no codes"}) and ${s.payer} paid it clean. This pattern is not the risk it was treated as.`;
  }
  if (s.truePositive && s.carcHits.length === 0 && s.actualCarcs.length > 0) {
    return `Right for the wrong reason on ${s.claimId}: the twin predicted a denial but named ${s.predictedCarcs.join(", ") || "no codes"} while ${s.payer} used ${s.actualCarcs.join(", ")}.`;
  }
  return null;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function renderCalibration(report: CalibrationReport): string {
  if (report.scored === 0) {
    return "No twin predictions have a matching remittance yet. Predictions are scored automatically once the ERA for the claim is parsed.";
  }
  const lines: string[] = [
    `${report.scored} prediction(s) scored against actual remittances.`,
    "",
    `Caught ${report.truePositives} of ${report.truePositives + report.falseNegatives} denial(s) — denial recall ${pct(report.denialRecall)}.`,
    `Of ${report.truePositives + report.falsePositives} warning(s), ${report.truePositives} were real — precision ${pct(report.precision)}.`,
    `Missed ${report.falseNegatives} denial(s) the twin called clean.`,
    "",
    `Accuracy ${pct(report.accuracy)} against a ${pct(report.baseRate)} denial base rate.`,
  ];

  // Accuracy without this comparison is the number that flatters a twin into
  // looking useful when it is only reflecting the base rate.
  lines.push(
    report.beatsTrivial
      ? `Always guessing the commoner outcome would score ${pct(report.trivialAccuracy)}, so the twin is adding something.`
      : `Always guessing the commoner outcome would score ${pct(report.trivialAccuracy)} — the twin is NOT beating that. Accuracy here reflects the base rate rather than any skill, and the recall and precision figures above are what to read.`,
  );

  if (report.carcPrecision > 0 || report.carcRecall > 0) {
    lines.push(
      "",
      `Reason codes: ${pct(report.carcPrecision)} of predicted CARCs appeared on the remittance, covering ${pct(report.carcRecall)} of the codes the payer actually used.`,
    );
  }

  if (report.byConfidence.length > 0) {
    lines.push("", "By stated confidence:");
    for (const b of report.byConfidence) {
      lines.push(`  ${b.confidence}: ${b.correct}/${b.n} correct (${pct(b.accuracy)})`);
    }
    lines.push(
      report.confidenceOrdered
        ? "  Higher confidence does track being right, so the label is worth reading."
        : "  Higher confidence does NOT track being right here. The twin's confidence is not informative yet — ignore it and read the verdict alone.",
    );
  }

  if (report.byPayer.length > 1) {
    lines.push("", "By payer:");
    for (const p of report.byPayer) {
      lines.push(`  ${p.payer}: ${p.n} scored · recall ${pct(p.recall)} · precision ${pct(p.precision)}`);
    }
  }

  return lines.join("\n");
}
