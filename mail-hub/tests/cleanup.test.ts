import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupExpired } from '../src/app.js';
import { getDb, getRow } from '../src/db.js';
import { registry } from '../src/providers/registry.js';
import { FakeProvider } from './helpers/fake-provider.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function insertShortAccount(email: string, refreshToken: string): void {
  getDb().prepare(
    `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, token_status, account_type)
     VALUES (?, 'pw', 'client-id', ?, 'valid', 'short')`,
  ).run(email, refreshToken);
}

describe('expired inbox cleanup', () => {
  it('releases assigned Outlook accounts before deleting stale inboxes', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, assigned_inbox_id, account_type)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('user@outlook.com', 'pw', 'client', 'refresh', 'inbox-old', 'long');
    db.prepare(
      `INSERT INTO inboxes (id, provider, address, auth_data, api_base, expires_at, status)
       VALUES (?, ?, ?, ?, ?, datetime('now', '-8 day'), 'closed')`,
    ).run('inbox-old', 'outlook', 'user@outlook.com', JSON.stringify({ email: 'user@outlook.com' }), '');

    await cleanupExpired();

    const assigned = getRow<{ assigned_inbox_id: string | null }>(
      db,
      `SELECT assigned_inbox_id FROM outlook_accounts WHERE email = ?`,
      'user@outlook.com',
    );
    expect(assigned?.assigned_inbox_id).toBeNull();
    const inbox = db.prepare(`SELECT id FROM inboxes WHERE id = ?`).get('inbox-old');
    expect(inbox).toBeUndefined();
  });

  it('does not call external provider deletion from scheduled cleanup', async () => {
    const provider = new FakeProvider();
    registry.register(provider);
    const db = getDb();
    db.prepare(
      `INSERT INTO inboxes (id, provider, address, auth_data, api_base, expires_at, status)
       VALUES (?, ?, ?, ?, ?, datetime('now', '-8 day'), 'closed')`,
    ).run('fake-old', 'fake', 'old@example.test', JSON.stringify({ token: 't' }), 'https://fake.test');

    await cleanupExpired();

    expect(provider.deleteCount).toBe(0);
    const inbox = db.prepare(`SELECT id FROM inboxes WHERE id = ?`).get('fake-old');
    expect(inbox).toBeUndefined();
    registry.unregister('fake');
  });

  it('closes expired active inboxes and frees their Outlook account at close time', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, assigned_inbox_id, account_type)
       VALUES ('used@outlook.com', 'pw', 'c', 'r', 'inbox-exp', 'long')`,
    ).run();
    db.prepare(
      `INSERT INTO inboxes (id, provider, address, auth_data, api_base, expires_at, status)
       VALUES ('inbox-exp', 'outlook', 'used@outlook.com', ?, '', datetime('now', '-1 hour'), 'active')`,
    ).run(JSON.stringify({ email: 'used@outlook.com' }));

    await cleanupExpired();

    const inbox = getRow<{ status: string }>(db, `SELECT status FROM inboxes WHERE id = 'inbox-exp'`);
    expect(inbox?.status).toBe('closed');
    const account = getRow<{ assigned_inbox_id: string | null }>(
      db,
      `SELECT assigned_inbox_id FROM outlook_accounts WHERE email = 'used@outlook.com'`,
    );
    expect(account?.assigned_inbox_id).toBeNull();
  });

  it('releases Outlook assignments pointing at inboxes that no longer exist', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, assigned_inbox_id, account_type)
       VALUES ('ghost@outlook.com', 'pw', 'c', 'r', 'ghost-inbox', 'long')`,
    ).run();

    await cleanupExpired();

    const account = getRow<{ assigned_inbox_id: string | null }>(
      db,
      `SELECT assigned_inbox_id FROM outlook_accounts WHERE email = 'ghost@outlook.com'`,
    );
    expect(account?.assigned_inbox_id).toBeNull();
  });
});

describe('daily Outlook token check safety', () => {
  it('keeps accounts when the token endpoint fails with 5xx', async () => {
    insertShortAccount('a5xx@outlook.com', 'rt-5xx-unique');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })));

    await cleanupExpired();

    const row = getRow<{ token_status: string; last_checked_at: string | null }>(
      getDb(),
      `SELECT token_status, last_checked_at FROM outlook_accounts WHERE email = 'a5xx@outlook.com'`,
    );
    expect(row?.token_status).toBe('valid');
    expect(row?.last_checked_at).not.toBeNull();
  });

  it('keeps accounts when the token endpoint is throttling with 429', async () => {
    insertShortAccount('a429@outlook.com', 'rt-429-unique');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'throttled' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    })));

    await cleanupExpired();

    const row = getRow<{ token_status: string }>(
      getDb(),
      `SELECT token_status FROM outlook_accounts WHERE email = 'a429@outlook.com'`,
    );
    expect(row?.token_status).toBe('valid');
  });

  it('deletes unassigned short accounts only on deterministic OAuth rejection', async () => {
    insertShortAccount('bad@outlook.com', 'rt-bad-unique');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })));

    await cleanupExpired();

    const row = getRow<{ email: string }>(
      getDb(),
      `SELECT email FROM outlook_accounts WHERE email = 'bad@outlook.com'`,
    );
    expect(row).toBeUndefined();
  });
});
