/**
 * Registration engine — orchestrates platform adapters, identity generation,
 * email providers, persistence and optional TFG export.
 */

import { createInterface } from "node:readline";
import { AccountStore } from "./account-store.ts";
import { FileEmailPool } from "./email/file-pool.ts";
import { MailHubProvider } from "./email/mailhub.ts";
import { MailTmProvider } from "./email/mailtm.ts";
import { ManualEmailProvider } from "./email/manual.ts";
import type {
  AccountIdentity,
  EngineConfig,
  EmailProvider,
  HumanPromptFn,
  PlatformAdapter,
  ProgressFn,
  RegisterMode,
  RegisterResult,
  RegisteredAccount,
} from "./types.ts";
import { DEFAULT_ENGINE_CONFIG } from "./types.ts";
import { GenericAdapter, createAdHocAdapter, type GenericPlatformConfig } from "../platforms/generic.ts";
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
  private adapters = new Map<string, PlatformAdapter>();
  private ask: HumanPromptFn;
  private onProgress: ProgressFn;

  constructor(
    config: Partial<EngineConfig> = {},
    opts: { ask?: HumanPromptFn; onProgress?: ProgressFn } = {},
  ) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.store = new AccountStore(this.config.storePath);
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
    const overrides = Object.fromEntries(Object.entries(adHocOverrides ?? {}).filter(([, value]) => value !== undefined));
    if (existing && Object.keys(overrides).length) {
      const config = existing instanceof GenericAdapter ? existing.cfg : {
        id: existing.id, name: existing.name, signupUrl: existing.signupUrl,
        domains: existing.domains, preferredMode: existing.preferredMode,
        needsEmail: existing.needsEmail, needsPhone: existing.needsPhone,
      };
      const adapter = new GenericAdapter({ ...config, ...overrides });
      this.registerAdapter(adapter);
      return adapter;
    }
    if (existing) return existing;

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
    switch (this.config.emailProvider) {
      case "mailhub":
        return new MailHubProvider({
          baseUrl: this.config.mailHubUrl || this.config.emailApiBase,
          apiKey: this.config.mailHubApiKey,
          provider: this.config.mailHubProvider,
          domain: this.config.mailHubDomain,
        });
      case "mailtm":
        return new MailTmProvider(this.config.emailApiBase);
      case "file":
        if (!this.config.emailFile) {
          throw new Error('emailProvider "file" requires emailFile path');
        }
        return new FileEmailPool(this.config.emailFile, this.ask);
      case "manual":
      default:
        return new ManualEmailProvider(this.ask);
    }
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

    if (adapter instanceof GenericAdapter && !adapter.cfg.successCookie && !adapter.cfg.successSelector) {
      throw new Error("Configure --success-cookie or --success-selector before registration/capture. Use inspect first. No account actions were attempted.");
    }
    const interactiveIdentity = options.captureOnly || (adapter instanceof GenericAdapter && adapter.cfg.authMethod === "github");
    if (adapter instanceof GenericAdapter && adapter.cfg.authMethod === "github" && options.mode === "auto") {
      throw new Error("GitHub authorization requires semi or manual mode.");
    }
    const emailProvider = interactiveIdentity ? undefined : this.buildEmailProvider();
    const identity = interactiveIdentity
      ? { ...options.identity, email: options.identity?.email ?? "", password: "" }
      : this.buildIdentity(options.identity);

    if (!identity.email) {
      if (!interactiveIdentity && (adapter.needsEmail || this.config.emailProvider !== "manual")) {
        this.onProgress(`[${adapter.name}] Acquiring email address...`);
        identity.email = await emailProvider!.acquireAddress(adapter.id);
      } else {
        identity.email = (await this.ask(`[${adapter.name}] Existing account email / local account label: `)).trim();
      }
    }

    if (!identity.email) throw new Error("A non-empty account label is required to avoid overwriting another session.");
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

    if (result.success && result.status === "success") {
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

    await emailProvider?.release?.(identity.email).catch(() => {});
    return saved;
  }

  /**
   * Sequential batch registration (concurrency kept at 1 by default to reduce ban risk).
   */
  async runBatch(
    platformId: string,
    count: number,
    options: {
      mode?: RegisterMode;
      exportTfg?: boolean;
      identities?: Partial<AccountIdentity>[];
    } = {},
  ): Promise<RegisteredAccount[]> {
    if (count < 1) return [];
    if (count > 20) {
      this.onProgress(
        `Refusing count=${count}. Cap is 20 per batch to discourage bulk abuse. Run multiple batches if you truly need more for legitimate testing.`,
        "warn",
      );
      count = 20;
    }

    const adapter = this.getAdapter(platformId);
    if (adapter instanceof GenericAdapter && adapter.cfg.authMethod === "github" && count !== 1) {
      throw new Error("GitHub authorization is interactive and only supports one account at a time.");
    }
    const results: RegisteredAccount[] = [];
    for (let i = 0; i < count; i++) {
      this.onProgress(`—— Batch ${i + 1}/${count} ——`);
      const identity = options.identities?.[i];
      const acc = await this.runOne(platformId, {
        identity,
        mode: options.mode,
        exportTfg: options.exportTfg,
      });
      results.push(acc);
      if (i < count - 1 && this.config.delayBetweenMs > 0) {
        this.onProgress(`Cooling down ${this.config.delayBetweenMs}ms...`);
        await sleep(this.config.delayBetweenMs);
      }
    }
    return results;
  }
}
