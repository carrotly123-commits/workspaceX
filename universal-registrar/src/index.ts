#!/usr/bin/env node
/**
 * Universal Registrar — CLI
 *
 * Commands:
 *   platforms                         List built-in + custom platforms
 *   register <platform> [options]     Register one or more accounts
 *   capture  <platform>               Only capture an already-logged-in session
 *   list [--platform id]              List saved accounts
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
  register <platform|url> [opts]    Register account(s) on a built-in or any new URL/channel
  capture  <platform|url>           Capture session from already-logged-in browser for any channel
  list [--platform <id>]            Show saved accounts
  export [--platform <id>]          Push credentials into token-free-gateway store
  doctor                            Verify Chrome CDP is reachable

Register options:
  --count <n>                       How many accounts (default 1, max 20)
  --mode <auto|semi|manual>         Override adapter preferred mode
  --url <signupUrl>                 Signup/login URL for onboarding a new channel on the fly
  --chat-url <chatUrl>              Chat page URL for token-free-gateway (defaults to URL origin)
  --save-platform                   Save this new channel into config/platforms/<id>.json
  --email <addr>                    Use this email (skip pool/manual acquire)
  --password <pwd>                  Use this password
  --phone <num>                     Phone number for SMS platforms
  --name <display>                  Display name
  --no-export                       Do not write token-free-gateway auth-profiles
  --email-provider <manual|file|mailtm|mailhub>
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
  const count = Math.max(1, Math.min(20, Number(flags.count || 1)));
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

  if (count === 1) {
    const acc = await engine.runOne(platform, { identity, mode, exportTfg, adHocConfig });
    console.log("\nResult:", JSON.stringify({
      platform: acc.platformId,
      email: acc.email,
      password: acc.password,
      status: acc.status,
      message: acc.message,
      hasCredentials: !!acc.credentials,
    }, null, 2));
  } else {
    const resolved = engine.resolveOrCreateAdapter(platform, adHocConfig);
    const targetPlatformId = resolved?.id ?? platform;
    const results = await engine.runBatch(targetPlatformId, count, {
      mode,
      exportTfg,
      identities: Array.from({ length: count }, (_, i) =>
        i === 0 ? identity : { phone: identity.phone },
      ),
    });
    const ok = results.filter((r) => r.status === "success").length;
    console.log(`\nBatch done: ${ok}/${results.length} succeeded`);
    for (const r of results) {
      console.log(`  [${r.status}] ${r.email}  ${r.message ?? ""}`);
    }
  }
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
