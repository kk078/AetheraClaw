// ── Risk adjustment ──────────────────────────────────────────────────────────
// A RAF score is a payment multiplier built from diagnoses, and that makes it
// the one number in this project where coding harder directly raises revenue.
// Which is exactly why the Department of Justice has extracted nine-figure
// settlements over it, and why every function here is built to be defensible
// rather than to maximise.
//
// Two structural facts drive the whole module:
//
//   HCCs do not carry forward. Every chronic condition has to be documented in
//   a face-to-face encounter and coded again in EVERY calendar year to count for
//   the next payment year. A patient's diabetes does not stay on the books
//   because it was coded in March of last year. That reset is what "recapture"
//   means, and it is the largest and most legitimate source of missed revenue in
//   value-based care — legitimate because the condition is real and documented,
//   and it simply was not re-coded.
//
//   Within a hierarchy, only the most severe condition counts. Coding both the
//   severe and the mild form of the same disease does not pay twice, and a tool
//   that adds their coefficients overstates the score in the direction an
//   auditor looks first.

/** CMS-HCC v28 is at full weight for payment year 2026, ending a three-year phase-in. */
export const CURRENT_MODEL = "v28";
export const V28_FULL_WEIGHT_YEAR = 2026;

/**
 * v28 dropped roughly two thousand diagnosis codes that mapped to an HCC under
 * v24, and expanded the categories from 86 to 115. A practice still working from
 * a v24 crosswalk is coding conditions that no longer carry any weight — the
 * effort is spent and the revenue is not there.
 */
export const V28_NOTE =
  "v28 removed about 2,000 diagnosis codes that mapped to an HCC under v24 and expanded the categories from 86 to 115. A crosswalk built for v24 will suggest codes that now carry no weight at all.";

export interface HccDefinition {
  hcc: string;
  label: string;
  coefficient: number;
  /** Hierarchy group. Within a group only the most severe HCC counts. */
  hierarchy: string;
  /** Higher wins within a hierarchy. */
  severity: number;
}

export interface HccModel {
  version: string;
  /** ICD-10 (normalized, no dot) → HCC code. */
  mapping: Record<string, string>;
  definitions: Record<string, HccDefinition>;
  /** Demographic coefficients keyed by a bucket label the caller builds. */
  demographic: Record<string, number>;
  /** Additive interaction terms, keyed by a name the caller can explain. */
  interactions: Record<string, { coefficient: number; requires: string[] }>;
}

export function normalizeIcd(code: string): string {
  return code.replace(/[.\s]/g, "").toUpperCase();
}

export interface Demographics {
  age: number;
  sex: "M" | "F" | "U";
  /** Community vs institutional changes the coefficient set entirely. */
  institutional?: boolean;
  /** Dual eligibility and disability both carry their own terms. */
  dualEligible?: boolean;
  disabled?: boolean;
}

/** The bucket label a demographic coefficient is looked up by. Exported so a model file can match it. */
export function demographicKey(d: Demographics): string {
  const bands = [0, 35, 45, 55, 60, 65, 70, 75, 80, 85, 90, 95];
  const band = bands.filter((b) => d.age >= b).pop() ?? 0;
  const upper = bands.find((b) => b > band);
  const range = upper ? `${band}_${upper - 1}` : `${band}_GT`;
  return [
    d.institutional ? "INS" : "CMS",
    d.sex === "F" ? "F" : "M",
    range,
    d.dualEligible ? "DUAL" : "NONDUAL",
    d.disabled ? "DIS" : "AGED",
  ].join("_");
}

export interface HierarchyResult {
  kept: string[];
  /** HCCs suppressed by a more severe one in the same hierarchy, and which. */
  suppressed: Array<{ hcc: string; by: string; hierarchy: string }>;
}

/**
 * Apply the hierarchies.
 *
 * Coding both the severe and the mild form of one disease does not pay twice.
 * Summing them would overstate the score, and overstatement is the direction an
 * auditor tests first — so the suppression is reported rather than done quietly,
 * because a coder who cannot see why a code stopped counting will code it again.
 */
export function applyHierarchies(hccs: string[], model: HccModel): HierarchyResult {
  const unique = [...new Set(hccs)].filter((h) => model.definitions[h]);
  const byHierarchy = new Map<string, HccDefinition[]>();
  const free: string[] = [];

  for (const hcc of unique) {
    const def = model.definitions[hcc];
    if (!def.hierarchy) {
      free.push(hcc);
      continue;
    }
    byHierarchy.set(def.hierarchy, [...(byHierarchy.get(def.hierarchy) ?? []), def]);
  }

  const kept = [...free];
  const suppressed: HierarchyResult["suppressed"] = [];
  for (const [hierarchy, group] of byHierarchy) {
    const ordered = [...group].sort((a, b) => b.severity - a.severity || a.hcc.localeCompare(b.hcc));
    kept.push(ordered[0].hcc);
    for (const loser of ordered.slice(1)) {
      suppressed.push({ hcc: loser.hcc, by: ordered[0].hcc, hierarchy });
    }
  }

  return { kept: kept.sort(), suppressed };
}

export interface RafComponent {
  label: string;
  code: string;
  coefficient: number;
}

export interface RafResult {
  version: string;
  score: number;
  demographic: RafComponent | null;
  hccs: RafComponent[];
  interactions: RafComponent[];
  suppressed: HierarchyResult["suppressed"];
  /** ICD-10 codes that mapped to nothing. Not an error — most codes are not HCCs. */
  unmapped: string[];
  warnings: string[];
}

/**
 * Compute a RAF score from diagnoses.
 *
 * Every term is reported with the code it came from. A score nobody can take
 * apart is a score nobody can defend, and the question in a RADV audit is always
 * about one condition rather than the total.
 */
export function computeRaf(demographics: Demographics, diagnoses: string[], model: HccModel): RafResult {
  const warnings: string[] = [];
  const unmapped: string[] = [];
  const hccs: string[] = [];

  for (const dx of diagnoses) {
    const hcc = model.mapping[normalizeIcd(dx)];
    if (hcc) hccs.push(hcc);
    else unmapped.push(dx.toUpperCase());
  }

  const hierarchy = applyHierarchies(hccs, model);
  const key = demographicKey(demographics);
  const demoCoefficient = model.demographic[key];
  const demographic: RafComponent | null =
    demoCoefficient === undefined ? null : { label: "Demographic", code: key, coefficient: demoCoefficient };
  if (demoCoefficient === undefined) {
    warnings.push(
      `The model has no demographic coefficient for "${key}", so the score below is the disease burden only. A RAF without its demographic term is not comparable to a published one.`,
    );
  }

  const hccComponents: RafComponent[] = hierarchy.kept.map((hcc) => ({
    label: model.definitions[hcc].label,
    code: hcc,
    coefficient: model.definitions[hcc].coefficient,
  }));

  const interactions: RafComponent[] = [];
  for (const [name, term] of Object.entries(model.interactions)) {
    if (term.requires.every((h) => hierarchy.kept.includes(h))) {
      interactions.push({ label: name, code: term.requires.join("+"), coefficient: term.coefficient });
    }
  }

  const score =
    (demoCoefficient ?? 0) +
    hccComponents.reduce((s, c) => s + c.coefficient, 0) +
    interactions.reduce((s, c) => s + c.coefficient, 0);

  if (model.version !== CURRENT_MODEL) {
    warnings.push(
      `This is model ${model.version}, and ${CURRENT_MODEL} is at full weight from payment year ${V28_FULL_WEIGHT_YEAR}. ${V28_NOTE}`,
    );
  }

  return {
    version: model.version,
    score: Math.round(score * 1000) / 1000,
    demographic,
    hccs: hccComponents,
    interactions,
    suppressed: hierarchy.suppressed,
    unmapped,
    warnings,
  };
}

export function renderRaf(result: RafResult, patientRef = ""): string {
  const lines = [
    `RAF ${result.score.toFixed(3)} — model ${result.version}${patientRef ? ` — ${patientRef}` : ""}`,
    "",
  ];

  if (result.demographic) {
    lines.push(`  ${result.demographic.coefficient.toFixed(3)}  demographic (${result.demographic.code})`);
  }
  for (const c of result.hccs) lines.push(`  ${c.coefficient.toFixed(3)}  ${c.code} — ${c.label}`);
  for (const c of result.interactions) lines.push(`  ${c.coefficient.toFixed(3)}  interaction: ${c.label} (${c.code})`);
  if (result.hccs.length === 0) lines.push("  no conditions mapped to an HCC");

  if (result.suppressed.length > 0) {
    lines.push(
      "",
      "Suppressed by hierarchy — these were coded but do not add to the score:",
      ...result.suppressed.map((s) => `  ${s.hcc} is covered by ${s.by} (${s.hierarchy})`),
      "That is the model working as designed: the more severe form already pays for the condition. Coding both does not pay twice.",
    );
  }

  if (result.unmapped.length > 0) {
    lines.push(
      "",
      `${result.unmapped.length} diagnosis code(s) mapped to no HCC. Most codes do not, so this is ordinary — but if a chronic condition is in this list, check it against the ${CURRENT_MODEL} mapping rather than an older crosswalk.`,
    );
  }

  if (result.warnings.length > 0) {
    lines.push("", ...result.warnings.map((w) => `⚠ ${w}`));
  }

  lines.push(
    "",
    "A RAF is only worth what the records behind it are worth. Every condition in this score has to be documented in a face-to-face encounter this year by an acceptable provider, and be supported by the note rather than by a problem list carried forward.",
  );

  return lines.join("\n");
}

/** Load a model from a plain object, saying what is missing rather than half-working. */
export function validateModel(raw: unknown): HccModel | string {
  if (!raw || typeof raw !== "object") return "The model file is not an object.";
  const model = raw as Partial<HccModel>;
  if (!model.version) return "The model has no version. A RAF computed against an unnamed model cannot be checked later.";
  if (!model.mapping || Object.keys(model.mapping).length === 0) return "The model has no ICD-10 to HCC mapping.";
  if (!model.definitions || Object.keys(model.definitions).length === 0) return "The model has no HCC definitions.";

  const missing = [...new Set(Object.values(model.mapping))].filter((hcc) => !model.definitions![hcc]);
  if (missing.length > 0) {
    return `The mapping points at ${missing.length} HCC(s) the definitions do not describe (${missing.slice(0, 5).join(", ")}). A code that maps to a category with no coefficient would silently contribute nothing.`;
  }

  return {
    version: model.version,
    mapping: model.mapping,
    definitions: model.definitions,
    demographic: model.demographic ?? {},
    interactions: model.interactions ?? {},
  };
}
