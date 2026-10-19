import { describe, expect, test } from "bun:test";
import { demoReport, parseReport, safeOrigin } from "../src/public/registrar/report.js";

const origin = "https://fixture.example";
const parse = (value: unknown) => parseReport(JSON.stringify(value));
const site = {
	id: "fixture",
	url: origin,
	origin,
	framework: "newapi",
	reachable: true,
	signupCandidates: [`${origin}/register`],
	apiBaseCandidates: [`${origin}/v1`],
};
const route = {
	type: "browser_email_otp",
	endpointOrUrl: `${origin}/register`,
	requiresEmailVerification: true,
	requiresPhone: false,
	requiresInviteCode: true,
	captchaType: "turnstile",
	feasibilityScore: 64,
};
const probe = {
	platformId: "fixture",
	siteUrl: origin,
	origin,
	signupUrl: `${origin}/register`,
	framework: "newapi",
	registrationOpen: true,
	routes: [route],
	detectedSelectors: {},
};
const plan = {
	platformId: "fixture",
	siteUrl: origin,
	signupUrl: `${origin}/register`,
	strategyKind: "browser_semi",
	chosenRoute: route,
	score: 64,
	canBulkRegister: false,
};
const credential = {
	origin,
	apiBaseUrl: `${origin}/v1?key=NEVER_SHOW_QUERY`,
	authType: "api_key",
	apiKey: "NEVER_SHOW_KEY",
	primarySecret: "NEVER_SHOW_SECRET",
	accessToken: "NEVER_SHOW_TOKEN",
	refreshToken: "NEVER_SHOW_REFRESH",
	readyHeaders: { Authorization: "NEVER_SHOW_HEADER" },
	cookie: "NEVER_SHOW_COOKIE",
	email: "NEVER_SHOW_EMAIL",
	password: "NEVER_SHOW_PASSWORD",
	quality: "high",
	qualityReason: "NEVER_SHOW_REASON",
};
const account = {
	platformId: "fixture",
	status: "success",
	email: "NEVER_SHOW_EMAIL",
	password: "NEVER_SHOW_PASSWORD",
	credentials: credential,
	message: "NEVER_SHOW_MESSAGE",
};

describe("registrar #2 report contracts", () => {
	test("discovery array and stored envelope use apiBaseCandidates", () => {
		for (const report of [parse([site]), parse({ version: 1, sites: [site] })]) {
			expect(report.counts.discovery).toBe(1);
			expect(report.rows[0]?.facts).toContainEqual(["API 候选入口", "1"]);
		}
	});
	test("probe reads route-level constraints, not inferred top-level flags", () => {
		const report = parse(probe);
		expect(report.counts.probe).toBe(1);
		expect(report.rows[0]?.facts).toContainEqual(["验证码限制", "需要人工处理"]);
		expect(report.rows[0]?.facts).toContainEqual(["邀请限制", "需要人工处理"]);
		expect(report.rows[0]?.facts).toContainEqual(["手机验证", "未检出（不保证没有）"]);
	});
	test("plan uses strategyKind/score and labels score as not a success rate", () => {
		const report = parse(plan);
		expect(report.counts.plan).toBe(1);
		expect(report.rows[0]?.status).toBe("浏览器半自动");
		expect(report.rows[0]?.facts).toContainEqual(["可行性评分", "64 / 100（非成功率）"]);
	});
	test("pipeline CLI projections do not fabricate discovery/account/credential rows", () => {
		const report = parse({
			discoveredCount: 3,
			probedCount: 2,
			plans: [
				{
					platformId: "fixture",
					strategyKind: "browser_semi",
					route: "browser_email_otp",
					score: 64,
					canBulkRegister: false,
				},
			],
			summaries: [
				{
					platformId: "fixture",
					succeeded: 1,
					failed: 1,
					apiKeysMinted: 1,
					bearerTokensCaptured: 0,
				},
			],
			credentialsFilePath: "NEVER_SHOW_PATH",
			totalExportedAccounts: 1,
			totalApiKeys: 1,
		});
		expect(report.counts).toEqual({
			discovery: 0,
			probe: 0,
			plan: 1,
			registration: 1,
			credentials: 0,
		});
		expect(report.totals).toEqual({ discovered: 3, probed: 2, exportedAccounts: 1, apiKeys: 1 });
		expect(report.rows[0]?.facts).toContainEqual(["建议途径", "邮箱验证码"]);
		expect(report.rows[0]?.site).toBe("平台 · fixture");
		expect(report.rows[1]?.site).toBe("平台 · fixture");
		expect(JSON.stringify(report)).not.toContain("NEVER_SHOW");
	});
	test("full bulk summaries contain individual outcomes without counting summary as an account", () => {
		const report = parse({
			totalRequested: 2,
			succeeded: 1,
			failed: 1,
			apiKeysMinted: 1,
			bearerTokensCaptured: 1,
			accounts: [account, { status: "failed" }],
		});
		expect(report.rows.filter((row) => row.title === "账号结果")).toHaveLength(2);
		expect(report.rows.filter((row) => row.reportedSuccess)).toHaveLength(1);
		expect(report.rows.filter((row) => row.reportedFailure)).toHaveLength(1);
		expect(report.counts.credentials).toBe(1);
	});
	test("account store awaiting states and legacy unverified status are preserved", () => {
		const report = parse({
			version: 1,
			accounts: [
				account,
				{ status: "awaiting_human" },
				{ status: "awaiting_captcha" },
				{ status: "unverified" },
			],
		});
		expect(report.rows.map((row) => row.status)).toContain("等待人工");
		expect(report.rows.map((row) => row.status)).toContain("等待验证码");
		expect(report.rows.map((row) => row.status)).toContain("未验证");
		expect(JSON.stringify(report)).not.toContain("NEVER_SHOW");
	});
	test("2API export bundles and flat export accounts are redacted; high quality is not verified", () => {
		const exported = { ...credential, platformId: "fixture" };
		for (const report of [
			parse([exported]),
			parse({
				version: 1,
				totalAccounts: 1,
				totalApiKeys: 1,
				platforms: {
					fixture: {
						origin,
						apiKeys: ["NEVER_SHOW_ARRAY"],
						bearerTokens: ["NEVER_SHOW_ARRAY"],
						accounts: [exported],
					},
				},
			}),
		]) {
			expect(report.counts.credentials).toBe(1);
			expect(report.counts.registration).toBe(0);
			expect(report.rows[0]?.status).toBe("未验证调用");
			expect(report.rows[0]?.facts).toContainEqual(["报告质量评级", "高"]);
			expect(JSON.stringify(report)).not.toContain("NEVER_SHOW");
		}
	});
	test("URLs strip userinfo and token-bearing path/query/fragment and reject active schemes", () => {
		expect(
			safeOrigin("https://user:NEVER_SHOW@fixture.example/NEVER_SHOW?key=NEVER_SHOW#NEVER_SHOW"),
		).toBe(origin);
		expect(safeOrigin("javascript:alert('NEVER_SHOW')")).toBe("未提供站点");
		expect(safeOrigin("file:///private/key")).toBe("未提供站点");
	});
	test("unknown enums and injected names/messages cannot enter rendered or exported data", () => {
		const report = parse([
			{ ...site, title: "<script>NEVER_SHOW</script>", framework: "<script>NEVER_SHOW</script>" },
			{ ...plan, strategyKind: "<img src=x onerror=NEVER_SHOW>", reasoning: ["NEVER_SHOW"] },
			{ ...account, status: "<script>NEVER_SHOW</script>" },
		]);
		expect(JSON.stringify(report)).not.toContain("NEVER_SHOW");
	});
	test("empty recognized reports are valid, invalid/mixed/unknown data are not", () => {
		expect(parse([]).rows).toHaveLength(0);
		expect(parse({ version: 1, accounts: [] }).rows).toHaveLength(0);
		for (const raw of ["log line\n[]", "{", "null", '{"unknown":true}', "42"])
			expect(() => parseReport(raw)).toThrow();
	});
	test("file size and row count have explicit limits", () => {
		expect(() => parseReport(" ".repeat(5 * 1024 * 1024 + 1))).toThrow("5 MB");
		expect(() => parse(Array.from({ length: 2001 }, () => site))).toThrow("2,000");
	});
	test("demo exercises all five phases and contains no usable credentials", () => {
		const report = demoReport();
		for (const count of Object.values(report.counts)) expect(count).toBeGreaterThan(0);
		expect(JSON.stringify(report)).not.toContain("synthetic-demo-not-a-real-key");
	});
});
