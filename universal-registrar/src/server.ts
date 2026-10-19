/**
 * Universal Registrar — HTTP API Server & Request Handler.
 *
 * Exposes all 5 stages of the registration pipeline over HTTP so the Web UI
 * (or any external frontend / 2API controller) can drive:
 *   1. External site discovery (`GET /api/registrar/sites`, `POST /api/registrar/discover`)
 *   2. Registration route probing (`POST /api/registrar/probe`)
 *   3. Optimal strategy selection (`POST /api/registrar/plan`)
 *   4. Bulk / concurrent registration & full pipeline (`POST /api/registrar/register`, `POST /api/registrar/pipeline`, `GET /api/registrar/jobs/:id`)
 *   5. Meaningful 2API credentials inspection & export (`GET /api/registrar/credentials`, `POST /api/registrar/credentials/export`)
 */

import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { RegistrationEngine } from "./core/engine.ts";
import type {
  BulkRegistrationSummary,
  DiscoveredSite,
  EngineConfig,
  ProbeReport,
  RegisterMode,
  RegistrationStrategyPlan,
} from "./core/types.ts";
import { DEFAULT_ENGINE_CONFIG } from "./core/types.ts";
import { nowIso } from "./core/utils.ts";
import {
  build2ApiCredentialBundle,
  formatCredentialsFor2Api,
  type CredentialExportFormat,
  type Exported2ApiBundle,
} from "./export/credentials-export.ts";
import { exportAllFromRegistrar } from "./export/tfg.ts";
import { saveGenericPlatformConfig, type GenericPlatformConfig } from "./platforms/generic.ts";
import { loadAllAdapters } from "./platforms/registry.ts";

export interface RegistrarJobLog {
  time: string;
  level: "info" | "warn" | "error" | "success";
  message: string;
}

export interface RegistrarJob {
  id: string;
  kind: "register" | "pipeline";
  target: string;
  status: "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  logs: RegistrarJobLog[];
  summary?: BulkRegistrationSummary;
  pipelineResult?: {
    discovered: DiscoveredSite[];
    probes: ProbeReport[];
    plans: RegistrationStrategyPlan[];
    summaries: BulkRegistrationSummary[];
    exportedCredentials: Exported2ApiBundle;
    credentialsFilePath: string;
  };
  error?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

function parseInputsField(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[\r\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export interface RegistrarApiControllerOptions {
  config?: Partial<EngineConfig>;
  fetchFn?: typeof fetch;
  onCredentialsUpdated?: () => void;
}

/**
 * Create a stateful Web-Standard Request -> Response handler for all registrar endpoints.
 * Supports both `/api/registrar/*` and `/api/*` route prefixes.
 */
export function createRegistrarApiHandler(opts: RegistrarApiControllerOptions = {}) {
  const baseConfig: Partial<EngineConfig> = {
    ...DEFAULT_ENGINE_CONFIG,
    ...(opts.config ?? {}),
  };
  const jobs = new Map<string, RegistrarJob>();
  let jobSeq = 1;

  function createEngineInstance(
    overrides: Partial<EngineConfig> = {},
    onProgress?: (msg: string, level?: "info" | "warn" | "error" | "success") => void,
  ): RegistrationEngine {
    const engine = new RegistrationEngine(
      { ...baseConfig, ...overrides },
      {
        onProgress: onProgress ?? (() => {}),
        ask: async () => "",
      },
    );
    engine.registerAdapters(loadAllAdapters());
    return engine;
  }

  const defaultEngine = createEngineInstance();

  function normalizeSubpath(pathname: string): string {
    if (pathname.startsWith("/api/registrar/")) {
      return "/" + pathname.slice("/api/registrar/".length);
    }
    if (pathname === "/api/registrar") {
      return "/status";
    }
    if (pathname.startsWith("/api/")) {
      return "/" + pathname.slice("/api/".length);
    }
    return pathname;
  }

  async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const sub = normalizeSubpath(url.pathname);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // 0. Standalone UI when visiting `/` or `/ui` on standalone registrar server
      if ((sub === "/" || sub === "/ui") && req.method === "GET") {
        const here =
          typeof import.meta.dirname === "string"
            ? import.meta.dirname
            : join(process.cwd(), "src");
        const candidates = [
          join(here, "public", "index.html"),
          join(here, "..", "..", "token-free-gateway", "src", "public", "index.html"),
          join(process.cwd(), "src", "public", "index.html"),
        ];
        for (const p of candidates) {
          if (existsSync(p)) {
            return new Response(readFileSync(p, "utf-8"), {
              status: 200,
              headers: {
                "Content-Type": "text/html; charset=utf-8",
                ...CORS_HEADERS,
              },
            });
          }
        }
        return jsonResponse({ ok: true, service: "universal-registrar" });
      }

      // 1. Status / Health overview
      if ((sub === "/status" || sub === "/health") && req.method === "GET") {
        const accounts = defaultEngine.store.list();
        const bundle = build2ApiCredentialBundle(accounts);
        const discovered = defaultEngine.discoveryStore.load();
        const platforms = defaultEngine.listAdapters().map((a) => ({
          id: a.id,
          name: a.name,
          signupUrl: a.signupUrl,
          preferredMode: a.preferredMode,
          needsEmail: a.needsEmail,
          needsPhone: a.needsPhone,
          domains: a.domains,
        }));
        const activeJobs = [...jobs.values()]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 20);

        return jsonResponse({
          ok: true,
          service: "universal-registrar",
          config: {
            cdpUrl: defaultEngine.config.cdpUrl,
            emailProvider: defaultEngine.config.emailProvider,
            mailHubUrl: defaultEngine.config.mailHubUrl,
            concurrency: defaultEngine.config.concurrency,
            maxRetries: defaultEngine.config.maxRetries,
          },
          stats: {
            platformsCount: platforms.length,
            discoveredCount: discovered.length,
            accountsCount: accounts.length,
            successAccountsCount: bundle.totalAccounts,
            apiKeysCount: bundle.totalApiKeys,
            bearerTokensCount: bundle.totalBearerTokens,
            runningJobsCount: activeJobs.filter((j) => j.status === "running").length,
          },
          platforms,
          jobs: activeJobs,
        });
      }

      // 2. List platforms
      if (sub === "/platforms" && req.method === "GET") {
        const platforms = defaultEngine.listAdapters().map((a) => ({
          id: a.id,
          name: a.name,
          signupUrl: a.signupUrl,
          preferredMode: a.preferredMode,
          needsEmail: a.needsEmail,
          needsPhone: a.needsPhone,
          domains: a.domains,
          tips: a.tips,
        }));
        return jsonResponse({ ok: true, platforms });
      }

      // 3. Phase 1: Discovered external sites (GET list / POST discover)
      if (sub === "/sites" && req.method === "GET") {
        const sites = defaultEngine.discoveryStore.load();
        return jsonResponse({ ok: true, sites });
      }

      if (sub === "/discover" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const inputs = parseInputsField(body.inputs ?? body.urls ?? body.target);
        if (inputs.length === 0) {
          return jsonResponse({ error: { message: "Missing 'inputs' or 'urls' array/string" } }, 400);
        }
        const logs: RegistrarJobLog[] = [];
        const engine = createEngineInstance({}, (message, level = "info") => {
          logs.push({ time: nowIso(), level, message });
        });
        const sites = await engine.discoverSites(inputs, {
          crawlDirectoryPages: Boolean(body.crawlDirectoryPages ?? body.crawl),
          concurrency: body.concurrency ? Number(body.concurrency) : 4,
          timeoutMs: body.timeoutMs ? Number(body.timeoutMs) : 8_000,
          fetchFn: opts.fetchFn,
        });
        return jsonResponse({ ok: true, sites, logs });
      }

      // 4. Phase 2: Probe registration routes
      if (sub === "/probe" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const target = String(body.target ?? body.url ?? body.platform ?? "").trim();
        if (!target) {
          return jsonResponse({ error: { message: "Missing 'target' URL or platform ID" } }, 400);
        }
        const logs: RegistrarJobLog[] = [];
        const engine = createEngineInstance({}, (message, level = "info") => {
          logs.push({ time: nowIso(), level, message });
        });
        const report = await engine.probeSite(target, {
          timeoutMs: body.timeoutMs ? Number(body.timeoutMs) : 8_000,
          fetchFn: opts.fetchFn,
        });
        return jsonResponse({ ok: true, report, logs });
      }

      // 5. Phase 3: Select optimal registration strategy
      if (sub === "/plan" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const target = String(body.target ?? body.url ?? body.platform ?? "").trim();
        if (!target) {
          return jsonResponse({ error: { message: "Missing 'target' URL or platform ID" } }, 400);
        }
        const logs: RegistrarJobLog[] = [];
        const engine = createEngineInstance({}, (message, level = "info") => {
          logs.push({ time: nowIso(), level, message });
        });
        const saveDir = body.savePlatform
          ? process.env.UR_PLATFORMS_DIR || join(process.cwd(), "config", "platforms")
          : undefined;
        const plan = await engine.planStrategy(target, {
          preferProtocol: body.preferProtocol === undefined ? true : Boolean(body.preferProtocol),
          maxConcurrency: body.maxConcurrency ? Number(body.maxConcurrency) : undefined,
          savePlatformDir: saveDir,
          fetchFn: opts.fetchFn,
        });
        // Also register the planned adapter on defaultEngine
        defaultEngine.resolveOrCreateAdapter(plan.platformId, {
          signupUrl: plan.signupUrl,
          preferredMode: plan.mode,
          framework: plan.framework,
          strategyKind: plan.strategyKind,
          protocolEndpoints: plan.protocolEndpoints,
          credentialHints: plan.credentialHints,
        });
        return jsonResponse({ ok: true, plan, logs });
      }

      // 6. Phase 4: Bulk / single registration
      if (sub === "/register" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const platform = String(body.platform ?? body.target ?? body.url ?? "").trim();
        if (!platform) {
          return jsonResponse({ error: { message: "Missing 'platform' or 'target' URL" } }, 400);
        }
        const count = Math.max(1, Number(body.count ?? 1));
        const concurrency = body.concurrency ? Math.max(1, Number(body.concurrency)) : undefined;
        const maxRetries = body.maxRetries !== undefined ? Math.max(0, Number(body.maxRetries)) : undefined;
        const mode = body.mode ? (String(body.mode) as RegisterMode) : undefined;
        const autoPlan = body.autoPlan === undefined ? true : Boolean(body.autoPlan);
        const exportTfg = body.exportTfg === undefined ? true : Boolean(body.exportTfg);
        const runAsync = Boolean(body.async);

        const engineOverrides: Partial<EngineConfig> = {};
        if (typeof body.emailProvider === "string" && body.emailProvider) {
          engineOverrides.emailProvider = body.emailProvider;
        }
        if (typeof body.mailHubUrl === "string" && body.mailHubUrl) {
          engineOverrides.mailHubUrl = body.mailHubUrl;
        }
        if (typeof body.mailHubApiKey === "string") {
          engineOverrides.mailHubApiKey = body.mailHubApiKey;
        }
        if (body.delayBetweenMs !== undefined) {
          engineOverrides.delayBetweenMs = Number(body.delayBetweenMs);
        }
        if (concurrency) {
          engineOverrides.concurrency = concurrency;
        }
        if (maxRetries !== undefined) {
          engineOverrides.maxRetries = maxRetries;
        }

        const adHocConfig: Partial<GenericPlatformConfig> | undefined =
          body.url || body.chatUrl
            ? {
                signupUrl: body.url ? String(body.url) : undefined,
                chatUrl: body.chatUrl ? String(body.chatUrl) : undefined,
              }
            : undefined;

        const jobId = `job_${Date.now().toString(36)}_${jobSeq++}`;
        const job: RegistrarJob = {
          id: jobId,
          kind: "register",
          target: platform,
          status: "running",
          createdAt: nowIso(),
          updatedAt: nowIso(),
          logs: [],
        };
        jobs.set(jobId, job);

        const executeJob = async () => {
          const engine = createEngineInstance(engineOverrides, (message, level = "info") => {
            job.logs.push({ time: nowIso(), level, message });
            job.updatedAt = nowIso();
          });
          try {
            let targetPlatformId = platform;
            if (autoPlan) {
              const report = await engine.probeSite(platform, { fetchFn: opts.fetchFn });
              const saveDir = body.savePlatform
                ? process.env.UR_PLATFORMS_DIR || join(process.cwd(), "config", "platforms")
                : undefined;
              const plan = await engine.planStrategy(report, {
                maxConcurrency: concurrency,
                savePlatformDir: saveDir,
                fetchFn: opts.fetchFn,
              });
              targetPlatformId = plan.platformId;
            } else if (body.savePlatform) {
              const adapter = engine.resolveOrCreateAdapter(platform, adHocConfig);
              if (adapter) {
                targetPlatformId = adapter.id;
                const dir = process.env.UR_PLATFORMS_DIR || join(process.cwd(), "config", "platforms");
                saveGenericPlatformConfig(
                  {
                    id: adapter.id,
                    name: adapter.name,
                    signupUrl: adapter.signupUrl,
                    domains: adapter.domains,
                    preferredMode: adapter.preferredMode,
                    needsEmail: adapter.needsEmail,
                    needsPhone: adapter.needsPhone,
                  },
                  dir,
                );
              }
            }

            const identity = {
              email: typeof body.email === "string" && body.email ? body.email : undefined,
              password: typeof body.password === "string" && body.password ? body.password : undefined,
              phone: typeof body.phone === "string" && body.phone ? body.phone : undefined,
              name: typeof body.name === "string" && body.name ? body.name : undefined,
            };

            const summary = await engine.runBulkWithSummary(targetPlatformId, count, {
              mode,
              exportTfg,
              adHocConfig,
              concurrency,
              maxRetries,
              autoPlan: false, // already planned above with fetchFn support
              identities: Array.from({ length: count }, (_, i) =>
                i === 0 ? identity : { phone: identity.phone },
              ),
            });

            job.summary = summary;
            job.status = "completed";
            job.updatedAt = nowIso();
            opts.onCredentialsUpdated?.();
            return summary;
          } catch (err) {
            job.status = "failed";
            job.error = err instanceof Error ? err.message : String(err);
            job.updatedAt = nowIso();
            throw err;
          }
        };

        if (runAsync) {
          executeJob().catch(() => {});
          return jsonResponse({ ok: true, jobId, status: "running", job });
        }

        try {
          const summary = await executeJob();
          return jsonResponse({ ok: true, jobId, status: "completed", summary, logs: job.logs });
        } catch (err) {
          return jsonResponse(
            {
              error: {
                message: err instanceof Error ? err.message : String(err),
              },
              jobId,
              logs: job.logs,
            },
            500,
          );
        }
      }

      // 7. End-to-End 5-Stage Pipeline
      if (sub === "/pipeline" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const inputs = parseInputsField(body.inputs ?? body.urls ?? body.target);
        if (inputs.length === 0) {
          return jsonResponse({ error: { message: "Missing 'inputs' or 'target' URLs" } }, 400);
        }
        const countPerSite = Math.max(1, Number(body.countPerSite ?? body.count ?? 1));
        const concurrency = body.concurrency ? Math.max(1, Number(body.concurrency)) : undefined;
        const maxRetries = body.maxRetries !== undefined ? Math.max(0, Number(body.maxRetries)) : undefined;
        const minScore = body.minScore !== undefined ? Number(body.minScore) : 40;
        const crawlDirectoryPages = Boolean(body.crawlDirectoryPages ?? body.crawl);
        const exportTfg = body.exportTfg === undefined ? true : Boolean(body.exportTfg);
        const runAsync = Boolean(body.async);

        const engineOverrides: Partial<EngineConfig> = {};
        if (typeof body.emailProvider === "string" && body.emailProvider) {
          engineOverrides.emailProvider = body.emailProvider;
        }
        if (typeof body.mailHubUrl === "string" && body.mailHubUrl) {
          engineOverrides.mailHubUrl = body.mailHubUrl;
        }
        if (typeof body.mailHubApiKey === "string") {
          engineOverrides.mailHubApiKey = body.mailHubApiKey;
        }
        if (body.delayBetweenMs !== undefined) {
          engineOverrides.delayBetweenMs = Number(body.delayBetweenMs);
        }
        if (concurrency) engineOverrides.concurrency = concurrency;
        if (maxRetries !== undefined) engineOverrides.maxRetries = maxRetries;

        const jobId = `pipe_${Date.now().toString(36)}_${jobSeq++}`;
        const job: RegistrarJob = {
          id: jobId,
          kind: "pipeline",
          target: inputs.join(", "),
          status: "running",
          createdAt: nowIso(),
          updatedAt: nowIso(),
          logs: [],
        };
        jobs.set(jobId, job);

        const executePipeline = async () => {
          const engine = createEngineInstance(engineOverrides, (message, level = "info") => {
            job.logs.push({ time: nowIso(), level, message });
            job.updatedAt = nowIso();
          });
          try {
            const saveDir = body.savePlatform
              ? process.env.UR_PLATFORMS_DIR || join(process.cwd(), "config", "platforms")
              : undefined;
            const res = await engine.runFullPipeline(inputs, {
              countPerSite,
              concurrency,
              maxRetries,
              minScore,
              crawlDirectoryPages,
              savePlatformDir: saveDir,
              exportTfg,
              fetchFn: opts.fetchFn,
            });
            job.pipelineResult = res;
            job.status = "completed";
            job.updatedAt = nowIso();
            opts.onCredentialsUpdated?.();
            return res;
          } catch (err) {
            job.status = "failed";
            job.error = err instanceof Error ? err.message : String(err);
            job.updatedAt = nowIso();
            throw err;
          }
        };

        if (runAsync) {
          executePipeline().catch(() => {});
          return jsonResponse({ ok: true, jobId, status: "running", job });
        }

        try {
          const result = await executePipeline();
          return jsonResponse({ ok: true, jobId, status: "completed", result, logs: job.logs });
        } catch (err) {
          return jsonResponse(
            {
              error: { message: err instanceof Error ? err.message : String(err) },
              jobId,
              logs: job.logs,
            },
            500,
          );
        }
      }

      // 8. Jobs status & logs polling
      if (sub === "/jobs" && req.method === "GET") {
        const list = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return jsonResponse({ ok: true, jobs: list });
      }

      if (sub.startsWith("/jobs/") && req.method === "GET") {
        const id = decodeURIComponent(sub.slice("/jobs/".length));
        const job = jobs.get(id);
        if (!job) {
          return jsonResponse({ error: { message: `Job not found: ${id}` } }, 404);
        }
        return jsonResponse({ ok: true, job });
      }

      // 9. Accounts list & deletion
      if (sub === "/accounts" && req.method === "GET") {
        const platform = url.searchParams.get("platform") || undefined;
        const accounts = defaultEngine.store.list(platform);
        return jsonResponse({ ok: true, accounts });
      }

      if (sub === "/accounts" && req.method === "DELETE") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const platformId = String(body.platformId ?? body.platform ?? "").trim();
        const email = String(body.email ?? "").trim();
        const data = defaultEngine.store.load();
        const before = data.accounts.length;
        data.accounts = data.accounts.filter((a) => {
          if (platformId && email) {
            return !(a.platformId === platformId && a.email === email);
          }
          if (platformId) return a.platformId !== platformId;
          if (email) return a.email !== email;
          return true;
        });
        defaultEngine.store.save(data);
        return jsonResponse({ ok: true, removed: before - data.accounts.length });
      }

      // 10. Phase 5: Meaningful 2API Credentials inspection & export
      if (sub === "/credentials" && req.method === "GET") {
        const platform = url.searchParams.get("platform") || undefined;
        const format = (url.searchParams.get("format") || "json") as CredentialExportFormat;
        const accounts = defaultEngine.store.list(platform);
        const bundle = build2ApiCredentialBundle(accounts);
        const formatted = formatCredentialsFor2Api(accounts, format);
        return jsonResponse({
          ok: true,
          format,
          content: formatted,
          bundle,
        });
      }

      if (sub === "/credentials/export" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const platformId = typeof body.platform === "string" && body.platform ? body.platform : undefined;
        const format = (typeof body.format === "string" ? body.format : "json") as CredentialExportFormat;
        const outputPath = typeof body.outputPath === "string" && body.outputPath ? body.outputPath : undefined;
        const syncTfg = body.syncTfg === undefined ? true : Boolean(body.syncTfg);

        const { filePath, bundle } = defaultEngine.exportCredentialsFor2Api({
          platformId,
          outputPath,
          format,
        });

        let exportedTfgCount = 0;
        if (syncTfg) {
          const accounts = defaultEngine.store.list(platformId);
          exportedTfgCount = exportAllFromRegistrar(accounts, defaultEngine.config.tfgStorePath);
          opts.onCredentialsUpdated?.();
        }

        const accounts = defaultEngine.store.list(platformId);
        const content = formatCredentialsFor2Api(accounts, format);

        return jsonResponse({
          ok: true,
          filePath,
          format,
          exportedTfgCount,
          content,
          bundle,
        });
      }

      return jsonResponse(
        {
          error: {
            message: `Unknown registrar endpoint: ${req.method} ${url.pathname}`,
          },
        },
        404,
      );
    } catch (err) {
      return jsonResponse(
        {
          error: {
            message: err instanceof Error ? err.message : String(err),
          },
        },
        500,
      );
    }
  }

  return {
    handleRequest,
    engine: defaultEngine,
    jobs,
  };
}

/**
 * Start a standalone Node.js HTTP server for Universal Registrar.
 */
export function startRegistrarServer(
  options: RegistrarApiControllerOptions & { port?: number; host?: string } = {},
): Promise<{ server: Server; port: number; host: string; close: () => Promise<void> }> {
  const port = options.port ?? Number(process.env.UR_PORT || 3200);
  const host = options.host ?? (process.env.UR_HOST || "127.0.0.1");
  const controller = createRegistrarApiHandler(options);

  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const proto = "http";
        const hostHeader = req.headers.host || `${host}:${port}`;
        const fullUrl = `${proto}://${hostHeader}${req.url || "/"}`;

        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        const bodyBuf = Buffer.concat(chunks);

        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (Array.isArray(v)) headers.set(k, v.join(", "));
          else if (typeof v === "string") headers.set(k, v);
        }

        const webReq = new Request(fullUrl, {
          method: req.method || "GET",
          headers,
          body:
            req.method && req.method !== "GET" && req.method !== "HEAD" && bodyBuf.length > 0
              ? bodyBuf
              : undefined,
        });

        const webRes = await controller.handleRequest(webReq);
        res.statusCode = webRes.status;
        webRes.headers.forEach((v, k) => {
          res.setHeader(k, v);
        });
        const arrayBuf = await webRes.arrayBuffer();
        res.end(Buffer.from(arrayBuf));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: { message: err instanceof Error ? err.message : String(err) },
          }),
        );
      }
    });

    server.on("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        server,
        port: actualPort,
        host,
        close: () =>
          new Promise<void>((resClose) => {
            server.closeAllConnections?.();
            server.close(() => resClose());
          }),
      });
    });
  });
}
