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

```bash
npm install
npm run build
export ANTHROPIC_API_KEY=sk-ant-...        # or another provider's key
node dist/cli/index.js serve               # starts the gateway + web UI
# open http://127.0.0.1:4180  — or, in another terminal:
node dist/cli/index.js chat                # interactive REPL
```

`npm run dev` runs the gateway from source via `tsx`.

## Safety model

All tool input is treated as untrusted model output:

- **Approval gate** — mutating shell commands, file writes, and claim/appeal generation require explicit approval (CLI `[y/N]` prompt or web modal). `approvalPolicy`: `always` | `unsafe-only` (default) | `never`.
- **Workspace confinement** — every file/shell path is resolved and verified to stay within the workspace root (blocks `../`, absolute paths, and symlink escapes).
- **SSRF guard** — web fetch refuses private/loopback addresses.
- **Localhost binding** — the gateway binds `127.0.0.1` by default.

## Healthcare RCM tools

**Coding & validation** — `icd10_search`, `icd10_validate` (NLM Clinical Tables), `hcpcs_lookup`, `npi_validate`/`npi_lookup`/`npi_search` (NPPES).
**Coverage & medical necessity** — `coverage_search_national` (NCD), `coverage_search_local` (LCD), `mac_lookup`, `sad_exclusion_check` (CMS Coverage API).
**Claims lifecycle** — `claim_scrub` (code/dx-pointer/NPI/modifier/POS/NCCI/MUE rules + the compliance pack below), `claim_build_837p`, `era_parse_835`, `ack_parse_277ca`, `denial_explain` (CARC/RARC), `reimbursement_estimate` (MPFS RVU).
**Secondary claims & COB** — `ack_parse_277ca` decodes the clearinghouse/payer acknowledgment that arrives *before* adjudication, splitting accepted from rejected claims and translating each status category/status/entity triplet into what is wrong and whose data caused it. A front-end rejection never entered the payer's system: there are no appeal rights, no remittance will follow, and timely filing keeps running — so rejections open worklist items immediately. `cob_determine_primary` resolves payer order and emits the SBR05 MSP type code, covering Medicare Secondary Payer rules (working aged at 20+ employees, disability at 100+, the 30-month ESRD coordination period, workers' comp, auto/no-fault, liability, Black Lung, VA) and commercial coordination (own coverage before dependent, active before retiree/COBRA, and the birthday rule with its court-decree and custodial-parent overrides); when a missing fact — usually employer size — is what decides the answer, it says so instead of guessing. `cob_balance_check` enforces `charge = paid + adjustments` on every line, the arithmetic secondary payers check first and the most common reason a secondary claim is rejected up front. `claim_build_secondary` generates the secondary 837 with the primary's adjudication carried in loop 2320 (SBR, CAS, AMT, OI, DTP\*573) and loop 2430 (SVD, CAS, DTP\*573), extracted from the primary's raw 835 rather than re-keyed, and refuses to emit while the balance check fails.
**Compliance rule pack** — `telehealth_check` / `telehealth_policy_set` (POS 02/10/11 and modifier 95/93/GT/GQ rules, with an editable **per-payer policy table** because payers diverge from Medicare), `global_period_check` / `global_period_record` (global surgical periods with modifier 24/25/57/58/78/79 logic against recorded procedure history), `incident_to_check` (incident-to in the office vs split/shared in a facility, including the modifier FS and substantive-portion rules). All three also run automatically inside `claim_scrub` when a claim carries the optional `compliance` block.
**Eligibility & worklists** — `eligibility_check` (pluggable clearinghouse; mock connector in v1), `worklist_add`/`list`/`update`, `timely_filing_check`.
**Audit & integrity** — `audit_track` / `audit_list` / `audit_update` / `audit_response_draft` (RAC, MAC ADR, TPE, UPIC, SMRC, CERT and commercial audits, with response deadlines and — once a determination lands — the computed appeal-ladder and §935 recoupment clocks), `audit_deadline_calculator` (every Medicare audit deadline from one date), `em_benchmark` (the E/M bell-curve analysis payers use to pick audit targets: per-level shares vs peer benchmark, per-provider variance, and payer downcoding rate), `credit_balance_detect` / `_add` / `_list` / `_resolve` (overpayment ledger with ACA 60-day report-and-return countdowns and CMS-838 quarterly reminders).
**Code & policy currency** — `code_update_calendar` shows upcoming releases and how far behind the installed data has fallen: ICD-10-CM/PCS (October 1 main release, April 1 mid-year), HCPCS Level II (January and July for items and services, **quarterly for drugs and biologicals** — if you bill injectables that is your real cadence), NCCI PTP/MUE (quarterly), CPT and MPFS (annual January 1). `code_set_register` records which edition is installed so staleness is a fact rather than a guess. `code_update_diff` diffs two editions and reports **only what touches codes this practice actually bills**, drawn from stored claims and remittances — deleted codes still in use, reworded codes, and, for ICD-10, codes that gained children and so became non-billable headers, which is the most common way established codes start rejecting on October 1. `policy_watch` reads the CMS Coverage national and local change feeds, filtered by contractor, document type, keyword and date, and shows only what has moved since the last run; a retired billing-and-coding Article is scored as an action item because nothing announces it on the claim. Which edition applies to a claim is decided by the **date of service**, not the submission date, so a claim spanning an effective date has to be split.
**Assistants** — `em_calculate` (2021 MDM E/M leveling), `appeal_draft`, `abn_generate`.
**Analytics & prediction** — `analytics_query` (denial rate, top CARCs, per-payer KPIs from parsed 835s), `denial_risk_score`.
**🚩 Flagship — Adversarial Payer Twin** — `payer_twin_adjudicate` role-plays the payer and tries to deny your claim before submission, grounded in a per-payer playbook built from your own 835 history; `claim_gauntlet` runs it in rounds until the claim survives; `twin_calibrate` scores past predictions against real remittances so the twin learns your payers.

Several tools use free public APIs (NLM, NPPES, CMS Coverage) — no keys required. Optional datasets go in `~/.aetheraclaw/data/`: `ncci-ptp.json` and `mue.json` (bundling and unit edits), `hcpcs.json`, `mpfs.json` (RVUs), `global-periods.json` (`{"CODE": 90}`) for global-period lookup, and `em-benchmark.json` (`{"99213": 38.2}` percentages, from the CMS *Medicare Physician & Other Practitioners* public use file) for peer E/M comparison. `code_update_diff` reads code-set editions from the same directory, either as a bare `{"CODE": "description"}` map or wrapped as `{"label", "effective", "codes"}`. CPT is AMA-licensed and supplied by the user via `healthcare.cptDataPath`. Every dataset is optional — tools that need one say so instead of guessing.

## Example

> "Is E11.65 billable? Does Medicare cover it in Texas? Build and scrub a test claim, then run it past the payer twin."

The agent chains `icd10_validate` → `mac_lookup` → `coverage_search_local` → `claim_scrub` → `payer_twin_adjudicate`, citing code and policy identifiers throughout.

## Testing

```bash
npm test          # unit tests: path-guard, shell risk, registry, truncation,
                  # NPI Luhn, X12 837/835 round-trip, claim scrub, E/M, denial codes
```

## Roadmap

Designed-in extension points, planned but not yet built: claim intelligence (fee-schedule variance), practice operations (credentialing, superbill capture, ERA export, GFE), coding review queue, payer-portal automation (Playwright), email channel + scheduled reporting, autonomous RCM swarm, regulation-as-code + compliance sentinel + hash-chained audit log, practice revenue digital twin (Monte Carlo), voice/telephony agent (Twilio + IVR), value-based care (HCC/RAF), price-transparency mining (MRF/TiC), FHIR ePA (Da Vinci CRD/DTR/PAS) + agent-to-agent negotiation, documentation-native CDI + coder training simulator — plus a real clearinghouse connector, PHI mode (encryption at rest, audit logging, redaction), messenger channels, a plugin SDK, multi-user auth, and Docker packaging.

## License

MIT
