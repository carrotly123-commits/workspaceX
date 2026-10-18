/**
 * Thin CDP browser helper shared by all platform adapters.
 * Reuses an already-running Chrome debug instance (same model as token-free-gateway).
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  userAgent: string;
  close: () => Promise<void>;
}

async function getChromeWebSocketUrl(cdpUrl: string, timeoutMs = 3000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/version`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { webSocketDebuggerUrl?: string };
    return data.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function getHeadersWithAuth(wsUrl: string): Record<string, string> | undefined {
  try {
    const u = new URL(wsUrl);
    if (u.username || u.password) {
      const token = Buffer.from(`${u.username}:${u.password}`).toString("base64");
      return { Authorization: `Basic ${token}` };
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Connect to Chrome over CDP. Does NOT launch a new browser by default —
 * start Chrome with --remote-debugging-port=9222 first (or use token-free-gateway chrome start).
 */
export async function connectCdp(cdpUrl = "http://127.0.0.1:9222"): Promise<BrowserSession> {
  let wsUrl: string | null = null;
  for (let i = 0; i < 15; i++) {
    wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
    if (wsUrl) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!wsUrl) {
    throw new Error(
      `Cannot reach Chrome CDP at ${cdpUrl}.\n` +
        `Start it with:\n` +
        `  token-free-gateway chrome start\n` +
        `  # or manually:\n` +
        `  chrome --remote-debugging-port=9222 --user-data-dir="%TEMP%\\chrome-debug"`,
    );
  }

  const browser = await chromium.connectOverCDP(wsUrl, {
    headers: getHeadersWithAuth(wsUrl),
  });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => "Mozilla/5.0");

  return {
    browser,
    context,
    page,
    userAgent,
    close: async () => {
      // Do not browser.close() — that would kill the shared Chrome instance.
      // Just disconnect.
      try {
        browser.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Open a fresh tab in the shared context. */
export async function newPage(session: BrowserSession, url?: string): Promise<Page> {
  const page = await session.context.newPage();
  if (url) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  return page;
}

/** Collect cookies for one or more URLs/domains. */
export async function collectCookies(
  session: BrowserSession,
  urls: string[],
): Promise<Array<{ name: string; value: string; domain: string; path: string }>> {
  const cookies = await session.context.cookies(urls);
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
  }));
}

/**
 * Wait until a predicate on the page becomes true, or timeout.
 */
export async function waitForPageCondition(
  page: Page,
  fn: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; pollMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const pollMs = options.pollMs ?? 1000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await page.evaluate(fn);
      if (ok) return;
    } catch {
      /* page may be navigating */
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `Timeout waiting for page condition${options.label ? `: ${options.label}` : ""} (${timeoutMs}ms)`,
  );
}

/**
 * Try a list of CSS / text selectors until one is visible, then click.
 */
export async function clickFirst(
  page: Page,
  selectors: string[],
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const timeout = options.timeoutMs ?? 8_000;
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: "visible", timeout: Math.min(timeout, 3000) });
      await loc.click({ timeout });
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

/**
 * Fill the first matching visible input.
 */
export async function fillFirst(
  page: Page,
  selectors: string[],
  value: string,
  options: { timeoutMs?: number; clear?: boolean } = {},
): Promise<boolean> {
  const timeout = options.timeoutMs ?? 8_000;
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: "visible", timeout: Math.min(timeout, 3000) });
      if (options.clear !== false) await loc.fill("");
      await loc.fill(value, { timeout });
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

/** Human-ish typing delay helper (optional). */
export async function typeHuman(page: Page, selector: string, text: string): Promise<void> {
  const loc = page.locator(selector).first();
  await loc.click();
  await loc.fill("");
  await loc.pressSequentially(text, { delay: 40 + Math.random() * 60 });
}
