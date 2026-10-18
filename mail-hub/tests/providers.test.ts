import { describe, expect, it } from 'vitest';
import { getDb, getRow } from '../src/db.js';
import { rateLimiter } from '../src/rate-limiter.js';
import { app, jsonHeaders } from './helpers/http.js';

describe('provider configuration routes', () => {
  it('returns auto-dispatch state in the provider list', async () => {
    getDb().prepare(`UPDATE provider_config SET auto_dispatch = 0 WHERE provider = ?`).run('mailtm');

    const res = await app.request('/api/providers', { headers: jsonHeaders() });
    const data = await res.json() as { providers: Array<{ name: string; autoDispatch?: boolean }> };
    const provider = data.providers.find((p) => p.name === 'mailtm');

    expect(res.status).toBe(200);
    expect(provider?.autoDispatch).toBe(false);
  });

  it('updates auto-dispatch using the public API field name', async () => {
    getDb().prepare(`UPDATE provider_config SET auto_dispatch = 0 WHERE provider = ?`).run('mailtm');

    const res = await app.request('/api/providers/mailtm', {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ autoDispatch: true }),
    });
    const data = await res.json() as { autoDispatch: boolean };
    const row = getRow<{ auto_dispatch: number }>(
      getDb(),
      `SELECT auto_dispatch FROM provider_config WHERE provider = ?`,
      'mailtm',
    );

    expect(res.status).toBe(200);
    expect(data.autoDispatch).toBe(true);
    expect(row?.auto_dispatch).toBe(1);
  });

  it('returns cooldown state in provider rate status', async () => {
    rateLimiter.setCooldown('mailtm', Date.now() + 60_000, 'rate-limit');

    const res = await app.request('/api/providers', { headers: jsonHeaders() });
    const data = await res.json() as {
      providers: Array<{
        name: string;
        rateStatus?: { available: boolean; nextAvailableAt: string | null; cooldownReason?: string | null };
      }>;
    };
    const provider = data.providers.find((p) => p.name === 'mailtm');

    expect(res.status).toBe(200);
    expect(provider?.rateStatus?.available).toBe(false);
    expect(provider?.rateStatus?.cooldownReason).toBe('rate-limit');
    expect(provider?.rateStatus?.nextAvailableAt).not.toBeNull();
  });
});
