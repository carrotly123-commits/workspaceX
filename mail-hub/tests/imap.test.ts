import { describe, it, expect, vi } from 'vitest';
import { getDb } from '../src/db.js';
import { ImapProvider } from '../src/providers/imap.js';
import type { InboxData } from '../src/providers/base.js';

const imapMockState = vi.hoisted(() => ({
  connectCount: 0,
  searchResult: [] as number[],
  fetchRanges: [] as number[][],
}));

vi.mock('imapflow', () => {
  class FakeImapFlow {
    async connect(): Promise<void> {
      imapMockState.connectCount++;
    }
    once(): void {}
    async logout(): Promise<void> {}
    async getMailboxLock(): Promise<{ release(): void }> {
      return { release() {} };
    }
    async search(): Promise<number[]> {
      return [...imapMockState.searchResult];
    }
    async *fetch(range: number[]): AsyncGenerator<{ uid: number; envelope: { from: { address: string }[]; subject: string; date: Date } }> {
      imapMockState.fetchRanges.push(range);
      for (const uid of range) {
        yield { uid, envelope: { from: [{ address: 'sender@example.test' }], subject: `mail-${uid}`, date: new Date() } };
      }
    }
    async fetchOne(): Promise<undefined> {
      return undefined;
    }
    async mailboxOpen(): Promise<void> {}
  }
  return { ImapFlow: FakeImapFlow };
});

function imapInbox(accountId: string, address: string): InboxData {
  return { address, authData: { imapAccountId: accountId, username: 'x', domain: 'example.com' }, provider: 'imap', apiBase: '' };
}

describe('ImapProvider polling', () => {
  it('fetches only the newest messages in one batched fetch call', async () => {
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('pool-limit', 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run();
    imapMockState.searchResult = Array.from({ length: 30 }, (_, i) => i + 1);
    imapMockState.fetchRanges = [];

    const p = new ImapProvider();
    const messages = await p.getMessages(imapInbox('pool-limit', 'x@example.com'));

    expect(messages).toHaveLength(20);
    expect(messages[0].id).toBe('11');
    expect(messages[19].id).toBe('30');
    expect(imapMockState.fetchRanges).toHaveLength(1);
    expect(imapMockState.fetchRanges[0]).toHaveLength(20);
  });

  it('shares one connection across concurrent polls of the same account', async () => {
    getDb().prepare(
      `INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('pool-share', 'imap.test.com', 993, 'u', 'p', 'example.com')`,
    ).run();
    imapMockState.searchResult = [1];
    const before = imapMockState.connectCount;

    const p = new ImapProvider();
    const inbox = imapInbox('pool-share', 'y@example.com');
    await Promise.all([p.getMessages(inbox), p.getMessages(inbox)]);

    expect(imapMockState.connectCount - before).toBe(1);
  });
});

describe('ImapProvider', () => {
  it('has correct meta', () => {
    const p = new ImapProvider();
    expect(p.meta.name).toBe('imap');
    expect(p.meta.type).toBe('api');
    expect(p.meta.trustLevel).toBe(10);
    expect(p.meta.features.pollInbox).toBe(true);
    expect(p.meta.features.customUsername).toBe(true);
  });

  it('returns empty domains when no accounts configured', async () => {
    const p = new ImapProvider();
    const domains = await p.getDomains();
    expect(domains).toEqual([]);
  });

  it('throws on createInbox when no accounts configured', async () => {
    const p = new ImapProvider();
    await expect(p.createInbox()).rejects.toThrow('No active IMAP accounts configured');
  });

  it('returns domains from active accounts', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t1', 'imap.test.com', 993, 'u1', 'p1', 'example.com')`).run();

    const p = new ImapProvider();
    const domains = await p.getDomains();
    expect(domains).toContain('example.com');
  });

  it('createInbox generates address under account domain', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t1', 'imap.test.com', 993, 'u1', 'p1', 'example.com')`).run();

    const p = new ImapProvider();
    const inbox = await p.createInbox({ domain: 'example.com' });
    expect(inbox.address).toMatch(/^[a-z0-9]+@example\.com$/);
    expect(inbox.provider).toBe('imap');
    expect(inbox.authData.imapAccountId).toBe('t1');
    expect(inbox.authData.domain).toBe('example.com');
    expect(inbox.authData.password).toBeUndefined();
    expect(inbox.authData.host).toBeUndefined();
  });

  it('createInbox supports custom username', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t1', 'imap.test.com', 993, 'u1', 'p1', 'example.com')`).run();

    const p = new ImapProvider();
    const inbox = await p.createInbox({ domain: 'example.com', username: 'testuser' });
    expect(inbox.address).toBe('testuser@example.com');
  });

  it('inactive accounts are excluded from domains', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t1', 'imap.test.com', 993, 'u1', 'p1', 'example.com')`).run();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain, status) VALUES ('t2', 'imap2.test.com', 993, 'u2', 'p2', 'disabled.com', 'inactive')`).run();

    const p = new ImapProvider();
    const domains = await p.getDomains();
    expect(domains).not.toContain('disabled.com');
    expect(domains).toContain('example.com');
  });

  it('deduplicates domains from multiple accounts', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t1', 'imap.test.com', 993, 'u1', 'p1', 'example.com')`).run();
    db.prepare(`INSERT INTO imap_accounts (id, host, port, user, password, domain) VALUES ('t3', 'imap3.test.com', 993, 'u3', 'p3', 'example.com')`).run();

    const p = new ImapProvider();
    const domains = await p.getDomains();
    const exampleCount = domains.filter(d => d === 'example.com').length;
    expect(exampleCount).toBe(1);
  });
});
