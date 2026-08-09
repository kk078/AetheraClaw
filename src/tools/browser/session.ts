import type { Browser, BrowserContext, Page } from "playwright";
import { checkUrl, normalizeOrigin, type PortalConfig } from "./policy.js";

// ── Browser session ──────────────────────────────────────────────────────────
// One browser, one context, one page, held for the life of the gateway process
// so a portal login survives across tool calls. Everything here is I/O; the
// decisions live in policy.ts.

export interface BrowserOptions {
  headless: boolean;
  navigationTimeoutMs: number;
  /** Set when the environment ships its own Chromium rather than a downloaded one. */
  executablePath?: string;
}

export class PortalBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  /** Portals signed in during this process, so a login is not repeated blindly. */
  readonly signedIn = new Set<string>();

  constructor(private opts: BrowserOptions) {}

  async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    const { chromium } = await import("playwright");
    this.browser ??= await chromium.launch({
      headless: this.opts.headless,
      executablePath: this.opts.executablePath,
    });
    this.context ??= await this.browser.newContext({ acceptDownloads: false });
    this.context.setDefaultNavigationTimeout(this.opts.navigationTimeoutMs);
    this.page = await this.context.newPage();
    return this.page;
  }

  get currentUrl(): string {
    return this.page && !this.page.isClosed() ? this.page.url() : "";
  }

  async close(): Promise<void> {
    await this.page?.close().catch(() => {});
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
    this.signedIn.clear();
  }
}

export interface NavigationOutcome {
  ok: boolean;
  finalUrl: string;
  message: string;
}

/**
 * Navigate, then re-check where we actually ended up.
 *
 * A redirect is the ordinary way a signed-in browser gets moved somewhere it was
 * not sent, so the destination is validated after the fact and the page is left
 * blank rather than parked on a disallowed origin.
 */
export async function navigateChecked(
  page: Page,
  url: string,
  portals: PortalConfig[],
): Promise<NavigationOutcome> {
  const before = checkUrl(url, portals);
  if (!before.allowed) return { ok: false, finalUrl: page.url(), message: before.reason };

  await page.goto(url, { waitUntil: "domcontentloaded" });
  const finalUrl = page.url();

  const after = checkUrl(finalUrl, portals);
  if (!after.allowed) {
    await page.goto("about:blank").catch(() => {});
    return {
      ok: false,
      finalUrl,
      message: `Navigation to ${url} redirected to ${normalizeOrigin(finalUrl) ?? finalUrl}, which is not an allowed origin. The page was closed without being read. ${after.reason}`,
    };
  }
  return { ok: true, finalUrl, message: `At ${finalUrl} (${after.portal?.label}).` };
}

// These run inside the page, not in Node. They are passed as source strings so
// the project's type surface stays free of DOM globals — adding "DOM" to lib
// would make `document` type-check in server code, where it is always a bug.

const READ_VISIBLE_TEXT = `(() => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const parts = [];
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    if (parent) {
      const tag = parent.tagName.toLowerCase();
      const style = window.getComputedStyle(parent);
      const hidden = style.display === "none" || style.visibility === "hidden";
      if (tag !== "script" && tag !== "style" && tag !== "noscript" && !hidden) {
        const text = node.textContent ? node.textContent.trim() : "";
        if (text) parts.push(text);
      }
    }
    node = walker.nextNode();
  }
  return parts.join("\\n");
})()`;

const DESCRIBE_FIELDS = `(() => {
  const out = [];
  const inputs = document.querySelectorAll("input, select, textarea");
  inputs.forEach((input, i) => {
    const id = input.id ? "#" + input.id : "";
    const name = input.name ? '[name="' + input.name + '"]' : "";
    const label =
      (input.labels && input.labels[0] && input.labels[0].textContent
        ? input.labels[0].textContent.trim()
        : "") ||
      input.getAttribute("aria-label") ||
      input.getAttribute("placeholder") ||
      "";
    out.push({
      selector: id || name || input.tagName.toLowerCase() + ":nth-of-type(" + (i + 1) + ")",
      type: input.type || input.tagName.toLowerCase(),
      name: input.name || "",
      label: label,
    });
  });
  return out;
})()`;

/** Visible text only — scripts, styles and hidden nodes are not page content. */
export async function readVisibleText(page: Page): Promise<string> {
  return (await page.evaluate(READ_VISIBLE_TEXT)) as string;
}

export interface FieldInfo {
  selector: string;
  type: string;
  name: string;
  label: string;
}

/** Form fields on the page, so a fill can be aimed without guessing selectors. */
export async function describeFields(page: Page): Promise<FieldInfo[]> {
  return (await page.evaluate(DESCRIBE_FIELDS)) as FieldInfo[];
}

export async function fieldType(page: Page, selector: string): Promise<string | undefined> {
  try {
    return await page.locator(selector).first().getAttribute("type").then((t) => t ?? undefined);
  } catch {
    return undefined;
  }
}
