CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'anthropic',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content_json TEXT NOT NULL,
  stop_reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS worklist_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,             -- 'denial' | 'rejection' | 'prior_auth' | 'reminder' | 'audit' | 'compliance'
  title TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'in_progress' | 'done' | 'dismissed'
  priority REAL NOT NULL DEFAULT 0,
  due_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  session_id TEXT,
  prompt TEXT NOT NULL,
  run_at INTEGER,                 -- one-shot epoch ms
  interval_ms INTEGER,            -- recurring
  last_run_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  payer TEXT NOT NULL DEFAULT '',
  claim_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft|scrubbed|submitted|paid|denied|appealed
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS remittances (
  id TEXT PRIMARY KEY,
  payer TEXT NOT NULL DEFAULT '',
  era_json TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

-- Per-payer policy overrides (kind='telehealth' today). Payers diverge from
-- Medicare conventions, so the rules they are checked against are data, not code.
CREATE TABLE IF NOT EXISTS payer_policies (
  payer_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (payer_key, kind)
);

-- Procedures performed, so later claims can be checked against open global periods.
CREATE TABLE IF NOT EXISTS procedure_history (
  id TEXT PRIMARY KEY,
  patient_ref TEXT NOT NULL,
  code TEXT NOT NULL,
  service_date TEXT NOT NULL,
  global_days INTEGER,
  surgeon_npi TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_procedure_history_patient ON procedure_history(patient_ref, service_date);

-- Payer/contractor audits (RAC, MAC ADR, TPE, UPIC, SMRC, CERT, commercial).
-- Response and appeal windows are short and unforgiving, so the dates that drive
-- them are first-class columns rather than buried in a JSON blob.
CREATE TABLE IF NOT EXISTS audit_requests (
  id TEXT PRIMARY KEY,
  audit_type TEXT NOT NULL,           -- 'RAC' | 'MAC_ADR' | 'TPE' | 'UPIC' | 'SMRC' | 'CERT' | 'commercial' | 'OIG'
  contractor TEXT NOT NULL DEFAULT '',
  received_date TEXT NOT NULL,        -- YYYYMMDD
  response_due_date TEXT NOT NULL,    -- YYYYMMDD
  claim_refs_json TEXT NOT NULL DEFAULT '[]',
  amount_at_risk_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'received',
  determination_date TEXT,            -- YYYYMMDD, set when the decision arrives
  demand_letter_date TEXT,            -- YYYYMMDD, starts the recoupment clock
  appeal_level INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_requests_status ON audit_requests(status, response_due_date);

-- Overpayment / credit balance ledger. Amounts are integer CENTS: this is money
-- of record with a statutory 60-day return deadline, so no float drift.
CREATE TABLE IF NOT EXISTS credit_balances (
  id TEXT PRIMARY KEY,
  payer TEXT NOT NULL DEFAULT '',
  claim_id TEXT NOT NULL DEFAULT '',
  patient_ref TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  identified_date TEXT NOT NULL,      -- YYYYMMDD — starts the ACA 60-day clock
  reason TEXT NOT NULL,               -- 'duplicate_payment' | 'cob_primary_paid' | 'retroactive_termination' | 'billing_error' | 'payer_error' | 'patient_overpayment' | 'other'
  status TEXT NOT NULL DEFAULT 'identified',
  resolved_date TEXT,
  resolution TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_balances_status ON credit_balances(status, identified_date);

-- The swarm blackboard: every claim in flight, what stage it is at, and who owns
-- it. One row per claim, so there is a single answer to "where is this" rather
-- than a stage inferred from whichever table was written last.
CREATE TABLE IF NOT EXISTS blackboard (
  id TEXT PRIMARY KEY,
  claim_ref TEXT NOT NULL,
  payer TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,   -- attempts at the CURRENT stage; reset on a move
  last_error TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (claim_ref)
);

CREATE INDEX IF NOT EXISTS idx_blackboard_stage ON blackboard(stage, updated_at);

-- Every stage change, append-only. An autonomous pipeline that cannot say what
-- it did and who authorized it is not one anybody should run.
CREATE TABLE IF NOT EXISTS blackboard_events (
  id TEXT PRIMARY KEY,
  claim_ref TEXT NOT NULL,
  from_stage TEXT NOT NULL DEFAULT '',
  to_stage TEXT NOT NULL,
  actor TEXT NOT NULL,                   -- a role name, or the person who took it
  automated INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blackboard_events_claim ON blackboard_events(claim_ref, created_at);

-- Payer-twin predictions, kept so calibration is automatic. Without this a
-- prediction has to be re-typed by hand when the remittance arrives, which means
-- in practice it never is and the twin is never scored at all.
CREATE TABLE IF NOT EXISTS twin_predictions (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  payer TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL,              -- 'PAY' | 'PARTIAL' | 'DENY'
  confidence TEXT NOT NULL DEFAULT '',
  predicted_carcs_json TEXT NOT NULL DEFAULT '[]',
  rationale TEXT NOT NULL DEFAULT '',
  remediation TEXT NOT NULL DEFAULT '',
  gauntlet_id TEXT NOT NULL DEFAULT '',
  round INTEGER NOT NULL DEFAULT 1,
  claim_fingerprint TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_twin_predictions_claim ON twin_predictions(claim_id, created_at);

-- What calibration learned. Separate from the statistics so it stays visible
-- which lines are evidence about the payer and which are corrections to the twin.
CREATE TABLE IF NOT EXISTS twin_playbook_notes (
  id TEXT PRIMARY KEY,
  payer_key TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- 'miss' | 'over_call' | 'wrong_reason' | 'manual'
  note TEXT NOT NULL,
  source_claim_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (payer_key, source_claim_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_twin_notes_payer ON twin_playbook_notes(payer_key, created_at);

-- Everything the portal browser did, append-only. Automation signed in as the
-- practice should leave a record that does not depend on a chat transcript
-- surviving. Credentials are never written here.
CREATE TABLE IF NOT EXISTS portal_actions (
  id TEXT PRIMARY KEY,
  portal_key TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,               -- navigate | read | screenshot | click | fill | login | close
  target TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portal_actions_time ON portal_actions(created_at);

-- Payer correspondence pulled from the mailbox. A billing inbox is an unsorted
-- work queue with clocks already running inside it, so each message is stored
-- with what it was classified as and the dates it imposes. Bodies flagged as
-- possibly carrying PHI are held rather than stored, because this deployment is
-- not approved for real patient data.
CREATE TABLE IF NOT EXISTS inbound_mail (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,                  -- mailbox UID, for the poll watermark
  mailbox TEXT NOT NULL DEFAULT 'INBOX',
  sender TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',      -- empty when quarantined
  kind TEXT NOT NULL DEFAULT 'other',
  confidence REAL NOT NULL DEFAULT 0,
  route_to TEXT NOT NULL DEFAULT '',
  deadlines_json TEXT NOT NULL DEFAULT '[]',
  claim_refs_json TEXT NOT NULL DEFAULT '[]',
  amounts_json TEXT NOT NULL DEFAULT '[]',
  phi_json TEXT NOT NULL DEFAULT '[]',
  quarantined INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new', -- 'new' | 'routed' | 'dismissed'
  received_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (mailbox, uid)
);

CREATE INDEX IF NOT EXISTS idx_inbound_mail_status ON inbound_mail(status, received_at);

-- Per-mailbox poll state. UIDVALIDITY is tracked so a mailbox recreation/restore
-- (which resets IMAP UIDs to low numbers) is detected: without it the stale
-- high-water UID silently filtered out every fresh low-UID message forever.
CREATE TABLE IF NOT EXISTS mailbox_poll_state (
  mailbox TEXT PRIMARY KEY,
  uidvalidity TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- Outbound replies are drafted, approved, and only then sent. The draft is kept
-- so what was sent is recoverable independently of the mail server.
CREATE TABLE IF NOT EXISTS outbound_mail (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  in_reply_to TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'sent' | 'failed'
  message_id TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

-- AI-suggested codes awaiting a human decision. Code selection is the coder's
-- and provider's legal responsibility, so a suggestion is never a claim until
-- someone accepts it. Current state lives here; the decision history lives in
-- review_events, because "who approved this and why" is exactly what an auditor
-- asks and a mutable status column cannot answer it.
CREATE TABLE IF NOT EXISTS code_suggestions (
  id TEXT PRIMARY KEY,
  claim_ref TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,                  -- 'diagnosis' | 'procedure' | 'modifier'
  suggested_code TEXT NOT NULL,
  suggested_description TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  provenance TEXT NOT NULL DEFAULT '', -- the documentation that supports it
  confidence REAL,
  source TEXT NOT NULL DEFAULT '',     -- which tool or agent proposed it
  payer TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted' | 'edited' | 'rejected'
  final_code TEXT NOT NULL DEFAULT '',
  reviewer TEXT NOT NULL DEFAULT '',
  review_reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_code_suggestions_status ON code_suggestions(status, created_at);

-- Append-only decision log. Rows are never updated or deleted.
CREATE TABLE IF NOT EXISTS review_events (
  id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL,
  action TEXT NOT NULL,                -- 'suggested' | 'accepted' | 'edited' | 'rejected' | 'reopened'
  from_status TEXT NOT NULL DEFAULT '',
  to_status TEXT NOT NULL DEFAULT '',
  code_before TEXT NOT NULL DEFAULT '',
  code_after TEXT NOT NULL DEFAULT '',
  reviewer TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_events_suggestion ON review_events(suggestion_id, created_at);

-- What this practice's coders keep changing. Corrections are recalled before
-- suggesting codes so the same mistake is not proposed twice; they are surfaced
-- through a tool rather than folded into the system prompt, which is byte-stable
-- for prompt caching.
CREATE TABLE IF NOT EXISTS coding_corrections (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  suggested_code TEXT NOT NULL,
  corrected_code TEXT NOT NULL DEFAULT '',  -- empty when the suggestion was rejected outright
  payer_key TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  times_seen INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, suggested_code, corrected_code, payer_key)
);

CREATE INDEX IF NOT EXISTS idx_coding_corrections_lookup ON coding_corrections(kind, suggested_code);

-- Provider enrollment per payer. A lapsed credential is not fixable afterwards —
-- claims for services furnished while unenrolled deny as provider-not-eligible
-- and no appeal recovers them — so the dates that drive it are columns.
CREATE TABLE IF NOT EXISTS credentialing (
  id TEXT PRIMARY KEY,
  provider_npi TEXT NOT NULL,
  provider_name TEXT NOT NULL DEFAULT '',
  payer TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'commercial',  -- 'medicare' | 'medicare_dmepos' | 'medicaid' | 'commercial'
  status TEXT NOT NULL DEFAULT 'not_started',
  effective_date TEXT NOT NULL DEFAULT '',  -- YYYYMMDD
  revalidation_due TEXT NOT NULL DEFAULT '',
  caqh_attested_on TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (provider_npi, payer)
);

CREATE INDEX IF NOT EXISTS idx_credentialing_due ON credentialing(status, revalidation_due);

-- Evidence that a claim was received by the payer, banked when acknowledgments
-- are parsed rather than hunted for months later. A timely-filing denial is
-- winnable only with an ACCEPTANCE report — a submission log shows you sent a
-- claim, an acknowledgment shows the payer received it, and only the second is
-- proof. The 277CA is the cleanest source.
-- ── Contracted rates ────────────────────────────────────────────────────────
-- What a payer agreed to allow, per code, from the practice's own signed
-- contract. This is the only basis on which "underpaid" is a contractual claim
-- rather than an observation; payment_variance's other two bases compare against
-- Medicare or against the payer's own habit, neither of which the payer owes.
--
-- Rates are dated because fee schedules are amended, and an amendment is
-- normally the reason a payment changed. A rate with no effective date would
-- silently apply the new schedule to old claims and report every one of them as
-- correct — or as underpaid, depending on which direction the amendment went.
CREATE TABLE IF NOT EXISTS contract_rates (
  id             TEXT PRIMARY KEY,
  payer_key      TEXT NOT NULL,        -- normalized payer name
  payer          TEXT NOT NULL,
  code           TEXT NOT NULL,
  modifier       TEXT NOT NULL DEFAULT '',   -- '' means the base rate
  allowed        REAL NOT NULL,        -- contracted allowed amount per unit
  effective_from TEXT NOT NULL,        -- YYYYMMDD
  effective_to   TEXT NOT NULL DEFAULT '',   -- '' = still in force
  source         TEXT NOT NULL DEFAULT '',   -- where this came from; an unsourced rate is hearsay
  created_at     INTEGER NOT NULL,
  UNIQUE (payer_key, code, modifier, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_contract_rates_lookup ON contract_rates(payer_key, code);

-- ── Tool call log ───────────────────────────────────────────────────────────
-- One row per tool invocation, so a support engineer can ask what failed rather
-- than having to bring the errors with them.
--
-- input_shape holds KEY NAMES ONLY, never values. Tool input carries claim data,
-- and a log that stored it would become the largest copy of that data in the
-- system, with weaker access control than the tables it copied from, sitting
-- there whether or not anyone ever reads it. The shape is enough to see that a
-- call was malformed.
--
-- error_text IS stored, scrubbed of identifier shapes. It is what the classifier
-- reads and cannot be reduced without destroying its use. Scrubbed rather than
-- refused — unlike phi_access_log, where a caller passing an identifier has a
-- bug worth surfacing; here the string came from a library and nobody chose it.
--
-- Retention is part of the design: this is the only table that grows with every
-- action forever, and a log that fills the disk is its own incident.
CREATE TABLE IF NOT EXISTS tool_calls (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL DEFAULT '',
  tool_name   TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  outcome     TEXT NOT NULL,       -- ok | invalid_input | unknown_tool | denied | error
  duration_ms INTEGER NOT NULL DEFAULT 0,
  input_shape TEXT NOT NULL DEFAULT '',
  error_text  TEXT NOT NULL DEFAULT '',
  -- 0 for a call the model made directly, 1+ for one reached through tool_invoke.
  -- One logical call through the catalogue produces two rows and both are true;
  -- the depth is what lets the summary avoid counting the failure twice.
  depth       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_at ON tool_calls(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_calls_failures ON tool_calls(ok, created_at DESC);

-- ── Ops baselines ───────────────────────────────────────────────────────────
-- Small key/value store for the operational sweeps: dataset hashes recorded at
-- install time, so the next sweep can report what changed. Deliberately not a
-- cache — nothing here is derivable, which is the point. A hash you did not
-- record cannot tell you a file changed behind your back.
CREATE TABLE IF NOT EXISTS ops_baseline (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ── Structured tool views ───────────────────────────────────────────────────
-- Rendered payloads for the web UI, keyed by the tool call that produced them.
--
-- A SEPARATE TABLE, deliberately. The runner rebuilds the model's context by
-- replaying `messages.content_json` verbatim, so anything stored there is sent
-- to the provider on every subsequent turn. A rendered claim form is thousands
-- of tokens of JSON restating what the tool's text already said — storing it
-- alongside the message would silently double the cost of every tool call that
-- draws something. Here it is reachable by the browser and unreachable by the
-- model, which is exactly the split that makes rich rendering free.
CREATE TABLE IF NOT EXISTS tool_views (
  session_id  TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  data_json   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, tool_use_id)
);
CREATE INDEX IF NOT EXISTS idx_tool_views_session ON tool_views(session_id, created_at);

CREATE TABLE IF NOT EXISTS filing_proof (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  accepted_on TEXT NOT NULL,          -- YYYYMMDD the payer acknowledged receipt
  payer TEXT NOT NULL DEFAULT '',
  payer_claim_number TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',    -- e.g. '277CA acknowledgment'
  recorded_at INTEGER NOT NULL,
  UNIQUE (claim_id, accepted_on, source)
);

CREATE INDEX IF NOT EXISTS idx_filing_proof_claim ON filing_proof(claim_id);

-- Which edition of each code set is installed locally, so staleness is a fact
-- rather than a guess. One row per code set; re-registering replaces it.
CREATE TABLE IF NOT EXISTS code_set_versions (
  code_set TEXT PRIMARY KEY,          -- 'icd10cm' | 'icd10pcs' | 'hcpcs' | 'hcpcs_drug' | 'ncci' | 'cpt' | 'mpfs'
  effective_date TEXT NOT NULL,       -- YYYYMMDD the installed edition took effect
  label TEXT NOT NULL DEFAULT '',
  code_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  installed_at INTEGER NOT NULL
);

-- Coverage policy changes already surfaced to the user. The UNIQUE constraint is
-- what makes policy_watch a watch rather than a report: a document version is
-- announced once, so re-running it shows only what has moved since.
CREATE TABLE IF NOT EXISTS policy_alerts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                -- 'national' | 'local'
  document_id TEXT NOT NULL,
  document_version TEXT NOT NULL DEFAULT '',
  display_id TEXT NOT NULL DEFAULT '',
  document_type TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  change_note TEXT NOT NULL DEFAULT '',
  contractor TEXT NOT NULL DEFAULT '',
  updated_on TEXT NOT NULL DEFAULT '',
  effective_date TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  seen_at INTEGER NOT NULL,
  UNIQUE (scope, document_id, document_version)
);

-- ── Regulation as code ──────────────────────────────────────────────────────
-- Scrub rules drafted from policy documents. A rule carries the paragraph it
-- came from: without it the rule cannot be re-checked when the policy is
-- revised, and cannot be defended when a payer asks why you billed this way.
-- Rules are inert until a person moves them to 'active'.
CREATE TABLE IF NOT EXISTS policy_rules (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  codes_json TEXT NOT NULL DEFAULT '[]',
  diagnoses_json TEXT NOT NULL DEFAULT '[]',
  modifiers_json TEXT NOT NULL DEFAULT '[]',
  pos_json TEXT NOT NULL DEFAULT '[]',
  max_units INTEGER NOT NULL DEFAULT 0,
  period TEXT NOT NULL DEFAULT 'claim',
  severity TEXT NOT NULL DEFAULT 'warning',
  message TEXT NOT NULL DEFAULT '',
  payer TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'active' | 'rejected' | 'retired'
  source_document TEXT NOT NULL DEFAULT '',
  source_citation TEXT NOT NULL DEFAULT '',
  source_quote TEXT NOT NULL DEFAULT '',
  source_effective TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  reviewer TEXT NOT NULL DEFAULT '',
  review_reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_policy_rules_status ON policy_rules(status);

-- Self-audit runs. The seed is stored because a sample nobody can redraw is not
-- a defensible audit — a contractor asks how the sample was drawn.
CREATE TABLE IF NOT EXISTS sentinel_runs (
  id TEXT PRIMARY KEY,
  seed INTEGER NOT NULL,
  population_size INTEGER NOT NULL,
  sample_size INTEGER NOT NULL,
  claims_in_error INTEGER NOT NULL,
  error_rate REAL NOT NULL,
  lower_bound REAL NOT NULL,
  upper_bound REAL NOT NULL,
  conservative_bound REAL NOT NULL,
  report TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- ── Tamper-evident audit log ────────────────────────────────────────────────
-- Append-only, each entry carrying the hash of the one before it. Tamper-EVIDENT
-- and not tamper-proof: anyone who can write to this file can rewrite the chain
-- consistently. The anchors table is what closes that gap.
CREATE TABLE IF NOT EXISTS audit_chain (
  seq INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  payload_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Head hashes published somewhere outside this database. Verification checks the
-- recomputed chain against these, which is what catches a consistent rewrite.
CREATE TABLE IF NOT EXISTS audit_anchors (
  seq INTEGER PRIMARY KEY,
  hash TEXT NOT NULL,
  published_to TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ── PHI access log (45 CFR §164.312(b)) ─────────────────────────────────────
-- Lives in the TENANT's database, so it inherits the same isolation as the data
-- it describes: there is no cross-tenant access log to leak, and a tenant's log
-- cannot be read from another tenant's connection.
--
-- Every column here is a pointer or a fact about the act. There is deliberately
-- no column for a patient name, an identifier, or a free-text reason, because a
-- log about PHI that stores PHI is a second copy of the record with weaker
-- access control than the first — compliance staff can read the logs.
--
-- READ is recorded, not just writes. The characteristic HIPAA incident is a
-- person with valid credentials looking at a record they had no business
-- looking at, and that leaves no trace at all in a mutation log.
CREATE TABLE IF NOT EXISTS phi_access_log (
  id            TEXT PRIMARY KEY,
  action        TEXT NOT NULL,        -- read | write | export | print | delete | amend
  resource_type TEXT NOT NULL,
  resource_ref  TEXT NOT NULL,        -- internal id ONLY; validated against identifier shapes on write
  actor         TEXT NOT NULL,
  tenant_slug   TEXT NOT NULL,
  source_address TEXT NOT NULL DEFAULT '',
  record_count  INTEGER NOT NULL DEFAULT 1,
  -- seq of the audit_chain entry this event was anchored into, so the log row
  -- and the tamper-evident chain cannot drift apart silently.
  chain_seq     INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phi_access_at ON phi_access_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phi_access_actor ON phi_access_log(actor, created_at DESC);

-- ── Practice revenue digital twin ───────────────────────────────────────────
-- Patient balances, for propensity scoring and outreach planning.
--
-- The columns are deliberately limited to what an ACCOUNT has done: payments
-- made, plans kept or broken, how old the balance is, how large. There is no
-- column for age, sex, race, ZIP, language or credit data, and none should be
-- added — scoring people on those is a discrimination engine wearing a revenue
-- cycle hat, and a schema that cannot hold them cannot be talked into it.
CREATE TABLE IF NOT EXISTS patient_accounts (
  patient_ref TEXT PRIMARY KEY,       -- de-identified; never a name or member ID
  balance_cents INTEGER NOT NULL DEFAULT 0,
  balance_since TEXT NOT NULL DEFAULT '',   -- YYYYMMDD the balance became the patient's
  insurance_adjudicated INTEGER NOT NULL DEFAULT 1,
  prior_payments INTEGER NOT NULL DEFAULT 0,
  prior_paid_cents INTEGER NOT NULL DEFAULT 0,
  broken_plans INTEGER NOT NULL DEFAULT 0,
  on_payment_plan INTEGER NOT NULL DEFAULT 0,
  financial_assistance_screened INTEGER NOT NULL DEFAULT 0,
  statements_sent INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Forecast runs, so a projection can be compared against what actually arrived.
-- The seed is stored for the same reason the sentinel stores one: a simulation
-- nobody can reproduce is an anecdote.
CREATE TABLE IF NOT EXISTS forecast_runs (
  id TEXT PRIMARY KEY,
  scenario TEXT NOT NULL DEFAULT 'baseline',
  scenario_json TEXT NOT NULL DEFAULT '{}',
  horizon_days INTEGER NOT NULL,
  paths INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  p10_cents INTEGER NOT NULL DEFAULT 0,
  p50_cents INTEGER NOT NULL DEFAULT 0,
  p90_cents INTEGER NOT NULL DEFAULT 0,
  report TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- ── Voice and telephony ─────────────────────────────────────────────────────
-- Payer calls. The reference number column is the reason this table exists: a
-- phone call is deniable six months later and "we have no record of that call"
-- is the standard answer to an appeal that rests on one.
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'simulator',
  payer TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT 'payer',   -- payer | clearinghouse | provider_office
  to_number TEXT NOT NULL DEFAULT '',
  caller_state TEXT NOT NULL DEFAULT '',
  callee_state TEXT NOT NULL DEFAULT '',
  recording INTEGER NOT NULL DEFAULT 0,
  consent_note TEXT NOT NULL DEFAULT '',
  claim_ref TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'dialing',
  reference_number TEXT NOT NULL DEFAULT '',
  representative TEXT NOT NULL DEFAULT '',
  disposition TEXT NOT NULL DEFAULT '',
  outcome_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_calls_claim ON calls(claim_ref);

-- Every segment heard and every action taken, append-only. A call nobody can
-- replay is a call that happened only in somebody's memory of it.
CREATE TABLE IF NOT EXISTS call_events (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- heard | said | pressed | state | note
  text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_call_events_call ON call_events(call_id, at_ms);

-- Learned phone trees. Menus change without notice, so misses are counted and a
-- map that keeps missing is reported as stale rather than pressed blindly.
CREATE TABLE IF NOT EXISTS ivr_maps (
  payer TEXT NOT NULL,
  level TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  last_confirmed_at INTEGER NOT NULL DEFAULT 0,
  misses INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (payer, level)
);

-- ── Value-based care ────────────────────────────────────────────────────────
-- Suspect conditions awaiting a coder's decision. Deliberately a separate table
-- from coding_suggestions so a risk-adjustment proposal carries its own extra
-- burden: the HCC it would add, the documentation quote, and which of
-- Monitor/Evaluate/Assess/Treat the note actually supports.
--
-- The direction column is what keeps this honest. A review that can only ever
-- propose 'add' is an upcoding engine; 'remove' rows are the ones that prove it
-- looked both ways.
CREATE TABLE IF NOT EXISTS vbc_suspects (
  id TEXT PRIMARY KEY,
  patient_ref TEXT NOT NULL,
  year INTEGER NOT NULL,
  direction TEXT NOT NULL,            -- 'add' | 'remove' | 'mention_only'
  hcc TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  coefficient REAL NOT NULL DEFAULT 0,
  suggested_code TEXT NOT NULL DEFAULT '',
  quote TEXT NOT NULL DEFAULT '',
  meat TEXT NOT NULL DEFAULT '',      -- comma-separated categories supported
  source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected
  reviewer TEXT NOT NULL DEFAULT '',
  review_reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vbc_suspects_status ON vbc_suspects(status, year);

-- ── Price transparency ──────────────────────────────────────────────────────
-- Rates mined from payer Transparency in Coverage files and hospital
-- machine-readable files, filtered during ingest to the codes this practice
-- actually bills. The source files are tens of gigabytes; these tables hold the
-- few thousand rows that matter.
--
-- negotiated_type is carried rather than normalized away because it decides what
-- the number MEANS: a rate of 250 is $250 under 'negotiated' and 250% of
-- Medicare under 'percentage', and a query that averaged them would return
-- something plausible and wrong.
CREATE TABLE IF NOT EXISTS market_rates (
  id TEXT PRIMARY KEY,
  billing_code TEXT NOT NULL,
  billing_code_type TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  negotiated_type TEXT NOT NULL DEFAULT 'negotiated',
  billing_class TEXT NOT NULL DEFAULT 'professional',
  rate REAL NOT NULL,
  service_codes TEXT NOT NULL DEFAULT '',
  expiration_date TEXT NOT NULL DEFAULT '',
  provider_ref TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  ingested_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_market_rates_code ON market_rates(billing_code, negotiated_type, billing_class);

-- Federal IDR disputes. The dates are all business-day computed, which is where
-- these get missed: a 30-business-day window is six calendar weeks.
CREATE TABLE IF NOT EXISTS idr_disputes (
  id TEXT PRIMARY KEY,
  payer TEXT NOT NULL DEFAULT '',
  claim_refs TEXT NOT NULL DEFAULT '',
  line_items INTEGER NOT NULL DEFAULT 1,
  amount_in_dispute_cents INTEGER NOT NULL DEFAULT 0,
  offer_cents INTEGER NOT NULL DEFAULT 0,
  initial_payment_on TEXT NOT NULL DEFAULT '',
  open_negotiation_ends TEXT NOT NULL DEFAULT '',
  initiation_opens TEXT NOT NULL DEFAULT '',
  initiation_closes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open_negotiation',
  outcome TEXT NOT NULL DEFAULT '',
  determination_on TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ── Prior authorization (Da Vinci CRD / DTR / PAS) ───────────────────────────
-- The local PA rule table. Most of the value in coverage-requirements discovery
-- is knowing which codes a payer requires authorization for, and a practice can
-- build that list from its own denials without any payer endpoint at all.
CREATE TABLE IF NOT EXISTS pa_rules (
  id TEXT PRIMARY KEY,
  payer TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL,
  requirement TEXT NOT NULL DEFAULT 'unknown',
  condition TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  UNIQUE (payer, code)
);

CREATE TABLE IF NOT EXISTS pa_questionnaires (
  id TEXT PRIMARY KEY,
  payer TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  items_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

-- A prefill is stored unsubmitted on purpose. The whole hazard of DTR is a form
-- whose answers appeared on their own and were signed unread, so the reviewed
-- state is a distinct row rather than a flag on the request.
CREATE TABLE IF NOT EXISTS pa_prefills (
  id TEXT PRIMARY KEY,
  questionnaire_id TEXT NOT NULL,
  patient_ref TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- received_at is the payer's receipt, not our submission: the CMS-0057-F
-- decision clock runs from receipt, and treating the two as the same quietly
-- gives away however long the transport took.
CREATE TABLE IF NOT EXISTS pa_requests (
  id TEXT PRIMARY KEY,
  payer TEXT NOT NULL DEFAULT '',
  patient_ref TEXT NOT NULL DEFAULT '',
  urgency TEXT NOT NULL DEFAULT 'standard',
  codes TEXT NOT NULL DEFAULT '',
  request_json TEXT NOT NULL DEFAULT '{}',
  bundle_json TEXT NOT NULL DEFAULT '{}',
  submitted_at INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'pending',
  auth_number TEXT NOT NULL DEFAULT '',
  response_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ── Agent-to-agent ───────────────────────────────────────────────────────────
-- The private key sits in this file unencrypted, and that is worth saying out
-- loud rather than burying: the key is exactly as protected as the database
-- file's permissions. It signs assertions about claims, not payments, so the
-- blast radius of a stolen key is forged statements rather than moved money —
-- but forged statements attributed to this practice are not a small thing.
CREATE TABLE IF NOT EXISTS a2a_keys (
  signer_id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  private_key_pem TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS a2a_attestations (
  id TEXT PRIMARY KEY,
  signer_id TEXT NOT NULL DEFAULT '',
  key_id TEXT NOT NULL DEFAULT '',
  claim_id TEXT NOT NULL DEFAULT '',
  audit_seq INTEGER NOT NULL DEFAULT 0,
  attestation_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS a2a_negotiations (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL DEFAULT '',
  payer TEXT NOT NULL DEFAULT '',
  billed_cents INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'presented',
  negotiation_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ── Clinical documentation integrity ─────────────────────────────────────────
-- Specificity rules are data so a practice can read and edit every one. A rule
-- nobody can inspect is a rule nobody can defend when asked why a query went
-- out.
CREATE TABLE IF NOT EXISTS cdi_rules (
  id TEXT PRIMARY KEY,
  triggers TEXT NOT NULL DEFAULT '[]',
  dimension TEXT NOT NULL,
  needs TEXT NOT NULL DEFAULT '',
  unspecified_code TEXT NOT NULL DEFAULT '',
  affects_risk INTEGER NOT NULL DEFAULT 0,
  options_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

-- Queries are kept whether or not they were answered, and the compliance check
-- that let each one out is stored with it. "Was this query leading?" is a
-- question asked years later, by someone who was not there.
CREATE TABLE IF NOT EXISTS cdi_queries (
  id TEXT PRIMARY KEY,
  patient_ref TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'multiple_choice',
  query_json TEXT NOT NULL DEFAULT '{}',
  check_json TEXT NOT NULL DEFAULT '{}',
  finding_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  response TEXT NOT NULL DEFAULT '',
  responded_by TEXT NOT NULL DEFAULT '',
  -- Superseded answers, kept. A record showing only the final response is what
  -- re-querying until the provider agrees looks like from the outside.
  history_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ── Coder training ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS training_cases (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL DEFAULT '',
  difficulty INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'diagnosis',
  case_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'synthetic',
  created_at INTEGER NOT NULL
);

-- confidence is stored with every attempt because accuracy alone cannot tell a
-- coder who knows what they do not know from one who does not.
CREATE TABLE IF NOT EXISTS training_attempts (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  learner TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.5,
  verdict TEXT NOT NULL DEFAULT '',
  credit REAL NOT NULL DEFAULT 0,
  explanation TEXT NOT NULL DEFAULT '',
  answered_at INTEGER NOT NULL
);

-- Appeal outcomes. Without these, appeal_triage cannot estimate a win rate and
-- says so rather than guessing — which is the correct behaviour on day one and
-- the reason this table is worth filling in.
--
-- `appealed` is separate from `overturned` on purpose: the denominator of a win
-- rate is appeals FILED, not denials received. Counting never-appealed denials
-- as losses drives every rate toward zero and produces a tool that recommends
-- never appealing, which is self-fulfilling.
CREATE TABLE IF NOT EXISTS appeal_outcomes (
  id           TEXT PRIMARY KEY,
  claim_id     TEXT NOT NULL,
  payer        TEXT NOT NULL,
  carc         TEXT NOT NULL,
  appealed     INTEGER NOT NULL DEFAULT 1,
  overturned   INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  note         TEXT NOT NULL DEFAULT '',
  decided_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appeal_outcomes_lookup ON appeal_outcomes(payer, carc, decided_at);

-- ── Uploaded documents ──────────────────────────────────────────────────────
-- Text extracted from a file somebody uploaded: an EOB, a denial letter, a
-- remittance spreadsheet.
--
-- THIS TABLE HOLDS DOCUMENT CONTENT, which is a different thing from every
-- other table here. The rest of the schema holds claim structure, codes and
-- de-identified references; this holds whatever was in the file, and what is in
-- a payer's EOB is a member id, a name and a diagnosis. It is stored because
-- the deployment chose to store it, and everything that follows from that
-- choice is why the columns below exist.
--
--   `phi_json` records what the identifier scan found at ingest, so a later
--   question about exposure is answered from the record rather than by
--   re-scanning and hoping the patterns have not changed.
--
--   `sha256` is over the ORIGINAL bytes, so the same document uploaded twice is
--   recognisable as one document rather than two.
--
--   Reads go through the PHI access log — see src/tenancy/access-log.ts. A
--   table of document text with no read trail is the exact thing §164.312(b)
--   exists to prevent.
--
-- Retention is a decision, not a default: `orion documents purge` exists
-- because a store of document content with no way to empty it is a liability
-- that only grows.
CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL DEFAULT '',
  filename    TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- pdf | docx | xlsx | csv | text | image | x12 | unknown
  size_bytes  INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  -- Empty when the file could not be read; `refusal` then says why.
  text        TEXT NOT NULL DEFAULT '',
  sections_json TEXT NOT NULL DEFAULT '[]',
  readable    INTEGER NOT NULL DEFAULT 0,
  refusal     TEXT NOT NULL DEFAULT '',
  confidence  REAL NOT NULL DEFAULT 0,
  phi_json    TEXT NOT NULL DEFAULT '[]',
  notes_json  TEXT NOT NULL DEFAULT '[]',
  -- Which uploaded archive this document came out of, '' for a direct upload.
  -- Added after the table shipped, so MemoryStore also back-fills it on open —
  -- see addColumnIfMissing(); a column added to a CREATE TABLE IF NOT EXISTS
  -- never reaches a database that already has the table.
  archive_id  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_session ON documents(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_sha ON documents(sha256);

-- ── Uploaded archives ────────────────────────────────────────────────────────
-- The first job/progress table in this system. A .zip of EOBs expands to many
-- documents, and OCR makes that slow enough that the upload cannot answer in
-- one request — so the work runs in the background and this row is what the
-- console polls and what `document_archive_list` reports.
--
-- The documents themselves still live in `documents` and nowhere else: the
-- README states that nothing but the upload path writes document text, and an
-- archive is the upload path.
CREATE TABLE IF NOT EXISTS document_archives (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL DEFAULT '',
  filename     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'processing',  -- processing | completed | failed
  total        INTEGER NOT NULL DEFAULT 0,
  processed    INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  ocr_count    INTEGER NOT NULL DEFAULT 0,
  -- Entries the ZIP reader could not decode at all, with the reason. Kept
  -- because a file silently missing from a 40-file batch is one the operator
  -- believes was processed.
  skipped_json TEXT NOT NULL DEFAULT '[]',
  notes_json   TEXT NOT NULL DEFAULT '[]',
  error        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_archives_session ON document_archives(session_id, created_at DESC);
-- NOTE: the index on documents(archive_id) is created in MemoryStore.migrate(),
-- not here. On a database that predates the column, this file runs BEFORE the
-- back-fill, so an index over archive_id fails with "no such column" and the
-- store will not open at all. Measured, not theorised.

-- ── Compaction records ──────────────────────────────────────────────────────
-- One row per time a session's history was folded down to fit the context
-- window. Kept rather than discarded for two reasons that pull in the same
-- direction: the agent replays them so a twice-compacted session does not
-- forget its first hour, and an operator asking "why did it not know that"
-- gets an answer instead of a shrug.
--
-- `facts_json` is the structured extraction; `summary` is the rendered text
-- actually put in front of the model. Both, because the rendering will change
-- and the facts should not have to be re-derived from prose when it does.
CREATE TABLE IF NOT EXISTS session_summaries (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  summary       TEXT NOT NULL,
  facts_json    TEXT NOT NULL DEFAULT '{}',
  dropped_count INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_session_summaries ON session_summaries(session_id, seq);

-- ── Job queue ───────────────────────────────────────────────────────────────
-- One row per unit of deferred work. SQLite rather than Redis, and one consumer
-- rather than many — see src/jobs/queue.ts for the tradeoff and the limit that
-- buys.
--
-- dedupe_key is UNIQUE, and that constraint is the whole idempotency story: a
-- second enqueue of the same work collides at the database instead of relying on
-- the caller to check first, which is a check that races.
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed | dead
  attempts    INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  run_after   INTEGER NOT NULL DEFAULT 0,
  -- Set while a worker holds the job. An expired lease means the worker died,
  -- which is not the same fact as the work having failed.
  lease_until INTEGER NOT NULL DEFAULT 0,
  dedupe_key  TEXT NOT NULL UNIQUE,
  last_error  TEXT NOT NULL DEFAULT '',
  session_id  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_runnable ON jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id, created_at DESC);
