/**
 * Kimi (kimi.com / moonshot) registration adapter.
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

export class KimiAdapter extends BasePlatformAdapter {
  readonly id = "kimi";
  readonly name = "Kimi";
  readonly signupUrl = "https://www.kimi.com/";
  readonly domains = ["kimi.com", "www.kimi.com"];
  readonly preferredMode = "semi" as const;
  readonly needsEmail = true;
  readonly needsPhone = true;
  readonly tips =
    "Kimi often requires phone SMS. Complete SMS in the browser; the tool will capture access_token afterwards.";

  async register(ctx: RegisterContext): Promise<RegisterResult> {
    return semiAutoSignupFlow(this, ctx, {
      openForm: async (page) => {
        await clickFirst(page, [
          'button:has-text("登录")',
          'button:has-text("Login")',
          'a:has-text("登录")',
          '[class*="login"]',
          'text=登录',
        ], { timeoutMs: 5000 });
        await sleep(600);
        await clickFirst(page, [
          'text=注册',
          'text=Sign up',
          'button:has-text("注册")',
          'a:has-text("注册")',
        ], { timeoutMs: 4000 });
        // Prefer email tab if phone is default
        await clickFirst(page, [
          'text=邮箱',
          'text=Email',
          'button:has-text("邮箱")',
        ], { timeoutMs: 3000 });
      },

      fillForm: async (page) => {
        // Phone-first UIs: fill phone if provided
        if (ctx.identity.phone) {
          await page
            .locator('input[type="tel"], input[placeholder*="手机"], input[name="phone"]')
            .first()
            .fill(ctx.identity.phone)
            .catch(() => {});
        }
        await fillEmailPasswordForm(page, ctx.identity).catch(async () => {
          // Some flows only ask phone; leave to human
          ctx.onProgress("Could not auto-fill email/password form — complete in browser.", "warn");
        });
      },

      submit: async (page) => {
        await clickSignupSubmit(page);
      },

      verifyEmail: async (page) => {
        const visible = await page
          .locator('input[placeholder*="验证码"], input[name="code"], input[autocomplete="one-time-code"]')
          .first()
          .isVisible()
          .catch(() => false);
        if (visible && !ctx.identity.phone) {
          await handleEmailCode(page, ctx, { codeLength: 6 });
        }
      },

      isSuccess: async (page) => {
        return page.evaluate(() => {
          return (
            document.cookie.includes("access_token") ||
            !!localStorage.getItem("access_token") ||
            document.cookie.includes("kimi-auth")
          );
        });
      },

      harvest: async (session, page) => harvestKimi(session, page, ctx),
    });
  }

  protected async harvestCredentials(session: BrowserSession, page: Page, ctx: RegisterContext) {
    return harvestKimi(session, page, ctx);
  }
}

async function harvestKimi(
  session: BrowserSession,
  page: Page,
  ctx: RegisterContext,
): Promise<Record<string, unknown> | null> {
  if (!page.url().includes("kimi.com")) {
    await page.goto("https://www.kimi.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
  }
  await sleep(1000);

  const cookies = await collectCookies(session, ["https://www.kimi.com", "https://kimi.com"]);
  const cookieString = cookiesToString(cookies);

  const tokens = await page.evaluate(() => {
    return {
      access_token: localStorage.getItem("access_token") || undefined,
      refresh_token: localStorage.getItem("refresh_token") || undefined,
    };
  });

  if (!cookieString && !tokens.access_token) return null;

  return {
    cookie: cookieString || undefined,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    userAgent: session.userAgent,
    email: ctx.identity.email,
  };
}

export const kimiAdapter = new KimiAdapter();
