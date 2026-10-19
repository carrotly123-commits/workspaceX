/**
 * Gemini (gemini.google.com) — requires Google account.
 */

import { collectCookies } from "../core/browser.ts";
import type { RegisterContext, RegisterResult } from "../core/types.ts";
import { cookiesToString, sleep } from "../core/utils.ts";
import type { BrowserSession } from "../core/browser.ts";
import type { Page } from "playwright-core";
import { BasePlatformAdapter } from "./base.ts";

export class GeminiAdapter extends BasePlatformAdapter {
  readonly id = "gemini";
  readonly name = "Gemini (Google)";
  readonly signupUrl = "https://gemini.google.com/";
  readonly domains = ["gemini.google.com", "google.com", "accounts.google.com"];
  readonly preferredMode = "manual" as const;
  readonly needsEmail = true;
  readonly needsPhone = true;
  readonly tips =
    "必须使用 Google 账号。在浏览器登录 Google / Gemini 后回车，工具抓取 SID 等 cookie。";

  async register(ctx: RegisterContext): Promise<RegisterResult> {
    return this.captureSession(ctx);
  }

  protected async harvestCredentials(
    session: BrowserSession,
    page: Page,
    ctx: RegisterContext,
  ) {
    await page
      .goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" })
      .catch(() => {});
    await sleep(1500);

    const cookies = await collectCookies(session, [
      "https://gemini.google.com",
      "https://www.google.com",
      "https://accounts.google.com",
    ]);
    if (!cookies.length) return null;

    const hasSid = cookies.some((c) =>
      ["SID", "HSID", "SSID", "__Secure-1PSID", "__Secure-3PSID"].includes(c.name),
    );
    if (!hasSid) {
      ctx.onProgress("Google SID cookies missing — login may be incomplete.", "warn");
    }

    return {
      cookie: cookiesToString(cookies),
      userAgent: session.userAgent,
      email: ctx.identity.email,
    };
  }
}

export const geminiAdapter = new GeminiAdapter();
