import type { ThreadMessageLike } from '@assistant-ui/react';
import type { WAContact as WAContactRecord } from '../proto/byte/v/forge/waapp/v1/contacts';
import { WAContactKind } from '../proto/byte/v/forge/waapp/v1/contacts';
import type { AccountMessage } from '../proto/byte/v/forge/waapp/v1/messaging';
import { AccountMessageDirection, AccountMessageSource, InboundMessageKind, MessageEncryptionState } from '../proto/byte/v/forge/waapp/v1/messaging';

export type WaChatEvent = {
  id: string;
  contactID: string;
  text: string;
  at?: Date;
  source: string;
  sender: string;
  copyText?: string;
  outgoing: boolean;
  read: boolean;
  canMarkRead: boolean;
  readAt?: Date;
};

export type WaContact = {
  id: string;
  title: string;
  subtitle: string;
  kind: WAContactKind;
  unreadCount: number;
  preview: string;
  lastAt?: Date;
  profilePictureURL?: string;
  statsFromRecord?: boolean;
};

export type WaChatMeta = Pick<WaChatEvent, 'source' | 'sender' | 'copyText' | 'outgoing' | 'read' | 'canMarkRead' | 'readAt'> & { displayText: string };

export function buildWaChatEvents(messages: AccountMessage[]) {
  return messages.filter((message) => message.kind === InboundMessageKind.INBOUND_MESSAGE_KIND_MESSAGE).sort(byMessageTime).map(messageEvent).filter(isKnownChatEvent);
}

export function buildWaContacts(events: WaChatEvent[], records: WAContactRecord[] = []) {
  const contacts = new Map<string, WaContact>();
  for (const record of records) {
    const id = recordContactID(record);
    if (!id) continue;
    contacts.set(id, { id, title: recordTitle(record), subtitle: recordSubtitle(record), kind: record.kind || WAContactKind.WA_CONTACT_KIND_UNSPECIFIED, unreadCount: record.unread_count || 0, preview: record.last_message_preview || '', lastAt: parseDate(record.last_message_at) || parseDate(record.audit?.updated_at), profilePictureURL: contactProfilePictureURL(record), statsFromRecord: true });
  }
  for (const event of events) {
    const current = contacts.get(event.contactID);
    const keepRecordStats = Boolean(current?.statsFromRecord);
    contacts.set(event.contactID, {
      id: event.contactID,
      title: current?.title || event.sender,
      subtitle: current?.subtitle || event.source,
      kind: current?.kind || WAContactKind.WA_CONTACT_KIND_UNSPECIFIED,
      unreadCount: keepRecordStats ? current?.unreadCount || 0 : (current?.unreadCount || 0) + (isUnreadChatEvent(event) ? 1 : 0),
      preview: current?.preview || event.text,
      lastAt: newerDate(current?.lastAt, event.at),
      profilePictureURL: current?.profilePictureURL,
      statsFromRecord: keepRecordStats,
    });
  }
  return [...contacts.values()].sort(compareContacts);
}

export function toAssistantMessage(event: WaChatEvent): ThreadMessageLike {
  const role = event.outgoing ? 'user' : 'assistant';
  const message: ThreadMessageLike = {
    id: event.id,
    role,
    content: event.text,
    createdAt: event.at,
    metadata: { custom: { source: event.source, sender: event.sender, copyText: event.copyText, outgoing: event.outgoing, displayText: event.text, read: event.read, canMarkRead: event.canMarkRead, readAt: event.readAt } satisfies WaChatMeta },
  };
  return role === 'assistant' ? { ...message, status: { type: 'complete', reason: 'stop' } } : message;
}

export function formatChatTime(value?: Date) {
  if (!value) return '';
  return value.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function messageEvent(item: AccountMessage): WaChatEvent {
  const text = item.text?.value || item.text?.redacted_value || messageStateLabel(item.encryption_state);
  return {
    id: item.account_message_id || item.message_session_id || `${item.wa_account_id}-${item.received_at}`,
    contactID: (item.contact_ref || item.sender_ref || '').trim() || 'unknown',
    text,
    at: parseDate(item.received_at),
    source: messageSourceLabel(item),
    sender: sourcePartyLabel(item.sender_ref || item.contact_ref),
    copyText: item.text?.value || '',
    outgoing: item.direction === AccountMessageDirection.ACCOUNT_MESSAGE_DIRECTION_OUTBOUND,
    read: Boolean(item.read_at),
    canMarkRead: item.direction !== AccountMessageDirection.ACCOUNT_MESSAGE_DIRECTION_OUTBOUND,
    readAt: parseDate(item.read_at),
  };
}

export function isUnreadChatEvent(event: WaChatEvent) {
  return event.canMarkRead && !event.outgoing && !event.read;
}

function newerDate(a?: Date, b?: Date) { return !a ? b : !b ? a : a.getTime() > b.getTime() ? a : b; }

function byMessageTime(a: AccountMessage, b: AccountMessage) {
  return (parseDate(a.received_at)?.getTime() || 0) - (parseDate(b.received_at)?.getTime() || 0);
}

function sourcePartyLabel(value?: string) {
  const raw = (value || '').trim();
  if (!raw) return '未知联系人';
  if (raw === 's.whatsapp.net') return '系统';
  if (raw.endsWith('@s.whatsapp.net')) return `+${raw.replace(/@s\.whatsapp\.net$/, '')}`;
  if (raw.endsWith('@lid')) return '未知联系人';
  return raw;
}

function recordContactID(record: WAContactRecord) { return (record.jid || record.number || record.contact_id || '').trim(); }

function contactProfilePictureURL(record: WAContactRecord) {
  if (!record.contact_id || record.kind === WAContactKind.WA_CONTACT_KIND_SYSTEM) return undefined;
  const version = record.profile_picture_id || record.audit?.updated_at || 'latest';
  return `/api/wa/contacts/${encodeURIComponent(record.contact_id)}/profile-picture?v=${encodeURIComponent(version)}`;
}

function recordTitle(record: WAContactRecord) {
  const name = firstContactName(record);
  if (record.kind === WAContactKind.WA_CONTACT_KIND_BUSINESS) return name || '企业联系人';
  return name || phoneTitle(record.number) || sourcePartyLabel(record.jid) || '未知联系人';
}

function recordSubtitle(record: WAContactRecord) {
  if (record.kind === WAContactKind.WA_CONTACT_KIND_SYSTEM) return '';
  if (record.kind === WAContactKind.WA_CONTACT_KIND_BUSINESS) return '';
  if (record.number) return `+${record.number}`;
  if (record.jid?.endsWith('@lid')) return 'WA 联系人';
  return sourcePartyLabel(record.jid);
}

function compareContacts(a: WaContact, b: WaContact) {
  const delta = (b.lastAt?.getTime() || 0) - (a.lastAt?.getTime() || 0);
  return delta || a.title.localeCompare(b.title);
}

function isKnownChatEvent(event: WaChatEvent) {
  return event.contactID.trim() !== '' && event.contactID !== 'unknown';
}

function messageSourceLabel(item: AccountMessage) {
  if (item.source === AccountMessageSource.ACCOUNT_MESSAGE_SOURCE_LOCAL_SEND) return '已发送';
  if (item.source === AccountMessageSource.ACCOUNT_MESSAGE_SOURCE_IMPORTED_HISTORY) return '导入历史';
  if (item.encryption_state === MessageEncryptionState.MESSAGE_ENCRYPTION_STATE_DECRYPTION_FAILED) return '解密失败';
  if (item.encryption_state === MessageEncryptionState.MESSAGE_ENCRYPTION_STATE_ENCRYPTED) return '待解密';
  return 'WA 消息';
}

function messageStateLabel(state?: MessageEncryptionState) {
  if (state === MessageEncryptionState.MESSAGE_ENCRYPTION_STATE_ENCRYPTED) return '消息待解密';
  if (state === MessageEncryptionState.MESSAGE_ENCRYPTION_STATE_DECRYPTION_FAILED) return '消息解密失败';
  return '空消息';
}

function safeContactName(value?: string) {
  const name = (value || '').trim();
  if (!name || name === '0' || name === '未知联系人' || name.startsWith('LID ') || name.startsWith('企业账号 ') || isPhoneFallbackName(name)) return '';
  return name;
}

function firstContactName(record: WAContactRecord) {
  return safeContactName(record.display_name) || safeContactName(record.verified_name) || safeContactName(record.wa_name);
}

function isPhoneFallbackName(value: string) {
  return /^\+?\d{6,}$/.test(value) || /^联系人 \+?\d{6,}$/.test(value);
}

function phoneTitle(number?: string) {
  const value = (number || '').trim();
  return value ? `+${value}` : '';
}

function parseDate(value?: string) { const time = value ? new Date(value) : undefined; return time && !Number.isNaN(time.getTime()) ? time : undefined; }
