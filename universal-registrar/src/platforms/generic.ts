/**
 * Generic / custom platform adapter driven by a JSON definition.
 * Use this to onboard a new site without writing TypeScript.
 *
 * Example config/platforms/example.json:
 * {
 *   "id": "my-site",
 *   "name": "My Site",
 *   "signupUrl": "https://example.com/signup",
 *   "domains": ["example.com"],
 *   "preferredMode": "semi",
 *   "needsEmail": true,
 *   "needsPhone": false,
 *   "selectors": {
 *     "email": ["#email", "input[name=email]"],
 *     "password": ["#password"],
 *     "submit": ["button[type=submit]"],
 *     "openSignup": ["a.signup"]
 *   },
 *   "successCookie": "session"
 * }
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "playwright-core";
import { connectCdp, type BrowserSession } from "../core/browser.ts";
import { targetOrigins, verifySession } from "../core/session-verification.ts";
import { clickFirst, collectCookies, fillFirst } from "../core/browser.ts";
import { handleCaptchaIfPresent } from "../core/captcha.ts";
import type { PlatformAdapter, RegisterContext, RegisterResult, RegisterMode } from "../core/types.ts";
import { cookiesToString, nowIso, sleep } from "../core/utils.ts";
import {
  BasePlatformAdapter,
  clickSignupSubmit,
  extractWebStorageTokens,
  fillEmailPasswordForm,
  handleEmailCode,
  semiAutoSignupFlow,
} from "./base.ts";

export interface GenericPlatformConfig {
  id: string;
  name?: string;
  signupUrl: string;
  domains?: string[];
  chatUrl?: string;
  preferredMode?: RegisterMode;
  needsEmail?: boolean;
  needsPhone?: boolean;
  tips?: string;
  selectors?: {
    openSignup?: string[];
    email?: string[];
    password?: string[];
    name?: string[];
    phone?: string[];
    submit?: string[];
    code?: string[];
    sendCode?: string[];
  };
  /** Optional DOM selectors passed to token-free-gateway GenericDomClient */
  chatSelectors?: {
    input?: string[];
    submit?: string[];
    response?: string[];
    newChat?: string[];
  };
  /** Optional model list exposed in token-free-gateway */
  models?: Array<{ id: string; name: string }>;
  /** Cookie name that indicates logged-in state */
  successCookie?: string;
  successSelector?: string;
  authMethod?: "email" | "github";
  /** Host hint for email link extraction */
  emailFromHint?: string;
}

export function deriveDomainsFromUrl(rawUrl: string): {
  normalizedUrl: string;
  origin: string;
  hostname: string;
  rootDomain: string;
  inferredId: string;
  inferredName: string;
} {
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawUrl.trim()) && !/^https?:\/\//i.test(rawUrl.trim())) {
    throw new Error("Only HTTP(S) target URLs are supported");
  }
  const withProto = /^https?:\/\//i.test(rawUrl.trim())
    ? rawUrl.trim()
    : `https://${rawUrl.trim()}`;
  const u = new URL(withProto);
  const hostname = u.hostname.toLowerCase();
  const parts = hostname.split(".").filter(Boolean);
  const rootDomain =
    parts.length >= 2 ? parts.slice(-2).join(".") : hostname;
  const coreLabel =
    parts.length >= 2
      ? (parts[parts.length - 2] === "com" || parts[parts.length - 2] === "co") && parts.length >= 3
        ? parts[parts.length - 3]!
        : parts[parts.length - 2]!
      : parts[0] || "custom";
  const inferredId = coreLabel.replace(/[^a-z0-9-_]/gi, "-").toLowerCase();
  const inferredName =
    inferredId.charAt(0).toUpperCase() + inferredId.slice(1) + ` (${hostname})`;
  return {
    normalizedUrl: u.toString(),
    origin: u.origin,
    hostname,
    rootDomain,
    inferredId,
    inferredName,
  };
}

export class GenericAdapter extends BasePlatformAdapter {
  readonly id: string;
  readonly name: string;
  readonly signupUrl: string;
  readonly domains: string[];
  readonly preferredMode: RegisterMode;
  readonly needsEmail: boolean;
  readonly needsPhone: boolean;
  readonly tips?: string;
  readonly cfg: GenericPlatformConfig;

  constructor(cfg: GenericPlatformConfig) {
    super();
    targetOrigins(cfg);
    const derived = deriveDomainsFromUrl(cfg.signupUrl);
    this.cfg = cfg;
    this.id = cfg.id || derived.inferredId;
    this.name = cfg.name || derived.inferredName;
    this.signupUrl = derived.normalizedUrl;
    this.domains =
      cfg.domains && cfg.domains.length > 0
        ? cfg.domains
        : [derived.hostname, derived.rootDomain].filter(
            (v, i, a) => Boolean(v) && a.indexOf(v) === i,
          );
    this.preferredMode = cfg.preferredMode ?? "semi";
    this.needsEmail = cfg.authMethod === "github" ? false : (cfg.needsEmail ?? true);
    this.needsPhone = cfg.needsPhone ?? false;
    this.tips = cfg.tips;
  }

  async harvestVerified(session: BrowserSession, page: Page): Promise<Record<string, unknown> | null> {
    if (!(await verifySession(page, this.cfg)).verified) return null;
    const cookies = await collectCookies(session, [page.url()]);
    const storage = await extractWebStorageTokens(page);
    if (!cookies.length && Object.keys(storage.localStorage).length === 0) return null;
    const current = new URL(page.url());
    return {
      cookie: cookiesToString(cookies),
      userAgent: session.userAgent,
      capturedAt: nowIso(),
      startUrl: this.cfg.chatUrl || current.origin,
      signupUrl: this.signupUrl,
      cookieDomain: current.hostname,
      domains: [current.hostname],
      providerName: this.name,
      verification: { level: "login-evidence", chatTested: false },
      ...(this.cfg.models ? { models: this.cfg.models } : {}),
      ...(this.cfg.chatSelectors ? { chatSelectors: this.cfg.chatSelectors } : {}),
      ...(storage.bearerToken ? { bearer: storage.bearerToken } : {}),
      ...(Object.keys(storage.localStorage).length ? { localStorage: storage.localStorage } : {}),
    };
  }

  override async captureSession(ctx: RegisterContext): Promise<RegisterResult> {
    return this.guidedLogin(ctx, false);
  }

  private async guidedLogin(ctx: RegisterContext, github: boolean): Promise<RegisterResult> {
    if (!this.cfg.successCookie && !this.cfg.successSelector) {
      return { success: false, status: "unverified", identity: ctx.identity, message: "Configure --success-cookie or --success-selector before login; use inspect to diagnose the page." };
    }
    if (ctx.mode === "auto") {
      return { success: false, status: "failed", identity: ctx.identity, message: "Interactive login requires semi or manual mode. GitHub authorization is always performed by the user." };
    }
    const session = await connectCdp(ctx.cdpUrl);
    try {
      const page = await session.context.newPage();
      page.setDefaultTimeout(Math.min(ctx.timeoutMs, 15_000));
      await page.goto(this.signupUrl, { waitUntil: "domcontentloaded", timeout: ctx.timeoutMs });
      if (github) {
        const { findGithubEntries } = await import("../core/site-inspection.ts");
        const entries = findGithubEntries(page);
        const count = await entries.count();
        if (count !== 1) {
          return { success: false, status: "failed", identity: ctx.identity, message: `Found ${count} GitHub login entries; expected exactly one. Use inspect or complete login manually with capture.` };
        }
        await entries.click();
        ctx.onProgress("Use your existing GitHub account. Review the target app and permissions, complete authorization yourself, then return to the target site. GitHub credentials are never collected.", "warn");
      }
      await ctx.askHuman("Complete login in the browser (including any popup), then press Enter to verify: ");
      // Limit capture to tabs opened by this flow, never unrelated browser tabs.
      const candidates = [page, ...session.context.pages().filter(candidate => candidate !== page)];
      let reason = "No verified target session was found.";
      for (const candidate of candidates) {
        if (candidate !== page && await candidate.opener() !== page) continue;
        if (candidate.isClosed()) continue;
        const evidence = await verifySession(candidate, this.cfg);
        reason = evidence.reason;
        if (!evidence.verified) continue;
        const credentials = await this.harvestVerified(session, candidate);
        if (credentials) return { success: true, status: "success", identity: ctx.identity, credentials: { ...credentials, email: ctx.identity.email }, message: evidence.reason };
      }
      return { success: false, status: "unverified", identity: ctx.identity, message: reason };
    } finally {
      await session.close();
    }
  }

  async register(ctx: RegisterContext): Promise<RegisterResult> {
    if (this.cfg.authMethod === "github") return this.guidedLogin(ctx, true);
    if (!this.cfg.successCookie && !this.cfg.successSelector) {
      return { success: false, status: "unverified", identity: ctx.identity, message: "Configure --success-cookie or --success-selector first; no account actions were attempted." };
    }
    const sel = this.cfg.selectors ?? {};

    return semiAutoSignupFlow(this, ctx, {
      openForm: async (page) => {
        if (sel.openSignup?.length) {
          await clickFirst(page, sel.openSignup, { timeoutMs: 5000 });
        } else {
          const hasEmailInput = await page
            .locator('input[type="email"], input[name="email"], input[placeholder*="mail" i], input[placeholder*="邮箱"]')
            .first()
            .isVisible()
            .catch(() => false);
          if (!hasEmailInput) {
            await clickFirst(
              page,
              [
                'a:has-text("Sign up")',
                'button:has-text("Sign up")',
                'a:has-text("Register")',
                'button:has-text("Register")',
                'a:has-text("注册")',
                'button:has-text("注册")',
                'a:has-text("立即注册")',
                'button:has-text("创建账号")',
              ],
              { timeoutMs: 3000 },
            ).catch(() => {});
          }
        }
      },
      fillForm: async (page) => {
        if (!sel.email && !sel.password) {
          await fillEmailPasswordForm(page, ctx.identity);
          return;
        }
        if (ctx.identity.name && sel.name?.length) {
          await fillFirst(page, sel.name, ctx.identity.name);
        }
        if (ctx.identity.phone && sel.phone?.length) {
          await fillFirst(page, sel.phone, ctx.identity.phone);
        }
        const emailSels = sel.email ?? [
          'input[type="email"]',
          'input[name="email"]',
          'input[autocomplete="email"]',
          'input[placeholder*="mail" i]',
          'input[placeholder*="邮箱"]',
        ];
        const passSels = sel.password ?? [
          'input[type="password"]',
          'input[name="password"]',
          'input[placeholder*="密码"]',
          'input[placeholder*="password" i]',
        ];
        const eOk = await fillFirst(page, emailSels, ctx.identity.email);
        if (!eOk) {
          throw new Error("Generic adapter: email selector missed");
        }
        let pOk = await fillFirst(page, passSels, ctx.identity.password);
        if (!pOk) {
          const submitSels = sel.submit ?? ['button[type="submit"]'];
          await clickFirst(page, submitSels).catch(() => clickSignupSubmit(page).catch(() => {}));
          await sleep(1500);
          await handleCaptchaIfPresent(page, ctx.onProgress, { timeoutMs: 30_000 }).catch(() => {});
          pOk = await fillFirst(page, passSels, ctx.identity.password);
        }
        if (!pOk) {
          throw new Error("Generic adapter: email/password selectors missed");
        }
      },
      submit: async (page) => {
        if (sel.submit?.length) {
          const ok = await clickFirst(page, sel.submit);
          if (!ok) throw new Error("Generic adapter: submit button not found");
        } else {
          await clickSignupSubmit(page);
        }
      },
      verifyEmail: async (page) => {
        if (!this.needsEmail) return;
        const sendCodeSels = sel.sendCode ?? [
          'button:has-text("发送验证码")',
          'button:has-text("获取验证码")',
          'button:has-text("Send code")',
          'button:has-text("Get code")',
        ];
        await clickFirst(page, sendCodeSels, { timeoutMs: 1500 }).catch(() => {});
        const codeSels = sel.code ?? [
          'input[name="code"]',
          'input[name="otp"]',
          'input[name="verifyCode"]',
          'input[autocomplete="one-time-code"]',
          'input[placeholder*="验证码"]',
          'input[placeholder*="code" i]',
          'input[maxlength="1"]',
        ];
        const visible = await page
          .locator(codeSels.join(", "))
          .first()
          .isVisible()
          .catch(() => false);
        if (visible) {
          await handleEmailCode(page, ctx, {
            fromHint: this.cfg.emailFromHint,
            codeLength: 6,
          });
        }
      },
      isSuccess: async (page) => (await verifySession(page, this.cfg)).verified,
      harvest: async (session, page) => {
        const credentials = await this.harvestVerified(session, page);
        return credentials ? { ...credentials, email: ctx.identity.email } : null;
      },
    });
  }
}

/**
 * Create a zero-config GenericAdapter on the fly from a URL, domain, or channel ID.
 */
export function createAdHocAdapter(
  idOrUrl: string,
  overrides: Partial<GenericPlatformConfig> = {},
): GenericAdapter {
  overrides = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
  const looksLikeUrlOrDomain =
    /^https?:\/\//i.test(idOrUrl) || idOrUrl.includes(".") || idOrUrl.includes("/");
  const rawUrl = overrides.signupUrl || (looksLikeUrlOrDomain ? idOrUrl : `https://${idOrUrl}`);
  const derived = deriveDomainsFromUrl(rawUrl);
  const id = overrides.id || (looksLikeUrlOrDomain ? derived.inferredId : idOrUrl);
  const cfg: GenericPlatformConfig = {
    id,
    name: overrides.name || derived.inferredName,
    signupUrl: derived.normalizedUrl,
    chatUrl: overrides.chatUrl || derived.origin,
    domains: overrides.domains ?? [derived.hostname, derived.rootDomain],
    preferredMode: overrides.preferredMode ?? "semi",
    needsEmail: overrides.needsEmail ?? true,
    needsPhone: overrides.needsPhone ?? false,
    ...overrides,
  };
  return new GenericAdapter(cfg);
}

/** Save a GenericPlatformConfig JSON file to disk for future reuse. */
export function saveGenericPlatformConfig(
  cfg: GenericPlatformConfig,
  dir: string,
): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${cfg.id}.json`);
  const dirOfFile = dirname(filePath);
  if (!existsSync(dirOfFile)) mkdirSync(dirOfFile, { recursive: true });
  writeFileSync(filePath, JSON.stringify(cfg, null, 2), "utf-8");
  return filePath;
}

/** Load all *.json generic platform defs from a directory. */
export function loadGenericAdaptersFromDir(dir: string): PlatformAdapter[] {
  if (!existsSync(dir)) return [];
  const out: PlatformAdapter[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const cfg = JSON.parse(raw) as GenericPlatformConfig;
      if (!cfg.id || !cfg.signupUrl) {
        console.warn(`[generic] skip ${file}: missing id/signupUrl`);
        continue;
      }
      out.push(new GenericAdapter(cfg));
    } catch (e) {
      console.warn(`[generic] failed to load ${file}:`, e);
    }
  }
  return out;
}
