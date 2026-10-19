/**
 * Generic / dynamic Web AI Provider for token-free-gateway.
 *
 * Enables zero-config or JSON-configured onboarding of any new web AI channel:
 * 1. Drop a JSON file in ~/.token-free-gateway/providers/<id>.json (or TFG_PROVIDERS_DIR), OR
 * 2. Register/capture any site with `universal-registrar` — credentials stored in
 *    `auth-profiles.json` with `startUrl` / `signupUrl` / `domains` are automatically
 *    discovered and mounted as OpenAI-compatible models (`<id>` and `<id>/default`).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { pasteText } from "../../browser/dom-input.ts";
import { BrowserManager } from "../../browser/manager.ts";
import { loadAuthStore } from "../auth-store.ts";
import { BaseDomClient } from "../factory/base-dom-client.ts";
import type { DomClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { parseGeminiStream } from "../gemini/stream.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import { ensurePage } from "../shared/page-lifecycle.ts";
import type { ModelInfo, ProviderDefinition, StreamResult } from "../types.ts";

export interface GenericProviderSelectors {
	newChat?: string[];
	input?: string[];
	submit?: string[];
	response?: string[];
}

export interface GenericProviderConfig {
	id: string;
	name?: string;
	startUrl: string;
	cookieDomain?: string;
	hostKey?: string;
	models?: ModelInfo[];
	selectors?: GenericProviderSelectors;
	pollIntervalMs?: number;
	maxWaitMs?: number;
	stabilityThreshold?: number;
}

export interface GenericWebAuth {
	cookie?: string;
	userAgent?: string;
	email?: string;
	startUrl?: string;
	signupUrl?: string;
	cookieDomain?: string;
	domains?: string[];
	providerName?: string;
	models?: ModelInfo[];
	chatSelectors?: GenericProviderSelectors;
	localStorage?: Record<string, string>;
}

const DEFAULT_INPUT_SELECTORS = [
	"textarea:not([disabled]):not([readonly])",
	'div[contenteditable="true"]',
	'[role="textbox"]',
	'input[type="text"]:not([disabled])',
];

const DEFAULT_SUBMIT_SELECTORS = [
	'button[type="submit"]:not([disabled])',
	'button[aria-label*="Send" i]:not([disabled])',
	'button[aria-label*="发送"]:not([disabled])',
	'button[data-testid*="send" i]:not([disabled])',
	'button:has-text("Send"):not([disabled])',
	'button:has-text("发送"):not([disabled])',
];

const DEFAULT_RESPONSE_SELECTORS = [
	'[data-message-author-role="assistant"]',
	'[data-role="assistant"]',
	'[class*="assistant-message" i]',
	'[class*="bot-message" i]',
	'[class*="ai-message" i]',
	'[class*="message-content" i]',
	'[class*="markdown-body" i]',
	'[class*="markdown" i]',
	'[class*="prose" i]',
	"article",
];

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseHostFromUrl(rawUrl: string): {
	origin: string;
	hostname: string;
	rootDomain: string;
} {
	const withProto = /^https?:\/\//i.test(rawUrl.trim())
		? rawUrl.trim()
		: `https://${rawUrl.trim()}`;
	const u = new URL(withProto);
	const hostname = u.hostname.toLowerCase();
	const parts = hostname.split(".").filter(Boolean);
	const rootDomain = parts.length >= 2 ? parts.slice(-2).join(".") : hostname;
	return { origin: u.origin, hostname, rootDomain };
}

export class GenericDomClient extends BaseDomClient<GenericWebAuth> {
	readonly providerId: string;
	protected readonly config: DomClientConfig;
	private readonly selectors: GenericProviderSelectors;

	constructor(cfg: GenericProviderConfig, auth: GenericWebAuth) {
		super(auth);
		this.providerId = cfg.id;
		const effectiveUrl =
			cfg.startUrl || auth?.startUrl || auth?.signupUrl || `https://${cfg.id}.com`;
		const parsed = parseHostFromUrl(effectiveUrl);
		const models =
			cfg.models && cfg.models.length > 0
				? cfg.models
				: auth?.models && auth.models.length > 0
					? auth.models
					: [
							{ id: cfg.id, name: cfg.name || auth?.providerName || cfg.id },
							{ id: `${cfg.id}-default`, name: `${cfg.name || cfg.id} (Default)` },
						];
		this.config = {
			hostKey: cfg.hostKey || parsed.hostname,
			startUrl: effectiveUrl,
			cookieDomain: cfg.cookieDomain || auth?.cookieDomain || `.${parsed.rootDomain}`,
			models,
			pollIntervalMs: cfg.pollIntervalMs ?? 2000,
			maxWaitMs: cfg.maxWaitMs ?? 120_000,
			stabilityThreshold: cfg.stabilityThreshold ?? 2,
		};
		this.selectors = {
			...auth?.chatSelectors,
			...cfg.selectors,
		};
	}

	protected getCookies() {
		return parseCookieHeader(this.auth?.cookie ?? "", this.config.cookieDomain);
	}

	protected override async getPage(): Promise<Page> {
		this.page = await ensurePage(this.page, {
			hostKey: this.config.hostKey,
			startUrl: this.config.startUrl,
			cookies: this.getCookies(),
			localStorage: this.auth?.localStorage,
		});
		return this.page;
	}

	protected async sendViaDom(page: Page, params: NormalizedSendParams): Promise<string> {
		if (this.selectors.newChat?.length) {
			for (const sel of this.selectors.newChat) {
				const btn = await page.$(sel);
				if (btn) {
					await btn.click().catch(() => {});
					await delay(1000);
					break;
				}
			}
		}

		const responseSels = this.selectors.response?.length
			? this.selectors.response
			: DEFAULT_RESPONSE_SELECTORS;

		const baseline = await page
			.evaluate((sels) => {
				const clean = (t: string) => t.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
				for (const sel of sels) {
					const els = document.querySelectorAll(sel);
					if (els.length > 0) {
						const lastText = clean((els[els.length - 1] as HTMLElement).innerText ?? "");
						return { count: els.length, lastText };
					}
				}
				return { count: 0, lastText: "" };
			}, responseSels)
			.catch(() => ({ count: 0, lastText: "" }));

		const inputSels = this.selectors.input?.length ? this.selectors.input : DEFAULT_INPUT_SELECTORS;
		let inputHandle = null;
		for (const sel of inputSels) {
			const handle = await page.$(sel);
			if (handle && (await handle.isVisible().catch(() => true))) {
				inputHandle = handle;
				break;
			}
		}
		if (!inputHandle) {
			throw new Error(`${this.providerId}: chat input element not found on ${page.url()}`);
		}

		await inputHandle.click().catch(() => {});
		await delay(200);
		await pasteText(page, params.message, inputHandle);
		await delay(250);

		let submitted = false;
		if (this.selectors.submit?.length) {
			for (const sel of this.selectors.submit) {
				const btn = await page.$(sel);
				if (btn && (await btn.isVisible().catch(() => true))) {
					await btn.click().catch(() => {});
					submitted = true;
					break;
				}
			}
		}
		if (!submitted) {
			await page.keyboard.press("Enter").catch(() => {});
			await delay(200);
			for (const sel of DEFAULT_SUBMIT_SELECTORS) {
				const btn = await page.$(sel);
				if (btn && (await btn.isVisible().catch(() => false))) {
					await btn.click().catch(() => {});
					break;
				}
			}
		}

		await delay(1000);

		return this.pollForStableText(async () => {
			return page.evaluate(
				({ sels, baseCount, baseLastText, promptSnippet }) => {
					const clean = (t: string) => t.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
					for (const sel of sels) {
						const els = document.querySelectorAll(sel);
						for (let i = els.length - 1; i >= 0; i--) {
							const t = clean((els[i] as HTMLElement).innerText ?? "");
							if (!t || t.length < 2) continue;
							if (promptSnippet && t === promptSnippet) continue;
							if (els.length > baseCount || t !== baseLastText) {
								return t;
							}
						}
					}
					return "";
				},
				{
					sels: responseSels,
					baseCount: baseline.count,
					baseLastText: baseline.lastText,
					promptSnippet: params.message.trim(),
				},
			);
		}, params.signal);
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseGeminiStream(body, onDelta);
	}
}

export function createGenericProviderDefinition(cfg: GenericProviderConfig): ProviderDefinition {
	const parsed = parseHostFromUrl(cfg.startUrl);
	const name = cfg.name || `${cfg.id} (${parsed.hostname})`;
	const models: ModelInfo[] =
		cfg.models && cfg.models.length > 0
			? cfg.models
			: [
					{ id: cfg.id, name },
					{ id: `${cfg.id}-default`, name: `${name} Default` },
				];

	return {
		id: cfg.id,
		name,
		models,
		factory: (credentials) => new GenericDomClient(cfg, (credentials ?? {}) as GenericWebAuth),
		loginFn: async ({ onProgress, openUrl }) => {
			const bm = BrowserManager.getInstance();
			const ctx = await bm.getContext();
			const page = await ctx.newPage();
			await openUrl(cfg.startUrl);
			await page.goto(cfg.startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
			onProgress(`Please log in at ${cfg.startUrl} in the browser window...`);
			const deadline = Date.now() + 300_000;
			while (Date.now() < deadline) {
				const cookies = await ctx.cookies([parsed.origin]);
				if (cookies.length > 0) {
					const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
					return {
						cookie: cookieStr,
						startUrl: cfg.startUrl,
						cookieDomain: cfg.cookieDomain || `.${parsed.rootDomain}`,
						providerName: name,
					};
				}
				await delay(2000);
			}
			throw new Error(`Login timed out for ${cfg.id}`);
		},
	};
}

export function loadCustomProviderDefinitions(builtinIds: Set<string>): ProviderDefinition[] {
	const defs = new Map<string, ProviderDefinition>();

	const dirs = [
		process.env.TFG_PROVIDERS_DIR,
		join(homedir(), ".token-free-gateway", "providers"),
		join(process.cwd(), "config", "providers"),
	].filter((d): d is string => Boolean(d));

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".json")) continue;
			try {
				const raw = readFileSync(join(dir, file), "utf-8");
				const cfg = JSON.parse(raw) as GenericProviderConfig;
				if (!cfg.id || !cfg.startUrl) continue;
				defs.set(cfg.id, createGenericProviderDefinition(cfg));
			} catch (err) {
				console.warn(`[generic-provider] Failed to load ${file}:`, err);
			}
		}
	}

	const store = loadAuthStore();
	for (const [profileKey, profile] of Object.entries(store.profiles)) {
		if (builtinIds.has(profileKey) || builtinIds.has(`${profileKey}-web`) || defs.has(profileKey)) {
			continue;
		}
		const creds = (profile.credentials ?? {}) as GenericWebAuth;
		const inferredUrl =
			creds.startUrl ||
			creds.signupUrl ||
			(creds.domains?.[0] ? `https://${creds.domains[0].replace(/^\./, "")}` : undefined) ||
			(creds.cookieDomain ? `https://${creds.cookieDomain.replace(/^\./, "")}` : undefined) ||
			(profileKey.includes(".") ? `https://${profileKey}` : undefined);

		if (!inferredUrl) continue;

		try {
			const def = createGenericProviderDefinition({
				id: profileKey,
				name: creds.providerName || profileKey,
				startUrl: inferredUrl,
				cookieDomain: creds.cookieDomain,
				models: creds.models,
				selectors: creds.chatSelectors,
			});
			defs.set(profileKey, def);
		} catch {
			// Ignore invalid URL in profile
		}
	}

	return [...defs.values()];
}
