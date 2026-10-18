/**
 * Perplexity.ai adapter.
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

export class PerplexityAdapter extends BasePlatformAdapter {
  readonly id = "perplexity";
  readonly name = "Perplexity";
  readonly signupUrl = "https://www.perplexity.ai/";
  readonly domains = ["perplexity.ai", "www.perplexity.ai"];
  readonly preferredMode = "semi" as const;
  readonly needsEmail = true;
  readonly needsPhone = false;
  readonly tips =
    "支持 Google / Apple / email。Email 流程可 semi；OAuth 请用 manual。凭证关键 next-auth cookie。";

  async register(ctx: RegisterContext): Promise<RegisterResult> {
    if (ctx.mode === "manual") return this.captureSession(ctx);

    return semiAutoSignupFlow(this, ctx, {
      openForm: async (page) => {
        await clickFirst(page, [
          'button:has-text("Sign in")',
          'button:has-text("Log in")',
          'a:has-text("Sign in")',
        ]);
        await sleep(500);
        await clickFirst(page, [
          'button:has-text("Sign up")',
          'a:has-text("Sign up")',
          'text=Continue with Email',
          'button:has-text("Email")',
        ]);
      },
      fillForm: async (page) => {
        await fillEmailPasswordForm(page, ctx.identity).catch(() => {
          ctx.onProgress("Use Google/Apple in the browser if email form is unavailable.", "warn");
        });
      },
      submit: async (page) => clickSignupSubmit(page).catch(() => {}),
      harvest: async (session) => {
        const cookies = await collectCookies(session, ["https://www.perplexity.ai"]);
        if (!cookies.length) return null;
        const hasNextAuth = cookies.some((c) =>
          c.name.toLowerCase().includes("next-auth") || c.name.toLowerCase().includes("session"),
        );
        if (!hasNextAuth) {
          // still return — some builds use different names
        }
        return {
          cookie: cookiesToString(cookies),
          userAgent: session.userAgent,
          email: ctx.identity.email,
        };
      },
    });
  }
}

export const perplexityAdapter = new PerplexityAdapter();
