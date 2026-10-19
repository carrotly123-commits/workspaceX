/**
 * ChatGPT (chatgpt.com) adapter — OpenAI auth is complex (OTP + Google/Apple).
 * Manual session capture is the supported path.
 */

import { collectCookies } from "../core/browser.ts";
import type { RegisterContext, RegisterResult } from "../core/types.ts";
import { cookiesToString, sleep } from "../core/utils.ts";
import type { BrowserSession } from "../core/browser.ts";
import type { Page } from "playwright-core";
import { BasePlatformAdapter } from "./base.ts";

export class ChatGPTAdapter extends BasePlatformAdapter {
  readonly id = "chatgpt";
  readonly name = "ChatGPT (OpenAI)";
  readonly signupUrl = "https://chatgpt.com/";
  readonly domains = ["chatgpt.com", "openai.com", "auth.openai.com"];
  readonly preferredMode = "manual" as const;
  readonly needsEmail = true;
  readonly needsPhone = true;
  readonly tips =
    "OpenAI 注册通常要邮箱 + 可能的手机验证。在浏览器完成登录后回车；工具会尝试抓 access token 与 cookie。";

  async register(ctx: RegisterContext): Promise<RegisterResult> {
    return this.captureSession(ctx);
  }

  protected async harvestCredentials(
    session: BrowserSession,
    page: Page,
    ctx: RegisterContext,
  ) {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
    await sleep(2000);

    const cookies = await collectCookies(session, [
      "https://chatgpt.com",
      "https://openai.com",
      "https://auth.openai.com",
    ]);
    const cookie = cookiesToString(cookies);

    // Try to pull access token the same way many open-source tools do
    let accessToken = "";
    try {
      accessToken = await page.evaluate(async () => {
        try {
          const res = await fetch("/api/auth/session", { credentials: "include" });
          if (!res.ok) return "";
          const data = await res.json();
          return data?.accessToken || data?.access_token || "";
        } catch {
          return "";
        }
      });
    } catch {
      /* ignore */
    }

    if (!cookie && !accessToken) return null;

    return {
      cookie,
      accessToken: accessToken || undefined,
      userAgent: session.userAgent,
      email: ctx.identity.email,
    };
  }
}

export const chatgptAdapter = new ChatGPTAdapter();
