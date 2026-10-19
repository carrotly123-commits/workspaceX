/**
 * Claude (claude.ai) adapter — Google/email magic link, heavily bot-protected.
 * Manual capture of sessionKey is the reliable path.
 */

import { collectCookies } from "../core/browser.ts";
import type { RegisterContext, RegisterResult } from "../core/types.ts";
import { cookiesToString } from "../core/utils.ts";
import type { BrowserSession } from "../core/browser.ts";
import type { Page } from "playwright-core";
import { BasePlatformAdapter } from "./base.ts";

export class ClaudeAdapter extends BasePlatformAdapter {
  readonly id = "claude";
  readonly name = "Claude (Anthropic)";
  readonly signupUrl = "https://claude.ai/";
  readonly domains = ["claude.ai", "www.claude.ai"];
  readonly preferredMode = "manual" as const;
  readonly needsEmail = true;
  readonly needsPhone = false;
  readonly tips =
    "Claude 反自动化很强。请在浏览器中手动完成注册/登录；成功后工具会抓取 sessionKey (sk-ant-sid*).";

  async register(ctx: RegisterContext): Promise<RegisterResult> {
    return this.captureSession(ctx);
  }

  protected async harvestCredentials(
    session: BrowserSession,
    _page: Page,
    ctx: RegisterContext,
  ) {
    const cookies = await collectCookies(session, [
      "https://claude.ai",
      "https://www.claude.ai",
    ]);
    if (!cookies.length) return null;

    const sessionKeyCookie = cookies.find(
      (c) =>
        c.name === "sessionKey" ||
        c.value.startsWith("sk-ant-sid01-") ||
        c.value.startsWith("sk-ant-sid02-"),
    );
    const sessionKey = sessionKeyCookie?.value;
    if (!sessionKey || !sessionKey.startsWith("sk-ant-sid")) {
      ctx.onProgress(
        "sessionKey not found. Make sure you finished login on claude.ai.",
        "warn",
      );
      // Still return cookies so user can retry
      return {
        sessionKey: sessionKey || "",
        cookie: cookiesToString(cookies),
        userAgent: session.userAgent,
        email: ctx.identity.email,
      };
    }

    return {
      sessionKey,
      cookie: cookiesToString(cookies),
      userAgent: session.userAgent,
      email: ctx.identity.email,
    };
  }
}

export const claudeAdapter = new ClaudeAdapter();
