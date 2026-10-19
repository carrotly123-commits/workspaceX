import test from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { verifySession, targetOrigins } from "../src/core/session-verification.ts";
import { GenericAdapter, createAdHocAdapter } from "../src/platforms/generic.ts";
import type { RegisterContext } from "../src/core/types.ts";

const criteria = { signupUrl: "https://chat.example.com/login", successCookie: "session" };
function fixture(options: { url?: string; cookies?: Array<Record<string, unknown>>; visible?: boolean[]; invalid?: boolean } = {}): Page {
  return {
    url: () => options.url ?? "https://chat.example.com/chat",
    context: () => ({ cookies: async () => options.cookies ?? [] }),
    locator: () => {
      if (options.invalid) throw new Error("invalid selector");
      return {
        count: async () => options.visible?.length ?? 0,
        nth: (index: number) => ({ isVisible: async () => options.visible?.[index] }),
      };
    },
  } as unknown as Page;
}
const sessionCookie = { name: "session", value: "local-test-only", httpOnly: true, expires: -1 };

test("missing success criteria never means logged in", async () => {
  assert.equal((await verifySession(fixture({ cookies: [sessionCookie] }), { signupUrl: criteria.signupUrl })).verified, false);
});
test("exact HttpOnly cookie is accepted, substring/analytics/expired/empty cookies are not", async () => {
  assert.equal((await verifySession(fixture({ cookies: [sessionCookie] }), criteria)).verified, true);
  for (const cookie of [
    { ...sessionCookie, name: "not-session" }, { ...sessionCookie, name: "analytics" },
    { ...sessionCookie, expires: 1 }, { ...sessionCookie, value: "" },
  ]) assert.equal((await verifySession(fixture({ cookies: [cookie] }), criteria)).verified, false);
});
test("identity-provider, sibling, and lookalike origins cannot be captured", async () => {
  for (const url of ["https://github.com/login", "https://chat.example.com.evil.test", "https://other.example.com", "http://chat.example.com"]) {
    assert.equal((await verifySession(fixture({ url, cookies: [sessionCookie] }), criteria)).verified, false);
  }
});
test("selector checks all matches and all configured criteria must pass", async () => {
  const both = { ...criteria, successSelector: "[data-account-menu]" };
  assert.equal((await verifySession(fixture({ cookies: [sessionCookie], visible: [false, true] }), both)).verified, true);
  assert.equal((await verifySession(fixture({ visible: [true] }), both)).verified, false);
  assert.equal((await verifySession(fixture({ cookies: [sessionCookie], visible: [false] }), both)).verified, false);
  assert.equal((await verifySession(fixture({ invalid: true }), { signupUrl: criteria.signupUrl, successSelector: "[" })).verified, false);
});
test("target URLs reject embedded secrets, non-web schemes, and GitHub capture", () => {
  for (const signupUrl of ["file:///tmp/x", "https://user:password@example.com", "https://github.com", "https://api.github.com"]) {
    assert.throws(() => targetOrigins({ signupUrl }));
  }
});
test("ad hoc options do not erase inferred URL with undefined properties", () => {
  const adapter = createAdHocAdapter("https://chat.example.com/login", { signupUrl: undefined, successCookie: "session" });
  assert.equal(adapter.signupUrl, criteria.signupUrl);
  assert.equal(adapter.cfg.successCookie, "session");
});
test("generic registration and capture refuse missing evidence without opening a browser", async () => {
  const adapter = new GenericAdapter({ id: "test", signupUrl: criteria.signupUrl });
  const ctx = { identity: { email: "fixture@example.com", password: "" }, mode: "manual" } as RegisterContext;
  for (const result of [await adapter.register(ctx), await adapter.captureSession(ctx)]) {
    assert.equal(result.status, "unverified");
    assert.equal(result.success, false);
    assert.equal(result.credentials, undefined);
  }
});
test("GitHub auto mode refuses authorization before browser actions", async () => {
  const adapter = new GenericAdapter({ id: "test", ...criteria, authMethod: "github" });
  assert.equal(adapter.needsEmail, false);
  const result = await adapter.register({ identity: { email: "fixture", password: "" }, mode: "auto" } as RegisterContext);
  assert.equal(result.success, false);
  assert.match(result.message!, /user/);
});
