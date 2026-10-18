package store

import (
	"context"
	"database/sql"
	"fmt"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wamodel"
	"github.com/jackc/pgx/v5"
)

func (s *PostgresStore) ListAccountMessages(ctx context.Context, waAccountIDValue string, contactRefs []string, cursorValue string, limit int, includeSensitiveText bool) ([]*waappv1.AccountMessage, string, error) {
	cursor, err := shared.DecodeKeysetCursor(cursorValue)
	if err != nil {
		return nil, "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, err.Error(), false)
	}
	contactRefs = shared.UniqueNonEmptyStrings(contactRefs...)
	if len(contactRefs) == 0 {
		return nil, "", nil
	}
	limit = shared.NormalizePageLimit(limit)
	rows, err := s.queryAccountMessagePage(ctx, waAccountIDValue, contactRefs, cursor, shared.KeysetLookaheadLimit(limit))
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	items := []*waappv1.AccountMessage{}
	for rows.Next() {
		item, err := scanAccountMessage(rows, includeSensitiveText)
		if err != nil {
			return nil, "", err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	items, nextCursor := shared.NewKeysetPage(items, limit, func(message *waappv1.AccountMessage) shared.KeysetCursor {
		return shared.KeysetCursorValue(shared.TimeFromProto(message.GetReceivedAt()), message.GetAccountMessageId())
	})
	return items, nextCursor, nil
}

func (s *PostgresStore) queryAccountMessagePage(ctx context.Context, waAccountIDValue string, contactRefs []string, cursor shared.KeysetCursor, limit int) (pgx.Rows, error) {
	query := `SELECT m.message_id,ms.wa_account_id,m.message_session_id,m.kind,m.encryption_state,m.ack_status,m.direction,m.source,m.contact_ref,m.sender_ref,m.payload_ref,m.read_at,m.delete_status,m.deleted_at,COALESCE(d.plaintext_value,''),COALESCE(d.plaintext_redacted,''),COALESCE(d.plaintext_secret_ref,''),m.last_error_code,m.last_error_message,m.last_error_retryable,m.received_at
FROM wa_inbound_messages m
JOIN wa_message_sessions ms ON ms.message_session_id=m.message_session_id
LEFT JOIN LATERAL (
  SELECT plaintext_value,plaintext_redacted,plaintext_secret_ref
  FROM wa_decrypted_messages
  WHERE message_id=m.message_id
  ORDER BY decrypted_at DESC, decrypted_message_id DESC
  LIMIT 1
) d ON true
WHERE ms.wa_account_id=$1
  AND m.kind=$2
  AND COALESCE(NULLIF(m.contact_ref,''), m.sender_ref)=ANY($3)
  AND COALESCE(m.delete_status,'MESSAGE_DELETE_STATUS_NOT_DELETED')<>'MESSAGE_DELETE_STATUS_DELETED_FOR_ME'`
	args := []any{waAccountIDValue, waappv1.InboundMessageKind_INBOUND_MESSAGE_KIND_MESSAGE.String(), contactRefs}
	nextArg := 4
	if shared.HasKeysetCursor(cursor) {
		query += fmt.Sprintf(" AND (m.received_at, m.message_id) < ($%d, $%d)", nextArg, nextArg+1)
		args = append(args, cursor.UpdatedAt, cursor.ID)
		nextArg += 2
	}
	query += fmt.Sprintf(" ORDER BY m.received_at DESC, m.message_id DESC LIMIT $%d", nextArg)
	args = append(args, limit)
	return s.pool.Query(ctx, query, args...)
}

func scanAccountMessage(rows pgx.Rows, includeSensitiveText bool) (*waappv1.AccountMessage, error) {
	var parts wamodel.AccountMessageParts
	var kind string
	var encryptionState string
	var ackStatus string
	var errCode string
	var errMessage string
	var errRetryable bool
	var readAt sql.NullTime
	var deletedAt sql.NullTime
	var deleteStatus string
	var direction string
	var source string
	if err := rows.Scan(&parts.MessageID, &parts.AccountID, &parts.SessionID, &kind, &encryptionState, &ackStatus, &direction, &source, &parts.ContactRef, &parts.SenderRef, &parts.PayloadRef, &readAt, &deleteStatus, &deletedAt, &parts.Plaintext, &parts.Redacted, &parts.SecretRef, &errCode, &errMessage, &errRetryable, &parts.ReceivedAt); err != nil {
		return nil, err
	}
	parts.Kind = waappv1.InboundMessageKind(waappv1.InboundMessageKind_value[kind])
	parts.EncryptionState = waappv1.MessageEncryptionState(waappv1.MessageEncryptionState_value[encryptionState])
	parts.AckStatus = waappv1.MessageAckStatus(waappv1.MessageAckStatus_value[ackStatus])
	parts.Direction = messageDirection(direction)
	parts.Source = messageSource(source)
	if readAt.Valid {
		parts.ReadAt = readAt.Time.UTC()
	}
	parts.DeleteStatus = messageDeleteStatus(deleteStatus)
	if deletedAt.Valid {
		parts.DeletedAt = deletedAt.Time.UTC()
	}
	parts.LastError = protoError(errCode, errMessage, errRetryable)
	return wamodel.NewAccountMessage(parts, includeSensitiveText), nil
}

func (s *PostgresStore) ListUnreadInboundMessagesByContactRefs(ctx context.Context, waAccountIDValue string, contactRefs []string, limit int) ([]*waappv1.InboundMessage, error) {
	contactRefs = shared.UniqueNonEmptyStrings(contactRefs...)
	if len(contactRefs) == 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT m.message_id,m.message_session_id,m.kind,m.encryption_state,m.ack_status,m.direction,m.source,m.contact_ref,m.sender_ref,m.payload_ref,m.provider_message_id,m.provider_timestamp,m.read_at,m.delete_status,m.deleted_at,m.last_error_code,m.last_error_message,m.last_error_retryable,m.received_at
FROM wa_inbound_messages m
JOIN wa_message_sessions ms ON ms.message_session_id=m.message_session_id
WHERE ms.wa_account_id=$1
  AND m.kind=$2
  AND m.direction='ACCOUNT_MESSAGE_DIRECTION_INBOUND'
  AND m.read_at IS NULL
  AND COALESCE(NULLIF(m.contact_ref,''), m.sender_ref)=ANY($3)
  AND COALESCE(m.delete_status,'MESSAGE_DELETE_STATUS_NOT_DELETED')<>'MESSAGE_DELETE_STATUS_DELETED_FOR_ME'
ORDER BY m.received_at DESC, m.message_id DESC
LIMIT $4`, waAccountIDValue, waappv1.InboundMessageKind_INBOUND_MESSAGE_KIND_MESSAGE.String(), contactRefs, normalizeMessageActionLimit(limit))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := []*waappv1.InboundMessage{}
	for rows.Next() {
		msg, err := scanPostgresInboundMessage(rows)
		if err != nil {
			return nil, err
		}
		messages = append(messages, msg)
	}
	return messages, rows.Err()
}

func normalizeMessageActionLimit(limit int) int {
	if limit <= 0 || limit > wamodel.MaxMessageActionBatchSize {
		return wamodel.MaxMessageActionBatchSize
	}
	return limit
}
