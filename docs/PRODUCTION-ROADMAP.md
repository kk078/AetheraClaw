# ORION production readiness — audit and plan

This is Phase 0. It exists to be argued with before any of it is built, because
several of the phases below are one-way doors and one of them (Phase 2) puts
this software between a practice and its money.

Nothing here claims ORION is production ready. It says what "production ready"
would have to mean, what is already true, and what is not.

---

## The honest current state

ORION today is a **complete RCM reasoning engine with no connection to the
outside world.** It parses X12, computes NCCI/MUE/E-M/COB verdicts from tested
pure functions, tracks denials and appeals, and refuses to invent regulatory
facts. What it does not do is talk to a payer, hold real PHI, or run work that
outlives a single agent turn.

| Area | What exists | What is missing for production |
|---|---|---|
| **PHI** | `detectPhi` (in `src/channels/email/classify.ts`), `src/config/posture.ts` gating ingress `blocked`/`permitted`, `phi_access_log` with hash-chained audit, `src/speech/transcript-gate.ts` | No `phiMode` distinct from the ingress posture; detection lives in the email module rather than as a shared concern; no encryption at rest; no retention enforcement; chat input is not screened before persistence |
| **Payer connectivity** | `x12/{276,277ca,835,837,837-cob,segments}.ts` — real parsers and builders; `eligibility.ts` with a simulated path | **No network connector at all.** Nothing has ever been sent to a clearinghouse. 270/271, 276/277, 837P submit and 835 poll are all local-only |
| **Agent reliability** | `selectTools` + profiles; `src/eval/{cases,run}.ts` routing eval | 163 of 227 tools are deferred behind `tool_search`; no intent router; context compaction is drop-oldest; no correctness eval |
| **Reference data** | `datasets.ts`, `reference-store.ts`, `scripts/` fetchers, `data_status` | No scheduled refresh, no staleness warning, no per-profile required-dataset check |
| **UI** | Dashboard, console, modules, providers, workbench shell | No analytics, forecast or swarm pages — the backend tools exist and have no surface |
| **Scale** | Single gateway process, one SQLite writer | No job queue; long work blocks a turn; no WAL; no `SQLITE_BUSY` retry |
| **Security** | `src/gateway/auth.ts` fail-closed off loopback; approval gates; registry redaction | Gateway *refuses requests* without a token but still *starts*; no rate limit; no CSP; shell/fs not hardened per-mode |
| **Ops** | Startup diagnostics, `data_status`, FMEA tools | No metrics endpoint, no structured logs, no runbook |

**Two things are true at once and both matter:** the parts that decide clinical
and financial questions are unusually well tested (2,648 tests, dual driver),
and the parts that would carry a real practice's data and money do not exist
yet. This plan is about the second half only.

---

## What "production ready" is not

Stating this because the phrase invites drift:

- Not "the tests pass". They pass now.
- Not "it is deployed". It is deployed now, publicly, with synthetic data.
- Not "the BAA is signed". A BAA is a precondition for holding PHI, not
  evidence the software handles it correctly.

**Production ready means a billing practice can put a real patient's claim
through it, get paid, and be able to prove afterwards what happened.** Every
phase below is scored against that sentence.

---

## Architecture decisions, with the tradeoff stated

### D1 — `phiMode` is separate from `posture`, and both survive

`src/config/posture.ts` already answers "may this deployment *store* PHI".
`phiMode` answers "how does this deployment *behave* around PHI" — screening
chat, requiring per-file acknowledgment, switching the system prompt.

*Alternative rejected:* folding them into one setting. They fail differently.
Posture is a legal fact about the deployment; mode is an operational stance.
Collapsing them means the day the BAA is signed, one edit silently changes
half a dozen behaviours nobody reviewed.

### D2 — PHI detection moves to `src/compliance/phi-detect.ts`

`detectPhi` living in `src/channels/email/classify.ts` is an accident of the
order things were built. It is now called from ingest, voice, browser policy and
speech — six modules importing a function from the email classifier.

*Migration:* new module owns the patterns; `classify.ts` re-exports for one
release so nothing breaks; callers move file by file.

*Tradeoff:* production mode wants **conservative** detection — prefer false
positives. A false positive costs an operator one acknowledgment click. A false
negative writes an SSN into a database that was promised not to hold one.

### D3 — One clearinghouse connector behind an interface, mock stays the default

*Chosen:* Stedi or Claim.MD first (documented X12 APIs, real sandboxes).
Availity's enrollment path is slower and would gate the whole phase.

*Tradeoff, stated plainly:* this is the phase that can lose money. A submitted
837 is not reversible by a code change. Therefore: `clearinghouse: "mock"` stays
the default forever, sandbox is a separate axis from the connector choice, the
UI carries a permanent banner while in sandbox, and **no submit path bypasses
the existing approval gate** regardless of mode.

*Never:* writing a simulated status onto a claim record. `x12/276.ts` already
documents this; Phase 2 enforces it everywhere.

### D4 — Job queue in SQLite, single consumer, inside the gateway

*Alternative rejected:* Redis/BullMQ. It adds a second stateful service to a
product whose main operational virtue is that it is one process and one file.

*Tradeoff:* one worker means throughput is bounded by that worker. Acceptable
for a billing team; documented as the limit it is. WAL plus bounded `SQLITE_BUSY`
retry covers concurrent reads.

### D5 — Multi-tenant stays database-per-tenant

Unchanged and not up for discussion in this plan. Row-level `tenant_id` in a
shared database is one missing `WHERE` clause away from cross-tenant PHI
disclosure. A separate file cannot leak that way.

*Cost accepted:* cross-tenant reporting must open each database sequentially,
read-only. `orion tenants report` will say so rather than pretend otherwise.

### D6 — EHR/FHIR is a seam in v1, not an integration

A real Epic or Cerner integration is a procurement exercise, not a sprint. Build
`EhrConnector` plus one SMART-on-FHIR reference implementation against the
public HAPI server. Anything more is scope that cannot be finished honestly.

---

## Migration path for existing installs

Every existing `~/.orion` (and pre-rename `~/.aetheraclaw`) install must keep
working untouched. The rules:

1. **Every new config key defaults to today's behaviour.** `phiMode: "education"`,
   `clearinghouse: "mock"`, `swarm.mode: "supervised"`. Upgrading and changing
   nothing changes nothing.
2. **Schema changes are additive.** New tables (`jobs`, `session_summaries`,
   `swarm_runs`, email quarantine); no destructive column changes. The existing
   `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` pattern continues.
3. **The legacy directory notice stays.** `src/config/legacy.ts` already handles
   an install that predates the rename; nothing in this plan may break it.
4. **No WS protocol break without a version bump.** `protocolVersion` in the
   handshake, and the server serves the older shape for one release.

---

## Feature flags

| Key | Default | Turns on |
|---|---|---|
| `healthcare.phiMode` | `"education"` | Chat PHI gate, per-file upload ack, production prompt |
| `healthcare.clearinghouse` | `"mock"` | Real connector selection |
| `healthcare.clearinghouseEnv` | `"sandbox"` | Production endpoints (with banner logic inverted) |
| `ORION_ENCRYPTION_KEY` | unset | Document text encryption at rest |
| `swarm.mode` | `"supervised"` | Stage auto-advance (never submit/appeal/refund) |
| `healthcare.voiceEnabled` | `false` | Outbound telephony tools |
| `jobs.enabled` | `true` | Async execution of long operations |

**Two combinations are refused rather than warned about**, following the
`PUBLIC_ACCESS` + `ORION_PHI` interlock already in `scripts/preflight.mjs`:

- `phiMode: "production"` with `approvalPolicy: "never"`
- `phiMode: "production"` with public access and no authentication

---

## Test strategy per phase

The existing discipline holds throughout: **rule logic in exported pure
functions, wrappers do only I/O, tests never construct a `MemoryStore`, both
SQLite drivers in CI, everything runs offline.**

| Phase | How it is proved |
|---|---|
| 1 PHI | `test/phi-mode.test.ts` — detection precision on a labelled corpus; the gate refusing before persistence, asserted by **row count**, not by return value |
| 2 Clearinghouse | Recorded-fixture (VCR) tests, no live network in CI. Mock connector remains the default so `npm test` never touches a payer |
| 3 Agent | Routing eval baseline committed; CI fails on >5% regression. Correctness eval scores scrub findings against expected JSON |
| 4 Data | Mocked downloads; staleness computed from injected clock, never `Date.now()` in the assertion |
| 5 UI | Route smoke tests, plus Playwright checks that assert on **what is visible** — hit-testing the rendered pane, not class names. This is not a stylistic preference: a class-name assertion passed while the providers screen was invisible behind the console for three rounds of fixes |
| 6 Jobs | Queue idempotency; a job enqueued twice runs once; crash-restart resumes |
| 7 Swarm | Stage machine transitions are replay-safe — applying the same transition twice is a no-op |
| 8 Channels | Quarantine asserted by row count in the agent-visible table being zero |
| 9 EHR | Fixtures only in CI; live HAPI run is a manual script |
| 10 Security | `test/security-*.test.ts` for the PHI gate, the sandbox banner, and refused config combinations |

---

## Sequence, and what blocks what

```
Phase 0  plan (this document)
   │
   ├── Phase 1  PHI mode + hardening ────┐
   └── Phase 2  clearinghouse connector ─┤   (independent; can run in parallel)
                                          │
              Phase 3  agent reliability ─┤   (needs neither, but eval baselines
                                          │    should be taken before Phase 2
                                          │    changes tool behaviour)
              Phase 4  data lifecycle ────┤
                                          │
              Phase 5  UI pages ──────────┤   (needs Phase 6 for anything long-running)
              Phase 6  jobs + scale ──────┘
                                          │
              Phase 7  swarm ─────────────┤   (needs 6)
              Phase 8  channels ──────────┤   (needs 1)
              Phase 9  EHR seam
              Phase 10 security/obs sweep      (closes every phase)
```

**Phase 2 is the one to be slow about.** Everything else is recoverable by
deploying a fix. A wrongly submitted 837 is a corrected claim, a payer
relationship, and possibly a compliance question.

---

## Checklist

Updated as each phase lands. Unchecked means not started or not finished — it
does not mean "mostly done".

- [x] **Phase 0** — this document
- [x] **Phase 1** — PHI mode. Complete:
  - [x] `src/compliance/phi-detect.ts` — patterns moved out of the email
        classifier; `detectPhi` frozen so the ingress gate is unchanged;
        `scanText` + `phiVerdict` added for the wider production scan
  - [x] `healthcare.phiMode` config, chat gate before persistence, production
        system-prompt variant, `docs/DEPLOY-PRODUCTION.md`
  - [x] Gateway refuses to **start** when exposed without a token;
        `orion serve --check-production`; two config combinations refused
  - [x] Encryption at rest — AES-256-GCM over document text **and** its
        per-page sections; plaintext rows stay readable; a wrong key refuses
        rather than returning an empty document; tampering is a decryption
        failure rather than a silent alteration
  - [x] Per-file upload acknowledgment — 428 with the filename named, per file
        rather than per session, because a blanket acknowledgement is
        indistinguishable from none within a day of being granted
  - [x] Retention enforcement — `documentRetentionDays`, applied at startup,
        with the delete logged. 0 means indefinitely, and 0 is OFF rather than
        "delete everything"
  - [x] Shell hardening — in production mode a read of the patient data store
        asks, even for a command that is read-only by every other test. `grep -r
        1EG4 /data` was a search of every stored document with no prompt and no
        access row
- [ ] **Phase 2** — `ClearinghouseConnector` + one real implementation, credential storage, submission audit trail, `docs/CLEARINGHOUSE-SETUP.md`
- [ ] **Phase 3** — intent router, pinned tools, structured context compaction, correctness eval
- [ ] **Phase 4** — `orion data refresh|status`, startup staleness warning, per-profile required datasets
- [ ] **Phase 5** — `/analytics.html`, `/forecast.html`, `/swarm.html`
- [ ] **Phase 6** — `src/jobs/`, WAL, busy retry, job status events.
  **Observed symptom, recorded before it is forgotten:** on the live deployment,
  repeated WebSocket connections opened in quick succession while an agent turn
  is in flight intermittently fail the UPGRADE with HTTP 500. Spaced-out
  connections succeed every time, and plain HTTP stays 200 throughout, so this
  is saturation of the single container rather than a broken route. Seen while
  verifying the Phase 1 gate against production; not caused by it — nothing in
  Phase 1 touches the upgrade path. This is the concrete thing Phase 6 has to
  fix, and it is the first evidence that the one-process-one-writer model has a
  ceiling a demo can reach.
- [ ] **Phase 7** — `swarm_runs`, SLA fields, dead-letter escalation
- [ ] **Phase 8** — email quarantine queue, browser health check, voice flag
- [ ] **Phase 9** — `EhrConnector` + SMART reference connector
- [ ] **Phase 10** — rate limiting, CSP, golden-path test, `/metrics`, `docs/RUNBOOK.md`

---

## The statement that will not be made early

ORION will not be described as production ready — in this repository, in the
console, or to a customer — until every box above is checked **and** a real
claim has completed a full lifecycle against a sandbox clearinghouse: scrub →
approval → 837 submit → 277CA → 835 → posting, with the audit chain verifying
end to end.

Until then the honest description is the one the console already shows: a
deployment that refuses protected health information and runs on synthetic data.
