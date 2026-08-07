// ── Quality measures from claims ─────────────────────────────────────────────
// A quality measure asks a clinical question — was the blood pressure
// controlled, was the A1c under nine — and a claim carries almost none of the
// answer. What it carries is CPT Category II codes, which exist for exactly this
// purpose: they are how a clinical value gets onto a claim at all.
//
// That produces the failure mode worth naming. A practice that controls blood
// pressure well but never submits the Category II codes looks, in claims, like a
// practice that never controls blood pressure. The measure is not failing; the
// reporting is. Telling those two apart is most of what this module is for, and
// a rate computed without saying which one you are looking at is worse than no
// rate.

export interface MeasureSpec {
  id: string;
  title: string;
  /** What puts a patient in the denominator — the population the measure is about. */
  denominatorCodes: string[];
  minAge?: number;
  maxAge?: number;
  /** What satisfies the measure. Usually CPT Category II codes. */
  numeratorCodes: string[];
  /** Codes that take a patient out of the denominator legitimately. */
  exclusionCodes: string[];
  /**
   * Category II codes carrying a performance-exclusion or performance-not-met
   * modifier. Submitted, so visible — and distinguishable from silence.
   */
  notMetCodes: string[];
  /** What a claim simply cannot answer for this measure. Always printed. */
  blindSpots: string[];
}

/**
 * A small, claims-computable set. Deliberately not a full eCQM library: a
 * measure whose numerator lives entirely in the chart cannot be computed here,
 * and shipping it would produce a confident wrong number.
 */
export const MEASURES: MeasureSpec[] = [
  {
    id: "MIPS-236",
    title: "Controlling high blood pressure",
    denominatorCodes: ["I10", "I11", "I12", "I13", "I15"],
    minAge: 18,
    maxAge: 85,
    numeratorCodes: ["3074F", "3075F", "3078F", "3079F"],
    exclusionCodes: ["N18.6", "Z99.2", "O09", "O10"],
    notMetCodes: ["3077F", "3080F"],
    blindSpots: [
      "The most recent blood pressure reading is the numerator, and it reaches a claim only as a Category II code. A patient at 118/74 with no 3074F/3078F submitted is indistinguishable from a patient nobody measured.",
      "Pregnancy and ESRD exclusions are only visible if they were coded on a claim in the period.",
    ],
  },
  {
    id: "MIPS-001",
    title: "Diabetes: haemoglobin A1c poor control (> 9%)",
    denominatorCodes: ["E10", "E11", "E13"],
    minAge: 18,
    maxAge: 75,
    // This measure is INVERSE: the numerator is poor control, so lower is better.
    numeratorCodes: ["3046F"],
    exclusionCodes: ["Z51.5", "Z66"],
    notMetCodes: ["3044F", "3051F", "3052F"],
    blindSpots: [
      "This is an inverse measure — the numerator is poor control, so a LOWER rate is better. Reading it like an ordinary measure inverts the conclusion.",
      "An A1c drawn and normal reaches the claim only as 3044F/3051F/3052F. No Category II code at all means the test is invisible, not that it was not done.",
    ],
  },
  {
    id: "MIPS-134",
    title: "Screening for depression and follow-up plan",
    denominatorCodes: ["Z00.00", "Z00.01", "99202", "99203", "99204", "99205", "99212", "99213", "99214", "99215"],
    minAge: 12,
    numeratorCodes: ["G8431", "G8510"],
    exclusionCodes: ["G8433", "G9717"],
    notMetCodes: ["G8432", "G8511"],
    blindSpots: [
      "The screening instrument and its result are documented in the note; only the G-code reaches the claim.",
    ],
  },
];

export interface Encounter {
  patientRef: string;
  serviceDate: string;
  age: number;
  /** Every code on the claim — diagnoses and procedures together. */
  codes: string[];
}

export interface MeasureResult {
  id: string;
  title: string;
  denominator: number;
  numerator: number;
  excluded: number;
  /** Denominator patients with an explicit performance-not-met code. */
  notMet: number;
  /**
   * Denominator patients with NO Category II code either way. Neither met nor
   * not-met — simply unreported, and the number that usually explains a bad rate.
   */
  unreported: number;
  /** numerator ÷ (denominator − excluded). */
  rate: number;
  /** The rate if the unreported patients performed like the reported ones. */
  rateIfReported: number;
  inverse: boolean;
  blindSpots: string[];
}

function matches(codes: string[], patterns: string[]): boolean {
  const normalized = codes.map((c) => c.replace(/[.\s]/g, "").toUpperCase());
  return patterns.some((p) => {
    const pattern = p.replace(/[.\s]/g, "").toUpperCase();
    return normalized.some((c) => c.startsWith(pattern));
  });
}

/** Roll a patient's encounters up: a measure is about the patient over the period, not per visit. */
function byPatient(encounters: Encounter[]): Map<string, { age: number; codes: string[] }> {
  const out = new Map<string, { age: number; codes: string[] }>();
  for (const e of encounters) {
    const slot = out.get(e.patientRef) ?? { age: e.age, codes: [] };
    slot.age = Math.max(slot.age, e.age);
    slot.codes.push(...e.codes);
    out.set(e.patientRef, slot);
  }
  return out;
}

export function computeMeasure(spec: MeasureSpec, encounters: Encounter[]): MeasureResult {
  const patients = byPatient(encounters);
  let denominator = 0;
  let numerator = 0;
  let excluded = 0;
  let notMet = 0;
  let unreported = 0;

  for (const { age, codes } of patients.values()) {
    if (spec.minAge !== undefined && age < spec.minAge) continue;
    if (spec.maxAge !== undefined && age > spec.maxAge) continue;
    if (!matches(codes, spec.denominatorCodes)) continue;
    denominator++;

    if (matches(codes, spec.exclusionCodes)) {
      excluded++;
      continue;
    }
    if (matches(codes, spec.numeratorCodes)) numerator++;
    else if (matches(codes, spec.notMetCodes)) notMet++;
    else unreported++;
  }

  const eligible = denominator - excluded;
  const reported = numerator + notMet;
  return {
    id: spec.id,
    title: spec.title,
    denominator,
    numerator,
    excluded,
    notMet,
    unreported,
    rate: eligible > 0 ? numerator / eligible : 0,
    // What the rate would be if the unreported patients behaved like the ones
    // that were reported. Not a claim about them — an estimate of how much of a
    // poor rate is performance and how much is paperwork.
    rateIfReported: reported > 0 ? numerator / reported : 0,
    inverse: spec.id === "MIPS-001",
    blindSpots: spec.blindSpots,
  };
}

export function computeAll(encounters: Encounter[], specs: MeasureSpec[] = MEASURES): MeasureResult[] {
  return specs.map((s) => computeMeasure(s, encounters)).filter((r) => r.denominator > 0);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function renderMeasures(results: MeasureResult[]): string {
  if (results.length === 0) {
    return "No measure had anybody in its denominator. Either the population is not here, or the diagnoses that define it were never coded.";
  }

  const lines: string[] = [];
  for (const r of results) {
    const eligible = r.denominator - r.excluded;
    lines.push(
      `${r.id} — ${r.title}${r.inverse ? "  [INVERSE: lower is better]" : ""}`,
      `  ${r.numerator} of ${eligible} = ${pct(r.rate)}${r.excluded ? `  (${r.excluded} excluded)` : ""}`,
    );

    if (r.unreported > 0) {
      const share = eligible > 0 ? r.unreported / eligible : 0;
      const reported = r.numerator + r.notMet;
      lines.push(`  ${r.unreported} patient(s) — ${pct(share)} of the denominator — have no Category II code either way.`);

      if (reported === 0) {
        lines.push(
          "  Nobody in this denominator was reported on at all, so the rate above measures submission and not care. There is no performance signal here yet.",
        );
      } else {
        lines.push(`  Among the ${reported} who were reported, the rate is ${pct(r.rateIfReported)}.`);
        lines.push(
          share > 0.25
            ? "  That gap is large enough that this is a reporting problem before it is a performance one — the unreported patients are indistinguishable from patients nobody assessed, whichever they are."
            : "  Submitting the Category II codes for those encounters would settle which side of the measure they fall on.",
        );
      }
    }

    for (const blind of r.blindSpots) lines.push(`  ⚠ ${blind}`);
    lines.push("");
  }

  lines.push(
    "These are computed from claims alone. Claims carry Category II codes and nothing else clinical, so treat every rate here as a floor on real performance and a ceiling on nothing.",
  );
  return lines.join("\n");
}
