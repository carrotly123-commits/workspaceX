import { registry } from './providers/registry.js';
import type { InboxData } from './providers/base.js';
import { createLogger } from './logger.js';
import { logIgnoredError } from './errors.js';

const log = createLogger('inbox-lifecycle');

export interface StoredInbox extends InboxData {
  id: string;
}

export function rowToInboxData(row: { address: string; auth_data: string; provider: string; api_base: string | null }): InboxData {
  return {
    address: row.address,
    authData: JSON.parse(row.auth_data),
    provider: row.provider,
    apiBase: row.api_base || '',
  };
}

export function parseStoredInbox(row: {
  id: string;
  provider: string;
  address: string;
  auth_data: string;
  api_base: string | null;
}): StoredInbox {
  return { id: row.id, ...rowToInboxData(row) };
}

export async function releaseInboxResources(
  inbox: StoredInbox,
  opts: { deleteExternal?: boolean } = {}
): Promise<void> {
  const provider = registry.get(inbox.provider);

  if (opts.deleteExternal) {
    await provider?.deleteInbox(inbox).catch((error: unknown) => {
      logIgnoredError(log, 'provider inbox deletion failed', error, { inboxId: inbox.id, provider: inbox.provider });
    });
  }

  await provider?.releaseInbox(inbox, inbox.id).catch((error: unknown) => {
    logIgnoredError(log, 'provider inbox release failed', error, { inboxId: inbox.id, provider: inbox.provider });
  });
}
