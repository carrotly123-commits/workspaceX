/**
 * Export meaningful account credentials into 2API-ready formats:
 *   - Structured 2API JSON bundle (`credentials-2api.json`)
 *   - Plain API keys / Bearer tokens list (`keys.txt`)
 *   - JSON Lines (`credentials.jsonl`)
 *   - Dotenv variable format (`.env.2api`)
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RegisteredAccount } from "../core/types.ts";
import { nowIso } from "../core/utils.ts";

export type CredentialExportFormat = "json" | "keys" | "jsonl" | "env";

export interface Exported2ApiAccount {
  platformId: string;
  email: string;
  password?: string;
  authType: string;
  primarySecret: string;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  sessionToken?: string;
  userId?: string;
  username?: string;
  quota?: number;
  origin?: string;
  apiBaseUrl?: string;
  readyHeaders: Record<string, string>;
  cookie?: string;
  quality: string;
  updatedAt: string;
}

export interface Exported2ApiBundle {
  version: 1;
  exportedAt: string;
  totalAccounts: number;
  totalApiKeys: number;
  totalBearerTokens: number;
  platforms: Record<
    string,
    {
      platformId: string;
      apiBaseUrl?: string;
      origin?: string;
      count: number;
      apiKeys: string[];
      bearerTokens: string[];
      accounts: Exported2ApiAccount[];
    }
  >;
}

export function normalizeAccountFor2Api(account: RegisteredAccount): Exported2ApiAccount | null {
  if (account.status !== "success" || !account.credentials) return null;
  const creds = account.credentials as Record<string, unknown>;

  const apiKey = typeof creds.apiKey === "string" && creds.apiKey ? creds.apiKey : undefined;
  const accessToken =
    typeof creds.accessToken === "string" && creds.accessToken
      ? creds.accessToken
      : typeof creds.bearer === "string" && creds.bearer && !creds.bearer.startsWith("sk-")
        ? creds.bearer
        : undefined;
  const refreshToken =
    typeof creds.refreshToken === "string" && creds.refreshToken ? creds.refreshToken : undefined;
  const sessionToken =
    typeof creds.sessionToken === "string" && creds.sessionToken ? creds.sessionToken : undefined;
  const cookie = typeof creds.cookie === "string" && creds.cookie ? creds.cookie : undefined;

  const authType =
    typeof creds.authType === "string"
      ? creds.authType
      : apiKey
        ? "api_key"
        : accessToken
          ? "bearer_token"
          : "cookie_session";

  const primarySecret =
    typeof creds.primarySecret === "string" && creds.primarySecret
      ? creds.primarySecret
      : (apiKey ?? accessToken ?? sessionToken ?? cookie ?? "");

  if (!primarySecret) return null;

  const origin =
    typeof creds.origin === "string"
      ? creds.origin
      : typeof creds.startUrl === "string"
        ? creds.startUrl
        : undefined;

  const apiBaseUrl =
    typeof creds.apiBaseUrl === "string"
      ? creds.apiBaseUrl
      : origin
        ? `${origin.replace(/\/$/, "")}/v1`
        : undefined;

  const readyHeaders: Record<string, string> =
    creds.readyHeaders && typeof creds.readyHeaders === "object"
      ? { ...(creds.readyHeaders as Record<string, string>) }
      : {
          ...(apiKey
            ? { Authorization: `Bearer ${apiKey}` }
            : accessToken
              ? { Authorization: `Bearer ${accessToken}` }
              : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        };

  return {
    platformId: account.platformId,
    email: account.email,
    password: account.password,
    authType,
    primarySecret,
    ...(apiKey ? { apiKey } : {}),
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(sessionToken ? { sessionToken } : {}),
    ...(typeof creds.userId === "string" ? { userId: creds.userId } : {}),
    ...(typeof creds.username === "string" ? { username: creds.username } : {}),
    ...(typeof creds.quota === "number" ? { quota: creds.quota } : {}),
    ...(origin ? { origin } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    readyHeaders,
    ...(cookie ? { cookie } : {}),
    quality: typeof creds.quality === "string" ? creds.quality : apiKey || accessToken ? "high" : "medium",
    updatedAt: account.updatedAt,
  };
}

/**
 * Build a grouped 2API credential bundle from registered accounts.
 */
export function build2ApiCredentialBundle(accounts: RegisteredAccount[]): Exported2ApiBundle {
  const platforms: Exported2ApiBundle["platforms"] = {};
  let totalAccounts = 0;
  let totalApiKeys = 0;
  let totalBearerTokens = 0;

  for (const acct of accounts) {
    const normalized = normalizeAccountFor2Api(acct);
    if (!normalized) continue;
    totalAccounts++;
    if (normalized.apiKey) totalApiKeys++;
    if (normalized.accessToken) totalBearerTokens++;

    const group =
      platforms[normalized.platformId] ??
      (platforms[normalized.platformId] = {
        platformId: normalized.platformId,
        apiBaseUrl: normalized.apiBaseUrl,
        origin: normalized.origin,
        count: 0,
        apiKeys: [],
        bearerTokens: [],
        accounts: [],
      });

    group.count++;
    if (!group.apiBaseUrl && normalized.apiBaseUrl) group.apiBaseUrl = normalized.apiBaseUrl;
    if (!group.origin && normalized.origin) group.origin = normalized.origin;
    if (normalized.apiKey && !group.apiKeys.includes(normalized.apiKey)) {
      group.apiKeys.push(normalized.apiKey);
    }
    const bearerOrKey = normalized.apiKey ?? normalized.accessToken;
    if (bearerOrKey && !group.bearerTokens.includes(bearerOrKey)) {
      group.bearerTokens.push(bearerOrKey);
    }
    group.accounts.push(normalized);
  }

  return {
    version: 1,
    exportedAt: nowIso(),
    totalAccounts,
    totalApiKeys,
    totalBearerTokens,
    platforms,
  };
}

/**
 * Format credentials into the requested string representation (`json`, `keys`, `jsonl`, or `env`).
 */
export function formatCredentialsFor2Api(
  accounts: RegisteredAccount[],
  format: CredentialExportFormat = "json",
): string {
  const bundle = build2ApiCredentialBundle(accounts);
  const allNormalized = Object.values(bundle.platforms).flatMap((p) => p.accounts);

  switch (format) {
    case "keys": {
      const lines = allNormalized.map((a) => a.apiKey ?? a.accessToken ?? a.primarySecret);
      return lines.join("\n");
    }
    case "jsonl": {
      return allNormalized.map((a) => JSON.stringify(a)).join("\n");
    }
    case "env": {
      const lines: string[] = [];
      for (const [platformId, group] of Object.entries(bundle.platforms)) {
        const prefix = platformId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
        if (group.apiBaseUrl) {
          lines.push(`${prefix}_API_BASE=${group.apiBaseUrl}`);
        }
        if (group.apiKeys.length > 0) {
          lines.push(`${prefix}_API_KEYS=${group.apiKeys.join(",")}`);
        }
        const secrets = group.accounts.map((a) => a.primarySecret);
        lines.push(`${prefix}_SECRETS=${secrets.join(",")}`);
      }
      return lines.join("\n");
    }
    case "json":
    default:
      return JSON.stringify(bundle, null, 2);
  }
}

/**
 * Save 2API credentials bundle or formatted file to disk.
 */
export function saveCredentialsFor2Api(
  accounts: RegisteredAccount[],
  filePath: string,
  format: CredentialExportFormat = "json",
): { filePath: string; bundle: Exported2ApiBundle } {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const bundle = build2ApiCredentialBundle(accounts);
  const content = formatCredentialsFor2Api(accounts, format);
  writeFileSync(filePath, content, "utf-8");
  return { filePath, bundle };
}
