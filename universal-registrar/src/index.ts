#!/usr/bin/env node
/**
 * Universal Registrar — CLI
 *
 * Commands:
 *   platforms                         List built-in + custom platforms
 *   discover <url|file>...            Discover external AI websites & signup entrypoints
 *   probe <platform|url>              Probe registration pathways, barriers & selectors
 *   plan <platform|url>               Select optimal registration strategy & save config
 *   register <platform> [options]     Register one or more accounts
 *   pipeline <url|file>...            Full auto pipeline: discover -> probe -> plan -> bulk register -> export 2API keys
 *   capture  <platform>               Only capture an already-logged-in session
 *   list [--platform id]              List saved accounts
 *   credentials [--platform id]       Inspect or export meaningful 2API credentials (API keys, tokens, headers)
 *   export [--platform id]            Export credentials to token-free-gateway
 *   doctor                            Check Chrome CDP connectivity
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RegistrationEngine } from "./core/engine.ts";
import type { EngineConfig, RegisterMode } from "./core/types.ts";
import { DEFAULT_ENGINE_CONFIG } from "./core/types.ts";
import { log } from "./core/utils.ts";
import {
  formatCredentialsFor2Api,
  type CredentialExportFormat,
} from "./export/credentials-export.ts";
import { exportToTokenFreeGateway } from "./export/tfg.ts";
import { saveGenericPlatformConfig, type GenericPlatformConfig } from "./platforms/generic.ts";
import { loadAllAdapters } from "./platforms/registry.ts";

function printHelp(): void {
  console.log(`
Universal Registrar  —  multi-platform account registration toolkit
Works with token-free-gateway (https://github.com/andeya/token-free-gateway)

Usage:
  npx tsx src/index.ts <command> [options]

Commands:
  platforms                         List supported platforms
  discover <url|file>... [opts]     Discover external AI sites & signup entrypoints
  probe    <platform|url>           Probe all registration pathways, CAPTCHAs & selectors
  plan     <platform|url> [opts]    Select optimal registration strategy (API vs Browser)
  register <platform|url> [opts]    Register account(s) on a built-in or any new URL/channel
  pipeline <url|file>... [opts]     End-to-end: discover -> probe -> plan -> bulk register -> export 2API keys
  capture  <platform|url>           Capture session from already-logged-in browser for any channel
  list [--platform <id>]            Show saved accounts
  credentials [--platform <id>]     Export/print meaningful 2API credentials (API keys, Bearer tokens, headers)
  export [--platform <id>]          Push credentials into token-free-gateway store
  doctor                            Verify Chrome CDP is reachable

Discovery / Probe / Plan / Pipeline options:
  --crawl                           Crawl links inside a directory/navigation page during discovery
  --min-score <0-100>               Minimum strategy feasibility score for pipeline bulk run (default 40)
  --format <json|keys|jsonl|env>    Output format for 'credentials' command (default json)
  --out <path>                      Output file path for exported 2API credentials

Register & Bulk options:
  --count <n>                       How many accounts to register (default 1, unlimited for bulk)
  --concurrency <n>                 Concurrent registration workers (default 1; 3-5 for API protocol)
  --retries <n>                     Auto-retries per account with a fresh inbox on failure (default 1)
  --auto-plan                       Automatically probe site & pick optimal strategy before registering
  --mode <auto|semi|manual>         Override adapter preferred mode
  --url <signupUrl>                 Signup/login URL for onboarding a new channel on the fly
  --chat-url <chatUrl>              Chat page URL for token-free-gateway (defaults to URL origin)
  --save-platform                   Save this new channel into config/platforms/<id>.json
  --email <addr>                    Use this email (skip pool/manual acquire)
  --password <pwd>                  Use this password
  --phone <num>                     Phone number for SMS platforms
  --name <display>                  Display name
  --no-export                       Do not write token-free-gateway auth-profiles
  --email-provider <auto|manual|file|mailtm|mailhub>
  --email-file <path>               Email pool file (with --email-provider file)
  --mailhub-url <url>               Mail Hub server URL (default http://127.0.0.1:3100)
  --mailhub-key <secret>            Mail Hub Bearer API key / API_SECRET
  --mailhub-provider <name>         Force Mail Hub provider (e.g. outlook, yyds, imap, mailtm)
  --mailhub-domain <domain>         Request specific domain from Mail Hub
  --cdp <url>                       Chrome CDP URL (default http://127.0.0.1:9222)
  --delay <ms>                      Delay between batch items (default 5000)

Examples:
  npx tsx src/index.ts platforms
  npx tsx src/index.ts doctor
  npx tsx src/index.ts register deepseek --mode semi
  npx tsx src/index.ts register kimi --phone +8613800138000
  npx tsx src/index.ts capture claude
  npx tsx src/index.ts register deepseek --count 3 --email-provider mailtm
  npx tsx src/index.ts register deepseek --email-provider mailhub --mailhub-key your-secret
  npx tsx src/index.ts export --platform deepseek

Config file (optional): ~/.universal-registrar/config.json
Environment:
  UR_CDP_URL, UR_STORE_PATH, TFG_STORE_PATH, UR_PLATFORMS_DIR,
  UR_EMAIL_PROVIDER, MAIL_HUB_URL, MAIL_HUB_API_KEY, MAIL_HUB_PROVIDER, MAIL_HUB_DOMAIN
`);
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--no-export") {
      flags.noExport = true;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positional.push(a);
  }
  return { command, positional, flags };
}

function loadUserConfig(): Partial<EngineConfig> {
  const path = join(homedir(), ".universal-registrar", "config.json");
  const local = join(process.cwd(), "config", "config.json");
  for (const p of [local, path]) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf-8")) as Partial<EngineConfig>;
      } catch {
        console.warn(`Failed to parse config: ${p}`);
      }
    }
  }
  return {};
}

function buildEngine(flags: Record<string, string | boolean>): RegistrationEngine {
  const user = loadUserConfig();
  const cfg: Partial<EngineConfig> = {
    ...user,
    cdpUrl: String(flags.cdp || user.cdpUrl || DEFAULT_ENGINE_CONFIG.cdpUrl),
    emailProvider: String(
      flags["email-provider"] || user.emailProvider || DEFAULT_ENGINE_CONFIG.emailProvider,
    ),
    emailFile: flags["email-file"]
      ? String(flags["email-file"])
      : user.emailFile,
    mailHubUrl: flags["mailhub-url"]
      ? String(flags["mailhub-url"])
      : user.mailHubUrl ?? DEFAULT_ENGINE_CONFIG.mailHubUrl,
    mailHubApiKey: flags["mailhub-key"]
      ? String(flags["mailhub-key"])
      : user.mailHubApiKey ?? DEFAULT_ENGINE_CONFIG.mailHubApiKey,
    mailHubProvider: flags["mailhub-provider"]
      ? String(flags["mailhub-provider"])
      : user.mailHubProvider ?? DEFAULT_ENGINE_CONFIG.mailHubProvider,
    mailHubDomain: flags["mailhub-domain"]
      ? String(flags["mailhub-domain"])
      : user.mailHubDomain ?? DEFAULT_ENGINE_CONFIG.mailHubDomain,
    delayBetweenMs: flags.delay
      ? Number(flags.delay)
      : user.delayBetweenMs ?? DEFAULT_ENGINE_CONFIG.delayBetweenMs,
    concurrency: flags.concurrency
      ? Number(flags.concurrency)
      : user.concurrency ?? DEFAULT_ENGINE_CONFIG.concurrency,
    maxRetries: flags.retries !== undefined
      ? Number(flags.retries)
      : user.maxRetries ?? DEFAULT_ENGINE_CONFIG.maxRetries,
  };
  const engine = new RegistrationEngine(cfg);
  engine.registerAdapters(loadAllAdapters());
  return engine;
}

async function cmdDoctor(flags: Record<string, string | boolean>): Promise<void> {
  const cdp = String(flags.cdp || DEFAULT_ENGINE_CONFIG.cdpUrl);
  const mailHubUrl = String(flags["mailhub-url"] || DEFAULT_ENGINE_CONFIG.mailHubUrl);
  const tfgUrl = process.env.TFG_URL || `http://127.0.0.1:${process.env.TFG_PORT || 3456}`;

  log(`1/3 Checking Chrome CDP at ${cdp} ...`);
  try {
    const res = await fetch(`${cdp.replace(/\/$/, "")}/json/version`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, string>;
    log(`Chrome reachable: ${data.Browser ?? data["User-Agent"] ?? "ok"}`, "success");
    log(`WebSocket: ${data.webSocketDebuggerUrl ?? "(none)"}`);
  } catch (e) {
    log(`Chrome CDP not reachable: ${e instanceof Error ? e.message : e}`, "error");
    console.log(`
Start Chrome in debug mode first:

  # If you installed token-free-gateway:
  token-free-gateway chrome start

  # Or manually (Windows):
  chrome.exe --remote-debugging-port=9222 --user-data-dir="%TEMP%\\chrome-ur-debug"

  # macOS:
  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-ur-debug

  # Linux:
  google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-ur-debug
`);
    process.exitCode = 1;
  }

  log(`2/3 Checking Mail Hub at ${mailHubUrl} ...`);
  try {
    const res = await fetch(`${mailHubUrl.replace(/\/$/, "")}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    log(`Mail Hub reachable: status=${data.status ?? "ok"} version=${data.version ?? "unknown"}`, "success");
  } catch (e) {
    log(`Mail Hub not running (${e instanceof Error ? e.message : e}) — needed only with --email-provider mailhub`, "warn");
  }

  log(`3/3 Checking Token-Free Gateway at ${tfgUrl} ...`);
  try {
    const res = await fetch(`${tfgUrl.replace(/\/$/, "")}/v1/models`);
    if (!res.ok && res.status !== 401) throw new Error(`HTTP ${res.status}`);
    log(`Token-Free Gateway reachable at ${tfgUrl} (HTTP ${res.status})`, "success");
  } catch (e) {
    log(`Token-Free Gateway not running (${e instanceof Error ? e.message : e}) — start with: make gateway`, "warn");
  }
}

async function cmdPlatforms(engine: RegistrationEngine): Promise<void> {
  const list = engine.listAdapters();
  console.log("\nSupported platforms:\n");
  console.log(
    "  " +
      "ID".padEnd(14) +
      "NAME".padEnd(24) +
      "MODE".padEnd(8) +
      "EMAIL".padEnd(7) +
      "PHONE".padEnd(7) +
      "SIGNUP",
  );
  console.log("  " + "-".repeat(100));
  for (const a of list) {
    console.log(
      "  " +
        a.id.padEnd(14) +
        a.name.padEnd(24) +
        a.preferredMode.padEnd(8) +
        (a.needsEmail ? "yes" : "no").padEnd(7) +
        (a.needsPhone ? "yes" : "no").padEnd(7) +
        a.signupUrl,
    );
  }
  console.log(`
Modes:
  auto   — fully scripted (rare; most sites have captcha)
  semi   — fill forms automatically, you solve captcha/SMS
  manual — you do everything in the browser; tool only captures session

Add custom platforms as JSON under config/platforms/*.json
`);
}

async function cmdRegister(
  engine: RegistrationEngine,
  platform: string,
  flags: Record<string, string | boolean>,
  captureOnly = false,
): Promise<void> {
  const count = Math.max(1, Number(flags.count || 1));
  const concurrency = flags.concurrency ? Number(flags.concurrency) : undefined;
  const maxRetries = flags.retries !== undefined ? Number(flags.retries) : undefined;
  const autoPlan = Boolean(flags["auto-plan"] || flags.autoPlan);
  const mode = flags.mode ? (String(flags.mode) as RegisterMode) : undefined;
  const exportTfg = !flags.noExport;
  const adHocConfig: Partial<GenericPlatformConfig> | undefined =
    flags.url || flags["chat-url"]
      ? {
          signupUrl: flags.url ? String(flags.url) : undefined,
          chatUrl: flags["chat-url"] ? String(flags["chat-url"]) : undefined,
        }
      : undefined;

  if (flags["save-platform"]) {
    const adapter = engine.resolveOrCreateAdapter(platform, adHocConfig);
    if (adapter) {
      const dir = process.env.UR_PLATFORMS_DIR || join(process.cwd(), "config", "platforms");
      const savedPath = saveGenericPlatformConfig(
        {
          id: adapter.id,
          name: adapter.name,
          signupUrl: adapter.signupUrl,
          domains: adapter.domains,
          chatUrl: flags["chat-url"] ? String(flags["chat-url"]) : undefined,
          preferredMode: adapter.preferredMode,
          needsEmail: adapter.needsEmail,
          needsPhone: adapter.needsPhone,
        },
        dir,
      );
      log(`Saved custom platform definition to ${savedPath}`, "success");
    }
  }

  const identity = {
    email: flags.email ? String(flags.email) : undefined,
    password: flags.password ? String(flags.password) : undefined,
    phone: flags.phone ? String(flags.phone) : undefined,
    name: flags.name ? String(flags.name) : undefined,
  };

  if (captureOnly) {
    const acc = await engine.runOne(platform, {
      identity,
      mode: mode ?? "manual",
      captureOnly: true,
      exportTfg,
      adHocConfig,
    });
    console.log("\nResult:", JSON.stringify({
      platform: acc.platformId,
      email: acc.email,
      status: acc.status,
      message: acc.message,
      hasCredentials: !!acc.credentials,
    }, null, 2));
    return;
  }

  if (count === 1 && !autoPlan) {
    const acc = await engine.runOne(platform, { identity, mode, exportTfg, adHocConfig });
    const creds = acc.credentials as Record<string, unknown> | undefined;
    console.log("\nResult:", JSON.stringify({
      platform: acc.platformId,
      email: acc.email,
      password: acc.password,
      status: acc.status,
      message: acc.message,
      hasCredentials: !!acc.credentials,
      authType: creds?.authType,
      apiKey: creds?.apiKey,
      accessToken: creds?.accessToken,
      primarySecret: creds?.primarySecret,
    }, null, 2));
  } else {
    const resolved = engine.resolveOrCreateAdapter(platform, adHocConfig);
    const targetPlatformId = resolved?.id ?? platform;
    const summary = await engine.runBulkWithSummary(targetPlatformId, count, {
      mode,
      exportTfg,
      adHocConfig,
      concurrency,
      maxRetries,
      autoPlan,
      identities: Array.from({ length: count }, (_, i) =>
        i === 0 ? identity : { phone: identity.phone },
      ),
    });
    console.log(
      `\nBulk registration done: ${summary.succeeded}/${summary.totalRequested} succeeded ` +
        `(API keys minted: ${summary.apiKeysMinted}, Bearer tokens: ${summary.bearerTokensCaptured}, duration: ${summary.durationMs}ms)`,
    );
    for (const r of summary.accounts) {
      const creds = r.credentials as Record<string, unknown> | undefined;
      const secretPreview =
        typeof creds?.apiKey === "string"
          ? `apiKey=${creds.apiKey}`
          : typeof creds?.accessToken === "string"
            ? `token=${creds.accessToken.slice(0, 24)}...`
            : "";
      console.log(`  [${r.status}] ${r.email}  ${secretPreview}  ${r.message ?? ""}`);
    }
  }
}

async function cmdDiscover(
  engine: RegistrationEngine,
  positional: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (positional.length === 0) {
    const saved = engine.discoveryStore.load();
    console.log(JSON.stringify(saved, null, 2));
    return;
  }
  const sites = await engine.discoverSites(positional, {
    crawlDirectoryPages: Boolean(flags.crawl),
    concurrency: flags.concurrency ? Number(flags.concurrency) : 4,
  });
  console.log(JSON.stringify(sites, null, 2));
}

async function cmdProbe(
  engine: RegistrationEngine,
  target: string,
): Promise<void> {
  const report = await engine.probeSite(target);
  console.log(JSON.stringify(report, null, 2));
}

async function cmdPlan(
  engine: RegistrationEngine,
  target: string,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const saveDir = flags["save-platform"]
    ? process.env.UR_PLATFORMS_DIR || join(process.cwd(), "config", "platforms")
    : undefined;
  const plan = await engine.planStrategy(target, {
    savePlatformDir: saveDir,
    maxConcurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
  });
  console.log(JSON.stringify(plan, null, 2));
}

async function cmdCredentials(
  engine: RegistrationEngine,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const platformId = flags.platform ? String(flags.platform) : undefined;
  const format = (flags.format ? String(flags.format) : "json") as CredentialExportFormat;
  const outPath = flags.out ? String(flags.out) : undefined;
  const accounts = engine.store.list(platformId);

  if (outPath) {
    const { filePath, bundle } = engine.exportCredentialsFor2Api({
      platformId,
      outputPath: outPath,
      format,
    });
    log(
      `Exported ${bundle.totalAccounts} account(s) (${bundle.totalApiKeys} API keys, ${bundle.totalBearerTokens} tokens) → ${filePath}`,
      "success",
    );
    return;
  }
  console.log(formatCredentialsFor2Api(accounts, format));
}

async function cmdPipeline(
  engine: RegistrationEngine,
  positional: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (positional.length === 0) {
    log("Usage: npx tsx src/index.ts pipeline <url|file>... [--count N] [--concurrency C]", "error");
    process.exitCode = 1;
    return;
  }
  const saveDir = flags["save-platform"]
    ? process.env.UR_PLATFORMS_DIR || join(process.cwd(), "config", "platforms")
    : undefined;
  const result = await engine.runFullPipeline(positional, {
    countPerSite: flags.count ? Number(flags.count) : 1,
    concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
    maxRetries: flags.retries !== undefined ? Number(flags.retries) : undefined,
    minScore: flags["min-score"] ? Number(flags["min-score"]) : 40,
    crawlDirectoryPages: Boolean(flags.crawl),
    savePlatformDir: saveDir,
    credentialsOutputPath: flags.out ? String(flags.out) : undefined,
    exportTfg: !flags.noExport,
  });
  console.log(
    JSON.stringify(
      {
        discoveredCount: result.discovered.length,
        probedCount: result.probes.length,
        plans: result.plans.map((p) => ({
          platformId: p.platformId,
          strategyKind: p.strategyKind,
          route: p.chosenRoute.type,
          score: p.score,
          canBulkRegister: p.canBulkRegister,
        })),
        summaries: result.summaries.map((s) => ({
          platformId: s.platformId,
          succeeded: s.succeeded,
          failed: s.failed,
          apiKeysMinted: s.apiKeysMinted,
          bearerTokensCaptured: s.bearerTokensCaptured,
        })),
        credentialsFilePath: result.credentialsFilePath,
        totalExportedAccounts: result.exportedCredentials.totalAccounts,
        totalApiKeys: result.exportedCredentials.totalApiKeys,
      },
      null,
      2,
    ),
  );
}

async function cmdList(
  engine: RegistrationEngine,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const platform = flags.platform ? String(flags.platform) : undefined;
  const rows = engine.store.list(platform);
  if (!rows.length) {
    log("No accounts saved yet.", "warn");
    return;
  }
  console.log(`\nSaved accounts (${rows.length}) store=${engine.config.storePath}\n`);
  for (const r of rows) {
    console.log(
      `  [${r.status.padEnd(8)}] ${r.platformId.padEnd(12)} ${r.email.padEnd(32)} ${r.createdAt}` +
        (r.message ? `  (${r.message})` : ""),
    );
  }
  console.log("");
}

async function cmdExport(
  engine: RegistrationEngine,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const platform = flags.platform ? String(flags.platform) : undefined;
  const rows = engine.store
    .list(platform)
    .filter((r) => r.status === "success" && r.credentials);

  if (!rows.length) {
    log("No successful accounts with credentials to export.", "warn");
    return;
  }

  // Sort chronologically so all valid accounts are merged into the multi-account pool
  const sorted = [...rows].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  let n = 0;
  for (const r of sorted) {
    exportToTokenFreeGateway(r.platformId, r.credentials, engine.config.tfgStorePath);
    log(`Exported ${r.platformId} (${r.email})`, "success");
    n++;
  }
  log(`Done. ${n} account(s) written to ${engine.config.tfgStorePath}`, "success");
  log("Start gateway: token-free-gateway start");
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv);

  if (command === "help" || command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "doctor") {
    await cmdDoctor(flags);
    return;
  }

  const engine = buildEngine(flags);

  switch (command) {
    case "platforms":
    case "list-platforms":
      await cmdPlatforms(engine);
      break;
    case "discover":
      await cmdDiscover(engine, positional, flags);
      break;
    case "probe": {
      const target = positional[0];
      if (!target) {
        log("Missing target URL or platform id. Try: npx tsx src/index.ts probe https://example.com", "error");
        process.exitCode = 1;
        return;
      }
      await cmdProbe(engine, target);
      break;
    }
    case "plan": {
      const target = positional[0];
      if (!target) {
        log("Missing target URL or platform id. Try: npx tsx src/index.ts plan https://example.com", "error");
        process.exitCode = 1;
        return;
      }
      await cmdPlan(engine, target, flags);
      break;
    }
    case "pipeline":
      await cmdPipeline(engine, positional, flags);
      break;
    case "credentials":
    case "creds":
      await cmdCredentials(engine, flags);
      break;
    case "register":
    case "reg": {
      const platform = positional[0];
      if (!platform) {
        log("Missing platform id. Try: npx tsx src/index.ts platforms", "error");
        process.exitCode = 1;
        return;
      }
      await cmdRegister(engine, platform, flags, false);
      break;
    }
    case "capture":
    case "login": {
      const platform = positional[0];
      if (!platform) {
        log("Missing platform id.", "error");
        process.exitCode = 1;
        return;
      }
      await cmdRegister(engine, platform, flags, true);
      break;
    }
    case "list":
      await cmdList(engine, flags);
      break;
    case "export":
      await cmdExport(engine, flags);
      break;
    default:
      log(`Unknown command: ${command}`, "error");
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
