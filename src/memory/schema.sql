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
