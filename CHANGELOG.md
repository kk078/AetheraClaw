# Changelog

## v0.2.4 — 2026-08-10

- fix: one id selector kept the console on top of every other screen (#12)


## v0.2.3 — 2026-08-10

- fix: make the provider-key screen reachable, usable and persistent (#11)


## v0.2.2 — 2026-08-10

- fix: make the voice interface and the provider-key screen reachable (#10)


## v0.2.1 — 2026-08-10

- fix: finish the ORION rename in the part people actually look at (#9)


## v0.2.0 — 2026-08-10

- feat: serve the console publicly, deliberately rather than by deletion (#8)


## v0.1.3 — 2026-08-10

- fix: give the container its token, and move to orion.aetheraonline.com (#7)


## v0.1.2 — 2026-08-10

- fix: make the release reach the deploy, and fail fast on Containers (#6)


## v0.1.1 — 2026-08-10

- ORION: give the gateway a door, then a way to publish it (#5)
- Read an archive of documents, and OCR the scans inside it (#4)
- Do not report a failed provider as a capability score (#3)
- Do not report a failed provider as a capability score
- Make Ctrl-C actually stop the gateway (#2)
- Make Ctrl-C actually stop the gateway
- AetheraClaw: multi-provider AI assistant for healthcare RCM &amp; medical billing/coding (#1)
- One command to run it, and configure the provider in the app
- Add a synthetic practice seeder, and fix what it exposed
- Voice tier 3: ambient capture, spoken authorization, gated wake word, voice evals
- Voice tier 2: screen-aware references, worklist mode, brief speech, briefing
- Voice tier 1: validate heard codes, gate identifiers, speak as it thinks
- Add the voice intelligence roadmap as a reference page
- Add a voice interface and cited web research
- Type-check the tests in CI, and isolate the dataset-cache test's shared home
- Clean up the low-severity correctness and display defects
- Correct the RCM analytics that were quietly wrong on common inputs
- Close the review-page XSS, the subject-line PHI leak, and three more
- Fix the money analytics: TiC ingest, credit balances, variance, collection rate
- Stop a purge typo deleting everything, a WS listener leak, and a silent scrub gap
- Fix NCCI edits, the birthday rule, and reference lookups on real schemas
- Get the money right in the X12 layer: batching, terminators, COB lines, signs
- Read hostile and real-world documents without losing text or the process
- Make the audit trail, identifier gate and credential store hold under pressure
- Make the swarm's human checkpoints real, not self-reported
- Harden the agent trust boundary and keep sessions replayable
- Build the prerequisites the clone does not bring, and prove the browser starts
- Let the tool limit be raised where it is a preference, not where it is physics
- Enter a key once, or use a local model and enter none
- Read the documents people actually get, and refuse the ones nothing can read
- Make a turn one card, and stop a badge claiming more than it knows
- Point at the managed copy when a configured path has been deleted
- Take the reference database into the installation, and be honest about updating
- Route the attached reference database into the tools that need it
- Fix the provider tool counts, and say the contract limit out loud
- Render the claim as the CMS-1500, and the appeal as something to read
- Report work RVUs, and refuse to flatter them
- Measure tool selection, and report the 10/14 it actually scores
- Install ICD-10-CM locally so the commonest lookup stops needing a network
- Parse PLB and tie the deposit to the claims that explain it
- Attach a user-supplied reference database, gated before the first read
- Stop the console reporting a working gateway as offline
- Fix two failures a live console run exposed
- Name what makes a zip the RVU or MUE file, not what it is called
- Classify local CMS zips by contents, not by filename
- Reject unknown options instead of silently doing something else
- Make --from-dir tolerate browser-renamed and duplicate downloads
- Add an offline path for CMS data, and stop masking a 403 as a missing file
- Add 276/277 claim status inquiry and appeal economics
- Stop CI running twice for every push
- Add CI, index the NCCI table, bound tool_views growth
- Redesign the console as a verdict feed with a canvas column
- Add a CMS reference-data fetcher, verified against the July 2026 releases
- Correct the ICD-10 offline claim; document a local install
- Add support workbench: batch heal preview, 277CA analyzer, RCA reports
- Mail operations: attachments, cross-referenced recommendations, MIS briefing
- Log every tool call, and let FMEA read it
- Support diagnostics: lifecycle trace, failure classification, stalled work, remediation
- Ops tooling: integrity, dataset health, inference telemetry, payer drift
- Render tool results as components instead of prose
- Stop demanding a key for a provider the user did not choose
- Pillar 2: a three-valued pre-submission gate, and E/M risk in both directions
- Pillar 4: executive KPIs that refuse to flatter, and contracted-rate variance
- Pillar 1: denials into the queue on arrival, and auto-repair that refuses to invent facts
- Pillar 3: tenant isolation by database file, and a PHI access log that refuses PHI
- Ground the agent: stop fabricated regulatory facts reaching claims
- Rebuild the web UI as an application shell around the module map
- Make all 176 tools reachable on any provider via a tool catalogue
- Remove the C++ toolchain requirement: fall back to node:sqlite
- Fix two CMS Coverage tools that were broken against the live API
- Make the build and shell tool work on Windows
- Ollama: pair the model with the endpoint, gpt-oss:120b on cloud
- Verify the Ollama path live; split buildRegistry out of the CLI
- Make the non-Anthropic providers actually usable
- M34: documentation-native CDI, greenlight, coder training
- M33: FHIR ePA (CRD/DTR/PAS) and agent-to-agent negotiation
- M32: price transparency — bounded-memory ingest, benchmarking, IDR economics
- M31: value-based care — RAF, recapture, symmetric suspecting, quality
- M30: voice and telephony — consent gates, IVR navigation, call outcomes
- M29: practice revenue digital twin — model fitting, Monte Carlo, scenarios
- M28: regulation-as-code, compliance sentinel, tamper-evident audit log
- M27: autonomous RCM swarm — blackboard, dispatch planner, autonomy tiers
- Build out the payer twin: real gauntlet loop and automatic calibration
- Add payer portal automation with credential, injection and PHI guards
- Add email channel and practice reporting
- Add coding review queue with an append-only decision log
- Add practice operations: credentialing, charge capture, posting, GFE
- Add denial prediction & filing deadlines with banked proof of filing
- Add claim intelligence: MPFS pricing, payment variance, rate drift
- Add code & policy currency: release calendar, edition diff, policy watch
- Add secondary claims & COB: 277CA parsing, MSP order, secondary 837
- Add audit & integrity module: audits, E/M benchmarking, credit balances
- Add compliance rule pack: telehealth, global periods, incident-to
- Initial commit
- Scaffold AetheraClaw: multi-provider RCM billing/coding assistant

