/**
 * Qwen international (chat.qwen.ai) + Qwen CN (tongyi.aliyun.com) adapters.
 */

import type { Page } from "playwright-core";
import { clickFirst, collectCookies, type BrowserSession } from "../core/browser.ts";
import type { RegisterContext, RegisterResult } from "../core/types.ts";
import { cookiesToString, sleep } from "../core/utils.ts";
import {
  BasePlatformAdapter,
  clickSignupSubmit,
  fillEmailPasswordForm,
  handleEmailCode,
  semiAutoSignupFlow,
} from "./base.ts";

export class QwenAdapter extends BasePlatformAdapter {
  readonly id = "qwen";
  readonly name = "Qwen (Intl)";
  readonly signupUrl = "https://chat.qwen.ai/";
  readonly domains = ["chat.qwen.ai", "qwen.ai"];
  readonly preferredMode = "semi" as const;
  readonly needsEmail = true;
  readonly needsPhone = false;
  readonly tips = "Qwen Intl usually supports email signup; captcha may appear.";

  async register(ctx: RegisterContext): Promise<RegisterResult> {
    return semiAutoSignupFlow(this, ctx, {
      openForm: async (page) => {
        await clickFirst(page, [
          'button:has-text("Sign in")',
          'button:has-text("Log in")',
          'button:has-text("Login")',
          'a:has-text("Sign in")',
          'text=Sign up',
        ], { timeoutMs: 5000 });
        await sleep(500);
        await clickFirst(page, [
          'a:has-text("Sign up")',
          'button:has-text("Sign up")',
          'text=Create account',
          'text=Register',
        ], { timeoutMs: 4000 });
      },
      fillForm: async (page) => fillEmailPasswordForm(page, ctx.identity),
      submit: async (page) => clickSignupSubmit(page),
      verifyEmail: async (page) => {
        const has = await page
          .locator('input[autocomplete="one-time-code"], input[name="code"], input[placeholder*="code" i]')
          .first()
          .isVisible()
          .catch(() => false);
        if (has) await handleEmailCode(page, ctx, { codeLength: 6 });
      },
      harvest: async (session, page) => {
        const cookies = await collectCookies(session, ["https://chat.qwen.ai"]);
        if (!cookies.length) return null;
        return {
          cookie: cookiesToString(cookies),
          userAgent: session.userAgent,
          email: ctx.identity.email,
        };
      },
    });
  }
}

export class QwenCnAdapter extends BasePlatformAdapter {
  readonly id = "qwen-cn";
  readonly name = "通义千问 (国内)";
  readonly signupUrl = "https://tongyi.aliyun.com/";
  readonly domains = ["tongyi.aliyun.com", "aliyun.com"];
  readonly preferredMode = "manual" as const;
  readonly needsEmail = false;
  readonly needsPhone = true;
  readonly tips =
    "国内通义依赖阿里云账号 / 手机号，建议 manual 模式在浏览器完成注册登录后自动抓 cookie + XSRF。";

  async register(ctx: RegisterContext): Promise<RegisterResult> {
    // Force human-driven flow; still harvest TFG-shaped creds
    return this.captureSession(ctx);
  }

  protected async harvestCredentials(session: BrowserSession, page: Page, ctx: RegisterContext) {
    const cookies = await collectCookies(session, [
      "https://tongyi.aliyun.com",
      "https://www.aliyun.com",
    ]);
    if (!cookies.length) return null;
    const cookie = cookiesToString(cookies);
    const xsrf =
      cookies.find((c) => /xsrf|csrf/i.test(c.name))?.value ||
      (await page
        .evaluate(() => {
          const m = document.cookie.match(/(?:XSRF-TOKEN|csrf_token)=([^;]+)/);
          return m?.[1] ?? "";
        })
        .catch(() => ""));

    return {
      cookie,
      xsrf: xsrf || undefined,
      userAgent: session.userAgent,
      email: ctx.identity.email,
    };
  }
}

export const qwenAdapter = new QwenAdapter();
export const qwenCnAdapter = new QwenCnAdapter();
