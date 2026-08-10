#!/usr/bin/env node
// ── Delete the Cloudflare Access application in front of a hostname ──────────
// The counterpart to scripts/access-app.mjs, and the half of "make it public"
// that no amount of code can do: Access runs BEFORE the Worker. While an Access
// application matches the hostname, Cloudflare answers every unauthenticated
// request with its own login page and worker/index.ts is never reached — so
// PUBLIC_ACCESS="1" on its own changes nothing a visitor can see.
//
// Written as a script rather than done by hand in the dashboard for the same
// reason access-app.mjs was: the thing that removed the door should be readable
// afterwards, and "somebody clicked delete" is not a record.
//
// Deliberately NARROW. It deletes applications whose domain matches the
// hostname given and nothing else — no wildcards, no prefix matching, no
// "clean up anything that looks stale". An over-eager version of this script
// would remove the protection from an unrelated internal hostname, and that is
// a breach with a commit message.

const API = "https://api.cloudflare.com/client/v4";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
const hostname = (process.env.ACCESS_HOSTNAME ?? "").trim().toLowerCase();
// Off by default. Listing what would go is safe; removing it is not, so the
// destructive path has to be asked for.
const confirm = (process.env.ACCESS_CONFIRM_REMOVE ?? "").trim() === "yes";

function die(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

if (!accountId) die("CLOUDFLARE_ACCOUNT_ID is not set.");
if (!token) die("CLOUDFLARE_API_TOKEN is not set.");
if (!hostname) die("ACCESS_HOSTNAME is not set (e.g. orion.aetheraonline.com).");

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
    const hint =
      res.status === 403
        ? " — the API token is missing `Access: Apps and Policies` → Edit. Edit it at " +
          "dash.cloudflare.com → My Profile → API Tokens."
        : "";
    die(`Cloudflare API ${res.status} on ${pathname}: ${errs || res.statusText}${hint}`);
  }
  return body.result;
}

const apps = (await cf(`/accounts/${accountId}/access/apps`)) ?? [];
// Exact match on the domain, case-insensitively. An Access `domain` may carry a
// path (host.example.com/admin); those are different applications guarding
// different things and are left alone.
const matches = apps.filter((a) => String(a.domain ?? "").trim().toLowerCase() === hostname);

if (matches.length === 0) {
  console.log(`No Access application matches ${hostname}. Nothing to remove.`);
  console.log("This is the expected result on a re-run — the script is idempotent.");
  process.exit(0);
}

console.log(`Access applications matching ${hostname}:`);
for (const a of matches) console.log(`  - ${a.name} (id ${a.id}, aud ${a.aud})`);

if (!confirm) {
  console.log("");
  console.log("Nothing was removed. Set ACCESS_CONFIRM_REMOVE=yes to actually delete these.");
  console.log("Deleting them makes the hostname reachable without a sign-in.");
  process.exit(0);
}

for (const a of matches) {
  await cf(`/accounts/${accountId}/access/apps/${a.id}`, { method: "DELETE" });
  console.log(`Deleted Access application "${a.name}" (${a.id}).`);
}

console.log("");
console.log(`${hostname} no longer has a Cloudflare Access application in front of it.`);
console.log("It is served to anyone who knows the name. Confirm PUBLIC_ACCESS is set in");
console.log("wrangler.jsonc, or the origin will still demand an identity the edge no");
console.log("longer sends and every page will answer 403.");

const fs = await import("node:fs");
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      "## Access application removed",
      "",
      `- **Hostname:** \`${hostname}\``,
      `- **Removed:** ${matches.map((a) => `\`${a.name}\``).join(", ")}`,
      "",
      "This hostname now serves anyone who reaches it. No sign-in is required.",
      "",
    ].join("\n"),
  );
}
