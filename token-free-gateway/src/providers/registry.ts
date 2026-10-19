/**
 * Provider registry: maps provider IDs and model names to WebProviderClient factories.
 * All 13 Web AI providers are registered here with their model catalogs.
 */

import {
	getAccountPool,
	getCredentials,
	markAccountCooldown,
	markAccountSuccess,
	selectAccount,
} from "./auth-store.ts";
import { loadCustomProviderDefinitions } from "./generic/index.ts";
import type { ModelInfo, ProviderDefinition, WebProviderClient } from "./types.ts";

// Lazy-loaded provider definitions to avoid importing all providers at startup
let _builtinDefinitions: ProviderDefinition[] | null = null;

async function loadBuiltinDefinitions(): Promise<ProviderDefinition[]> {
	if (_builtinDefinitions) return _builtinDefinitions;

	const [
		claude,
		chatgpt,
		deepseek,
		doubao,
		gemini,
		glm,
		glmIntl,
		grok,
		kimi,
		perplexity,
		qwen,
		qwenCn,
		xiaomimo,
	] = await Promise.all([
		import("./claude/index.ts"),
		import("./chatgpt/index.ts"),
		import("./deepseek/index.ts"),
		import("./doubao/index.ts"),
		import("./gemini/index.ts"),
		import("./glm/index.ts"),
		import("./glm-intl/index.ts"),
		import("./grok/index.ts"),
		import("./kimi/index.ts"),
		import("./perplexity/index.ts"),
		import("./qwen/index.ts"),
		import("./qwen-cn/index.ts"),
		import("./xiaomimo/index.ts"),
	]);

	_builtinDefinitions = [
		claude.definition,
		chatgpt.definition,
		deepseek.definition,
		doubao.definition,
		gemini.definition,
		glm.definition,
		glmIntl.definition,
		grok.definition,
		kimi.definition,
		perplexity.definition,
		qwen.definition,
		qwenCn.definition,
		xiaomimo.definition,
	];
	return _builtinDefinitions;
}

async function loadDefinitions(): Promise<ProviderDefinition[]> {
	const builtins = await loadBuiltinDefinitions();
	const builtinIds = new Set(builtins.map((d) => d.id));
	const custom = loadCustomProviderDefinitions(builtinIds);
	const merged = new Map<string, ProviderDefinition>();
	for (const d of builtins) merged.set(d.id, d);
	for (const d of custom) merged.set(d.id, d);
	return [...merged.values()];
}

const clientCache = new Map<string, WebProviderClient>();
const clientAccountMap = new Map<WebProviderClient, { providerId: string; accountId: string }>();

/**
 * Evict a cached provider client so the next `getProviderClient` call
 * re-reads credentials from disk and creates a fresh instance.
 * Called automatically when a SessionExpiredError is thrown.
 */
export function evictProviderClient(providerId: string, accountId?: string): void {
	for (const [cacheKey, client] of clientCache.entries()) {
		if (
			cacheKey === providerId ||
			(accountId
				? cacheKey === `${providerId}::${accountId}`
				: cacheKey.startsWith(`${providerId}::`))
		) {
			client.close?.().catch(() => {});
			clientCache.delete(cacheKey);
			clientAccountMap.delete(client);
		}
	}
	console.log(
		`[registry] Evicted cached client for "${providerId}"${accountId ? ` (account=${accountId})` : ""}`,
	);
}

/**
 * Mark the account bound to a client as failed/cooling down and evict its cached instance.
 * Returns true if the provider has additional accounts in the pool to fail over to.
 */
export function failoverClientAccount(client: WebProviderClient, cooldownMs = 60_000): boolean {
	const meta = clientAccountMap.get(client);
	const providerId = meta?.providerId ?? client.providerId;
	const accountId = meta?.accountId ?? "default";
	markAccountCooldown(providerId, accountId, cooldownMs);
	evictProviderClient(providerId, accountId);
	const pool = getAccountPool(providerId);
	return pool.length > 1;
}

export function reportClientSuccess(client: WebProviderClient): void {
	const meta = clientAccountMap.get(client);
	if (meta) {
		markAccountSuccess(meta.providerId, meta.accountId);
	}
}

function findDefinition(
	defs: ProviderDefinition[],
	idOrAlias: string,
): ProviderDefinition | undefined {
	const direct = defs.find((d) => d.id === idOrAlias);
	if (direct) return direct;
	if (idOrAlias.endsWith("-web")) {
		const stripped = idOrAlias.slice(0, -4);
		return defs.find((d) => d.id === stripped);
	}
	return defs.find((d) => d.id === `${idOrAlias}-web`);
}

/**
 * Get or create a provider client for the given provider ID.
 * Uses Round-Robin across the provider's multi-account pool when multiple accounts exist.
 * Returns null if no credentials are stored for this provider.
 */
export async function getProviderClient(providerId: string): Promise<WebProviderClient | null> {
	const defs = await loadDefinitions();
	const def = findDefinition(defs, providerId);
	if (!def) return null;

	const selected = selectAccount(def.id);
	if (!selected) return null;

	const cacheKey = `${def.id}::${selected.accountId}`;
	if (clientCache.has(cacheKey)) {
		return clientCache.get(cacheKey)!;
	}

	const client = def.factory(selected.credentials);
	await client.init();
	clientCache.set(cacheKey, client);
	clientAccountMap.set(client, { providerId: def.id, accountId: selected.accountId });
	return client;
}

/**
 * Resolve a model name to a provider ID.
 * Supports:
 * - direct model IDs ("claude-sonnet-4-6")
 * - prefixed format ("claude-web/claude-sonnet-4-6" or "claude/claude-sonnet-4-6")
 * - direct provider/channel ID ("my-custom-channel" or "deepseek")
 */
export async function resolveModelToProvider(model: string): Promise<string | null> {
	const defs = await loadDefinitions();

	// Check prefixed format: "provider-id/model-id"
	if (model.includes("/")) {
		const prefix = model.split("/")[0]!;
		const matched = findDefinition(defs, prefix);
		if (matched) return matched.id;
	}

	// Search all providers for matching model ID
	for (const def of defs) {
		if (def.models.some((m) => m.id === model)) return def.id;
	}

	// Fallback: allow passing the provider/channel ID directly as the model name
	const byProviderId = findDefinition(defs, model);
	if (byProviderId) return byProviderId.id;

	return null;
}

/**
 * Get the client for a specific model name.
 */
export async function getClientForModel(model: string): Promise<WebProviderClient | null> {
	const providerId = await resolveModelToProvider(model);
	if (!providerId) return null;
	return getProviderClient(providerId);
}

/**
 * List all models from all authenticated providers.
 */
export async function listAllModels(): Promise<ModelInfo[]> {
	const defs = await loadDefinitions();
	const models: ModelInfo[] = [];
	for (const def of defs) {
		const creds = getCredentials(def.id);
		if (!creds) continue;
		models.push(...def.models);
	}
	return models;
}

/**
 * List all provider definitions (for webauth wizard).
 */
export async function listProviderDefinitions(): Promise<ProviderDefinition[]> {
	return loadDefinitions();
}

/**
 * Clear a cached provider client (e.g. after re-authentication).
 */
export function clearProviderCache(providerId: string): void {
	evictProviderClient(providerId);
}

const SESSION_CHECK_TIMEOUT_MS = 10_000;

/**
 * Check session status for all cached provider clients that support it.
 * Each check is guarded by a 10 s timeout so /health never hangs.
 */
export async function checkAllSessions(): Promise<
	Record<string, { valid: boolean; reason?: string }>
> {
	const results: Record<string, { valid: boolean; reason?: string }> = {};
	const entries = [...clientCache.entries()];
	await Promise.all(
		entries.map(async ([id, client]) => {
			if (!client.checkSession) {
				results[id] = { valid: true, reason: "unchecked" };
				return;
			}
			try {
				const race = Promise.race([
					client.checkSession(),
					new Promise<{ valid: false; reason: string }>((resolve) =>
						setTimeout(
							() => resolve({ valid: false, reason: "session check timed out" }),
							SESSION_CHECK_TIMEOUT_MS,
						),
					),
				]);
				results[id] = await race;
			} catch (err) {
				results[id] = { valid: false, reason: err instanceof Error ? err.message : String(err) };
			}
		}),
	);
	return results;
}
