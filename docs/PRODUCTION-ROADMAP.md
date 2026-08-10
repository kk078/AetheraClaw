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
- [ ] **Phase 2** — clearinghouse. **This phase cannot be fully ticked by
  testing**, and that is a permanent property rather than a temporary gap:
  - [x] `ClearinghouseConnector`, `MockConnector`, `getConnector`, config on two
        axes (which vendor, and whether it reaches real payers)
  - [x] Stedi eligibility, **verified against the live sandbox** — auth scheme,
        request shape, response parsing, and all three rejection codes (71 DOB
        mismatch, 72 unknown member, 79 invalid participant)
  - [x] A successful benefits response — captured live: UnitedHealthcare,
        thirty-eight benefit lines, no AAA segment. Until this landed the parser
        was only ever proved against rejections, and a mapping that handles
        every failure and mangles the success is a perfectly ordinary bug. The
        fixture pins the parts a naive mapping loses: the cost-share amounts,
        and the fact that individual and family deductibles are separate lines
        that must not be collapsed
  - [x] A claim across the seams — `test/claim-lifecycle.test.ts` follows one
        claim from eligibility through scrub, gate, 837, submit, status and 835
        posting. Every stage already had unit tests; none covered the HANDOFF,
        which is where an integration breaks quietly. The member id eligibility
        confirmed must appear on the wire, and the charge submitted must equal
        the charge adjudicated — when it does not, the claim in the system was
        not the claim on the wire and every KPI after it is fiction
  - [x] The supervised-first-submission machinery, so the decision is ready to
        make rather than improvised on the day — `docs/FIRST-LIVE-SUBMISSION.md`,
        a gate that blocks, a dry run that reads values back OUT of the wire,
        and a ledger written BEFORE the send. The cap is a number the submit
        path consults, not a line in a document: a document saying "only submit
        one to start" is one somebody deviates from at 4pm when the first
        worked and the queue is long
  - [ ] **Submit / status / ERA against a real network — NOT POSSIBLE.**
        Stedi's sandbox plan covers eligibility ONLY. Those three unlock on the
        production plan, which by Stedi's own wording means sending real claims
        to real payers. **There is no test network for the 837 path.** They are
        built and tested against the mock connector, and the Stedi connector
        refuses them with the reason. Ticking this box requires a supervised
        first live submission — a business decision, not an engineering task.
- [x] **Phase 3** — agent reliability. Complete:
  - [x] `src/agent/tool-router.ts` — ranks the tool set against the question.
        It **ranks and never filters**: a tool that scores zero is still
        reachable, because a router that hides a tool turns a mis-scored
        question into a capability that has silently vanished
  - [x] Pinned tools per session, seeded from what the session has already used
        successfully. A tool that answered a question three turns ago must not
        vanish because a later message scored differently
  - [x] Structured compaction into `session_summaries`, replacing drop-oldest.
        The summary is EXTRACTIVE, not model-written: a summarisation call
        inside the agent loop would fail precisely when the context is already
        full. Prior summaries replay, so a twice-compacted session keeps its
        first hour
  - [x] Correctness eval — 14 cases, no model, no network, so it gates CI where
        the routing eval cannot. Misses and false alarms counted separately and
        never averaged
- [x] **Phase 4** — data lifecycle. `orion data status|refresh`, a startup
  warning, per-profile required datasets. The distinction it is built around:
  when a file landed on disk is not the same fact as which edition it holds, so
  mtime supports only the negative inference. A file with no edition stamp is
  reported **undated, never current** — calling it current would turn not
  knowing into a statement of safety
- [x] **Phase 5** — analytics, cash forecast and swarm board, built as views in
  the existing console rather than three standalone pages that would each
  duplicate the auth, banner and header. Every verdict computed server-side.
  The forecast refuses under two remittance batches rather than drawing a flat
  line through one point
- [x] **Phase 6** — jobs + scale. `src/jobs/`, WAL and busy-retry (already
  present), job events on the session channel. The rule that makes it not a
  generic queue: **a job is not retried unless its kind declares it safe**, and
  the idempotency check runs before the attempts counter so a config mistake
  cannot reach an unsafe resend. `claim_submit` dead-letters on its first
  failure and is never restarted after a crash — the process may have died
  after the 837 went out.
  **The WebSocket saturation recorded here is mitigated, not solved:** the
  handler can no longer produce a 500 (connection cap closing with 1013, setup
  errors closing with a reason), but the root cause needs the load the
  container was under to reproduce and has not been.
- [x] **Phase 7** — `swarm_runs`, SLA targets, escalation. Two clocks kept
  apart: the stage target is internal, the filing deadline is external and
  absolute, and the filing window wins whenever it is binding. Escalation
  orders by money inside urgency bands, never by age. Replay safety is a UNIQUE
  constraint, not a check in code — a replayed advance would move a claim two
  stages and it would have skipped the work in between
- [x] **Phase 8** — a review queue for held mail (never a release switch: the
  body was not withheld, it was never stored), and a browser health check that
  distinguishes a missing package from a missing binary because they have
  different fixes. Outbound telephony was already gated behind consent checks
  and the simulator, and was left as it is rather than given a second door
- [x] **Phase 9** — `EhrConnector` plus a SMART-on-FHIR reference
  implementation, **verified live against the public HAPI R4 server** before it
  was committed. Read-only, no name search, refuses to guess between duplicate
  identifiers, and returns nothing rather than a mock when unconfigured — a
  fabricated chart is worse than any other fabrication here, because a chart is
  what everything else defers to. The SMART launch flow is deliberately absent:
  it is meaningless without a client id from a specific hospital
- [x] **Phase 10** — token-bucket rate limiting (a refusal costs nothing, so
  backing off recovers), a CSP that allows inline styles and not inline
  scripts, `/metrics` that carries counts and durations but never an identifier
  — enforced with `detectPhi` rather than a second set of patterns — and
  `docs/RUNBOOK.md`, written symptom-first

---

## Where this leaves it, as of the Phase 10 sweep

Nine of the eleven phases are closed. **Phase 2 is not, and cannot be closed by
testing** — that is a permanent property, not a gap. Stedi's sandbox plan covers
eligibility only; submission, status and ERA unlock on the production plan,
which by Stedi's own wording means real claims to real payers. Eligibility is
verified on both sides against the live sandbox, and the 837 path is proved
against the mock connector, which is the only rehearsal that exists.

Two other things are honestly open and are named rather than buried:

- **The WebSocket saturation is mitigated, not diagnosed.** The upgrade path can
  no longer produce a 500 from this handler, and a busy server now says so with
  a close code a client backs off on. Reproducing the original needs the load
  the container was under.
- **The Phase 3 routing eval still needs a provider and a key**, so it cannot
  gate CI. The correctness eval was built to fill exactly that hole and does.

## The statement that will not be made early

ORION will not be described as production ready — in this repository, in the
console, or to a customer — until every box above is checked **and** a real
claim has completed a full lifecycle against a sandbox clearinghouse: scrub →
approval → 837 submit → 277CA → 835 → posting, with the audit chain verifying
end to end.

Until then the honest description is the one the console already shows: a
deployment that refuses protected health information and runs on synthetic data.
