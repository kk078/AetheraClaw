# Publishing to aetheraonline.com

This describes the arrangement in `wrangler.jsonc`, `Dockerfile`, `worker/index.ts`
and the two workflows — and, just as importantly, what it does **not** do yet.

## The shape

```
browser ──► Cloudflare Access ──► Worker ──► Container ──► SQLite on /data
                (SSO, MFA)      (verifies    (the Node        │
                 ⚠ CURRENTLY     the JWT,     gateway)        ▼
                   REMOVED —     pins the                  R2 snapshot
                   see below)    tenant)
```

Each hop exists for a reason that is not decoration:

**Access** supplies the authentication the application does not have. Until
`src/gateway/auth.ts` was written there was no authentication anywhere in this
codebase — no hook, no middleware — and the entire security model was
`gateway: { host: "127.0.0.1" }`. Access is what replaces "only this machine can
reach it" when the thing is on the public internet.

> ## ⚠ This deployment currently has NO sign-in
>
> `PUBLIC_ACCESS: "1"` in `wrangler.jsonc` and no Access application in front of
> `orion.aetheraonline.com`. **Anyone who learns the hostname gets the console,
> the claims database, the shell tool, the filesystem tool and the payer-portal
> browser.** This was asked for explicitly, for a trial and a presentation, over
> a stated objection — it is recorded here rather than left for someone to
> discover.
>
> Two things make it survivable, and only these two:
>
> - the seeded data is **synthetic** (`ORION_SEED_DEMO`), and
> - the PHI posture is **`blocked`** (`ORION_PHI` in the `Dockerfile`), so a
>   document carrying an identifier is refused with 422 before it is stored.
>
> **If either changes, this must change on the same day.** In particular, the
> day the BAA is signed and `ORION_PHI` becomes `permitted`, an unauthenticated
> console becomes an unauthenticated console over real charts.
>
> **To close it:** set `PUBLIC_ACCESS` to `"0"` in `wrangler.jsonc`, deploy, and
> run the **Access setup** workflow to re-create the application. Both halves —
> Access runs ahead of the Worker, so the code flag alone changes nothing a
> visitor sees, and deleting the application alone leaves the origin demanding an
> identity the edge no longer sends (every page 403).
>
> What public mode does **not** relax, deliberately:
>
> - the shared `GATEWAY_TOKEN` is still required, so the container is
>   addressable only by our own Worker (a browser never sends it, so this costs
>   a visitor nothing);
> - a JWT that *is* presented is still verified — an unverifiable one is refused,
>   not downgraded to anonymous;
> - the Worker deletes any client-supplied `Cf-Access-Authenticated-User-Email`
>   before forwarding, so nobody can name themselves in the audit log;
> - PHI access rows record the actor as **`anonymous`**, not as the agent —
>   "the software read this chart" is the one answer that would be actively
>   false.

**The Worker** verifies the Access JWT's signature, audience and expiry before
anything else runs, then presents a shared secret to the container. The order is
load-bearing. `Cf-Access-Authenticated-User-Email` is a header like any other;
trusting it before proving the request came through the edge is the standard way
an Access-fronted origin ends up open while everyone believes it is protected.
`test/gateway-auth.test.ts` has that case as its longest comment.

**The container** runs the real gateway, unchanged, on port 8080 bound to
`0.0.0.0` — which is why the auth module treats anything non-loopback as exposed
and refuses every request unless the secret is configured and correct.

**R2** holds the database, because a container's disk does not survive the
instance.

## The part that deserves scrutiny: state

Cloudflare stops an idle container and starts a fresh one on the next request.
Everything written to `/data` in between is gone. `scripts/container-boot.mjs`
restores the SQLite file from R2 on boot and checkpoints it back on a timer and
on shutdown.

That is correct **only while exactly one instance writes a given tenant's
database.** The Worker guarantees it by deriving the container's Durable Object
id from the verified email's domain, so a tenant's requests all land on one
instance. If that ever stops holding, two instances restore the same snapshot,
diverge, and the last to checkpoint silently erases the other's work. There is
no merge for that. It is why `tenantKey()` reads the *verified* email and never
a header or query parameter a client could set.

**Why not D1**, which would remove the problem entirely: `src/memory/sqlite.ts`
exposes a **synchronous** interface — `prepare(sql).get(...)` returns a row, not
a promise — and every one of `MemoryStore`'s callers is written against it. D1's
API is asynchronous. Adopting it means making the store and its entire call
graph async, which is a large change to the most-tested part of this codebase.
Snapshotting keeps the storage engine the 2,600 tests actually run against. It
is a deliberate trade, not an oversight, and the honest summary is: **this is
durable against restarts, not against concurrent writers.**

Checkpoint interval is `ORION_CHECKPOINT_MS` (default 60s). The exposure
window on a hard crash is that interval — the WAL is flushed on a clean SIGTERM,
which is the path Cloudflare uses to stop an idle instance.

**What travels with the database.** `credentials.json` and `config.json5` are
snapshotted alongside it. Without that, a provider key typed into the *Providers
& keys* screen was gone at the next cold start — roughly twenty idle minutes
later — which from the operator's side is "I added a key and it did not save",
and they were right.

**Two failures this path used to have**, both fixed and worth knowing because
each was silent:

- The container never sent the shared token on its snapshot calls, and the
  Worker's `/snapshot/` handler answers **401** without it. So setting
  `ORION_SNAPSHOT_URL` did not turn on persistence — it turned on a 401 that
  `restore()` treated as failure and *exited the process over*, taking the whole
  deployment down on first boot. Nobody hit it only because the variable was
  never set.
- A failed restore called `process.exit(1)`. The instinct was right — an
  instance that cannot read the snapshot must never write over it — but exiting
  turned one bad environment variable into a total outage. It now starts with
  **checkpointing disabled**, which protects the snapshot just as well and keeps
  the console serving while somebody reads the log.

The callback also needed Access to be gone: the container has no Access session,
so every snapshot request would have been redirected to a login page.

## One-time setup

None of this is done by the pipeline, because none of it should be automatic.

1. **DNS** — `aetheraonline.com` on Cloudflare, and `orion.aetheraonline.com`
   as the custom domain in `wrangler.jsonc`.
2. **R2 bucket** — `npx wrangler r2 bucket create orion-snapshots`.
3. **Access application** over `orion.aetheraonline.com` in Zero Trust — run the
   **Access setup** workflow, which creates it and commits the **AUD tag** into
   `wrangler.jsonc` under `vars.ACCESS_AUD` along with `ACCESS_TEAM_DOMAIN`. The
   AUD check is what stops a valid token for a *different* Access application in
   the same account working here.
   *Skipped in the current public deployment* — the **Access removal** workflow
   (`scripts/access-remove.mjs`) deletes it, and it is the only thing that makes
   the sign-in page go away, because Access runs ahead of the Worker.
4. **Repository secrets** in GitHub: `CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_ACCOUNT_ID`, and `GATEWAY_TOKEN` (generate with
   `openssl rand -hex 32`). The deploy fails fast if any is missing rather than
   shipping a container that would refuse every request.
5. **Provider key** — set it in the console's provider screen after the first
   deploy, or as a container environment variable. It is never committed.

## The pipeline

```
Claude Code ──► branch ──► PR ──► CI (ci.yml) ──► merge to rcm-base
                                                        │
                                              release.yml: run the full
                                              suite on both SQLite drivers,
                                              compute the version from the
                                              commits, write CHANGELOG.md,
                                              tag vX.Y.Z, cut a release
                                                        │
                                              deploy.yml (on the tag):
                                              build the image, wrangler deploy,
                                              poll /healthz until it answers
```

Deployment triggers on the **tag**, not the branch. So what is running in
production always has a version number, and a rollback is
`workflow_dispatch → deploy.yml` with an older tag — not an archaeology exercise
at 2am.

`scripts/release-version.mjs` will decide to release **nothing** when every
commit since the last tag is `docs:`, `chore:`, `test:`, `ci:` or `style:`. That
is intentional: a repository where every push produces a version produces
versions that mean nothing, and here it would redeploy a PHI application to make
a comment typo live.

## Not done, and needed before real patient data

The BAA is not signed yet, and this deployment is built to be production-real
without it. That is enforced in code, not promised in a slide.

### The trial posture

`src/config/posture.ts` gates the ingress path. Off loopback the default is
**blocked**: a document carrying an identifier — SSN, MBI, legacy HICN, date of
birth — is refused with **HTTP 422** *before* `saveDocument` is called. Screened
before rather than deleted after, because storing it and removing it afterwards
still means the text was written to disk, replicated into the WAL, and carried
into the next R2 snapshot. The bytes having arrived is precisely what the
agreement is about.

Nothing has to be remembered for this to hold. Exposure alone closes the door;
forgetting a flag fails safe. Opening it requires exactly `ORION_PHI=permitted`
— "true", "yes" and "1" all read as blocked, because guessing at an operator's
intent is the wrong instinct when the subject is whether patient data may be
stored.

The console shows the rule **on load**, not on refusal. A prospect who learns
the limit by having a real EOB turned away has already handed the file over; the
refusal protected the database, not them.

Archive entries are screened **individually**. Refusing a whole zip because one
file of forty carried an identifier would teach people to split archives up
until they went through, which is a gate demonstrating how to get around it.
Refused entries are counted separately from unreadable ones in the manifest — a
refusal is the gate working, an unreadable file is the reader not managing, and
conflating them sends an operator to fix the wrong thing.

Verified live against a gateway bound to `0.0.0.0`: a document containing an
SSN and a date of birth returned 422 and left **zero** rows — not the text, not
the filename — while a synthetic remittance in the same session stored normally.

### The day the BAA is signed

One line in the `Dockerfile`: `ORION_PHI=blocked` becomes `permitted`. Then the
items below become live obligations rather than deferred ones.

- Confirm the products used here are in scope of the executed BAA.
- Confirm no zone-level Cache Rule re-enables caching on this hostname. An edge
  cache of these responses would put patient data in POPs worldwide.
- Keep Zaraz and Web Analytics off this hostname — URLs carry claim and
  document ids.
- **AI Gateway logging** stores prompts, and the prompts would then contain PHI.
- **`req.identity` reaches `phi_access_log` on the ingress paths only.** An
  upload records the person (or `anonymous`); a *read* performed by a tool
  during an agent turn still records `agent`, because a tool call is not an HTTP
  request and carries no identity today. This is the one item that should not
  wait for the BAA.
- **The console has no sign-in at all right now** (see the box at the top).
  Under a BAA that is not a gap, it is a breach.

### Still true regardless

- The licensed AMA CPT-derived data (NCCI, MUE, MPFS) ships in the image. Fine
  for a licensed deployment; not fine for a public demo.
- `instance_type: standard-1` gives 8 GB of disk. A tenant whose database plus
  datasets exceed that will fail to start, not degrade.
- The R2 snapshot scheme is durable against restarts, not against concurrent
  writers.
- **The snapshot keys are fixed names, so they hold ONE tenant.** Safe exactly
  while `PUBLIC_ACCESS` is on, because public mode pins every request to a single
  container instance. Restoring Access brings back per-domain tenants, and each
  one needs its own key prefix *before* that happens — otherwise two tenants
  share a snapshot and the last to checkpoint erases the other.

### Demo data

`ORION_SEED_DEMO=1` seeds synthetic claims on first boot — only when the
operator asked, only when no database file exists, and only when the restore
found no snapshot. A populated install fails every one of those conditions. It
exists so a presentation opens on a working console rather than on nulls, which
read as a broken deployment to somebody who has never seen it working.
