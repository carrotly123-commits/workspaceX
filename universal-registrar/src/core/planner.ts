/**
 * Phase 3: Optimal Registration Strategy Selector & Planner.
 *
 * Evaluates a `ProbeReport` from Phase 2, selects the highest-scoring
 * registration pathway, configures concurrency/email/retry parameters,
 * and generates a ready-to-run `RegistrationStrategyPlan` and `GenericPlatformConfig`.
 */

import type { GenericPlatformConfig } from "../platforms/generic.ts";
import type {
  ProbeReport,
  RegisterMode,
  RegistrationRouteCandidate,
  RegistrationStrategyPlan,
  StrategyExecutionKind,
} from "./types.ts";
import { nowIso } from "./utils.ts";

/**
 * Select the optimal registration strategy from a site's ProbeReport.
 */
export function selectOptimalStrategy(
  report: ProbeReport,
  options: {
    preferProtocol?: boolean;
    maxConcurrency?: number;
  } = {},
): RegistrationStrategyPlan {
  const sortedRoutes = [...report.routes].sort(
    (a, b) => b.feasibilityScore - a.feasibilityScore,
  );

  const fallbackRoute: RegistrationRouteCandidate = {
    type: report.registrationOpen ? "browser_email_otp" : "closed",
    endpointOrUrl: report.signupUrl,
    method: "BROWSER",
    requiresEmailVerification: true,
    requiresPhone: false,
    captchaType: "none",
    feasibilityScore: report.registrationOpen ? 50 : 0,
    estimatedSpeed: report.registrationOpen ? "medium" : "manual",
    notes: ["Fallback registration route"],
  };

  const chosenRoute = sortedRoutes[0] ?? fallbackRoute;
  const alternativeRoutes = sortedRoutes.slice(1);
  const reasoning: string[] = [];

  let strategyKind: StrategyExecutionKind = "browser_semi";
  let mode: RegisterMode = "semi";
  let canBulkRegister = true;
  let recommendedEmailProvider: "auto" | "mailhub" | "mailtm" | "manual" = "auto";
  let recommendedConcurrency = 1;
  let recommendedDelayMs = 3_000;

  if (!report.registrationOpen || chosenRoute.type === "closed") {
    strategyKind = "manual";
    mode = "manual";
    canBulkRegister = false;
    recommendedEmailProvider = "manual";
    reasoning.push("Target site currently has new user registration closed.");
  } else if (
    (chosenRoute.type === "api_oneapi" ||
      chosenRoute.type === "api_rest" ||
      chosenRoute.type === "api_supabase") &&
    chosenRoute.captchaType === "none" &&
    options.preferProtocol !== false
  ) {
    strategyKind = "api_protocol";
    mode = "auto";
    canBulkRegister = true;
    recommendedEmailProvider = "auto";
    recommendedConcurrency = Math.min(options.maxConcurrency ?? 5, chosenRoute.requiresEmailVerification ? 3 : 5);
    recommendedDelayMs = chosenRoute.requiresEmailVerification ? 1_000 : 300;
    reasoning.push(
      `Selected pure HTTP protocol registration (${chosenRoute.type} -> ${chosenRoute.endpointOrUrl}) with score ${chosenRoute.feasibilityScore}/100.`,
    );
    if (!chosenRoute.requiresEmailVerification) {
      reasoning.push("No email OTP or CAPTCHA required — supports fast high-concurrency bulk registration.");
    } else {
      reasoning.push("Requires email verification code — paired with automatic MailHub/Mail.tm inbox polling.");
    }
    if (report.credentialHints.supportsApiKeyCreation) {
      reasoning.push("Automatically provisions sk-... API keys via /api/token after registration.");
    }
  } else if (
    chosenRoute.type === "browser_email_direct" ||
    chosenRoute.type === "browser_email_otp" ||
    chosenRoute.type === "browser_email_link" ||
    (chosenRoute.type === "api_oneapi" && chosenRoute.captchaType !== "none")
  ) {
    const hasHardCaptcha =
      chosenRoute.captchaType !== "none" && chosenRoute.captchaType !== "turnstile";
    if (chosenRoute.captchaType === "none") {
      strategyKind = "browser_auto";
      mode = "auto";
      canBulkRegister = true;
      recommendedConcurrency = Math.min(options.maxConcurrency ?? 2, 2);
      recommendedDelayMs = 2_000;
      reasoning.push(
        `Selected fully automated browser registration (${chosenRoute.type}) with score ${chosenRoute.feasibilityScore}/100.`,
      );
    } else if (chosenRoute.captchaType === "turnstile" && !hasHardCaptcha) {
      strategyKind = "browser_semi";
      mode = "auto";
      canBulkRegister = true;
      recommendedConcurrency = 1;
      recommendedDelayMs = 3_500;
      reasoning.push(
        `Site uses Cloudflare Turnstile; selected browser flow with automatic Turnstile clicker + fallback (${chosenRoute.feasibilityScore}/100).`,
      );
    } else {
      strategyKind = "browser_semi";
      mode = "semi";
      canBulkRegister = true;
      recommendedConcurrency = 1;
      recommendedDelayMs = 5_000;
      reasoning.push(
        `Site requires CAPTCHA (${chosenRoute.captchaType}); selected semi-auto browser flow (${chosenRoute.feasibilityScore}/100).`,
      );
    }
  } else {
    strategyKind = "manual";
    mode = "manual";
    canBulkRegister = false;
    recommendedEmailProvider = "manual";
    reasoning.push(
      `Site requires ${chosenRoute.type === "browser_phone_sms" ? "SMS phone verification" : "third-party OAuth"} (${chosenRoute.feasibilityScore}/100); manual or session capture recommended.`,
    );
  }

  const isOneApi =
    report.framework === "oneapi" ||
    report.framework === "newapi" ||
    report.framework === "voapi" ||
    Boolean(report.oneApiStatus);

  const protocolEndpoints = isOneApi
    ? {
        registerUrl: `${report.origin}/api/user/register`,
        loginUrl: `${report.origin}/api/user/login`,
        sendCodeUrl: `${report.origin}/api/verification`,
        tokenUrl: `${report.origin}/api/token/`,
        userSelfUrl: `${report.origin}/api/user/self`,
      }
    : chosenRoute.method === "POST"
      ? {
          registerUrl: chosenRoute.endpointOrUrl,
        }
      : undefined;

  return {
    platformId: report.platformId,
    siteUrl: report.siteUrl,
    signupUrl: report.signupUrl,
    framework: report.framework,
    chosenRoute,
    alternativeRoutes,
    strategyKind,
    mode,
    score: chosenRoute.feasibilityScore,
    canBulkRegister,
    recommendedEmailProvider,
    recommendedConcurrency,
    recommendedDelayMs,
    reasoning,
    credentialHints: report.credentialHints,
    detectedSelectors: report.detectedSelectors,
    protocolEndpoints,
    plannedAt: nowIso(),
  };
}

/**
 * Convert a `RegistrationStrategyPlan` into a `GenericPlatformConfig`
 * that can be saved to `config/platforms/<id>.json` or passed to adapters.
 */
export function planToGenericPlatformConfig(
  plan: RegistrationStrategyPlan,
): GenericPlatformConfig {
  const sel = plan.detectedSelectors;
  return {
    id: plan.platformId,
    name: `${plan.platformId} (${new URL(plan.siteUrl).hostname})`,
    signupUrl: plan.signupUrl,
    preferredMode: plan.mode,
    needsEmail: Boolean(plan.chosenRoute.requiresEmailVerification),
    needsPhone: plan.chosenRoute.requiresPhone,
    tips: plan.reasoning.join(" | "),
    selectors: {
      ...(sel.openSignup ? { openSignup: sel.openSignup } : {}),
      ...(sel.email ? { email: sel.email } : {}),
      ...(sel.password ? { password: sel.password } : {}),
      ...(sel.name || sel.username
        ? { name: [...(sel.name ?? []), ...(sel.username ?? [])] }
        : {}),
      ...(sel.phone ? { phone: sel.phone } : {}),
      ...(sel.submit ? { submit: sel.submit } : {}),
      ...(sel.code ? { code: sel.code } : {}),
      ...(sel.sendCode ? { sendCode: sel.sendCode } : {}),
    },
    framework: plan.framework,
    strategyKind: plan.strategyKind,
    protocolEndpoints: plan.protocolEndpoints,
    credentialHints: plan.credentialHints,
  };
}
