/**
 * Phase 1: External Site Discovery.
 *
 * Discovers external AI / API websites from:
 *   - Seed URLs or domain names
 *   - Remote directory / navigation / aggregator web pages or JSON feeds
 *   - Local text, Markdown, HTML, CSV, or JSON files
 * Then inspects each site to identify framework signatures (OneAPI / NewAPI / VoAPI /
 * Supabase / Clerk / NextAuth / Generic AI), candidate signup/login entrypoints, and
 * OpenAI-compatible API endpoints.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deriveDomainsFromUrl } from "../platforms/generic.ts";
import type { DiscoveredSite, ProgressFn, SiteFrameworkType } from "./types.ts";
import { nowIso } from "./utils.ts";

/** Domains ignored when harvesting external links from directories/READMEs */
const IGNORED_HOST_PATTERNS = [
  /(^|\.)github\.com$/i,
  /(^|\.)githubusercontent\.com$/i,
  /(^|\.)npmjs\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)youtube\.com$/i,
  /(^|\.)t\.me$/i,
  /(^|\.)discord\.(gg|com)$/i,
  /(^|\.)wikipedia\.org$/i,
  /(^|\.)w3\.org$/i,
  /(^|\.)schema\.org$/i,
  /(^|\.)googleapis\.com$/i,
  /(^|\.)gstatic\.com$/i,
  /(^|\.)cloudflare\.com$/i,
  /(^|\.)jsdelivr\.net$/i,
  /(^|\.)unpkg\.com$/i,
];

const STATIC_ASSET_EXT_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|woff2?|ttf|eot|mp4|webm|mp3|pdf|zip|tar|gz)$/i;

const COMMON_SIGNUP_PATHS = [
  "/register",
  "/signup",
  "/sign_up",
  "/auth/register",
  "/auth/signup",
  "/user/register",
  "/login",
];

/**
 * Extract candidate site URLs from raw text, Markdown, HTML, CSV, or JSON content.
 */
export function extractCandidateUrlsFromText(
  rawText: string,
  options: { baseUrl?: string; includeNonAiLooking?: boolean } = {},
): string[] {
  const results = new Set<string>();

  // 1. Absolute http(s) URLs in text / Markdown / JSON / HTML
  const urlRe = /https?:\/\/[^\s"'<>)\]]+/gi;
  const matches: string[] = [...(rawText.match(urlRe) ?? [])];

  // 2. Relative/absolute hrefs in HTML if baseUrl provided
  if (options.baseUrl) {
    const hrefRe = /href=["']([^"'#]+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = hrefRe.exec(rawText)) !== null) {
      const href = m[1]?.trim();
      if (!href || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
      try {
        const resolved = new URL(href, options.baseUrl).toString();
        matches.push(resolved);
      } catch {
        // ignore invalid href
      }
    }
  }

  // 3. Plain domain lines (e.g. "api.example.com" or "chat.example.org/signup")
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^[-*•\d.)\s]+/, "").trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[^\s]*)?$/i.test(trimmed)) {
      matches.push(`https://${trimmed}`);
    }
  }

  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;:!?)'"`]+$/, "");
    try {
      const u = new URL(cleaned);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      if (STATIC_ASSET_EXT_RE.test(u.pathname)) continue;
      if (IGNORED_HOST_PATTERNS.some((re) => re.test(u.hostname))) continue;
      results.add(u.toString());
    } catch {
      // ignore malformed URL
    }
  }

  return [...results];
}

/**
 * Group URLs by origin so we inspect each unique external site once,
 * while preserving any specific signup/register paths discovered in the input.
 */
export function groupUrlsBySiteOrigin(urls: string[]): Map<string, string[]> {
  const byOrigin = new Map<string, string[]>();
  for (const raw of urls) {
    try {
      const withProto = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
      const u = new URL(withProto);
      const list = byOrigin.get(u.origin) ?? [];
      if (!list.includes(u.toString())) {
        list.push(u.toString());
      }
      byOrigin.set(u.origin, list);
    } catch {
      // ignore
    }
  }
  return byOrigin;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/json,application/xhtml+xml,*/*;q=0.8",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detect framework from HTML content, headers, and `/api/status` probe.
 */
export function detectFrameworkFromHtml(html: string): SiteFrameworkType {
  const lower = html.toLowerCase();
  if (lower.includes("new-api") || lower.includes("newapi") || lower.includes("quantumyl/new-api")) {
    return "newapi";
  }
  if (lower.includes("one-api") || lower.includes("oneapi") || lower.includes("songquanpeng/one-api")) {
    return "oneapi";
  }
  if (lower.includes("voapi")) {
    return "voapi";
  }
  if (lower.includes("supabase") || lower.includes("gotrue")) {
    return "supabase";
  }
  if (lower.includes("__clerk") || lower.includes("clerk.browser.js")) {
    return "clerk";
  }
  if (lower.includes("/api/auth/session") || lower.includes("next-auth")) {
    return "nextauth";
  }
  if (
    lower.includes("chat") ||
    lower.includes("openai") ||
    lower.includes("llm") ||
    lower.includes("gpt") ||
    lower.includes("claude") ||
    lower.includes("deepseek") ||
    lower.includes("api key") ||
    lower.includes("令牌") ||
    lower.includes("模型")
  ) {
    return "generic_ai";
  }
  return "unknown";
}

function extractTitleFromHtml(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m?.[1]) return undefined;
  return m[1].replace(/\s+/g, " ").trim().slice(0, 120);
}

function extractAuthLinksFromHtml(html: string, origin: string): {
  signupLinks: string[];
  loginLinks: string[];
} {
  const signupLinks = new Set<string>();
  const loginLinks = new Set<string>();

  const anchorRe = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1]?.trim();
    const text = (m[2] ?? "").replace(/<[^>]+>/g, " ").trim().toLowerCase();
    if (!href || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
    let resolved: string;
    try {
      const u = new URL(href, origin);
      if (u.origin !== origin) continue;
      resolved = u.toString();
    } catch {
      continue;
    }
    const pathLower = resolved.toLowerCase();
    if (
      /sign[-_]?up|register|create[-_]?account|join/i.test(pathLower) ||
      /sign\s*up|register|注册|立即注册|创建账号|免费注册/i.test(text)
    ) {
      signupLinks.add(resolved);
    } else if (
      /log[-_]?in|sign[-_]?in|auth|console/i.test(pathLower) ||
      /log\s*in|sign\s*in|登录|控制台/i.test(text)
    ) {
      loginLinks.add(resolved);
    }
  }

  return {
    signupLinks: [...signupLinks],
    loginLinks: [...loginLinks],
  };
}

/**
 * Inspect a single external website URL to discover its framework,
 * registration entrypoints, and API endpoints.
 */
export async function inspectExternalSite(
  rawUrl: string,
  options: {
    source?: string;
    timeoutMs?: number;
    knownPaths?: string[];
    fetchFn?: typeof fetch;
  } = {},
): Promise<DiscoveredSite> {
  const derived = deriveDomainsFromUrl(rawUrl);
  const timeoutMs = options.timeoutMs ?? 8_000;
  const doFetch = options.fetchFn
    ? (url: string, init?: RequestInit) => options.fetchFn!(url, init)
    : (url: string, init?: RequestInit) => fetchWithTimeout(url, init, timeoutMs);

  const signupCandidates = new Set<string>();
  const loginCandidates = new Set<string>();
  const apiBaseCandidates = new Set<string>([derived.origin, `${derived.origin}/v1`, `${derived.origin}/api`]);

  // If rawUrl itself already points to a signup/register route, prioritize it
  if (/sign[-_]?up|register|auth/i.test(derived.normalizedUrl)) {
    signupCandidates.add(derived.normalizedUrl);
  }
  for (const p of options.knownPaths ?? []) {
    if (/sign[-_]?up|register/i.test(p)) signupCandidates.add(p);
    if (/log[-_]?in|sign[-_]?in/i.test(p)) loginCandidates.add(p);
  }

  let reachable = false;
  let statusCode: number | undefined;
  let title: string | undefined;
  let framework: SiteFrameworkType = "unknown";
  let openAiCompatible = false;

  // 1. Fetch homepage or entry URL
  try {
    const res = await doFetch(derived.normalizedUrl, { method: "GET" });
    statusCode = res.status;
    reachable = res.status > 0 && res.status < 500;
    const html = await res.text().catch(() => "");
    title = extractTitleFromHtml(html);
    framework = detectFrameworkFromHtml(html);
    const links = extractAuthLinksFromHtml(html, derived.origin);
    for (const s of links.signupLinks) signupCandidates.add(s);
    for (const l of links.loginLinks) loginCandidates.add(l);
  } catch {
    reachable = false;
  }

  // 2. Probe `/api/status` (identifies OneAPI / NewAPI / VoAPI sites immediately)
  try {
    const statusRes = await doFetch(`${derived.origin}/api/status`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (statusRes.ok) {
      const json = (await statusRes.json().catch(() => null)) as Record<string, unknown> | null;
      const data = (json?.data ?? json) as Record<string, unknown> | undefined;
      if (
        json &&
        (json.success === true || typeof data?.system_name === "string" || "email_verification" in (data ?? {}))
      ) {
        reachable = true;
        if (framework === "unknown" || framework === "generic_ai") {
          const sysName = String(data?.system_name ?? "").toLowerCase();
          framework = sysName.includes("new") ? "newapi" : sysName.includes("vo") ? "voapi" : "oneapi";
        }
        if (!title && typeof data?.system_name === "string") {
          title = data.system_name;
        }
        signupCandidates.add(`${derived.origin}/register`);
        loginCandidates.add(`${derived.origin}/login`);
        openAiCompatible = true;
      }
    }
  } catch {
    // ignore
  }

  // 3. Probe `/v1/models` to check OpenAI API compatibility
  if (!openAiCompatible) {
    try {
      const modelsRes = await doFetch(`${derived.origin}/v1/models`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      // 200 (public models) or 401/403 (auth-protected OpenAI endpoint) both confirm /v1/models exists
      if (modelsRes.status === 200 || modelsRes.status === 401 || modelsRes.status === 403) {
        const ct = modelsRes.headers.get("content-type") ?? "";
        if (ct.includes("json") || modelsRes.status === 401) {
          openAiCompatible = true;
          reachable = true;
        }
      }
    } catch {
      // ignore
    }
  }

  // 4. Add standard fallback signup candidates if none were found in HTML
  if (signupCandidates.size === 0) {
    for (const path of COMMON_SIGNUP_PATHS) {
      signupCandidates.add(`${derived.origin}${path}`);
    }
  }

  return {
    id: derived.inferredId,
    url: derived.normalizedUrl,
    origin: derived.origin,
    hostname: derived.hostname,
    rootDomain: derived.rootDomain,
    title,
    reachable,
    statusCode,
    framework,
    signupCandidates: [...signupCandidates],
    loginCandidates: [...loginCandidates],
    apiBaseCandidates: [...apiBaseCandidates],
    openAiCompatible,
    source: options.source ?? "direct",
    discoveredAt: nowIso(),
  };
}

/**
 * Discover external sites from multiple sources (URLs, directory pages, files, or raw text).
 */
export async function discoverExternalSites(
  inputs: string[],
  options: {
    concurrency?: number;
    timeoutMs?: number;
    crawlDirectoryPages?: boolean;
    onProgress?: ProgressFn;
    fetchFn?: typeof fetch;
  } = {},
): Promise<DiscoveredSite[]> {
  const candidateUrls: string[] = [];
  const doFetch = options.fetchFn
    ? (url: string, init?: RequestInit) => options.fetchFn!(url, init)
    : (url: string, init?: RequestInit) => fetchWithTimeout(url, init, options.timeoutMs ?? 8_000);

  for (const input of inputs) {
    const trimmed = input.trim();
    if (!trimmed) continue;

    // Case 1: Local file path
    if (existsSync(trimmed)) {
      options.onProgress?.(`[discover] Reading candidate URLs from file: ${trimmed}`);
      const content = readFileSync(trimmed, "utf-8");
      candidateUrls.push(...extractCandidateUrlsFromText(content));
      continue;
    }

    // Case 2: Remote URL or directory page
    if (/^https?:\/\//i.test(trimmed) && options.crawlDirectoryPages) {
      options.onProgress?.(`[discover] Crawling directory/seed page: ${trimmed}`);
      try {
        const res = await doFetch(trimmed);
        const text = await res.text();
        const extracted = extractCandidateUrlsFromText(text, { baseUrl: trimmed });
        if (extracted.length > 0) {
          candidateUrls.push(...extracted);
        } else {
          candidateUrls.push(trimmed);
        }
      } catch {
        candidateUrls.push(trimmed);
      }
      continue;
    }

    // Case 3: Direct URL, domain, or multi-line text snippet
    const extracted = extractCandidateUrlsFromText(trimmed);
    if (extracted.length > 0) {
      candidateUrls.push(...extracted);
    } else {
      candidateUrls.push(trimmed);
    }
  }

  const grouped = groupUrlsBySiteOrigin(candidateUrls);
  const entries = [...grouped.entries()];
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const results: DiscoveredSite[] = [];

  options.onProgress?.(
    `[discover] Inspecting ${entries.length} unique external site(s) (concurrency=${concurrency})...`,
  );

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (cursor < entries.length) {
      const idx = cursor++;
      const [origin, urls] = entries[idx]!;
      const primaryUrl = urls[0] ?? origin;
      const site = await inspectExternalSite(primaryUrl, {
        source: "discovery",
        timeoutMs: options.timeoutMs,
        knownPaths: urls,
        fetchFn: options.fetchFn,
      });
      results.push(site);
      options.onProgress?.(
        `[discover] Found ${site.id} (${site.origin}) framework=${site.framework} reachable=${site.reachable} signup=${site.signupCandidates[0] ?? "n/a"}`,
        site.reachable ? "success" : "warn",
      );
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Persistent store for discovered external websites.
 */
export class DiscoveryStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  load(): DiscoveredSite[] {
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as { sites?: DiscoveredSite[] };
        return Array.isArray(parsed?.sites) ? parsed.sites : [];
      }
    } catch {
      // ignore
    }
    return [];
  }

  save(sites: DiscoveredSite[]): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify({ version: 1, updatedAt: nowIso(), sites }, null, 2), "utf-8");
  }

  upsertMany(newSites: DiscoveredSite[]): DiscoveredSite[] {
    const existing = this.load();
    const map = new Map<string, DiscoveredSite>();
    for (const s of existing) map.set(s.origin, s);
    for (const s of newSites) map.set(s.origin, s);
    const merged = [...map.values()];
    this.save(merged);
    return merged;
  }
}
