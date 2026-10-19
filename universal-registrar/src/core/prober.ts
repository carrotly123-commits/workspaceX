/**
 * Phase 2: Registration Route Prober.
 *
 * Probes an external website to discover all available registration pathways:
 *   - Protocol-level APIs (OneAPI / NewAPI / VoAPI `/api/user/register`, Supabase `/auth/v1/signup`, REST `/api/auth/register`)
 *   - Browser form pathways (direct email+password, email+OTP code, email+magic link, phone+SMS)
 *   - OAuth-only or closed registration states
 *   - Anti-bot / CAPTCHA barriers (Turnstile, hCaptcha, reCAPTCHA, GeeTest, slider, image captcha)
 *   - Concrete DOM selectors and credential/API-key provisioning capabilities
 */

import { deriveDomainsFromUrl } from "../platforms/generic.ts";
import { detectFrameworkFromHtml, inspectExternalSite } from "./discovery.ts";
import type {
  CaptchaBarrierType,
  CredentialHint,
  DetectedFormSelectors,
  DiscoveredSite,
  OneApiStatusMetadata,
  ProbeReport,
  ProgressFn,
  RegistrationRouteCandidate,
  SiteFrameworkType,
} from "./types.ts";
import { nowIso } from "./utils.ts";

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/json,*/*;q=0.8",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detect CAPTCHA / anti-bot barrier from HTML or script tags.
 */
export function detectCaptchaFromHtml(html: string): CaptchaBarrierType {
  const lower = html.toLowerCase();
  if (
    lower.includes("challenges.cloudflare.com/turnstile") ||
    lower.includes("cf-turnstile") ||
    lower.includes("turnstile_check\":true")
  ) {
    return "turnstile";
  }
  if (lower.includes("hcaptcha.com") || lower.includes("h-captcha")) {
    return "hcaptcha";
  }
  if (lower.includes("google.com/recaptcha") || lower.includes("g-recaptcha") || lower.includes("grecaptcha")) {
    return "recaptcha";
  }
  if (lower.includes("geetest") || lower.includes("gt.js") || lower.includes(" gt4.js")) {
    return "geetest";
  }
  if (lower.includes("nc_iconfont") || lower.includes("aliyun-captcha") || lower.includes("滑动验证")) {
    return "slider";
  }
  if (lower.includes("/api/captcha") || lower.includes("captcha-img") || lower.includes("图形验证码")) {
    return "image_captcha";
  }
  return "none";
}

/**
 * Extract concrete CSS selectors and form requirements from HTML markup.
 */
export function analyzeRegistrationHtml(html: string): {
  selectors: DetectedFormSelectors;
  hasEmailField: boolean;
  hasUsernameField: boolean;
  hasPasswordField: boolean;
  hasConfirmPasswordField: boolean;
  hasCodeField: boolean;
  hasSendCodeButton: boolean;
  hasPhoneField: boolean;
  hasInviteField: boolean;
  oauthProviders: string[];
  registrationClosed: boolean;
} {
  const selectors: DetectedFormSelectors = {};
  const emailSels: string[] = [];
  const usernameSels: string[] = [];
  const passwordSels: string[] = [];
  const confirmPasswordSels: string[] = [];
  const codeSels: string[] = [];
  const sendCodeSels: string[] = [];
  const phoneSels: string[] = [];
  const inviteSels: string[] = [];
  const submitSels: string[] = [];

  // Parse <input ...> tags
  const inputRe = /<input\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  let passwordInputCount = 0;

  while ((m = inputRe.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    const type = (attrs.match(/\btype=["']([^"']+)["']/i)?.[1] ?? "text").toLowerCase();
    const id = attrs.match(/\bid=["']([^"']+)["']/i)?.[1];
    const name = attrs.match(/\bname=["']([^"']+)["']/i)?.[1];
    const placeholder = attrs.match(/\bplaceholder=["']([^"']+)["']/i)?.[1] ?? "";
    const autocomplete = attrs.match(/\bautocomplete=["']([^"']+)["']/i)?.[1] ?? "";
    const combined = `${type} ${id ?? ""} ${name ?? ""} ${placeholder} ${autocomplete}`.toLowerCase();

    if (type === "hidden" || type === "checkbox" || type === "radio") continue;

    const bestSelector = id
      ? `#${id}`
      : name
        ? `input[name="${name}"]`
        : placeholder
          ? `input[placeholder*="${placeholder.slice(0, 12)}"]`
          : `input[type="${type}"]`;

    if (type === "password" || /password|密码|pwd/i.test(combined)) {
      passwordInputCount++;
      if (passwordInputCount === 1 && !/confirm|repeat|确认|再次/i.test(combined)) {
        passwordSels.push(bestSelector);
      } else {
        confirmPasswordSels.push(bestSelector);
      }
      continue;
    }

    // Check OTP / verification code BEFORE email so "邮箱验证码" or "Email verification code" is classified as code
    if (
      type !== "email" &&
      /code|otp|verify|verification|captcha|验证码/i.test(combined)
    ) {
      codeSels.push(bestSelector);
      continue;
    }

    if (type === "email" || /e-?mail|邮箱/i.test(combined)) {
      emailSels.push(bestSelector);
      continue;
    }

    if (type === "tel" || /phone|mobile|手机|手机号/i.test(combined)) {
      phoneSels.push(bestSelector);
      continue;
    }

    if (/aff|invite|referral|邀请码/i.test(combined)) {
      inviteSels.push(bestSelector);
      continue;
    }

    if (/user[-_]?name|account|login|用户名|账号/i.test(combined)) {
      usernameSels.push(bestSelector);
      continue;
    }
  }

  // Parse <button ...> tags
  const buttonRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  while ((m = buttonRe.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    const text = (m[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const type = (attrs.match(/\btype=["']([^"']+)["']/i)?.[1] ?? "").toLowerCase();
    const id = attrs.match(/\bid=["']([^"']+)["']/i)?.[1];

    if (/发送验证码|获取验证码|send\s*code|get\s*code|verify\s*email/i.test(text)) {
      sendCodeSels.push(id ? `#${id}` : `button:has-text("${text.slice(0, 20)}")`);
    } else if (
      type === "submit" ||
      /^(sign\s*up|register|create\s*account|continue|注册|立即注册|创建账号|提交)$/i.test(text)
    ) {
      submitSels.push(id ? `#${id}` : text ? `button:has-text("${text}")` : 'button[type="submit"]');
    }
  }

  if (emailSels.length) selectors.email = [...new Set(emailSels)];
  if (usernameSels.length) selectors.username = [...new Set(usernameSels)];
  if (passwordSels.length) selectors.password = [...new Set(passwordSels)];
  if (confirmPasswordSels.length) selectors.confirmPassword = [...new Set(confirmPasswordSels)];
  if (codeSels.length) selectors.code = [...new Set(codeSels)];
  if (sendCodeSels.length) selectors.sendCode = [...new Set(sendCodeSels)];
  if (phoneSels.length) selectors.phone = [...new Set(phoneSels)];
  if (inviteSels.length) selectors.inviteCode = [...new Set(inviteSels)];
  if (submitSels.length) selectors.submit = [...new Set(submitSels)];

  // Detect OAuth providers mentioned on page
  const oauthProviders: string[] = [];
  const oauthPatterns: Array<[string, RegExp]> = [
    ["google", /continue with google|sign in with google|google\s*登录|accounts\.google\.com/i],
    ["github", /continue with github|sign in with github|github\s*登录|github\.com\/login\/oauth/i],
    ["linuxdo", /linux\.?do|connect\.linux\.do/i],
    ["microsoft", /continue with microsoft|login\.microsoftonline\.com/i],
    ["discord", /continue with discord|discord\.com\/api\/oauth2/i],
    ["wechat", /微信登录|扫码登录|wechat/i],
  ];
  for (const [provider, re] of oauthPatterns) {
    if (re.test(html)) oauthProviders.push(provider);
  }

  const closedRe =
    /已关闭新用户注册|暂停注册|关闭注册|registration\s+is\s+(currently\s+)?closed|sign\s*ups?\s+are\s+disabled|invite[- ]only/i;
  const registrationClosed =
    closedRe.test(html) &&
    emailSels.length === 0 &&
    usernameSels.length === 0 &&
    passwordSels.length === 0;

  return {
    selectors,
    hasEmailField: emailSels.length > 0,
    hasUsernameField: usernameSels.length > 0,
    hasPasswordField: passwordSels.length > 0,
    hasConfirmPasswordField: confirmPasswordSels.length > 0,
    hasCodeField: codeSels.length > 0,
    hasSendCodeButton: sendCodeSels.length > 0,
    hasPhoneField: phoneSels.length > 0,
    hasInviteField: inviteSels.length > 0,
    oauthProviders,
    registrationClosed,
  };
}

/**
 * Probe `/api/status` for OneAPI / NewAPI / VoAPI metadata.
 */
async function probeOneApiStatus(
  origin: string,
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<OneApiStatusMetadata | undefined> {
  try {
    const res = await doFetch(`${origin}/api/status`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return undefined;
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json || typeof json !== "object") return undefined;
    const data = (json.data ?? json) as Record<string, unknown>;
    if (
      json.success !== true &&
      typeof data.system_name !== "string" &&
      !("email_verification" in data) &&
      !("turnstile_check" in data)
    ) {
      return undefined;
    }

    // In OneAPI/NewAPI, register_enabled defaults to true unless explicitly false
    const registerEnabled =
      data.register_enabled === undefined ? true : Boolean(data.register_enabled);

    return {
      systemName: typeof data.system_name === "string" ? data.system_name : undefined,
      registerEnabled,
      emailVerification: Boolean(data.email_verification),
      turnstileCheck: Boolean(data.turnstile_check),
      turnstileSiteKey:
        typeof data.turnstile_site_key === "string" ? data.turnstile_site_key : undefined,
      githubOAuth: Boolean(data.github_oauth),
      linuxdoOAuth: Boolean(data.linuxdo_oauth),
      wechatLogin: Boolean(data.wechat_login),
      serverAddress:
        typeof data.server_address === "string" ? data.server_address : origin,
    };
  } catch {
    return undefined;
  }
}

/**
 * Probe common REST registration endpoints to see if direct API signup exists.
 */
async function probeRestRegistrationEndpoints(
  origin: string,
  html: string,
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<string[]> {
  const candidates = new Set<string>();

  // Scan HTML/inline scripts for API registration endpoints
  const apiPathRe = /["'](\/(?:api|v1|auth)\/[a-zA-Z0-9/_-]*?(?:register|signup|sign-up|sign_up))["']/gi;
  let m: RegExpExecArray | null;
  while ((m = apiPathRe.exec(html)) !== null) {
    if (m[1]) candidates.add(`${origin}${m[1]}`);
  }

  // Common REST registration endpoints
  const standardPaths = [
    "/api/auth/register",
    "/api/v1/auth/register",
    "/api/v1/user/register",
    "/api/register",
  ];
  for (const p of standardPaths) {
    candidates.add(`${origin}${p}`);
  }

  const confirmed: string[] = [];
  for (const endpoint of candidates) {
    try {
      const res = await doFetch(endpoint, {
        method: "OPTIONS",
        headers: { Accept: "application/json" },
      });
      // 200, 204, 400, 405, 422 on an API path often indicate the route handler exists (vs 404 HTML)
      if (res.status === 200 || res.status === 204 || res.status === 405 || res.status === 422) {
        confirmed.push(endpoint);
      }
    } catch {
      // ignore
    }
  }
  return confirmed;
}

/**
 * Score a single registration route candidate (0 - 100) based on automation feasibility,
 * speed, verification friction, and CAPTCHA barriers.
 */
export function scoreRouteCandidate(
  route: Omit<RegistrationRouteCandidate, "feasibilityScore">,
): number {
  if (route.type === "closed") return 0;

  let score = 50;
  switch (route.type) {
    case "api_oneapi":
      score = 96;
      break;
    case "api_rest":
    case "api_supabase":
      score = 88;
      break;
    case "browser_email_direct":
      score = 84;
      break;
    case "browser_email_otp":
    case "browser_email_link":
      score = 78;
      break;
    case "browser_phone_sms":
      score = 25;
      break;
    case "oauth_only":
      score = 20;
      break;
    default:
      score = 40;
  }

  // Adjust for verification requirements
  if (route.requiresEmailVerification) {
    score -= 6;
  }
  if (route.requiresPhone) {
    score -= 45;
  }
  if (route.requiresInviteCode) {
    score -= 30;
  }

  // Adjust for CAPTCHA barriers
  switch (route.captchaType) {
    case "none":
      break;
    case "turnstile":
      score -= route.method === "POST" ? 32 : 18;
      break;
    case "image_captcha":
      score -= 20;
      break;
    case "hcaptcha":
    case "recaptcha":
    case "geetest":
    case "slider":
      score -= 25;
      break;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Probe a site (URL or DiscoveredSite) to enumerate all registration routes,
 * barriers, selectors, and credential capabilities.
 */
export async function probeSiteRegistrationRoutes(
  siteOrUrl: string | DiscoveredSite,
  options: {
    timeoutMs?: number;
    onProgress?: ProgressFn;
    fetchFn?: typeof fetch;
  } = {},
): Promise<ProbeReport> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const doFetch = options.fetchFn
    ? (url: string, init?: RequestInit) => options.fetchFn!(url, init)
    : (url: string, init?: RequestInit) => fetchWithTimeout(url, init, timeoutMs);

  const discovered: DiscoveredSite =
    typeof siteOrUrl === "string"
      ? await inspectExternalSite(siteOrUrl, { timeoutMs, fetchFn: options.fetchFn })
      : siteOrUrl;

  const origin = discovered.origin;
  const derived = deriveDomainsFromUrl(discovered.url);
  let framework: SiteFrameworkType = discovered.framework;

  options.onProgress?.(`[probe] Probing registration pathways for ${discovered.id} (${origin})...`);

  // 1. Check OneAPI / NewAPI / VoAPI status endpoint
  const oneApiStatus = await probeOneApiStatus(origin, doFetch);
  if (oneApiStatus && (framework === "unknown" || framework === "generic_ai")) {
    const sys = (oneApiStatus.systemName ?? "").toLowerCase();
    framework = sys.includes("new") ? "newapi" : sys.includes("vo") ? "voapi" : "oneapi";
  }

  // 2. Fetch candidate signup pages to analyze HTML forms & selectors
  let bestSignupUrl = discovered.signupCandidates[0] ?? `${origin}/register`;
  let bestHtml = "";
  let bestAnalysis = analyzeRegistrationHtml("");

  const candidatePages = [
    ...new Set([
      ...discovered.signupCandidates,
      `${origin}/register`,
      `${origin}/signup`,
      discovered.url,
    ]),
  ].slice(0, 5);

  for (const pageUrl of candidatePages) {
    try {
      const res = await doFetch(pageUrl, { method: "GET" });
      if (!res.ok && res.status !== 200) continue;
      const html = await res.text().catch(() => "");
      if (!html) continue;

      const detectedFw = detectFrameworkFromHtml(html);
      if (framework === "unknown" && detectedFw !== "unknown") {
        framework = detectedFw;
      }

      const analysis = analyzeRegistrationHtml(html);
      const fieldCount =
        (analysis.hasEmailField ? 2 : 0) +
        (analysis.hasUsernameField ? 1 : 0) +
        (analysis.hasPasswordField ? 2 : 0) +
        (analysis.hasCodeField ? 1 : 0) +
        (analysis.hasPhoneField ? 1 : 0);

      if (!bestHtml || fieldCount > 0) {
        bestSignupUrl = pageUrl;
        bestHtml = html;
        bestAnalysis = analysis;
        if (analysis.hasPasswordField && (analysis.hasEmailField || analysis.hasUsernameField)) {
          break;
        }
      }
    } catch {
      // continue trying next candidate
    }
  }

  const htmlCaptcha = detectCaptchaFromHtml(bestHtml);
  const captchaType: CaptchaBarrierType =
    oneApiStatus?.turnstileCheck ? "turnstile" : htmlCaptcha;

  const routes: RegistrationRouteCandidate[] = [];

  // 3. Build Route Candidates
  // Route A: OneAPI / NewAPI / VoAPI protocol registration
  if (oneApiStatus || framework === "oneapi" || framework === "newapi" || framework === "voapi") {
    const isOpen = oneApiStatus ? oneApiStatus.registerEnabled : !bestAnalysis.registrationClosed;
    if (!isOpen) {
      routes.push({
        type: "closed",
        endpointOrUrl: `${origin}/api/user/register`,
        method: "POST",
        requiresEmailVerification: false,
        requiresPhone: false,
        captchaType,
        feasibilityScore: 0,
        estimatedSpeed: "manual",
        notes: ["Site has disabled new user registration (register_enabled=false)"],
      });
    } else {
      const needsEmail = oneApiStatus?.emailVerification ?? bestAnalysis.hasCodeField;
      const baseRoute: Omit<RegistrationRouteCandidate, "feasibilityScore"> = {
        type: "api_oneapi",
        endpointOrUrl: `${origin}/api/user/register`,
        method: "POST",
        requiresEmailVerification: needsEmail,
        requiresPhone: false,
        captchaType,
        estimatedSpeed: captchaType === "none" ? "fast" : "medium",
        notes: [
          `OneAPI/NewAPI standard protocol (${needsEmail ? "with /api/verification email code" : "direct no-OTP signup"})`,
          "Supports automatic POST /api/token to mint sk-... API keys after login",
        ],
      };
      routes.push({
        ...baseRoute,
        feasibilityScore: scoreRouteCandidate(baseRoute),
      });
    }
  }

  // Route B: Generic REST API registration if discovered
  if (framework !== "oneapi" && framework !== "newapi" && framework !== "voapi") {
    const restEndpoints = await probeRestRegistrationEndpoints(origin, bestHtml, doFetch);
    for (const ep of restEndpoints) {
      const baseRoute: Omit<RegistrationRouteCandidate, "feasibilityScore"> = {
        type: framework === "supabase" ? "api_supabase" : "api_rest",
        endpointOrUrl: ep,
        method: "POST",
        requiresEmailVerification: bestAnalysis.hasCodeField || bestAnalysis.hasSendCodeButton,
        requiresPhone: bestAnalysis.hasPhoneField && !bestAnalysis.hasEmailField,
        captchaType,
        estimatedSpeed: captchaType === "none" ? "fast" : "medium",
        notes: [`Detected backend registration endpoint ${ep}`],
      };
      routes.push({
        ...baseRoute,
        feasibilityScore: scoreRouteCandidate(baseRoute),
      });
    }
  }

  // Route C: Browser form registration pathways
  const registrationOpen =
    oneApiStatus !== undefined ? oneApiStatus.registerEnabled : !bestAnalysis.registrationClosed;

  if (registrationOpen) {
    const hasEmailOrUserForm =
      bestAnalysis.hasEmailField ||
      bestAnalysis.hasUsernameField ||
      bestAnalysis.hasPasswordField ||
      framework === "oneapi" ||
      framework === "newapi" ||
      framework === "voapi";

    const needsEmailOtp =
      Boolean(oneApiStatus?.emailVerification) ||
      bestAnalysis.hasCodeField ||
      bestAnalysis.hasSendCodeButton;

    const phoneOnly =
      bestAnalysis.hasPhoneField && !bestAnalysis.hasEmailField && !bestAnalysis.hasUsernameField;

    if (phoneOnly) {
      const baseRoute: Omit<RegistrationRouteCandidate, "feasibilityScore"> = {
        type: "browser_phone_sms",
        endpointOrUrl: bestSignupUrl,
        method: "BROWSER",
        requiresEmailVerification: false,
        requiresPhone: true,
        captchaType,
        estimatedSpeed: "manual",
        notes: ["Form requires phone number and SMS verification"],
      };
      routes.push({
        ...baseRoute,
        feasibilityScore: scoreRouteCandidate(baseRoute),
      });
    } else if (hasEmailOrUserForm) {
      const routeType = needsEmailOtp ? "browser_email_otp" : "browser_email_direct";
      const baseRoute: Omit<RegistrationRouteCandidate, "feasibilityScore"> = {
        type: routeType,
        endpointOrUrl: bestSignupUrl,
        method: "BROWSER",
        requiresEmailVerification: needsEmailOtp,
        requiresPhone: false,
        requiresInviteCode: bestAnalysis.hasInviteField,
        captchaType,
        estimatedSpeed: captchaType === "none" ? (needsEmailOtp ? "medium" : "fast") : "medium",
        notes: [
          needsEmailOtp
            ? "Browser signup form with automatic email verification code / link"
            : "Direct browser signup form (email/username + password, no email OTP required)",
        ],
      };
      routes.push({
        ...baseRoute,
        feasibilityScore: scoreRouteCandidate(baseRoute),
      });
    } else if (bestAnalysis.oauthProviders.length > 0) {
      const baseRoute: Omit<RegistrationRouteCandidate, "feasibilityScore"> = {
        type: "oauth_only",
        endpointOrUrl: bestSignupUrl,
        method: "BROWSER",
        requiresEmailVerification: false,
        requiresPhone: false,
        captchaType,
        oauthProviders: bestAnalysis.oauthProviders,
        estimatedSpeed: "manual",
        notes: [`OAuth login only (${bestAnalysis.oauthProviders.join(", ")})`],
      };
      routes.push({
        ...baseRoute,
        feasibilityScore: scoreRouteCandidate(baseRoute),
      });
    } else {
      // Fallback browser email route for client-rendered SPA pages
      const baseRoute: Omit<RegistrationRouteCandidate, "feasibilityScore"> = {
        type: "browser_email_otp",
        endpointOrUrl: bestSignupUrl,
        method: "BROWSER",
        requiresEmailVerification: true,
        requiresPhone: false,
        captchaType,
        estimatedSpeed: "medium",
        notes: ["Client-rendered SPA signup page; heuristic email+password+OTP browser flow"],
      };
      routes.push({
        ...baseRoute,
        feasibilityScore: scoreRouteCandidate(baseRoute),
      });
    }
  }

  // Sort routes from highest feasibility score to lowest
  routes.sort((a, b) => b.feasibilityScore - a.feasibilityScore);

  // 4. Determine credential hints for 2API usage
  const isOneApiFamily =
    Boolean(oneApiStatus) ||
    framework === "oneapi" ||
    framework === "newapi" ||
    framework === "voapi";

  const credentialHints: CredentialHint = {
    supportsApiKeyCreation: isOneApiFamily,
    tokenEndpoint: isOneApiFamily ? `${origin}/api/token/` : undefined,
    userSelfEndpoint: isOneApiFamily ? `${origin}/api/user/self` : undefined,
    openAiModelsEndpoint:
      discovered.openAiCompatible || isOneApiFamily ? `${origin}/v1/models` : undefined,
    chatCompletionsEndpoint:
      discovered.openAiCompatible || isOneApiFamily
        ? `${origin}/v1/chat/completions`
        : undefined,
    expectedAuthType: isOneApiFamily
      ? "api_key"
      : framework === "supabase" || framework === "clerk"
        ? "bearer_token"
        : "cookie_session",
  };

  return {
    platformId: discovered.id || derived.inferredId,
    siteUrl: discovered.url,
    origin,
    signupUrl: bestSignupUrl,
    framework,
    registrationOpen,
    routes,
    detectedSelectors: bestAnalysis.selectors,
    oneApiStatus,
    credentialHints,
    probedAt: nowIso(),
  };
}
