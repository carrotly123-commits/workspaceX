/**
 * 豆包 Doubao (www.doubao.com) adapter.
 */

import { clickFirst, collectCookies } from "../core/browser.ts";
import type { RegisterContext, RegisterResult } from "../core/types.ts";
import { cookiesToString, sleep } from "../core/utils.ts";
import {
  BasePlatformAdapter,
  clickSignupSubmit,
  fillEmailPasswordForm,
  semiAutoSignupFlow,
} from "./base.ts";

export class DoubaoAdapter extends BasePlatformAdapter {
  readonly id = "doubao";
  readonly name = "豆包 Doubao";
  readonly signupUrl = "https://www.doubao.com/";
  readonly domains = ["doubao.com", "www.doubao.com"];
  readonly preferredMode = "manual" as const;
  readonly needsEmail = false;
  readonly needsPhone = true;
  readonly tips =
    "豆包主要走手机号 / 抖音授权。推荐 manual：浏览器里注册登录后回车抓取 cookie。";

  async register(ctx: RegisterContext): Promise<RegisterResult> {
    if (ctx.mode === "manual") return this.captureSession(ctx);

    return semiAutoSignupFlow(this, ctx, {
      openForm: async (page) => {
        await clickFirst(page, [
          'button:has-text("登录")',
          'text=登录',
          '[class*="login"]',
        ], { timeoutMs: 5000 });
        await sleep(800);
      },
      fillForm: async (page) => {
        if (ctx.identity.phone) {
          await page
            .locator('input[type="tel"], input[placeholder*="手机"]')
            .first()
            .fill(ctx.identity.phone)
            .catch(() => {});
        }
        await fillEmailPasswordForm(page, ctx.identity).catch(() => {
          ctx.onProgress("Form not auto-fillable — finish in browser (SMS/ Douyin).", "warn");
        });
      },
      submit: async (page) => {
        await clickSignupSubmit(page).catch(() => {});
      },
      harvest: async (session) => {
        const cookies = await collectCookies(session, [
          "https://www.doubao.com",
          "https://doubao.com",
        ]);
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

export const doubaoAdapter = new DoubaoAdapter();
