import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WAContact as WAContactRecord } from '../proto/byte/v/forge/waapp/v1/contacts';
import { resolveWaContacts, waKeys } from './wa-api';

const MAX_AUTO_RESOLVE_CONTACTS = 20;

export function useWaContactAutoResolve(accountID: string, records: WAContactRecord[]) {
  const queryClient = useQueryClient();
  const targets = useMemo(() => unresolvedContactJIDs(records).slice(0, MAX_AUTO_RESOLVE_CONTACTS), [records]);
  const signature = targets.join('\n');
  const attempted = useRef('');
  const { isPending, mutate } = useMutation({
    mutationKey: waKeys.contactResolve(accountID),
    mutationFn: () => resolveWaContacts(accountID, targets),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: waKeys.contacts(accountID) });
    },
  });
  useEffect(() => {
    const key = `${accountID}:${signature}`;
    if (!accountID || targets.length === 0 || isPending || attempted.current === key) return;
    attempted.current = key;
    mutate();
  }, [accountID, isPending, mutate, signature, targets.length]);
}

function unresolvedContactJIDs(records: WAContactRecord[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const jid = (record.jid || '').trim();
    if (!jid.endsWith('@lid') || seen.has(jid) || !needsResolve(record)) continue;
    seen.add(jid);
    out.push(jid);
  }
  return out;
}

function needsResolve(record: WAContactRecord) {
  const name = (record.display_name || '').trim();
  return !record.profile_picture_id || !record.number || !name || name === '未知联系人' || name.startsWith('LID ') || name.startsWith('联系人 ');
}
