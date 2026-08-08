import type { ToolSpec } from "../providers/types.js";

// ── Module map ───────────────────────────────────────────────────────────────
// 176 tools in one list is a wall of names. Grouped by the job they belong to,
// it is a map of what the system can actually do — which is what somebody
// opening this for the first time needs, and what the flat registry never told
// them.
//
// Ordered: the first pattern that matches a tool wins, so narrower entries come
// before broader prefixes. Everything unmatched lands in a catch-all rather than
// disappearing, because a tool that belongs to no module is invisible in the UI
// and that is worse than an ugly grouping.

export interface ModuleDef {
  key: string;
  label: string;
  /** One line, for the card. */
  blurb: string;
  /** The idea worth knowing before using it. */
  note: string;
  glyph: string;
  match: string[];
}

export const MODULES: ModuleDef[] = [
  {
    key: "codes",
    label: "Coding & Lookup",
    blurb: "ICD-10, HCPCS and NPI validation against bundled and live registries.",
    note: "ICD-10 runs fully offline against bundled FY2026 data. NPI check digits are Luhn-validated without a network call. Place-of-service codes are a table, not a recollection — POS 22 is On Campus-Outpatient Hospital.",
    glyph: "◈",
    match: ["icd10_", "hcpcs_", "npi_", "pos_lookup"],
  },
  {
    key: "em",
    label: "E/M Levelling",
    blurb: "2021 MDM-guideline scorer and peer bell-curve benchmarking.",
    note: "The level is the 2-of-3 middle value across problems, data and risk — shown element by element, never as a bare code.",
    glyph: "◐",
    match: ["em_calculate", "em_benchmark"],
  },
  {
    key: "coverage",
    label: "Medicare Coverage",
    blurb: "NCD and LCD search, contractors, self-administered drug exclusions.",
    note: "The CMS API publishes no state-to-MAC mapping — find the policy that binds you by searching LCDs, not by looking up a state.",
    glyph: "◇",
    match: ["coverage_", "mac_lookup", "sad_exclusion_check"],
  },
  {
    key: "claims",
    label: "Claim Build & Scrub",
    blurb: "837P generation, rule-engine scrubbing, charge capture.",
    note: "The scrubber reports severity, and a dangling diagnosis pointer is an error rather than a warning — it cannot be adjudicated. claim_autoheal fixes only what has one correct answer; anything needing a fact the claim does not contain comes back as a question.",
    glyph: "▣",
    match: ["claim_scrub", "claim_autoheal", "claim_build_837p", "superbill_build"],
  },
  {
    key: "remittance",
    label: "Remittance & Variance",
    blurb: "835 parsing, acknowledgment triage, underpayment detection.",
    note: "Underpayment is measured against Medicare, the payer's own established median, or a recorded contract. Only the last supports the sentence \"you allowed less than the agreement says\" — a payer's median describes its habit, not its obligation, so a payer underpaying since signing has a median that IS the underpayment.",
    glyph: "▤",
    match: ["era_", "ack_parse_277ca", "payment_variance", "fee_schedule_drift", "reimbursement_estimate", "analytics_query", "contract_rate_", "kpi_dashboard"],
  },
  {
    key: "denials",
    label: "Denials & Appeals",
    blurb: "CARC/RARC explanation, risk scoring, worklists, appeal drafting.",
    note: "Risk scores shrink toward the practice baseline in proportion to the evidence, so three claims with one denial is not a 33% rate.",
    glyph: "▽",
    match: ["denial_", "appeal_draft", "worklist_"],
  },
  {
    key: "twin",
    label: "Adversarial Payer Twin",
    blurb: "A second agent role-plays the payer and tries to deny the claim first.",
    note: "Grounded in a playbook built from the practice's own 835 history, and scored against what the payer actually did.",
    glyph: "◭",
    match: ["twin_", "payer_twin_adjudicate", "claim_gauntlet"],
  },
  {
    key: "filing",
    label: "Timely Filing",
    blurb: "Per-payer deadlines, countdowns, and banked proof of acceptance.",
    note: "Proof means an acceptance report, not a submission log. 277CA acknowledgments are banked as they arrive.",
    glyph: "◷",
    match: ["timely_filing_", "filing_proof_record"],
  },
  {
    key: "eligibility",
    label: "Eligibility & Prior Auth",
    blurb: "Da Vinci CRD/DTR/PAS, the CMS-0057-F decision clock, eligibility checks.",
    note: "Decision timeframes are in force now: 72 hours expedited, seven calendar days standard. 'Unknown' is kept distinct from 'not required'.",
    glyph: "◑",
    match: ["pa_", "dtr_", "eligibility_check"],
  },
  {
    key: "cdi",
    label: "Clinical Documentation",
    blurb: "Specificity gaps, compliant physician queries, pre-service clearance.",
    note: "A leading query is refused rather than warned about, and generated options come from the axis, never from a guessed answer.",
    glyph: "◉",
    match: ["cdi_", "greenlight_check"],
  },
  {
    key: "review",
    label: "Coding Review Queue",
    blurb: "Suggested codes as proposals, with a decision log that is never rewritten.",
    note: "A reason is required to edit or reject, and corrections are recalled before the same code is suggested again.",
    glyph: "▦",
    match: ["review_", "code_suggest", "coding_corrections"],
  },
  {
    key: "compliance",
    label: "Compliance Rules",
    blurb: "Telehealth, global periods, incident-to, ABNs, regulation-as-code.",
    note: "Policy documents compile into draft scrub rules with the source paragraph attached, then go to a human.",
    glyph: "◫",
    match: ["telehealth_", "global_period_", "incident_to_check", "abn_generate", "policy_", "sentinel_"],
  },
  {
    key: "audit",
    label: "Audit & Integrity",
    blurb: "RAC/MAC tracking, appeal ladders, a hash-chained log, and PHI access records.",
    note: "The chain proves nothing was edited in place; an external anchor is what proves history was not rewritten wholesale. PHI access rows are cross-checked against the chain, because a forged log row is added rather than edited and the chain alone would still verify.",
    glyph: "⛓",
    match: ["audit_", "phi_access_"],
  },
  {
    key: "tenancy",
    label: "Tenant Isolation",
    blurb: "Which practice this session is bound to, and how that boundary is enforced.",
    note: "SQLite has no row-level security, so a tenant is a database file rather than a column. There is no tool to change tenant — the binding is made outside the conversation and nothing inside it can move.",
    glyph: "⬚",
    match: ["tenant_"],
  },
  {
    key: "cob",
    label: "Secondary & COB",
    blurb: "Payer order, MSP types, secondary 837 from the primary's raw 835.",
    note: "It refuses to emit while charge = paid + adjustments fails on any line, because that claim cannot balance.",
    glyph: "⇉",
    match: ["cob_", "claim_build_secondary"],
  },
  {
    key: "forecast",
    label: "Revenue Digital Twin",
    blurb: "Kaplan–Meier lag fitting, Monte Carlo cash forecasts, what-if scenarios.",
    note: "Unresolved claims enter as right-censored observations — dropping them selects for claims that paid fast and inflates near-term cash.",
    glyph: "◬",
    match: ["revenue_model_fit", "cash_forecast", "simulate_scenario", "forecast_", "patient_"],
  },
  {
    key: "vbc",
    label: "Value-Based Care",
    blurb: "HCC/RAF, recapture gaps, symmetric suspecting, quality measures.",
    note: "Suspecting looks both ways — documented-but-not-coded and coded-but-not-documented — from the same pass.",
    glyph: "◍",
    match: ["raf_calculate", "hcc_recapture", "suspect_", "quality_measures"],
  },
  {
    key: "transparency",
    label: "Price Transparency",
    blurb: "MRF/TiC ingest, market benchmarking, No Surprises Act IDR.",
    note: "Rates are segregated by negotiated type first: 250 means $250 under one and 250% of Medicare under another.",
    glyph: "◎",
    match: ["rate_", "negotiation_brief", "idr_"],
  },
  {
    key: "credit",
    label: "Credit Balances",
    blurb: "Overpayment ledger with the ACA 60-day report-and-return clock.",
    note: "The 60-day return clock and the §935 recoupment window share a number and are unrelated rules — kept apart deliberately.",
    glyph: "◒",
    match: ["credit_balance_"],
  },
  {
    key: "gfe",
    label: "Good Faith Estimates",
    blurb: "No Surprises Act estimates, variance checks and their deadlines.",
    note: "The clock runs in business days from scheduling, which is the part practices miss.",
    glyph: "◔",
    match: ["gfe_", "cost_estimate"],
  },
  {
    key: "credentialing",
    label: "Credentialing",
    blurb: "Enrollment, revalidation cycles, CAQH attestation windows.",
    note: "CAQH attestation expires every 120 days with no notice, and answers whether a provider could bill on a given date.",
    glyph: "◊",
    match: ["credentialing_"],
  },
  {
    key: "updates",
    label: "Code & Policy Currency",
    blurb: "Release calendars, code-set diffs, LCD/NCD change watch.",
    note: "Diffs are scoped to codes the practice actually bills, including codes that gained children and became non-billable headers.",
    glyph: "⟳",
    match: ["code_update_", "code_set_register", "policy_watch"],
  },
  {
    key: "swarm",
    label: "Autonomous Swarm",
    blurb: "A blackboard of claims in flight, advanced by role agents.",
    note: "Run caps count slots actually spent, so a board of paid claims cannot exhaust the budget having advanced nothing.",
    glyph: "⬡",
    match: ["swarm_"],
  },
  {
    key: "voice",
    label: "Voice & Telephony",
    blurb: "Payer calls, IVR navigation, consent gates, structured outcomes.",
    note: "All-party consent states are enforced before a recording starts, and intent picks the IVR option while the prompt confirms it.",
    glyph: "◖",
    match: ["payer_call_", "call_", "ivr_map_"],
  },
  {
    key: "portal",
    label: "Payer Portals",
    blurb: "Playwright automation for payers with no API, hard-gated.",
    note: "Every new domain and every form submission needs approval; credentials are typed by the tool layer and never shown to the model.",
    glyph: "◗",
    match: ["portal_"],
  },
  {
    key: "a2a",
    label: "Agent-to-Agent",
    blurb: "Structured claim negotiation with signed attestations.",
    note: "An agreement between two agents is not a payment determination, and a signature proves authorship rather than correctness.",
    glyph: "⬢",
    match: ["a2a_"],
  },
  {
    key: "training",
    label: "Coder Training",
    blurb: "Practice cases from the real case mix, scored for calibration.",
    note: "Confidence is scored beside accuracy, because the coder who costs money is the one who is wrong confidently.",
    glyph: "◓",
    match: ["training_"],
  },
  {
    key: "comms",
    label: "Channels & Reports",
    blurb: "Email intake and replies, scheduled workbook and PDF exports.",
    note: "Outbound mail is an approval-gated draft, like every other artifact that leaves the building.",
    glyph: "✉",
    match: ["email_", "report_generate"],
  },
  {
    key: "system",
    label: "Workspace & Catalogue",
    blurb: "Files, shell, fetch, and the tool catalogue itself.",
    note: "tool_invoke routes back through the same validation and approval gate as a direct call — a way to reach a tool, not around it.",
    glyph: "⌘",
    match: ["run_command", "read_file", "write_file", "list_dir", "web_fetch", "web_search", "tool_", "data_status"],
  },
];

const OTHER: ModuleDef = {
  key: "other",
  label: "Unfiled",
  blurb: "Tools that match no module yet.",
  note: "Anything here is a gap in the module map rather than a gap in the system.",
  glyph: "·",
  match: [],
};

export function moduleFor(toolName: string): ModuleDef {
  for (const m of MODULES) {
    if (m.match.some((p) => (p.endsWith("_") ? toolName.startsWith(p) : toolName === p))) return m;
  }
  return OTHER;
}

export interface ModuleView {
  key: string;
  label: string;
  blurb: string;
  note: string;
  glyph: string;
  tools: Array<{ name: string; summary: string; description: string }>;
}

function firstSentence(text: string): string {
  const at = text.search(/\.\s/);
  return at > 0 ? text.slice(0, at + 1) : text;
}

/** Group the live registry into modules. Empty modules are omitted. */
export function groupIntoModules(specs: ToolSpec[]): ModuleView[] {
  const byKey = new Map<string, ModuleView>();
  for (const spec of specs) {
    const m = moduleFor(spec.name);
    const view =
      byKey.get(m.key) ??
      ({ key: m.key, label: m.label, blurb: m.blurb, note: m.note, glyph: m.glyph, tools: [] } as ModuleView);
    view.tools.push({ name: spec.name, summary: firstSentence(spec.description), description: spec.description });
    byKey.set(m.key, view);
  }
  const order = [...MODULES.map((m) => m.key), OTHER.key];
  return [...byKey.values()]
    .map((v) => ({ ...v, tools: v.tools.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}
