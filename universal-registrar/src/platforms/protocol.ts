/**
 * Phase 4: High-Speed Protocol-Level Registrar (`ProtocolAdapter`).
 *
 * Executes pure HTTP API registration + login + automatic `sk-...` API key
 * provisioning without browser overhead whenever a site exposes a compatible
 * registration API (OneAPI, NewAPI, VoAPI, Supabase, or REST JSON endpoints).
 */

import {
  buildMeaningfulCredentials,
  extractSecretsFromJsonPayload,
  provisionApiKeyViaProtocol,
  type SniffedNetworkCredentials,
} from "../core/credentials.ts";
import type {
  RegisterContext,
  RegisterResult,
  SiteFrameworkType,
} from "../core/types.ts";
import { extractVerificationCode } from "../core/utils.ts";

export interface ProtocolRegisterOptions {
  origin: string;
  framework: SiteFrameworkType;
  registerUrl: string;
  loginUrl?: string;
  sendCodeUrl?: string;
  requiresEmailVerification?: boolean;
  affCode?: string;
  fetchFn?: typeof fetch;
}

/**
 * Extract `key=value` cookie pairs from `Set-Cookie` headers on a fetch Response.
 */
function extractSetCookies(res: Response): Record<string, string> {
  const jar: Record<string, string> = {};
  const rawList: string[] = [];

  const anyHeaders = res.headers as unknown as {
    getSetCookie?: () => string[];
  };
  if (typeof anyHeaders.getSetCookie === "function") {
    rawList.push(...anyHeaders.getSetCookie());
  } else {
    const single = res.headers.get("set-cookie");
    if (single) {
      rawList.push(...single.split(/,(?=\s*[a-zA-Z0-9_-]+=)/));
    }
  }

  for (const raw of rawList) {
    const firstPart = raw.split(";")[0]?.trim();
    if (!firstPart) continue;
    const eq = firstPart.indexOf("=");
    if (eq > 0) {
      const k = firstPart.slice(0, eq).trim();
      const v = firstPart.slice(eq + 1).trim();
      if (k) jar[k] = v;
    }
  }
  return jar;
}

function cookieJarToString(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function deriveUsername(email: string, fallbackName?: string): string {
  const prefix = (email.split("@")[0] ?? fallbackName ?? "user")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${prefix || "user"}_${suffix}`;
}

/**
 * Execute protocol-level registration, login, and API key provisioning.
 */
export async function executeProtocolRegistration(
  ctx: RegisterContext,
  opts: ProtocolRegisterOptions,
): Promise<RegisterResult> {
  const doFetch = opts.fetchFn ?? fetch;
  const origin = opts.origin.replace(/\/$/, "");
  const cookieJar: Record<string, string> = {};
  const sniffed: SniffedNetworkCredentials = {
    customAuthHeaders: {},
    observedApiEndpoints: [opts.registerUrl],
  };
  const userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  const username = deriveUsername(ctx.identity.email, ctx.identity.name);
  let verificationCode = "";

  // Step 1: Request & poll email verification code if required
  if (opts.requiresEmailVerification) {
    const sendCodeEndpoint =
      opts.sendCodeUrl ?? `${origin}/api/verification`;
    const urlWithEmail = sendCodeEndpoint.includes("?")
      ? `${sendCodeEndpoint}&email=${encodeURIComponent(ctx.identity.email)}`
      : `${sendCodeEndpoint}?email=${encodeURIComponent(ctx.identity.email)}`;

    ctx.onProgress(`Requesting email verification code via ${urlWithEmail}...`, "info");
    const codeRes = await doFetch(urlWithEmail, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": userAgent,
      },
    });
    Object.assign(cookieJar, extractSetCookies(codeRes));
    const codeJson = (await codeRes.json().catch(() => null)) as Record<string, unknown> | null;
    if (codeJson && codeJson.success === false) {
      throw new Error(
        `Failed to request email verification code: ${String(codeJson.message ?? codeRes.status)}`,
      );
    }

    if (!ctx.email) {
      throw new Error("Email verification required by protocol endpoint, but no EmailProvider is configured");
    }
    const msg = await ctx.email.waitForMessage(
      ctx.identity.email,
      (m) => Boolean(extractVerificationCode(m.bodyText)),
      ctx.timeoutMs,
    );
    const extracted = extractVerificationCode(msg.bodyText);
    if (!extracted) {
      throw new Error("Could not extract verification code from received email");
    }
    verificationCode = extracted;
    ctx.onProgress(`Received email verification code: ${verificationCode}`, "info");
  }

  // Step 2: Submit registration request
  ctx.onProgress(`Submitting protocol registration to ${opts.registerUrl} (username=${username})...`, "info");
  const registerPayload: Record<string, unknown> = {
    username,
    password: ctx.identity.password,
    password2: ctx.identity.password,
    email: ctx.identity.email,
    name: ctx.identity.name ?? username,
    ...(verificationCode
      ? { verification_code: verificationCode, code: verificationCode }
      : {}),
    ...(opts.affCode ? { aff_code: opts.affCode } : {}),
  };

  const regRes = await doFetch(opts.registerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": userAgent,
      ...(Object.keys(cookieJar).length > 0
        ? { Cookie: cookieJarToString(cookieJar) }
        : {}),
    },
    body: JSON.stringify(registerPayload),
  });

  Object.assign(cookieJar, extractSetCookies(regRes));
  const regJson = (await regRes.json().catch(() => null)) as Record<string, unknown> | null;

  if (!regRes.ok || (regJson && regJson.success === false)) {
    const errMsg =
      typeof regJson?.message === "string"
        ? regJson.message
        : typeof regJson?.error === "string"
          ? regJson.error
          : `HTTP ${regRes.status}`;
    throw new Error(`Protocol registration failed: ${errMsg}`);
  }

  if (regJson) {
    extractSecretsFromJsonPayload(regJson, opts.registerUrl, sniffed);
  }

  // Step 3: Perform login if needed (OneAPI/NewAPI requires POST /api/user/login to establish session cookie)
  const loginUrl = opts.loginUrl ?? `${origin}/api/user/login`;
  const isOneApiFamily =
    opts.framework === "oneapi" ||
    opts.framework === "newapi" ||
    opts.framework === "voapi" ||
    opts.registerUrl.endsWith("/api/user/register");

  if (isOneApiFamily || (!sniffed.apiKey && !sniffed.accessToken && Object.keys(cookieJar).length === 0)) {
    try {
      const loginRes = await doFetch(loginUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": userAgent,
          ...(Object.keys(cookieJar).length > 0
            ? { Cookie: cookieJarToString(cookieJar) }
            : {}),
        },
        body: JSON.stringify({
          username,
          email: ctx.identity.email,
          password: ctx.identity.password,
        }),
      });
      Object.assign(cookieJar, extractSetCookies(loginRes));
      const loginJson = await loginRes.json().catch(() => null);
      if (loginJson) {
        extractSecretsFromJsonPayload(loginJson, loginUrl, sniffed);
      }
    } catch {
      // ignore login error if registration already authenticated
    }
  }

  // Step 4: Provision API Key (`sk-...`) and fetch user profile/quota
  const cookieString = cookieJarToString(cookieJar);
  const provisioned = await provisionApiKeyViaProtocol({
    origin,
    cookieString,
    accessToken: sniffed.accessToken,
    userId: sniffed.userId,
    userAgent,
    fetchFn: doFetch,
  });

  if (provisioned.apiKey) {
    ctx.onProgress(`Minted API Key for ${ctx.identity.email}: ${provisioned.apiKey.slice(0, 10)}...`, "success");
    sniffed.observedApiEndpoints.push(`${origin}/v1/chat/completions`, `${origin}/v1/models`);
  }

  const credentials = buildMeaningfulCredentials({
    email: ctx.identity.email,
    origin,
    userAgent,
    cookies: cookieString,
    sniffed,
    provisioned: {
      ...provisioned,
      username: provisioned.username ?? username,
    },
    extra: {
      username,
      password: ctx.identity.password,
      startUrl: origin,
      providerName: origin,
    },
  });

  if (!credentials) {
    return {
      success: false,
      status: "failed",
      identity: ctx.identity,
      message: "Protocol registration succeeded but no session/token/key credentials were returned",
    };
  }

  return {
    success: true,
    status: "success",
    identity: {
      ...ctx.identity,
      extra: { ...(ctx.identity.extra ?? {}), username },
    },
    credentials,
    message: credentials.apiKey
      ? `Registered via protocol & minted API key (${credentials.apiKey.slice(0, 10)}...)`
      : `Registered via protocol (${credentials.authType})`,
  };
}
