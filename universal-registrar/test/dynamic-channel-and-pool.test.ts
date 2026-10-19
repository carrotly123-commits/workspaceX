import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistrationEngine } from "../src/core/engine.ts";
import { createAdHocAdapter, deriveDomainsFromUrl } from "../src/platforms/generic.ts";
import { exportToTokenFreeGateway, loadTfgStore } from "../src/export/tfg.ts";

test("deriveDomainsFromUrl and createAdHocAdapter infer channel metadata from raw URL or domain", () => {
  const info = deriveDomainsFromUrl("https://chat.acme-ai.com/signup");
  assert.equal(info.origin, "https://chat.acme-ai.com");
  assert.equal(info.hostname, "chat.acme-ai.com");
  assert.equal(info.rootDomain, "acme-ai.com");
  assert.equal(info.inferredId, "acme-ai");

  const adapter = createAdHocAdapter("https://chat.acme-ai.com/signup");
  assert.equal(adapter.id, "acme-ai");
  assert.equal(adapter.signupUrl, "https://chat.acme-ai.com/signup");
  assert.deepEqual(adapter.domains, ["chat.acme-ai.com", "acme-ai.com"]);
});

test("RegistrationEngine.resolveOrCreateAdapter dynamically creates adapter for unknown URL or --url", () => {
  const engine = new RegistrationEngine();
  const byUrl = engine.resolveOrCreateAdapter("https://chat.newchannel.io/register");
  assert.ok(byUrl);
  assert.equal(byUrl.id, "newchannel");
  assert.equal(engine.getAdapter("newchannel"), byUrl);

  const byCustomId = engine.resolveOrCreateAdapter("my-private-llm", {
    signupUrl: "https://llm.internal.example.org/login",
  });
  assert.ok(byCustomId);
  assert.equal(byCustomId.id, "my-private-llm");
  assert.equal(byCustomId.signupUrl, "https://llm.internal.example.org/login");
});

test("exportToTokenFreeGateway accumulates multiple accounts into profile.accounts pool", () => {
  const storePath = join(tmpdir(), `ur-tfg-pool-${process.pid}-${Date.now()}.json`);
  try {
    exportToTokenFreeGateway(
      "deepseek",
      { email: "user1@example.com", cookie: "ds_session=111", startUrl: "https://chat.deepseek.com" },
      storePath,
    );
    exportToTokenFreeGateway(
      "deepseek",
      { email: "user2@example.com", cookie: "ds_session=222", startUrl: "https://chat.deepseek.com" },
      storePath,
    );
    // Re-exporting user1 updates existing entry rather than duplicating
    exportToTokenFreeGateway(
      "deepseek",
      { email: "user1@example.com", cookie: "ds_session=111_refreshed", startUrl: "https://chat.deepseek.com" },
      storePath,
    );

    const store = loadTfgStore(storePath);
    const profile = store.profiles.deepseek;
    assert.ok(profile);
    assert.equal(profile.accounts?.length, 2);
    assert.equal(
      (profile.accounts?.[0]?.credentials as { cookie: string }).cookie,
      "ds_session=111_refreshed",
    );
    assert.equal(
      (profile.accounts?.[1]?.credentials as { cookie: string }).cookie,
      "ds_session=222",
    );
  } finally {
    if (existsSync(storePath)) rmSync(storePath);
  }
});
