import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearAccountCooldowns,
	getAccountPool,
	getCredentials,
	getStorePath,
	loadAuthStore,
	markAccountCooldown,
	saveCredentials,
	selectAccount,
} from "../src/providers/auth-store.ts";
import { listAllModels, resolveModelToProvider } from "../src/providers/registry.ts";

const TEST_STORE_PATH = join(tmpdir(), `tfg-test-auth-${process.pid}.json`);

beforeAll(() => {
	process.env.TFG_STORE_PATH = TEST_STORE_PATH;
});

afterAll(() => {
	delete process.env.TFG_STORE_PATH;
	if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH);
});

afterEach(() => {
	clearAccountCooldowns();
	const storePath = getStorePath();
	if (existsSync(storePath)) rmSync(storePath);
});

describe("auth-store", () => {
	test("loadAuthStore returns empty profiles when no file exists", () => {
		const store = loadAuthStore();
		expect(store.profiles).toEqual({});
	});

	test("saveCredentials and getCredentials round-trip", () => {
		saveCredentials("test-provider", { token: "abc123" });
		const creds = getCredentials<{ token: string }>("test-provider");
		expect(creds).toBeDefined();
		expect(creds?.token).toBe("abc123");
	});

	test("getCredentials returns null for unknown provider", () => {
		expect(getCredentials("nonexistent")).toBeNull();
	});

	test("saveCredentials overwrites existing", () => {
		saveCredentials("test-provider", { v: 1 });
		saveCredentials("test-provider", { v: 2 });
		const creds = getCredentials<{ v: number }>("test-provider");
		expect(creds?.v).toBe(2);
	});

	test("multiple providers", () => {
		saveCredentials("a", { key: "aaa" });
		saveCredentials("b", { key: "bbb" });
		expect(getCredentials<{ key: string }>("a")?.key).toBe("aaa");
		expect(getCredentials<{ key: string }>("b")?.key).toBe("bbb");
	});

	test("multi-account pool round-robin and cooldown failover", () => {
		saveCredentials("deepseek-web", { email: "a1@test.com", token: "t1" });
		saveCredentials("deepseek-web", { email: "a2@test.com", token: "t2" });
		saveCredentials("deepseek-web", { email: "a3@test.com", token: "t3" });

		const pool = getAccountPool("deepseek-web");
		expect(pool).toHaveLength(3);

		// Round-robin cycles through a1 -> a2 -> a3 -> a1
		expect(selectAccount<{ token: string }>("deepseek-web")?.credentials.token).toBe("t1");
		expect(selectAccount<{ token: string }>("deepseek-web")?.credentials.token).toBe("t2");
		expect(selectAccount<{ token: string }>("deepseek-web")?.credentials.token).toBe("t3");
		expect(selectAccount<{ token: string }>("deepseek-web")?.credentials.token).toBe("t1");

		// Mark a2 and a3 on cooldown -> only a1 should be selected
		markAccountCooldown("deepseek-web", "a2@test.com", 60_000);
		markAccountCooldown("deepseek-web", "a3@test.com", 60_000);
		expect(selectAccount<{ token: string }>("deepseek-web")?.accountId).toBe("a1@test.com");
		expect(selectAccount<{ token: string }>("deepseek-web")?.accountId).toBe("a1@test.com");
	});

	test("resolves provider alias without -web suffix and auto-discovers zero-config channels", async () => {
		// Saved under registrar's "deepseek" id, queried via gateway's "deepseek-web"
		saveCredentials("deepseek", { email: "u@test.com", cookie: "c=1" });
		expect(getCredentials<{ cookie: string }>("deepseek-web")?.cookie).toBe("c=1");

		// Brand-new channel saved with startUrl metadata is auto-discovered by registry
		saveCredentials("my-new-ai", {
			cookie: "sid=xyz",
			startUrl: "https://chat.my-new-ai.org",
			providerName: "My New AI",
		});

		expect(await resolveModelToProvider("my-new-ai")).toBe("my-new-ai");
		expect(await resolveModelToProvider("my-new-ai/default")).toBe("my-new-ai");

		const models = await listAllModels();
		expect(models.some((m) => m.id === "my-new-ai")).toBe(true);
	});
});
