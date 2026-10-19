package rpc

import (
	"context"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/engine"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
	"github.com/byte-v-forge/wa-app/internal/waapp/wamodel"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const (
	accountProfileNameMaxRunes = 25
)

func (s *accountSettingsHandler) GetTwoFactorAuthStatus(ctx context.Context, req *waappv1.GetTwoFactorAuthStatusRequest) (*waappv1.GetTwoFactorAuthStatusResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.GetTwoFactorAuthStatusResponse{Error: shared.ToProtoError(err)}, nil
	}
	if !req.GetRemoteRefresh() {
		status, err := s.cachedTwoFactorAuthStatus(ctx, req.GetSelector())
		if err != nil {
			return &waappv1.GetTwoFactorAuthStatusResponse{Error: shared.ToProtoError(err)}, nil
		}
		return &waappv1.GetTwoFactorAuthStatusResponse{Status: status}, nil
	}
	status, appErr, err := s.refreshTwoFactorAuthStatus(ctx, req.GetContext(), req.GetSelector())
	if err != nil {
		return &waappv1.GetTwoFactorAuthStatusResponse{Error: shared.ToProtoError(err)}, nil
	}
	if appErr != nil {
		return &waappv1.GetTwoFactorAuthStatusResponse{Error: appErr}, nil
	}
	return &waappv1.GetTwoFactorAuthStatusResponse{Status: status}, nil
}

func (s *accountSettingsHandler) SetTwoFactorAuthSettings(ctx context.Context, req *waappv1.SetTwoFactorAuthSettingsRequest) (*waappv1.SetTwoFactorAuthSettingsResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.SetTwoFactorAuthSettingsResponse{Error: shared.ToProtoError(err)}, nil
	}
	pin, err := accountSettingsSensitiveValue(req.GetPin(), "pin", true)
	if err != nil {
		return &waappv1.SetTwoFactorAuthSettingsResponse{Error: shared.ToProtoError(err)}, nil
	}
	pin, err = requireSixDigits(pin, "pin")
	if err != nil {
		return &waappv1.SetTwoFactorAuthSettingsResponse{Error: shared.ToProtoError(err)}, nil
	}
	op, err := s.applyAccountSettings(ctx, req.GetContext(), req.GetSelector(), waappv1.AccountSettingsOperationKind_ACCOUNT_SETTINGS_OPERATION_KIND_TWO_FACTOR_AUTH_SETTINGS, func(input wacore.EngineAccountSettingsInput) wacore.EngineAccountSettingsInput {
		input.Pin = pin
		return input
	})
	if err != nil {
		return &waappv1.SetTwoFactorAuthSettingsResponse{Error: shared.ToProtoError(err)}, nil
	}
	if op.GetError() == nil {
		if err := s.patchTwoFactorAuthStatus(ctx, op.GetWaAccountId(), accountSettingsCompletedAt(op, s.clock.Now()), func(status *waappv1.TwoFactorAuthStatus) {
			status.Configured = true
		}); err != nil {
			return &waappv1.SetTwoFactorAuthSettingsResponse{Operation: op, Error: shared.ToProtoError(err)}, nil
		}
	}
	return &waappv1.SetTwoFactorAuthSettingsResponse{Operation: op, Error: op.GetError()}, nil
}

func (s *accountSettingsHandler) SetAccountEmail(ctx context.Context, req *waappv1.SetAccountEmailRequest) (*waappv1.SetAccountEmailResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.SetAccountEmailResponse{Error: shared.ToProtoError(err)}, nil
	}
	emailAddress, err := requiredEmailAddress(req.GetEmailAddress(), "email_address")
	if err != nil {
		return &waappv1.SetAccountEmailResponse{Error: shared.ToProtoError(err)}, nil
	}
	googleIDToken, err := accountSettingsSensitiveValue(req.GetGoogleIdToken(), "google_id_token", false)
	if err != nil {
		return &waappv1.SetAccountEmailResponse{Error: shared.ToProtoError(err)}, nil
	}
	op, result, err := s.applyAccountSettingsResult(ctx, req.GetContext(), req.GetSelector(), waappv1.AccountSettingsOperationKind_ACCOUNT_SETTINGS_OPERATION_KIND_ACCOUNT_EMAIL_SET, func(input wacore.EngineAccountSettingsInput) wacore.EngineAccountSettingsInput {
		input.EmailAddress = emailAddress
		input.GoogleIDToken = googleIDToken
		return input
	})
	if err != nil {
		return &waappv1.SetAccountEmailResponse{Error: shared.ToProtoError(err)}, nil
	}
	if op.GetError() == nil {
		if err := s.patchTwoFactorAuthStatus(ctx, op.GetWaAccountId(), accountSettingsCompletedAt(op, s.clock.Now()), func(status *waappv1.TwoFactorAuthStatus) {
			mergeTwoFactorAuthStatus(status, result.TwoFactorStatus)
			if status.GetEmailAddress() == "" {
				status.EmailAddress = emailAddress
			}
			status.EmailConfigured = status.GetEmailConfigured() || status.GetEmailAddress() != ""
		}); err != nil {
			return &waappv1.SetAccountEmailResponse{Operation: op, Error: shared.ToProtoError(err)}, nil
		}
	}
	return &waappv1.SetAccountEmailResponse{Operation: op, Error: op.GetError()}, nil
}

func (s *accountSettingsHandler) RequestAccountEmailOtp(ctx context.Context, req *waappv1.RequestAccountEmailOtpRequest) (*waappv1.RequestAccountEmailOtpResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.RequestAccountEmailOtpResponse{Error: shared.ToProtoError(err)}, nil
	}
	op, err := s.applyAccountSettings(ctx, req.GetContext(), req.GetSelector(), waappv1.AccountSettingsOperationKind_ACCOUNT_SETTINGS_OPERATION_KIND_ACCOUNT_EMAIL_OTP_REQUEST, func(input wacore.EngineAccountSettingsInput) wacore.EngineAccountSettingsInput {
		input.LocaleLanguage = accountSettingsLocale(req.GetLocaleLanguage(), "en")
		input.LocaleCountry = accountSettingsLocale(req.GetLocaleCountry(), "US")
		return input
	})
	if err != nil {
		return &waappv1.RequestAccountEmailOtpResponse{Error: shared.ToProtoError(err)}, nil
	}
	return &waappv1.RequestAccountEmailOtpResponse{Operation: op, Error: op.GetError()}, nil
}

func (s *accountSettingsHandler) VerifyAccountEmailOtp(ctx context.Context, req *waappv1.VerifyAccountEmailOtpRequest) (*waappv1.VerifyAccountEmailOtpResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.VerifyAccountEmailOtpResponse{Error: shared.ToProtoError(err)}, nil
	}
	code, err := accountSettingsSensitiveValue(req.GetCode(), "code", true)
	if err != nil {
		return &waappv1.VerifyAccountEmailOtpResponse{Error: shared.ToProtoError(err)}, nil
	}
	code, err = requireSixDigits(code, "code")
	if err != nil {
		return &waappv1.VerifyAccountEmailOtpResponse{Error: shared.ToProtoError(err)}, nil
	}
	op, err := s.applyAccountSettings(ctx, req.GetContext(), req.GetSelector(), waappv1.AccountSettingsOperationKind_ACCOUNT_SETTINGS_OPERATION_KIND_ACCOUNT_EMAIL_OTP_VERIFY, func(input wacore.EngineAccountSettingsInput) wacore.EngineAccountSettingsInput {
		input.Code = code
		return input
	})
	if err != nil {
		return &waappv1.VerifyAccountEmailOtpResponse{Error: shared.ToProtoError(err)}, nil
	}
	if op.GetError() == nil && op.GetStatus() == waappv1.AccountSettingsOperationStatus_ACCOUNT_SETTINGS_OPERATION_STATUS_VERIFIED {
		if err := s.patchTwoFactorAuthStatus(ctx, op.GetWaAccountId(), accountSettingsCompletedAt(op, s.clock.Now()), func(status *waappv1.TwoFactorAuthStatus) {
			mergeTwoFactorAuthStatus(status, &waappv1.TwoFactorAuthStatus{EmailConfigured: true, EmailVerified: true})
		}); err != nil {
			return &waappv1.VerifyAccountEmailOtpResponse{Operation: op, Error: shared.ToProtoError(err)}, nil
		}
	}
	return &waappv1.VerifyAccountEmailOtpResponse{Operation: op, Error: op.GetError()}, nil
}

func (s *accountSettingsHandler) SetAccountProfileName(ctx context.Context, req *waappv1.SetAccountProfileNameRequest) (*waappv1.SetAccountProfileNameResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.SetAccountProfileNameResponse{Error: shared.ToProtoError(err)}, nil
	}
	displayName, err := requiredAccountProfileName(req.GetDisplayName())
	if err != nil {
		return &waappv1.SetAccountProfileNameResponse{Error: shared.ToProtoError(err)}, nil
	}
	op, err := s.applyAccountSettings(ctx, req.GetContext(), req.GetSelector(), waappv1.AccountSettingsOperationKind_ACCOUNT_SETTINGS_OPERATION_KIND_ACCOUNT_PROFILE_NAME_SET, func(input wacore.EngineAccountSettingsInput) wacore.EngineAccountSettingsInput {
		input.DisplayName = displayName
		return input
	})
	if err != nil {
		return &waappv1.SetAccountProfileNameResponse{Error: shared.ToProtoError(err)}, nil
	}
	if op.GetError() == nil {
		if err := s.saveAccountDisplayName(ctx, op.GetWaAccountId(), displayName, accountSettingsCompletedAt(op, s.clock.Now())); err != nil {
			return &waappv1.SetAccountProfileNameResponse{Operation: op, Error: shared.ToProtoError(err)}, nil
		}
	}
	return &waappv1.SetAccountProfileNameResponse{Operation: op, Error: op.GetError()}, nil
}

func (s *accountSettingsHandler) SetAccountProfilePicture(ctx context.Context, req *waappv1.SetAccountProfilePictureRequest) (*waappv1.SetAccountProfilePictureResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.SetAccountProfilePictureResponse{Error: shared.ToProtoError(err)}, nil
	}
	image, err := requiredAccountProfilePicture(req.GetImage(), req.GetContentType())
	if err != nil {
		return &waappv1.SetAccountProfilePictureResponse{Error: shared.ToProtoError(err)}, nil
	}
	contentType, _ := engine.ProfilePictureContentType(image, req.GetContentType())
	op, result, err := s.applyAccountSettingsResult(ctx, req.GetContext(), req.GetSelector(), waappv1.AccountSettingsOperationKind_ACCOUNT_SETTINGS_OPERATION_KIND_ACCOUNT_PROFILE_PICTURE_SET, func(input wacore.EngineAccountSettingsInput) wacore.EngineAccountSettingsInput {
		input.ProfilePicture = image
		return input
	})
	if err != nil {
		return &waappv1.SetAccountProfilePictureResponse{Error: shared.ToProtoError(err)}, nil
	}
	if op.GetError() == nil {
		s.cacheWAAccountProfilePicture(ctx, op.GetWaAccountId(), WAContactProfilePicture{ProfilePictureID: result.ProfilePictureID, ContentType: contentType, Data: image})
	}
	return &waappv1.SetAccountProfilePictureResponse{Operation: op, ProfilePictureId: result.ProfilePictureID, HasStaging: result.HasStaging, Error: op.GetError()}, nil
}

func (s *accountSettingsHandler) RemoveAccountProfilePicture(ctx context.Context, req *waappv1.RemoveAccountProfilePictureRequest) (*waappv1.RemoveAccountProfilePictureResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.RemoveAccountProfilePictureResponse{Error: shared.ToProtoError(err)}, nil
	}
	op, err := s.applyAccountSettings(ctx, req.GetContext(), req.GetSelector(), waappv1.AccountSettingsOperationKind_ACCOUNT_SETTINGS_OPERATION_KIND_ACCOUNT_PROFILE_PICTURE_REMOVE, nil)
	if err != nil {
		return &waappv1.RemoveAccountProfilePictureResponse{Error: shared.ToProtoError(err)}, nil
	}
	if op.GetError() == nil {
		s.deleteWAAccountProfilePictureCache(ctx, op.GetWaAccountId())
	}
	return &waappv1.RemoveAccountProfilePictureResponse{Operation: op, Error: op.GetError()}, nil
}

func (s *serverCore) applyAccountSettings(ctx context.Context, requestContext *waappv1.RequestContext, selector *waappv1.AccountLoginSelector, kind waappv1.AccountSettingsOperationKind, enrich func(wacore.EngineAccountSettingsInput) wacore.EngineAccountSettingsInput) (*waappv1.AccountSettingsOperation, error) {
	op, _, err := s.applyAccountSettingsResult(ctx, requestContext, selector, kind, enrich)
	return op, err
}

func (s *serverCore) applyAccountSettingsResult(ctx context.Context, requestContext *waappv1.RequestContext, selector *waappv1.AccountLoginSelector, kind waappv1.AccountSettingsOperationKind, enrich func(wacore.EngineAccountSettingsInput) wacore.EngineAccountSettingsInput) (*waappv1.AccountSettingsOperation, wacore.EngineAccountSettingsResult, error) {
	operationCtx, cancel := accountSettingsOperationContext(ctx)
	defer cancel()
	loginState, err := s.accountSettingsLoginState(operationCtx, selector)
	if err != nil {
		return nil, wacore.EngineAccountSettingsResult{}, err
	}
	input := wacore.EngineAccountSettingsInput{
		WAAccountID:          loginState.GetWaAccountId(),
		ClientProfileID:      loginState.GetClientProfileId(),
		RegisteredIdentityID: loginState.GetRegisteredIdentityId(),
		LoginStateID:         loginState.GetLoginStateId(),
		AppVersion:           s.loginStateAppVersion(operationCtx, loginState),
		Kind:                 kind,
	}
	if enrich != nil {
		input = enrich(input)
	}
	runner, release, err := s.accountSettingsRunner(operationCtx, requestContext, loginState, kind)
	if err != nil {
		return nil, wacore.EngineAccountSettingsResult{}, err
	}
	defer release()
	result := runner.ApplyAccountSettings(operationCtx, input)
	completedAt := s.clock.Now()
	op := &waappv1.AccountSettingsOperation{
		AccountSettingsOperationId: s.ids.NewID("waacctset_"),
		WaAccountId:                loginState.GetWaAccountId(),
		ClientProfileId:            loginState.GetClientProfileId(),
		LoginStateId:               loginState.GetLoginStateId(),
		RegisteredIdentityId:       loginState.GetRegisteredIdentityId(),
		Kind:                       kind,
		Status:                     accountSettingsStatus(kind, result),
		CompletedAt:                timestamppb.New(completedAt),
		Error:                      shared.ToProtoError(result.Err),
	}
	if result.WaitTime > 0 {
		op.WaitTime = durationpb.New(result.WaitTime)
	}
	return op, result, nil
}

func (s *serverCore) refreshTwoFactorAuthStatus(ctx context.Context, requestContext *waappv1.RequestContext, selector *waappv1.AccountLoginSelector) (*waappv1.TwoFactorAuthStatus, *waappv1.WaError, error) {
	operationCtx, cancel := accountSettingsOperationContext(ctx)
	defer cancel()
	loginState, err := s.accountSettingsLoginState(operationCtx, selector)
	if err != nil {
		return nil, nil, err
	}
	runner, release, err := s.accountSettingsRunner(operationCtx, requestContext, loginState, waappv1.AccountSettingsOperationKind_ACCOUNT_SETTINGS_OPERATION_KIND_TWO_FACTOR_AUTH_STATUS_GET)
	if err != nil {
		return nil, nil, err
	}
	defer release()
	result := runner.ApplyAccountSettings(operationCtx, wacore.EngineAccountSettingsInput{
		WAAccountID:          loginState.GetWaAccountId(),
		ClientProfileID:      loginState.GetClientProfileId(),
		RegisteredIdentityID: loginState.GetRegisteredIdentityId(),
		LoginStateID:         loginState.GetLoginStateId(),
		AppVersion:           s.loginStateAppVersion(operationCtx, loginState),
		Kind:                 waappv1.AccountSettingsOperationKind_ACCOUNT_SETTINGS_OPERATION_KIND_TWO_FACTOR_AUTH_STATUS_GET,
	})
	if result.Err != nil {
		return nil, shared.ToProtoError(result.Err), nil
	}
	status := cloneTwoFactorAuthStatus(result.TwoFactorStatus)
	if status == nil {
		status = &waappv1.TwoFactorAuthStatus{}
	}
	if err := s.saveTwoFactorAuthStatus(operationCtx, loginState.GetWaAccountId(), status, s.clock.Now()); err != nil {
		return nil, nil, err
	}
	return status, nil, nil
}

func (s *serverCore) cachedTwoFactorAuthStatus(ctx context.Context, selector *waappv1.AccountLoginSelector) (*waappv1.TwoFactorAuthStatus, error) {
	accountID, err := s.accountSettingsAccountID(ctx, selector)
	if err != nil {
		return nil, err
	}
	account, err := s.GetWAAccountRecord(ctx, accountID)
	if err != nil {
		return nil, err
	}
	return cloneTwoFactorAuthStatus(account.GetTwoFactorAuth()), nil
}

func (s *serverCore) patchTwoFactorAuthStatus(ctx context.Context, accountID string, updatedAt time.Time, patch func(*waappv1.TwoFactorAuthStatus)) error {
	account, err := s.GetWAAccountRecord(ctx, accountID)
	if err != nil {
		return err
	}
	status := cloneTwoFactorAuthStatus(account.GetTwoFactorAuth())
	if status == nil {
		status = &waappv1.TwoFactorAuthStatus{}
	}
	patch(status)
	return s.saveTwoFactorAuthStatusForAccount(ctx, account, status, updatedAt)
}

func (s *serverCore) saveTwoFactorAuthStatus(ctx context.Context, accountID string, status *waappv1.TwoFactorAuthStatus, updatedAt time.Time) error {
	account, err := s.GetWAAccountRecord(ctx, accountID)
	if err != nil {
		return err
	}
	return s.saveTwoFactorAuthStatusForAccount(ctx, account, status, updatedAt)
}

func (s *serverCore) saveTwoFactorAuthStatusForAccount(ctx context.Context, account *waappv1.WAAccount, status *waappv1.TwoFactorAuthStatus, updatedAt time.Time) error {
	if updatedAt.IsZero() {
		updatedAt = s.clock.Now()
	}
	_, err := s.SaveWAAccountRecord(ctx, withWAAccountTwoFactorAuthStatus(account, preserveTwoFactorEmailProjection(account.GetTwoFactorAuth(), status), updatedAt))
	return err
}

func preserveTwoFactorEmailProjection(current *waappv1.TwoFactorAuthStatus, next *waappv1.TwoFactorAuthStatus) *waappv1.TwoFactorAuthStatus {
	out := cloneTwoFactorAuthStatus(next)
	if out == nil || current == nil {
		return out
	}
	currentEmailAddress := strings.TrimSpace(current.GetEmailAddress())
	nextEmailAddress := strings.TrimSpace(out.GetEmailAddress())
	if nextEmailAddress == "" {
		out.EmailAddress = currentEmailAddress
		nextEmailAddress = currentEmailAddress
	}
	if nextEmailAddress == "" {
		return out
	}
	out.EmailConfigured = out.GetEmailConfigured() || current.GetEmailConfigured() || nextEmailAddress != ""
	if nextEmailAddress == currentEmailAddress {
		out.EmailVerified = out.GetEmailVerified() || current.GetEmailVerified()
		out.EmailConfirmed = out.GetEmailConfirmed() || current.GetEmailConfirmed()
	}
	return out
}

func mergeTwoFactorAuthStatus(status *waappv1.TwoFactorAuthStatus, patch *waappv1.TwoFactorAuthStatus) {
	if status == nil || patch == nil {
		return
	}
	status.Configured = status.GetConfigured() || patch.GetConfigured()
	patchEmailAddress := strings.TrimSpace(patch.GetEmailAddress())
	if patchEmailAddress != "" {
		currentEmailAddress := strings.TrimSpace(status.GetEmailAddress())
		status.EmailAddress = patchEmailAddress
		status.EmailConfigured = status.GetEmailConfigured() || patch.GetEmailConfigured() || patchEmailAddress != ""
		if patchEmailAddress == currentEmailAddress {
			status.EmailVerified = status.GetEmailVerified() || patch.GetEmailVerified()
			status.EmailConfirmed = status.GetEmailConfirmed() || patch.GetEmailConfirmed()
			return
		}
		status.EmailVerified = patch.GetEmailVerified()
		status.EmailConfirmed = patch.GetEmailConfirmed()
		return
	}
	status.EmailConfigured = status.GetEmailConfigured() || patch.GetEmailConfigured()
	status.EmailVerified = status.GetEmailVerified() || patch.GetEmailVerified()
	status.EmailConfirmed = status.GetEmailConfirmed() || patch.GetEmailConfirmed()
}

func (s *serverCore) accountSettingsAccountID(ctx context.Context, selector *waappv1.AccountLoginSelector) (string, error) {
	if selector.GetWaAccountId() != "" {
		return wamodel.RequireWAAccountID(selector.GetWaAccountId())
	}
	loginState, err := s.accountSettingsLoginState(ctx, selector)
	if err != nil {
		return "", err
	}
	return wamodel.RequireWAAccountID(loginState.GetWaAccountId())
}

func (s *serverCore) saveAccountDisplayName(ctx context.Context, accountID string, displayName string, updatedAt time.Time) error {
	account, err := s.GetWAAccountRecord(ctx, accountID)
	if err != nil {
		return err
	}
	_, err = s.SaveWAAccountRecord(ctx, withWAAccountDisplayName(account, displayName, updatedAt))
	return err
}

func accountSettingsCompletedAt(op *waappv1.AccountSettingsOperation, fallback time.Time) time.Time {
	if op == nil {
		return fallback
	}
	completedAt := shared.TimeFromProto(op.GetCompletedAt())
	if completedAt.IsZero() {
		return fallback
	}
	return completedAt
}

func accountSettingsOperationContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithTimeout(ctx, engine.DefaultAccountSettingsOperationTimeout)
}

func (s *serverCore) accountSettingsRunner(ctx context.Context, requestContext *waappv1.RequestContext, loginState *waappv1.LoginState, kind waappv1.AccountSettingsOperationKind) (wacore.ProtocolEngine, func(), error) {
	if s.longConnections != nil {
		if runner := s.longConnections.Runner(loginState); runner != nil {
			return runner, func() {}, nil
		}
	}
	return s.runner, func() {}, nil
}

func (s *serverCore) accountSettingsLoginState(ctx context.Context, selector *waappv1.AccountLoginSelector) (*waappv1.LoginState, error) {
	if selector.GetLoginStateId() != "" {
		return requireActiveLoginState(func() (*waappv1.LoginState, error) {
			return s.store.GetLoginState(ctx, selector.GetLoginStateId())
		})
	}
	if selector.GetRegisteredIdentityId() != "" {
		return requireActiveLoginState(func() (*waappv1.LoginState, error) {
			return s.store.GetLoginStateByRegisteredIdentity(ctx, selector.GetRegisteredIdentityId())
		})
	}
	accountID, err := wamodel.RequireWAAccountID(selector.GetWaAccountId())
	if err != nil {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "login_state_id, registered_identity_id, or wa_account_id is required", false)
	}
	if selector.GetClientProfileId() != "" {
		return requireActiveLoginState(func() (*waappv1.LoginState, error) {
			return s.store.GetActiveLoginState(ctx, accountID, selector.GetClientProfileId())
		})
	}
	records, err := s.store.ListActiveLoginStates(ctx)
	if err != nil {
		return nil, err
	}
	for _, record := range records {
		loginState := record.LoginState
		if loginState.GetWaAccountId() == accountID {
			return loginState, nil
		}
	}
	return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REGISTRATION_NOT_FOUND, "active login state not found", false)
}

func requireActiveLoginState(load func() (*waappv1.LoginState, error)) (*waappv1.LoginState, error) {
	loginState, err := load()
	if err != nil {
		return nil, err
	}
	if loginState.GetStatus() != waappv1.LoginStateStatus_LOGIN_STATE_STATUS_ACTIVE {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_CONFLICT, "login state is not active", false)
	}
	return loginState, nil
}

func accountSettingsStatus(kind waappv1.AccountSettingsOperationKind, result wacore.EngineAccountSettingsResult) waappv1.AccountSettingsOperationStatus {
	if result.Status != waappv1.AccountSettingsOperationStatus_ACCOUNT_SETTINGS_OPERATION_STATUS_UNSPECIFIED {
		return result.Status
	}
	if result.Err != nil {
		return waappv1.AccountSettingsOperationStatus_ACCOUNT_SETTINGS_OPERATION_STATUS_REJECTED
	}
	if kind == waappv1.AccountSettingsOperationKind_ACCOUNT_SETTINGS_OPERATION_KIND_ACCOUNT_EMAIL_OTP_REQUEST {
		return waappv1.AccountSettingsOperationStatus_ACCOUNT_SETTINGS_OPERATION_STATUS_WAITING
	}
	return waappv1.AccountSettingsOperationStatus_ACCOUNT_SETTINGS_OPERATION_STATUS_ACCEPTED
}

func accountSettingsSensitiveValue(value *waappv1.SensitiveText, label string, required bool) (string, error) {
	plain := strings.TrimSpace(value.GetValue())
	if plain != "" {
		return plain, nil
	}
	if strings.TrimSpace(value.GetSecretRef()) != "" {
		return "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_UNSUPPORTED_OPERATION, label+" secret_ref is not supported by native account settings", false)
	}
	if required {
		return "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, label+" is required", false)
	}
	return "", nil
}

func requireSixDigits(value string, label string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) != 6 || shared.DigitsOnly(trimmed) != trimmed {
		return "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, label+" must be 6 digits", false)
	}
	return trimmed, nil
}

func requiredEmailAddress(value string, label string) (string, error) {
	trimmed, err := optionalEmailAddress(value, label)
	if err != nil {
		return "", err
	}
	if trimmed == "" {
		return "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, label+" is required", false)
	}
	return trimmed, nil
}

func optionalEmailAddress(value string, label string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", nil
	}
	address, err := mail.ParseAddress(trimmed)
	if err != nil || address.Address != trimmed {
		return "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, label+" is invalid", false)
	}
	return trimmed, nil
}

func accountSettingsLocale(value string, fallback string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fallback
	}
	return trimmed
}

func requiredAccountProfileName(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "display_name is required", false)
	}
	if utf8.RuneCountInString(trimmed) > accountProfileNameMaxRunes {
		return "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "display_name is too long", false)
	}
	return trimmed, nil
}

func requiredAccountProfilePicture(image []byte, contentType string) ([]byte, error) {
	if len(image) == 0 {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "image is required", false)
	}
	if len(image) > engine.ProfilePictureDownloadMaxBytes {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, "WA profile picture is too large", false)
	}
	if _, err := engine.ProfilePictureContentType(image, contentType); err != nil {
		return nil, err
	}
	return append([]byte(nil), image...), nil
}
