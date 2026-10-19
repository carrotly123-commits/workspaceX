import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildMeaningfulCredentials,
  extractSecretsFromJsonPayload,
  provisionApiKeyViaProtocol,
} from "../src/core/credentials.ts";
import {
  discoverExternalSites,
  extractCandidateUrlsFromText,
} from "../src/core/discovery.ts";
import { RegistrationEngine } from "../src/core/engine.ts";
import { selectOptimalStrategy } from "../src/core/planner.ts";
import {
  analyzeRegistrationHtml,
  probeSiteRegistrationRoutes,
} from "../src/core/prober.ts";
import {
  build2ApiCredentialBundle,
  formatCredentialsFor2Api,
} from "../src/export/credentials-export.ts";

test("Phase 1 (Discovery): extracts external AI sites from directory HTML/Markdown and identifies frameworks", async () => {
  const directoryHtml = `
    <html>
      <body>
        <h1>AI Relay Directory</h1>
        <a href="https://relay-alpha.example.com/register">Alpha AI Relay (立即注册)</a>
        <a href="https://chat-beta.example.org">Beta Web Chat</a>
        <a href="https://github.com/songquanpeng/one-api">GitHub Repo (ignored)</a>
        <img src="https://relay-alpha.example.com/logo.png" />
      </body>
    </html>
  `;

  const urls = extractCandidateUrlsFromText(directoryHtml, {
    baseUrl: "https://directory.example.net",
  });
  assert.ok(urls.includes("https://relay-alpha.example.com/register"));
  assert.ok(urls.includes("https://chat-beta.example.org/"));
  assert.ok(!urls.some((u) => u.includes("github.com")));
  assert.ok(!urls.some((u) => u.endsWith(".png")));

  const mockFetch: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://directory.example.net") {
      return new Response(directoryHtml, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    if (url.startsWith("https://relay-alpha.example.com/api/status")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            system_name: "Alpha NewAPI",
            register_enabled: true,
            email_verification: false,
            turnstile_check: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.startsWith("https://relay-alpha.example.com")) {
      return new Response(
        `<html><head><title>Alpha NewAPI</title></head><body><a href="/register">注册</a></body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }
    if (url.startsWith("https://chat-beta.example.org/v1/models")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith("https://chat-beta.example.org")) {
      return new Response(
        `<html><head><title>Beta Chat</title></head><body><a href="/signup">Sign up</a></body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }
    return new Response("Not Found", { status: 404 });
  };

  const sites = await discoverExternalSites(["https://directory.example.net"], {
    crawlDirectoryPages: true,
    fetchFn: mockFetch,
    onProgress: () => {},
  });

  assert.equal(sites.length, 2);
  const alpha = sites.find((s) => s.origin === "https://relay-alpha.example.com");
  const beta = sites.find((s) => s.origin === "https://chat-beta.example.org");
  assert.ok(alpha);
  assert.equal(alpha.framework, "newapi");
  assert.equal(alpha.openAiCompatible, true);
  assert.ok(alpha.signupCandidates.includes("https://relay-alpha.example.com/register"));

  assert.ok(beta);
  assert.equal(beta.openAiCompatible, true);
  assert.ok(beta.signupCandidates.includes("https://chat-beta.example.org/signup"));
});

test("Phase 2 & 3 (Probing & Optimal Strategy Selection): ranks protocol API above browser OTP and CAPTCHA routes", async () => {
  const signupFormHtml = `
    <html>
      <body>
        <form>
          <input id="user-email" type="email" name="email" placeholder="请输入邮箱" />
          <input id="user-name" type="text" name="username" placeholder="用户名" />
          <input id="user-pass" type="password" name="password" placeholder="密码" />
          <input id="verify-code" type="text" name="verification_code" placeholder="邮箱验证码" />
          <button id="send-code-btn" type="button">发送验证码</button>
          <button id="submit-btn" type="submit">立即注册</button>
        </form>
      </body>
    </html>
  `;

  const htmlAnalysis = analyzeRegistrationHtml(signupFormHtml);
  assert.equal(htmlAnalysis.hasEmailField, true);
  assert.equal(htmlAnalysis.hasPasswordField, true);
  assert.equal(htmlAnalysis.hasCodeField, true);
  assert.equal(htmlAnalysis.hasSendCodeButton, true);
  assert.deepEqual(htmlAnalysis.selectors.email, ["#user-email"]);
  assert.deepEqual(htmlAnalysis.selectors.password, ["#user-pass"]);
  assert.deepEqual(htmlAnalysis.selectors.code, ["#verify-code"]);

  const mockFetch: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/status")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            system_name: "FastAI Hub",
            register_enabled: true,
            email_verification: true,
            turnstile_check: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(signupFormHtml, { status: 200, headers: { "Content-Type": "text/html" } });
  };

  const report = await probeSiteRegistrationRoutes("https://fastai.example.com", {
    fetchFn: mockFetch,
    onProgress: () => {},
  });

  assert.equal(report.registrationOpen, true);
  assert.equal(report.framework, "oneapi");
  assert.equal(report.credentialHints.supportsApiKeyCreation, true);
  assert.ok(report.routes.length >= 2);
  assert.equal(report.routes[0]!.type, "api_oneapi");

  const plan = selectOptimalStrategy(report);
  assert.equal(plan.strategyKind, "api_protocol");
  assert.equal(plan.mode, "auto");
  assert.equal(plan.canBulkRegister, true);
  assert.ok(plan.score >= 85);
  assert.equal(plan.protocolEndpoints?.registerUrl, "https://fastai.example.com/api/user/register");
  assert.equal(plan.protocolEndpoints?.tokenUrl, "https://fastai.example.com/api/token/");
});

test("Phase 4 & 5 (Bulk Registration & Meaningful Credentials): runs >20 concurrent registrations, mints sk-... keys, and exports 2API bundles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ur-pipeline-test-"));
  try {
    const storePath = join(dir, "accounts.json");
    const tfgPath = join(dir, "auth-profiles.json");
    const discoveredPath = join(dir, "discovered.json");
    const credsPath = join(dir, "credentials-2api.json");
    const seedFile = join(dir, "seeds.txt");

    writeFileSync(seedFile, "https://api.openhub.com/register\n", "utf-8");

    let userCounter = 0;
    const mintedKeysByUser = new Map<string, string>();

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;

      // 1. Mail Hub inbox allocation & message polling
      if (url.startsWith("http://mailhub.local/api/inbox") && method === "POST") {
        const idx = ++userCounter;
        return new Response(
          JSON.stringify({
            id: `inbox_${idx}`,
            address: `bot_${idx}@mailhub.local`,
            provider: "mock",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("http://mailhub.local/api/inbox/") && url.endsWith("/messages")) {
        return new Response(
          JSON.stringify({
            messages: [{ id: "m1", from: "noreply@openhub.com", subject: "Code", receivedAt: Date.now() }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("http://mailhub.local/api/inbox/") && url.includes("/messages/m1")) {
        return new Response(
          JSON.stringify({
            id: "m1",
            from: "noreply@openhub.com",
            subject: "Verification Code",
            text: "Your verification code is 654321",
            receivedAt: Date.now(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.startsWith("http://mailhub.local/api/inbox/")) {
        return new Response(null, { status: 204 });
      }

      // 2. Target external AI site (OneAPI/NewAPI compatible)
      if (url === "https://api.openhub.com/api/status") {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              system_name: "OpenHub AI",
              register_enabled: true,
              email_verification: true,
              turnstile_check: false,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.startsWith("https://api.openhub.com/api/verification")) {
        return new Response(
          JSON.stringify({ success: true, message: "Verification code sent" }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": "pre_session=verify_ok; Path=/",
            },
          },
        );
      }
      if (url === "https://api.openhub.com/api/user/register" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
        assert.equal(body.verification_code, "654321");
        return new Response(
          JSON.stringify({
            success: true,
            message: "registered",
            data: { username: body.username, email: body.email },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://api.openhub.com/api/user/login" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
        const uid = body.username.replace(/[^0-9a-zA-Z]/g, "").slice(-6) || "101";
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              id: uid,
              username: body.username,
              access_token: `access_tok_${uid}_${body.username}`,
              quota: 500000,
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": `session=sess_${body.username}; Path=/; HttpOnly`,
            },
          },
        );
      }
      if (url === "https://api.openhub.com/api/user/self") {
        const cookie = headers.Cookie ?? "";
        const m = cookie.match(/session=sess_([^;]+)/);
        const uname = m?.[1] ?? "user";
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              id: uname,
              username: uname,
              access_token: `sys_tok_${uname}_1234567890`,
              quota: 500000,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.startsWith("https://api.openhub.com/api/token/") && method === "GET") {
        const uid = headers["New-Api-User"] ?? "anon";
        const existingKey = mintedKeysByUser.get(uid);
        return new Response(
          JSON.stringify({
            success: true,
            data: existingKey ? [{ id: 1, name: "auto-2api", key: existingKey }] : [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.startsWith("https://api.openhub.com/api/token/") && method === "POST") {
        const uid = headers["New-Api-User"] ?? "anon";
        const rawKey = `openhub_${uid}_9876543210abcdef12345678`;
        mintedKeysByUser.set(uid, rawKey);
        return new Response(
          JSON.stringify({ success: true, message: "created" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.startsWith("https://api.openhub.com")) {
        return new Response(
          `<html><head><title>OpenHub AI</title></head><body><input type="email" name="email"/><input type="password" name="password"/></body></html>`,
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      const engine = new RegistrationEngine(
        {
          storePath,
          tfgStorePath: tfgPath,
          discoveredSitesPath: discoveredPath,
          credentialsExportPath: credsPath,
          emailProvider: "mailhub",
          mailHubUrl: "http://mailhub.local",
          delayBetweenMs: 0,
          concurrency: 5,
        },
        { onProgress: () => {} },
      );

      // Run full 5-stage pipeline for 25 accounts (> old 20 limit) with concurrency=5
      const pipelineResult = await engine.runFullPipeline([seedFile], {
        countPerSite: 25,
        concurrency: 5,
        credentialsOutputPath: credsPath,
        fetchFn: mockFetch,
      });

      assert.equal(pipelineResult.discovered.length, 1);
      assert.equal(pipelineResult.plans.length, 1);
      assert.equal(pipelineResult.plans[0]!.strategyKind, "api_protocol");
      assert.equal(pipelineResult.summaries.length, 1);

      const summary = pipelineResult.summaries[0]!;
      assert.equal(summary.totalRequested, 25);
      assert.equal(summary.succeeded, 25);
      assert.equal(summary.failed, 0);
      assert.equal(summary.apiKeysMinted, 25);
      assert.equal(summary.highQualityCredentials, 25);

      // Verify exported 2API credentials bundle on disk
      assert.ok(existsSync(credsPath));
      const exportedJson = JSON.parse(readFileSync(credsPath, "utf-8"));
      assert.equal(exportedJson.totalAccounts, 25);
      assert.equal(exportedJson.totalApiKeys, 25);

      const platformPool = exportedJson.platforms.openhub;
      assert.ok(platformPool);
      assert.equal(platformPool.count, 25);
      assert.equal(platformPool.apiKeys.length, 25);
      assert.equal(platformPool.apiBaseUrl, "https://api.openhub.com/v1");

      for (const acct of platformPool.accounts) {
        assert.equal(acct.authType, "api_key");
        assert.ok(acct.apiKey.startsWith("sk-openhub_"));
        assert.equal(acct.primarySecret, acct.apiKey);
        assert.equal(acct.readyHeaders.Authorization, `Bearer ${acct.apiKey}`);
        assert.ok(acct.accessToken.startsWith("sys_tok_"));
        assert.equal(acct.quality, "high");
      }

      // Verify keys, jsonl, and env export formats
      const savedAccounts = engine.store.list("openhub");
      const keysTxt = formatCredentialsFor2Api(savedAccounts, "keys");
      assert.equal(keysTxt.split("\n").length, 25);
      assert.ok(keysTxt.split("\n").every((line) => line.startsWith("sk-openhub_")));

      const envTxt = formatCredentialsFor2Api(savedAccounts, "env");
      assert.ok(envTxt.includes("OPENHUB_API_BASE=https://api.openhub.com/v1"));
      assert.ok(envTxt.includes("OPENHUB_API_KEYS=sk-openhub_"));
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 5 (Credential Extraction): extracts nested tokens, JWTs, and sk- keys from JSON payloads and storage", async () => {
  const sniffed = extractSecretsFromJsonPayload(
    {
      code: 200,
      data: {
        user: { id: 42, username: "alice", quota: 100000 },
        session: {
          access_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0MiJ9.signature123456",
          refresh_token: "ref_998877665544332211",
        },
      },
    },
    "https://api.example.com/api/user/login",
  );

  assert.equal(sniffed.userId, "42");
  assert.equal(sniffed.username, "alice");
  assert.equal(sniffed.quota, 100000);
  assert.ok(sniffed.accessToken?.startsWith("eyJhbGci"));
  assert.equal(sniffed.refreshToken, "ref_998877665544332211");

  const creds = buildMeaningfulCredentials({
    email: "alice@example.com",
    origin: "https://api.example.com",
    userAgent: "Mozilla/5.0",
    cookies: [{ name: "session", value: "s_123" }],
    localStorage: {
      "openai-store": JSON.stringify({ apiKey: "sk-proj-1234567890abcdefghijklmnop" }),
    },
    sniffed,
  });

  assert.ok(creds);
  assert.equal(creds.authType, "api_key");
  assert.equal(creds.apiKey, "sk-proj-1234567890abcdefghijklmnop");
  assert.equal(creds.primarySecret, "sk-proj-1234567890abcdefghijklmnop");
  assert.equal(creds.accessToken, sniffed.accessToken);
  assert.equal(creds.refreshToken, "ref_998877665544332211");
  assert.equal(creds.readyHeaders.Authorization, "Bearer sk-proj-1234567890abcdefghijklmnop");
  assert.equal(creds.readyHeaders["New-Api-User"], "42");
  assert.equal(creds.quality, "high");

  const bundle = build2ApiCredentialBundle([
    {
      platformId: "example",
      email: "alice@example.com",
      password: "pw",
      status: "success",
      credentials: creds,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ]);
  assert.equal(bundle.totalAccounts, 1);
  assert.equal(bundle.totalApiKeys, 1);
  assert.equal(bundle.totalBearerTokens, 1);
});

test("Phase 5 (Protocol Key Provisioning): provisions sk- key when /api/token initially returns empty list", async () => {
  let created = false;
  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/user/self")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: { id: 88, username: "bob", access_token: "bob_system_token_123456", quota: 250000 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/api/token/") && method === "GET") {
      return new Response(
        JSON.stringify({
          success: true,
          data: created ? { items: [{ key: "abcd1234efgh5678ijkl9012mnop3456" }] } : { items: [] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/api/token/") && method === "POST") {
      created = true;
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  };

  const res = await provisionApiKeyViaProtocol({
    origin: "https://newapi.example.com",
    cookieString: "session=xyz",
    fetchFn: mockFetch,
  });

  assert.equal(res.userId, "88");
  assert.equal(res.username, "bob");
  assert.equal(res.accessToken, "bob_system_token_123456");
  assert.equal(res.apiKey, "sk-abcd1234efgh5678ijkl9012mnop3456");
});
