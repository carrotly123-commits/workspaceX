/**
 * Shared helpers for platform adapters.
 */

import type { Page } from "playwright-core";
import {
  applyMinimalStealth,
  clickFirst,
  collectCookies,
  connectCdp,
  fillFirst,
  type BrowserSession,
} from "../core/browser.ts";
import { detectCaptchaState, handleCaptchaIfPresent } from "../core/captcha.ts";
import type {
  PlatformAdapter,
  RegisterContext,
  RegisterResult,
} from "../core/types.ts";
import { cookiesToString, extractVerificationCode, nowIso, sleep } from "../core/utils.ts";
import { askForCode } from "../core/email/manual.ts";

export abstract class BasePlatformAdapter implements PlatformAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly signupUrl: string;
  abstract readonly domains: string[];
  abstract readonly preferredMode: PlatformAdapter["preferredMode"];
  abstract readonly needsEmail: boolean;
  abstract readonly needsPhone: boolean;
  readonly tips?: string;

  abstract register(ctx: RegisterContext): Promise<RegisterResult>;

  /** Default session capture: open domain, wait for human login, dump cookies. */
  async captureSession(ctx: RegisterContext): Promise<RegisterResult> {
    const session = await connectCdp(ctx.cdpUrl);
    try {
      ctx.onProgress(`Opening ${this.signupUrl} for session capture...`);
      const page = await session.context.newPage();
      await page.goto(this.signupUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      ctx.onProgress("Log in manually in the browser, then press Enter here...", "warn");
      await ctx.askHuman("Press Enter after you are logged in: ");

      const creds = await this.harvestCredentials(session, page, ctx);
      if (!creds) {
        return {
          success: false,
          status: "failed",
          identity: ctx.identity,
          message: "No credentials captured",
        };
      }
      return {
        success: true,
        status: "success",
        identity: ctx.identity,
        credentials: creds,
        message: "Session captured",
      };
    } finally {
      await session.close();
    }
  }

  /** Override in subclasses to map cookies → TFG credential shape. */
  protected async harvestCredentials(
    session: BrowserSession,
    _page: Page,
    ctx: RegisterContext,
  ): Promise<Record<string, unknown> | null> {
    const urls = this.domains.map((d) => (d.startsWith("http") ? d : `https://${d}`));
    const cookies = await collectCookies(session, urls);
    if (cookies.length === 0) return null;
    return {
      cookie: cookiesToString(cookies),
      userAgent: session.userAgent,
      capturedAt: nowIso(),
      email: ctx.identity.email,
    };
  }
}

/** Semi-auto flow skeleton used by most web AI platforms. */
export async function semiAutoSignupFlow(
  adapter: PlatformAdapter,
  ctx: RegisterContext,
  steps: {
    /** Navigate & click through to the email signup form */
    openForm: (page: Page, session: BrowserSession) => Promise<void>;
    /** Fill email/password/name fields */
    fillForm: (page: Page, session: BrowserSession) => Promise<void>;
    /** Submit the form */
    submit: (page: Page, session: BrowserSession) => Promise<void>;
    /** Optional: handle email verification */
    verifyEmail?: (page: Page, session: BrowserSession) => Promise<void>;
    /** Detect success (logged-in state) */
    isSuccess?: (page: Page) => Promise<boolean>;
    /** Map session → credentials */
    harvest: (session: BrowserSession, page: Page) => Promise<Record<string, unknown> | null>;
  },
): Promise<RegisterResult> {
  const session = await connectCdp(ctx.cdpUrl);
  try {
    const page = await session.context.newPage();
    await applyMinimalStealth(page);
    ctx.onProgress(`Navigating to ${adapter.signupUrl}`);
    await page.goto(adapter.signupUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    if (ctx.mode === "manual") {
      ctx.onProgress("Manual mode: complete registration in the browser, then press Enter.", "warn");
      await ctx.askHuman("Press Enter when registration + login is done: ");
    } else {
      try {
        // 1. Handle any entry interstitial / Cloudflare shield before opening form
        await handleCaptchaIfPresent(page, ctx.onProgress, { timeoutMs: 90_000 });

        await steps.openForm(page, session);
        await steps.fillForm(page, session);

        // 2. Handle pre-submit Turnstile / checkbox if embedded in the signup form
        await handleCaptchaIfPresent(page, ctx.onProgress, { timeoutMs: 90_000 });

        await steps.submit(page, session);
        await sleep(1200);

        // 3. Handle post-submit popup captcha (Turnstile, GeeTest slider, hCaptcha, etc.)
        await handleCaptchaIfPresent(page, ctx.onProgress, { timeoutMs: 120_000 });

        if (steps.verifyEmail) {
          await steps.verifyEmail(page, session);
        }

        // 4. Smart completion check: if already logged in (isSuccess), skip asking user to press Enter!
        const alreadyLoggedIn = steps.isSuccess ? await steps.isSuccess(page).catch(() => false) : false;
        if (!alreadyLoggedIn && (ctx.mode === "semi" || adapter.needsPhone)) {
          if (steps.isSuccess) {
            ctx.onProgress(
              "Waiting for login state in browser (finish any remaining SMS/captcha in browser — auto-detecting)...",
              "info",
            );
            const waitStart = Date.now();
            let detected = false;
            while (Date.now() - waitStart < 90_000) {
              await handleCaptchaIfPresent(page, ctx.onProgress, { timeoutMs: 30_000 });
              if (await steps.isSuccess(page).catch(() => false)) {
                detected = true;
                ctx.onProgress("Login state detected automatically!", "success");
                break;
              }
              await sleep(1500);
            }
            if (!detected) {
              await ctx.askHuman("Press Enter when the account is ready (logged in): ");
            }
          } else {
            const cap = await detectCaptchaState(page);
            if (cap.present || adapter.needsPhone) {
              ctx.onProgress(
                "If the site still needs captcha / SMS / OAuth, finish it in the browser.",
                "warn",
              );
              await ctx.askHuman("Press Enter when the account is ready (logged in): ");
            }
          }
        }
      } catch (err) {
        ctx.onProgress(
          `Auto steps failed (${err instanceof Error ? err.message : err}). Falling back to manual...`,
          "warn",
        );
        await ctx.askHuman("Finish registration manually, then press Enter: ");
      }
    }

    if (steps.isSuccess) {
      const ok = await steps.isSuccess(page).catch(() => false);
      if (!ok) {
        ctx.onProgress("Success detector returned false — still trying to harvest session...", "warn");
      }
    }

    const credentials = await steps.harvest(session, page);
    if (!credentials) {
      return {
        success: false,
        status: "failed",
        identity: ctx.identity,
        message: "Registration may have succeeded but credentials were not captured",
      };
    }

    return {
      success: true,
      status: "success",
      identity: ctx.identity,
      credentials,
      message: "Registered / session captured",
    };
  } catch (err) {
    return {
      success: false,
      status: "failed",
      identity: ctx.identity,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await session.close();
  }
}

/** Common email+password field filler using heuristic selectors. */
export async function fillEmailPasswordForm(
  page: Page,
  identity: { email: string; password: string; name?: string },
): Promise<void> {
  if (identity.name) {
    await fillFirst(page, [
      'input[name="name"]',
      'input[name="username"]',
      'input[name="nickname"]',
      'input[autocomplete="name"]',
      'input[placeholder*="名"]',
      'input[placeholder*="Name" i]',
    ], identity.name);
  }

  const emailOk = await fillFirst(page, [
    'input[type="email"]',
    'input[name="email"]',
    'input[autocomplete="email"]',
    'input[placeholder*="mail" i]',
    'input[placeholder*="邮箱"]',
    'input[placeholder*="邮箱"]',
  ], identity.email);
  if (!emailOk) throw new Error("Could not find email input");

  const passOk = await fillFirst(page, [
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="new-password"]',
    'input[placeholder*="密码"]',
    'input[placeholder*="password" i]',
  ], identity.password);
  if (!passOk) throw new Error("Could not find password input");

  // Confirm password if present
  const passFields = page.locator('input[type="password"]');
  const count = await passFields.count();
  if (count >= 2) {
    await passFields.nth(1).fill(identity.password).catch(() => {});
  }
}

export async function clickSignupSubmit(page: Page): Promise<void> {
  const clicked = await clickFirst(page, [
    'button[type="submit"]',
    'button:has-text("Sign up")',
    'button:has-text("Signup")',
    'button:has-text("Register")',
    'button:has-text("Create")',
    'button:has-text("注册")',
    'button:has-text("立即注册")',
    'button:has-text("创建账号")',
    'button:has-text("创建账户")',
    'button:has-text("继续")',
    'button:has-text("Continue")',
    'button:has-text("Next")',
  ]);
  if (!clicked) {
    // try Enter on password field
    await page.locator('input[type="password"]').last().press("Enter").catch(() => {
      throw new Error("Could not find signup submit button");
    });
  }
}

/** Pull email code via provider or human, fill into OTP inputs. */
export async function handleEmailCode(
  page: Page,
  ctx: RegisterContext,
  opts: { fromHint?: string; subjectHint?: string; codeLength?: number } = {},
): Promise<void> {
  ctx.onProgress("Waiting for email verification code...", "info");
  let code: string | null = null;

  if (ctx.email && ctx.identity.email) {
    try {
      const msg = await ctx.email.waitForMessage(
        ctx.identity.email,
        (m) => {
          if (opts.fromHint && !m.from.toLowerCase().includes(opts.fromHint.toLowerCase())) {
            // still allow if code present
          }
          if (opts.subjectHint && !m.subject.toLowerCase().includes(opts.subjectHint.toLowerCase())) {
            // soft filter
          }
          return !!extractVerificationCode(m.bodyText, opts.codeLength);
        },
        ctx.timeoutMs,
      );
      code = extractVerificationCode(msg.bodyText, opts.codeLength);
    } catch (e) {
      ctx.onProgress(`Email provider wait failed: ${e instanceof Error ? e.message : e}`, "warn");
    }
  }

  if (!code) {
    code = await askForCode(ctx.askHuman, "email verification code", opts.codeLength);
  }

  // Try single OTP input or multi-box
  const filled = await fillFirst(page, [
    'input[name="code"]',
    'input[name="otp"]',
    'input[name="verifyCode"]',
    'input[name="verificationCode"]',
    'input[autocomplete="one-time-code"]',
    'input[placeholder*="验证码"]',
    'input[placeholder*="code" i]',
    'input[type="tel"]',
    'input[inputmode="numeric"]',
  ], code);

  if (!filled) {
    // multi digit boxes
    const boxes = page.locator('input[maxlength="1"]');
    const n = await boxes.count();
    if (n >= 4 && n <= 8) {
      for (let i = 0; i < Math.min(n, code.length); i++) {
        await boxes.nth(i).fill(code[i]!);
      }
    } else {
      throw new Error("Could not find verification code input");
    }
  }

  await clickFirst(page, [
    'button[type="submit"]',
    'button:has-text("Verify")',
    'button:has-text("Confirm")',
    'button:has-text("提交")',
    'button:has-text("验证")',
    'button:has-text("确认")',
    'button:has-text("Continue")',
  ]);
}
