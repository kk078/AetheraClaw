# Deploying ORION for real patient data

This is the checklist for a deployment that will hold PHI. It is separate from
`DEPLOY-CLOUDFLARE.md`, which describes the trial deployment that deliberately
refuses PHI, because the two are different postures and merging the documents
would let somebody follow half of each.

**Nothing in this file makes ORION production ready.** It describes what Phase 1
built and what it does not cover. `PRODUCTION-ROADMAP.md` has the full list and
the honest state of each phase.

---

## The two settings, and why there are two

| Setting | Question it answers | Where |
|---|---|---|
| `ORION_PHI` (posture) | **May** this deployment store PHI at all? | `src/config/posture.ts`, env |
| `healthcare.phiMode` | **How careful** is it being while it runs? | `config.json5` |

They were deliberately not merged. The posture is a legal fact about the
deployment — it changes when an agreement is signed. The mode is an operational
stance — it changes how chat is screened, whether uploads need an
acknowledgment, and what the model is told about the data it is handling.

Collapsing them would mean the day the BAA is signed, one edit silently changes
half a dozen behaviours nobody reviewed.

**Both must be set.** `ORION_PHI=permitted` with `phiMode: "education"` is a
deployment that will store real records while telling the model that synthetic
examples are fine. `phiMode: "production"` with `ORION_PHI=blocked` is safe but
stores nothing, and the startup check says so.

---

## What `phiMode: "production"` changes

### 1. Chat input is screened before it is stored

`SessionManager.handleUserMessage` runs the scan **before** `runTurn`, because
`runTurn`'s first act is to persist the user message. Screening after that point
would mean the identifier had already been written to the transcript, replicated
into the WAL and carried into the next snapshot — and deleting it afterwards
does not unwrite any of that.

The two modes differ in exactly one place: whether a **medium-confidence** shape
is enough to stop.

| Signal | Confidence | education | production |
|---|---|---|---|
| SSN, MBI, legacy HICN, labelled DOB | high | **blocked** | **blocked** |
| Bare date beside "patient"/"member"/… | medium | allowed | **blocked** |
| Phone number, email address | medium | allowed | **blocked** |
| Labelled MRN / member / policy number | medium | allowed | **blocked** |

High confidence is blocked in **both** modes. An education deployment that lets
a labelled SSN into a transcript is not educating anyone about anything.

A blocked turn emits `phi_blocked` to the client and writes one row to
`phi_access_log` with `resource_type = "chat_message"` and `record_count = 0` —
kinds only, never the text. Zero record count is how a reviewer tells a refusal
from an access. The row exists because "somebody pasted an identifier into the
chat box" is exactly the event an incident review needs to find, and the gate
working is what stops it leaving any other trace.

### 2. The system prompt loses its escape hatch

The education prompt tells the model that "educational examples and clearly
synthetic/test data are fine". A model working on real charts that has been told
that has been handed the argument it needs to treat a real record as an example.

Production replaces that section: treat every identifier as real, never repeat
one back in full, never put PHI in a tool argument that does not need it,
minimum necessary, and every outbound disclosure is an approval gate.

### 3. Two configurations are refused, not warned about

The gateway **will not start** when:

- `phiMode: "production"` and `approvalPolicy: "never"` — an agent that can
  submit, appeal and email without asking, over real patient data
- `phiMode: "production"` and public access is on — an unauthenticated console
  over real patient data

Same pattern as the existing `PUBLIC_ACCESS` + `ORION_PHI` interlock in
`scripts/preflight.mjs`. A warning about this would be read once and then not.

---

## The gateway now refuses to start, not just to serve

Bound to a non-loopback address with no `ORION_GATEWAY_TOKEN`, ORION previously
started happily and answered 500 to every request. That is safe and it is also a
total outage that reports itself as an application bug — green everywhere a
machine looks, dead everywhere a person does.

It now exits at startup with the reason. An operator reading a boot log finds it
in seconds.

```
orion serve --check-production
```

runs the same checks and exits without starting anything. Exit code 1 means at
least one FATAL. Use it in a deploy pipeline before cutting traffic over.

---

## Before the first real record

1. **Business Associate Agreement** in force, covering every service in the
   path — the host, the model provider, the clearinghouse, and any logging or
   analytics touching the hostname.
2. **`ORION_PHI=permitted`** — exactly that string. "true", "yes" and "1" all
   read as blocked, because guessing at intent is the wrong instinct when the
   subject is whether patient data may be stored.
3. **`healthcare.phiMode: "production"`** in `config.json5`.
4. **`approvalPolicy`** at `"unsafe-only"` or `"always"`. Startup refuses
   `"never"`.
5. **Authentication.** Cloudflare Access or equivalent in front of the hostname,
   and `PUBLIC_ACCESS` off. Startup refuses the combination.
6. **`ORION_GATEWAY_TOKEN`** — `openssl rand -hex 32`.
7. **No edge caching** on the hostname. Responses carry PHI; an edge cache puts
   patient data in POPs worldwide. The Worker sets `no-store`, and a zone-level
   Cache Rule can still override it.
8. **Zaraz and Web Analytics off** on this hostname — URLs carry claim and
   document ids.
9. **AI Gateway logging off**, or understood: it stores prompts, and the prompts
   will contain PHI.
10. **Backups and retention.** The snapshot in R2 is a copy of the database and
    is subject to the same agreement. Decide the retention period before there
    is data to retain.
11. **`orion serve --check-production`** exits 0.

---

## Encryption at rest

`ORION_ENCRYPTION_KEY` encrypts the extracted **text** of uploaded documents and
its per-page **sections**, with AES-256-GCM. Both, or neither — sections carry
the same content split by page, so encrypting one and not the other would be a
feature that reads as protection and provides none.

```
openssl rand -hex 32     # 64 hex characters, used directly
```

Any other value is treated as a passphrase and stretched with scrypt. That works
and is only as strong as the passphrase; a passphrase is not refused, because
refusing one pushes people towards turning encryption off entirely.

**What it protects, stated narrowly so nobody over-trusts it:**

| | |
|---|---|
| Protects | Document text and sections, against anyone who obtains a **copy** — the SQLite file, or an R2 snapshot — without also obtaining the key |
| Does **not** protect | Anything else in the database. Claim numbers, amounts, payer names, worklist items, session transcripts and the audit chain are all in the clear |
| Does **not** protect | A running process. The key is in memory and the gateway decrypts on every read — it has to, or nobody can see the document they uploaded |

So it is defence against a **stolen copy**, not against a compromised host. It
is worth having because a snapshot in object storage is exactly the kind of copy
that travels. **It is not a substitute for encrypting the volume.**

**Turning it on is a non-event.** Rows written before it carry no marker and are
returned unchanged; new rows are encrypted. There is no migration step and no
downtime.

**Turning it off, or losing the key, is not.** A document stored under a key you
no longer have cannot be read. It does not come back as an empty document —
`readable` becomes false and the refusal text says the key is wrong or the bytes
were altered, so a coder is sent to the key rather than to the file they
uploaded. Rotating the key without re-encrypting existing rows leaves those rows
unreadable; there is no automatic re-encryption yet.

**Tampering is detected, not decrypted.** GCM's authentication tag means an
attacker who can write to the database cannot alter a stored clinical document
into a different one that still reads — it becomes a decryption failure instead.

---

## What Phase 1 does NOT cover

Phase 1 is complete. What follows is what the OTHER phases still owe, stated
here because somebody reading this file is deciding whether to trust the
deployment with a real record.

- **No clearinghouse connector exists.** Nothing has ever been sent to a payer.
  Eligibility, claim status and submission are local-only. That is Phase 2, and
  it is the phase to be slow about.
- **No automated reference-data refresh.** NCCI, MUE, MPFS and ICD-10 are
  installed by hand and nothing warns when they go stale (Phase 4).
- **Long operations block a turn**, and the single container has a concurrency
  ceiling a demonstration can reach (Phase 6).
- **No metrics endpoint, no structured logs, no runbook** (Phase 10).

Key rotation is also not automated: rotating `ORION_ENCRYPTION_KEY` without
re-encrypting existing rows leaves those rows unreadable. There is no
re-encryption command yet.

## Verifying the gate

```
# Refused in both modes — high-confidence identifier
"Patient SSN 123-45-6789"        → phi_blocked, 0 rows written

# Allowed in education, refused in production
"Patient seen 01/02/1955"        → phi_blocked only when phiMode=production

# Untouched in both — a synthetic remittance
"Claim CLM-4471 allowed 220.00, date of service 03/14/2025"
```

`test/phi-mode.test.ts` asserts each of these, including the one that matters
most for the existing deployment: **a synthetic remittance must stay at risk
`none`**. Widening detection until real demo files start being refused is the
failure mode that gets a safety control turned off.
