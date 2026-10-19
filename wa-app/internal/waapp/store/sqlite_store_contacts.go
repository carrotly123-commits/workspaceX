package store

import (
	"context"
	"database/sql"
	"time"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wamodel"
)

func (s *SQLiteStore) SaveWAContacts(ctx context.Context, contacts []*waappv1.WAContact) error {
	if len(contacts) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, contact := range contacts {
		contact = wamodel.NormalizedWAContactForStorage(contact)
		if contact == nil || contact.GetContactId() == "" || contact.GetWaAccountId() == "" {
			continue
		}
		payload, err := sqliteMarshal(contact)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO wa_sqlite_contacts (id,wa_account_id,updated_at,payload) VALUES (?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  wa_account_id=excluded.wa_account_id,
  updated_at=excluded.updated_at,
  payload=CASE
    WHEN COALESCE(json_extract(wa_sqlite_contacts.payload, '$.display_name'), '') IN ('', '未知联系人') THEN excluded.payload
    WHEN COALESCE(json_extract(wa_sqlite_contacts.payload, '$.display_name'), '') LIKE '联系人 %' THEN excluded.payload
    WHEN COALESCE(json_extract(wa_sqlite_contacts.payload, '$.display_name'), '') LIKE 'LID %' THEN excluded.payload
    WHEN COALESCE(json_extract(wa_sqlite_contacts.payload, '$.display_name'), '') = '0' THEN excluded.payload
    WHEN length(ltrim(COALESCE(json_extract(wa_sqlite_contacts.payload, '$.display_name'), ''), '+')) >= 6
      AND ltrim(COALESCE(json_extract(wa_sqlite_contacts.payload, '$.display_name'), ''), '+') NOT GLOB '*[^0-9]*' THEN excluded.payload
    WHEN COALESCE(NULLIF(json_extract(wa_sqlite_contacts.payload, '$.number'), ''), NULLIF(json_extract(excluded.payload, '$.number'), ''), '') <> ''
      AND COALESCE(json_extract(wa_sqlite_contacts.payload, '$.display_name'), '') = '+' || COALESCE(NULLIF(json_extract(wa_sqlite_contacts.payload, '$.number'), ''), NULLIF(json_extract(excluded.payload, '$.number'), ''), '') THEN excluded.payload
    ELSE wa_sqlite_contacts.payload
  END`, contact.GetContactId(), contact.GetWaAccountId(), SQLiteTimeValue(shared.TimeFromProto(contact.GetAudit().GetUpdatedAt())), payload); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *SQLiteStore) GetWAContact(ctx context.Context, contactID string) (*waappv1.WAContact, error) {
	contact := &waappv1.WAContact{}
	if err := s.loadPayload(ctx, "wa_sqlite_contacts", contactID, contact, waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND, "WA contact not found"); err != nil {
		return nil, err
	}
	wamodel.EnrichWAContactFallback(contact)
	if err := s.enrichWAContactMessageStats(ctx, contact.GetWaAccountId(), contact); err != nil {
		return nil, err
	}
	return contact, nil
}

func (s *SQLiteStore) GetWAContactByRef(ctx context.Context, waAccountIDValue string, contactRef string) (*waappv1.WAContact, error) {
	refs := wamodel.ContactRefVariants(contactRef)
	idClause, idArgs := sqliteInClause("id", refs)
	jidClause, jidArgs := sqliteInClause("json_extract(payload, '$.jid')", refs)
	numberClause, numberArgs := sqliteInClause("json_extract(payload, '$.number')", refs)
	args := append([]any{waAccountIDValue}, idArgs...)
	args = append(args, jidArgs...)
	args = append(args, numberArgs...)
	row := s.db.QueryRowContext(ctx, `SELECT payload FROM wa_sqlite_contacts WHERE wa_account_id=? AND (`+idClause+` OR `+jidClause+` OR `+numberClause+`) ORDER BY updated_at DESC, id DESC LIMIT 1`, args...)
	var payload string
	if err := row.Scan(&payload); err != nil {
		return nil, sqliteNotFound(err, waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND, "WA contact not found")
	}
	contact := &waappv1.WAContact{}
	if err := sqliteUnmarshal([]byte(payload), contact); err != nil {
		return nil, err
	}
	wamodel.EnrichWAContactFallback(contact)
	if err := s.enrichWAContactMessageStats(ctx, waAccountIDValue, contact); err != nil {
		return nil, err
	}
	return contact, nil
}

func (s *SQLiteStore) ListWAContacts(ctx context.Context, waAccountIDValue string, cursorValue string, limit int) ([]*waappv1.WAContact, string, error) {
	cursor, err := shared.DecodeKeysetCursor(cursorValue)
	if err != nil {
		return nil, "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, err.Error(), false)
	}
	limit = shared.NormalizePageLimit(limit)
	lookahead := shared.KeysetLookaheadLimit(limit)
	query := `SELECT payload FROM wa_sqlite_contacts WHERE wa_account_id=?`
	args := []any{waAccountIDValue}
	if shared.HasKeysetCursor(cursor) {
		value := SQLiteTimeValue(cursor.UpdatedAt)
		query += ` AND (updated_at < ? OR (updated_at = ? AND id < ?))`
		args = append(args, value, value, cursor.ID)
	}
	query += ` ORDER BY updated_at DESC, id DESC LIMIT ?`
	args = append(args, lookahead)
	items, err := sqliteListPayloads(ctx, s.db, func() *waappv1.WAContact { return &waappv1.WAContact{} }, query, args...)
	if err != nil {
		return nil, "", err
	}
	for _, item := range items {
		wamodel.EnrichWAContactFallback(item)
		if err := s.enrichWAContactMessageStats(ctx, waAccountIDValue, item); err != nil {
			return nil, "", err
		}
	}
	items, nextCursor := shared.NewKeysetPage(items, limit, func(contact *waappv1.WAContact) shared.KeysetCursor {
		return shared.KeysetCursorValue(shared.TimeFromProto(contact.GetAudit().GetUpdatedAt()), contact.GetContactId())
	})
	return items, nextCursor, nil
}

func (s *SQLiteStore) DeleteWAContact(ctx context.Context, waAccountIDValue string, refs []string, deletedAt time.Time) (DeleteWAContactResult, error) {
	refs = shared.UniqueNonEmptyStrings(refs...)
	if len(refs) == 0 {
		return DeleteWAContactResult{}, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return DeleteWAContactResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	deletedStatus := waappv1.MessageDeleteStatus_MESSAGE_DELETE_STATUS_DELETED_FOR_ME.String()
	deletedTime := deletedAt.UTC().Format(time.RFC3339Nano)
	messageRefClause, messageRefArgs := sqliteInClause("COALESCE(NULLIF(json_extract(payload, '$.contact_ref'), ''), json_extract(payload, '$.sender_ref'))", refs)
	messageArgs := append([]any{deletedStatus, deletedTime, waAccountIDValue}, messageRefArgs...)
	messageResult, err := tx.ExecContext(ctx, `UPDATE wa_sqlite_inbound_messages
SET payload=json_set(payload, '$.delete_status', ?, '$.deleted_at', ?)
WHERE EXISTS (
  SELECT 1 FROM wa_sqlite_message_sessions s
  WHERE s.id=wa_sqlite_inbound_messages.message_session_id AND s.wa_account_id=?
)
AND `+messageRefClause+`
AND COALESCE(json_extract(payload, '$.delete_status'), 'MESSAGE_DELETE_STATUS_NOT_DELETED')<>'MESSAGE_DELETE_STATUS_DELETED_FOR_ME'`, messageArgs...)
	if err != nil {
		return DeleteWAContactResult{}, err
	}
	otpSourceClause, otpSourceArgs := sqliteInClause("json_extract(payload, '$.source_party')", refs)
	otpMessageClause, otpMessageArgs := sqliteInClause("COALESCE(NULLIF(json_extract(m.payload, '$.contact_ref'), ''), json_extract(m.payload, '$.sender_ref'))", refs)
	otpArgs := append([]any{waAccountIDValue}, otpSourceArgs...)
	otpArgs = append(otpArgs, waAccountIDValue)
	otpArgs = append(otpArgs, otpMessageArgs...)
	otpResult, err := tx.ExecContext(ctx, `DELETE FROM wa_sqlite_otp_messages
WHERE wa_account_id=? AND (
  `+otpSourceClause+`
  OR EXISTS (
    SELECT 1
    FROM wa_sqlite_inbound_messages m
    JOIN wa_sqlite_message_sessions s ON s.id=m.message_session_id
    WHERE m.id=json_extract(wa_sqlite_otp_messages.payload, '$.message_id')
      AND s.wa_account_id=?
      AND `+otpMessageClause+`
      AND COALESCE(json_extract(m.payload, '$.delete_status'), 'MESSAGE_DELETE_STATUS_NOT_DELETED')='MESSAGE_DELETE_STATUS_DELETED_FOR_ME'
  )
)`, otpArgs...)
	if err != nil {
		return DeleteWAContactResult{}, err
	}
	contactIDClause, contactIDArgs := sqliteInClause("id", refs)
	jidClause, jidArgs := sqliteInClause("json_extract(payload, '$.jid')", refs)
	numberClause, numberArgs := sqliteInClause("json_extract(payload, '$.number')", refs)
	contactArgs := append([]any{waAccountIDValue}, contactIDArgs...)
	contactArgs = append(contactArgs, jidArgs...)
	contactArgs = append(contactArgs, numberArgs...)
	contactResult, err := tx.ExecContext(ctx, `DELETE FROM wa_sqlite_contacts
WHERE wa_account_id=?
  AND (`+contactIDClause+` OR `+jidClause+` OR `+numberClause+`)`, contactArgs...)
	if err != nil {
		return DeleteWAContactResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return DeleteWAContactResult{}, err
	}
	messageCount, _ := messageResult.RowsAffected()
	otpCount, _ := otpResult.RowsAffected()
	contactCount, _ := contactResult.RowsAffected()
	return DeleteWAContactResult{Deleted: messageCount+otpCount+contactCount > 0, DeletedMessageCount: int(messageCount)}, nil
}

func (s *SQLiteStore) enrichWAContactMessageStats(ctx context.Context, waAccountIDValue string, contact *waappv1.WAContact) error {
	refs := wamodel.ContactMessageRefs(contact)
	primaryRef := sqliteContactRef(refs, 0)
	secondaryRef := sqliteContactRef(refs, 1)
	jidRef := sqliteContactRef(refs, 2)
	var messageCount int32
	var unreadCount int32
	var lastMessageAt int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*),
  COALESCE(SUM(CASE WHEN json_extract(m.payload, '$.read_at') IS NULL AND COALESCE(json_extract(m.payload, '$.direction'), 'ACCOUNT_MESSAGE_DIRECTION_INBOUND')='ACCOUNT_MESSAGE_DIRECTION_INBOUND' THEN 1 ELSE 0 END), 0),
  COALESCE(MAX(m.received_at), 0)
FROM wa_sqlite_inbound_messages m
JOIN wa_sqlite_message_sessions s ON s.id=m.message_session_id
WHERE s.wa_account_id=?
  AND json_extract(m.payload, '$.kind')=?
  AND COALESCE(NULLIF(json_extract(m.payload, '$.contact_ref'), ''), json_extract(m.payload, '$.sender_ref')) IN (?, ?, ?)
  AND COALESCE(json_extract(m.payload, '$.delete_status'), 'MESSAGE_DELETE_STATUS_NOT_DELETED')<>'MESSAGE_DELETE_STATUS_DELETED_FOR_ME'`,
		waAccountIDValue, waappv1.InboundMessageKind_INBOUND_MESSAGE_KIND_MESSAGE.String(), primaryRef, secondaryRef, jidRef).Scan(&messageCount, &unreadCount, &lastMessageAt); err != nil {
		return err
	}
	contact.MessageCount = messageCount
	contact.UnreadCount = unreadCount
	if lastMessageAt > 0 {
		contact.LastMessageAt = shared.ProtoTimestamp(time.Unix(0, lastMessageAt).UTC())
	}
	preview, err := s.latestWAContactMessagePreview(ctx, waAccountIDValue, primaryRef, secondaryRef, jidRef)
	if err != nil {
		return err
	}
	contact.LastMessagePreview = preview
	return nil
}

func (s *SQLiteStore) latestWAContactMessagePreview(ctx context.Context, waAccountIDValue string, primaryRef string, secondaryRef string, jidRef string) (string, error) {
	row := s.db.QueryRowContext(ctx, `SELECT m.payload, COALESCE((
  SELECT d.payload
  FROM wa_sqlite_decrypted_messages d
  WHERE d.message_id=m.id
  ORDER BY d.decrypted_at DESC, d.id DESC
  LIMIT 1
), '')
FROM wa_sqlite_inbound_messages m
JOIN wa_sqlite_message_sessions s ON s.id=m.message_session_id
WHERE s.wa_account_id=?
  AND json_extract(m.payload, '$.kind')=?
  AND COALESCE(NULLIF(json_extract(m.payload, '$.contact_ref'), ''), json_extract(m.payload, '$.sender_ref')) IN (?, ?, ?)
  AND COALESCE(json_extract(m.payload, '$.delete_status'), 'MESSAGE_DELETE_STATUS_NOT_DELETED')<>'MESSAGE_DELETE_STATUS_DELETED_FOR_ME'
ORDER BY m.received_at DESC, m.id DESC
LIMIT 1`, waAccountIDValue, waappv1.InboundMessageKind_INBOUND_MESSAGE_KIND_MESSAGE.String(), primaryRef, secondaryRef, jidRef)
	message, decrypted, err := scanSQLiteAccountMessageRow(row)
	if err != nil {
		if err == sql.ErrNoRows {
			return "", nil
		}
		return "", err
	}
	text := decrypted.GetPlaintextText()
	return wamodel.ContactMessagePreview(text.GetValue(), text.GetRedactedValue(), message.GetPayloadRef(), message.GetEncryptionState()), nil
}

func sqliteContactRef(refs []string, index int) string {
	if index >= 0 && index < len(refs) {
		return refs[index]
	}
	return ""
}
