export function waAccountPath(accountID: string) {
  return `/accounts/${encodeURIComponent(accountID)}`;
}

export function waChatsPath(accountID: string) {
  return `${waAccountPath(accountID)}/chats`;
}

export function waContactPath(accountID: string, contactID: string) {
  return `${waChatsPath(accountID)}/${encodeURIComponent(contactID)}`;
}
