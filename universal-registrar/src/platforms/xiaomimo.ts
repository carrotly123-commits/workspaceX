/**
 * 小米 MiMo adapter.
 */

import { clickFirst, collectCookies } from "../core/browser.ts";
import type { RegisterContext, RegisterResult } from "../core/types.ts";
import { cookiesToString } from "../core/utils.ts";
import {
  BasePlatformAdapter,
  clickSignupSubmit,
  fillEmailPasswordForm,
  semiAutoSignupFlow,
} from "./base.ts";

export class XiaomiMimoAdapter extends BasePlatformAdapter {
  readonly id = "xiaomimo";
  readonly name = "小米 MiMo";
  readonly signupUrl = "https://mimo.xiaomi.com/";
  readonly domains = ["mimo.xiaomi.com", "xiaomi.com"];
  readonly preferredMode = "semi" as const;
  readonly needsEmail = false;
  readonly needsPhone = true;
  readonly tips = "小米账号体系，通常需要手机号。建议 semi/manual 完成登录后抓 bearer。";

  async register(ctx: RegisterContext): Promise<RegisterResult> {
    if (ctx.mode === "manual") return this.captureSession(ctx);

    return semiAutoSignupFlow(this, ctx, {
      openForm: async (page) => {
        await clickFirst(page, [
          'button:has-text("登录")',
          'text=登录',
          'a:has-text("登录")',
        ]);
      },
      fillForm: async (page) => {
        if (ctx.identity.phone) {
          await page
            .locator('input[type="tel"], input[placeholder*="手机"]')
            .first()
            .fill(ctx.identity.phone)
            .catch(() => {});
        }
        await fillEmailPasswordForm(page, ctx.identity).catch(() => {});
      },
      submit: async (page) => clickSignupSubmit(page).catch(() => {}),
      harvest: async (session, page) => {
        const cookies = await collectCookies(session, [
          "https://mimo.xiaomi.com",
          "https://xiaomi.com",
        ]);
        const cookie = cookiesToString(cookies);

        let bearer = "";
        try {
          bearer = await page.evaluate(() => {
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (!k) continue;
              const v = localStorage.getItem(k) ?? "";
              if (/token|bearer|auth/i.test(k) && v.length > 20) {
                try {
                  const p = JSON.parse(v);
                  if (p.token) return p.token;
                } catch {
                  return v.replace(/^Bearer\s+/i, "");
                }
              }
            }
            return "";
          });
        } catch {
          /* ignore */
        }

        if (!cookie && !bearer) return null;
        return {
          cookie: cookie || undefined,
          bearer: bearer || undefined,
          token: bearer || undefined,
          userAgent: session.userAgent,
          email: ctx.identity.email,
        };
      },
    });
  }
}

export const xiaomimoAdapter = new XiaomiMimoAdapter();
