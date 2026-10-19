/**
 * Export captured credentials into token-free-gateway's auth-profiles.json
 * so `token-free-gateway start` can use them immediately.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface TfgAccountEntry {
  id: string;
  email?: string;
  credentials: unknown;
  updatedAt: string;
}

export interface TfgAuthProfile {
  providerId: string;
  credentials: unknown;
  updatedAt: string;
  accounts?: TfgAccountEntry[];
}

export interface TfgAuthStore {
  profiles: Record<string, TfgAuthProfile>;
}

const DEFAULT_TFG_PATH = join(homedir(), ".token-free-gateway", "auth-profiles.json");

export function getTfgStorePath(override?: string): string {
  return override || process.env.TFG_STORE_PATH || DEFAULT_TFG_PATH;
}

export function loadTfgStore(path = getTfgStorePath()): TfgAuthStore {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8")) as TfgAuthStore;
    }
  } catch (e) {
    console.warn(`[tfg-export] failed to load ${path}:`, e);
  }
  return { profiles: {} };
}

export function saveTfgStore(store: TfgAuthStore, path = getTfgStorePath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), "utf-8");
}

function deriveAccountId(credentials: unknown, indexHint: number): { id: string; email?: string } {
  if (credentials && typeof credentials === "object") {
    const rec = credentials as Record<string, unknown>;
    const email = typeof rec.email === "string" && rec.email.trim() ? rec.email.trim() : undefined;
    if (email) return { id: email, email };
    if (typeof rec.accountId === "string" && rec.accountId.trim()) {
      return { id: rec.accountId.trim() };
    }
    if (typeof rec.cookie === "string" && rec.cookie.trim()) {
      const clean = rec.cookie.replace(/\s+/g, "");
      let hash = 0;
      for (let i = 0; i < clean.length; i++) {
        hash = (hash * 31 + clean.charCodeAt(i)) | 0;
      }
      return { id: `cookie-${Math.abs(hash).toString(36)}` };
    }
  }
  return { id: `acct-${indexHint}` };
}

/**
 * Merge one provider's credentials into the TFG store.
 * `providerId` should match token-free-gateway ids:
 * claude, chatgpt, deepseek, doubao, gemini, glm, glm-intl, grok, kimi,
 * perplexity, qwen, qwen-cn, xiaomimo
 */
export function exportToTokenFreeGateway(
  providerId: string,
  credentials: unknown,
  storePath?: string,
): void {
  const path = getTfgStorePath(storePath);
  const store = loadTfgStore(path);
  const now = new Date().toISOString();
  const existing = store.profiles[providerId];
  const accounts: TfgAccountEntry[] = Array.isArray(existing?.accounts)
    ? [...existing.accounts]
    : existing?.credentials
      ? [
          {
            ...deriveAccountId(existing.credentials, 1),
            credentials: existing.credentials,
            updatedAt: existing.updatedAt || now,
          },
        ]
      : [];

  const { id, email } = deriveAccountId(credentials, accounts.length + 1);
  const idx = accounts.findIndex((a) => a.id === id || (email && a.email === email));
  const entry: TfgAccountEntry = { id, ...(email ? { email } : {}), credentials, updatedAt: now };
  if (idx >= 0) {
    accounts[idx] = entry;
  } else {
    accounts.push(entry);
  }

  store.profiles[providerId] = {
    providerId,
    credentials,
    updatedAt: now,
    accounts,
  };
  saveTfgStore(store, path);
}

/** Re-export all successful accounts that already have credentials. */
export function exportAllFromRegistrar(
  accounts: Array<{ platformId: string; credentials?: Record<string, unknown>; status: string }>,
  storePath?: string,
): number {
  let n = 0;
  for (const a of accounts) {
    if (a.status === "success" && a.credentials) {
      exportToTokenFreeGateway(a.platformId, a.credentials, storePath);
      n++;
    }
  }
  return n;
}
