import { beforeEach, describe, expect, it, vi } from 'vitest';

const { checkForUpdates } = vi.hoisted(() => ({ checkForUpdates: vi.fn() }));
vi.mock('../src/update-check.js', () => ({ checkForUpdates }));

import { app, authHeaders, jsonOf } from './helpers/http.js';

interface UpdateCheckResponse {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  checkedAt: string;
  source: 'github-api' | 'github-feed';
}

describe('GET /api/admin/update-check', () => {
  beforeEach(() => {
    checkForUpdates.mockReset();
  });

  it('requires administrator authentication', async () => {
    const res = await app.request('/api/admin/update-check');

    expect(res.status).toBe(401);
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it('returns the normalized update result', async () => {
    const expected: UpdateCheckResponse = {
      currentVersion: '0.9.4',
      latestVersion: '0.10.0',
      updateAvailable: true,
      checkedAt: '2026-07-17T00:00:00.000Z',
      source: 'github-api',
    };
    checkForUpdates.mockResolvedValue(expected);

    const res = await app.request('/api/admin/update-check', { headers: authHeaders() });

    expect(res.status).toBe(200);
    expect(await jsonOf<UpdateCheckResponse>(res)).toEqual(expected);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('maps GitHub failures to an upstream error response', async () => {
    checkForUpdates.mockImplementation(() => {
      throw new Error('GitHub rate limit exceeded');
    });

    const res = await app.request('/api/admin/update-check', { headers: authHeaders() });

    expect(res.status).toBe(502);
    expect(await jsonOf<{ error: string }>(res)).toEqual({ error: 'GitHub rate limit exceeded' });
  });
});
