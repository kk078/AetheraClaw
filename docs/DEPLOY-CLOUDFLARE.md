# Publishing to aetheraonline.com

This describes the arrangement in `wrangler.jsonc`, `Dockerfile`, `worker/index.ts`
and the two workflows — and, just as importantly, what it does **not** do yet.

## The shape

```
browser ──► Cloudflare Access ──► Worker ──► Container ──► SQLite on /data
                (SSO, MFA)      (verifies    (the Node        │
                                 the JWT,     gateway)        ▼
                                 pins the                  R2 snapshot
                                 tenant)
```

Each hop exists for a reason that is not decoration:

**Access** supplies the authentication the application does not have. Until
`src/gateway/auth.ts` was written there was no authentication anywhere in this
codebase — no hook, no middleware — and the entire security model was
`gateway: { host: "127.0.0.1" }`. Access is what replaces "only this machine can
reach it" when the thing is on the public internet.

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

Checkpoint interval is `AETHERACLAW_CHECKPOINT_MS` (default 60s). The exposure
window on a hard crash is that interval — the WAL is flushed on a clean SIGTERM,
which is the path Cloudflare uses to stop an idle instance.

## One-time setup

None of this is done by the pipeline, because none of it should be automatic.

1. **DNS** — `aetheraonline.com` on Cloudflare, and `app.aetheraonline.com`
   as the custom domain in `wrangler.jsonc`.
2. **R2 bucket** — `npx wrangler r2 bucket create aetheraclaw-snapshots`.
3. **Access application** over `app.aetheraonline.com` in Zero Trust. Take the
   **AUD tag** and put it in `wrangler.jsonc` under `vars.ACCESS_AUD`, and set
   `ACCESS_TEAM_DOMAIN` to your team domain. The AUD check is what stops a valid
   token for a *different* Access application in the same account working here.
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

Stated plainly rather than left to be discovered:

- **A BAA with Cloudflare.** PHI passing through Cloudflare compute and sitting
  in R2 requires one, and it is available on Enterprise plans for a defined
  subset of services. Confirm the products used here are in scope before any
  real record is loaded. This is a commercial step no code can perform.
- **Caching is disabled in the Worker**, but confirm no zone-level Cache Rule
  or Page Rule re-enables it on this hostname. An edge cache of these responses
  would put patient data in POPs worldwide.
- **No Zaraz, no Web Analytics, no third-party tags** on this hostname. They
  send URLs — which carry claim and document ids — to third parties.
- **AI Gateway logging.** Useful in front of the model providers, but its
  request logging stores prompts, and the prompts contain PHI. Enable the
  gateway without logging, or not at all, until the BAA covers it.
- **The identity is not yet used for PHI attribution.** `req.identity` is
  populated by the auth hook but `phi_access_log` still records what it did
  before. Wiring the verified email into those rows is the obvious next commit
  and is not in this change.
- **The licensed AMA CPT-derived data** (NCCI, MUE, MPFS) ships in the image.
  That is fine for a licensed deployment and is not fine for a public demo.
- **`instance_type: standard-1` gives 8 GB of disk.** A tenant whose database
  plus datasets exceed that will fail to start, not degrade.
