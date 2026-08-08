# 🦞 AetheraClaw

A self-hosted AI assistant for **US healthcare Revenue Cycle Management (RCM) and medical billing & coding**, inspired by [OpenClaw](https://github.com/openclaw/openclaw). A long-running Gateway service connects a CLI and a local web UI to a Claude-powered agent that can look up codes, check Medicare coverage, scrub and build claims, parse remittances, work denials — and adversarially pre-adjudicate claims against a **payer twin** before you ever submit them.

> ⚠️ **Not for real PHI.** This build is for coding education, code/policy lookup, and de-identified/synthetic examples. The agent is instructed to refuse real patient identifiers. Do not deploy against production patient data without adding the PHI-mode controls on the roadmap.

## Architecture

```
CLI (readline) ──WS──┐   Gateway (Fastify, 127.0.0.1:4180)
Web UI (browser)─WS──┤   HTTP: /api/sessions, /healthz, static UI; WS: /ws
                     │   SessionManager → AgentRunner (manual loop)
                     │        │                │
                     │   MemoryStore       ToolRegistry (shell/fs/web + healthcare)
                     │   (SQLite)          approval-gated
                     └──── ModelProvider → Anthropic | OpenAI | Gemini | Ollama
```

The Gateway is the only long-running process and the single owner of state. The CLI and web UI are thin clients over one shared WebSocket protocol — the seam future messenger channels plug into.

## Multi-provider

The agent loop is provider-agnostic. Choose per deployment (and per session) in `~/.aetheraclaw/config.json5`:

- **Anthropic** (default) — `claude-opus-5`, prompt caching, adaptive thinking, server-side web search.
- **OpenAI** — `gpt-4.1` and others, function calling.
- **Google Gemini** — `gemini-2.5-pro`, function calling.
- **Ollama** — local (`http://localhost:11434/v1`) or **Ollama Cloud** (`https://ollama.com/v1` + `OLLAMA_API_KEY`), OpenAI-compatible.

API keys come from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OLLAMA_API_KEY`). See `.env.example`.

## Quick start

Requires **Node 22.5 or newer** (`node -v`). Nothing else — no compiler, no Python,
no system SQLite. `better-sqlite3` ships prebuilt binaries for macOS, Linux and
Windows on both x64 and arm64, and if it is unavailable for any reason the store
falls back to Node's built-in `node:sqlite` automatically, which is why it is an
*optional* dependency rather than a required one.

```bash
git clone -b claude/openclaw-functionalities-xljw65 https://github.com/kk078/AetheraClaw.git
cd AetheraClaw
npm install
npm run build

# Set ONE provider key — whichever you have. No provider is privileged.
export OLLAMA_API_KEY=...                  # Ollama Cloud
#   or ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY
#   or none at all, if a local Ollama server is running

node dist/cli/index.js serve               # starts the gateway + web UI
# open http://127.0.0.1:4180  — or, in another terminal:
node dist/cli/index.js chat                # interactive REPL
```

**`provider` in the config is a preference, not a requirement.** It ships as `"anthropic"`, but if that key is absent AetheraClaw uses whichever provider's key *is* present and announces the substitution at startup. It will not refuse to run and tell you to go and get a key for a provider you never chose. To pin one:

```bash
node dist/cli/index.js serve --provider ollama    # explicit; never substituted
node dist/cli/index.js providers                  # which keys are present here
```

An explicit `--provider` is honoured or it fails — it is never quietly swapped, because serving a different model than the one named is worse than an error.

Every push runs `.github/workflows/ci.yml`: typecheck, the full suite on **both**
SQLite drivers, then a build. The second driver is not ceremony — `node:sqlite` is
where every install without a prebuilt binary lands, and running it has caught a
transaction shim that worked on one and not the other.

The suite points `AETHERACLAW_HOME` at an empty temp directory before any test
loads. Without that it reads the developer's own config and reference data, and
two tests failed the moment real NCCI edits were installed here. That shape is the
dangerous one: a CI runner has no `~/.aetheraclaw`, so those tests would have
passed forever on the machine nobody works on and failed on every machine somebody
does.

`npm run dev` runs the gateway from source via `tsx`. `npm test` runs the whole
suite offline — no database, no network, no keys — so a green run proves the
checkout is sound before any provider is configured.

### Reference data

`node scripts/fetch-cms-data.mjs` downloads the current CMS files and converts them
into the JSON the offline checks read. No dependencies and no `unzip` on the PATH —
the script carries a small ZIP reader so it runs on a stock Windows install.

```bash
node scripts/fetch-cms-data.mjs                 # all of it, ~25s
node scripts/fetch-cms-data.mjs --only=icd10    # a subset: ncci, mue, mpfs, icd10
node scripts/fetch-cms-data.mjs --hospital      # outpatient facility edits instead of practitioner
```

Verified end to end against the July 2026 releases: 1,728,585 active PTP edits,
15,162 MUE ceilings, 17,095 priced codes, 218 GPCI localities, conversion factor
33.4009 read out of the RVU file rather than remembered, and 74,706 billable
ICD-10-CM codes with 23,460 category headers.

**ICD-10-CM is the one dataset here that is not AMA-licensed.** It is CMS/WHO and
published free, which is exactly why the most-used lookup in the product can now
answer offline while CPT still cannot. `icd10_search` and `icd10_validate` read
the local table when it is installed and fall back to the NLM Clinical Tables API
when it is not — **and every answer says which one served it, and which fiscal
year**. A stale FY2025 table answering as though it were current is the failure
that replaces network dependency, and it is invisible unless the edition is named.

Billable status comes from CMS's own order file rather than being inferred from
the hierarchy. The file states it outright in column 14, and "a code with children
is a header" is wrong in both directions — plenty of billable codes have more
specific ones beneath them. The fetcher installs **the edition in effect, not the
newest published**: CMS posts next year's file months ahead, and the first version
of this reached forward and installed FY2027 in August 2026, which would have
answered every question about a service performed that day out of next year's book.

Search is literal matching over CMS titles, **ranked by how many of the search
words appear rather than filtered to all of them**. Requiring every word returned
`Z86.31` (*personal history of diabetic foot ulcer*) and nothing else for "diabetic
foot ulcer", because `E11.621` is titled *…diabetes mellitus with foot ulcer* — the
one code a coder wanted, excluded by a letter. Billable codes rank above category
headers at equal relevance, since "acute appendicitis" otherwise led with three
headers that are the most on-point titles in the file and none of them claimable.
Measured: 108 ms to load the 8 MB table once, then 1.9 ms per validation and code
lookup, 20 ms for a term search.

**If CMS refuses (HTTP 403), download them yourself.** Its CDN declines some
clients outright — a plain 403 on pages a browser loads fine from the same
network. This script does not argue with that: no User-Agent rotation, no
pretending to be a browser, because defeating a bot rule to pull AMA-licensed
data is doing something nobody agreed to. The manual route is better anyway,
since downloading in a browser is the path that goes *through* the AMA licence
acceptance page that a direct-link fetch quietly skips. Save every ZIP into one
folder and point the script at it:

```bash
node scripts/fetch-cms-data.mjs --from-dir=C:\Users\you\Downloads\cms
```

Same converters, no network. Verified to produce byte-identical output to the
online path — 1,728,585 pairs either way. **A missing PTP part is fatal, not a
warning**: each of the four files holds a different slice of the code range, so
three of four is not "most of the edits" but a table with a silent hole, and a
pair inside that hole would read as *not bundled* rather than *not checked*.

**Retired edits are dropped, and that is the point.** The published PTP table is
cumulative — 904,804 of its rows are edits CMS no longer enforces, each carrying a
deletion date. Loading them would make the scrubber report bundling violations on
claims that would have paid: confident, specific, and wrong. Rows carrying a 26 or
TC modifier are skipped in the RVU file for the same class of reason — letting a
professional-component row overwrite the global code silently prices every global
service at about a third of the correct amount.

**Licence.** These files contain CPT codes, copyright the AMA; CMS routes the NCCI
links through an AMA licence page. They are fetched to your machine at runtime and
are **never committed to this repository** — the same posture as `cptDataPath`. Do
not redistribute what lands in `~/.aetheraclaw/data`.

`ncci-ptp.json` is written as `{ COL1: { COL2: indicator } }` rather than a list
of objects, and indexed once per process rather than scanned per claim. The array
form repeated three key names 1.7 million times — 105 MB on disk, 2.3 s of
`JSON.parse` before the first scrub, and ~110 ms per scrub thereafter spent
deciding that 1,728,583 edits had nothing to do with the two codes on the claim.
Measured after: **20 MB, 1.4 s to first scrub, 0.005 ms per scrub.** The older
array shape is still read, so an existing file keeps working.

**One limit worth knowing.** `hcpcs.json` is built from the RVU file's own
description column, which covers every *priced* code but not unpriced HCPCS — most
DME, supplies and drugs. CMS's "alpha-numeric HCPCS file" looks like the right
source and is not: the 2026 ANWEB record carries ~1,700 codes and contains none of
J1885, E0114, A0428 or G0008, so nothing here is built on it. A miss reports as
"not found in local data" rather than as a nonexistent code.

### Attaching a reference database you already own

A practice may already hold a large code or policy database. Point
`healthcare.referenceDbPath` at the SQLite file and AetheraClaw reads it **in
place** — read-only, never copied, never converted, never committed. Look inside
it first:

```bash
node scripts/inspect-db.mjs /path/to/reference.db
```

That prints every table, its row count and columns, and the *shape* of a sample —
`"1985-03-12"` as `date`, `"J. Rivera"` as `text(9)`. Values are never printed. A
schema dump that pastes three real rows into a terminal, and from there into a
ticket or a chat log, leaks exactly what the rest of this design exists to prevent.

Once attached, **no table is readable until its column names have been scanned for
patient identifiers** — `mrn`, `dob`, `member_id`, `last_name`, `address`, and the
rest. A match holds the table back: `reference_db_status` names it and names the
columns that tripped, and no tool will query it. The scan is deliberately broad,
because a false positive costs one config line
(`healthcare.referenceDbAllowTables`, one table at a time — there is no global
override) and a false negative hands PHI to a language model.

Read-only is enforced by SQLite, not by convention: both drivers take the flag and
both then fail a write. A user's 1.24 GB file is not something to open writable and
hope.

`reference_lookup` answers from a cleared table and **says which file and table it
came from** — a descriptor served from a private database is a different claim from
one served by a published CMS file.

**Known tables are routed into the domain tools.** Nobody asking what CARC 253 means
should have to know the answer lives in a table called `ref_carc`, so table names map
to *roles* and the tools consult the role. `denial_explain` fills the silence left by
the compiled subsets (24 CARCs of ~400, 14 RARCs of ~1,000) while keeping the compiled
entry where it exists, because that one carries a category and a recommended action a
bare code list does not. `hcpcs_lookup` gains the unpriced Level II codes the RVU file
omits. `mac_lookup` can finally answer *which MAC serves my state* — the CMS Coverage
API publishes no state field, and until now the honest answer was that it could not be
looked up at all. `ndc_lookup`, `loinc_lookup`, `icd10pcs_lookup`, `modifier_lookup`,
`drg_lookup`, `taxonomy_lookup`, `eob_crosswalk` and `hcc_lookup` cover code sets that
previously had no home; each reports a miss as a miss rather than answering from
recollection, and `reference_roles` lists what the attached file can actually serve.

**Fullest descriptor wins, not first source.** `hcpcs.json` is built from the RVU
file's description column, which is a truncated abbreviation — `J1885` reads
*"Ketorolac tromethamine inj"* there against the real descriptor *"Injection,
ketorolac tromethamine, per 15 mg"*, and a coder checking a unit definition needs the
"per 15 mg". Sources that disagree are both shown rather than silently resolved.

**Licensed content is opt-in per role.** CPT descriptors are read only when
`healthcare.referenceDbLicensedRoles` names `"cpt"`. There is no default-on path,
because a default cannot be a decision about somebody else's licence — and the status
report distinguishes *present but not declared* from *absent*, which have different
answers.

**What a fresh install does and does not fetch.** `npm install` takes ~200 MB and
no build step. Playwright's browser binaries are *not* downloaded — the payer-portal
tools need `npx playwright install chromium` first, and every other tool works
without it. Reference datasets are not bundled either — see above; `data_status` lists what is
missing and what each absence stops you from checking.

State lives in `~/.aetheraclaw` — `config.json5`, `aetheraclaw.db`, `data/` — and
the workspace defaults to `~/aetheraclaw-workspace`. Set `AETHERACLAW_HOME` to put
it somewhere else; nothing is written outside those two directories.

## Safety model

All tool input is treated as untrusted model output:

- **Approval gate** — mutating shell commands, file writes, and claim/appeal generation require explicit approval (CLI `[y/N]` prompt or web modal). `approvalPolicy`: `always` | `unsafe-only` (default) | `never`.
- **Workspace confinement** — every file/shell path is resolved and verified to stay within the workspace root (blocks `../`, absolute paths, and symlink escapes).
- **SSRF guard** — web fetch refuses private/loopback addresses.
- **Localhost binding** — the gateway binds `127.0.0.1` by default.

### Multi-tenant isolation

Off by default (`tenancy.enabled`). When on, **a tenant is a database file, not a column.**

That is a deliberate departure from the usual `tenant_id` + row-level-security design, for one reason: **SQLite has no row-level security.** There is no `CREATE POLICY`, no `current_setting`, no engine-level predicate. A `tenant_id` column in SQLite is enforced only by every query remembering to write `AND tenant_id = ?` — and with 47 tables and several hundred queries across three dozen tool modules, one forgotten clause is a cross-tenant disclosure with nothing underneath it to catch the mistake. Here a query that forgets its tenant cannot reach one, because the connection it runs on does not physically contain another tenant's rows. The cost is real and worth stating: cross-tenant reporting must open each tenant in turn and aggregate in application code.

**The model cannot choose the tenant.** There is no `tenant_switch` tool and there will not be one — tool input is untrusted model output, and a tool that accepts a tenant id can be argued into accepting a different one by text arriving inside a payer letter or a portal page. The binding is made once at the edge (`--tenant`, or a gateway session) and travels in the tool context. `tenant_current` reports where the session is; nothing can move it.

Enabling tenancy never moves existing data: single-tenant keeps its original database path and tenants get new ones under `tenants/<slug>/`. There is no automatic migration, because a migration that guesses which practice owns which row is worse than none. A suspended tenant is refused outright rather than served read-only — read-only still discloses.

```
aetheraclaw tenants create acme-health --name "Acme Health Partners"
aetheraclaw tenants list
aetheraclaw serve --tenant acme-health
```

### PHI access logging (45 CFR §164.312(b))

`phi_access_record` / `phi_access_review`, written into the tenant's own hash chain. Two things here are the opposite of the usual design:

- **The log refuses to hold PHI.** A resource reference containing an SSN, MBI, legacy HICN, date-of-birth marker or email address is rejected, not redacted. A log about PHI that stores PHI is a second copy of the record with weaker access control than the first — everyone in compliance can read the logs.
- **Reads are logged, and exports are marked.** The characteristic HIPAA incident is a person with valid credentials viewing a record they had no business viewing, which leaves no trace at all in a change log. `export` and `print` are flagged as disclosing because they are the actions after which the organisation no longer controls the copy.

`phi_access_review` reports what left the building and which actors moved unusual volume — framed as a question, since a payer audit response, a year-end close and a data migration look identical here to the thing you are watching for. It also cross-checks every log row against the chain: a **forged** log row is *added* rather than edited, so verifying the chain alone would still pass.

> This build remains **not approved for real PHI**. The access log, tenant isolation and identifier refusals are the infrastructure a PHI-approved deployment would need; turning them on does not by itself make this system a covered-entity-ready one, and the no-PHI posture in the system prompt, intake, email and portal paths is unchanged.

### The console renders results, not transcripts

A tool returns two things now: the text the model reads, and an optional **structured view** the browser renders. The text is unchanged, so no tool's behaviour in the agent loop changed and no prompt was rewritten.

The view **never enters the model's context**. It is stored in its own `tool_views` table and streamed straight to the UI, because the runner rebuilds provider context by replaying `messages.content_json` verbatim — anything stored there is re-sent every turn, and a rendered claim form is thousands of tokens of JSON restating what the tool's prose already said. That split is what makes rich rendering free rather than a per-turn tax. A test asserts the payload does not appear in the message rows.

- **`claim_scrub` / `presubmit_check`** render a line-item form: one row per service line, severity stripe, place-of-service *name* beside the code, findings expanded underneath. A **safe repair** shows what it changes (`2026-01-15 → 20260115`); anything needing a fact the claim does not contain shows as **needs a human** with the question — never a button. A one-click "accept fix" on a POS/telehealth mismatch would put a false statement on a Medicare claim in a single click, which is exactly what `claim_autoheal` refuses to do.
- **`payment_variance`** renders expected → shortfall → actually allowed, with the reclaimable dollars as a badge, and the caveat attached to the basis: a Medicare comparison against a commercial payer is *not* a recovery claim, and a payer's own median describes its habit rather than its obligation.
- **`em_level_risk`** renders the four-code ladder with **documented** and **billed** marked on it, plus the MDM elements that produced the level.
- **`kpi_dashboard`** renders rings. An uncomputable metric shows `—`, never `0` — a zero reads as a measurement.

The overview page carries the same three figures as **micro-widgets** — days in A/R, front-end acceptance, net collection — computed through the *same* loaders `kpi_dashboard` uses, because two claim↔ERA joins normalising ids differently would let the page and the tool disagree about what is outstanding with no way to say which was right. A withheld figure shows `—` with the reason underneath; rendering it as `0` would read as "we collect instantly", the one wrong answer that looks like good news. Past a bounded row count the widgets decline and point at the tool, rather than making every page load parse the whole claim history.

Severity, line attribution and whether a repair may be offered as a button are all decided server-side in `src/views/build.ts`, where they are tested. A browser is the wrong place to re-derive a domain judgement, and a second implementation would drift from the rule engine.

### Support & operations tooling

A profile (`--profile ops`) for the people who keep it running rather than the people who bill with it. Every tool here is **read-only by construction** — a diagnostic that can also change things is one nobody runs during an incident, which is exactly when it needs to be reflexive.

- **`ops_tenant_integrity_check`** sweeps every tenant database for corruption, schema drift, foreign-key violations, WAL growth and page fragmentation — and, first in the report, the isolation boundary itself: file permissions, and whether two tenants resolve to the same file. Two tenants sharing a path is not a leak, it is shared storage, and it is invisible to every per-file check. **This tool found a real defect on its first run**: databases were being created at whatever the umask allowed (0644 on a default Linux install), so every tenant's claims were world-readable. Fixed in `MemoryStore`, WAL and SHM included, with a regression test.
- **`ops_dataset_health`** reports size, SHA-256, mtime and staleness against the published CMS release cadence. It does **not** claim to verify against CMS: CMS publishes no manifest hash and refuses automated fetches, so an upstream check would verify nothing while looking like proof. Hashes detect change between your own recorded snapshots, which is a real and different guarantee.
- **`ops_ollama_telemetry`** reports what Ollama's API actually exposes — loaded models, resident-VRAM share, context length, probe latency. A model 40% resident in VRAM is the usual cause of minute-long turns, and a context smaller than `contextTokenBudget` means Ollama is silently truncating the conversation. GPU utilisation and token rates are **not** shown, because the API does not expose them and reading nvidia-smi would describe the whole machine rather than this process.
- **`ops_batch_heal_preview`** runs the auto-heal engine across a whole batch and answers the capacity question rather than listing defects: how many go out as they are, how many a safe repair covers, and how many **need a human** — the only one of the three that is work. Repairs and reviews are grouped by rule, because one rule hitting forty claims is a charge-capture form emitting the wrong format, not forty independent problems. Nothing is written, and there is deliberately **no batch apply**: rewriting hundreds of claims in one unreviewed action would be the largest single change this system can make, and the safe repairs are exactly the ones nobody would notice going wrong. A stored row that will not parse is excluded and *said*, never counted as clean.
- **`ops_rejection_analysis`** reads every 277CA outcome together — acceptances banked to `filing_proof`, rejections opened as worklist items — and detects **emerging edits**: a clearinghouse or payer front end that tightened a rule and did not announce it. Same statistical discipline as the drift check, with one deliberate exception: a status code that never appeared and now appears repeatedly is reported on its count alone, because a proportion test against a zero baseline would suppress exactly the case the tool exists for. A code whose rate *fell* is not reported — a front end relaxing an edit is good news, and putting it under "emerging edits" trains people to skim the section.
- **`ops_generate_rca`** composes a Root Cause Analysis document: the failing step, the classified cause with the evidence **quoted** rather than summarised, the claim's lifecycle timeline including the stages that never happened, and remediation addressed to a **named owner** rather than a bare tier number — "Tier 1" says how hard the fix is, not who does it, and a payer rejection and a schema mismatch are both easy and belong to different teams. Severity turns on two axes only: is data at risk right now, and is a filing clock running. When a claim is named, its **own record sets the root cause** and unrelated tool failures in the same window are reported under "also failing in this window" and kept out of it — the regression that motivated this was a claim sitting 95 days unacknowledged being filed as a network incident and addressed to engineering, because Ollama happened to be down that afternoon.
- **`ops_policy_drift_check`** detects a payer silently tightening an edit, comparing each payer/CARC pair's recent denial rate against its own earlier rate with a two-proportion test and a minimum denominator in both periods. Three-of-ten to eight-of-twenty is not a doubling, it is noise — and an alerting tool nobody trusts gets muted, which is how the real change goes unnoticed too. Pairs too thin to test are counted and reported rather than dropped in silence.

**Support diagnostics** (`support_*`):

- **`support_trace_claim`** assembles a claim's lifecycle from every table that touched it — build, filing proof, remittance, worklist, pipeline stage, twin prediction, audit entry — and **names the expected stages that never happened**, because the gap is nearly always the answer. A claim built but never acknowledged did not reach the payer; acknowledged but never adjudicated is either in process or lost after acceptance, and the filing clock ran through both.
- **`support_fmea_diagnose`** reads the **tool-call log** by default, so it works on real production failures without anyone finding and pasting them first, and classifies them into a root cause with next steps. It counts per category for a batch — forty failures with one cause is one incident, forty with eleven is something that changed underneath them all. Anything no rule matches returns **UNCLASSIFIED** rather than a guess: a confident wrong category sends an engineer down the wrong path for an hour precisely because it sounded certain.
- **`support_failed_ops`** lists work that entered the system and stopped moving — mail held at the PHI boundary, jobs that should have fired, wedged claims, expired worklist items — with the ones where *the delay itself is the loss* marked and sorted first.
- **The tool-call log** records every invocation at the registry's choke point: name, outcome, duration, and the input **shape** — key names only, never values, because tool input carries claim data and a log storing it would become the largest copy of that data in the system with weaker access control than the tables it came from. Error text *is* stored, **scrubbed** of identifier shapes rather than refused — the opposite of the PHI access log next door, and deliberately: there a caller passing an identifier has a bug worth surfacing, here the string came from a library and refusing would throw away the diagnosis. Retention is bounded by age *and* by row count, pruned once at startup, because a burst inside the window outruns the age rule and this is the only table that grows with every action forever. Overhead measured at **+0.135 ms per call**.
- **`support_remediate_preview` / `_apply`** run a single `UPDATE`/`DELETE`/`INSERT` against the live database inside a savepoint that is **always** rolled back — there is no branch in the preview path that commits — and show the exact before/after diff with an exact affected-row count. An `UPDATE` or `DELETE` with **no `WHERE` is refused outright, with no override**; so is anything touching the append-only audit tables. Applying requires the token the preview returned for *exactly* that statement, so editing the `WHERE` clause afterwards invalidates it and applying something nobody previewed is not possible by forgetting. Every apply is transactional and appended to the hash-chained audit log with the statement and a required reason. Verified on both SQLite drivers, including that the rollback survives a statement that throws mid-execution.

**Ticketing.** `ops_generate_rca` emits a **ticket payload** — title, severity, labels, assignee, body, and a stable fingerprint — rather than a Jira / ServiceNow / Zendesk client. Three API integrations that cannot be authenticated or tested from this machine would look finished and would first be exercised during an incident, which is the worst possible moment to discover a field name was wrong. Piping the payload into your own instance is a few lines of glue somebody writes once and can actually run. The fingerprint is the part a hand-written bridge always forgets and the part that matters: it is derived from the **cause** with digits normalised out, so the same fault recurring — including a claim whose cause reads "built 95 day(s) ago" and reads 96 tomorrow — produces the same value and updates the existing ticket instead of forking a new one every morning.

Two tools in the original spec are **not** built, because AetheraClaw does not have the architecture they describe. There are no microservices, no Cloudflare Workers or tunnels, and no message queue — it is a single Node process over SQLite. A `support_trace_claim` reporting "tunnel hops", or a `support_dlq_replay` listing queue messages, would be reporting on infrastructure that does not exist. The equivalents that *are* real are `support_trace_claim` and `support_failed_ops` above, under names that describe what they actually inspect.

### Chasing a quiet claim, and deciding what to appeal

**`claim_status_inquiry` (X12 276/277)** asks a payer where one specific claim is.
It exists because `support_trace_claim` and `ops_generate_rca` both diagnose a
claim as accepted-and-then-silent and ended at the same sentence — *chase the
payer* — with nothing to chase with. Not the same as `ack_parse_277ca`: that is an
unprompted acknowledgment that a claim got through the front door; this is a
question about one that got through and then produced no remittance.

The answer that matters most is **NO RECORD**, and it is never rendered as a
pending status. It means the claim is not in adjudication and never was, so every
day of waiting bought nothing and the filing clock ran throughout. The second
thing the tool insists on: **pending is a status, not a protection.** Timely filing
does not pause for adjudication and no appeal rights accrue while a claim pends,
because nothing has been determined. `P3` is called out separately — the payer is
waiting on *you*, and it is the most commonly missed status of the set. Responses
are simulated and labelled as such on every run until a real connector is
configured, and nothing simulated is written to the claim record.

**`appeal_triage`** ranks denials by expected recovery — amount × this practice's
own overturn rate for that payer and CARC, minus the stated cost of the work —
rather than by balance, which puts a $4,000 denial nobody has ever won ahead of a
$600 one they win four times in five. Two constraints are built in rather than
warned about:

- **It declines below a real sample.** Under twelve *recorded appeals* there is no
  rate to estimate, and it makes no recommendation instead of inventing one. The
  denominator is appeals **filed**, not denials received — counting never-appealed
  denials as losses drives every rate toward zero and yields a tool that
  recommends never appealing, which is self-fulfilling.
- **It never recommends a write-off.** The closest it comes is reporting that a
  denial is worth less than the work — and before saying that it checks for a
  **cluster**. Seven $55 denials sharing one CARC are not seven write-offs; they
  are one upstream fault, and they are the most valuable rows in the queue
  precisely because a per-claim ranking would bury them.

`appeal_outcome_record` is what makes the rate real: record losses as well as
wins, and the ranking comes from this practice's results rather than an industry
average.

### Grounding

The dangerous failure in a billing assistant is not a crash, it is a fluent wrong answer. Every item here exists because a model running against this system produced one, and each is a countermeasure with a test behind it (`test/grounding.test.ts`).

- **Facts live in tables, not in the model.** `pos_lookup` holds the full CMS Place of Service code set, because asked what POS 22 means a model answered "Remote Telehealth (store-and-forward)". It is On Campus-Outpatient Hospital — the difference decides facility vs non-facility practice expense on every line. A guardrail without the data would only have converted a confident wrong answer into a confident refusal, so the data came with it.
- **Invented citations cannot reach an outbound letter.** A model asked to appeal a CARC 96 denial produced a letter citing "CMS NCD 310.2 — Evaluation and Management Services", addressed to Medicare Appeals. There is no NCD for E/M services; the CMS Coverage API returns nothing. `appeal_draft` now detects identifier-shaped citations and refuses to write until the caller states they were verified.
- **Absent data is not a negative result.** `data_status` reports which reference tables are installed and, for each missing one, what can no longer be checked. This is here because a model reported that NCCI data was not installed and then, in the same answer, stated that the NCCI tables do not bundle a particular pair — a claim about a table it had just said it could not read.
- **A refusal is an answer.** When `reimbursement_estimate` declines for want of RVUs, the gap is not to be filled with a remembered national rate and GPCIs. The system prompt says so; the tool never emits a number it did not compute.
- **A wrong tool name is corrected, not aliased.** Calling `search` instead of `web_search` fails and returns the nearest real names. An alias table would make the invented name work, teach the model nothing, and risk silently running a different tool than the one meant.
- **A 403 is the site's decision.** `web_fetch` sends one honest, identifying User-Agent and never rotates it. When a host refuses automated access the error says so and names the API tool that has the same data, instead of leaving a model to retry and then try to look like a browser.

## Healthcare RCM tools

**Coding & validation** — `icd10_search`, `icd10_validate` (local CMS code set when installed, NLM Clinical Tables otherwise — the answer names which), `hcpcs_lookup`, `pos_lookup` (full CMS Place of Service code set, including the unassigned ranges — a claim carrying POS 38 rejects, and that is different from an unknown code), `npi_validate`/`npi_lookup`/`npi_search` (NPPES), `data_status` (which reference tables are installed and what cannot be checked without each).
**Coverage & medical necessity** — `coverage_search_national` (NCD), `coverage_search_local` (LCD), `mac_lookup`, `sad_exclusion_check` (CMS Coverage API).
**Claims lifecycle** — `claim_autoheal` repairs only the defects with exactly one correct answer — a date written `2026-01-15`, a place of service left as one digit — because those write down what the claim already said. Everything else comes back as a question, including the one auto-repair rule everybody wants: **POS is never rewritten to agree with a telehealth modifier.** Place of service is a factual assertion about where the service happened; when it and the modifier disagree the claim contains two contradictory statements and nothing in it says which is wrong, so "correcting" POS resolves the contradiction by inventing a fact — and if the visit really was in the office, an automated system has just put a false statement on a Medicare claim. Choosing between 02 and 10 is worse still: they are distinguished by where the *patient* was, which the claim does not record at all. Parsing an 835 now opens worklist items for the denials inside it, deduplicated on claim+CARC so re-parsing the same remittance adds nothing, and summed per reason so three lines denied for one cause rank as one piece of work rather than three small ones. `claim_scrub` (code/dx-pointer/NPI/modifier/POS/NCCI/MUE rules + the compliance pack below), `claim_build_837p`, `era_parse_835`, `ack_parse_277ca`, `denial_explain` (CARC/RARC), `reimbursement_estimate`, `payment_variance` (see claim intelligence below).
**Secondary claims & COB** — `ack_parse_277ca` decodes the clearinghouse/payer acknowledgment that arrives *before* adjudication, splitting accepted from rejected claims and translating each status category/status/entity triplet into what is wrong and whose data caused it. A front-end rejection never entered the payer's system: there are no appeal rights, no remittance will follow, and timely filing keeps running — so rejections open worklist items immediately. `cob_determine_primary` resolves payer order and emits the SBR05 MSP type code, covering Medicare Secondary Payer rules (working aged at 20+ employees, disability at 100+, the 30-month ESRD coordination period, workers' comp, auto/no-fault, liability, Black Lung, VA) and commercial coordination (own coverage before dependent, active before retiree/COBRA, and the birthday rule with its court-decree and custodial-parent overrides); when a missing fact — usually employer size — is what decides the answer, it says so instead of guessing. `cob_balance_check` enforces `charge = paid + adjustments` on every line, the arithmetic secondary payers check first and the most common reason a secondary claim is rejected up front. `claim_build_secondary` generates the secondary 837 with the primary's adjudication carried in loop 2320 (SBR, CAS, AMT, OI, DTP\*573) and loop 2430 (SVD, CAS, DTP\*573), extracted from the primary's raw 835 rather than re-keyed, and refuses to emit while the balance check fails.
**Claim intelligence** — `reimbursement_estimate` runs the official MPFS formula, `[(work RVU × work GPCI) + (PE RVU × PE GPCI) + (MP RVU × MP GPCI)] × conversion factor`, then applies the rules that actually decide the number: facility vs non-facility practice expense (the same code pays differently in an office and a hospital), modifier adjustments checked against **the code's own MPFS policy indicators** rather than applied blindly — bilateral 50 at 150% only where the indicator allows it, multiple-procedure reduction, assistant at surgery at 16% (and *not payable at all* where the indicator carries the statutory restriction), modifier AS compounding to 13.6%, co-surgery 62 at 62.5% — plus the 85% rate for a PA/NP billing under their own NPI, and 2% sequestration taken off the Medicare share only. `payment_variance` finds underpaid lines two ways: `payer_history` measures each payer against **its own established median** for that code, which works for any payer without knowing the contract, and `fee_schedule` compares against Medicare. `fee_schedule_drift` catches a payer quietly repricing a code by splitting its payment history and comparing medians — a step down that holds is a fee schedule change nobody sent a letter about. NCCI edits carry their real indicators: a PTP pair with modifier indicator 0 cannot be unbundled by any modifier, and an MUE with adjudication indicator 2 is absolute and will not be won on appeal, so neither is worth spending an appeal window on.
**Compliance rule pack** — `telehealth_check` / `telehealth_policy_set` (POS 02/10/11 and modifier 95/93/GT/GQ rules, with an editable **per-payer policy table** because payers diverge from Medicare), `global_period_check` / `global_period_record` (global surgical periods with modifier 24/25/57/58/78/79 logic against recorded procedure history), `incident_to_check` (incident-to in the office vs split/shared in a facility, including the modifier FS and substantive-portion rules). All three also run automatically inside `claim_scrub` when a claim carries the optional `compliance` block.
**Eligibility & worklists** — `eligibility_check` (pluggable clearinghouse; mock connector in v1), `worklist_add`/`list`/`update`.
**Denial prediction & filing deadlines** — `denial_risk_score` predicts from the practice's own remittance history, with every rate shrunk toward the observed baseline in proportion to the evidence behind it, so three claims with one denial does not read as a 33% denial rate. The evidence levels are nested rather than independent — "this code with this payer" is a subset of "this code everywhere" — so they back off into one another instead of being summed, and each factor's contribution is reported in percentage points that sum exactly to the movement off the baseline. `timely_filing_check` computes the deadline (Medicare fee-for-service is **one calendar year** from the date of service by statute, ACA §6404, computed in calendar years so a leap day cannot shift it) and reports whether proof is already on file; `timely_filing_set` records a payer's real contract window, `timely_filing_exception` computes the extension under 42 CFR 424.44(b), and `timely_filing_sweep` finds claims whose window is closing. **Acceptances are banked as they arrive**: `ack_parse_277ca` writes each acknowledged claim to a filing-proof ledger, so when a CARC 29 denial turns up eight months later the evidence that wins the appeal already exists. Proof means an *acceptance* report, not a submission log — the first shows the payer received the claim, the second only that you sent it. `worklist_prioritize` ranks denials by expected recovery per hour rather than by dollars, drops past-deadline items out of the queue, and separately names the items the queue will not reach before they expire.
**Audit & integrity** — `audit_track` / `audit_list` / `audit_update` / `audit_response_draft` (RAC, MAC ADR, TPE, UPIC, SMRC, CERT and commercial audits, with response deadlines and — once a determination lands — the computed appeal-ladder and §935 recoupment clocks), `audit_deadline_calculator` (every Medicare audit deadline from one date), `em_benchmark` (the E/M bell-curve analysis payers use to pick audit targets: per-level shares vs peer benchmark, per-provider variance, and payer downcoding rate), `credit_balance_detect` / `_add` / `_list` / `_resolve` (overpayment ledger with ACA 60-day report-and-return countdowns and CMS-838 quarterly reminders).
**Code & policy currency** — `code_update_calendar` shows upcoming releases and how far behind the installed data has fallen: ICD-10-CM/PCS (October 1 main release, April 1 mid-year), HCPCS Level II (January and July for items and services, **quarterly for drugs and biologicals** — if you bill injectables that is your real cadence), NCCI PTP/MUE (quarterly), CPT and MPFS (annual January 1). `code_set_register` records which edition is installed so staleness is a fact rather than a guess. `code_update_diff` diffs two editions and reports **only what touches codes this practice actually bills**, drawn from stored claims and remittances — deleted codes still in use, reworded codes, and, for ICD-10, codes that gained children and so became non-billable headers, which is the most common way established codes start rejecting on October 1. `policy_watch` reads the CMS Coverage national and local change feeds, filtered by contractor, document type, keyword and date, and shows only what has moved since the last run; a retired billing-and-coding Article is scored as an action item because nothing announces it on the claim. Which edition applies to a claim is decided by the **date of service**, not the submission date, so a claim spanning an effective date has to be split.
**Practice operations** — `credentialing_track` / `_list` / `_check` follow provider enrollment per payer, computing a revalidation date from the effective date when the payer has not published one (five years for Medicare providers and organizations, three for DMEPOS suppliers) so a new enrollment is never simply unwatched, and tracking the CAQH attestation that silently expires every **120 days** and blocks commercial credentialing with no notice. `credentialing_check` answers "could this provider bill this payer on this date" *before* the claim goes out — a service furnished while unenrolled denies as provider-not-eligible (CARC B7) and no appeal recovers it. `superbill_build` turns a captured encounter into a clean claim, deriving the 1-based diagnosis pointers the 837 needs from the diagnosis **codes** each line names, which removes the step charge capture most often gets wrong; `web/public/superbill.html` is the same thing as a form. `era_export` writes a posting CSV with charged, allowed, paid, patient responsibility, contractual write-off and sequestration in separate columns. `gfe_deadline`, `gfe_generate` and `gfe_variance_check` cover the No Surprises Act Good Faith Estimate: the clock runs in **business days from scheduling** (10+ business days out → 3 to deliver, 3–9 → 1, under 3 → no scheduling trigger, and a patient request always starts a 3-day clock), and a final bill $400 or more above the estimate opens patient-provider dispute resolution.
**Coding review queue** — AI-suggested codes are proposals, never claims: code selection belongs to the coder and the provider. `code_suggest` queues a code with the documentation that supports it; `review_decide` records accept, edit, reject or reopen. **A reason is required to edit or reject** — it is what teaches the next suggestion and what an auditor asks for — and a decided suggestion is never silently overwritten, only reopened with a stated reason. Every decision is appended to a log that is never rewritten, so `review_audit` can show that a code was accepted, reopened, and then changed, which a mutable status column cannot. `review_apply` collects only the codes a coder actually approved and counts the ones it excluded. Edits and rejections become **corrections** that `coding_corrections` recalls before the same code is suggested again — payer-specific corrections outrank general ones, repeated ones outrank one-offs, and they are surfaced through a tool rather than folded into the system prompt, which stays byte-stable so prompt caching works. `review_audit` with no arguments reports each suggestion source's accept rate over *decided* suggestions, so an unreviewed backlog does not read as failure. `web/public/review.html` is the same queue as a page.
**Mail operations** — `mail_inbox_sweep` groups mail by **urgency rather than arrival**, where urgency comes from the deadline the letter states and a relative window ("within 30 days") counts from when it was **received** — measuring it from now would reset the clock every time somebody opened the inbox, the one direction it must never move. `mail_recommend_action` cross-references the claims a letter names against what the database already knows: the same records request is three different situations, and it **refuses to recommend opening a worklist item for a claim that does not exist here**, because a queue full of phantom claims is worse than an empty one. `mail_attachment_scan` identifies attachments by **content before extension** — an 835 arrives as `.txt`, `.dat`, `.era` or nameless, but the ISA envelope and its ST transaction-set code do not lie — and routes each to the tool that already parses it rather than growing a second X12 reader. It reports a PDF as a PDF: **there is no PDF text extraction in this build**, and returning the ASCII fragments visible in a raw PDF stream would look like a reading and be worse than nothing. `mail_ops_briefing` reports what arrived, what was held, what could not be placed, how many carry a deadline inside a week, and the dollar value of **informal denials** — the ones that arrived by email rather than on an 835, which are invisible to remittance analytics, so a practice's denial rate is understated by exactly these and the gap is not discoverable from the 835s because nothing is missing from them. Payer latency is a **median**: one letter arriving after nine months drags a mean past anything anyone would recognise, which is when a metric stops being used. Every ingest is bound into the hash chain by **hash of the raw message**, so the chain can prove which letter was ingested without becoming a second copy of a body that was deliberately never stored.
**Email channel &amp; reporting** — a billing inbox is not a mailbox, it is an unsorted work queue with clocks already running inside it. `email_poll` classifies each message into the RCM artifact it actually is — records request, audit notice, overpayment demand, revalidation notice, denial, policy bulletin, clearinghouse rejection — and pulls out the deadlines, claim references and amounts it carries, naming the tool that should take it from there. Ambiguous letters resolve toward the **costlier miss**: a records request that also mentions a denial stays a records request, because missing the ADR window loses the claim outright. Inbound mail carrying identifier-shaped text (SSN, MBI, legacy HICN, labelled DOB) is **held rather than stored** — this deployment is not approved for PHI, and an inbox is where it arrives unasked. Outbound mail is never on a timer: `email_draft` stores a reply and `email_send` is approval-gated. `email_ingest_file` runs the same classifier on a saved letter with no mailbox connected at all. `report_generate` writes the practice report — production, accounts receivable aged from the **date of service** in 30/60/90/120 buckets with a dollar-weighted average age, and denials ranked **by dollars rather than by count**, since a frequent small edit is rarely the expensive problem. A denied claim leaves AR rather than sitting in both reports. Output is Markdown plus CSVs that open in Excel.
**Payer portal automation** — a real browser for portals with no API, which is the most dangerous thing here and is built accordingly. **Credentials never reach the model**: `portal_login` takes a portal name only, reads the username and password from the environment, types them into the page, and reports success or failure — they are not arguments, not results, and not in the action log, and a Playwright error that quotes the value it was typing is scrubbed before it is stored. `portal_fill` refuses password, one-time-code and PIN fields outright, by input type *and* by selector name, so no string produced anywhere else can be typed into one. **Navigation is confined to configured portal origins**, checked before the request and again on the URL that actually results, because a redirect is the ordinary way a signed-in browser gets moved somewhere it was not sent; a page that lands off the allowlist is closed unread. **Page text is framed as untrusted content** — a portal is not a trusted party and a spoofed one is not a party at all — and a page carrying several identifiers is withheld entirely rather than redacted, because masking identifiers does not make the names and diagnoses around them safe to keep. `portal_screenshot` is how those pages get reviewed: the image goes to a file a person opens, not into the transcript. Every action is approval-gated and written to an append-only `portal_actions` log.
**Pre-submission gate** — `presubmit_check` runs the structural scrub, the compliance pack, this practice's own denial-risk history and (optionally) the E/M level against the documentation, and returns **hold, review or clear**. Three values rather than two on purpose: a binary gate becomes a rubber stamp, because everything not blocked reads as approved and the borderline cases go out with the clean ones. "Clear" means *nothing that ran* found a problem — any check whose dataset is not installed is listed at the top as a blind spot, before the verdict, because turning an absence of information into a statement of safety is worse than having no gate at all.
**E/M level risk** — `em_level_risk` compares a billed code against what the documented MDM supports **in both directions**. Above the note is upcoding: a False Claims Act exposure, and two levels apart is a different claim rather than a scoring disagreement. Below the note is undercoding — not a compliance problem, but revenue earned and not billed, and the more common finding in an audited population. Reporting only the first direction teaches defensive downcoding, which pulls a practice under its own peer benchmark and invites the audit it was avoiding. Neither is an instruction to change the code: the record decides the level, and where they disagree the answer may be that the record is incomplete. It refuses to compare across the new and established ladders, since 99204 and 99214 are the same level for different patient types.
**Assistants** — `em_calculate` (2021 MDM E/M leveling), `appeal_draft`, `abn_generate`. `appeal_draft` will not write a letter containing an unverified policy identifier: any citation shaped like an NCD, LCD, article, transmittal or CFR section must be looked up first and the call must set `citations_verified`. See *Grounding* below for why.
**Analytics & prediction** — `analytics_query` (denial rate, top CARCs, per-payer KPIs from parsed 835s), `denial_risk_score`. `kpi_dashboard` computes the three executive numbers, each with the failure mode that usually makes them lie. **Net collection rate** is measured only over claims old enough to have finished paying (120 days by default): including recent ones counts their charges while their payments are still in flight, which is how this metric gets computed once, disbelieved and abandoned — and it refuses rather than printing a figure over an open window. Its denominator is charges minus *contractual* adjustments only; patient responsibility stays in, because excluding it reports a flattering rate for a practice that never chases a patient balance. **Clean claim rate** is two numbers, not one: front-end acceptance (did the clearinghouse take it) and first-pass payment (did the payer adjudicate it without a denial). Both are called "clean claim rate" in the industry and a practice can run 98% on the first and 70% on the second — a blended figure hides which half is broken. Only the *first* outcome per claim counts, or fixing a rejection and resubmitting would raise the score. **Days in A/R** divides by daily charges over the trailing quarter, and when less than a quarter of history exists it uses the real span and says the comparison is not like-for-like — dividing 30 days of charges by 90 would roughly triple the reported figure.
**Deposit reconciliation** — money in an 835 moves at two levels: the claims say what was decided about each bill, and the `PLB` loop says everything the payer did to the *cheque* that belongs to no claim on it — a recoupment of something paid three months ago, interest owed, a levy, a balance carried forward. `era_reconcile` ties them together on the one equation an 835 balances on, `BPR = Σ CLP04 − Σ PLB`. **The sign is the whole risk**: in X12 a positive PLB amount *reduces* the payment, and getting it backwards turns a $4,000 takeback into a $4,000 credit — invisible, because both directions produce a plausible number. It is encoded once, in `checkEffect`, and tested in both directions. **A residual is reported with its figure, never absorbed**; silently balancing it is how a real discrepancy becomes a rounding line. **`FB` is not a takeback** — a forwarding balance carries to the next remittance and will arrive, so counting it as lost understates cash. The posting file carries signed PLB rows, so `era_export` now sums to the deposit rather than to the claims alone, and net collection rate nets recoupments out of collections: a recoupment tied to a claim in the settled cohort is subtracted, one tied to a claim outside it is **counted and named rather than netted**, because subtracting money from a cohort it was never part of understates the rate as surely as hiding it flatters one. `credit_balance_recoupments` finds open credit balances the payer already took back through a `WO` — refunds the ledger is waiting to send that will never be sent. It reports and does not resolve: closing a 60-day report-and-return obligation is not something to do from a parse.

**CMS-1500 grid** — `claim_form_1500` renders a claim as the 02/12 form with every scrub finding attributed to the box it belongs to: 24A dates, 24B place of service, 24D procedure and modifiers, 24E diagnosis pointer, 24G units, 33a billing NPI. **The box numbers are the real ones or there are none** — a grid with an invented "box 24K" teaches a field that does not exist and gets quoted back to a payer, so fields the system does not hold (box 9, box 23, box 32) are absent rather than shown blank, because a blank box on a form reads as *we checked and it is empty*. Attribution is computed server-side in `src/views/cms1500.ts` where it is tested; the browser paints what it is told. A finding whose rule maps to no box, or whose line cannot be recovered from its message, is **listed below the form rather than pinned to a plausible-looking field** — highlighting the wrong row on a form reads as an assertion about that service. Box 21 uses letters A–L, as the paper form does, and the browser run caught the defect worth catching: a claim listing three diagnoses and pointing at 5 rendered `E`, an ordinary-looking letter for a row that does not exist — the dangling pointer made invisible by the form built to expose it. It prints `5?` now.

**Appeal canvas** — `appeal_draft` gained a canvas view, and deliberately **not an editor**. The plan called for one; reading the tool showed that was the wrong build, because it already writes a Markdown file into the workspace — persistent, diffable, and openable in whatever the practice uses. A `contenteditable` panel would be a second copy whose changes vanish on refresh, and an editor that silently loses work is worse than none. So the canvas reads and prints, names the file that is the real artifact, and puts the one thing prose buries where it cannot be missed: **unverified citations are a HOLD, not a footnote.** Sending is the irreversible step, and the risk is not that the appeal fails — it is that a fabricated policy identifier goes to a federal payer over the practice's name.

**Provider productivity** — `wrvu_report` became computable only once the MPFS relative value file was installed. It sums **work RVU and never total**: compensation formulae are written against work RVU, and total is work + practice expense + malpractice, roughly double, so quoting it inflates every figure in a compensation conversation while looking entirely plausible. Units multiply. A code absent from the fee schedule is **excluded and named**, never counted as zero — unpriced work is still work, and a silent zero looks exactly like a quiet month, so the totals are stated as a floor. A `TC` line contributes nothing, because the technical component is the scanner rather than the physician. Modifiers that change the *share* of work — assistant surgeon, co-surgery, bilateral, surgical-care-only — are **counted and named but not applied**: the correct percentages are payer-specific and are not held here, so those lines are flagged as an upper bound rather than silently overstated. Where claims carry no rendering NPI the report says loudly that a whole group has been credited to one number. Two defects came out of running it rather than reading it: narrowing to one NPI left the header totals unrecomputed (a summary of 27.44 above a single row reading 21.91), and the last column printed the *clinic's* name against a rendering NPI, which reads as an identification the 837 does not contain.

**Tool-selection eval** — `aetheraclaw eval` measures the thing a passing unit suite cannot: whether the model reaches for the right tool. It exists because a user watched this system reply *"I don't have any tools that can inspect Ollama telemetry, evaluate dataset health, or verify the integrity of the underlying tenant database"* when all three existed, deferred behind `tool_search`. The system prompt was patched and **nothing measured whether the patch worked**. Cases run against the configured provider with the same `selectTools` split production uses; only `tool_search` and `tool_describe` execute, every domain tool is stubbed, because what is measured is which tool was reached for. Scoring is tool selection alone — judging prose needs a judge model, which would make the harness as unreliable as the thing it measures.

**Measured on `gpt-oss:120b` (Ollama Cloud, 64 direct / 147 deferred): 10 of 14.** The regression case passes — the model now searches, describes and invokes all three ops tools. The four failures are one pattern, and it is not the one the prompt was patched for: on *"we were denied for timely filing"*, *"does this payer require prior authorization for 27447"* and *"the payer has not acknowledged claim CLM-4417"* it called **nothing at all** and answered from memory. The patch cured false refusal; it did not touch false confidence, which is the same error facing the other way. That is the finding, and the cases are not being tuned until it passes.

**Contract variance** — `contract_rate_set` / `contract_rate_list` record the practice's signed fee schedule, adding a third basis to `payment_variance`. It is the only one that supports "you allowed less than the agreement says": Medicare is not what a commercial payer owes, and a payer's own median describes its habit rather than its obligation — a payer that has underpaid a code since the contract was signed has a median that *is* the underpayment. Rates are dated and selected by **date of service** read from the stored claim, not by remittance date, because an amendment is normally why a payment changed. A source citation is required, since a rate nobody can trace to a signed schedule cannot support a recovery claim. Payer names match on case and punctuation only and never fuzzily — "Aetna" and "Aetna Better Health" are different contracts. The output reports how many billed codes the table could speak to at all, because a contract basis covering 12 of 80 codes finds few underpayments and reads as a clean bill of health. **Known limit, stated on every run rather than buried here:** the table holds one *flat* allowed amount per code, date and modifier. Carve-outs, per-diems, percent-of-charge, lesser-of and case rates are not representable, and against a contract carrying any of them a "shortfall" is a confidently wrong number — worse than no number, because it names a figure and a payer and invites somebody to dispute it.
**🚩 Flagship — Adversarial Payer Twin** — `payer_twin_adjudicate` role-plays the payer and tries to deny your claim before submission, grounded in a per-payer playbook built from your own remittance history plus the notes calibration has written about where the twin was wrong before. **Predictions are stored**, so `twin_calibrate` scores them automatically when the real remittance arrives rather than requiring anyone to re-type what was predicted — which in practice is why twins never get scored at all.

`claim_gauntlet` runs the real loop: the twin attacks, a biller model applies the remediation, the twin attacks the corrected claim, until it survives the required consecutive clean passes. The interesting part is what it refuses to call a fix. The loop optimizes for *the twin stops objecting*, and there are two ways to reach that which are not fixes — the claim never changed (the model just answered differently), or **the claim changed by billing more**. Raising an E/M level or adding a distinct-service modifier makes a bundling or necessity objection disappear, and if the record does not support it that is upcoding manufactured by an automated loop. Both are detected structurally: every change between rounds is classified as revenue-increasing, neutral or revenue-decreasing, and a run that converged by billing more is reported as needing the chart rather than as a finished claim.

`twin_calibrate` reports **denial recall** (of the claims the payer denied, how many the twin warned about — what it is *for*) and **precision** separately from accuracy, and says outright when accuracy is only reflecting the base rate: on a book that denies 10% of claims, a twin that never warns about anything scores 90%. It also checks whether stated confidence tracks being right, and says to ignore the confidence label when it does not. Misses become playbook notes the twin reads next time, kept visibly separate from the payer statistics so it stays clear which lines are evidence and which are corrections. `twin_self_heal` takes a claim the payer actually denied and drafts an analysis against what the twin predicted beforehand — a draft only, nothing corrected or resubmitted.

**Autonomous RCM swarm** — `swarm_track` puts a claim on a blackboard that holds one row per claim, so there is a single answer to where it is rather than a stage inferred from whichever table was written last. `swarm_pipeline` prints the whole state machine: thirteen stages, the specialist that owns each one (coder, scrubber, submitter, denial fighter, auditor, treasurer), and which moves stop for a person.

**Those stops are structural, not settings.** Submitting a claim, sending an appeal, and writing off or abandoning a denial send something outside the practice under its name or give up money — none of them advance on their own in any mode, including autopilot, because a setting that can turn off a safety property is a safety property that is off. Code selection stops too: it is the coder's legal responsibility, so the swarm's job at that stage is to put work in front of a person, not to decide. `swarm_advance` refuses those transitions outright when asked to take them automatically, and records the name of whoever does take them.

The danger in an unattended pipeline is not a wrong action — a human working a queue makes a wrong call occasionally and catches it on the next one. A dispatcher makes the same wrong call four hundred times before anyone looks, and four hundred identical bad claims is not four hundred mistakes, it is one mistake and a compliance event. So `swarm_plan` shows what a run *would* do before any of it is done, under limits that bound blast radius rather than correctness: a cap on claims per run, a cap on attempts before a claim is parked for a person instead of retried forever, and a halt when several *distinct* claims fail the same way. Failure text is normalized past claim numbers, amounts and dates so the shape of the failure is what gets compared — one claim retried three times is one problem, three claims failing identically is a broken rule or a changed payer, and the run stops before advancing anything else. Claims beyond the run cap are reported rather than silently dropped, since a queue that quietly stops at twenty-five looks identical to a queue that finished. `swarm_history` is append-only: an autonomous pipeline that cannot say what it did and who authorized it is not one anybody should run.

Autonomy is tiered in config — `swarm.mode: "off" | "assist" | "autopilot-with-checkpoints"`, defaulting to **off**. In assist mode the swarm names the next step for every claim and takes none of them.

**Regulation as code** — payer policy arrives as prose and gets applied as arithmetic, and the gap between those two is where compliance programs actually fail: someone reads an LCD, tells the billing team what it says, and eighteen months later nobody can name the sentence a scrub rule came from or say whether it still exists. `policy_compile` reads a coverage document and drafts executable rules from the sentences that state obligations — covered-diagnosis lists, frequency limits, required modifiers, place-of-service restrictions, exclusions. **Every rule carries the paragraph it came from, quoted.** That changes the review question from "does this rule look right" to "does this rule match this text", which is a question a coder can actually answer, and it is what makes the rule re-checkable when the policy is revised. A rule that loses its source is skipped by the evaluator rather than trusted.

It is a drafting aid, and the honest part is what it reports failing at. **Obligations the compiler could not encode are listed alongside the drafts** — a silent skip is the dangerous outcome, because the reviewer accepts nine rules, believes the document is covered, and the tenth paragraph is now unrecorded exposure. Drafts are inert: `policy_rule_review` is what makes one live, a rejection needs a reason, and every decision goes to the audit log. Medical-necessity rules are checked against the diagnoses **the line points at**, not every diagnosis on the claim — a claim-level check would pass exactly the claim the payer denies. Period limits that need history say so when there is none, rather than reporting a limit as satisfied when it was never looked at.

**Compliance sentinel** — `sentinel_run` samples your own claims and audits them the way a contractor would, through the same scrub the practice already uses plus the priority areas that need the whole sample: E/M on the same day as a minor procedure in **both** directions (with modifier 25 the record has to support it; without it the E/M is bundled and should not have been paid), distinct-service modifiers, highest-level E/M, and new-patient codes for patients seen inside three years — a cross-claim error a per-claim scrub can never see.

The statistics are the substance. An internal audit reporting "2 of 30 claims had findings, so our error rate is 6.7%" is worse than no audit: 2/30 is consistent with a true rate from about 2% to about 21%, and the practice has written down a number it will be held to. So every rate carries a Wilson interval, and exposure is **refused** below 30 sampled claims rather than produced with a caveat nobody reads. Where a figure is given it uses the lower bound of a one-sided 90% interval — the same conservative basis CMS extrapolates from, deliberately favouring the provider. The **50% line is reported separately from the measurement**, because a contractor may not extrapolate an overpayment across a whole population unless it finds a sustained or high level of payment error, and "high" is defined as 50% or greater: 3 of 5 measures 60% but proves nothing, and the report says which of those two situations you are in. Samples are seeded and reproducible — a sample nobody can redraw is not a defensible audit — and the population is sorted before drawing so an upstream ordering change cannot silently alter what a recorded seed selects. When errors turn up, the report names the clocks: report and return within **60 days of identifying** an overpayment, where identification is knowing you have one — since the 2024 revision, working out the amount is no longer part of identifying it — with the deadline suspended while a good-faith investigation into related overpayments runs, until it concludes or **180 days** from the first identification, and a **six-year** lookback. It files candidates and deliberately starts nobody's clock on its own.

**Tamper-evident audit log** — every rule change, review decision and sentinel run is appended to a hash chain, each entry carrying the SHA-256 of the one before it, verified by `audit_verify` or `aetheraclaw audit verify` (non-zero exit on failure, so it can gate a cron job). Payloads are hashed rather than stored: the log has to prove what happened without becoming the largest store of claim data in a system that is not approved for PHI.

Be exact about what that buys, because the usual claim is wrong. It is tamper-**evident**, not tamper-proof. The chain lives in the same SQLite file the application writes to, and anyone who can edit that file can change an entry and recompute the rest to match. What the chain alone catches is corruption, a row edited with a SQL client, a deleted entry — reported as four distinct failures, because a recomputed-hash mismatch, a broken link, a gap and an anchor mismatch mean different things. **`audit_anchor` is what makes the guarantee real**: it records the head hash and writes a witness file to publish somewhere the application cannot reach back into. Verification checks the chain against every anchor, so a consistent rewrite of history — which the chain by itself verifies happily — is caught. `audit_verify` says how many entries fall after the newest anchor, and says plainly that an unanchored log proves nothing against the person an audit log exists to constrain.

**Practice revenue digital twin** — `revenue_model_fit` builds a model of the practice from its own claims and remittances: payer mix, collection ratio, denial rate, patient share, and how long each payer actually takes to pay. The timing fit is the part that matters. Fitting payment lag only from claims that *have* a remittance fits only the claims that paid — the slow ones and the never-paid ones are sitting in AR, excluded from the sample, pulling the estimate down. A practice gets told it collects in twenty-four days, and that is the number somebody makes a payroll decision on. So outstanding claims are carried into the fit as **right-censored observations** and the curve is a **Kaplan–Meier** estimate, which also hands the forecast the two things it needs directly: the probability a claim has paid by day *t*, and the plateau the curve settles at — the share that never pays at all. Payers with too little history borrow the practice-wide curve and are told so rather than being quietly averaged in. A fitted Medicare curve with real mass below day 14 is reported as **broken rather than fast**: a clean electronic claim sits on a 13-day payment floor, so beating it means the claim-to-remittance join or the date anchor is wrong.

`cash_forecast` simulates forward as a range, not a number. Claims already in the book are drawn from the *remaining* part of their curve — a ninety-day-old claim is not a fresh one, and treating it as one forecasts the oldest and most doubtful receivables as the soonest. Insurance and patient cash are separate lines, because a dollar assigned to a patient is not a dollar collected and it arrives much later and incompletely. Each path draws a **per-payer shock before it draws any claim**: sampling claims independently makes the total collapse to a very tight band by the central limit theorem, which is how a forecast comes to look confident and be wrong — real cash moves in blocks when a payer's system goes down for three weeks. The bands are still labelled a **floor on uncertainty** rather than a range, since a clearinghouse outage or a bad quarter across the whole book is not modelled either.

`simulate_scenario` runs the what-ifs — drop a payer, change rates or volume, add a provider, move the denial rate. **Scenarios change work not yet done.** Dropping a payer does not stop their cash tomorrow: every claim already submitted still pays out on the fitted curve, so the forecast shows the point where that tail runs dry rather than a cliff that does not exist. The same asymmetry is the entire reason to ask about a hire — the charges start on day one and the cash starts a lag-curve later, so the tool names the gap ("full productivity at day 90 means full cash near day 126"). It also reports the day the two forecasts start to separate, and says outright when a change does nothing on the horizon asked about. `forecast_chart` writes a fan chart as a self-contained page — the band drawn as a widening envelope, because the band is the finding and a single line is a lie told with a pen.

**Patient balances** — `patient_outreach_plan` scores each account and says what to do with it. The guard against this becoming a discrimination engine is the **type, not a policy**: `PatientAccount` has fields for what the account has done — payments made, plans kept or broken, balance size and age — and no field for age, sex, race, ZIP, language or credit data, so no caller can supply one. Routing sends work to help as readily as to collections: a large balance from someone who has never paid is the profile of a person who *cannot* pay, and reading that as "escalate" gets the answer backwards and loses the money. Large unscreened balances go to **financial-assistance screening before a demand**; balances under $25 are written off because chasing them costs more than they are worth. One rule overrides the score entirely — **nothing is billed while insurance has not finished**, because that balance is not the patient's yet. `patient_letter_draft` writes in plain language: what the service was, what insurance did, what is left, and the options including a payment plan and assistance, since a patient who does not know they can ask does not ask. No threats, no invented deadlines, approval-gated, and it stays a draft until a person sends it.

**Voice & telephony** — the module where getting it wrong is a crime rather than a denial, so two legal questions are kept apart because they have different answers and different sources of law.

**May this number be called?** `call_policy_check` refuses patient calls outright. An AI-generated voice is an "artificial voice" under the TCPA — [the FCC said so in February 2024](https://www.fcc.gov/document/fcc-makes-ai-generated-voices-robocalls-illegal) — which puts an AI calling a patient inside the prior-express-consent regime with per-call statutory damages, and a patient call cannot avoid discussing their account. `patient_letter_draft` exists for that. Payer business lines are a different footing, and the agent still opens by saying it is automated: a representative is entitled to know whether the thing asking them for a claim adjustment is a person.

**May it be recorded?** Twelve states require every party's consent, and recording without it there is a criminal offence rather than a compliance lapse. For an interstate call the **stricter end governs** — which state's law applies to a call crossing a line has been decided both ways, so the only posture safe in every forum is the strict one. Michigan and Nevada are treated as all-party because their statutes and their courts disagree, and "we relied on the more convenient reading" is not a defence. Recording is **off by default**, refused outright when either end of the call is unknown, and the Twilio `Record` parameter is always passed explicitly rather than left to a default.

**Navigating the tree.** `payer_call_navigate` never guesses, because a wrong digit does not fail — it succeeds into the wrong queue, waits twenty minutes, and reaches somebody who cannot help. A real IVR reads its whole menu in one breath, so **the intent decides and the prompt confirms**: the caller says what it is trying to reach, the learned map says which digit that is, and the menu is checked to confirm it still offers it. A menu that stopped mentioning the thing being asked for is a tree that changed, and that is counted as a miss; a refusal because nobody said what they wanted is not, so ordinary calls never age a good map toward stale. Only single menu keys may be pressed from a chat turn — a member ID or tax ID is entered by the tool layer from the claim on the call, because a model-produced identifier can be plausible and belong to somebody else, and an IVR accepts it without comment.

**Hold, human, or a mailbox.** `payer_call_listen` tells hold from a person by **repetition** rather than by silence: a hold loop says the same sentence in the same words every ninety seconds, and a person does not. Voicemail is checked *before* a person, because a recorded greeting sounds exactly like one and the cost is one-sided — talking to a mailbox discloses a claim to an unattended recording the practice does not control. Hold time is measured, and past twenty-five minutes the tool says a callback is cheaper than the rest of the queue.

**What the call was worth.** `payer_call_end` extracts the outcome, and the thing it cares most about is the **call reference number** — the only part of a conversation that survives it. "We have no record of that call" is the standard answer to an appeal resting on one, and it is unanswerable without a reference. So a call that ended without one is reported as unprovable, in those words, and `call_history` counts them. A local **IVR simulator is the default provider**, with a scripted tree that holds, loops, and reaches a representative who does not volunteer a reference number until asked — because a real payer call means saying a member ID out loud, and this build is not approved for patient data.

**Value-based care** — a RAF score is a payment multiplier built from diagnoses, which makes it the one number here where coding harder directly raises revenue. That is why the Department of Justice has spent a decade extracting nine-figure settlements over it, and why every function in this module is built to be defensible rather than to maximise.

`raf_calculate` breaks the score into terms that can each be defended alone, because a RADV audit asks about one condition rather than a total. It applies the **hierarchies** — within a hierarchy only the most severe condition counts, so coding both forms of a disease does not pay twice — and reports what was suppressed instead of dropping it quietly, since a coder who cannot see why a code stopped counting will code it again. Coefficients come from an installed CMS dataset; nothing here invents them, because a made-up RAF looks exactly like a real one. CMS-HCC **v28 is at full weight from payment year 2026**, and it dropped about 2,000 codes that mapped to an HCC under v24 — a practice still working from a v24 crosswalk is coding conditions that now carry no weight at all.

`hcc_recapture` is the part that works from claims you already have. HCCs **do not carry forward**: every chronic condition must be documented in a face-to-face encounter and coded again in each calendar year, so a patient's diabetes does not stay on the books because it was coded last March. That reset is the largest *legitimate* source of missed revenue in value-based care — the condition is real and was documented, and nobody re-coded it. Gaps are grouped by condition rather than by code, so a patient coded E11.9 last year and E11.65 this year has recaptured it and no coder is sent looking for finished work. Patients seen this year (a chart review) are separated from patients not seen at all (a scheduling problem, where no amount of chart review creates an encounter), and the countdown to 31 December is printed because there is no late filing for a risk score.

`suspect_conditions` is the compliance-critical one, and it has a structural property the usual product does not: **it looks both ways**. Every run reports conditions documented but not coded *and* conditions coded with nothing found to support them, produced by the same pass so a practice cannot run only the profitable half. A tool that can only ever propose additions is an upcoding engine whatever its documentation says, because the only direction it can move a risk score is up. Each proposal carries the sentence it came from and which of Monitor/Evaluate/Assess/Treat that sentence actually supports; a condition named in a history with nothing addressing it is reported as a **mention that must not be coded**, which is the specific thing an audit removes first. The evidence is taken from the strongest note in the chart rather than the first one read, and nothing is ever coded — proposals go to a coder who accepts or rejects with a reason, required on acceptance too, because "the tool suggested it" is not an answer to an auditor. Whether RADV findings may be extrapolated across a contract is stated as **unsettled**, since the rule permitting it was vacated in September 2025 and is under appeal; assuming it dead invites sloppiness and assuming it alive overstates a live question.

`quality_measures` computes MIPS/eCQM rates from claims and separates the two things a low rate can mean. A clinical value reaches a claim only as a **CPT Category II code**, so a practice that controls blood pressure well but never submits 3074F is indistinguishable in claims from one that never measured it. Denominator patients with no Category II code either way are counted separately, and the rate among patients who *were* reported on is shown beside the headline — which is usually what tells you whether a bad measure is care or paperwork. Inverse measures are labelled so they are not read backwards.

**Price transparency** — payer Transparency in Coverage files and hospital machine-readable files are public, and they are also tens of gigabytes each. `JSON.parse` on one is not slow, it is impossible: the string alone exceeds what a process can hold. So `rate_ingest` never holds the file. It scans as the bytes arrive and emits one in-network record at a time, with peak memory bounded to the largest single record — a 520 MB test file streams through at about 1 KB of buffer. The filter is the point: a payer file covers every code for every provider in the network, a practice bills a few dozen, and `use_billed_codes` takes that list from your own remittances. The trap that breaks every first attempt at this is brace counting — a record naming `Removal of foreign body {see note}` closes early under a naive depth counter and everything after it is misaligned garbage that still parses often enough to look like it worked — so strings and their escapes are tracked explicitly, and the chunk boundary is allowed to fall anywhere, including mid-escape.

`rate_benchmark` segregates before it compares. **A `negotiated_rate` of 250 means $250 under one negotiated type and 250% of Medicare under another**, and averaging them produces a number that is neither while looking entirely plausible; a professional rate and a facility rate for the same CPT price different things. Groups below eight comparable rates are shown as *thin* rather than quoted as a market, because a 75th percentile computed from four rates invites exactly one question in a negotiation and there is no good answer to it. Every output repeats that the providers behind a published rate have to be comparable in setting and size — an academic medical centre's rate says nothing about what a solo practice should be paid, and that is the first thing the other side will say.

`rate_position` compares your own allowed amount **per unit** (a published rate is a unit price; a line's allowed amount is that price times its units) and says plainly when a code is already top-quartile, since a negotiation spent on a code you are well paid for is a negotiation wasted. `negotiation_brief` ranks by **dollars at stake rather than by the size of the gap**: a 40% gap on a code billed twice a year is not an agenda item, and a 6% gap on the code you bill four hundred times is.

**No Surprises Act disputes** — `idr_evaluate` treats federal IDR as what it is, an economic decision before a legal one. It is **baseball arbitration**: one offer each and the arbitrator picks one outright, so the number to submit is the highest the evidence fully carries rather than the highest you would like — an unsupported offer beside a supported one loses everything rather than landing halfway. And the loser pays the arbitrator. The June 2026 operations rule cut the administrative fee from $115 to $15 per party, which moves the whole decision onto the arbitrator's fee: $200–$840 for a single determination, $268–$1,173 for a batch of up to **50 line items**. That makes batching the biggest lever there is — the same $300 claim is clearly not worth filing alone and clearly worth filing batched, and the tool computes the break-even. The verdict is taken at the **top** of the fee range on purpose: which arbitrator you get is not something you control, and a decision that only works with the cheapest one is not a decision. Deadlines are all in business days, where they get missed — 30 business days is six calendar weeks — including the portal response the June 2026 rule newly requires by the 15th business day, the four-business-day initiation window with no late filing, and the 90-day cooling-off period that, when it swallows the negotiation window, extends initiation to 30 business days instead.

**Prior authorization (Da Vinci CRD / DTR / PAS)** — two CMS-0057-F dates matter and they are a year apart. The FHIR Prior Authorization API is due **1 January 2027**, and that is the part everyone talks about. But the **decision timeframes have been in force since 1 January 2026**: an impacted payer owes a decision within **72 hours** on an expedited request and **seven calendar days** on a standard one, whether or not anybody has built an API. That is the part a practice can hold a payer to today, so `pa_submit` and `pa_status` compute the deadline rather than chasing an endpoint. The units differ on purpose and getting them wrong is the whole mistake — 72 hours is measured to the hour, and reading it as "three days" hands the payer until the end of day three on exactly the requests where somebody is waiting for care. A decided request is measured against **when it was decided**, not against now, so settled rows do not drift further overdue every day they sit in the table. Worth stating because the obvious reading of HIPAA Administrative Simplification is the opposite: X12 278 is named as *the* prior-authorization transaction, but CMS granted enforcement discretion for an all-FHIR API that does not use it. Both routes are live and a payer may be on either.

`pa_requirement_check` answers "does this need authorization" from a local rule table, and keeps **unknown distinct from not_required**: a practice that has never been denied for a code has no evidence the code is exempt — it may simply never have billed it — and collapsing the two is how a service gets rendered without an authorization it needed. `pa_rules_learn` builds that table from your own remittances, because **every CARC 197 is the payer stating on the record that a service needed an authorization it did not have**; it is the most reliable PA list a practice can get, at the cost of one denied claim per entry. When a payer's CRD service does answer, its cards are read for the two actionable facts and passed through verbatim otherwise — a summary of a coverage statement is not a coverage statement — and the negations are matched as carefully as the positives, since "does not require prior authorization" is about the most common way a payer says no.

DTR is where the saving and the hazard are the same mechanism. A prior authorization is a statement to a payer about a patient, so **an autofilled answer that is wrong is a false statement that nobody typed and nobody read** — the clinician signed a form whose answers appeared on their own. So `dtr_prefill` attaches provenance to every filled answer, names what it could not fill instead of leaving the form looking complete, and refuses outright on questions asking for a clinical assertion: medical necessity, failure of conservative therapy, anything phrased as an attestation. A choice answer outside the payer's option set is left blank rather than mapped to the nearest one, because choosing the nearest option would be the tool making a clinical answer. Answers a clinician supplies are recorded as *theirs*, not as prefilled, and nothing is emitted as a QuestionnaireResponse until nothing required is outstanding.

`pa_submit` builds the PAS bundle, where `use: "preauthorization"` is the single word that makes it a request rather than a bill — the same Claim resource carries both. Reading the response, **partial approval is the case that gets missed**: the outcome says approved, the authorization number is there, and one of four requested services was quietly refused, so per-service dispositions are read individually. An approval with no authorization number is flagged as authorizing nothing, and a payer error naming something absent from the FHIR request is called out as having happened in the X12 278 leg the practice never saw.

**Agent-to-agent** — `a2a_open`/`a2a_send` give claim negotiation a structured protocol, and the load-bearing fact is that **an agreement between two agents is not a payment determination**. Nothing here moves money; money moves when the payer's adjudication system produces an 835, and that system does not read this protocol. So the outcome is non-binding in the type, every rendering says so, and `a2a_reconcile` against the real remittance is part of the module rather than left as an exercise — an agreement the payer then underpays is the strongest appeal evidence a practice can hold, and it is only evidence if somebody checks. A party cannot accept its own offer: one side writing down a number and calling it agreed is a note to itself, and it is trivially easy to produce by accident when both sides are agents in one process.

Attestations are signed with a local Ed25519 key and anchored to the audit chain, and the claim made for them is deliberately small. A valid signature proves that **whoever holds the private key produced these exact bytes** — not that the statement is true, and not that the signer is who the attestation says. A signed false statement is worse than an unsigned one because it is now attributable. Identity comes from a key exchanged out of band beforehand, so `a2a_verify` checks against a roster and reports **signature validity, key trust, and the audit anchor as three separate answers**; a valid signature from a key nobody had is reported as unknown, which is emphatically not the same as verified. The private key lives unencrypted in the database file and the tool says so when it generates one.

**Documentation-native CDI** — `cdi_analyze` reads de-identified documentation and finds where the record is less specific than the patient: laterality left open, heart failure named without systolic or diastolic, a manifestation not linked to its cause. Every finding carries the sentence it came from **verbatim, with its character offset**, so a reviewer lands on the exact text rather than on the note. Two properties keep it on the right side of a line that matters here. It **never proposes the more specific code** — offering "you probably meant the left knee" and collecting a click is a leading query wearing a code suggestion's clothes, and the code that comes out is indefensible even when it was right. And **unspecified is frequently correct**: if the provider does not yet know which side, the unspecified code is the accurate one, so nothing here says the documentation is wrong. Findings are ranked by whether clarifying them changes anything, and a gap found in a sentence with no Monitor/Evaluate/Assess/Treat evidence behind it is called out as one a provider would rightly ignore.

`cdi_query_draft` is a **checker before it is a builder**. A query that names a financial or scoring consequence, instructs the provider what to document, invites agreement with a conclusion it has already drawn, or offers a menu with no way off it is **refused rather than emitted with a warning** — a warning on a leading query is a leading query. Escape options ("other, please specify", "unable to determine", "not clinically significant") are appended automatically, because the failure they prevent is one of omission. Yes/no format is held to its narrow use: verifying a diagnosis already documented somewhere in the record, never introducing one, and always with "unable to determine". This applies in full to a query a machine wrote — the 2026 draft of the practice brief says so directly. Which version governs is stated in every check: the **2022 Update is operative**; the 2026 Update's public comment closed 12 June 2026 and the rules applied here are the ones common to both.

`cdi_query_from_finding` generates the query, and the reason it can be generated at all is that **the options come from the axis, not from a guess at the answer**. "Left / right / bilateral / unable to determine" is exhaustive and carries no preference; a query built around the answer the tool believes is right cannot get that property back by rewording. A recorded answer cannot be quietly replaced either — overwriting one needs a stated reason and keeps the first, because a record showing only the final response is what re-querying until the provider agrees looks like from the outside.

`greenlight_check` answers one pre-service question — can this be rendered today without creating a claim that will not pay or a bill nobody warned the patient about — from eligibility, prior authorization, coverage and cost together. It **fails closed**: "we could not determine whether this needs authorization" is a STOP, not 70%, because a clearance product that scores unknowns in the middle produces a number that reads as mostly fine and the service gets rendered. There is deliberately **no percentage**, since a blocker cannot be outweighed — three clean checks and a terminated policy is not 75% clear. Staleness is caught two ways, and the second is the one that bites: a verification can be well inside thirty days and still be from *last calendar month*, which is when commercial coverage terminates. An authorization that expires before the service date denies exactly like no authorization. And the cost line prevents the most common front-desk error there is — under an unmet deductible the patient owes the allowed amount, not the copay, and the tool says how much collecting the copay would under-collect by.

**Coder training** — `training_drill` draws cases weighted toward what the practice actually bills, since that is what makes them relevant, and **names what that weighting misses**: a bank shaped by the practice's history cannot ask about anything the practice has never billed, and a fifth of every draw is spread evenly across topics so the rare ones stay genuinely reachable rather than reachable in arithmetic. Cases carry **defensible alternatives**, because real coding has genuine ambiguity and grading one right answer where two coders would both survive an audit teaches a coder to distrust a correct instinct. Every answer is given with a stated confidence, and `training_progress` reports **calibration beside accuracy** — a Brier score, plus the specific list of answers that were wrong at high confidence. That list is the point: the coder who costs a practice money is not the one who gets things wrong, it is the one who gets things wrong confidently, because nobody double-checks a coder who never flags anything. Topics with few attempts show their Wilson interval instead of a number, since three attempts is not a skill level.

## Running it

It runs on your own machine — there is no hosted instance. `127.0.0.1:4180` only answers on the box where you started the gateway.

```bash
git clone https://github.com/kk078/AetheraClaw.git
cd AetheraClaw
npm install
npm run build
```

Set a key for whichever provider you want, then start it:

```bash
# macOS / Linux
export OLLAMA_API_KEY=...            # or ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY
node dist/cli/index.js serve --provider ollama --profile coding
```

```powershell
# Windows PowerShell
$env:OLLAMA_API_KEY = "..."
node dist\cli\index.js serve --provider ollama --profile coding
```

Then open **http://127.0.0.1:4180**. The gateway serves the web UI and the API from the same port. For a terminal REPL instead, leave `serve` running and open a second shell: `node dist/cli/index.js chat`.

**No build toolchain required.** SQLite comes from `better-sqlite3` when it is already installed and from Node's built-in `node:sqlite` otherwise, so a machine with no C++ compiler runs the same code. This matters because the native module has no prebuilt binary for every Node release, and when npm falls back to `node-gyp` on a machine without Visual Studio the whole install aborts — taking `tsc` with it, so what you actually see is `'tsc' is not recognized` and `Cannot find module dist\cli\index.js`, three steps downstream of the real cause. `better-sqlite3` is an optional dependency now; if it fails to build, npm carries on and the app uses the built-in driver. `serve` prints which one it got. Node **22.5 or newer** is required, since that is when `node:sqlite` arrived.

Windows notes: the build and the gateway are cross-platform, and `run_command` uses `cmd.exe` there rather than bash.

Two things worth knowing before you pick a port. **4190 will not work**: it is on the WHATWG fetch blocked-port list, so the server binds fine and every browser request dies with `ERR_UNSAFE_PORT`. And Node's `fetch` ignores `HTTPS_PROXY`, so behind a corporate proxy the provider SDKs fail where `curl` succeeds — there is no proxy support in the app yet.

Useful commands:

```bash
node dist/cli/index.js providers      # which providers work here, models, tool counts
node dist/cli/index.js sessions       # list past conversations
node dist/cli/index.js audit verify   # check the tamper-evident log
```

## Running on a provider other than Anthropic

`aetheraclaw providers` prints what is usable here — which keys are set, which model each provider is configured for, and how many tools each can actually be sent.

```
aetheraclaw serve --provider openai --profile claims
aetheraclaw serve --provider gemini --profile coding
aetheraclaw serve --provider ollama --profile denials    # local, no key
OLLAMA_API_KEY=… aetheraclaw serve --provider ollama     # Ollama Cloud
```

**Ollama is two services behind one name, so it carries two models.** `providers.ollama.model` is the local one (`qwen3`, whatever `ollama pull` gave you); `providers.ollama.cloudModel` is the cloud one, defaulting to **`gpt-oss:120b`**. Which pair is used follows a single decision — a key with no explicit local base URL means the cloud — so the endpoint and the model can never disagree. That mattered: the two catalogues do not overlap, and picking the URL one way and the model the other sends a real request to a real service for a model it has never heard of, whose 404 names the model rather than the mismatch that caused it. `aetheraclaw providers` prints the resolved pair, `gpt-oss:120b (cloud)` or `qwen3 (local)`, so the answer is visible before a turn is spent.

**All 222 tools are reachable on every provider**, but not by shipping 222 definitions. Three catalogue tools — `tool_search`, `tool_describe`, `tool_invoke` — go on the wire, and everything else is discovered on demand. Ollama Cloud loads 64 directly and reaches the other 158 through the catalogue; `tool_invoke` routes back through the same choke point as a direct call, so zod validation, risk assessment and the approval gate all still apply. It is a way to reach a tool, not a way around it, and there are tests that hold that line.

The cost is a real one and worth naming: discovery becomes a step, and a tool the model cannot find is worse than one that is absent, because it will answer from memory instead. That is not hypothetical — asked what CARC 197 means with `denial_explain` deferred, a model confidently answered "Claim Not Submitted". It means *precertification absent*. So when anything is deferred the system prompt says so and instructs the model to search before answering any question about a code, deadline, payer rule or dollar amount. With that in place the same question produced a `tool_search` → `tool_describe` → `tool_invoke` chain and the correct answer.

**Tool profiles narrow that further, because the registry still does not fit.** 173 tools serialize to about 145 KB of definitions — roughly 37,000 tokens. Anthropic prompt-caches that block, so it is paid for once; nobody else does, so on OpenAI or Gemini it is 37k tokens of input on *every turn*, and on a local Ollama model it exhausts an 8k window before the conversation starts. Worse, **OpenAI rejects any request carrying more than 128 tools outright** — not a degradation, a 400 on every turn. So a session picks one of `coding`, `claims`, `denials`, `revenue`, `operations`, or `all`, each a coherent job somebody actually does; every profile fits inside every provider's ceiling except `all`, which is Anthropic-only and says so. This is not purely a workaround: a model choosing among 173 tools chooses worse than one choosing among 35.

When tools *are* cut to fit a cap, every dropped name is printed. A model that quietly lost `claim_scrub` will confidently proceed without it, and the transcript will read as though it decided not to scrub the claim rather than as though it could not.

Two provider quirks are handled rather than left to bite: **Ollama Cloud** is selected automatically when `OLLAMA_API_KEY` is set and no explicit base URL is configured, because otherwise the failure is `ECONNREFUSED` on port 11434 — which reads as "Ollama isn't running" and sends you installing a local server you did not want. And Ollama's OpenAI-compatible endpoint reads `max_tokens` while OpenAI wants `max_completion_tokens`; sending only the latter to Ollama means it is ignored, so generation runs unbounded. A missing API key is caught at startup with the variable name, not as an SDK stack trace mid-turn.

**Verified live against Ollama Cloud** (`gpt-oss:120b` and `qwen3.5:397b`): streaming, tool calling, tool results fed back, and the full turn persisted. Two things that run showed up that mocks could not. The model's first `claim_scrub` call had the wrong argument shape; the registry's zod layer returned a path-level error and **the model corrected itself on the retry** — the validation boundary is doing real work, not just rejecting. And `qwen3`, then the only default, is a *local* model name — Ollama Cloud returned `404 model "qwen3" not found`, which is what led to the separate `cloudModel` above.

Switching providers mid-session keeps the conversation: history is stored in normalized form, and Anthropic-only blocks (thinking, server-side search results) are dropped rather than replayed to a provider that cannot read them.

**What the live APIs actually give you.** ICD-10 search and validation prefer the locally installed CMS code set, where billable status is CMS's own assertion and the fiscal year is named; without it they call the NLM Clinical Tables API, which needs network and derives billable status from whether the code has children in the returned hierarchy. Either way it is looked up, never asserted from memory. NPI validation is an offline Luhn check; NPI lookup hits NPPES, and a non-2xx throws rather than being reported as "no record" — a network outage must not read as "this provider does not exist". NCD and LCD search work against the CMS Coverage API. Two things do not, and both were found by calling them rather than by testing them: **the Coverage API publishes no state-to-MAC mapping at all**, so `mac_lookup` lists contractors and says to find your binding policy by searching LCDs instead of pretending to answer by state; and the **SAD exclusion list is licence-gated** — it embeds AMA CPT descriptors, so CMS answers 401 until you accept the licence agreement and present a token, which the tool now explains instead of surfacing a bare HTTP error.

Several tools use free public APIs (NLM, NPPES, CMS Coverage) — no keys required. Optional datasets go in `~/.aetheraclaw/data/`: `ncci-ptp.json` and `mue.json` (bundling and unit edits), `icd10.json` (the full ICD-10-CM code set with billable status and its fiscal year), `hcpcs.json`, `mpfs.json` (RVUs), `global-periods.json` (`{"CODE": 90}`) for global-period lookup, `mpfs-cf.json` (`{"cf": 32.35}`) and `gpci.json` (`{"LOCALITY": {work, pe, mp}}`) for locality-accurate pricing, `em-benchmark.json` (`{"99213": 38.2}` percentages, from the CMS *Medicare Physician & Other Practitioners* public use file) for peer E/M comparison, and `hcc-model.json` (ICD-10→HCC mapping, category definitions with coefficients and hierarchies, demographic terms) from the CMS risk-adjustment model files. `code_update_diff` reads code-set editions from the same directory, either as a bare `{"CODE": "description"}` map or wrapped as `{"label", "effective", "codes"}`. CPT is AMA-licensed and supplied by the user via `healthcare.cptDataPath`. Every dataset is optional — tools that need one say so instead of guessing.

## Example

> "Is E11.65 billable? Does Medicare cover it in Texas? Build and scrub a test claim, then run it past the payer twin."

The agent chains `icd10_validate` → `mac_lookup` → `coverage_search_local` → `claim_scrub` → `payer_twin_adjudicate`, citing code and policy identifiers throughout.

## Testing

```bash
npm test          # unit tests: path-guard, shell risk, registry, truncation,
                  # NPI Luhn, X12 837/835 round-trip, claim scrub, E/M, denial codes
```

## Roadmap

The build plan is complete — every module in it is implemented, tested and documented above. What follows is the honest list of what a real deployment would still need, roughly in the order it would matter.

**Before this touches a live practice.** A **real clearinghouse connector** — eligibility and claim submission run through a mock today, and the `ClearinghouseConnector` interface exists precisely so that swap is a config change rather than a rewrite. **PHI mode**: encryption at rest, key management, a redaction layer at every boundary, and a BAA-shaped deployment story. The current posture is not a soft default, it is the design — the system prompt refuses real patient identifiers and every module takes de-identified references — and lifting it is a project, not a flag.

**Making it operable.** Multi-user auth with roles, since a coder, a biller and a practice owner should not see the same surface. Docker packaging. An eval harness for the agent loop and the payer twin, so a provider or prompt change can be measured rather than eyeballed. Model routing, to put cheap models on mechanical work and keep the expensive ones for adjudication and appeals.

**Extending it.** Messenger channels beyond email, on the `Channel` interface the email implementation already proves out. A plugin SDK so a practice can add its own tools without forking. Multi-practice and contract-level modelling, which is where the digital twin and the transparency data would meet.

**Ideas worth building, not yet designed.** A **federated payer-intelligence network** — payer behaviour is the one dataset every practice has and none can build alone, and the interesting question is whether it can be pooled without pooling anything identifiable. A **self-extending toolsmith** that writes and reviews its own tools against the registry's contract. A **Revenue Time Machine** replaying a year of claims under a rule change to price it. A **Contract Negotiation Copilot** joining the price-transparency benchmarks to the practice's own variance history and the payer twin's read of how a given payer actually behaves.

## License

MIT
