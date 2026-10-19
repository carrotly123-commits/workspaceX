/**
 * DeepSeek (chat.deepseek.com) registration adapter.
 * Credential shape matches token-free-gateway deepseek provider.
 */

import type { Page } from "playwright-core";
import {
  clickFirst,
  collectCookies,
  type BrowserSession,
} from "../core/browser.ts";
import type { RegisterContext, RegisterResult } from "../core/types.ts";
import { cookiesToString, sleep } from "../core/utils.ts";
import {
  BasePlatformAdapter,
  clickSignupSubmit,
  fillEmailPasswordForm,
  handleEmailCode,
  semiAutoSignupFlow,
} from "./base.ts";

async function tryCaptureBearer(page: Page): Promise<string> {
  try {
    const fromStorage = await page.evaluate(() => {
      const out: string[] = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key) continue;
          const val = localStorage.getItem(key) ?? "";
          if (/token|auth|bearer/i.test(key) && val.length > 20) out.push(val);
          try {
            const parsed = JSON.parse(val) as { token?: string };
            if (parsed?.token && parsed.token.length > 20) out.push(parsed.token);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
      return out[0] ?? "";
    });
    if (fromStorage) {
      // raw token or JSON blob
      try {
        const p = JSON.parse(fromStorage) as { token?: string };
        if (p.token) return p.token;
      } catch {
        return fromStorage.replace(/^Bearer\s+/i, "");
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

export class DeepSeekAdapter extends BasePlatformAdapter {
  readonly id = "deepseek";
  readonly name = "DeepSeek";
  readonly signupUrl = "https://chat.deepseek.com/sign_up";
  readonly domains = ["chat.deepseek.com", "deepseek.com"];
  readonly preferredMode = "semi" as const;
  readonly needsEmail = true;
  readonly needsPhone = false;
  readonly tips =
    "DeepSeek may show captcha. Prefer a real mailbox. After signup, stay on the chat page so the bearer token can be captured.";

  async register(ctx: RegisterContext): Promise<RegisterResult> {
    return semiAutoSignupFlow(this, ctx, {
      openForm: async (page) => {
        // Already on sign_up; some locales redirect to login with a toggle
        const switched = await clickFirst(page, [
          'a:has-text("Sign up")',
          'a:has-text("注册")',
          'button:has-text("Sign up")',
          'button:has-text("注册")',
          'text=Sign up',
          'text=注册',
        ], { timeoutMs: 3000 });
        if (!switched) {
          // try alternate URL
          if (!page.url().includes("sign")) {
            await page.goto(this.signupUrl, { waitUntil: "domcontentloaded" });
          }
        }
        await sleep(800);
      },

      fillForm: async (page) => {
        await fillEmailPasswordForm(page, ctx.identity);
      },

      submit: async (page) => {
        await clickSignupSubmit(page);
        await sleep(1500);
      },

      verifyEmail: async (page) => {
        // If an OTP field appears, handle it
        const hasCode = await page
          .locator(
            'input[name="code"], input[placeholder*="验证码"], input[placeholder*="code" i], input[autocomplete="one-time-code"]',
          )
          .first()
          .isVisible()
          .catch(() => false);
        if (hasCode) {
          await handleEmailCode(page, ctx, { fromHint: "deepseek", codeLength: 6 });
        }
      },

      isSuccess: async (page) => {
        const url = page.url();
        if (url.includes("chat.deepseek.com") && !url.includes("sign")) return true;
        const cookies = await page.context().cookies(["https://chat.deepseek.com"]);
        return cookies.some(
          (c) => c.name.includes("session") || c.name === "ds_session_id" || c.name === "HWSID",
        );
      },

      harvest: async (session, page) => harvestDeepSeek(session, page, ctx),
    });
  }

  protected async harvestCredentials(session: BrowserSession, page: Page, ctx: RegisterContext) {
    return harvestDeepSeek(session, page, ctx);
  }
}

async function harvestDeepSeek(
  session: BrowserSession,
  page: Page,
  ctx: RegisterContext,
): Promise<Record<string, unknown> | null> {
  // Ensure we are on chat page
  if (!page.url().includes("chat.deepseek.com")) {
    await page.goto("https://chat.deepseek.com", { waitUntil: "domcontentloaded" }).catch(() => {});
    await sleep(2000);
  }

  const cookies = await collectCookies(session, [
    "https://chat.deepseek.com",
    "https://deepseek.com",
  ]);
  const cookie = cookiesToString(cookies);
  if (!cookie || cookie.length < 10) return null;

  let bearer = await tryCaptureBearer(page);
  if (!bearer) {
    ctx.onProgress("Bearer not in storage yet; trying users/current API...", "warn");
    try {
      const token = await page.evaluate(async () => {
        const res = await fetch("/api/v0/users/current", { credentials: "include" });
        if (!res.ok) return "";
        const data = await res.json();
        return (
          data?.data?.biz_data?.token ||
          data?.data?.token ||
          data?.token ||
          ""
        );
      });
      if (token) bearer = token;
    } catch {
      /* ignore */
    }
  }

  return {
    cookie,
    bearer: bearer || "",
    userAgent: session.userAgent,
    email: ctx.identity.email,
  };
}

export const deepseekAdapter = new DeepSeekAdapter();
