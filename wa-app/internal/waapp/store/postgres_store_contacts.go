package store

import (
	"context"
	"time"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wamodel"
	"github.com/jackc/pgx/v5"
)

func (s *PostgresStore) SaveWAContacts(ctx context.Context, contacts []*waappv1.WAContact) error {
	if len(contacts) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	queued := 0
	for _, contact := range contacts {
		contact = wamodel.NormalizedWAContactForStorage(contact)
		if contact == nil || contact.GetContactId() == "" || contact.GetWaAccountId() == "" {
			continue
		}
		createdAt := shared.TimeFromProto(contact.GetAudit().GetCreatedAt())
		updatedAt := shared.TimeFromProto(contact.GetAudit().GetUpdatedAt())
		batch.Queue(`INSERT INTO wa_contacts (contact_id, wa_account_id, jid, number, display_name, wa_name, verified_name, profile_picture_id, kind, is_whatsapp_user, is_reachable, created_at, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
ON CONFLICT (contact_id) DO UPDATE SET
  jid=EXCLUDED.jid,
  number=COALESCE(NULLIF(EXCLUDED.number,''), wa_contacts.number),
  display_name=CASE
    WHEN NULLIF(EXCLUDED.display_name,'') IS NULL THEN wa_contacts.display_name
    WHEN wa_contacts.display_name='' OR wa_contacts.display_name='未知联系人' OR wa_contacts.display_name LIKE '联系人 %' OR wa_contacts.display_name LIKE 'LID %' THEN EXCLUDED.display_name
    WHEN wa_contacts.display_name='0' OR wa_contacts.display_name ~ '^\+?[0-9]{6,}$' THEN EXCLUDED.display_name
    WHEN COALESCE(NULLIF(wa_contacts.number,''), NULLIF(EXCLUDED.number,''), '') <> '' AND wa_contacts.display_name='+' || COALESCE(NULLIF(wa_contacts.number,''), NULLIF(EXCLUDED.number,''), '') THEN EXCLUDED.display_name
    ELSE wa_contacts.display_name
  END,
  wa_name=COALESCE(NULLIF(EXCLUDED.wa_name,''), wa_contacts.wa_name),
  verified_name=COALESCE(NULLIF(EXCLUDED.verified_name,''), wa_contacts.verified_name),
  profile_picture_id=COALESCE(NULLIF(EXCLUDED.profile_picture_id,''), wa_contacts.profile_picture_id),
  kind=CASE WHEN EXCLUDED.kind IN ('WA_CONTACT_KIND_UNSPECIFIED','WA_CONTACT_KIND_USER') AND wa_contacts.kind <> '' THEN wa_contacts.kind ELSE EXCLUDED.kind END,
  is_whatsapp_user=wa_contacts.is_whatsapp_user OR EXCLUDED.is_whatsapp_user,
  is_reachable=wa_contacts.is_reachable OR EXCLUDED.is_reachable,
  updated_at=GREATEST(wa_contacts.updated_at, EXCLUDED.updated_at)`, contact.GetContactId(), contact.GetWaAccountId(), contact.GetJid(), contact.GetNumber(), contact.GetDisplayName(), contact.GetWaName(), contact.GetVerifiedName(), contact.GetProfilePictureId(), wamodel.ContactKindStorageValue(contact), contact.GetIsWhatsappUser(), contact.GetIsReachable(), createdAt, updatedAt)
		queued++
	}
	if queued == 0 {
		return nil
	}
	br := s.pool.SendBatch(ctx, batch)
	return br.Close()
}

func (s *PostgresStore) GetWAContact(ctx context.Context, contactID string) (*waappv1.WAContact, error) {
	var r contactRow
	row := s.pool.QueryRow(ctx, contactSelectSQL+` WHERE c.contact_id=$1`, contactID)
	if err := scanContactRow(row, &r); err != nil {
		return nil, notFound(err, waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND, "WA contact not found")
	}
	return r.toProto(), nil
}

func (s *PostgresStore) GetWAContactByRef(ctx context.Context, waAccountIDValue string, contactRef string) (*waappv1.WAContact, error) {
	refs := wamodel.ContactRefVariants(contactRef)
	var r contactRow
	row := s.pool.QueryRow(ctx, contactSelectSQL+` WHERE c.wa_account_id=$1 AND (c.contact_id=ANY($2) OR c.jid=ANY($2) OR c.number=ANY($2)) ORDER BY c.updated_at DESC LIMIT 1`, waAccountIDValue, refs)
	if err := scanContactRow(row, &r); err != nil {
		return nil, notFound(err, waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND, "WA contact not found")
	}
	return r.toProto(), nil
}

func (s *PostgresStore) ListWAContacts(ctx context.Context, waAccountIDValue string, cursorValue string, limit int) ([]*waappv1.WAContact, string, error) {
	cursor, err := shared.DecodeKeysetCursor(cursorValue)
	if err != nil {
		return nil, "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, err.Error(), false)
	}
	limit = shared.NormalizePageLimit(limit)
	rows, err := s.queryContactPage(ctx, waAccountIDValue, cursor, shared.KeysetLookaheadLimit(limit))
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	items := []*waappv1.WAContact{}
	for rows.Next() {
		var r contactRow
		if err := scanContactRow(rows, &r); err != nil {
			return nil, "", err
		}
		items = append(items, r.toProto())
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	items, nextCursor := shared.NewKeysetPage(items, limit, func(contact *waappv1.WAContact) shared.KeysetCursor {
		return shared.KeysetCursorValue(shared.TimeFromProto(contact.GetAudit().GetUpdatedAt()), contact.GetContactId())
	})
	return items, nextCursor, nil
}

func (s *PostgresStore) DeleteWAContact(ctx context.Context, waAccountIDValue string, refs []string, deletedAt time.Time) (DeleteWAContactResult, error) {
	refs = shared.UniqueNonEmptyStrings(refs...)
	if len(refs) == 0 {
		return DeleteWAContactResult{}, nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DeleteWAContactResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	messageTag, err := tx.Exec(ctx, `UPDATE wa_inbound_messages m
SET delete_status=$3, deleted_at=$4
FROM wa_message_sessions ms
WHERE ms.message_session_id=m.message_session_id
  AND ms.wa_account_id=$1
  AND COALESCE(NULLIF(m.contact_ref,''), m.sender_ref) = ANY($2)
  AND COALESCE(m.delete_status,'MESSAGE_DELETE_STATUS_NOT_DELETED')<>'MESSAGE_DELETE_STATUS_DELETED_FOR_ME'`,
		waAccountIDValue, refs, waappv1.MessageDeleteStatus_MESSAGE_DELETE_STATUS_DELETED_FOR_ME.String(), deletedAt.UTC())
	if err != nil {
		return DeleteWAContactResult{}, err
	}
	otpTag, err := tx.Exec(ctx, `DELETE FROM wa_otp_messages o
WHERE o.wa_account_id=$1 AND (
  o.source_party = ANY($2)
  OR EXISTS (
    SELECT 1
    FROM wa_inbound_messages m
    JOIN wa_message_sessions ms ON ms.message_session_id=m.message_session_id
    WHERE m.message_id=o.message_id
      AND ms.wa_account_id=$1
      AND COALESCE(NULLIF(m.contact_ref,''), m.sender_ref) = ANY($2)
      AND COALESCE(m.delete_status,'MESSAGE_DELETE_STATUS_NOT_DELETED')='MESSAGE_DELETE_STATUS_DELETED_FOR_ME'
  )
)`, waAccountIDValue, refs)
	if err != nil {
		return DeleteWAContactResult{}, err
	}
	contactTag, err := tx.Exec(ctx, `DELETE FROM wa_contacts
WHERE wa_account_id=$1
  AND (contact_id = ANY($2) OR jid = ANY($2) OR number = ANY($2))`,
		waAccountIDValue, refs)
	if err != nil {
		return DeleteWAContactResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return DeleteWAContactResult{}, err
	}
	return DeleteWAContactResult{
		Deleted:             messageTag.RowsAffected()+otpTag.RowsAffected()+contactTag.RowsAffected() > 0,
		DeletedMessageCount: int(messageTag.RowsAffected()),
	}, nil
}

func (s *PostgresStore) queryContactPage(ctx context.Context, waAccountIDValue string, cursor shared.KeysetCursor, limit int) (pgx.Rows, error) {
	if !shared.HasKeysetCursor(cursor) {
		return s.pool.Query(ctx, contactSelectSQL+` WHERE c.wa_account_id=$1 ORDER BY COALESCE(stats.last_message_at,c.updated_at) DESC, c.contact_id DESC LIMIT $2`, waAccountIDValue, limit)
	}
	return s.pool.Query(ctx, contactSelectSQL+` WHERE c.wa_account_id=$1 AND (COALESCE(stats.last_message_at,c.updated_at), c.contact_id) < ($2, $3) ORDER BY COALESCE(stats.last_message_at,c.updated_at) DESC, c.contact_id DESC LIMIT $4`, waAccountIDValue, cursor.UpdatedAt, cursor.ID, limit)
}

const contactSelectSQL = `SELECT c.contact_id,c.wa_account_id,c.jid,c.number,c.display_name,c.wa_name,c.verified_name,c.profile_picture_id,c.kind,c.is_whatsapp_user,c.is_reachable,c.created_at,c.updated_at,COALESCE(stats.message_count,0),COALESCE(stats.unread_count,0),stats.last_message_at,COALESCE(latest.plaintext_value,''),COALESCE(latest.plaintext_redacted,''),COALESCE(latest.payload_ref,''),COALESCE(latest.encryption_state,'')
FROM wa_contacts c
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS message_count,
         COUNT(*) FILTER (WHERE m.read_at IS NULL AND m.direction='ACCOUNT_MESSAGE_DIRECTION_INBOUND') AS unread_count,
         MAX(m.received_at) AS last_message_at
  FROM wa_inbound_messages m
  JOIN wa_message_sessions ms ON ms.message_session_id=m.message_session_id
  WHERE ms.wa_account_id=c.wa_account_id
    AND m.kind='INBOUND_MESSAGE_KIND_MESSAGE'
    AND COALESCE(NULLIF(m.contact_ref,''), m.sender_ref) IN (c.jid, c.number, CASE WHEN c.number<>'' THEN c.number || '@s.whatsapp.net' ELSE '' END)
    AND COALESCE(m.delete_status,'MESSAGE_DELETE_STATUS_NOT_DELETED')<>'MESSAGE_DELETE_STATUS_DELETED_FOR_ME'
) stats ON true
LEFT JOIN LATERAL (
  SELECT d.plaintext_value,d.plaintext_redacted,m.payload_ref,m.encryption_state
  FROM wa_inbound_messages m
  JOIN wa_message_sessions ms ON ms.message_session_id=m.message_session_id
  LEFT JOIN LATERAL (
    SELECT plaintext_value,plaintext_redacted
    FROM wa_decrypted_messages
    WHERE message_id=m.message_id
    ORDER BY decrypted_at DESC, decrypted_message_id DESC
    LIMIT 1
  ) d ON true
  WHERE ms.wa_account_id=c.wa_account_id
    AND m.kind='INBOUND_MESSAGE_KIND_MESSAGE'
    AND COALESCE(NULLIF(m.contact_ref,''), m.sender_ref) IN (c.jid, c.number, CASE WHEN c.number<>'' THEN c.number || '@s.whatsapp.net' ELSE '' END)
    AND COALESCE(m.delete_status,'MESSAGE_DELETE_STATUS_NOT_DELETED')<>'MESSAGE_DELETE_STATUS_DELETED_FOR_ME'
  ORDER BY m.received_at DESC, m.message_id DESC
  LIMIT 1
) latest ON true`

type contactScanner interface {
	Scan(...any) error
}

func scanContactRow(scanner contactScanner, r *contactRow) error {
	return scanner.Scan(&r.id, &r.waAccountIDValue, &r.jid, &r.number, &r.displayName, &r.waName, &r.verifiedName, &r.profilePictureID, &r.kind, &r.isWhatsAppUser, &r.isReachable, &r.createdAt, &r.updatedAt, &r.messageCount, &r.unreadCount, &r.lastMessageAt, &r.lastPlaintext, &r.lastRedacted, &r.lastPayloadRef, &r.lastEncryption)
}
