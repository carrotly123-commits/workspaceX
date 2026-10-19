package store

import (
	"context"
	"errors"
	"fmt"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/jackc/pgx/v5"
)

func (s *PostgresStore) DeleteWAAccount(ctx context.Context, waAccountIDValue string) error {
	if s == nil || s.pool == nil {
		return fmt.Errorf("wa-app postgres store is not configured")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWAAccount(ctx, tx, waAccountIDValue); err != nil {
		return err
	}
	for _, statement := range waAccountDeleteStatements {
		if _, err := tx.Exec(ctx, statement, waAccountIDValue); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM wa_accounts WHERE wa_account_id=$1`, waAccountIDValue); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func lockWAAccount(ctx context.Context, tx pgx.Tx, waAccountIDValue string) error {
	var accountID string
	err := tx.QueryRow(ctx, `SELECT wa_account_id FROM wa_accounts WHERE wa_account_id=$1 FOR UPDATE`, waAccountIDValue).Scan(&accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_WA_ACCOUNT_NOT_FOUND, "WA account not found", false)
	}
	return err
}

var waAccountDeleteStatements = []string{
	`DELETE FROM wa_contacts WHERE wa_account_id=$1`,
	`DELETE FROM wa_extracted_candidates WHERE message_id IN (
		SELECT m.message_id FROM wa_inbound_messages m
		JOIN wa_message_sessions s ON s.message_session_id=m.message_session_id
		WHERE s.wa_account_id=$1
	)`,
	`DELETE FROM wa_decrypted_messages WHERE message_id IN (
		SELECT m.message_id FROM wa_inbound_messages m
		JOIN wa_message_sessions s ON s.message_session_id=m.message_session_id
		WHERE s.wa_account_id=$1
	)`,
	`DELETE FROM wa_inbound_messages WHERE message_session_id IN (
		SELECT message_session_id FROM wa_message_sessions WHERE wa_account_id=$1
	)`,
	`DELETE FROM wa_message_sessions WHERE wa_account_id=$1`,
	`DELETE FROM wa_otp_messages WHERE wa_account_id=$1`,
	`DELETE FROM wa_login_states WHERE wa_account_id=$1`,
	`DELETE FROM wa_registrations WHERE wa_account_id=$1`,
	`DELETE FROM wa_verification_requests WHERE wa_account_id=$1`,
	`DELETE FROM wa_account_probes WHERE wa_account_id=$1`,
	`DELETE FROM wa_client_profile_states WHERE client_profile_id IN (
		SELECT client_profile_id FROM wa_client_profiles WHERE wa_account_id=$1
	)`,
	`DELETE FROM wa_client_profiles WHERE wa_account_id=$1`,
}
