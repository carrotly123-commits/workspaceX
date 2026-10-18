import { ImapFlow } from 'imapflow';
import { BaseProvider, PROVIDER, type InboxData, type Message, type MessageDetail } from './base.js';
import { allRows, getDb, getRow } from '../db.js';
import { randomString } from '../utils.js';
import { createLogger } from '../logger.js';
import { errorMessage, logIgnoredError } from '../errors.js';

const log = createLogger('imap');

interface ImapAccount {
  id: string;
  host: string;
  port: number;
  user: string;
  password: string;
  domain: string;
  tls: number;
  status: string;
}

function getActiveAccounts(): ImapAccount[] {
  return allRows<ImapAccount>(
    getDb(),
    `SELECT id, host, port, user, password, domain, tls, status FROM imap_accounts WHERE status = 'active'`,
  );
}

function getAccountById(id: string): ImapAccount | undefined {
  return getRow<ImapAccount>(
    getDb(),
    `SELECT id, host, port, user, password, domain, tls, status FROM imap_accounts WHERE id = ? AND status = 'active'`,
    id,
  );
}

function getAccountByDomain(domain: string): ImapAccount | undefined {
  return getRow<ImapAccount>(
    getDb(),
    `SELECT id, host, port, user, password, domain, tls, status FROM imap_accounts WHERE domain = ? AND status = 'active' LIMIT 1`,
    domain,
  );
}

async function connectImap(account: ImapAccount): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.tls === 1,
    auth: { user: account.user, pass: account.password },
    logger: false,
  });
  await client.connect();
  return client;
}

interface PoolEntry { clientPromise: Promise<ImapFlow>; timer: ReturnType<typeof setTimeout>; }
const pool = new Map<string, PoolEntry>();
const IDLE_MS = 5 * 60 * 1000;
// A busy catch-all mailbox can match hundreds of UIDs; poll only the newest.
const POLL_FETCH_LIMIT = 20;

function evictClient(id: string, entry?: PoolEntry): void {
  const current = pool.get(id);
  if (!current) return;
  // Entry-matched eviction: an async error callback must not kill a newer
  // client that has since replaced the failed one.
  if (entry && current !== entry) return;
  clearTimeout(current.timer);
  pool.delete(id);
  current.clientPromise
    .then((client) => client.logout())
    .catch((error: unknown) => {
      logIgnoredError(log, 'IMAP pooled client logout failed', error, { accountId: id });
    });
}

async function getPooledClient(account: ImapAccount): Promise<ImapFlow> {
  const existing = pool.get(account.id);
  if (existing) {
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => evictClient(account.id, existing), IDLE_MS);
    return existing.clientPromise;
  }
  // The entry is registered synchronously (holding a promise) so concurrent
  // callers share one connection instead of racing to open duplicates.
  const entry: PoolEntry = {
    clientPromise: connectImap(account).then((client) => {
      client.once('error', () => evictClient(account.id, entry));
      return client;
    }),
    timer: setTimeout(() => evictClient(account.id, entry), IDLE_MS),
  };
  pool.set(account.id, entry);
  try {
    return await entry.clientPromise;
  } catch (e) {
    if (pool.get(account.id) === entry) {
      clearTimeout(entry.timer);
      pool.delete(account.id);
    }
    throw e;
  }
}

export class ImapProvider extends BaseProvider {
  meta = {
    name: PROVIDER.IMAP,
    displayName: 'IMAP / 域名邮箱',
    type: 'api' as const,
    tier: 'free' as const,
    trustLevel: 10,
    rateLimit: { createPerMinute: 60, pollPerMinute: 10 },
    retention: '24h',
    features: {
      customUsername: true,
      pollInbox: true,
      realtime: false,
      attachments: true,
    },
  };

  async getDomains(): Promise<string[]> {
    const accounts = getActiveAccounts();
    return [...new Set(accounts.map((a) => a.domain))];
  }

  async createInbox(opts?: { domain?: string; username?: string }): Promise<InboxData> {
    let account: ImapAccount | undefined;

    if (opts?.domain) {
      account = getAccountByDomain(opts.domain);
    }

    if (!account) {
      const accounts = getActiveAccounts();
      if (accounts.length === 0) throw new Error('No active IMAP accounts configured');
      account = accounts[Math.floor(Math.random() * accounts.length)];
    }

    const username = opts?.username || randomString(12);

    return {
      address: `${username}@${account.domain}`,
      authData: {
        imapAccountId: account.id,
        username,
        domain: account.domain,
      },
      provider: this.meta.name,
      apiBase: `imap://${account.host}`,
    };
  }

  async getMessages(inbox: InboxData): Promise<Message[]> {
    const account = getAccountById(inbox.authData.imapAccountId);
    if (!account) throw new Error(`IMAP account ${inbox.authData.imapAccountId} not found`);

    const client = await getPooledClient(account);
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const toAddr = inbox.address;
        const uids = await client.search({ to: toAddr }, { uid: true });
        if (!uids || uids.length === 0) return [];
        const recent = uids.slice(-POLL_FETCH_LIMIT);
        const messages: Message[] = [];
        for await (const fetched of client.fetch(recent, { envelope: true }, { uid: true })) {
          messages.push({
            id: String(fetched.uid),
            from: fetched.envelope?.from?.[0]?.address ?? '',
            subject: fetched.envelope?.subject ?? '',
            excerpt: '',
            receivedAt: fetched.envelope?.date?.toISOString() ?? '',
          });
        }
        return messages;
      } finally {
        lock.release();
      }
    } catch (e) {
      evictClient(account.id);
      throw e;
    }
  }

  async getMessage(inbox: InboxData, messageId: string): Promise<MessageDetail> {
    const account = getAccountById(inbox.authData.imapAccountId);
    if (!account) throw new Error(`IMAP account ${inbox.authData.imapAccountId} not found`);

    const client = await getPooledClient(account);
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const fetched = await client.fetchOne(messageId, {
          uid: true,
          envelope: true,
          bodyParts: ['1', '2'],
        }, { uid: true });

        if (!fetched) throw new Error(`Message ${messageId} not found`);

        let text = '';
        let html = '';
        try { text = fetched.bodyParts?.get('1')?.toString() ?? ''; } catch (error) {
          log.warn('failed to read IMAP text body part', { accountId: account.id, messageId, error: errorMessage(error) });
        }
        try { html = fetched.bodyParts?.get('2')?.toString() ?? ''; } catch (error) {
          log.warn('failed to read IMAP html body part', { accountId: account.id, messageId, error: errorMessage(error) });
        }

        return {
          id: messageId,
          from: fetched.envelope?.from?.[0]?.address ?? '',
          subject: fetched.envelope?.subject ?? '',
          excerpt: text.slice(0, 200),
          receivedAt: fetched.envelope?.date?.toISOString() ?? '',
          text: text || undefined,
          html: html || undefined,
        };
      } finally {
        lock.release();
      }
    } catch (e) {
      evictClient(account.id);
      throw e;
    }
  }
}

export async function testImapConnection(account: ImapAccount): Promise<{ ok: boolean; error?: string }> {
  let client: ImapFlow;
  try {
    client = await connectImap(account);
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
  try {
    await client.mailboxOpen('INBOX');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  } finally {
    await client.logout().catch((error: unknown) => {
      logIgnoredError(log, 'IMAP test logout failed', error, { accountId: account.id });
    });
  }
}
