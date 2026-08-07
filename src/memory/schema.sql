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
