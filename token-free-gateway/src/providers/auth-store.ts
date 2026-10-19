/**
 * Persistent credential store for web AI providers.
 * Stores auth profiles in <homedir>/.token-free-gateway/auth-profiles.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AuthAccountEntry {
	id: string;
	email?: string;
	credentials: unknown;
	updatedAt: string;
	disabled?: boolean;
	cooldownUntil?: number;
	failCount?: number;
}

export interface AuthProfile {
	providerId: string;
	credentials: unknown;
	updatedAt: string;
	accounts?: AuthAccountEntry[];
}

export interface AuthStore {
	profiles: Record<string, AuthProfile>;
}

const DEFAULT_STORE_PATH = join(homedir(), ".token-free-gateway", "auth-profiles.json");

// Round-robin cursor per provider
const rrCursor = new Map<string, number>();
// In-memory runtime cooldown state (accountKey = `${providerId}::${accountId}`)
const runtimeCooldowns = new Map<string, { cooldownUntil: number; failCount: number }>();

/** Returns the active store path. Override with TFG_STORE_PATH (used in tests). */
export function getStorePath(): string {
	return process.env.TFG_STORE_PATH ?? DEFAULT_STORE_PATH;
}

function ensureStoreDir(storePath: string): void {
	const dir = dirname(storePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

export function resolveProfileKey(store: AuthStore, providerId: string): string | null {
	if (store.profiles[providerId]) return providerId;
	if (providerId.endsWith("-web")) {
		const stripped = providerId.slice(0, -4);
		if (store.profiles[stripped]) return stripped;
	} else if (store.profiles[`${providerId}-web`]) {
		return `${providerId}-web`;
	}
	return null;
}

function deriveAccountIdentity(credentials: unknown): {
	id?: string;
	email?: string;
	hasExplicitIdentity: boolean;
} {
	if (credentials && typeof credentials === "object") {
		const rec = credentials as Record<string, unknown>;
		if (typeof rec.accountId === "string" && rec.accountId.trim()) {
			return {
				id: rec.accountId.trim(),
				email: typeof rec.email === "string" ? rec.email.trim() : undefined,
				hasExplicitIdentity: true,
			};
		}
		if (typeof rec.email === "string" && rec.email.trim()) {
			return {
				id: rec.email.trim(),
				email: rec.email.trim(),
				hasExplicitIdentity: true,
			};
		}
	}
	return { hasExplicitIdentity: false };
}

export function loadAuthStore(): AuthStore {
	const storePath = getStorePath();
	try {
		if (existsSync(storePath)) {
			const raw = readFileSync(storePath, "utf-8");
			return JSON.parse(raw) as AuthStore;
		}
	} catch (e) {
		console.warn(`[auth-store] Failed to load ${storePath}: ${e}`);
	}
	return { profiles: {} };
}

export function saveAuthStore(store: AuthStore): void {
	const storePath = getStorePath();
	ensureStoreDir(storePath);
	writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
}

export function getCredentials<T = unknown>(providerId: string): T | null {
	const selected = selectAccount<T>(providerId);
	return selected ? selected.credentials : null;
}

export function getAccountPool(providerId: string): AuthAccountEntry[] {
	const store = loadAuthStore();
	const key = resolveProfileKey(store, providerId);
	if (!key) return [];
	const profile = store.profiles[key];
	if (!profile) return [];

	if (Array.isArray(profile.accounts) && profile.accounts.length > 0) {
		return profile.accounts.filter((a) => !a.disabled && a.credentials != null);
	}
	if (profile.credentials != null) {
		const ident = deriveAccountIdentity(profile.credentials);
		return [
			{
				id: ident.id ?? "default",
				email: ident.email,
				credentials: profile.credentials,
				updatedAt: profile.updatedAt,
			},
		];
	}
	return [];
}

/**
 * Select the next healthy account from the provider's account pool via Round-Robin.
 */
export function selectAccount<T = unknown>(
	providerId: string,
): { accountId: string; credentials: T; poolSize: number } | null {
	const pool = getAccountPool(providerId);
	if (pool.length === 0) return null;

	const now = Date.now();
	const startIdx = rrCursor.get(providerId) ?? 0;

	for (let offset = 0; offset < pool.length; offset++) {
		const idx = (startIdx + offset) % pool.length;
		const entry = pool[idx]!;
		const cdKey = `${providerId}::${entry.id}`;
		const rtCd = runtimeCooldowns.get(cdKey)?.cooldownUntil ?? 0;
		const persistedCd = entry.cooldownUntil ?? 0;
		if (Math.max(rtCd, persistedCd) <= now) {
			rrCursor.set(providerId, (idx + 1) % pool.length);
			return {
				accountId: entry.id,
				credentials: entry.credentials as T,
				poolSize: pool.length,
			};
		}
	}

	// All accounts are in cooldown: fall back to the one whose cooldown expires earliest
	let earliest = pool[0]!;
	let earliestTime = Number.POSITIVE_INFINITY;
	for (const entry of pool) {
		const cdKey = `${providerId}::${entry.id}`;
		const until = Math.max(
			runtimeCooldowns.get(cdKey)?.cooldownUntil ?? 0,
			entry.cooldownUntil ?? 0,
		);
		if (until < earliestTime) {
			earliestTime = until;
			earliest = entry;
		}
	}
	return {
		accountId: earliest.id,
		credentials: earliest.credentials as T,
		poolSize: pool.length,
	};
}

export function markAccountCooldown(
	providerId: string,
	accountId: string,
	cooldownMs = 60_000,
): void {
	const cdKey = `${providerId}::${accountId}`;
	const prev = runtimeCooldowns.get(cdKey);
	runtimeCooldowns.set(cdKey, {
		cooldownUntil: Date.now() + cooldownMs,
		failCount: (prev?.failCount ?? 0) + 1,
	});
}

export function markAccountSuccess(providerId: string, accountId: string): void {
	const cdKey = `${providerId}::${accountId}`;
	runtimeCooldowns.delete(cdKey);
}

export function clearAccountCooldowns(): void {
	runtimeCooldowns.clear();
	rrCursor.clear();
}

export function saveCredentials(
	providerId: string,
	credentials: unknown,
	options?: { accountId?: string; append?: boolean },
): void {
	const store = loadAuthStore();
	const now = new Date().toISOString();
	const existing = store.profiles[providerId];
	const ident = deriveAccountIdentity(credentials);
	const explicitId = options?.accountId ?? ident.id;

	let accounts: AuthAccountEntry[] = [];
	if (existing) {
		if (Array.isArray(existing.accounts) && existing.accounts.length > 0) {
			accounts = [...existing.accounts];
		} else if (existing.credentials != null) {
			const prevIdent = deriveAccountIdentity(existing.credentials);
			accounts = [
				{
					id: prevIdent.id ?? "default",
					...(prevIdent.email ? { email: prevIdent.email } : {}),
					credentials: existing.credentials,
					updatedAt: existing.updatedAt || now,
				},
			];
		}
	}

	if (explicitId || options?.append) {
		const targetId = explicitId ?? `acct-${accounts.length + 1}`;
		const idx = accounts.findIndex(
			(a) => a.id === targetId || (ident.email && a.email === ident.email),
		);
		const entry: AuthAccountEntry = {
			id: targetId,
			...(ident.email ? { email: ident.email } : {}),
			credentials,
			updatedAt: now,
		};
		if (idx >= 0) {
			accounts[idx] = entry;
		} else {
			accounts.push(entry);
		}
	} else {
		// Single-account overwrite semantics when no accountId/email is specified
		accounts = [
			{
				id: "default",
				credentials,
				updatedAt: now,
			},
		];
	}

	store.profiles[providerId] = {
		providerId,
		credentials,
		updatedAt: now,
		accounts,
	};
	saveAuthStore(store);
}

export function listAuthorizedProviders(): string[] {
	const store = loadAuthStore();
	return Object.keys(store.profiles);
}
