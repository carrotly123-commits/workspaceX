import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistrationEngine } from "../src/core/engine.ts";
import { GenericAdapter } from "../src/platforms/generic.ts";
import type { PlatformAdapter } from "../src/core/types.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "registrar-reliability-"));
  const tfg = join(dir, "gateway.json");
  const engine = new RegistrationEngine({ storePath: join(dir, "accounts.json"), tfgStorePath: tfg }, {
    ask: async () => { throw new Error("Unexpected human prompt"); }, onProgress: () => {},
  });
  return { dir, engine, tfg };
}

test("unverified results persist but are not exported even if adapter reports success", async () => {
  const { dir, engine, tfg } = setup();
  try {
    engine.registerAdapter({
      id: "fixture", name: "Fixture", signupUrl: "https://fixture.example", domains: ["fixture.example"],
      preferredMode: "semi", needsEmail: false, needsPhone: false,
      register: async ctx => ({ success: true, status: "unverified", identity: ctx.identity, credentials: { cookie: "fixture-only" } }),
    } satisfies PlatformAdapter);
    const result = await engine.runOne("fixture", { identity: { email: "fixture@example.com" } });
    assert.equal(result.status, "unverified");
    assert.equal(result.credentials, undefined);
    assert.equal(existsSync(tfg), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("generic preflight fails before email allocation or account storage", async () => {
  const { dir, engine, tfg } = setup();
  try {
    await assert.rejects(engine.runOne("https://fixture.example/login"), /success-cookie/);
    assert.equal(engine.store.list().length, 0);
    assert.equal(existsSync(tfg), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("overrides apply to an already-loaded generic adapter without losing selectors", () => {
  const { dir, engine } = setup();
  try {
    engine.registerAdapter(new GenericAdapter({ id: "fixture", signupUrl: "https://fixture.example", selectors: { email: ["#email"] }, successCookie: "session" }));
    const resolved = engine.resolveOrCreateAdapter("fixture", { authMethod: "github", successCookie: undefined });
    assert.ok(resolved instanceof GenericAdapter);
    assert.equal(resolved.cfg.authMethod, "github");
    assert.equal(resolved.cfg.successCookie, "session");
    assert.deepEqual(resolved.cfg.selectors, { email: ["#email"] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("capture does not acquire a mailbox or generate a password", async () => {
  const { dir, engine } = setup();
  try {
    engine.registerAdapter({
      id: "fixture", name: "Fixture", signupUrl: "https://fixture.example", domains: ["fixture.example"], preferredMode: "manual", needsEmail: true, needsPhone: false,
      register: async () => { throw new Error("Must not register"); },
      captureSession: async ctx => {
        assert.equal(ctx.email, undefined);
        assert.equal(ctx.identity.password, "");
        return { success: false, status: "unverified", identity: ctx.identity };
      },
    });
    await engine.runOne("fixture", { captureOnly: true, identity: { email: "existing-account" } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
