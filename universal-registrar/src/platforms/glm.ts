/**
 * 智谱 GLM (chatglm.cn) + GLM International adapters.
 */

import { clickFirst, collectCookies } from "../core/browser.ts";
import type { RegisterContext, RegisterResult } from "../core/types.ts";
import { cookiesToString, sleep } from "../core/utils.ts";
import {
  BasePlatformAdapter,
  clickSignupSubmit,
  fillEmailPasswordForm,
  handleEmailCode,
  semiAutoSignupFlow,
} from "./base.ts";

export class GlmAdapter extends BasePlatformAdapter {
  readonly id = "glm";
  readonly name = "智谱 GLM";
  readonly signupUrl = "https://chatglm.cn/";
  readonly domains = ["chatglm.cn", "www.chatglm.cn"];
  readonly preferredMode = "semi" as const;
  readonly needsEmail = true;
  readonly needsPhone = true;
  readonly tips = "智谱常需要手机验证码；可先填邮箱密码，短信在浏览器完成。";

  async register(ctx: RegisterContext): Promise<RegisterResult> {
    return semiAutoSignupFlow(this, ctx, {
      openForm: async (page) => {
        await clickFirst(page, [
          'button:has-text("登录")',
          'text=登录',
          'a:has-text("登录")',
        ]);
        await sleep(500);
        await clickFirst(page, [
          'text=注册',
          'button:has-text("注册")',
          'a:has-text("注册")',
        ]);
      },
      fillForm: async (page) => {
        if (ctx.identity.phone) {
          await page
            .locator('input[placeholder*="手机"], input[type="tel"]')
            .first()
            .fill(ctx.identity.phone)
            .catch(() => {});
        }
        await fillEmailPasswordForm(page, ctx.identity).catch(() => {
          ctx.onProgress("Complete the form manually if needed.", "warn");
        });
      },
      submit: async (page) => clickSignupSubmit(page),
      verifyEmail: async (page) => {
        const has = await page
          .locator('input[placeholder*="验证码"], input[name="code"]')
          .first()
          .isVisible()
          .catch(() => false);
        if (has && !ctx.identity.phone) {
          await handleEmailCode(page, ctx, { codeLength: 6 });
        }
      },
      harvest: async (session) => {
        const cookies = await collectCookies(session, ["https://chatglm.cn"]);
        if (!cookies.length) return null;
        // TFG glm provider uses refresh token cookie among others
        return {
          cookie: cookiesToString(cookies),
          userAgent: session.userAgent,
          email: ctx.identity.email,
        };
      },
    });
  }
}

export class GlmIntlAdapter extends BasePlatformAdapter {
  readonly id = "glm-intl";
  readonly name = "GLM International";
  readonly signupUrl = "https://chat.z.ai/";
  readonly domains = ["chat.z.ai", "z.ai"];
  readonly preferredMode = "semi" as const;
  readonly needsEmail = true;
  readonly needsPhone = false;
  readonly tips = "z.ai / GLM intl — email signup with possible captcha.";

  async register(ctx: RegisterContext): Promise<RegisterResult> {
    return semiAutoSignupFlow(this, ctx, {
      openForm: async (page) => {
        await clickFirst(page, [
          'button:has-text("Sign in")',
          'button:has-text("Log in")',
          'a:has-text("Sign up")',
          'text=Sign up',
        ]);
        await clickFirst(page, [
          'a:has-text("Sign up")',
          'button:has-text("Sign up")',
          'text=Create',
        ], { timeoutMs: 3000 });
      },
      fillForm: async (page) => fillEmailPasswordForm(page, ctx.identity),
      submit: async (page) => clickSignupSubmit(page),
      verifyEmail: async (page) => {
        const has = await page
          .locator('input[autocomplete="one-time-code"], input[name="code"]')
          .first()
          .isVisible()
          .catch(() => false);
        if (has) await handleEmailCode(page, ctx, { codeLength: 6 });
      },
      harvest: async (session) => {
        const cookies = await collectCookies(session, ["https://chat.z.ai"]);
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

export const glmAdapter = new GlmAdapter();
export const glmIntlAdapter = new GlmIntlAdapter();
