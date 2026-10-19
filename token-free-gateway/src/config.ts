import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface GatewayConfig {
	port: number;
	host: string;
	gatewayApiKey: string | undefined;
	cdpUrl: string;
	/** Per-request timeout in seconds for the /v1/chat/completions route. */
	requestTimeoutSec: number;
}

interface ConfigFile {
	port?: number;
	host?: string;
	apiKey?: string;
	cdpUrl?: string;
	requestTimeoutSec?: number;
}

const DEFAULTS: Required<ConfigFile> = {
	port: 3456,
	host: "127.0.0.1",
	apiKey: "",
	cdpUrl: "http://127.0.0.1:9222",
	requestTimeoutSec: 300,
};

export const CONFIG_FILE_PATH = join(homedir(), ".token-free-gateway", "config.json");

function loadConfigFile(): ConfigFile {
	try {
		if (existsSync(CONFIG_FILE_PATH)) {
			const raw = readFileSync(CONFIG_FILE_PATH, "utf-8");
			return JSON.parse(raw) as ConfigFile;
		}
	} catch {
		// ignore malformed or unreadable config file
	}
	return {};
}

/**
 * Ensure config file exists and contains all known fields.
 * - If the file is missing, create it with all defaults.
 * - If the file exists but is missing fields added in newer versions,
 *   back-fill them so users can discover and edit every option.
 */
export function ensureConfigFile(): void {
	try {
		mkdirSync(dirname(CONFIG_FILE_PATH), { recursive: true });

		if (!existsSync(CONFIG_FILE_PATH)) {
			writeFileSync(CONFIG_FILE_PATH, `${JSON.stringify(DEFAULTS, null, 2)}\n`, "utf-8");
			console.log(`Created default config: ${CONFIG_FILE_PATH}`);
			return;
		}

		const raw = readFileSync(CONFIG_FILE_PATH, "utf-8");
		const existing = JSON.parse(raw) as Record<string, unknown>;
		let patched = false;
		for (const [key, value] of Object.entries(DEFAULTS)) {
			if (!(key in existing)) {
				existing[key] = value;
				patched = true;
			}
		}
		if (patched) {
			writeFileSync(CONFIG_FILE_PATH, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
			console.log(`Updated config with new fields: ${CONFIG_FILE_PATH}`);
		}
	} catch {
		// non-fatal: config file is optional
	}
}

/**
 * Load gateway configuration.
 *
 * Priority (highest to lowest):
 *   1. TFG_* environment variables
 *   2. <homedir>/.token-free-gateway/config.json
 *   3. Built-in defaults
 */
export function loadConfig(): GatewayConfig {
	const file = loadConfigFile();
	return {
		port: Number.parseInt(process.env.TFG_PORT ?? String(file.port ?? DEFAULTS.port), 10),
		host: process.env.TFG_HOST?.trim() || file.host?.trim() || DEFAULTS.host,
		// `||` rather than `??`: an empty TFG_API_KEY (e.g. exported from .env) must not mask file.apiKey.
		gatewayApiKey: process.env.TFG_API_KEY?.trim() || file.apiKey?.trim() || undefined,
		cdpUrl: process.env.TFG_CDP_URL ?? file.cdpUrl ?? DEFAULTS.cdpUrl,
		requestTimeoutSec: Number.parseInt(
			process.env.TFG_REQUEST_TIMEOUT_SEC ??
				String(file.requestTimeoutSec ?? DEFAULTS.requestTimeoutSec),
			10,
		),
	};
}
