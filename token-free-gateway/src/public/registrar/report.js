export const stages = [
	{ id: "discovery", name: "网站发现", hint: "候选不等于已接入" },
	{ id: "probe", name: "途径探测", hint: "识别注册方式与限制" },
	{ id: "plan", name: "策略选择", hint: "评分不代表成功率" },
	{ id: "registration", name: "注册结果", hint: "按报告记录，不推断成功" },
	{ id: "credentials", name: "凭证摘要", hint: "已采集不等于可调用" },
];
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);
const number = (value) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const present = (value) => typeof value === "string" && value.trim().length > 0;
const enumLabel = (value, labels) => (Object.hasOwn(labels, value) ? labels[value] : "未提供");
const platformLabel = (value) =>
	typeof value === "string" && /^[a-z][a-z0-9._-]{0,63}$/i.test(value) && !/^(sk-|eyJ)/.test(value)
		? value
		: null;
const routeLabels = {
	api_oneapi: "OneAPI 协议",
	api_rest: "REST 接口",
	api_supabase: "Supabase 接口",
	browser_email_direct: "邮箱 + 密码",
	browser_email_otp: "邮箱验证码",
	browser_phone_sms: "手机短信",
	oauth_only: "OAuth 授权",
	closed: "未开放注册",
};
const frameworks = {
	oneapi: "OneAPI",
	newapi: "NewAPI",
	voapi: "VoAPI",
	supabase: "Supabase",
	clerk: "Clerk",
	nextauth: "NextAuth",
	generic_ai: "通用 AI 站点",
	unknown: "未知",
};
const modes = {
	api_protocol: "协议方式",
	browser_auto: "浏览器自动",
	browser_semi: "浏览器半自动",
	manual: "人工操作",
	skip: "跳过",
};
const states = {
	pending: "等待中",
	running: "进行中",
	awaiting_human: "等待人工",
	awaiting_email: "等待邮箱",
	awaiting_sms: "等待短信",
	awaiting_captcha: "等待验证码",
	success: "报告成功",
	failed: "报告失败",
	skipped: "已跳过",
	unverified: "未验证",
};
const qualities = { high: "高", medium: "中", low: "低" };
const authTypes = {
	api_key: "API Key",
	bearer_token: "Bearer Token",
	cookie_session: "网页会话",
	custom_header: "自定义请求头",
};

// Only keep an origin. Paths, queries and fragments can carry authentication secrets.
export function safeOrigin(value) {
	try {
		const url = new URL(value);
		return ["https:", "http:"].includes(url.protocol) ? url.origin : "未提供站点";
	} catch {
		return "未提供站点";
	}
}

export function parseReport(text) {
	if (typeof text !== "string" || new TextEncoder().encode(text).length > 5 * 1024 * 1024)
		throw new Error("文件过大，请使用 5 MB 以内的 JSON 报告。");
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("无法解析 JSON。请使用完整 JSON 报告，不要混入终端日志、keys 或 env 格式。");
	}
	const rows = [];
	let recognized = false;
	let credentialIndex = 0;
	const add = (stage, site, title, status, facts, extra = {}) => {
		if (rows.length >= 2000) throw new Error("报告超过 2,000 条展示记录，请拆分文件后导入。");
		rows.push({
			id: String(rows.length),
			stage,
			site:
				safeOrigin(site) === "未提供站点" && extra.platform
					? `平台 · ${extra.platform}`
					: safeOrigin(site),
			title,
			status,
			facts,
			...extra,
		});
	};
	const credentials = (value, origin) => {
		if (!object(value)) return;
		const known = [
			"authType",
			"apiKey",
			"accessToken",
			"primarySecret",
			"cookie",
			"bearer",
			"readyHeaders",
			"sessionToken",
		].some((key) => Object.hasOwn(value, key));
		if (!known) return;
		credentialIndex++;
		const keys = present(value.apiKey);
		const bearer = present(value.accessToken) || present(value.bearer);
		const cookie = present(value.cookie) || present(value.sessionToken);
		add(
			"credentials",
			value.origin || value.apiBaseUrl || value.startUrl || origin,
			`凭证记录 ${credentialIndex}`,
			"未验证调用",
			[
				["认证类型", enumLabel(value.authType, authTypes)],
				["API Key", keys ? "已提供 · 已隐藏" : "未提供"],
				["Access Token", bearer ? "已提供 · 已隐藏" : "未提供"],
				["Refresh Token", present(value.refreshToken) ? "已提供 · 已隐藏" : "未提供"],
				["网页会话", cookie ? "已提供 · 已隐藏" : "未提供"],
				[
					"请求头",
					object(value.readyHeaders) && Object.keys(value.readyHeaders).length
						? "已提供 · 不展示内容"
						: "未提供",
				],
				["报告质量评级", enumLabel(value.quality, qualities)],
				["接口站点", safeOrigin(value.apiBaseUrl)],
				["独立调用验证", "报告未提供调用验收证据"],
			],
			{ hasApiKey: keys, hasBearer: bearer, platform: platformLabel(value.platformId) },
		);
	};
	const account = (value, origin) => {
		if (!object(value)) return;
		if (typeof value.status === "string") {
			recognized = true;
			add(
				"registration",
				value.credentials?.origin || value.credentials?.startUrl || origin,
				"账号结果",
				enumLabel(value.status, states),
				[
					["账号标识", "隐私信息已隐藏"],
					["状态", enumLabel(value.status, states)],
					["凭证记录", object(value.credentials) ? "已附带（需单独验证）" : "未附带"],
				],
				{
					platform: platformLabel(value.platformId),
					reportedSuccess: value.status === "success",
					reportedFailure: value.status === "failed",
				},
			);
			credentials({ ...value.credentials, platformId: value.platformId }, origin);
		} else if (typeof value.authType === "string" || Object.hasOwn(value, "primarySecret")) {
			recognized = true;
			credentials(value, origin);
		}
	};
	const probe = (value) => {
		recognized = true;
		const routes = list(value.routes);
		const barrier = (key, match) =>
			routes.length
				? routes.some((route) => object(route) && match(route[key]))
					? "需要人工处理"
					: "未检出（不保证没有）"
				: "未提供";
		add(
			"probe",
			value.siteUrl || value.origin,
			"注册途径报告",
			routes.length ? `${routes.length} 条途径` : "无途径记录",
			[
				["检测框架", enumLabel(value.framework, frameworks)],
				[
					"注册开放",
					value.registrationOpen === true
						? "报告开放"
						: value.registrationOpen === false
							? "报告未开放"
							: "未提供",
				],
				[
					"注册途径",
					routes.map((route) => enumLabel(route?.type, routeLabels)).join(" / ") || "未提供",
				],
				[
					"验证码限制",
					barrier("captchaType", (value) => typeof value === "string" && value !== "none"),
				],
				["邮箱验证", barrier("requiresEmailVerification", (value) => value === true)],
				["手机验证", barrier("requiresPhone", (value) => value === true)],
				["邀请限制", barrier("requiresInviteCode", (value) => value === true)],
			],
		);
	};
	const plan = (value) => {
		recognized = true;
		const score = number(value.score);
		add(
			"plan",
			value.signupUrl || value.platformConfig?.signupUrl,
			"策略评估",
			enumLabel(value.strategyKind, modes),
			[
				["建议方式", enumLabel(value.strategyKind, modes)],
				["建议途径", enumLabel(value.chosenRoute?.type || value.route, routeLabels)],
				["可行性评分", score !== null && score <= 100 ? `${score} / 100（非成功率）` : "未提供"],
				[
					"是否适合批量",
					value.canBulkRegister === true
						? "报告建议支持 · 未验证"
						: value.canBulkRegister === false
							? "报告不建议"
							: "未提供",
				],
				["注意", "建议仅供审阅；本页不执行注册任务"],
			],
			{ platform: platformLabel(value.platformId) },
		);
	};
	const site = (value) => {
		recognized = true;
		add(
			"discovery",
			value.url || value.origin,
			"候选站点",
			value.reachable === true
				? "报告可访问"
				: value.reachable === false
					? "报告不可访问"
					: "未探测",
			[
				["检测框架", enumLabel(value.framework, frameworks)],
				[
					"可访问性",
					value.reachable === true
						? "报告可访问"
						: value.reachable === false
							? "报告不可访问"
							: "未提供",
				],
				["注册入口", String(list(value.signupCandidates).length)],
				["API 候选入口", String(list(value.apiBaseCandidates).length)],
				["兼容性线索", value.openAiCompatible === true ? "检测到线索 · 未验证对话" : "未确认"],
			],
		);
	};
	const summary = (value) => {
		recognized = true;
		const count = (key) => (number(value[key]) === null ? "未提供" : String(value[key]));
		add(
			"registration",
			value.origin,
			"批次摘要",
			"报告汇总",
			[
				["请求账号数", count("totalRequested")],
				["报告成功", count("succeeded")],
				["报告失败", count("failed")],
				["API Key 数", count("apiKeysMinted")],
				["Bearer Token 数", count("bearerTokensCaptured")],
				["说明", "汇总数量来自报告，不代表凭证调用通过"],
			],
			{ platform: platformLabel(value.platformId) },
		);
		for (const item of list(value.accounts)) account(item, value.origin);
	};
	const entry = (value) => {
		if (!object(value)) return;
		if (
			Array.isArray(value.routes) &&
			(typeof value.siteUrl === "string" || typeof value.origin === "string")
		)
			probe(value);
		else if (typeof value.strategyKind === "string") plan(value);
		else if (Object.hasOwn(value, "totalRequested") && Array.isArray(value.accounts))
			summary(value);
		else if (
			typeof value.url === "string" &&
			(Object.hasOwn(value, "reachable") || Object.hasOwn(value, "framework"))
		)
			site(value);
		else account(value);
	};
	if (Array.isArray(raw)) {
		recognized = raw.length === 0;
		for (const value of raw) entry(value);
	} else if (object(raw)) {
		if (Array.isArray(raw.sites)) {
			recognized = true;
			for (const value of raw.sites) if (object(value)) site(value);
		}
		if (Array.isArray(raw.accounts)) {
			recognized = true;
			if (Object.hasOwn(raw, "totalRequested")) summary(raw);
			else for (const value of raw.accounts) account(value);
		}
		if (Array.isArray(raw.plans) || Array.isArray(raw.summaries)) {
			recognized = true;
			for (const value of list(raw.plans)) if (object(value)) plan(value);
			for (const value of list(raw.summaries)) if (object(value)) summary(value);
		}
		if (object(raw.platforms)) {
			recognized = true;
			for (const platform of Object.values(raw.platforms)) {
				if (!object(platform)) continue;
				for (const value of list(platform.accounts))
					account(value, platform.origin || platform.apiBaseUrl);
			}
		}
		if (!recognized) entry(raw);
	}
	if (!recognized)
		throw new Error(
			"未识别的报告结构。支持 #2 的发现、探测、策略、pipeline 汇总、账号存储及凭证 JSON。",
		);
	return {
		version: 1,
		totals: {
			discovered: object(raw) ? number(raw.discoveredCount) : null,
			probed: object(raw) ? number(raw.probedCount) : null,
			exportedAccounts: object(raw) ? number(raw.totalExportedAccounts ?? raw.totalAccounts) : null,
			apiKeys: object(raw) ? number(raw.totalApiKeys) : null,
		},
		rows,
		counts: Object.fromEntries(
			stages.map((stage) => [stage.id, rows.filter((row) => row.stage === stage.id).length]),
		),
	};
}

export function demoReport() {
	const origin = "https://demo.example.com";
	return parseReport(
		JSON.stringify([
			{
				url: origin,
				framework: "newapi",
				reachable: true,
				signupCandidates: [`${origin}/register`],
				apiBaseCandidates: [`${origin}/v1`],
				openAiCompatible: true,
			},
			{
				siteUrl: origin,
				framework: "newapi",
				routes: [
					{
						type: "browser_email_otp",
						captchaType: "turnstile",
						requiresEmailVerification: true,
						requiresPhone: false,
					},
					{ type: "oauth_only", captchaType: "none", requiresPhone: false },
				],
				registrationOpen: true,
			},
			{
				signupUrl: `${origin}/register`,
				strategyKind: "browser_semi",
				chosenRoute: { type: "browser_email_otp" },
				score: 64,
				canBulkRegister: false,
			},
			{
				totalRequested: 2,
				succeeded: 1,
				failed: 1,
				apiKeysMinted: 1,
				bearerTokensCaptured: 0,
				origin,
				accounts: [
					{
						status: "success",
						credentials: {
							origin,
							apiBaseUrl: `${origin}/v1`,
							authType: "api_key",
							apiKey: "synthetic-demo-not-a-real-key",
							quality: "high",
						},
					},
					{ status: "failed" },
				],
			},
		]),
	);
}
