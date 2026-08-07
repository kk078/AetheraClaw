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
**Claims lifecycle** — `claim_scrub` (code/dx-pointer/NPI/modifier/POS/NCCI/MUE rules), `claim_build_837p`, `era_parse_835`, `denial_explain` (CARC/RARC), `reimbursement_estimate` (MPFS RVU).
**Eligibility & worklists** — `eligibility_check` (pluggable clearinghouse; mock connector in v1), `worklist_add`/`list`/`update`, `timely_filing_check`.
**Assistants** — `em_calculate` (2021 MDM E/M leveling), `appeal_draft`, `abn_generate`.
**Analytics & prediction** — `analytics_query` (denial rate, top CARCs, per-payer KPIs from parsed 835s), `denial_risk_score`.
**🚩 Flagship — Adversarial Payer Twin** — `payer_twin_adjudicate` role-plays the payer and tries to deny your claim before submission, grounded in a per-payer playbook built from your own 835 history; `claim_gauntlet` runs it in rounds until the claim survives; `twin_calibrate` scores past predictions against real remittances so the twin learns your payers.

Several tools use free public APIs (NLM, NPPES, CMS Coverage) — no keys required. Optional bundled datasets (NCCI PTP/MUE, HCPCS, MPFS RVUs) go in `~/.aetheraclaw/data/`; CPT is AMA-licensed and supplied by the user via `healthcare.cptDataPath`.

## Example

> "Is E11.65 billable? Does Medicare cover it in Texas? Build and scrub a test claim, then run it past the payer twin."

The agent chains `icd10_validate` → `mac_lookup` → `coverage_search_local` → `claim_scrub` → `payer_twin_adjudicate`, citing code and policy identifiers throughout.

## Testing

```bash
npm test          # unit tests: path-guard, shell risk, registry, truncation,
                  # NPI Luhn, X12 837/835 round-trip, claim scrub, E/M, denial codes
```

## Roadmap

Designed-in extension points, planned but not yet built: claim intelligence (fee-schedule variance), practice operations (credentialing, superbill capture, ERA export, GFE), compliance rule pack (telehealth/global-period/incident-to, audit tracker, code/policy update ingestion), secondary claims & COB (277CA, secondary 837), coding review queue, payer-portal automation (Playwright), email channel + scheduled reporting, autonomous RCM swarm, regulation-as-code + compliance sentinel + hash-chained audit log, practice revenue digital twin (Monte Carlo), voice/telephony agent (Twilio + IVR), value-based care (HCC/RAF), price-transparency mining (MRF/TiC), FHIR ePA (Da Vinci CRD/DTR/PAS) + agent-to-agent negotiation, documentation-native CDI + coder training simulator — plus a real clearinghouse connector, PHI mode (encryption at rest, audit logging, redaction), messenger channels, a plugin SDK, multi-user auth, and Docker packaging.

## License

MIT
