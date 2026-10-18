/**
 * Grok (grok.com / xAI) adapter.
 * Usually requires X/Twitter or Google OAuth — manual/semi only.
 */

import { collectCookies } from "../core/browser.ts";
import type { RegisterContext, RegisterResult } from "../core/types.ts";
import { cookiesToString, sleep } from "../core/utils.ts";
import type { BrowserSession } from "../core/browser.ts";
import type { Page } from "playwright-core";
import { BasePlatformAdapter } from "./base.ts";

export class GrokAdapter extends BasePlatformAdapter {
  readonly id = "grok";
  readonly name = "Grok (xAI)";
  readonly signupUrl = "https://grok.com/";
  readonly domains = ["grok.com", "x.com", "twitter.com"];
  readonly preferredMode = "manual" as const;
  readonly needsEmail = false;
  readonly needsPhone = false;
  readonly tips =
    "Grok 依赖 X / Google 登录。用 manual 模式：浏览器完成注册登录后回车，工具抓取 sso cookie。";

  async register(ctx: RegisterContext): Promise<RegisterResult> {
    return this.captureSession(ctx);
  }

  protected async harvestCredentials(
    session: BrowserSession,
    page: Page,
    ctx: RegisterContext,
  ) {
    // Prefer grok.com cookies; sso is the key one for TFG
    if (!page.url().includes("grok.com")) {
      await page.goto("https://grok.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
      await sleep(1500);
    }
    const cookies = await collectCookies(session, ["https://grok.com"]);
    const cookie = cookiesToString(cookies);
    if (!cookie || cookie.length < 5) return null;
    const hasSso = cookies.some((c) => c.name.toLowerCase().includes("sso"));
    if (!hasSso) {
      ctx.onProgress("No sso cookie yet — are you fully logged in?", "warn");
    }
    return {
      cookie,
      userAgent: session.userAgent,
      email: ctx.identity.email,
    };
  }
}

export const grokAdapter = new GrokAdapter();
