/**
 * Pragmatic anti-bot & captcha handler for real-world browser sessions:
 * 1. Waits through passive interstitials (Cloudflare "Just a moment...").
 * 2. Attempts a single human-like click on Cloudflare Turnstile / checkbox challenges.
 * 3. When an interactive puzzle (slider, image grid, Arkose) remains visible,
 *    brings the tab to front and auto-detects completion in real time so the user
 *    doesn't have to switch back to the terminal to press Enter.
 */

import type { ElementHandle, Locator, Page } from "playwright-core";
import { humanClickBox } from "./browser.ts";
import type { ProgressFn } from "./types.ts";
import { sleep } from "./utils.ts";

export interface CaptchaDetection {
  present: boolean;
  kind?: "cf-interstitial" | "turnstile" | "hcaptcha" | "recaptcha" | "geetest" | "arkose" | "generic";
  solved?: boolean;
}

/** Inspect page DOM & frames for active challenge widgets or interstitials. */
export async function detectCaptchaState(page: Page): Promise<CaptchaDetection> {
  try {
    const state = await page.evaluate(() => {
      const title = document.title.toLowerCase();
      const bodyText = (document.body?.innerText || "").slice(0, 1500).toLowerCase();

      // 1. Passive Cloudflare 5s interstitial
      if (
        title.includes("just a moment") ||
        title.includes("请稍候") ||
        document.querySelector("#cf-wrapper, #challenge-running, #challenge-stage")
      ) {
        return { present: true, kind: "cf-interstitial" as const, solved: false };
      }

      // 2. Check solved hidden token inputs first
      const turnstileInput = document.querySelector<HTMLInputElement>(
        'input[name="cf-turnstile-response"]',
      );
      if (turnstileInput && turnstileInput.value.length > 20) {
        return { present: false, kind: "turnstile" as const, solved: true };
      }

      const isVisible = (el: Element | null): boolean => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return false;
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      };

      // 3. Cloudflare Turnstile iframe / container
      const cfFrame = document.querySelector(
        'iframe[src*="challenges.cloudflare.com"], .cf-turnstile, [data-sitekey]',
      );
      if (isVisible(cfFrame)) {
        return { present: true, kind: "turnstile" as const, solved: false };
      }

      // 4. hCaptcha
      const hcap = document.querySelector('iframe[src*="hcaptcha.com"], .h-captcha');
      if (isVisible(hcap)) {
        const resp = document.querySelector<HTMLTextAreaElement>(
          'textarea[name="h-captcha-response"]',
        );
        if (resp && resp.value.length > 20) {
          return { present: false, kind: "hcaptcha" as const, solved: true };
        }
        return { present: true, kind: "hcaptcha" as const, solved: false };
      }

      // 5. reCAPTCHA
      const recap = document.querySelector('iframe[src*="google.com/recaptcha"], .g-recaptcha');
      if (isVisible(recap)) {
        const resp = document.querySelector<HTMLTextAreaElement>(
          'textarea[name="g-recaptcha-response"]',
        );
        if (resp && resp.value.length > 20) {
          return { present: false, kind: "recaptcha" as const, solved: true };
        }
        return { present: true, kind: "recaptcha" as const, solved: false };
      }

      // 6. GeeTest / Slider / Arkose / Domestic AI captchas
      const geetest = document.querySelector(
        '.geetest_panel_box, .geetest_widget, .geetest_btn, [class*="captcha-modal"], [id*="captcha"], iframe[src*="arkoselabs.com"], iframe[src*="funcaptcha.com"]',
      );
      if (isVisible(geetest)) {
        return { present: true, kind: "geetest" as const, solved: false };
      }

      if (
        bodyText.includes("verify you are human") ||
        bodyText.includes("确认您是真人") ||
        bodyText.includes("请完成安全验证") ||
        bodyText.includes("安全验证")
      ) {
        const dialog = document.querySelector('[role="dialog"], .modal, [class*="modal"], [class*="verify"]');
        if (isVisible(dialog)) {
          return { present: true, kind: "generic" as const, solved: false };
        }
      }

      return { present: false, solved: false };
    });
    return state;
  } catch {
    return { present: false };
  }
}

/**
 * Try a single human-like click on the checkbox portion of a Turnstile / reCAPTCHA / hCaptcha widget.
 * Turnstile checkboxes sit on the left side (~28-36px from left edge, vertically centered).
 */
async function tryClickChallengeCheckbox(page: Page, kind: CaptchaDetection["kind"]): Promise<boolean> {
  const selectors =
    kind === "turnstile"
      ? [
          'iframe[src*="challenges.cloudflare.com"]',
          ".cf-turnstile",
          "#cf-turnstile",
          '[id*="turnstile"]',
        ]
      : [
          'iframe[src*="challenges.cloudflare.com"]',
          'iframe[src*="hcaptcha.com"]',
          'iframe[src*="google.com/recaptcha/api2/anchor"]',
          ".geetest_radar_tip",
          ".geetest_btn",
        ];

  for (const sel of selectors) {
    try {
      const loc: Locator = page.locator(sel).first();
      const visible = await loc.isVisible().catch(() => false);
      if (!visible) continue;
      const box = await loc.boundingBox();
      if (!box || box.width < 20 || box.height < 20) continue;

      const targetBox = {
        x: box.x + Math.min(28, box.width * 0.15),
        y: box.y + box.height * 0.35,
        width: Math.min(20, box.width * 0.2),
        height: Math.min(20, box.height * 0.3),
      };
      await humanClickBox(page, targetBox);
      return true;
    } catch {
      /* try next */
    }
  }

  for (const frame of page.frames()) {
    const url = frame.url();
    if (url.includes("challenges.cloudflare.com") || url.includes("turnstile")) {
      try {
        const frameEl = (await frame.frameElement()) as ElementHandle<HTMLElement> | null;
        const box = await frameEl?.boundingBox();
        if (box && box.width >= 20 && box.height >= 20) {
          await humanClickBox(page, {
            x: box.x + 26,
            y: box.y + box.height * 0.38,
            width: 16,
            height: 16,
          });
          return true;
        }
      } catch {
        /* ignore */
      }
    }
  }

  return false;
}

/**
 * Pragmatic captcha handler:
 * - Auto-waits passive 5s shields.
 * - Attempts 1 natural click on Turnstile / checkbox widgets.
 * - If interactive captcha persists, focuses the browser tab and polls until
 *   the user solves it in the browser (or until timeoutMs).
 */
export async function handleCaptchaIfPresent(
  page: Page,
  onProgress?: ProgressFn,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const initial = await detectCaptchaState(page);
  if (!initial.present) return false;

  const start = Date.now();

  // 1. Passive Cloudflare interstitial: wait up to 12s before attempting a click
  if (initial.kind === "cf-interstitial") {
    onProgress?.("Detected Cloudflare interstitial shield, waiting for auto-pass...", "info");
    for (let i = 0; i < 6; i++) {
      await sleep(2000);
      const cur = await detectCaptchaState(page);
      if (!cur.present) {
        onProgress?.("Cloudflare shield passed automatically.", "success");
        return true;
      }
    }
  }

  // 2. Attempt human-like checkbox click (works for Turnstile / low-risk checkbox)
  const current = await detectCaptchaState(page);
  if (
    current.present &&
    (current.kind === "turnstile" ||
      current.kind === "cf-interstitial" ||
      current.kind === "hcaptcha" ||
      current.kind === "recaptcha" ||
      current.kind === "geetest")
  ) {
    onProgress?.(`Detected ${current.kind} challenge — attempting human-like checkbox click...`, "info");
    const clicked = await tryClickChallengeCheckbox(page, current.kind);
    if (clicked) {
      await sleep(2500);
      const afterClick = await detectCaptchaState(page);
      if (!afterClick.present || afterClick.solved) {
        onProgress?.(`${current.kind} challenge passed automatically!`, "success");
        return true;
      }
    }
  }

  // 3. Interactive challenge remains: bring tab to front and auto-poll for completion
  await page.bringToFront().catch(() => {});
  onProgress?.(
    `Interactive captcha (${current.kind ?? "challenge"}) requires human action in browser — auto-continuing as soon as you solve it...`,
    "warn",
  );

  while (Date.now() - start < timeoutMs) {
    await sleep(1500);
    const state = await detectCaptchaState(page);
    if (!state.present || state.solved) {
      onProgress?.("Captcha solved! Resuming automated flow...", "success");
      await sleep(600);
      return true;
    }
  }

  onProgress?.("Captcha wait timed out; continuing flow...", "warn");
  return false;
}
