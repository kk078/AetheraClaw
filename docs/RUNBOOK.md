# Runbook

What to do when something is wrong, written for the person on call rather than
for the person who built it. Every section names the symptom first, because that
is what you have.

The rule that governs this whole document: **ORION refuses rather than guesses.**
Most of what looks like a failure here is the system declining to answer, and the
fix is to give it what it needs — not to work around the refusal.

---

## First five minutes

```bash
curl -s localhost:4180/healthz            # is it serving at all
curl -s localhost:4180/metrics            # counts, and what is stuck
orion data status                          # is the reference data still right
orion jobs list                            # is background work moving
orion serve --check-production             # would it start, and why not
```

`/healthz` is unauthenticated and costs nothing against the rate limiter.
`/metrics` is behind the gateway token off loopback.

---

## The gateway will not start

It refuses to start rather than starting and failing every request. The reason is
printed. The three fatal ones:

| Message names | What it means | Fix |
|---|---|---|
| exposed with no token | Bound off loopback with no `ORION_GATEWAY_TOKEN`. Every request would 401, which reads as a 500 to a user. | Set the token, or bind `127.0.0.1` |
| `approvalPolicy: "never"` in production | Nothing would ever ask before submitting a claim | Set it to `always` or `risky` |
| public access + production PHI mode | The console would be served to anyone with no identity, in a mode that stores PHI | Turn one of the two off |

`orion serve --check-production` prints the same report and exits without
starting, which is what a deploy script should call.

---

## "It says it can't check that"

Not a fault. A tool that has no data says so instead of answering from memory.

```bash
orion data status --profile claims
```

Exit 1 means something is missing or provably stale. `orion data refresh` fetches
the current public CMS files.

**A file with no edition stamp is reported as `undated`, not as current.** Only
ICD-10-CM declares its own edition; the rest are bare tables. `undated` is the
normal state of a correct install and is not a problem to chase.

---

## Background work is not finishing

```bash
orion jobs list
```

- **queued and not moving** — the worker runs inside `orion serve`. If the
  gateway is not running, nothing drains.
- **running with an expired lease** — the process that held it died. Restarting
  the gateway reclaims it.
- **dead** — read the reason. It will not be retried.

### A `claim_submit` job is dead-lettered

**Do not resubmit.** A failure does not tell you whether the payer received the
837. Check the claim's status at the clearinghouse first; if it is there, the
claim is filed and a resend would duplicate it. Duplicate claims are treated as
fraud-adjacent by payers and surface as takebacks months later.

This is why `claim_submit` is `idempotent: false` and is never retried
automatically, including after a crash.

---

## A claim is stuck

```
swarm board  →  the escalation list is ordered worst-first
```

The list is ordered by money inside urgency bands, and a **closed timely-filing
window outranks everything** — it is the only unrecoverable item on the board.

If the window has closed: filing now will be denied on the deadline, and that
denial is not appealable on the merits of the care. The only remaining path is a
late-filing exception with the payer.

**A clearinghouse rejection is not a submission.** The claim never reached the
payer and the filing clock never stopped. This catches people out constantly.

---

## Eligibility says something confusing

Three answers that look similar and are not:

| What it says | What it means | What to do |
|---|---|---|
| "The payer could not identify this patient" | The enquiry failed. **This says nothing about coverage.** | Fix the demographics and retry — check DOB and member id against the chart |
| "no active coverage for the service types asked about" | The payer found them and has no active plan | Tell the patient, or check for other coverage |
| "Active coverage confirmed" | There is coverage | Proceed |

AAA codes 71 (DOB mismatch) and 72 (invalid member id) are the common ones and
are usually transcription differences, not facts about the patient.

---

## The payer portal will not open

```
portal_health
```

It distinguishes two failures with different fixes:

- **Playwright is not installed** → `npm install playwright`
- **Playwright is installed, its browser is not** → `npx playwright install chromium`,
  or point `browser.executablePath` at a Chromium already on the machine

Everything that does not drive a portal — scrubbing, X12, eligibility, analytics
— is unaffected.

---

## The inbox looks empty and mail is missing

Mail matching a PHI pattern is **held**: the body is never stored and the subject
is redacted, so it is invisible to every ordinary mail tool.

```
mail_held_queue
```

It cannot be opened from here — the body was not withheld, it was never written.
Read it in the mailbox itself, then record what happened with `mail_held_resolve`,
which requires an outcome.

`orion_mail_held` in `/metrics` is the number to alert on. A count that climbs
and never falls is a queue nobody is working.

---

## 429s

Token bucket: 120 requests/minute sustained, burst 60, per identity where there
is one and per address otherwise. Static assets and `/healthz` cost nothing.
Turns cost 5, uploads 10.

`Retry-After` says how long. A refused request costs nothing, so backing off
genuinely recovers.

`orion_rate_limited_total` counts refusals since start.

---

## Restoring

The database is one SQLite file (plus its `-wal` and `-shm` siblings — copy all
three, or checkpoint first). `orion audit verify` re-walks the hash chain and
reports the first row that does not verify.

Documents may be encrypted at rest. **Back up `ORION_ENCRYPTION_KEY` separately
from the database.** Both in one place is neither a backup nor encryption. A
restore with the wrong key does not corrupt anything: `decryptField` returns
empty with a reason rather than garbage, and rows written before encryption was
turned on stay readable.

---

## What is deliberately not automated

Named here so nobody goes looking for the switch:

- **Claim submission is never retried automatically.** See above.
- **Nothing writes to an EHR.** The chart connector is read-only.
- **Held mail is never released to the agent.** Quarantine has no bypass.
- **A simulated clearinghouse result is never written to a claim record.** Every
  result carries `simulated`, and the mock connector sets it on all of them.
- **The swarm never auto-advances submit, appeal or refund**, in any mode.
