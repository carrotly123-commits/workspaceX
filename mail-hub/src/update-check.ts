import { APP_VERSION } from './version.js';
import { fetchWithTimeout } from './utils.js';

const GITHUB_TAGS_URL = 'https://api.github.com/repos/ydddp/mail-hub/tags?per_page=100';
const GITHUB_TAGS_FEED_URL = 'https://github.com/ydddp/mail-hub/tags.atom';
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

type VersionTuple = readonly [number, number, number];
type UpdateFetch = (
  url: string,
  options?: RequestInit & { timeout?: number; retries?: number },
) => Promise<Response>;

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  checkedAt: string;
  source: 'github-api' | 'github-feed';
}

export interface UpdateCheckerOptions {
  currentVersion?: string;
  fetcher?: UpdateFetch;
  now?: () => Date;
  cacheTtlMs?: number;
}

function parseStableVersion(
  value: unknown,
  requireTagPrefix = false,
): { normalized: string; tuple: VersionTuple } | null {
  if (typeof value !== 'string') return null;
  const pattern = requireTagPrefix
    ? /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
    : /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const match = pattern.exec(value.trim());
  if (!match) return null;
  const tuple = match.slice(1).map(Number) as unknown as VersionTuple;
  if (tuple.some(part => !Number.isSafeInteger(part))) return null;
  return { normalized: tuple.join('.'), tuple };
}

export function normalizeStableVersion(value: unknown): string | null {
  return parseStableVersion(value)?.normalized ?? null;
}

function normalizeStableTag(value: unknown): string | null {
  return parseStableVersion(value, true)?.normalized ?? null;
}

function highestVersion(versions: string[], emptyMessage: string): string {
  if (versions.length === 0) throw new Error(emptyMessage);
  return versions.reduce((latest, candidate) => (
    compareStableVersions(candidate, latest) > 0 ? candidate : latest
  ));
}

function stableVersionsFromTagsPayload(payload: unknown): string[] {
  if (!Array.isArray(payload)) throw new Error('invalid GitHub tags response');
  return payload
    .map(tag => tag && typeof tag === 'object'
      ? normalizeStableTag((tag as { name?: unknown }).name)
      : null)
    .filter((value): value is string => value !== null);
}

export function compareStableVersions(left: string, right: string): number {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (!a || !b) throw new Error('invalid stable version');

  for (let i = 0; i < 3; i++) {
    if (a.tuple[i] > b.tuple[i]) return 1;
    if (a.tuple[i] < b.tuple[i]) return -1;
  }
  return 0;
}

export function findLatestStableVersion(payload: unknown): string {
  return highestVersion(stableVersionsFromTagsPayload(payload), 'no stable version tag found');
}

function findLatestStableVersionFromAtom(xml: string): string {
  const versions = Array.from(
    xml.matchAll(/<id>[^<]*\/(v?\d+\.\d+\.\d+)<\/id>/g),
    match => normalizeStableTag(match[1]),
  ).filter((value): value is string => value !== null);

  return highestVersion(versions, 'invalid GitHub tag feed response');
}

function nextGitHubPage(response: Response): string | null {
  const header = response.headers.get('link');
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /^\s*<([^>]+)>;\s*rel="next"\s*$/.exec(part);
    if (!match) continue;
    const url = new URL(match[1]);
    if (url.protocol !== 'https:' || url.hostname !== 'api.github.com') {
      throw new Error('invalid GitHub pagination link');
    }
    return url.toString();
  }
  return null;
}

export function createUpdateChecker(options: UpdateCheckerOptions = {}): () => Promise<UpdateCheckResult> {
  const currentVersion = normalizeStableVersion(options.currentVersion ?? APP_VERSION);
  const fetcher = options.fetcher ?? fetchWithTimeout;
  const now = options.now ?? (() => new Date());
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  let cache: { result: UpdateCheckResult; expiresAt: number } | undefined;
  let inFlight: Promise<UpdateCheckResult> | undefined;

  const runCheck = async (validCurrentVersion: string): Promise<UpdateCheckResult> => {
    const restOptions: RequestInit & { timeout: number; retries: number } = {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Mail-Hub',
      },
      timeout: 10_000,
      retries: 1,
    };
    let response = await fetcher(GITHUB_TAGS_URL, restOptions);

    let latestVersion: string;
    let source: UpdateCheckResult['source'] = 'github-api';
    const restVersions: string[] = [];
    const visitedPages = new Set<string>([GITHUB_TAGS_URL]);
    while (response.status !== 403 && response.status !== 429) {
      if (!response.ok) throw new Error(`GitHub returned status ${response.status}`);

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error('invalid GitHub tags response');
      }
      restVersions.push(...stableVersionsFromTagsPayload(payload));

      const nextPage = nextGitHubPage(response);
      if (!nextPage) break;
      if (visitedPages.has(nextPage)) throw new Error('invalid GitHub pagination link');
      visitedPages.add(nextPage);
      response = await fetcher(nextPage, restOptions);
    }

    if (response.status === 403 || response.status === 429) {
      source = 'github-feed';
      const feedResponse = await fetcher(GITHUB_TAGS_FEED_URL, {
        headers: {
          Accept: 'application/atom+xml',
          'User-Agent': 'Mail-Hub',
        },
        timeout: 10_000,
        retries: 1,
      });
      if (!feedResponse.ok) {
        throw new Error(`GitHub tag feed returned status ${feedResponse.status}`);
      }
      latestVersion = findLatestStableVersionFromAtom(await feedResponse.text());
    } else {
      latestVersion = highestVersion(restVersions, 'no stable version tag found');
    }

    const completedAt = now();
    const result: UpdateCheckResult = {
      currentVersion: validCurrentVersion,
      latestVersion,
      updateAvailable: compareStableVersions(latestVersion, validCurrentVersion) > 0,
      checkedAt: completedAt.toISOString(),
      source,
    };
    cache = { result, expiresAt: completedAt.getTime() + cacheTtlMs };
    return result;
  };

  return async () => {
    if (!currentVersion) throw new Error('invalid current application version');

    const currentTime = now();
    if (cache && currentTime.getTime() < cache.expiresAt) return cache.result;
    if (inFlight) return inFlight;

    inFlight = runCheck(currentVersion);
    try {
      return await inFlight;
    } finally {
      inFlight = undefined;
    }
  };
}

export const checkForUpdates = createUpdateChecker();
