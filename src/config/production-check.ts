// ── Is this deployment safe to start? ────────────────────────────────────────
//
// Pure, so the rules can be argued with in a test rather than inferred from a
// startup path nobody runs locally. Same shape as src/config/posture.ts, and
// the same instinct: the answer to "should this run" belongs in a function, not
// scattered across the code that runs it.
//
// The distinction that matters here is FATAL versus WARN.
//
//   fatal   the deployment is misconfigured in a way that either exposes data
//           or serves nothing. It must not start. Refusing at startup is
//           kinder than refusing every request: an operator reading a boot log
//           finds this in seconds, whereas a process that starts happily and
//           500s every page looks like an application bug for an afternoon.
//
//   warn    the deployment will work and something about it deserves a
//           sentence. Never escalated to fatal on a guess — a check that stops
//           a working system because it was unsure is a check people disable.

import type { PhiMode } from "../compliance/phi-detect.js";

export interface ProductionInput {
  /** From classifyBind — whether the bound address is reachable off this machine. */
  exposure: "loopback" | "exposed";
  /** The shared secret the edge must present. Empty means none is configured. */
  gatewayToken: string;
  phiMode: PhiMode;
  approvalPolicy: string;
  /** Whether the console is served to anyone, with no identity at all. */
  publicAccess: boolean;
  /** ORION_ENCRYPTION_KEY, or "" when unset. */
  encryptionKey: string;
  /** The ingress posture — whether PHI may be STORED. */
  posture: "blocked" | "permitted";
}

export interface ProductionCheck {
  id: string;
  level: "fatal" | "warn" | "ok";
  message: string;
}

export interface ProductionReport {
  checks: ProductionCheck[];
  /** True when at least one check is fatal. The gateway must not start. */
  fatal: boolean;
}

export function checkProduction(input: ProductionInput): ProductionReport {
  const checks: ProductionCheck[] = [];
  const production = input.phiMode === "production";

  // ── 1. Exposed with no way to authenticate anything ────────────────────────
  // src/gateway/auth.ts already refuses every REQUEST in this state, which is
  // correct and is also a total outage that reports itself as a 500. Refusing
  // to start turns a silent all-day failure into a boot message.
  if (input.exposure === "exposed" && input.gatewayToken === "") {
    checks.push({
      id: "gateway-token",
      level: "fatal",
      message:
        "This gateway is bound to a non-loopback address and ORION_GATEWAY_TOKEN is not set. " +
        "No request could be authenticated, so every one would be refused. Set that secret to the " +
        "same value the edge sends, or bind 127.0.0.1 for local use.",
    });
  } else {
    checks.push({
      id: "gateway-token",
      level: "ok",
      message:
        input.exposure === "loopback"
          ? "Bound to loopback — reachable only from this machine."
          : "Exposed, with a shared secret configured.",
    });
  }

  // ── 2. Production PHI mode with no approvals ───────────────────────────────
  // REFUSED rather than warned about, which is the standing pattern here (see
  // the PUBLIC_ACCESS + ORION_PHI interlock in scripts/preflight.mjs). An agent
  // that can submit a claim, send an appeal and email a record without asking,
  // over real patient data, is not a configuration anyone chose on purpose.
  if (production && input.approvalPolicy === "never") {
    checks.push({
      id: "approvals",
      level: "fatal",
      message:
        'phiMode is "production" and approvalPolicy is "never". Money and disclosure actions — submit, ' +
        "appeal, email, portal — would run with no human in the loop over real patient data. Set " +
        'approvalPolicy to "unsafe-only" or "always".',
    });
  }

  // ── 3. Production PHI mode on a console anyone can open ────────────────────
  if (production && input.publicAccess) {
    checks.push({
      id: "public-access",
      level: "fatal",
      message:
        'phiMode is "production" and public access is on. That is an unauthenticated console over ' +
        "real patient data, reachable by anyone who learns the hostname. Turn off PUBLIC_ACCESS and " +
        "put Cloudflare Access back in front of the hostname.",
    });
  }

  // ── 4. Production mode over a store that refuses PHI ───────────────────────
  // Contradictory but SAFE — the strictest of both settings wins, and nothing
  // can be stored. Worth a sentence because it usually means half a change
  // landed.
  if (production && input.posture === "blocked") {
    checks.push({
      id: "posture",
      level: "warn",
      message:
        'phiMode is "production" but the ingress posture is "blocked", so identifier-bearing documents ' +
        "are still refused with 422 and nothing is stored. Safe, and probably not what was intended — " +
        "set ORION_PHI=permitted once a Business Associate Agreement covering these services is in force.",
    });
  }

  // ── 5. Encryption at rest ──────────────────────────────────────────────────
  if (production && input.encryptionKey === "") {
    checks.push({
      id: "encryption",
      level: "warn",
      message:
        "ORION_ENCRYPTION_KEY is not set, so extracted document text is stored in the clear. Setting it " +
        "encrypts document text and its per-page sections with AES-256-GCM, which protects a STOLEN " +
        "COPY — a database file or an R2 snapshot — and nothing else: the rest of the database, and the " +
        "file itself, remain unencrypted. Generate one with `openssl rand -hex 32`.",
    });
  }

  if (production) {
    checks.push({
      id: "phi-mode",
      level: "ok",
      message:
        'phiMode is "production": chat input is screened before it is stored, anything that might ' +
        "identify a patient is refused rather than guessed about, and the model is told it is working " +
        "on real records.",
    });
  } else {
    checks.push({
      id: "phi-mode",
      level: "ok",
      message:
        'phiMode is "education": high-confidence identifiers are still refused, medium-confidence ' +
        "shapes are allowed through. Set it to \"production\" before handling real patient data.",
    });
  }

  return { checks, fatal: checks.some((c) => c.level === "fatal") };
}

/** One block of text for a boot log or a CLI run. */
export function renderProductionReport(report: ProductionReport): string {
  const mark = (level: ProductionCheck["level"]) =>
    level === "fatal" ? "FATAL" : level === "warn" ? " warn" : "   ok";
  const lines = report.checks.map((c) => `  [${mark(c.level)}] ${c.id}: ${c.message}`);
  lines.unshift("Production readiness:");
  if (report.fatal) {
    lines.push("");
    lines.push("Refusing to start. Fix the FATAL item(s) above.");
  }
  return lines.join("\n");
}
