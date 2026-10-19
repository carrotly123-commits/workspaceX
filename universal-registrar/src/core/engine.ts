/**
 * Registration engine — orchestrates platform adapters, identity generation,
 * email providers, persistence and optional TFG export.
 */

import { createInterface } from "node:readline";
import { AccountStore } from "./account-store.ts";
import {
  DiscoveryStore,
  discoverExternalSites,
} from "./discovery.ts";
import { AutoEmailProvider } from "./email/auto-pool.ts";
import { FileEmailPool } from "./email/file-pool.ts";
import { MailHubProvider } from "./email/mailhub.ts";
import { MailTmProvider } from "./email/mailtm.ts";
import { ManualEmailProvider } from "./email/manual.ts";
import {
  planToGenericPlatformConfig,
  selectOptimalStrategy,
} from "./planner.ts";
import { probeSiteRegistrationRoutes } from "./prober.ts";
import type {
  AccountIdentity,
  BulkRegistrationSummary,
  DiscoveredSite,
  EngineConfig,
  EmailProvider,
  HumanPromptFn,
  PlatformAdapter,
  ProbeReport,
  ProgressFn,
  RegisterMode,
  RegisterResult,
  RegisteredAccount,
  RegistrationStrategyPlan,
} from "./types.ts";
import { DEFAULT_ENGINE_CONFIG } from "./types.ts";
import {
  createAdHocAdapter,
  saveGenericPlatformConfig,
  type GenericPlatformConfig,
} from "../platforms/generic.ts";
import {
  saveCredentialsFor2Api,
  type CredentialExportFormat,
  type Exported2ApiBundle,
} from "../export/credentials-export.ts";
import { generateName, generatePassword, log, nowIso, sleep } from "./utils.ts";

function createAskHuman(): HumanPromptFn {
  return (prompt, options) =>
    new Promise((resolve, reject) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const timer =
        options?.timeoutMs &&
        setTimeout(() => {
          rl.close();
          reject(new Error("Human input timed out"));
        }, options.timeoutMs);

      rl.question(prompt, (answer) => {
        if (timer) clearTimeout(timer);
        rl.close();
        resolve(answer);
      });
    });
}

function defaultProgress(): ProgressFn {
  return (msg, level = "info") => log(msg, level);
}

export class RegistrationEngine {
  readonly config: EngineConfig;
  readonly store: AccountStore;
  readonly discoveryStore: DiscoveryStore;
  private adapters = new Map<string, PlatformAdapter>();
  private ask: HumanPromptFn;
  private onProgress: ProgressFn;
  private sharedEmailProvider?: EmailProvider;

  constructor(
    config: Partial<EngineConfig> = {},
    opts: { ask?: HumanPromptFn; onProgress?: ProgressFn } = {},
  ) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.store = new AccountStore(this.config.storePath);
    this.discoveryStore = new DiscoveryStore(
      this.config.discoveredSitesPath ?? DEFAULT_ENGINE_CONFIG.discoveredSitesPath!,
    );
    this.ask = opts.ask ?? createAskHuman();
    this.onProgress = opts.onProgress ?? defaultProgress();
  }

  registerAdapter(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  registerAdapters(adapters: PlatformAdapter[]): void {
    for (const a of adapters) this.registerAdapter(a);
  }

  listAdapters(): PlatformAdapter[] {
    return [...this.adapters.values()];
  }

  getAdapter(id: string): PlatformAdapter | undefined {
    const direct = this.adapters.get(id);
    if (direct) return direct;
    if (id.endsWith("-web")) {
      const stripped = id.slice(0, -4);
      if (this.adapters.has(stripped)) return this.adapters.get(stripped);
    } else if (this.adapters.has(`${id}-web`)) {
      return this.adapters.get(`${id}-web`);
    }
    if (/^https?:\/\//i.test(id) || id.includes(".") || id.includes("/")) {
      try {
        const derivedId = createAdHocAdapter(id).id;
        if (this.adapters.has(derivedId)) return this.adapters.get(derivedId);
      } catch {
        // ignore
      }
    }
    return undefined;
  }

  /**
   * Resolve an existing adapter or dynamically create a zero-config GenericAdapter
   * when given a URL, domain, or custom channel with an explicit `signupUrl`.
   */
  resolveOrCreateAdapter(
    platformIdOrUrl: string,
    adHocOverrides?: Partial<GenericPlatformConfig>,
  ): PlatformAdapter | undefined {
    const existing = this.getAdapter(platformIdOrUrl);
    if (existing && !adHocOverrides?.signupUrl) return existing;

    const looksLikeUrlOrDomain =
      /^https?:\/\//i.test(platformIdOrUrl) ||
      platformIdOrUrl.includes(".") ||
      platformIdOrUrl.includes("/") ||
      Boolean(adHocOverrides?.signupUrl);

    if (!looksLikeUrlOrDomain) return existing;

    const adapter = createAdHocAdapter(platformIdOrUrl, adHocOverrides);
    this.registerAdapter(adapter);
    return adapter;
  }

  private buildEmailProvider(): EmailProvider {
    if (this.sharedEmailProvider) return this.sharedEmailProvider;
    let provider: EmailProvider;
    switch (this.config.emailProvider) {
      case "auto":
        provider = new AutoEmailProvider({
          mailHub: {
            baseUrl: this.config.mailHubUrl || this.config.emailApiBase,
            apiKey: this.config.mailHubApiKey,
            provider: this.config.mailHubProvider,
            domain: this.config.mailHubDomain,
          },
          mailTmApiBase: this.config.emailApiBase,
          emailFile: this.config.emailFile,
          ask: this.ask,
          onProgress: this.onProgress,
        });
        break;
      case "mailhub":
        provider = new MailHubProvider({
          baseUrl: this.config.mailHubUrl || this.config.emailApiBase,
          apiKey: this.config.mailHubApiKey,
          provider: this.config.mailHubProvider,
          domain: this.config.mailHubDomain,
        });
        break;
      case "mailtm":
        provider = new MailTmProvider(this.config.emailApiBase);
        break;
      case "file":
        if (!this.config.emailFile) {
          throw new Error('emailProvider "file" requires emailFile path');
        }
        provider = new FileEmailPool(this.config.emailFile, this.ask);
        break;
      case "manual":
      default:
        provider = new ManualEmailProvider(this.ask);
        break;
    }
    this.sharedEmailProvider = provider;
    return provider;
  }

  /**
   * Phase 1: Discover external websites from URLs, directory pages, or files.
   */
  async discoverSites(
    inputs: string[],
    options: {
      crawlDirectoryPages?: boolean;
      concurrency?: number;
      timeoutMs?: number;
      fetchFn?: typeof fetch;
    } = {},
  ): Promise<DiscoveredSite[]> {
    const discovered = await discoverExternalSites(inputs, {
      ...options,
      onProgress: this.onProgress,
    });
    this.discoveryStore.upsertMany(discovered);
    return discovered;
  }

  /**
   * Phase 2: Probe registration pathways, barriers, and credential hints for a site.
   */
  async probeSite(
    targetUrlOrId: string | DiscoveredSite,
    options: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
  ): Promise<ProbeReport> {
    if (typeof targetUrlOrId === "string") {
      const existingAdapter = this.getAdapter(targetUrlOrId);
      const resolvedTarget = existingAdapter ? existingAdapter.signupUrl : targetUrlOrId;
      const report = await probeSiteRegistrationRoutes(resolvedTarget, {
        ...options,
        onProgress: this.onProgress,
      });
      if (existingAdapter) {
        return { ...report, platformId: existingAdapter.id };
      }
      return report;
    }
    return probeSiteRegistrationRoutes(targetUrlOrId, {
      ...options,
      onProgress: this.onProgress,
    });
  }

  /**
   * Phase 3: Select optimal registration strategy for a site and auto-register its adapter.
   */
  async planStrategy(
    targetOrReport: string | DiscoveredSite | ProbeReport,
    options: {
      preferProtocol?: boolean;
      maxConcurrency?: number;
      savePlatformDir?: string;
      fetchFn?: typeof fetch;
    } = {},
  ): Promise<RegistrationStrategyPlan> {
    const report: ProbeReport =
      typeof targetOrReport === "object" && "routes" in targetOrReport
        ? targetOrReport
        : await this.probeSite(targetOrReport, { fetchFn: options.fetchFn });

    const plan = selectOptimalStrategy(report, {
      preferProtocol: options.preferProtocol,
      maxConcurrency: options.maxConcurrency ?? this.config.concurrency,
    });

    // Automatically configure and register a GenericAdapter tailored with the optimal plan
    const cfg = planToGenericPlatformConfig(plan);
    const adapter = createAdHocAdapter(plan.platformId, cfg);
    this.registerAdapter(adapter);

    if (options.savePlatformDir) {
      const savedPath = saveGenericPlatformConfig(cfg, options.savePlatformDir);
      this.onProgress(`[plan] Saved optimal platform config → ${savedPath}`, "success");
    }

    return plan;
  }

  /**
   * Build an identity. Missing email is filled by the email provider later
   * (or from opts.email). Password/name are auto-generated when omitted.
   */
  buildIdentity(partial: Partial<AccountIdentity> = {}): AccountIdentity {
    return {
      email: partial.email ?? "",
      password: partial.password || generatePassword(this.config.passwordLength),
      name: partial.name || generateName(),
      phone: partial.phone,
      extra: partial.extra,
    };
  }

  async runOne(
    platformId: string,
    options: {
      identity?: Partial<AccountIdentity>;
      mode?: RegisterMode;
      captureOnly?: boolean;
      exportTfg?: boolean;
      adHocConfig?: Partial<GenericPlatformConfig>;
    } = {},
  ): Promise<RegisteredAccount> {
    const adapter = this.resolveOrCreateAdapter(platformId, options.adHocConfig);
    if (!adapter) {
      throw new Error(
        `Unknown platform "${platformId}". Pass a URL/domain (e.g. https://example.com/signup) or --url <signupUrl> to use any new channel immediately, or choose from: ${[...this.adapters.keys()].join(", ")}`,
      );
    }

    const emailProvider = this.buildEmailProvider();
    const identity = this.buildIdentity(options.identity);

    if (!identity.email) {
      if (adapter.needsEmail || this.config.emailProvider !== "manual") {
        this.onProgress(`[${adapter.name}] Acquiring email address...`);
        identity.email = await emailProvider.acquireAddress(adapter.id);
      } else {
        identity.email = (await this.ask(`[${adapter.name}] Email: `)).trim();
      }
    }

    const mode = options.mode ?? adapter.preferredMode;
    this.onProgress(
      `[${adapter.name}] Start register  email=${identity.email}  mode=${mode}`,
      "info",
    );
    if (adapter.tips) this.onProgress(`[${adapter.name}] Tip: ${adapter.tips}`, "warn");

    const pending: RegisteredAccount = {
      ...identity,
      platformId: adapter.id,
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.upsert(pending);

    let result: RegisterResult;
    try {
      const ctx = {
        identity,
        mode,
        onProgress: ((msg: string, level?: "info" | "warn" | "error" | "success") =>
          this.onProgress(`[${adapter.name}] ${msg}`, level)) as ProgressFn,
        askHuman: this.ask,
        email: emailProvider,
        cdpUrl: this.config.cdpUrl,
        headless: this.config.headless,
        timeoutMs: this.config.timeoutMs,
      };

      if (options.captureOnly && adapter.captureSession) {
        result = await adapter.captureSession(ctx);
      } else {
        result = await adapter.register(ctx);
      }
    } catch (err) {
      result = {
        success: false,
        status: "failed",
        identity,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const saved: RegisteredAccount = {
      ...identity,
      platformId: adapter.id,
      status: result.status,
      credentials: result.credentials,
      message: result.message,
      createdAt: pending.createdAt,
      updatedAt: nowIso(),
    };
    this.store.upsert(saved);

    if (result.success) {
      this.onProgress(
        `[${adapter.name}] Success → ${identity.email}`,
        "success",
      );
      if (options.exportTfg !== false && result.credentials) {
        const { exportToTokenFreeGateway } = await import("../export/tfg.ts");
        exportToTokenFreeGateway(adapter.id, result.credentials, this.config.tfgStorePath);
        this.onProgress(`[${adapter.name}] Exported credentials to token-free-gateway store`, "success");
      }
    } else {
      this.onProgress(
        `[${adapter.name}] Failed: ${result.message ?? result.status}`,
        "error",
      );
    }

    await emailProvider.release?.(identity.email).catch(() => {});
    return saved;
  }

  /**
   * Phase 4: High-throughput bulk registration with configurable concurrency,
   * automatic retries with fresh inboxes, and no artificial 20-account ceiling.
   */
  async runBatch(
    platformId: string,
    count: number,
    options: {
      mode?: RegisterMode;
      exportTfg?: boolean;
      identities?: Partial<AccountIdentity>[];
      adHocConfig?: Partial<GenericPlatformConfig>;
      concurrency?: number;
      maxRetries?: number;
      autoPlan?: boolean;
    } = {},
  ): Promise<RegisteredAccount[]> {
    if (count < 1) return [];

    let effectiveMode = options.mode;
    let effectiveConcurrency = Math.max(1, options.concurrency ?? this.config.concurrency ?? 1);
    let effectiveDelayMs = this.config.delayBetweenMs;
    const maxRetries = Math.max(0, options.maxRetries ?? this.config.maxRetries ?? 1);
    let targetPlatformId = platformId;

    // Optional automatic route probing & optimal strategy selection before bulk run
    if (options.autoPlan) {
      try {
        const plan = await this.planStrategy(platformId, {
          maxConcurrency: effectiveConcurrency,
        });
        targetPlatformId = plan.platformId;
        effectiveMode = effectiveMode ?? plan.mode;
        if (!options.concurrency) {
          effectiveConcurrency = plan.recommendedConcurrency;
        }
        effectiveDelayMs = plan.recommendedDelayMs;
        this.onProgress(
          `[plan] Selected strategy=${plan.strategyKind} route=${plan.chosenRoute.type} score=${plan.score} mode=${effectiveMode} concurrency=${effectiveConcurrency}`,
          "info",
        );
      } catch (err) {
        this.onProgress(
          `[plan] Auto-probe skipped (${err instanceof Error ? err.message : err}), proceeding with direct adapter`,
          "warn",
        );
      }
    }

    const results: RegisteredAccount[] = new Array(count);
    let nextIndex = 0;

    const runWorker = async () => {
      while (nextIndex < count) {
        const i = nextIndex++;
        this.onProgress(`—— Batch ${i + 1}/${count} ——`);
        const baseIdentity = options.identities?.[i];
        let attempt = 0;
        let lastAcc: RegisteredAccount | undefined;

        while (attempt <= maxRetries) {
          if (attempt > 0) {
            this.onProgress(
              `[retry ${attempt}/${maxRetries}] Retrying slot #${i + 1} with a fresh inbox...`,
              "warn",
            );
          }
          // On retry, clear any pre-assigned email unless user explicitly fixed a single email
          const identityForAttempt =
            attempt === 0
              ? baseIdentity
              : { ...(baseIdentity ?? {}), email: undefined };

          lastAcc = await this.runOne(targetPlatformId, {
            identity: identityForAttempt,
            mode: effectiveMode,
            exportTfg: options.exportTfg,
            adHocConfig: options.adHocConfig,
          });

          if (lastAcc.status === "success") break;
          attempt++;
        }

        results[i] = lastAcc!;
        if (nextIndex < count && effectiveDelayMs > 0) {
          this.onProgress(`Cooling down ${effectiveDelayMs}ms...`);
          await sleep(effectiveDelayMs);
        }
      }
    };

    const workerCount = Math.min(effectiveConcurrency, count);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    // Automatically export 2API credentials bundle if any account succeeded
    if (this.config.credentialsExportPath && results.some((r) => r?.status === "success")) {
      try {
        this.exportCredentialsFor2Api({
          outputPath: this.config.credentialsExportPath,
          format: "json",
        });
      } catch {
        // ignore export error
      }
    }

    return results;
  }

  /**
   * Run bulk registration and return a structured summary including minted API key & token counts.
   */
  async runBulkWithSummary(
    platformId: string,
    count: number,
    options: Parameters<RegistrationEngine["runBatch"]>[2] = {},
  ): Promise<BulkRegistrationSummary> {
    const startedAt = Date.now();
    const accounts = await this.runBatch(platformId, count, options);
    let succeeded = 0;
    let failed = 0;
    let highQualityCredentials = 0;
    let apiKeysMinted = 0;
    let bearerTokensCaptured = 0;

    for (const acc of accounts) {
      if (acc.status === "success") {
        succeeded++;
        const creds = acc.credentials as Record<string, unknown> | undefined;
        if (creds) {
          if (typeof creds.apiKey === "string" && creds.apiKey) apiKeysMinted++;
          if (
            (typeof creds.accessToken === "string" && creds.accessToken) ||
            (typeof creds.bearer === "string" && creds.bearer)
          ) {
            bearerTokensCaptured++;
          }
          if (creds.quality === "high" || creds.apiKey || creds.accessToken || creds.bearer) {
            highQualityCredentials++;
          }
        }
      } else {
        failed++;
      }
    }

    return {
      platformId,
      totalRequested: count,
      succeeded,
      failed,
      highQualityCredentials,
      apiKeysMinted,
      bearerTokensCaptured,
      durationMs: Date.now() - startedAt,
      accounts,
    };
  }

  /**
   * Phase 5: Export meaningful 2API credentials (`apiKey`, `accessToken`, `readyHeaders`, etc.).
   */
  exportCredentialsFor2Api(
    options: {
      platformId?: string;
      outputPath?: string;
      format?: CredentialExportFormat;
    } = {},
  ): { filePath: string; bundle: Exported2ApiBundle } {
    const accounts = this.store.list(options.platformId);
    const outputPath =
      options.outputPath ??
      this.config.credentialsExportPath ??
      DEFAULT_ENGINE_CONFIG.credentialsExportPath!;
    return saveCredentialsFor2Api(accounts, outputPath, options.format ?? "json");
  }

  /**
   * End-to-End Pipeline:
   *   1. Discover external websites from inputs
   *   2. Probe registration routes for each site
   *   3. Select optimal registration strategy
   *   4. Bulk register accounts on feasible sites
   *   5. Export meaningful 2API credentials (API keys, tokens, headers)
   */
  async runFullPipeline(
    inputs: string[],
    options: {
      countPerSite?: number;
      concurrency?: number;
      maxRetries?: number;
      minScore?: number;
      crawlDirectoryPages?: boolean;
      savePlatformDir?: string;
      credentialsOutputPath?: string;
      exportTfg?: boolean;
      fetchFn?: typeof fetch;
    } = {},
  ): Promise<{
    discovered: DiscoveredSite[];
    probes: ProbeReport[];
    plans: RegistrationStrategyPlan[];
    summaries: BulkRegistrationSummary[];
    exportedCredentials: Exported2ApiBundle;
    credentialsFilePath: string;
  }> {
    const countPerSite = Math.max(1, options.countPerSite ?? 1);
    const minScore = options.minScore ?? 40;

    // Step 1: Discover external websites
    const discovered = await this.discoverSites(inputs, {
      crawlDirectoryPages: options.crawlDirectoryPages,
      fetchFn: options.fetchFn,
    });

    const probes: ProbeReport[] = [];
    const plans: RegistrationStrategyPlan[] = [];
    const summaries: BulkRegistrationSummary[] = [];

    // Step 2 & 3: Probe & Plan each discovered site
    for (const site of discovered) {
      if (!site.reachable) {
        this.onProgress(`[pipeline] Skipping unreachable site ${site.origin}`, "warn");
        continue;
      }
      const report = await this.probeSite(site, { fetchFn: options.fetchFn });
      probes.push(report);

      const plan = await this.planStrategy(report, {
        maxConcurrency: options.concurrency ?? this.config.concurrency,
        savePlatformDir: options.savePlatformDir,
        fetchFn: options.fetchFn,
      });
      plans.push(plan);

      if (!plan.canBulkRegister || plan.score < minScore) {
        this.onProgress(
          `[pipeline] Skipping bulk registration for ${plan.platformId} (score=${plan.score} < minScore=${minScore}, strategy=${plan.strategyKind})`,
          "warn",
        );
        continue;
      }

      // Step 4: Bulk register using optimal strategy
      this.onProgress(
        `[pipeline] Bulk registering ${countPerSite} account(s) on ${plan.platformId} via ${plan.strategyKind} (route=${plan.chosenRoute.type}, score=${plan.score})...`,
        "info",
      );
      const summary = await this.runBulkWithSummary(plan.platformId, countPerSite, {
        mode: plan.mode,
        concurrency: options.concurrency ?? plan.recommendedConcurrency,
        maxRetries: options.maxRetries,
        exportTfg: options.exportTfg,
      });
      summaries.push(summary);
    }

    // Step 5: Export meaningful 2API credentials
    const { filePath: credentialsFilePath, bundle: exportedCredentials } =
      this.exportCredentialsFor2Api({
        outputPath: options.credentialsOutputPath,
        format: "json",
      });

    this.onProgress(
      `[pipeline] Completed! Exported ${exportedCredentials.totalAccounts} account(s) (${exportedCredentials.totalApiKeys} API keys, ${exportedCredentials.totalBearerTokens} tokens) → ${credentialsFilePath}`,
      "success",
    );

    return {
      discovered,
      probes,
      plans,
      summaries,
      exportedCredentials,
      credentialsFilePath,
    };
  }
}
