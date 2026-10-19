package rpc

import (
	"context"
	"encoding/json"
	"log"
	"strings"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wamodel"
)

const pendingRegistrationCleanupPageLimit = 100

// markWAAccountTransferredOut 在账号被接管/转出(chatd device_removed/replaced 或 device_logout)时,
// 把账号级状态置为 TRANSFERRED_OUT,使仪表盘账号资料不再显示"正常"。账号不存在或已是该态则跳过;
// 再次注册到本端会经注册流回到 ACTIVE。
func (s *serverCore) markWAAccountTransferredOut(ctx context.Context, WAAccountID string) {
	if s == nil || strings.TrimSpace(WAAccountID) == "" {
		return
	}
	account, err := s.GetWAAccountRecord(ctx, WAAccountID)
	if err != nil || account == nil {
		return
	}
	if wamodel.WAAccountStatus(account) == waappv1.WAAccountStatus_WA_ACCOUNT_STATUS_TRANSFERRED_OUT {
		return
	}
	if _, err := s.SaveWAAccountRecord(ctx, withWAAccountStatus(account, waappv1.WAAccountStatus_WA_ACCOUNT_STATUS_TRANSFERRED_OUT, s.clock.Now())); err != nil {
		log.Printf("WA mark account transferred out failed: wa_account=%s error=%v", WAAccountID, shared.SanitizeLogError(err))
	}
}

func (s *serverCore) SaveWAAccountRecord(ctx context.Context, account *waappv1.WAAccount) (*waappv1.WAAccount, error) {
	if account == nil {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "WA account is required", false)
	}
	accountID, err := wamodel.RequireWAAccountID(account.GetWaAccountId())
	if err != nil {
		return nil, err
	}
	account.WaAccountId = accountID
	account.DisplayName = strings.TrimSpace(account.GetDisplayName())
	account.Phone = wamodel.NormalizePhone(account.GetPhone())
	account.Status = wamodel.NormalizeWAAccountStatus(account.GetStatus())
	if err := s.store.SaveWAAccount(ctx, account); err != nil {
		return nil, err
	}
	return s.store.GetWAAccount(ctx, accountID)
}

func (s *serverCore) GetWAAccountRecord(ctx context.Context, accountID string) (*waappv1.WAAccount, error) {
	accountID, err := wamodel.RequireWAAccountID(accountID)
	if err != nil {
		return nil, err
	}
	account, err := s.store.GetWAAccount(ctx, accountID)
	if wamodel.IsWAAccountNotFound(err) {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_WA_ACCOUNT_NOT_FOUND, "WA account not found", false)
	}
	return account, err
}

func (s *serverCore) listWAAccounts(ctx context.Context, cursor string, limit int) ([]*waappv1.WAAccount, string, error) {
	return s.store.ListWAAccounts(ctx, strings.TrimSpace(cursor), limit)
}

func (s *serverCore) deleteWAAccount(ctx context.Context, accountID string) (bool, error) {
	accountID, err := wamodel.RequireWAAccountID(accountID)
	if err != nil {
		return false, err
	}
	err = s.store.DeleteWAAccount(ctx, accountID)
	if wamodel.IsWAAccountNotFound(err) {
		return false, nil
	}
	return err == nil, err
}

func (s *serverCore) deletePendingRegistrationWAAccounts(ctx context.Context) (int, error) {
	cursor := ""
	deleted := 0
	for {
		accounts, nextCursor, err := s.listWAAccounts(ctx, cursor, pendingRegistrationCleanupPageLimit)
		if err != nil {
			return deleted, err
		}
		for _, account := range accounts {
			if wamodel.WAAccountStatus(account) != waappv1.WAAccountStatus_WA_ACCOUNT_STATUS_PENDING_REGISTRATION {
				continue
			}
			accountID := wamodel.WAAccountID(account)
			if accountID == "" {
				continue
			}
			s.deleteRegistrationOTPWaitForAccount(ctx, accountID)
			found, err := s.deleteWAAccount(ctx, accountID)
			if err != nil {
				return deleted, err
			}
			if found {
				deleted++
			}
		}
		if nextCursor == "" {
			return deleted, nil
		}
		cursor = nextCursor
	}
}

func (s *serverCore) deleteRegistrationOTPWaitForAccount(ctx context.Context, accountID string) {
	if s == nil || s.runtime == nil || strings.TrimSpace(accountID) == "" {
		return
	}
	accountKey := wamodel.RegistrationOTPWaitAccountKey(accountID)
	if data, err := s.runtime.GetTransientState(ctx, accountKey); err == nil {
		var wait wamodel.RegistrationOTPWait
		if json.Unmarshal(data, &wait) == nil && wait.VerificationRequestID != "" {
			_ = s.runtime.DeleteTransientState(ctx, wamodel.RegistrationOTPWaitKey(wait.VerificationRequestID))
		}
	}
	_ = s.runtime.DeleteTransientState(ctx, accountKey)
}
