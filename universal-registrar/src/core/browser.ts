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

/** Track virtual cursor position per Page for realistic mouse movement trajectories. */
const cursorPositions = new WeakMap<Page, { x: number; y: number }>();

/**
 * Minimal, non-invasive stealth patch:
 * Only masks `navigator.webdriver` and ensures `window.chrome.runtime` exists
 * without spoofing Canvas/WebGL/UA (which would mismatch a real headed Chrome).
 */
const MINIMAL_STEALTH_SCRIPT = () => {
  try {
    if (Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver") || navigator.webdriver) {
      Object.defineProperty(Navigator.prototype, "webdriver", {
        get: () => undefined,
        configurable: true,
      });
    }
    const w = window as unknown as Record<string, unknown>;
    if (!w.chrome) w.chrome = {};
    const ch = w.chrome as Record<string, unknown>;
    if (!ch.runtime) ch.runtime = {};
  } catch {
    /* ignore */
  }
};

export async function applyMinimalStealth(page: Page): Promise<void> {
  await page.addInitScript(MINIMAL_STEALTH_SCRIPT).catch(() => {});
  await page.evaluate(MINIMAL_STEALTH_SCRIPT).catch(() => {});
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
  await context.addInitScript(MINIMAL_STEALTH_SCRIPT).catch(() => {});
  const page = context.pages()[0] ?? (await context.newPage());
  await applyMinimalStealth(page);
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
  await applyMinimalStealth(page);
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
 * WindMouse-inspired human trajectory movement to a target coordinate.
 * Generates smooth acceleration/deceleration steps with subtle hand jitter.
 */
export async function humanMoveTo(page: Page, targetX: number, targetY: number): Promise<void> {
  const prev = cursorPositions.get(page) ?? {
    x: 120 + Math.random() * 300,
    y: 100 + Math.random() * 220,
  };
  const dx = targetX - prev.x;
  const dy = targetY - prev.y;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(8, Math.min(28, Math.round(dist / 22)));

  const bend = (Math.random() - 0.5) * Math.min(60, dist * 0.25);
  const midX = (prev.x + targetX) / 2 - (dy / (dist || 1)) * bend;
  const midY = (prev.y + targetY) / 2 + (dx / (dist || 1)) * bend;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = 1 - Math.pow(1 - t, 3);
    const inv = 1 - ease;
    const jitter = i < steps ? (Math.random() - 0.5) * 1.6 : 0;
    const x = inv * inv * prev.x + 2 * inv * ease * midX + ease * ease * targetX + jitter;
    const y = inv * inv * prev.y + 2 * inv * ease * midY + ease * ease * targetY + jitter;
    await page.mouse.move(x, y);
    await new Promise((r) => setTimeout(r, 4 + Math.random() * 8));
  }

  cursorPositions.set(page, { x: targetX, y: targetY });
}

/**
 * Click inside a bounding box using human-like trajectory, off-center point, and hold delay.
 */
export async function humanClickBox(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
  const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);
  await humanMoveTo(page, targetX, targetY);
  await new Promise((r) => setTimeout(r, 45 + Math.random() * 90));
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 35 + Math.random() * 75));
  await page.mouse.up();
}

/**
 * Try a list of CSS / text selectors until one is visible, then click.
 * Uses human-like mouse trajectory when a bounding box is available.
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
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      const box = await loc.boundingBox().catch(() => null);
      if (box && box.width > 4 && box.height > 4) {
        await humanClickBox(page, box);
      } else {
        await loc.click({ timeout });
      }
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

/**
 * Fill the first matching visible input using realistic focus + sequential keystrokes,
 * falling back to direct `.fill()` if the element transforms or rejects sequential input.
 */
export async function fillFirst(
  page: Page,
  selectors: string[],
  value: string,
  options: { timeoutMs?: number; clear?: boolean; humanLike?: boolean } = {},
): Promise<boolean> {
  const timeout = options.timeoutMs ?? 8_000;
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: "visible", timeout: Math.min(timeout, 3000) });
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      const box = await loc.boundingBox().catch(() => null);
      if (box && box.width > 4 && box.height > 4) {
        await humanClickBox(page, box);
      } else {
        await loc.click({ timeout: 2000 }).catch(() => {});
      }
      if (options.clear !== false) await loc.fill("");
      if (options.humanLike !== false && value.length <= 64) {
        await loc.pressSequentially(value, { delay: 32 + Math.random() * 55 });
        const currentVal = await loc.inputValue().catch(() => value);
        if (currentVal !== value) {
          await loc.fill(value, { timeout });
        }
      } else {
        await loc.fill(value, { timeout });
      }
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
