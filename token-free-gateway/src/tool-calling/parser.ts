/**
 * Parse tool calls from web model text responses.
 *
 * Migrated from openclaw-zero-token web-tool-parser.ts.
 * Supports multiple formats (tried in order):
 * 1. Fenced: ```tool_json\n{"tool":"...","parameters":{...}}\n```
 * 2. Bare JSON: {"tool":"...","parameters":{...}}
 * 3. XML: <tool_call>{"name":"...","arguments":{...}}</tool_call>
 * 4. OpenAI-native: {"tool_calls":[{"name":"...","arguments":{...}}]}
 */

export interface ParsedToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

const FENCED_REGEX = /```tool_json\s*\n?\s*(\{[\s\S]*\})\s*\n?\s*```/;
const BARE_JSON_REGEX = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*(\{[\s\S]*?\})\s*\}/;
const XML_TOOL_REGEX = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/;
const OPENAI_TOOL_CALLS_REGEX =
	/\{\s*"tool_calls"\s*:\s*\[\s*(\{[\s\S]*?\})\s*(?:,[\s\S]*?)?\]\s*\}/;

export function extractToolCalls(text: string): ParsedToolCall[] {
	// Try extracting multiple XML tool_calls first
	const xmlMatches = [...text.matchAll(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/g)];
	if (xmlMatches.length > 0) {
		const calls: ParsedToolCall[] = [];
		for (const match of xmlMatches) {
			const parsed = parseToolJson(match[1] ?? "");
			if (parsed) calls.push(parsed);
		}
		if (calls.length > 0) return calls;
	}

	// Try single extraction
	const single = extractSingleToolCall(text);
	return single ? [single] : [];
}

export function extractSingleToolCall(text: string): ParsedToolCall | null {
	// 1. Fenced code block
	const fenced = FENCED_REGEX.exec(text);
	if (fenced?.[1]) return parseToolJson(fenced[1]);

	// 2. OpenAI-style tool_calls array
	const openai = OPENAI_TOOL_CALLS_REGEX.exec(text);
	if (openai?.[1]) return parseToolJson(openai[1]);

	// 3. Bare JSON with tool/parameters
	const bare = BARE_JSON_REGEX.exec(text);
	if (bare?.[1] && bare?.[2]) {
		try {
			return { name: bare[1], arguments: JSON.parse(bare[2]) };
		} catch {
			return null;
		}
	}

	// 4. XML format
	const xml = XML_TOOL_REGEX.exec(text);
	if (xml?.[1]) return parseToolJson(xml[1]);

	// 5. Fuzzy repair: truncated JSON
	const fuzzy = text.match(/\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*\{([^}]*)\}/);
	if (fuzzy?.[1] && fuzzy?.[2] !== undefined) {
		const repaired = `{"tool":"${fuzzy[1]}","parameters":{${fuzzy[2]}}}`;
		return parseToolJson(repaired);
	}

	return null;
}

function parseToolJson(raw: string): ParsedToolCall | null {
	try {
		let cleaned = raw.trim();
		// Auto-repair unbalanced braces
		const opens = (cleaned.match(/\{/g) || []).length;
		const closes = (cleaned.match(/\}/g) || []).length;
		if (opens > closes) {
			cleaned += "}".repeat(opens - closes);
		}

		const obj = JSON.parse(cleaned);

		// Format: {"tool":"name","parameters":{...}}
		if (typeof obj.tool === "string") {
			return { name: obj.tool, arguments: obj.parameters ?? {} };
		}
		// Format: {"name":"...","arguments":{...}}
		if (typeof obj.name === "string") {
			return { name: obj.name, arguments: obj.arguments ?? {} };
		}

		return null;
	} catch {
		return null;
	}
}

export function hasToolCall(text: string): boolean {
	return (
		FENCED_REGEX.test(text) ||
		BARE_JSON_REGEX.test(text) ||
		XML_TOOL_REGEX.test(text) ||
		OPENAI_TOOL_CALLS_REGEX.test(text)
	);
}

const CONFIRMED_TOOL_START_RE = /```tool_json|<tool_call[\s>]|^\s*\{\s*"(?:tool|tool_calls)"\s*:/;

const POTENTIAL_PREFIXES = [
	"```tool_json",
	"<tool_call",
	'{"tool"',
	'{"tool_calls"',
	'{ "tool"',
	'{ "tool_calls"',
];

/**
 * Incremental streaming filter for tool calls.
 *
 * Immediately forwards normal assistant text deltas via `onContentDelta` for low TTFT,
 * while holding back potential tool-call prefixes (`<tool_call`, ```` ```tool_json ````,
 * `{"tool":`) and buffering confirmed tool-call blocks so they can be parsed into
 * structured `tool_calls` at stream end.
 */
export class StreamingToolCallFilter {
	private fullText = "";
	private pending = "";
	private emittedContent = "";
	private capturingTool = false;

	constructor(private readonly onContentDelta: (delta: string) => void) {}

	push(delta: string): void {
		if (!delta) return;
		this.fullText += delta;
		if (this.capturingTool) {
			return;
		}
		this.pending += delta;
		this.drainPending();
	}

	private drainPending(): void {
		const fenceIdx = this.pending.indexOf("```tool_json");
		const xmlIdx = this.pending.indexOf("<tool_call");
		const jsonMatch =
			this.emittedContent.trim().length === 0
				? /^\s*\{\s*"(?:tool|tool_calls)"\s*:/.exec(this.pending)
				: null;

		let earliestToolIdx = -1;
		for (const idx of [fenceIdx, xmlIdx, jsonMatch ? jsonMatch.index : -1]) {
			if (idx >= 0 && (earliestToolIdx === -1 || idx < earliestToolIdx)) {
				earliestToolIdx = idx;
			}
		}

		if (earliestToolIdx >= 0) {
			const before = this.pending.slice(0, earliestToolIdx);
			if (before) {
				this.emittedContent += before;
				this.onContentDelta(before);
			}
			this.pending = this.pending.slice(earliestToolIdx);
			this.capturingTool = true;
			return;
		}

		const holdLen = this.computeHoldLength(this.pending);
		const safeLen = this.pending.length - holdLen;
		if (safeLen > 0) {
			const toEmit = this.pending.slice(0, safeLen);
			this.pending = this.pending.slice(safeLen);
			this.emittedContent += toEmit;
			this.onContentDelta(toEmit);
		}
	}

	private computeHoldLength(buf: string): number {
		if (this.emittedContent.trim().length === 0 && /^\s*\{\s*(?:"[a-z_]*)?$/i.test(buf)) {
			return buf.length;
		}
		let maxHold = 0;
		const tailMax = Math.min(buf.length, 16);
		for (let len = 1; len <= tailMax; len++) {
			const suffix = buf.slice(buf.length - len);
			for (const prefix of POTENTIAL_PREFIXES) {
				if (prefix.startsWith(suffix)) {
					if (len > maxHold) maxHold = len;
				}
			}
		}
		return maxHold;
	}

	finish(): {
		fullText: string;
		emittedContent: string;
		unemittedTail: string;
		capturedToolBlock: boolean;
	} {
		const capturedToolBlock = this.capturingTool || CONFIRMED_TOOL_START_RE.test(this.pending);
		return {
			fullText: this.fullText,
			emittedContent: this.emittedContent,
			unemittedTail: this.pending,
			capturedToolBlock,
		};
	}
}
