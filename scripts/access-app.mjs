#!/usr/bin/env node
// ── Create (or find) the Cloudflare Access application ───────────────────────
// The AUD tag is the one value worker/index.ts cannot be deployed without, and
// it only exists once the Access application exists. This creates the
// application, attaches an allow policy, and prints the AUD.
//
// Run from GitHub Actions rather than a laptop, because that is where the API
// token lives — a repository secret is readable by a workflow and by nothing
// else, which is the property that makes it a secret.
//
// IDEMPOTENT ON PURPOSE. Two Access applications on the same hostname is a
// genuinely nasty state: Cloudflare serves whichever it matches first, the AUD
// in wrangler.jsonc belongs to the other one, and every login then fails
// audience verification with no indication that a duplicate is the reason. So
// an existing application for this hostname is REUSED and its AUD reported,
// never shadowed by a second one.

const API = "https://api.cloudflare.com/client/v4";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
const hostname = (process.env.ACCESS_HOSTNAME ?? "").trim();
const emails = (process.env.ACCESS_EMAILS ?? "")
  .split(/[,\s]+/)
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
const sessionDuration = (process.env.ACCESS_SESSION_DURATION ?? "24h").trim();

function die(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

if (!accountId) die("CLOUDFLARE_ACCOUNT_ID is not set.");
if (!token) die("CLOUDFLARE_API_TOKEN is not set.");
if (!hostname) die("ACCESS_HOSTNAME is not set (e.g. orion.aetheraonline.com).");
if (emails.length === 0) {
  die(
    "ACCESS_EMAILS is empty. An Access application with no policy admits NOBODY, " +
      "which looks identical to a broken deployment. Name at least one address.",
  );
}

async function cf(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const errs = (body.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    // 403 almost always means the token is scoped to Workers only, which is
    // what somebody creates when they set out to do deployments. Cloudflare
    // reports it as "Authentication error", which sends people to regenerate a
    // token that was never the problem — so name the permission, and name the
    // one THIS endpoint needs rather than a general guess, because the two
    // calls here want different ones and being told the wrong permission is
    // barely better than being told none.
    const needed = pathname.includes("/access/organizations")
      ? "`Access: Organizations, Identity Providers, and Groups` → Read"
      : "`Access: Apps and Policies` → Edit";
    const hint =
      res.status === 403
        ? ` — the API token is missing ${needed}. Both are needed here, and a token scoped only for ` +
          "Workers deploys has neither. Edit the token at dash.cloudflare.com → My Profile → API Tokens."
        : "";
    die(`Cloudflare API ${res.status} on ${pathname}: ${errs || res.statusText}${hint}`);
  }
  return body.result;
}

// ── The team domain ──────────────────────────────────────────────────────────
// worker/index.ts fetches Access's signing keys from here. Read rather than
// guessed: it is set once when Zero Trust is enabled and is not derivable from
// the account id or the hostname.
const org = await cf(`/accounts/${accountId}/access/organizations`);
const teamDomain = org?.auth_domain ?? "";
if (!teamDomain) {
  die(
    "This account has no Zero Trust organization yet. Open Zero Trust in the Cloudflare " +
      "dashboard once to choose a team name, then run this again.",
  );
}

// ── The application ──────────────────────────────────────────────────────────
const existingApps = await cf(`/accounts/${accountId}/access/apps`);
const existing = (existingApps ?? []).find((a) => a.domain === hostname);

let app;
if (existing) {
  app = existing;
  console.log(`Reusing the existing Access application for ${hostname} (created ${existing.created_at}).`);
} else {
  app = await cf(`/accounts/${accountId}/access/apps`, {
    method: "POST",
    body: JSON.stringify({
      name: "ORION",
      domain: hostname,
      type: "self_hosted",
      session_duration: sessionDuration,
      // The gateway does its own logout; Access's own path is left at the
      // default rather than pointed somewhere this app does not serve.
      app_launcher_visible: true,
      // Without this the JWT never reaches the origin, and worker/index.ts
      // refuses every request for want of a session it was never sent.
      http_only_cookie_attribute: true,
    }),
  });
  console.log(`Created Access application "${app.name}" for ${hostname}.`);
}

// ── The policy ───────────────────────────────────────────────────────────────
// An application with no policy admits nobody. Checked separately from creation
// because a reused application may already have one, and adding a second
// identical allow rule each run would quietly accumulate them.
const policies = await cf(`/accounts/${accountId}/access/apps/${app.id}/policies`).catch(() => []);
const POLICY_NAME = "ORION operators";
const already = (policies ?? []).find((p) => p.name === POLICY_NAME);

if (already) {
  console.log(`Policy "${POLICY_NAME}" already exists — leaving it alone.`);
} else {
  await cf(`/accounts/${accountId}/access/apps/${app.id}/policies`, {
    method: "POST",
    body: JSON.stringify({
      name: POLICY_NAME,
      decision: "allow",
      include: emails.map((email) => ({ email: { email } })),
    }),
  });
  console.log(`Created policy "${POLICY_NAME}" admitting ${emails.length} address(es).`);
}

// ── Report ───────────────────────────────────────────────────────────────────
const aud = app.aud ?? "";
if (!aud) die("The application was created but returned no AUD tag, which should not happen.");

console.log("");
console.log(`ACCESS_AUD=${aud}`);
console.log(`ACCESS_TEAM_DOMAIN=${teamDomain}`);

// Written to the step summary so the value is readable without opening logs,
// and to GITHUB_OUTPUT so the next step can patch wrangler.jsonc with it.
const fs = await import("node:fs");
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `aud=${aud}\nteam_domain=${teamDomain}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      "## Access application",
      "",
      `- **Hostname:** \`${hostname}\``,
      `- **AUD tag:** \`${aud}\``,
      `- **Team domain:** \`${teamDomain}\``,
      `- **Admitted:** ${emails.join(", ")}`,
      "",
      "These are identifiers, not credentials — the AUD names which application a token was minted for.",
      "",
    ].join("\n"),
  );
}
