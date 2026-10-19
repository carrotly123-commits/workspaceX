import { demoReport, parseReport, stages } from "./report.js";

const $ = (id) => document.getElementById(id);
let report = null;
let stage = "discovery";
let selected = null;
let isDemo = false;
let loadVersion = 0;
function element(tag, className, text) {
	const el = document.createElement(tag);
	if (className) el.className = className;
	if (text !== undefined) el.textContent = text;
	return el;
}
function empty(container, heading, hint) {
	const block = element("div", "empty");
	block.append(
		element("span", "empty-symbol", "◇"),
		element("h3", "", heading),
		element("p", "", hint),
	);
	container.replaceChildren(block);
}
function render() {
	$("export").disabled = !report;
	$("clear").disabled = !report;
	$("report-source").textContent = !report
		? "尚未导入报告"
		: isDemo
			? "示例数据 · 非真实执行结果"
			: "已导入本地报告 · 原始凭证不会展示";
	$("report-source").className = isDemo ? "demo-label" : "";
	for (const [id, kind] of [
		["metric-sites", "discovery"],
		["metric-plans", "plan"],
		["metric-accounts", "registration"],
		["metric-creds", "credentials"],
	]) {
		const count =
			kind === "registration"
				? report?.rows.filter((row) => row.stage === kind && row.title === "账号结果").length
				: report?.counts[kind];
		$(id).textContent = report ? String(count ?? 0) : "—";
	}
	$("stages").replaceChildren(
		...stages.map((value, index) => {
			const button = element("button", `stage ${stage === value.id ? "active" : ""}`);
			button.type = "button";
			button.setAttribute("aria-pressed", String(stage === value.id));
			button.append(element("span", "stage-index", `0${index + 1}`));
			const copy = element("span", "stage-copy");
			copy.append(element("strong", "", value.name), element("small", "", value.hint));
			button.append(copy, element("span", "stage-count", String(report?.counts[value.id] ?? "—")));
			button.addEventListener("click", () => {
				stage = value.id;
				selected = null;
				$("search").value = "";
				render();
				$("stages").children[index].focus();
			});
			return button;
		}),
	);
	renderRecords();
}
function renderRecords() {
	$("records-title").textContent = stages.find((value) => value.id === stage).name;
	const query = $("search").value.trim().toLowerCase();
	const all = report?.rows.filter((row) => row.stage === stage) ?? [];
	const rows = all.filter((row) =>
		`${row.site} ${row.status} ${row.title}`.toLowerCase().includes(query),
	);
	$("records-count").textContent = report
		? `${rows.length} / ${all.length} 条记录 · 仅当前报告`
		: "尚无报告记录";
	if (!rows.some((row) => row.id === selected)) selected = rows[0]?.id ?? null;
	if (!rows.length) {
		empty(
			$("records"),
			!report ? "先导入一份报告" : query ? "没有匹配的记录" : "此阶段没有报告记录",
			!report
				? "选择本地 JSON，或查看示例了解五阶段流程。"
				: query
					? "尝试其他站点或状态关键词。"
					: "缺少记录不代表阶段失败或已完成。",
		);
	} else {
		$("records").replaceChildren(
			...rows.map((row) => {
				const button = element("button", `record ${row.id === selected ? "selected" : ""}`);
				button.type = "button";
				button.setAttribute("aria-pressed", String(row.id === selected));
				const icon = element("span", "record-icon", row.stage === "credentials" ? "⌁" : "↗");
				const copy = element("span", "record-copy");
				copy.append(element("strong", "", row.site), element("small", "", row.title));
				button.append(
					icon,
					copy,
					element("span", `badge ${row.reportedFailure ? "danger" : ""}`, row.status),
				);
				button.addEventListener("click", () => {
					selected = row.id;
					renderRecords();
					$("records").querySelector('[aria-pressed="true"]')?.focus();
				});
				return button;
			}),
		);
	}
	renderDetail(rows.find((row) => row.id === selected));
}
function renderDetail(row) {
	if (!row) {
		empty($("detail"), "尚未选择记录", "站点信息、状态和凭证类型将在这里展示。");
		return;
	}
	const heading = element("h3", "detail-site", row.site);
	const badge = element("span", "badge", row.status);
	const dl = element("dl", "facts");
	for (const [label, value] of row.facts) {
		const pair = element("div", "fact");
		pair.append(element("dt", "", label), element("dd", "", value));
		dl.append(pair);
	}
	$("detail").replaceChildren(heading, badge, dl);
	if (row.stage === "credentials")
		$("detail").append(
			element("p", "safe-note", "密钥、Token 与请求头内容已隐藏。本页不会使用这些凭证发送请求。"),
		);
}
function apply(next, demo) {
	report = next;
	isDemo = demo;
	selected = null;
	stage = stages.find((value) => next.counts[value.id] > 0)?.id ?? "discovery";
	$("search").value = "";
	$("import-error").hidden = true;
	render();
}
$("import").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async () => {
	const file = $("file").files[0];
	if (!file) return;
	const version = ++loadVersion;
	try {
		if (file.size > 5 * 1024 * 1024) throw new Error("文件过大，请使用 5 MB 以内的 JSON 报告。");
		const next = parseReport(await file.text());
		if (version === loadVersion) apply(next, false);
	} catch (error) {
		if (version === loadVersion) {
			$("import-error").textContent = `${error.message} 当前报告未被替换。`;
			$("import-error").hidden = false;
		}
	} finally {
		if (version === loadVersion) $("file").value = "";
	}
});
$("demo").addEventListener("click", () => {
	loadVersion++;
	$("file").value = "";
	apply(demoReport(), true);
});
$("clear").addEventListener("click", () => {
	loadVersion++;
	report = null;
	isDemo = false;
	selected = null;
	stage = "discovery";
	$("file").value = "";
	$("search").value = "";
	$("import-error").hidden = true;
	render();
});
$("search").addEventListener("input", renderRecords);
$("export").addEventListener("click", () => {
	if (!report) return;
	const blob = new Blob(
		[JSON.stringify({ kind: "registrar-redacted-review", demo: isDemo, ...report }, null, 2)],
		{ type: "application/json" },
	);
	const url = URL.createObjectURL(blob);
	const link = element("a");
	link.href = url;
	link.download = "registrar-redacted-summary.json";
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
});
render();
