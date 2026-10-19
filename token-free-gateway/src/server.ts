import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { authenticate } from "./auth.ts";
import { BrowserManager } from "./browser/manager.ts";
import { loadConfig } from "./config.ts";
import { handleChatCompletions, setRouteTimeoutSec } from "./openai/chat-completions.ts";
import {
	getAccountPool,
	listAuthorizedProviders,
	loadAuthStore,
	saveAuthStore,
	saveCredentials,
} from "./providers/auth-store.ts";
import {
	checkAllSessions,
	evictProviderClient,
	getClientForModel,
	listAllModels,
	listProviderDefinitions,
	resolveModelToProvider,
} from "./providers/registry.ts";

const config = loadConfig();
setRouteTimeoutSec(config.requestTimeoutSec);

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function withCors(res: Response): Response {
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => {
		headers[k] = v;
	});
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers: { ...headers, ...CORS_HEADERS },
	});
}

async function handleRequest(req: Request): Promise<Response> {
	const { pathname } = new URL(req.url);

	if (req.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}

	// Health check is public — no auth required (load balancers, monitoring)
	if (pathname === "/health" || pathname === "/healthz") {
		return withCors(await handleHealthRoute());
	}

	// Built-in Web Console UI
	if ((pathname === "/" || pathname === "/ui") && req.method === "GET") {
		return handleUiRoute();
	}

	const registrarFiles: Record<string, string> = {
		"/registrar": "index.html",
		"/registrar/": "index.html",
		"/registrar/app.js": "app.js",
		"/registrar/report.js": "report.js",
		"/registrar/style.css": "style.css",
	};
	if (req.method === "GET" && Object.hasOwn(registrarFiles, pathname)) {
		return new Response(
			Bun.file(join(import.meta.dir, "public", "registrar", registrarFiles[pathname]!)),
			{
				headers: {
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff",
					"Referrer-Policy": "no-referrer",
					"Content-Security-Policy":
						"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
				},
			},
		);
	}

	const authError = authenticate(req, config.gatewayApiKey);
	if (authError) return withCors(authError);

	if (pathname === "/api/admin/channels") {
		return withCors(await handleAdminChannelsRoute(req));
	}

	if (pathname === "/v1/chat/completions" && req.method === "POST") {
		return withCors(await handleChatCompletionsRoute(req));
	}

	if (pathname === "/v1/models" && req.method === "GET") {
		return withCors(await handleModelsRoute());
	}

	if (pathname.startsWith("/v1/models/") && req.method === "GET") {
		const modelId = decodeURIComponent(pathname.slice("/v1/models/".length));
		return withCors(await handleModelByIdRoute(modelId));
	}

	return withCors(
		Response.json(
			{
				error: {
					message: `Unknown endpoint: ${req.method} ${pathname}`,
					type: "invalid_request_error",
				},
			},
			{ status: 404 },
		),
	);
}

// ── Route handlers ───────────────────────────────────────────

function handleUiRoute(): Response {
	const candidates = [
		join(import.meta.dir, "public", "index.html"),
		join(process.cwd(), "src", "public", "index.html"),
	];
	for (const p of candidates) {
		if (existsSync(p)) {
			return new Response(readFileSync(p, "utf-8"), {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		}
	}
	return new Response("<h1>Token-Free Gateway</h1>", {
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

async function handleAdminChannelsRoute(req: Request): Promise<Response> {
	if (req.method === "GET") {
		const defs = await listProviderDefinitions();
		const authorized = listAuthorizedProviders();
		const channels = authorized.map((id) => {
			const def =
				defs.find((d) => d.id === id) ??
				defs.find((d) => d.id === `${id}-web`) ??
				defs.find((d) => d.id.replace(/-web$/, "") === id);
			const accounts = getAccountPool(def?.id ?? id);
			return {
				id: def?.id ?? id,
				name: def?.name ?? id,
				models: def?.models ?? [{ id, name: id }],
				accounts: accounts.map((a) => ({
					id: a.id,
					email: a.email,
					updatedAt: a.updatedAt,
				})),
			};
		});
		return Response.json({ channels });
	}

	if (req.method === "POST") {
		let body: Record<string, unknown>;
		try {
			body = (await req.json()) as Record<string, unknown>;
		} catch {
			return Response.json({ error: { message: "Invalid JSON" } }, { status: 400 });
		}
		let rawProvider = String(body.providerId ?? "").trim();
		let startUrl = typeof body.startUrl === "string" ? body.startUrl.trim() : "";
		const cookie = typeof body.cookie === "string" ? body.cookie.trim() : "";
		const email = typeof body.email === "string" ? body.email.trim() : undefined;
		const bearer = typeof body.bearer === "string" ? body.bearer.trim() : undefined;

		if (!rawProvider || !cookie) {
			return Response.json(
				{ error: { message: "providerId and cookie are required" } },
				{ status: 400 },
			);
		}

		if (/^https?:\/\//i.test(rawProvider) || rawProvider.includes(".")) {
			const u = new URL(/^https?:\/\//i.test(rawProvider) ? rawProvider : `https://${rawProvider}`);
			if (!startUrl) startUrl = u.toString();
			const parts = u.hostname.split(".").filter(Boolean);
			rawProvider = (parts.length >= 2 ? parts[parts.length - 2]! : parts[0]!)
				.replace(/[^a-z0-9-_]/gi, "-")
				.toLowerCase();
		}

		const credentials: Record<string, unknown> = {
			cookie,
			capturedAt: new Date().toISOString(),
			...(email ? { email } : {}),
			...(startUrl ? { startUrl } : {}),
			...(bearer ? { bearer } : {}),
		};
		saveCredentials(rawProvider, credentials, {
			accountId: email || undefined,
			append: Boolean(email),
		});
		evictProviderClient(rawProvider);
		return Response.json({ ok: true, providerId: rawProvider });
	}

	if (req.method === "DELETE") {
		const body = (await req.json().catch(() => ({}))) as {
			providerId?: string;
			accountId?: string;
		};
		const store = loadAuthStore();
		const key =
			Object.keys(store.profiles).find(
				(k) =>
					k === body.providerId ||
					`${k}-web` === body.providerId ||
					k === body.providerId?.replace(/-web$/, ""),
			) ?? body.providerId;
		if (key && store.profiles[key]) {
			const prof = store.profiles[key]!;
			if (Array.isArray(prof.accounts) && body.accountId) {
				prof.accounts = prof.accounts.filter((a) => a.id !== body.accountId);
				if (prof.accounts.length === 0) {
					delete store.profiles[key];
				} else {
					prof.credentials = prof.accounts[prof.accounts.length - 1]!.credentials;
				}
			} else {
				delete store.profiles[key];
			}
			saveAuthStore(store);
			if (body.providerId) evictProviderClient(body.providerId);
		}
		return Response.json({ ok: true });
	}

	return Response.json({ error: { message: "Method not allowed" } }, { status: 405 });
}

async function handleHealthRoute(): Promise<Response> {
	const authorized = listAuthorizedProviders();
	const browserHealthy = await BrowserManager.getInstance().isHealthy();
	const sessions = await checkAllSessions();
	const hasExpired = Object.values(sessions).some((s) => !s.valid && s.reason !== "unchecked");
	const overallStatus = !browserHealthy ? "degraded" : hasExpired ? "session_expired" : "ok";
	return Response.json({
		status: overallStatus,
		browser: browserHealthy ? "connected" : "disconnected",
		providers: authorized.length,
		models: (await listAllModels()).length,
		sessions,
	});
}

async function handleChatCompletionsRoute(req: Request): Promise<Response> {
	let body: any;
	try {
		body = await req.json();
	} catch {
		return Response.json(
			{ error: { message: "Invalid JSON body", type: "invalid_request_error" } },
			{ status: 400 },
		);
	}

	const provider = await getClientForModel(body.model || "");
	if (!provider) {
		return Response.json(
			{
				error: {
					message: `No authorized provider found for model "${body.model || ""}". Run 'token-free-gateway webauth' to authorize providers.`,
					type: "invalid_request_error",
				},
			},
			{ status: 404 },
		);
	}

	return handleChatCompletions(body, provider);
}

async function handleModelsRoute(): Promise<Response> {
	const models = await listAllModels();
	const now = Math.floor(Date.now() / 1000);
	const data = await Promise.all(
		models.map(async (m) => ({
			id: m.id,
			object: "model" as const,
			created: now,
			owned_by: (await resolveModelToProvider(m.id)) ?? "web-provider",
		})),
	);
	return Response.json({ object: "list", data });
}

async function handleModelByIdRoute(modelId: string): Promise<Response> {
	const models = await listAllModels();
	const model = models.find((m) => m.id === modelId);
	if (!model) {
		return Response.json(
			{ error: { message: `Model '${modelId}' not found`, type: "invalid_request_error" } },
			{ status: 404 },
		);
	}
	return Response.json({
		id: model.id,
		object: "model",
		created: Math.floor(Date.now() / 1000),
		owned_by: (await resolveModelToProvider(model.id)) ?? "web-provider",
	});
}

// ── Server bootstrap ─────────────────────────────────────────

const server = Bun.serve({
	hostname: config.host,
	port: config.port,
	fetch: handleRequest,
	// Disable Bun's built-in idle timeout (default 10s).
	// Route-level timeouts are managed by handleChatCompletions via Promise.race.
	idleTimeout: 0,
});

const authorized = listAuthorizedProviders();
console.log(`Token-Free Gateway listening on http://${config.host}:${server.port}`);
console.log(`Auth: ${config.gatewayApiKey ? "enabled (Bearer token)" : "disabled"}`);
if (!config.gatewayApiKey && !["127.0.0.1", "localhost", "::1"].includes(config.host)) {
	console.warn(
		`WARNING: listening on ${config.host} without TFG_API_KEY — anyone on the network can use this gateway.`,
	);
}
console.log(`Request timeout: ${config.requestTimeoutSec}s`);
console.log(
	`Authorized providers: ${authorized.length > 0 ? authorized.join(", ") : "none — run 'token-free-gateway webauth' to authorize"}`,
);

async function gracefulShutdown(signal: string) {
	console.log(`\nReceived ${signal}, shutting down...`);
	await BrowserManager.getInstance().shutdown();
	server.stop(true);
	process.exit(0);
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

export { server };
