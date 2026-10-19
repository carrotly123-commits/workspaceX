/**
 * Phase 5: Meaningful Credential Extraction & Automatic API Key Provisioning.
 *
 * Extracts actionable credentials for custom 2API development:
 *   1. Real-time browser network sniffer (Request Authorization headers + Response JSON tokens/keys)
 *   2. Deep WebStorage (localStorage / sessionStorage) JSON traversal
 *   3. Automatic API Key (`sk-...`) provisioning on OneAPI / NewAPI / VoAPI & compatible consoles
 *   4. Auth cookie classification & ready-to-use HTTP headers assembly
 */

import type { Page } from "playwright-core";
import type { CredentialAuthType, MeaningfulCredentials } from "./types.ts";
import { cookiesToString, nowIso, parseCookieString } from "./utils.ts";

const SK_KEY_REGEX = /\bsk-[a-zA-Z0-9_-]{16,128}\b/;
const JWT_REGEX = /^eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}$/;
const AUTH_COOKIE_NAME_RE =
  /^(session|session_id|sid|token|auth|auth_token|access_token|jwt|user_token|__Secure-next-auth\.session-token|next-auth\.session-token|sb-.*-auth-token|cf_clearance)$/i;

export interface SniffedNetworkCredentials {
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  sessionToken?: string;
  userId?: string;
  username?: string;
  quota?: number;
  customAuthHeaders: Record<string, string>;
  observedApiEndpoints: string[];
}

export interface NetworkSnifferHandle {
  getSnapshot: () => SniffedNetworkCredentials;
  detach: () => void;
}

/**
 * Recursively inspect a parsed JSON payload for keys, tokens, and user metadata.
 */
export function extractSecretsFromJsonPayload(
  payload: unknown,
  sourceUrl = "",
  target: SniffedNetworkCredentials = {
    customAuthHeaders: {},
    observedApiEndpoints: [],
  },
  depth = 0,
): SniffedNetworkCredentials {
  if (depth > 5 || !payload || typeof payload !== "object") return target;

  if (Array.isArray(payload)) {
    for (const item of payload.slice(0, 10)) {
      extractSecretsFromJsonPayload(item, sourceUrl, target, depth + 1);
    }
    return target;
  }

  const obj = payload as Record<string, unknown>;
  const isTokenEndpoint = /\/api\/token|\/v1\/keys|\/api[-_]?keys/i.test(sourceUrl);

  for (const [rawKey, val] of Object.entries(obj)) {
    const key = rawKey.toLowerCase();

    if (typeof val === "string") {
      const trimmed = val.trim();
      if (!trimmed) continue;

      // 1. Direct sk-... API key match anywhere
      const skMatch = trimmed.match(SK_KEY_REGEX);
      if (skMatch && !target.apiKey) {
        target.apiKey = skMatch[0];
        continue;
      }

      // 2. OneAPI / NewAPI /api/token returns { key: "48charhex..." } without "sk-" prefix
      if (
        !target.apiKey &&
        (key === "api_key" ||
          key === "apikey" ||
          key === "secret_key" ||
          key === "openai_api_key" ||
          (isTokenEndpoint && key === "key")) &&
        /^[a-zA-Z0-9_-]{24,128}$/.test(trimmed)
      ) {
        target.apiKey = trimmed.startsWith("sk-") ? trimmed : `sk-${trimmed}`;
        continue;
      }

      // 3. Access / Bearer / JWT token
      if (
        !target.accessToken &&
        (key === "access_token" ||
          key === "accesstoken" ||
          key === "bearer_token" ||
          key === "id_token" ||
          key === "jwt" ||
          key === "auth_token" ||
          (key === "token" && trimmed.length >= 16))
      ) {
        if (trimmed.startsWith("sk-") && !target.apiKey) {
          target.apiKey = trimmed;
        } else {
          target.accessToken = trimmed.replace(/^Bearer\s+/i, "");
        }
        continue;
      }

      // 4. Refresh token
      if (!target.refreshToken && (key === "refresh_token" || key === "refreshtoken")) {
        target.refreshToken = trimmed;
        continue;
      }

      // 5. Session token
      if (!target.sessionToken && (key === "session_token" || key === "sessiontoken" || key === "session_id")) {
        target.sessionToken = trimmed;
        continue;
      }

      // 6. Username
      if (!target.username && (key === "username" || key === "user_name") && trimmed.length <= 64) {
        target.username = trimmed;
        continue;
      }

      // 7. String user ID on user endpoints
      if (
        !target.userId &&
        (key === "user_id" || key === "userid" || (key === "id" && /\/user|\/me|\/self|\/auth/i.test(sourceUrl))) &&
        trimmed.length <= 64
      ) {
        target.userId = trimmed;
      }
    } else if (typeof val === "number") {
      if (!target.userId && (key === "id" || key === "user_id") && /\/user|\/me|\/self|\/login|\/register/i.test(sourceUrl)) {
        target.userId = String(val);
      }
      if (target.quota === undefined && (key === "quota" || key === "remain_quota" || key === "balance")) {
        target.quota = val;
      }
    } else if (val && typeof val === "object") {
      extractSecretsFromJsonPayload(val, sourceUrl, target, depth + 1);
    }
  }

  return target;
}

/**
 * Attach a live network request/response sniffer to a Playwright Page
 * to capture Bearer tokens, API keys, custom auth headers, and API endpoints.
 */
export function attachNetworkCredentialSniffer(page: Page): NetworkSnifferHandle {
  const state: SniffedNetworkCredentials = {
    customAuthHeaders: {},
    observedApiEndpoints: [],
  };
  const endpointsSet = new Set<string>();

  const onRequest = (req: { url: () => string; headers: () => Record<string, string> }) => {
    try {
      const url = req.url();
      if (/\/(v1|api|chat|graphql)\//i.test(url)) {
        try {
          const u = new URL(url);
          endpointsSet.add(`${u.origin}${u.pathname}`);
        } catch {
          // ignore
        }
      }
      const headers = req.headers();
      for (const [k, v] of Object.entries(headers)) {
        const lower = k.toLowerCase();
        if (!v) continue;
        if (lower === "authorization") {
          const m = v.match(/^Bearer\s+(.+)$/i);
          const token = (m ? m[1] : v).trim();
          if (token.startsWith("sk-") && !state.apiKey) {
            state.apiKey = token;
          } else if (token.length >= 12 && !state.accessToken) {
            state.accessToken = token;
          }
        } else if (
          lower === "x-api-key" ||
          lower === "api-key" ||
          lower === "x-openai-api-key"
        ) {
          if (!state.apiKey && v.trim().length >= 12) {
            state.apiKey = v.trim();
          }
          state.customAuthHeaders[k] = v.trim();
        } else if (
          lower === "x-auth-token" ||
          lower === "new-api-user" ||
          lower === "x-user-id"
        ) {
          state.customAuthHeaders[k] = v.trim();
          if (lower === "new-api-user" && !state.userId) {
            state.userId = v.trim();
          }
        }
      }
    } catch {
      // ignore listener errors
    }
  };

  const onResponse = async (res: {
    url: () => string;
    status: () => number;
    headers: () => Record<string, string>;
    json: () => Promise<unknown>;
  }) => {
    try {
      const status = res.status();
      if (status < 200 || status >= 300) return;
      const ct = (res.headers()["content-type"] ?? "").toLowerCase();
      if (!ct.includes("json")) return;
      const url = res.url();
      const data = await res.json().catch(() => null);
      if (data) {
        extractSecretsFromJsonPayload(data, url, state);
      }
    } catch {
      // ignore response read errors
    }
  };

  page.on("request", onRequest);
  page.on("response", onResponse);

  return {
    getSnapshot: () => ({
      ...state,
      customAuthHeaders: { ...state.customAuthHeaders },
      observedApiEndpoints: [...endpointsSet],
    }),
    detach: () => {
      page.off("request", onRequest);
      page.off("response", onResponse);
    },
  };
}

/**
 * Automatically query / create an `sk-...` API key on OneAPI / NewAPI / VoAPI
 * or compatible token endpoints using captured session cookies / access token.
 */
export async function provisionApiKeyViaProtocol(options: {
  origin: string;
  cookieString: string;
  accessToken?: string;
  userId?: string;
  userAgent?: string;
  fetchFn?: typeof fetch;
}): Promise<{
  apiKey?: string;
  accessToken?: string;
  userId?: string;
  username?: string;
  quota?: number;
}> {
  const doFetch = options.fetchFn ?? fetch;
  const origin = options.origin.replace(/\/$/, "");
  let userId = options.userId;
  let accessToken = options.accessToken;
  let username: string | undefined;
  let quota: number | undefined;
  let apiKey: string | undefined;

  const buildHeaders = (): Record<string, string> => {
    const h: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": options.userAgent ?? "Mozilla/5.0",
    };
    if (options.cookieString) h.Cookie = options.cookieString;
    if (accessToken) h.Authorization = `Bearer ${accessToken}`;
    if (userId) {
      h["New-Api-User"] = String(userId);
      h["Rix-Api-User"] = String(userId);
      h["Voapi-User"] = String(userId);
    }
    return h;
  };

  // Step 1: Query `/api/user/self` to discover userId, quota, and system access_token
  try {
    const selfRes = await doFetch(`${origin}/api/user/self`, {
      method: "GET",
      headers: buildHeaders(),
    });
    if (selfRes.ok) {
      const json = (await selfRes.json().catch(() => null)) as Record<string, unknown> | null;
      const data = (json?.data ?? json) as Record<string, unknown> | undefined;
      if (data && typeof data === "object") {
        if (data.id !== undefined && data.id !== null) userId = String(data.id);
        if (typeof data.username === "string") username = data.username;
        if (typeof data.quota === "number") quota = data.quota;
        if (typeof data.access_token === "string" && data.access_token.trim()) {
          accessToken = data.access_token.trim();
        }
      }
    }
  } catch {
    // ignore if not a OneAPI/NewAPI site
  }

  // Helper to parse token list from `/api/token/`
  const extractKeyFromTokenList = (json: unknown): string | undefined => {
    if (!json || typeof json !== "object") return undefined;
    const root = json as Record<string, unknown>;
    const data = root.data;
    const items: unknown[] = Array.isArray(data)
      ? data
      : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).items)
        ? ((data as Record<string, unknown>).items as unknown[])
        : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).data)
          ? ((data as Record<string, unknown>).data as unknown[])
          : [];
    for (const item of items) {
      if (item && typeof item === "object") {
        const k = (item as Record<string, unknown>).key;
        if (typeof k === "string" && k.trim().length >= 16) {
          const trimmed = k.trim();
          return trimmed.startsWith("sk-") ? trimmed : `sk-${trimmed}`;
        }
      }
    }
    return undefined;
  };

  // Step 2: Check existing tokens at `GET /api/token/?p=0&size=10`
  try {
    const listRes = await doFetch(`${origin}/api/token/?p=0&size=10`, {
      method: "GET",
      headers: buildHeaders(),
    });
    if (listRes.ok) {
      const listJson = await listRes.json().catch(() => null);
      apiKey = extractKeyFromTokenList(listJson);

      // Step 3: If no token exists yet, mint a new unlimited token via `POST /api/token/`
      if (!apiKey && listJson && typeof listJson === "object" && (listJson as Record<string, unknown>).success !== false) {
        const createRes = await doFetch(`${origin}/api/token/`, {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify({
            name: `auto-2api-${Date.now().toString(36)}`,
            remain_quota: 500000,
            expired_time: -1,
            unlimited_quota: true,
            model_limits_enabled: false,
            model_limits: "",
            allow_ips: "",
          }),
        });
        if (createRes.ok) {
          const createJson = await createRes.json().catch(() => null);
          apiKey = extractKeyFromTokenList(createJson);
          if (!apiKey) {
            const listAfterRes = await doFetch(`${origin}/api/token/?p=0&size=10`, {
              method: "GET",
              headers: buildHeaders(),
            });
            if (listAfterRes.ok) {
              const listAfterJson = await listAfterRes.json().catch(() => null);
              apiKey = extractKeyFromTokenList(listAfterJson);
            }
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // Step 4: If still no accessToken on a OneAPI/NewAPI site, try `GET /api/user/token`
  if (!accessToken && userId) {
    try {
      const tokRes = await doFetch(`${origin}/api/user/token`, {
        method: "GET",
        headers: buildHeaders(),
      });
      if (tokRes.ok) {
        const tokJson = (await tokRes.json().catch(() => null)) as Record<string, unknown> | null;
        if (typeof tokJson?.data === "string" && tokJson.data.trim().length >= 16) {
          accessToken = tokJson.data.trim();
        }
      }
    } catch {
      // ignore
    }
  }

  return { apiKey, accessToken, userId, username, quota };
}

/**
 * Filter a cookie list or cookie string into key authentication cookies.
 */
export function extractAuthCookies(
  cookiesInput: Array<{ name: string; value: string }> | string,
): Record<string, string> {
  const list =
    typeof cookiesInput === "string"
      ? parseCookieString(cookiesInput)
      : cookiesInput;

  const authCookies: Record<string, string> = {};
  for (const c of list) {
    if (!c.name || !c.value) continue;
    if (
      AUTH_COOKIE_NAME_RE.test(c.name) ||
      /token|sess|auth|jwt|uid|user|key/i.test(c.name)
    ) {
      authCookies[c.name] = c.value;
    }
  }
  return authCookies;
}

/**
 * Assemble a standardized `MeaningfulCredentials` object from all collected signals
 * (cookies, web storage, network sniffer, and API key provisioning).
 */
export function buildMeaningfulCredentials(input: {
  email: string;
  origin: string;
  userAgent: string;
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string }> | string;
  localStorage?: Record<string, string>;
  bearerToken?: string;
  sniffed?: Partial<SniffedNetworkCredentials>;
  provisioned?: {
    apiKey?: string;
    accessToken?: string;
    userId?: string;
    username?: string;
    quota?: number;
  };
  extra?: Record<string, unknown>;
}): MeaningfulCredentials | null {
  const cookieString =
    typeof input.cookies === "string"
      ? input.cookies
      : input.cookies
        ? cookiesToString(input.cookies)
        : "";

  const authCookies = extractAuthCookies(input.cookies ?? "");
  const storage = input.localStorage ?? {};

  // Also scan localStorage values with `extractSecretsFromJsonPayload`
  const storageSecrets: SniffedNetworkCredentials = {
    customAuthHeaders: {},
    observedApiEndpoints: [],
  };
  for (const [k, v] of Object.entries(storage)) {
    if (!v) continue;
    const skMatch = v.match(SK_KEY_REGEX);
    if (skMatch && !storageSecrets.apiKey) {
      storageSecrets.apiKey = skMatch[0];
    }
    if (JWT_REGEX.test(v.trim()) && !storageSecrets.accessToken) {
      storageSecrets.accessToken = v.trim();
    }
    try {
      const parsed = JSON.parse(v);
      extractSecretsFromJsonPayload(parsed, k, storageSecrets);
    } catch {
      // plain string value
    }
  }

  // Also check if any auth cookie value itself is a JWT or sk- key
  let cookieJwt: string | undefined;
  for (const val of Object.values(authCookies)) {
    if (JWT_REGEX.test(val)) {
      cookieJwt = val;
      break;
    }
  }

  const apiKey =
    input.provisioned?.apiKey ??
    input.sniffed?.apiKey ??
    storageSecrets.apiKey;

  const accessToken =
    input.provisioned?.accessToken ??
    input.sniffed?.accessToken ??
    input.bearerToken ??
    storageSecrets.accessToken ??
    cookieJwt;

  const refreshToken =
    input.sniffed?.refreshToken ??
    storageSecrets.refreshToken;

  const sessionToken =
    input.sniffed?.sessionToken ??
    storageSecrets.sessionToken ??
    authCookies.session ??
    authCookies.session_id ??
    authCookies.token;

  const userId =
    input.provisioned?.userId ??
    input.sniffed?.userId ??
    storageSecrets.userId;

  const username =
    input.provisioned?.username ??
    input.sniffed?.username ??
    storageSecrets.username;

  const quota =
    input.provisioned?.quota ??
    input.sniffed?.quota ??
    storageSecrets.quota;

  const hasAnyCredential =
    Boolean(apiKey) ||
    Boolean(accessToken) ||
    Boolean(sessionToken) ||
    Boolean(cookieString) ||
    Object.keys(storage).length > 0;

  if (!hasAnyCredential) {
    return null;
  }

  // Determine primary authType and primarySecret
  let authType: CredentialAuthType = "cookie_session";
  let primarySecret = cookieString;
  let quality: "high" | "medium" | "low" = "low";
  let qualityReason = "Only generic browser cookies captured";

  if (apiKey) {
    authType = "api_key";
    primarySecret = apiKey;
    quality = "high";
    qualityReason = "Dedicated API key (sk-...) provisioned/extracted for direct 2API calls";
  } else if (accessToken) {
    authType = "bearer_token";
    primarySecret = accessToken;
    quality = "high";
    qualityReason = "Bearer / JWT access token captured for authenticated API calls";
  } else if (Object.keys(input.sniffed?.customAuthHeaders ?? {}).length > 0) {
    authType = "custom_header";
    primarySecret = Object.values(input.sniffed!.customAuthHeaders!)[0] ?? cookieString;
    quality = "high";
    qualityReason = "Custom authentication header captured from live API traffic";
  } else if (sessionToken || Object.keys(authCookies).length > 0) {
    authType = "cookie_session";
    primarySecret = sessionToken ?? cookieString;
    quality = "medium";
    qualityReason = `Authenticated session cookie(s) captured (${Object.keys(authCookies).join(", ")})`;
  }

  // Assemble ready-to-use HTTP headers for 2API requests
  const readyHeaders: Record<string, string> = {
    "User-Agent": input.userAgent || "Mozilla/5.0",
    ...(input.sniffed?.customAuthHeaders ?? {}),
  };
  if (apiKey) {
    readyHeaders.Authorization = `Bearer ${apiKey}`;
  } else if (accessToken) {
    readyHeaders.Authorization = `Bearer ${accessToken}`;
  }
  if (cookieString) {
    readyHeaders.Cookie = cookieString;
  }
  if (userId) {
    readyHeaders["New-Api-User"] = String(userId);
  }

  const origin = input.origin.replace(/\/$/, "");
  const apiBaseUrl = apiKey ? `${origin}/v1` : origin;

  const result: MeaningfulCredentials = {
    ...(input.extra ?? {}),
    authType,
    primarySecret,
    ...(apiKey ? { apiKey } : {}),
    ...(accessToken ? { accessToken, bearer: accessToken } : apiKey ? { bearer: apiKey } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(sessionToken ? { sessionToken } : {}),
    cookie: cookieString,
    authCookies,
    readyHeaders,
    email: input.email,
    ...(userId ? { userId } : {}),
    ...(username ? { username } : {}),
    ...(quota !== undefined ? { quota } : {}),
    origin,
    apiBaseUrl,
    observedApiEndpoints: input.sniffed?.observedApiEndpoints ?? [],
    userAgent: input.userAgent || "Mozilla/5.0",
    capturedAt: nowIso(),
    quality,
    qualityReason,
    ...(Object.keys(storage).length > 0 ? { localStorage: storage } : {}),
  };
  return result;
}
