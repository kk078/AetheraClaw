# The first live claim

This is the one action in the product that cannot be undone by deploying a fix.

Everything else — a wrong verdict, a bad estimate, a lost document — is
recoverable. A submitted 837 is a claim at a payer. The only things that change
it afterwards are a **void** (frequency code 8) or a **replacement** (frequency
code 7), and both are new filings a person has to reason about.

Read this before the day, not on it.

---

## Why this exists at all

Stedi's sandbox plan covers eligibility and nothing else. Submission, status and
ERA unlock on the production plan, which by their own wording means sending real
claims to real payers. **There is no test network for the 837 path.**

So the step after "the mock connector works" is a real claim, for a real
patient, at a real payer. Everything below exists to make that first one small,
watched, and reversible in the only sense that word applies here — that there is
still time to correct and refile.

---

## Choose the claim first

The instinct is to pick a big complicated claim to test it properly. That is
backwards. **A first submission tests the pipe, not the claim.** A complex claim
adds ways to fail that tell you nothing about whether the connection works, and
if it goes wrong it goes wrong for more money.

What you want:

| | |
|---|---|
| **Charge** | Under $500 |
| **Scrub** | No errors *and* no warnings |
| **Eligibility** | Already confirmed for this patient, this payer |
| **Filing window** | At least 60 days left |
| **Payer** | One you file with often, whose rejections you recognise |
| **Patient** | Established, with demographics that have adjudicated before |

The filing window matters more than it looks. It is what buys you the right to
be wrong: if this submission fails in a way that needs correcting, you need
room to correct and refile.

---

## The day

### 1. Confirm what you are pointed at

```bash
orion serve --check-production      # must not be fatal
orion data status                    # nothing missing, nothing provably stale
```

The startup banner names the connector and its environment. Read it. It says
`REAL PAYERS` in production, and that sentence is the one to stop on.

### 2. Set the supervised window

`healthcare.liveSubmissionCap` defaults to **1**. Leave it there.

This is a number the submit path consults, not a line in a document. A document
saying "only submit one to start" is a document somebody deviates from at 4pm
when the first one worked and the queue is long.

### 3. Dry run

```
claim_dry_run
```

Sends nothing. It renders what the payer will actually receive, annotated
segment by segment, and diffs the wire against what the system believes it is
billing — those can differ, and every difference is a rejection nobody would
predict from reading either side alone.

**Check these four by hand, against something that is not this screen:**

- the billing NPI digits (`NM1*85`) — the commonest hard rejection there is
- the member id
- the dates of service
- that the line charges sum to the claim total

Checking a rendering against itself proves only that the rendering is
consistent.

### 4. The gate

```
claim_first_submission_check
```

It reports what would block: the cap, the environment, the approval policy, the
scrub, **any check that could not run**, the filing window, eligibility, whether
anyone has read the 837, and whether a person is named as watching.

The "could not run" one blocks, and it is the one worth understanding. If the
NCCI table is not installed, the scrub line above it still says *"The scrubber
found nothing"* — truthfully, because nothing looked. Everywhere else in the
product that degrades an answer somebody can weigh. Here the next step files a
claim, so an absence of information must not read as a statement of safety.

It is also the cheapest item on the list to clear: `orion data refresh` fetches
public CMS files, and step 1 is where you find out.

It also checks whether this exact claim has been sent before, which is the one
thing the gate alone cannot know.

**A passing gate is not a safety proof.** It means the obvious mistakes have
been ruled out. Only the payer decides whether the claim is correct, and a green
checklist is exactly the sort of thing that gets quoted as approval later.

### 5. Submit

Approval is required and `approvalPolicy` must not be `never` — the gate blocks
on that, because a submission with no approval prompt is unattended however many
people are in the room.

The attempt is written to the ledger **before** the send. A row written only on
success would let a submission that crashed mid-flight be retried past the cap,
which is precisely the case the cap exists for.

---

## After it goes out

**There is no rollback.**

1. **Wait for the 277CA.** Accepted means the clearinghouse and payer took it —
   not that it will pay.
2. **If nothing arrives, check status (276/277). Do not resend.** A timeout does
   not tell you whether the payer received it. A duplicate claim is treated as
   fraud-adjacent and surfaces as a takeback months later.
3. **Record filing proof only when the acknowledgement actually arrives.** A
   clearinghouse receipt is not proof of filing at the payer.
4. **If it was wrong:** void (frequency 8) or replace (frequency 7), referencing
   the payer's claim number. Do **not** file a corrected copy as a new original
   — that is the duplicate.
5. **Do not raise the cap until this claim has been acknowledged *and*
   adjudicated.** Accepted is not paid.

```
claim_live_ledger
```

Shows every live attempt and its outcome. `unknown` is its own outcome and the
important one — those claims may be sitting at the payer. Resolve each by
checking status before doing anything else with them.

---

## When to widen

Raise `liveSubmissionCap` only after:

- the earlier claims have a 277CA acknowledgement, **and**
- an 835 showing they adjudicated, **and**
- the paid amount matches what you expected, or you understand why it does not.

Then raise it to a number you would be comfortable explaining if all of them
were wrong the same way. The failure mode of a bad configuration is not one bad
claim — it is every claim that goes out before somebody notices.

---

## What is deliberately not automated

- **A failed submission is never retried automatically.** `claim_submit` is
  declared non-idempotent; it dead-letters on its first failure and is not
  restarted even after a crash, because the process may have died *after* the
  837 went out.
- **The swarm never auto-advances a submission**, in any mode.
- **A simulated result is never written onto a claim record.** Every
  clearinghouse result carries `simulated`, and the mock sets it on all of them.
