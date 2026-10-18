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

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { clickFirst, collectCookies, fillFirst } from "../core/browser.ts";
import type { PlatformAdapter, RegisterContext, RegisterResult, RegisterMode } from "../core/types.ts";
import { cookiesToString } from "../core/utils.ts";
import {
  BasePlatformAdapter,
  handleEmailCode,
  semiAutoSignupFlow,
} from "./base.ts";

export interface GenericPlatformConfig {
  id: string;
  name: string;
  signupUrl: string;
  domains: string[];
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
  };
  /** Cookie name that indicates logged-in state */
  successCookie?: string;
  /** Host hint for email link extraction */
  emailFromHint?: string;
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
  private cfg: GenericPlatformConfig;

  constructor(cfg: GenericPlatformConfig) {
    super();
    this.cfg = cfg;
    this.id = cfg.id;
    this.name = cfg.name;
    this.signupUrl = cfg.signupUrl;
    this.domains = cfg.domains;
    this.preferredMode = cfg.preferredMode ?? "semi";
    this.needsEmail = cfg.needsEmail ?? true;
    this.needsPhone = cfg.needsPhone ?? false;
    this.tips = cfg.tips;
  }

  async register(ctx: RegisterContext): Promise<RegisterResult> {
    const sel = this.cfg.selectors ?? {};

    return semiAutoSignupFlow(this, ctx, {
      openForm: async (page) => {
        if (sel.openSignup?.length) {
          await clickFirst(page, sel.openSignup, { timeoutMs: 5000 });
        }
      },
      fillForm: async (page) => {
        if (ctx.identity.name && sel.name?.length) {
          await fillFirst(page, sel.name, ctx.identity.name);
        }
        if (ctx.identity.phone && sel.phone?.length) {
          await fillFirst(page, sel.phone, ctx.identity.phone);
        }
        const emailSels = sel.email ?? ['input[type="email"]', 'input[name="email"]'];
        const passSels = sel.password ?? ['input[type="password"]'];
        const eOk = await fillFirst(page, emailSels, ctx.identity.email);
        const pOk = await fillFirst(page, passSels, ctx.identity.password);
        if (!eOk || !pOk) {
          throw new Error("Generic adapter: email/password selectors missed");
        }
      },
      submit: async (page) => {
        const submitSels = sel.submit ?? ['button[type="submit"]'];
        const ok = await clickFirst(page, submitSels);
        if (!ok) throw new Error("Generic adapter: submit button not found");
      },
      verifyEmail: async (page) => {
        if (!this.needsEmail) return;
        const codeSels = sel.code ?? [
          'input[name="code"]',
          'input[autocomplete="one-time-code"]',
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
      isSuccess: async (page) => {
        if (!this.cfg.successCookie) return true;
        return page.evaluate((name) => document.cookie.includes(name), this.cfg.successCookie);
      },
      harvest: async (session) => {
        const urls = this.domains.map((d) => (d.startsWith("http") ? d : `https://${d}`));
        const cookies = await collectCookies(session, urls);
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
