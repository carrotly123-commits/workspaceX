import { describe, expect, it, vi } from 'vitest';
import {
  compareStableVersions,
  createUpdateChecker,
  findLatestStableVersion,
  normalizeStableVersion,
} from '../src/update-check.js';

describe('stable version handling', () => {
  it.each([
    ['v1.2.3', '1.2.3'],
    ['1.2.3', '1.2.3'],
    [' v0.9.4 ', '0.9.4'],
    ['v01.2.3', null],
    ['v1.2.3-beta.1', null],
    ['release-1.2.3', null],
    ['1.2', null],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeStableVersion(input)).toBe(expected);
  });

  it('compares numeric triplets instead of strings', () => {
    expect(compareStableVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareStableVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareStableVersions('0.9.9', '1.0.0')).toBe(-1);
  });

  it('selects the highest stable tag from an unordered payload', () => {
    expect(findLatestStableVersion([
      { name: 'v0.9.4' },
      { name: 'v1.0.0-beta.1' },
      { name: 'notes' },
      { name: 'v0.10.0' },
      { name: 'v0.9.9' },
    ])).toBe('0.10.0');
  });

  it('only accepts canonical v-prefixed stable tags from GitHub', () => {
    expect(findLatestStableVersion([
      { name: '2.0.0' },
      { name: 'v01.0.0' },
      { name: 'v1.2.3' },
    ])).toBe('1.2.3');
  });

  it('rejects invalid GitHub payloads or payloads without a stable tag', () => {
    expect(() => findLatestStableVersion({ name: 'v1.0.0' })).toThrow('invalid GitHub tags response');
    expect(() => findLatestStableVersion([{ name: 'v1.0.0-beta.1' }])).toThrow('no stable version tag');
  });
});

describe('update checker', () => {
  it('returns update availability and caches a successful result', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify([
      { name: 'v0.9.4' },
      { name: 'v0.10.0' },
    ]), { status: 200 }));
    const now = vi.fn()
      .mockReturnValueOnce(new Date('2026-07-17T00:00:00.000Z'))
      .mockReturnValue(new Date('2026-07-17T00:01:00.000Z'));
    const check = createUpdateChecker({ currentVersion: '0.9.4', fetcher, now, cacheTtlMs: 300_000 });

    const first = await check();
    const second = await check();

    expect(first).toEqual({
      currentVersion: '0.9.4',
      latestVersion: '0.10.0',
      updateAvailable: true,
      checkedAt: '2026-07-17T00:01:00.000Z',
      source: 'github-api',
    });
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent cache misses', async () => {
    let resolveResponse!: (response: Response) => void;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetcher = vi.fn(() => responsePromise);
    const check = createUpdateChecker({ currentVersion: '0.9.4', fetcher });

    const first = check();
    const second = check();
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveResponse(new Response(JSON.stringify([{ name: 'v0.9.4' }]), { status: 200 }));
    await expect(first).resolves.toEqual(await second);
  });

  it('refetches after the successful-result cache expires', async () => {
    const times = [
      '2026-07-17T00:00:00.000Z',
      '2026-07-17T00:00:00.000Z',
      '2026-07-17T00:04:00.000Z',
      '2026-07-17T00:06:00.000Z',
      '2026-07-17T00:06:00.000Z',
    ];
    const now = vi.fn(() => new Date(times.shift() ?? '2026-07-17T00:06:00.000Z'));
    const fetcher = vi.fn(async () => new Response(JSON.stringify([{ name: 'v0.9.4' }]), { status: 200 }));
    const check = createUpdateChecker({ currentVersion: '0.9.4', fetcher, now, cacheTtlMs: 300_000 });

    await check();
    await check();
    await check();

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('treats a newer local build as up to date', async () => {
    const check = createUpdateChecker({
      currentVersion: '1.1.0',
      fetcher: async () => new Response(JSON.stringify([{ name: 'v1.0.0' }]), { status: 200 }),
    });

    expect((await check()).updateAvailable).toBe(false);
  });

  it('follows GitHub tag pagination before selecting the highest stable version', async () => {
    const nextUrl = 'https://api.github.com/repositories/123/tags?per_page=100&page=2';
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ name: 'v0.9.4' }]), {
        status: 200,
        headers: { Link: `<${nextUrl}>; rel="next", <${nextUrl}>; rel="last"` },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ name: 'v1.0.0' }]), { status: 200 }));
    const check = createUpdateChecker({ currentVersion: '0.9.4', fetcher });

    expect(await check()).toMatchObject({
      latestVersion: '1.0.0',
      updateAvailable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toBe(nextUrl);
  });

  it.each([403, 429])('falls back to the GitHub tag feed for status %s', async (status) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('', { status }))
      .mockResolvedValueOnce(new Response(`
        <feed>
          <id>tag:github.com,2008:https://github.com/ydddp/mail-hub/releases</id>
          <entry><id>tag:github.com,2008:Repository/123/v0.9.4</id></entry>
          <entry><id>tag:github.com,2008:Repository/123/v0.10.0</id></entry>
        </feed>
      `, { status: 200 }));
    const check = createUpdateChecker({
      currentVersion: '0.9.4',
      fetcher,
    });

    expect(await check()).toMatchObject({
      latestVersion: '0.10.0',
      updateAvailable: true,
      source: 'github-feed',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toBe('https://github.com/ydddp/mail-hub/tags.atom');
  });

  it('reports a failed GitHub tag-feed fallback', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    const check = createUpdateChecker({ currentVersion: '0.9.4', fetcher });

    await expect(check()).rejects.toThrow('GitHub tag feed returned status 503');
  });

  it('rejects a GitHub tag feed without canonical stable tag IDs', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response('<feed><entry><id>not-a-tag</id></entry></feed>', { status: 200 }));
    const check = createUpdateChecker({ currentVersion: '0.9.4', fetcher });

    await expect(check()).rejects.toThrow('invalid GitHub tag feed response');
  });

  it('reports other upstream failures without exposing the response body', async () => {
    const check = createUpdateChecker({
      currentVersion: '0.9.4',
      fetcher: async () => new Response('sensitive upstream failure', { status: 500 }),
    });

    await expect(check()).rejects.toThrow('GitHub returned status 500');
    await expect(check()).rejects.not.toThrow('sensitive upstream failure');
  });

  it('reports malformed GitHub JSON as an invalid response', async () => {
    const check = createUpdateChecker({
      currentVersion: '0.9.4',
      fetcher: async () => new Response('{not-json', { status: 200 }),
    });

    await expect(check()).rejects.toThrow('invalid GitHub tags response');
  });
});
