// ── Can this install drive a browser at all ──────────────────────────────────
//
// The portal tools fail in the least useful way available when Playwright or
// its Chromium is absent: an import error or a launch error, mid-task, phrased
// in terms of a browser binary the operator never asked for. What a biller sees
// is that logging into the payer portal "did not work".
//
// The diagnosis is cheap and the answer is fixed, so it is worth asking BEFORE
// the first navigation rather than after — and worth being able to ask on
// demand, which is what `portal_health` is for.
//
// The verdict is deliberately three-valued rather than a boolean. "Playwright
// is missing" and "Playwright is here and its Chromium is not" have completely
// different fixes (`npm install` versus `npx playwright install chromium`, or
// pointing at a system Chromium), and a single false would send somebody to the
// wrong one.

export type BrowserHealth = "ready" | "no_playwright" | "no_browser_binary";

export interface BrowserHealthReport {
  status: BrowserHealth;
  /** One sentence naming what is wrong. */
  summary: string;
  /** The exact command or setting that fixes it. "Install the browser" is not an instruction. */
  fix: string;
  /** Where the binary was looked for, when that is known. */
  executablePath: string;
}

export interface HealthProbe {
  /** Injected so a test can describe an environment without having one. */
  importPlaywright?: () => Promise<unknown>;
  launch?: (executablePath?: string) => Promise<{ close: () => Promise<void> }>;
  executablePath?: string;
}

/**
 * Turn whatever went wrong into a verdict and a fix.
 *
 * Pure and exported so the message can be asserted without a browser, which is
 * the only way the DEGRADED path gets tested at all — and the degraded path is
 * the one an install without Chromium always takes.
 */
export function classifyBrowserError(err: unknown, executablePath: string): BrowserHealthReport {
  const message = err instanceof Error ? err.message : String(err);

  // A missing package and a missing binary both surface as errors from the same
  // call, and only the text tells them apart.
  if (/Cannot find (module|package) 'playwright'|ERR_MODULE_NOT_FOUND/.test(message)) {
    return {
      status: "no_playwright",
      summary: "Playwright is not installed, so no portal tool can open a page.",
      fix: "npm install playwright   (it is an optional dependency — the rest of Orion runs without it)",
      executablePath,
    };
  }
  return {
    status: "no_browser_binary",
    summary: `Playwright is installed but could not start a browser: ${message.split("\n")[0].slice(0, 200)}`,
    fix: executablePath
      ? `Check that ${executablePath} exists and is executable, or clear browser.executablePath to use Playwright's own download.`
      : "npx playwright install chromium   — or set browser.executablePath to a Chromium already on this machine.",
    executablePath,
  };
}

/**
 * Ask the question for real: import, launch, close.
 *
 * It actually launches rather than checking for a file. A binary that exists and
 * cannot run — wrong architecture, missing shared library, no sandbox
 * permissions — passes every cheaper check and fails at the moment it matters.
 */
export async function checkBrowserHealth(probe: HealthProbe = {}): Promise<BrowserHealthReport> {
  const executablePath = probe.executablePath ?? "";
  try {
    const importer = probe.importPlaywright ?? (() => import("playwright"));
    const mod = (await importer()) as { chromium?: { launch: (o: unknown) => Promise<{ close: () => Promise<void> }> } };
    const launcher =
      probe.launch ??
      (async (p?: string) => {
        if (!mod.chromium) throw new Error("the playwright module exported no chromium launcher");
        return mod.chromium.launch({ headless: true, executablePath: p || undefined });
      });
    const browser = await launcher(executablePath);
    await browser.close().catch(() => {});
    return {
      status: "ready",
      summary: "A headless browser starts and closes cleanly. Portal automation is available.",
      fix: "",
      executablePath,
    };
  } catch (err) {
    return classifyBrowserError(err, executablePath);
  }
}

export function renderBrowserHealth(report: BrowserHealthReport): string {
  if (report.status === "ready") {
    return `Browser: ready.${report.executablePath ? ` Using ${report.executablePath}.` : ""}`;
  }
  return [
    `Browser: NOT AVAILABLE — ${report.summary}`,
    `  Fix: ${report.fix}`,
    // Said explicitly, because the alternative reading is that the whole
    // product is broken. Portal automation is one capability among many.
    "  Everything that does not drive a portal — scrubbing, X12, eligibility, analytics — is unaffected.",
  ].join("\n");
}
