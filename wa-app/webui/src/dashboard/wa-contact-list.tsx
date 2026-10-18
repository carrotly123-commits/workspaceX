import type { MouseEvent } from 'react';
import { useMemo, useRef, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { NavLink } from 'react-router';
import { WAContactKind } from '../proto/byte/v/forge/waapp/v1/contacts';
import type { OtpMessage } from '../proto/byte/v/forge/waapp/v1/extraction';
import type { WaContact } from './wa-chat-model';
import { formatChatTime } from './wa-chat-model';
import { WaContactAvatar } from './wa-contact-avatar';
import { WaContactOtpBanner } from './wa-contact-otp-banner';
import { waContactPath } from './wa-route-paths';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';

export function WaContactList({ accountID, contacts, selectedID, loading, error, deletingID, otp, onOpenContact, onDeleteContact }: { accountID: string; contacts: WaContact[]; selectedID: string; loading: boolean; error?: string; deletingID?: string; otp?: OtpMessage; onOpenContact: (contactID: string) => void; onDeleteContact: (contactID: string) => void }) {
  const [query, setQuery] = useState('');
  const visibleContacts = useMemo(() => filterContacts(contacts, query), [contacts, query]);
  const unreadCount = contacts.reduce((sum, contact) => sum + contact.unreadCount, 0);
  return (
    <aside className="grid min-h-0 grid-rows-[auto_1fr] overflow-hidden border-r border-border bg-card">
      <div className="space-y-3 px-3 py-3">
        <WaContactOtpBanner otp={otp} />
        <div className="flex items-center gap-2">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索联系人" aria-label="搜索联系人" />
          {loading && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
        </div>
        <p className="px-1 text-xs text-muted-foreground">{contacts.length} 个会话{unreadCount > 0 ? ` · ${unreadCount} 条未读` : ''}</p>
      </div>
      <div className="min-h-0 overflow-y-auto p-2">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {!loading && !error && contacts.length === 0 && <ContactEmpty title="暂无联系人" description="收到消息后会显示在这里。" />}
        {!loading && !error && contacts.length > 0 && visibleContacts.length === 0 && <ContactEmpty title="没有匹配联系人" description="换个关键词再试。" />}
        {visibleContacts.map((contact) => <ContactRow key={contact.id} accountID={accountID} contact={contact} selected={contact.id === selectedID} deleting={deletingID === contact.id} onOpenContact={onOpenContact} onDeleteContact={onDeleteContact} />)}
      </div>
    </aside>
  );
}

function ContactEmpty({ title, description }: { title: string; description: string }) {
  return <Empty className="border-0 p-4"><EmptyHeader><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader></Empty>;
}

function ContactRow({ accountID, contact, selected, deleting, onOpenContact, onDeleteContact }: { accountID: string; contact: WaContact; selected: boolean; deleting: boolean; onOpenContact: (contactID: string) => void; onDeleteContact: (contactID: string) => void }) {
  const unread = contact.unreadCount > 0;
  const holdTimer = useRef<number | undefined>(undefined);
  const revealedByHold = useRef(false);
  const [deleteVisible, setDeleteVisible] = useState(false);
  const revealDelete = (blockNextClick = true) => {
    revealedByHold.current = blockNextClick;
    setDeleteVisible(true);
  };
  const clearHold = () => window.clearTimeout(holdTimer.current);
  const startHold = () => {
    clearHold();
    holdTimer.current = window.setTimeout(() => revealDelete(), 650);
  };
  const openOrReveal = (event: MouseEvent<HTMLAnchorElement>) => {
    if (revealedByHold.current) {
      event.preventDefault();
      revealedByHold.current = false;
      return;
    }
    if (unread) onOpenContact(contact.id);
  };
  return (
    <div className={`mb-1 grid grid-cols-[1fr_auto] items-center rounded-2xl transition hover:bg-muted/60 ${selected ? 'bg-primary/10' : unread ? 'bg-emerald-50/70' : ''}`} onContextMenu={(event) => { event.preventDefault(); revealDelete(false); }}>
      <NavLink className="grid min-w-0 grid-cols-[42px_1fr_auto] items-center gap-3 px-3 py-2 text-left" to={waContactPath(accountID, contact.id)} title="长按显示删除" onClick={openOrReveal} onPointerDown={startHold} onPointerLeave={clearHold} onPointerCancel={clearHold} onPointerUp={clearHold}>
        <WaContactAvatar contact={contact} />
        <span className="min-w-0 space-y-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className={`truncate text-sm ${unread ? 'font-semibold text-foreground' : 'font-medium'}`}>{contact.title}</span>
            <ContactKindBadge kind={contact.kind} />
          </span>
          <span className={`block truncate text-xs ${unread ? 'font-medium text-foreground/85' : 'text-foreground/70'}`}>{contact.preview || contact.subtitle}</span>
          {contact.preview && contact.subtitle && <span className="block truncate text-[11px] text-muted-foreground">{contact.subtitle}</span>}
        </span>
        <span className="grid justify-items-end gap-1">
          <time className="text-[11px] text-muted-foreground">{formatChatTime(contact.lastAt)}</time>
          {unread && <Badge variant="default">{contact.unreadCount}</Badge>}
        </span>
      </NavLink>
      {deleteVisible && <Button className="mr-2 rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive" variant="ghost" size="icon" type="button" title="删除联系人" aria-label="删除联系人" disabled={deleting} onClick={() => onDeleteContact(contact.id)}>{deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 size={14} />}</Button>}
    </div>
  );
}

function ContactKindBadge({ kind }: { kind: WAContactKind }) {
  const label = kindLabel(kind);
  if (!label) return null;
  return <Badge variant="secondary">{label}</Badge>;
}

function filterContacts(contacts: WaContact[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return contacts;
  return contacts.filter((contact) => `${contact.title} ${contact.subtitle} ${contact.preview} ${contact.id}`.toLowerCase().includes(needle));
}

function kindLabel(kind: WAContactKind) {
  if (kind === WAContactKind.WA_CONTACT_KIND_GROUP) return '群';
  if (kind === WAContactKind.WA_CONTACT_KIND_BUSINESS) return '企';
  if (kind === WAContactKind.WA_CONTACT_KIND_SYSTEM) return '系统';
  if (kind === WAContactKind.WA_CONTACT_KIND_INTEROP) return '互通';
  return '';
}
