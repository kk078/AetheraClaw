// ── Failure classification ───────────────────────────────────────────────────
// Tier 1 gets "the batch failed" and starts reading logs. Most of the time the
// evidence already names the cause precisely, in a form nobody reads because it
// is a status triplet or a stack frame. This maps evidence to cause.
//
// The design constraint that matters: it must be able to say IT DOES NOT KNOW.
// A classifier that always returns a category is worse than no classifier,
// because a confident wrong category sends an engineer down the wrong path for
// an hour, and they trust it precisely because it sounded certain. Every rule
// here requires positive evidence, and anything unmatched comes back as
// unclassified with the raw text attached.

export type FailureCategory =
  | "auth"
  | "network"
  | "timeout"
  | "rate_limit"
  | "schema_mismatch"
  | "missing_reference_data"
  | "payer_rejection"
  | "payer_denial"
  | "database"
  | "disk"
  | "model_capacity"
  // The two below are never returned by classifyFailure, because there is no
  // text to classify: they are read off a claim's lifecycle record by
  // ops_generate_rca, where the evidence is a stage that never happened rather
  // than an error somebody caught. They live in the same enum so a claim's root
  // cause and a tool failure's root cause can be counted, owned and rendered by
  // the same code — a claim stuck for ninety days is an incident with a cause,
  // and giving it a separate vocabulary would just mean two of everything.
  | "submission_gap"
  | "no_payer_response"
  | "unclassified";

export interface Diagnosis {
  category: FailureCategory;
  confidence: "certain" | "likely";
  cause: string;
  /** What to do, ordered by what resolves it fastest. */
  nextSteps: string[];
  /** The text this was matched on, so nobody has to take it on trust. */
  evidence: string;
}

interface Rule {
  category: FailureCategory;
  confidence: "certain" | "likely";
  pattern: RegExp;
  cause: string;
  nextSteps: string[];
}

/**
 * Ordered — first match wins, so the specific rules come before the general.
 *
 * "401" must be tested before "HTTP error", and a Node error CODE (ECONNREFUSED)
 * before the prose that surrounds it, because the code is unambiguous and the
 * prose is whatever the library felt like writing.
 */
const RULES: Rule[] = [
  {
    category: "auth",
    confidence: "certain",
    pattern: /\b(401|403)\b|unauthorized|invalid[_ ]api[_ ]key|authentication failed|missing bearer/i,
    cause: "The upstream rejected the credentials, not the request.",
    nextSteps: [
      "Check the relevant *_API_KEY is present in the environment of the RUNNING process, not just your shell — `aetheraclaw providers` prints which keys it can see.",
      "A 403 with a valid key usually means the key is real but not entitled to this endpoint or model.",
      "Retrying will not help. This fails identically every time until the credential changes.",
    ],
  },
  {
    category: "rate_limit",
    confidence: "certain",
    pattern: /\b429\b|rate[_ ]limit|too many requests|quota exceeded/i,
    cause: "The upstream is throttling this client.",
    nextSteps: [
      "Back off and retry — this one IS transient, unlike the other HTTP failures here.",
      "If it repeats under normal load, the account limit is the constraint rather than the burst.",
    ],
  },
  {
    category: "network",
    confidence: "certain",
    pattern: /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|fetch failed|socket hang up/i,
    cause: "The endpoint was not reachable at all — nothing answered.",
    nextSteps: [
      "For a local Ollama: is `ollama serve` running? ECONNREFUSED on localhost is almost always this.",
      "For a remote endpoint: DNS, egress rules, or the service being down. Check ops_ollama_telemetry for the inference path specifically.",
      "Distinguish from a timeout — nothing answered here, rather than answering slowly.",
    ],
  },
  {
    category: "timeout",
    confidence: "certain",
    pattern: /ETIMEDOUT|timed? ?out|AbortError|signal is aborted|deadline exceeded/i,
    cause: "Something answered too slowly, or not before the deadline.",
    nextSteps: [
      "If this is model inference, check ops_ollama_telemetry — a model only partly resident in VRAM is the usual cause and no timeout increase fixes it.",
      "If it is a database call, check ops_tenant_integrity_check for WAL growth: a long-lived reader blocks a checkpoint and everything queues behind it.",
    ],
  },
  {
    category: "disk",
    confidence: "certain",
    pattern: /ENOSPC|no space left|disk (?:is )?full|SQLITE_FULL/i,
    cause: "The filesystem is out of space.",
    nextSteps: [
      "Writes fail while deletes still succeed. Free space before anything else — a database written to a full disk can be left inconsistent.",
      "Check WAL sizes first (ops_tenant_integrity_check); an un-checkpointed WAL is the usual quiet consumer.",
    ],
  },
  {
    category: "database",
    confidence: "certain",
    pattern: /SQLITE_BUSY|database is locked|SQLITE_CORRUPT|malformed database|SQLITE_READONLY|attempt to write a readonly/i,
    cause: "SQLite refused the operation.",
    nextSteps: [
      "`database is locked` means a concurrent writer held it past the busy timeout — find the long transaction rather than raising the timeout.",
      "`readonly` after the permission hardening usually means the process is not the file's owner.",
      "`malformed` is corruption: stop writing and run ops_tenant_integrity_check before anything else.",
    ],
  },
  {
    category: "missing_reference_data",
    confidence: "certain",
    pattern: /data not installed|not found in local data|mpfs\.json|ncci-ptp\.json|mue\.json|no RVU data/i,
    cause: "A reference dataset the operation needs is absent, so the check could not run.",
    nextSteps: [
      "Run data_status for what is missing and what each absence blocks, and ops_dataset_health for whether what IS installed is current.",
      "This is not a failure of the claim — it is a limit on what could be verified about it. Do not read the result as a pass.",
    ],
  },
  {
    category: "schema_mismatch",
    confidence: "certain",
    pattern: /Invalid input for|invalid_type|Required at|Unrecognized key|zod|no such column|no such table/i,
    cause: "The payload did not match the shape the receiver expects.",
    nextSteps: [
      "For a tool call, the validation message names the exact field. A model guessing `procedure_code` for `cpt_hcpcs` is the common one, and it self-corrects on retry.",
      "`no such column` or `no such table` means the database predates the code — schema is applied on open, so serving the tenant once usually resolves it. Confirm with ops_tenant_integrity_check first.",
    ],
  },
  {
    category: "model_capacity",
    confidence: "likely",
    pattern: /context length|maximum context|token limit|too many tokens|prompt is too long|out of memory|CUDA/i,
    cause: "The request exceeded what the model could hold, or the machine could not fit the model.",
    nextSteps: [
      "Compare contextTokenBudget against the model's loaded context with ops_ollama_telemetry — Ollama truncates silently, so the model answers about a conversation it cannot fully see.",
      "On a smaller provider window, lower the tool profile: `--profile claims` sends 44 definitions instead of 191.",
    ],
  },
];

/** 277CA status categories that mean the claim never entered adjudication. */
const REJECTION_CATEGORIES = /\b(A3|A7|A8)\b/;

export function classifyFailure(text: string): Diagnosis {
  const evidence = text.trim().slice(0, 500);

  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    return {
      category: rule.category,
      confidence: rule.confidence,
      cause: rule.cause,
      nextSteps: rule.nextSteps,
      evidence: match[0],
    };
  }

  if (REJECTION_CATEGORIES.test(text)) {
    return {
      category: "payer_rejection",
      confidence: "certain",
      cause: "A front-end rejection — the claim never entered adjudication.",
      nextSteps: [
        "There are no appeal rights, because there was no determination. Correct and resubmit.",
        "Timely filing kept running throughout. Check timely_filing_check before assuming there is room.",
        "Parse the full acknowledgment with ack_parse_277ca — the status triplet names which entity's data was wrong.",
      ],
      evidence,
    };
  }

  return {
    category: "unclassified",
    confidence: "likely",
    cause: "No rule matched this text.",
    nextSteps: [
      "This is deliberately not a guess. A classifier that always returns a category sends an engineer down the wrong path for an hour, and they trust it because it sounded certain.",
      "The raw evidence is below. If this shape recurs, it is worth a rule.",
    ],
    evidence,
  };
}

/**
 * Outcomes the registry already determined, so the classifier must not re-derive them.
 *
 * The tool-call log records WHY a call failed at the choke point that decided
 * it: an unknown name, a schema rejection, a denied approval. Feeding that
 * row's error prose back through a text classifier throws away a fact for a
 * guess — and the guess came back UNCLASSIFIED, which is worse than the
 * structured answer sitting one field away. Only a genuine execution error
 * needs the text rules.
 */
const OUTCOME_DIAGNOSES: Record<string, Omit<Diagnosis, "evidence">> = {
  unknown_tool: {
    category: "schema_mismatch",
    confidence: "certain",
    cause: "The model called a tool that does not exist.",
    nextSteps: [
      "The registry already replied with the nearest real names — deliberately, rather than aliasing the invented one, so the model corrects itself instead of learning nothing.",
      "A NAME that recurs across sessions is worth a look: it usually means a real tool is hard to discover, not that the model is careless.",
    ],
  },
  invalid_input: {
    category: "schema_mismatch",
    confidence: "certain",
    cause: "The input did not match the tool's schema and was rejected before execution.",
    nextSteps: [
      "The validation message names the exact field. This self-corrects on retry, so a one-off is not an incident.",
      "The same wrong input SHAPE repeating is the signal: it means the schema is being misread the same way every time, which is a description problem rather than a model problem.",
    ],
  },
  denied: {
    category: "unclassified",
    confidence: "certain",
    cause: "A human denied the approval request.",
    nextSteps: [
      "Not a fault. It is recorded because a run that stopped because somebody said no looks identical to a run that failed, until you can tell them apart.",
    ],
  },
};

/**
 * Diagnose a logged call, preferring the recorded outcome over its prose.
 */
export function diagnoseRecord(record: { toolName: string; outcome: string; errorText: string }): Diagnosis {
  const known = OUTCOME_DIAGNOSES[record.outcome];
  if (known) return { ...known, evidence: `${record.toolName}: ${record.errorText.slice(0, 200)}` };
  return classifyFailure(`${record.toolName}: ${record.errorText}`);
}

export function diagnoseRecords(records: Array<{ toolName: string; outcome: string; errorText: string }>): BatchDiagnosis {
  const diagnoses = records.map(diagnoseRecord);
  return { total: records.length, byCategory: groupCategories(diagnoses), diagnoses };
}

function groupCategories(diagnoses: Diagnosis[]): BatchDiagnosis["byCategory"] {
  const grouped = new Map<FailureCategory, { count: number; example: string }>();
  for (const d of diagnoses) {
    const slot = grouped.get(d.category) ?? { count: 0, example: d.evidence };
    slot.count++;
    grouped.set(d.category, slot);
  }
  return [...grouped.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.count - a.count);
}

export interface BatchDiagnosis {
  total: number;
  byCategory: Array<{ category: FailureCategory; count: number; example: string }>;
  diagnoses: Diagnosis[];
}

/**
 * Classify many failures at once.
 *
 * The count per category is the useful output for a batch: forty failures with
 * one cause is one incident, and forty with eleven causes is a different
 * situation entirely. Reading them one at a time hides which of the two it is.
 */
export function diagnoseBatch(texts: string[]): BatchDiagnosis {
  const diagnoses = texts.map(classifyFailure);
  return { total: texts.length, byCategory: groupCategories(diagnoses), diagnoses };
}

export function renderDiagnosis(d: Diagnosis): string {
  return [
    `${d.category.toUpperCase().replace(/_/g, " ")} (${d.confidence})`,
    `  ${d.cause}`,
    ...d.nextSteps.map((s) => `  → ${s}`),
    `  Matched on: ${d.evidence}`,
  ].join("\n");
}

export function renderBatch(batch: BatchDiagnosis): string {
  if (batch.total === 0) return "Nothing to classify.";
  const lines = [`${batch.total} failure(s):`, ""];
  for (const g of batch.byCategory) {
    lines.push(`  ${String(g.count).padStart(4)} × ${g.category.replace(/_/g, " ")}`);
  }
  if (batch.byCategory.length === 1) {
    lines.push("", "One cause across all of them — this is a single incident, not a batch of unrelated problems.");
  } else if (batch.byCategory.length > 3) {
    lines.push(
      "",
      `${batch.byCategory.length} distinct causes. That is usually not one incident; look for something that changed underneath them all rather than fixing each.`,
    );
  }
  const first = batch.diagnoses.find((d) => d.category === batch.byCategory[0]?.category);
  if (first) lines.push("", "Most common:", renderDiagnosis(first));
  const unclassified = batch.byCategory.find((g) => g.category === "unclassified");
  if (unclassified) {
    lines.push("", `${unclassified.count} did not match any rule and are reported as unclassified rather than guessed at.`);
  }
  return lines.join("\n");
}
