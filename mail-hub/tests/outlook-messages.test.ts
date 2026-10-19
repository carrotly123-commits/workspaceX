import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../src/db.js';
import { OutlookProvider } from '../src/providers/outlook.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

// Contract: the Outlook REST API (api_type 'outlook') returns PascalCase
// fields; messages must be normalized BEFORE dedup/merge/sort, otherwise every
// message collapses onto an undefined id and only one survives.
describe('Outlook REST (PascalCase) message polling', () => {
  it('returns all inbox+junk messages, normalized and sorted newest first', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO outlook_accounts (email, password, client_id, refresh_token, api_type)
       VALUES ('rest@outlook.com', 'pw', 'cid-rest', 'rt-rest-unique', 'outlook')`,
    ).run();

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/oauth2/v2.0/token')) {
        return new Response(JSON.stringify({ access_token: 'at-rest' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes('outlook.office.com') && u.includes('/inbox/')) {
        return new Response(JSON.stringify({ value: [
          { Id: 'in-1', Subject: 'Inbox One', ReceivedDateTime: '2026-07-01T10:00:00Z', From: { EmailAddress: { Name: 'A', Address: 'a@x.com' } }, BodyPreview: 'p1' },
          { Id: 'in-2', Subject: 'Inbox Two', ReceivedDateTime: '2026-07-01T12:00:00Z', From: { EmailAddress: { Name: 'B', Address: 'b@x.com' } }, BodyPreview: 'p2' },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('outlook.office.com') && u.includes('/junkemail/')) {
        return new Response(JSON.stringify({ value: [
          { Id: 'jk-1', Subject: 'Junk One', ReceivedDateTime: '2026-07-01T11:00:00Z', From: { EmailAddress: { Address: 'c@x.com' } }, BodyPreview: 'p3' },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }));

    const provider = new OutlookProvider();
    const messages = await provider.getMessages({
      address: 'rest@outlook.com',
      authData: { email: 'rest@outlook.com', password: 'pw', clientId: 'cid-rest', refreshToken: 'rt-rest-unique' },
      provider: 'outlook',
      apiBase: '',
    });

    expect(messages.map((m) => m.id)).toEqual(['in-2', 'jk-1', 'in-1']);
    expect(messages[0].subject).toBe('Inbox Two');
    expect(messages[0].from).toBe('B <b@x.com>');
  });
});
