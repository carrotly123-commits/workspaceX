import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { GenericAdapter } from "../src/platforms/generic.ts";
import { semiAutoSignupFlow } from "../src/platforms/base.ts";
import type { RegisterContext } from "../src/core/types.ts";

const cdp = process.env.UR_TEST_CDP_URL;
const origin = process.env.UR_TEST_ORIGIN;

test("controlled-browser GitHub entry, callback, evidence failure, and ambiguity", { skip: !cdp || !origin }, async () => {
  const target = new URL(origin!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "Use a local fixture origin only");
  const browser = await chromium.connectOverCDP(cdp!);
  const context = browser.contexts()[0]!;
  const existingPages = new Set(context.pages());
  const route = `${target.origin}/__ur-fixture/**`;
  let variant: "callback" | "popup" | "duplicate" = "callback";
  let captured = false;
  let harvested = false;
  await context.route(route, async intercepted => {
    const pathname = new URL(intercepted.request().url()).pathname;
    const action = variant === "popup"
      ? "window.open('/__ur-fixture/callback', '_blank')"
      : "location.href='/__ur-fixture/callback'";
    await intercepted.fulfill({
      contentType: "text/html",
      body: pathname.endsWith("callback")
        ? '<main data-account-menu>Local simulated account</main>'
        : `<button hidden>Continue with GitHub</button><a href="https://github.com/example/repository">GitHub source</a><button onclick="${action}">Continue with GitHub</button>${variant === "duplicate" ? '<button>使用 GitHub 登录</button>' : ''}`,
    });
  });
  const config = { id: "fixture", signupUrl: `${target.origin}/__ur-fixture/login`, successCookie: "ur_oauth_fixture", successSelector: "[data-account-menu]", authMethod: "github" as const };
  const ctx: RegisterContext = {
    identity: { email: "local-fixture", password: "" }, mode: "semi", cdpUrl: cdp!, headless: true, timeoutMs: 3000,
    onProgress: () => {},
    askHuman: async () => {
      const callback = context.pages().find(page => page.url().endsWith("/__ur-fixture/callback"));
      assert.ok(callback, "The target callback must be reached before evidence is checked");
      await context.addCookies([{ name: "ur_oauth_fixture", value: "synthetic-only", url: target.origin, httpOnly: true }]);
      captured = true;
      return "";
    },
  };
  try {
    const adapter = new GenericAdapter(config);
    for (const flow of ["callback", "popup"] as const) {
      variant = flow;
      captured = false;
      const result = await adapter.register(ctx);
      assert.equal(result.success, true, result.message);
      assert.equal(captured, true);
      assert.match(String(result.credentials?.cookie), /ur_oauth_fixture=/);
      assert.deepEqual(result.credentials?.verification, { level: "login-evidence", chatTested: false });
    }
    const failed = await new GenericAdapter({ ...config, successSelector: "[data-missing-login-proof]" }).register(ctx);
    assert.equal(failed.status, "unverified");
    assert.equal(failed.credentials, undefined);
    variant = "duplicate";
    captured = false;
    const ambiguous = await adapter.register(ctx);
    assert.equal(ambiguous.success, false);
    assert.match(ambiguous.message!, /Found 2/);
    assert.equal(captured, false);

    const failedDetector = await semiAutoSignupFlow(adapter, { ...ctx, mode: "manual", askHuman: async () => "" }, {
      openForm: async () => {}, fillForm: async () => {}, submit: async () => {},
      isSuccess: async () => false,
      harvest: async () => { harvested = true; return { cookie: "must-not-export" }; },
    });
    assert.equal(failedDetector.status, "unverified");
    assert.equal(harvested, false);
  } finally {
    await context.unroute(route);
    await context.clearCookies({ name: "ur_oauth_fixture" });
    for (const page of context.pages()) if (!existingPages.has(page)) await page.close();
    await browser.close();
  }
});
