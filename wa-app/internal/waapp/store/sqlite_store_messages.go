package store

import (
	"context"
	"strings"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wamodel"
)

func (s *SQLiteStore) ListAccountMessages(ctx context.Context, waAccountIDValue string, contactRefs []string, cursorValue string, limit int, includeSensitiveText bool) ([]*waappv1.AccountMessage, string, error) {
	cursor, err := shared.DecodeKeysetCursor(cursorValue)
	if err != nil {
		return nil, "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, err.Error(), false)
	}
	contactRefs = shared.UniqueNonEmptyStrings(contactRefs...)
	if len(contactRefs) == 0 {
		return nil, "", nil
	}
	limit = shared.NormalizePageLimit(limit)
	rows, err := s.queryAccountMessages(ctx, waAccountIDValue, contactRefs, cursor, shared.KeysetLookaheadLimit(limit))
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	items := []*waappv1.AccountMessage{}
	for rows.Next() {
		message, decrypted, err := scanSQLiteAccountMessage(rows)
		if err != nil {
			return nil, "", err
		}
		item := wamodel.NewAccountMessageFromInbound(waAccountIDValue, message, decrypted, includeSensitiveText)
		if item != nil {
			items = append(items, item)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	items, nextCursor := shared.NewKeysetPage(items, limit, func(message *waappv1.AccountMessage) shared.KeysetCursor {
		return shared.KeysetCursorValue(shared.TimeFromProto(message.GetReceivedAt()), message.GetAccountMessageId())
	})
	return items, nextCursor, nil
}

func (s *SQLiteStore) ListUnreadInboundMessagesByContactRefs(ctx context.Context, waAccountIDValue string, contactRefs []string, limit int) ([]*waappv1.InboundMessage, error) {
	contactRefs = shared.UniqueNonEmptyStrings(contactRefs...)
	if len(contactRefs) == 0 {
		return nil, nil
	}
	inClause, inArgs := sqliteInClause("COALESCE(NULLIF(json_extract(m.payload, '$.contact_ref'), ''), json_extract(m.payload, '$.sender_ref'))", contactRefs)
	query := `SELECT m.payload
FROM wa_sqlite_inbound_messages m
JOIN wa_sqlite_message_sessions s ON s.id=m.message_session_id
WHERE s.wa_account_id=?
  AND json_extract(m.payload, '$.kind')=?
  AND COALESCE(json_extract(m.payload, '$.direction'), 'ACCOUNT_MESSAGE_DIRECTION_INBOUND')='ACCOUNT_MESSAGE_DIRECTION_INBOUND'
  AND json_extract(m.payload, '$.read_at') IS NULL
  AND ` + inClause + `
  AND COALESCE(json_extract(m.payload, '$.delete_status'), 'MESSAGE_DELETE_STATUS_NOT_DELETED')<>'MESSAGE_DELETE_STATUS_DELETED_FOR_ME'
ORDER BY m.received_at DESC, m.id DESC
LIMIT ?`
	args := append([]any{waAccountIDValue, waappv1.InboundMessageKind_INBOUND_MESSAGE_KIND_MESSAGE.String()}, inArgs...)
	args = append(args, normalizeMessageActionLimit(limit))
	return sqliteListPayloads(ctx, s.db, func() *waappv1.InboundMessage { return &waappv1.InboundMessage{} }, query, args...)
}

func (s *SQLiteStore) queryAccountMessages(ctx context.Context, waAccountIDValue string, contactRefs []string, cursor shared.KeysetCursor, limit int) (sqlRows, error) {
	query := `SELECT m.payload, COALESCE((
  SELECT d.payload
  FROM wa_sqlite_decrypted_messages d
  WHERE d.message_id=m.id
  ORDER BY d.decrypted_at DESC, d.id DESC
  LIMIT 1
), '')
FROM wa_sqlite_inbound_messages m
JOIN wa_sqlite_message_sessions s ON s.id=m.message_session_id
WHERE s.wa_account_id=? AND json_extract(m.payload, '$.kind')=? AND COALESCE(json_extract(m.payload, '$.delete_status'), 'MESSAGE_DELETE_STATUS_NOT_DELETED')<>'MESSAGE_DELETE_STATUS_DELETED_FOR_ME'`
	args := []any{waAccountIDValue, waappv1.InboundMessageKind_INBOUND_MESSAGE_KIND_MESSAGE.String()}
	inClause, inArgs := sqliteInClause("COALESCE(NULLIF(json_extract(m.payload, '$.contact_ref'), ''), json_extract(m.payload, '$.sender_ref'))", contactRefs)
	query += ` AND ` + inClause
	args = append(args, inArgs...)
	if shared.HasKeysetCursor(cursor) {
		value := SQLiteTimeValue(cursor.UpdatedAt)
		query += ` AND (m.received_at < ? OR (m.received_at = ? AND m.id < ?))`
		args = append(args, value, value, cursor.ID)
	}
	query += ` ORDER BY m.received_at DESC, m.id DESC LIMIT ?`
	args = append(args, limit)
	return s.db.QueryContext(ctx, query, args...)
}

type sqlRows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
	Close() error
}

func scanSQLiteAccountMessage(rows sqlRows) (*waappv1.InboundMessage, *waappv1.DecryptedMessage, error) {
	var messagePayload string
	var decryptedPayload string
	if err := rows.Scan(&messagePayload, &decryptedPayload); err != nil {
		return nil, nil, err
	}
	return scanSQLiteAccountMessagePayloads(messagePayload, decryptedPayload)
}

func scanSQLiteAccountMessageRow(row interface{ Scan(dest ...any) error }) (*waappv1.InboundMessage, *waappv1.DecryptedMessage, error) {
	var messagePayload string
	var decryptedPayload string
	if err := row.Scan(&messagePayload, &decryptedPayload); err != nil {
		return nil, nil, err
	}
	return scanSQLiteAccountMessagePayloads(messagePayload, decryptedPayload)
}

func scanSQLiteAccountMessagePayloads(messagePayload string, decryptedPayload string) (*waappv1.InboundMessage, *waappv1.DecryptedMessage, error) {
	message := &waappv1.InboundMessage{}
	if err := sqliteUnmarshal([]byte(messagePayload), message); err != nil {
		return nil, nil, err
	}
	if strings.TrimSpace(decryptedPayload) == "" {
		return message, nil, nil
	}
	decrypted := &waappv1.DecryptedMessage{}
	if err := sqliteUnmarshal([]byte(decryptedPayload), decrypted); err != nil {
		return nil, nil, err
	}
	return message, decrypted, nil
}
