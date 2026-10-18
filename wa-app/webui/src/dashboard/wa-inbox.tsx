import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router';
import type { OtpMessage } from '../proto/byte/v/forge/waapp/v1/extraction';
import type { WAAccount } from '../proto/byte/v/forge/waapp/v1/profile';
import { deleteWaContact, getWaAccountOtpMessages, getWaContacts, getWaMessages, markWaMessagesRead, sendWaTextMessage, waAccountID, waKeys } from './wa-api';
import { useWaContactAutoResolve } from './wa-contact-resolve';
import { buildWaChatEvents, buildWaContacts } from './wa-chat-model';
import { WaChatThread } from './wa-chat-thread';
import { WaContactList } from './wa-contact-list';
import { waContactPath } from './wa-route-paths';

type MarkReadInput = { contactID?: string };

export function WaInbox({ account, contactID }: { account: WAAccount; contactID: string }) {
  const accountID = waAccountID(account);
  const queryClient = useQueryClient();
  const contactsQuery = useQuery({ queryKey: waKeys.contacts(accountID), queryFn: () => getWaContacts(accountID), enabled: Boolean(accountID), refetchInterval: 30000 });
  useWaContactAutoResolve(accountID, contactsQuery.data?.contacts || []);
  const baseContacts = useMemo(() => buildWaContacts([], contactsQuery.data?.contacts || []), [contactsQuery.data?.contacts]);
  const activeContactID = baseContacts.some((contact) => contact.id === contactID) ? contactID : baseContacts[0]?.id || '';
  const messagesQuery = useQuery({ queryKey: waKeys.messages(accountID, activeContactID), queryFn: () => getWaMessages(accountID, activeContactID), enabled: Boolean(accountID && activeContactID), refetchInterval: 8000 });
  const otpQuery = useQuery({ queryKey: waKeys.otpMessages(accountID), queryFn: () => getWaAccountOtpMessages(accountID, { limit: 5, includeSensitiveValues: true }), enabled: Boolean(accountID), refetchInterval: 5000 });
  const events = useMemo(() => buildWaChatEvents(messagesQuery.data?.messages || []), [messagesQuery.data?.messages]);
  const contacts = baseContacts;
  const activeContact = contacts.find((contact) => contact.id === activeContactID);
  const activeOtp = useMemo(() => latestActiveOtp(otpQuery.data?.otp_messages || []), [otpQuery.data?.otp_messages]);
  const threadEvents = events;
  const refreshMessageViews = async (messageContactID = activeContactID) => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: waKeys.messages(accountID, messageContactID) }), queryClient.invalidateQueries({ queryKey: waKeys.contacts(accountID) }), queryClient.invalidateQueries({ queryKey: waKeys.otpMessages(accountID) })]);
  };
  const markReadMutation = useMutation({
    mutationFn: async (input: MarkReadInput) => {
      const resp = await markWaMessagesRead(accountID, { contactRef: input.contactID });
      if (resp.error?.message) throw new Error(resp.error.message);
      return resp;
    },
    onSettled: (_data, _error, input) => refreshMessageViews(input.contactID || activeContactID),
  });
  const deleteContactMutation = useMutation({
    mutationFn: async (deleteContactID: string) => {
      const resp = await deleteWaContact(accountID, deleteContactID);
      if (resp.error?.message) throw new Error(resp.error.message);
      return resp;
    },
    onSettled: () => refreshMessageViews(),
  });
  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      const resp = await sendWaTextMessage(accountID, activeContactID, text);
      if (resp.error?.message) throw new Error(resp.error.message);
      return resp;
    },
    onSettled: () => refreshMessageViews(),
  });
  const error = messagesQuery.data?.error?.message || contactsQuery.data?.error?.message || otpQuery.data?.error?.message || mutationError(markReadMutation.error) || mutationError(deleteContactMutation.error) || mutationError(sendMutation.error);
  if (activeContactID && activeContactID !== contactID) return <Navigate to={waContactPath(accountID, activeContactID)} replace />;
  return (
    <section className="grid h-dvh min-h-0 md:grid-cols-[320px_minmax(0,1fr)]">
      <WaContactList accountID={accountID} contacts={contacts} selectedID={activeContactID} loading={contactsQuery.isLoading} error={error} deletingID={deleteContactMutation.variables} otp={activeOtp} onOpenContact={(id) => openContact(id, markReadMutation.mutate)} onDeleteContact={(id) => deleteContact(id, deleteContactMutation.mutate)} />
      <WaChatThread contact={activeContact} events={threadEvents} loading={messagesQuery.isFetching || contactsQuery.isFetching} sending={sendMutation.isPending} error={error} onSendMessage={(text) => sendMutation.mutateAsync(text)} />
    </section>
  );
}

function openContact(contactID: string, mutate: (input: MarkReadInput) => void) {
  if (contactID) mutate({ contactID });
}

function deleteContact(contactID: string, mutate: (contactID: string) => void) {
  if (!contactID) return;
  if (window.confirm('删除该联系人和本地会话？')) mutate(contactID);
}

function mutationError(error: unknown) {
  return error instanceof Error ? error.message : '';
}

function latestActiveOtp(messages: OtpMessage[]) {
  const now = Date.now();
  return messages.find((message) => {
    const expiresAt = Date.parse(message.expires_at || '');
    const code = message.otp?.value || message.otp?.redacted_value || '';
    return Boolean(code) && Number.isFinite(expiresAt) && expiresAt > now;
  });
}
