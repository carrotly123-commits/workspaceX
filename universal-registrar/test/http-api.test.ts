import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRegistrarApiHandler, startRegistrarServer } from "../src/server.ts";

test("Universal Registrar HTTP API controls all 5 stages (discover -> probe -> plan -> bulk register -> credentials)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ur-http-api-test-"));
  try {
    const storePath = join(dir, "accounts.json");
    const tfgStorePath = join(dir, "auth-profiles.json");
    const discoveredSitesPath = join(dir, "discovered.json");
    const credentialsExportPath = join(dir, "credentials-2api.json");

    let inboxSeq = 0;
    const mintedKeys = new Map<string, string>();

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;

      // Mock Mail Hub
      if (url.startsWith("http://mailhub.local/api/inbox") && method === "POST") {
        const id = ++inboxSeq;
        return new Response(
          JSON.stringify({
            id: `ibx_${id}`,
            address: `user_${id}@mailhub.local`,
            provider: "mock",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.startsWith("http://mailhub.local/api/inbox/")) {
        return new Response(null, { status: 204 });
      }

      // Mock target site (OneAPI/NewAPI no-OTP direct protocol site)
      if (url === "https://api.nova-ai.com/api/status") {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              system_name: "Nova AI Relay",
              register_enabled: true,
              email_verification: false,
              turnstile_check: false,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://api.nova-ai.com/api/user/register" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
        return new Response(
          JSON.stringify({
            success: true,
            data: { id: body.username, username: body.username },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://api.nova-ai.com/api/user/login" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              id: body.username,
              username: body.username,
              access_token: `tok_${body.username}_abcdef123456`,
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
      if (url === "https://api.nova-ai.com/api/user/self") {
        const cookie = headers.Cookie ?? "";
        const uname = cookie.match(/session=sess_([^;]+)/)?.[1] ?? "u1";
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              id: uname,
              username: uname,
              access_token: `tok_${uname}_abcdef123456`,
              quota: 500000,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.startsWith("https://api.nova-ai.com/api/token/") && method === "GET") {
        const uid = headers["New-Api-User"] ?? "u1";
        const key = mintedKeys.get(uid);
        return new Response(
          JSON.stringify({
            success: true,
            data: key ? [{ id: 1, key }] : [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.startsWith("https://api.nova-ai.com/api/token/") && method === "POST") {
        const uid = headers["New-Api-User"] ?? "u1";
        mintedKeys.set(uid, `nova_${uid}_99887766554433221100`);
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.startsWith("https://api.nova-ai.com")) {
        return new Response(
          `<html><head><title>Nova AI</title></head><body><a href="/register">Sign up</a><input type="email" name="email"/><input type="password" name="password"/></body></html>`,
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      let updatedCallbackCount = 0;
      const api = createRegistrarApiHandler({
        config: {
          storePath,
          tfgStorePath,
          discoveredSitesPath,
          credentialsExportPath,
          emailProvider: "mailhub",
          mailHubUrl: "http://mailhub.local",
          delayBetweenMs: 0,
          concurrency: 3,
        },
        fetchFn: mockFetch,
        onCredentialsUpdated: () => {
          updatedCallbackCount++;
        },
      });

      // 1. POST /api/registrar/discover
      const discRes = await api.handleRequest(
        new Request("http://localhost/api/registrar/discover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inputs: "https://api.nova-ai.com" }),
        }),
      );
      assert.equal(discRes.status, 200);
      const discJson = await discRes.json();
      assert.equal(discJson.ok, true);
      assert.equal(discJson.sites.length, 1);
      assert.equal(discJson.sites[0].framework, "oneapi");

      // 2. POST /api/registrar/probe
      const probeRes = await api.handleRequest(
        new Request("http://localhost/api/registrar/probe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: "https://api.nova-ai.com" }),
        }),
      );
      assert.equal(probeRes.status, 200);
      const probeJson = await probeRes.json();
      assert.equal(probeJson.report.registrationOpen, true);
      assert.equal(probeJson.report.routes[0].type, "api_oneapi");

      // 3. POST /api/registrar/plan
      const planRes = await api.handleRequest(
        new Request("http://localhost/api/registrar/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: "https://api.nova-ai.com" }),
        }),
      );
      assert.equal(planRes.status, 200);
      const planJson = await planRes.json();
      assert.equal(planJson.plan.strategyKind, "api_protocol");
      assert.ok(planJson.plan.score >= 90);

      // 4. POST /api/registrar/register (bulk 6 accounts)
      const regRes = await api.handleRequest(
        new Request("http://localhost/api/registrar/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            platform: "https://api.nova-ai.com",
            count: 6,
            concurrency: 3,
            autoPlan: true,
          }),
        }),
      );
      assert.equal(regRes.status, 200);
      const regJson = await regRes.json();
      assert.equal(regJson.ok, true);
      assert.equal(regJson.summary.succeeded, 6);
      assert.equal(regJson.summary.apiKeysMinted, 6);
      assert.ok(updatedCallbackCount >= 1);

      // 5. GET /api/registrar/credentials?format=keys
      const credRes = await api.handleRequest(
        new Request("http://localhost/api/registrar/credentials?format=keys"),
      );
      assert.equal(credRes.status, 200);
      const credJson = await credRes.json();
      assert.equal(credJson.bundle.totalAccounts, 6);
      assert.equal(credJson.bundle.totalApiKeys, 6);
      const keyLines = String(credJson.content).trim().split("\n");
      assert.equal(keyLines.length, 6);
      assert.ok(keyLines.every((k) => k.startsWith("sk-nova_")));

      // 6. GET /api/registrar/status
      const statusRes = await api.handleRequest(
        new Request("http://localhost/api/registrar/status"),
      );
      const statusJson = await statusRes.json();
      assert.equal(statusJson.stats.successAccountsCount, 6);
      assert.equal(statusJson.stats.apiKeysCount, 6);
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Standalone startRegistrarServer listens on ephemeral port and serves status API", async () => {
  const srv = await startRegistrarServer({ port: 0, host: "127.0.0.1" });
  try {
    assert.ok(srv.port > 0);
    const res = await fetch(`http://${srv.host}:${srv.port}/api/registrar/status`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean; service: string };
    assert.equal(data.ok, true);
    assert.equal(data.service, "universal-registrar");
  } finally {
    await srv.close();
  }
});
