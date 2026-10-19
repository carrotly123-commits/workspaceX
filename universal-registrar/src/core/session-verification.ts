import type { Page } from "playwright-core";

export interface SessionCriteria {
  signupUrl: string;
  chatUrl?: string;
  successCookie?: string;
  successSelector?: string;
}

export interface SessionVerification {
  verified: boolean;
  reason: string;
}

export function targetOrigins(criteria: SessionCriteria): string[] {
  return [...new Set([criteria.signupUrl, criteria.chatUrl].filter(Boolean).map(raw => {
    const url = new URL(raw!);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Target URLs must be HTTP(S) URLs without embedded credentials");
    }
    if (url.hostname === "github.com" || url.hostname.endsWith(".github.com")) {
      throw new Error("GitHub is an identity provider, not a target for credential capture");
    }
    return url.origin;
  }))];
}

export async function verifySession(page: Page, criteria: SessionCriteria): Promise<SessionVerification> {
  const origins = targetOrigins(criteria);
  if (!criteria.successCookie && !criteria.successSelector) {
    return { verified: false, reason: "No login evidence configured. Set successCookie or successSelector after inspecting the site." };
  }
  let currentOrigin: string;
  try { currentOrigin = new URL(page.url()).origin; } catch { currentOrigin = ""; }
  if (!origins.includes(currentOrigin)) {
    return { verified: false, reason: "Login has not returned to an explicitly configured target origin." };
  }
  if (criteria.successCookie) {
    const cookies = await page.context().cookies([page.url()]);
    const now = Date.now() / 1000;
    if (!cookies.some(cookie => cookie.name === criteria.successCookie && cookie.value.length > 0 && (cookie.expires === -1 || cookie.expires > now))) {
      return { verified: false, reason: "The exact configured login cookie is missing or expired." };
    }
  }
  if (criteria.successSelector) {
    try {
      const candidates = page.locator(criteria.successSelector);
      let visible = false;
      for (let i = 0; i < await candidates.count(); i++) {
        if (await candidates.nth(i).isVisible()) { visible = true; break; }
      }
      if (!visible) return { verified: false, reason: "The configured logged-in element is not visible." };
    } catch {
      return { verified: false, reason: "The configured successSelector is invalid or the page is unavailable." };
    }
  }
  return { verified: true, reason: "Configured login evidence matched on the target origin; model connectivity has not been tested." };
}
