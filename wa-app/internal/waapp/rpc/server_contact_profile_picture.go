package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"time"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/engine"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
	"github.com/byte-v-forge/wa-app/internal/waapp/wamodel"
)

const contactProfilePictureCacheTTL = 6 * time.Hour
const profilePictureFailureCacheTTL = 10 * time.Minute
const contactProfilePictureLatestCacheVersion = "latest"

type waContactProfilePictureResolver interface {
	ResolveContactProfilePicture(context.Context, wacore.EngineContactProfilePictureInput) wacore.EngineContactProfilePictureResult
}

type WAContactProfilePicture struct {
	ProfilePictureID string
	ContentType      string
	Data             []byte
}

type contactProfilePictureCacheEntry struct {
	ProfilePictureID string `json:"profile_picture_id"`
	ContentType      string `json:"content_type"`
	Data             []byte `json:"data"`
}

func (s *serverCore) contactProfilePictureRunner(ctx context.Context, loginState *waappv1.LoginState) (wacore.ProtocolEngine, func(), error) {
	if s != nil && s.longConnections != nil {
		if runner := s.longConnections.Runner(loginState); runner != nil {
			if _, ok := runner.(waContactProfilePictureResolver); ok {
				return runner, func() {}, nil
			}
		}
	}
	return s.contactResolverRunner(loginState)
}

func contactProfilePictureRemoteTimeout(runner wacore.ProtocolEngine) time.Duration {
	if _, ok := runner.(*engine.LongConnectionNativeEngine); ok {
		return longConnectionWaitTimeout + engine.DefaultContactProfilePictureTimeout
	}
	return engine.DefaultContactProfilePictureTimeout
}

func (s *accountSettingsHandler) GetAccountProfilePicture(ctx context.Context, req *waappv1.GetAccountProfilePictureRequest) (*waappv1.GetAccountProfilePictureResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.GetAccountProfilePictureResponse{Error: shared.ToProtoError(err)}, nil
	}
	picture, err := s.getWAAccountProfilePicture(ctx, req.GetSelector())
	if err != nil {
		return &waappv1.GetAccountProfilePictureResponse{Error: shared.ToProtoError(err)}, nil
	}
	return &waappv1.GetAccountProfilePictureResponse{Image: picture.Data, ContentType: picture.ContentType, ProfilePictureId: picture.ProfilePictureID}, nil
}

func (s *serverCore) GetWAAccountProfilePicture(ctx context.Context, accountID string) (WAContactProfilePicture, error) {
	return s.getWAAccountProfilePicture(ctx, &waappv1.AccountLoginSelector{WaAccountId: accountID})
}

func (s *serverCore) getWAAccountProfilePicture(ctx context.Context, selector *waappv1.AccountLoginSelector) (WAContactProfilePicture, error) {
	loginState, err := s.accountSettingsLoginState(ctx, selector)
	if err != nil {
		return WAContactProfilePicture{}, err
	}
	account, err := s.store.GetWAAccount(ctx, loginState.GetWaAccountId())
	if err != nil {
		return WAContactProfilePicture{}, err
	}
	if cached, ok := s.cachedWAAccountProfilePicture(ctx, account.GetWaAccountId()); ok {
		return cached, nil
	}
	accountCacheKey := accountProfilePictureCacheKey(account.GetWaAccountId())
	if s.cachedWAProfilePictureFailure(ctx, accountCacheKey) {
		return WAContactProfilePicture{}, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND, "WA profile picture not found", false)
	}
	pnJID := accountProfilePictureJID(account)
	if pnJID == "" {
		return WAContactProfilePicture{}, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "WA account phone is required", false)
	}
	runner, release, err := s.contactProfilePictureRunner(ctx, loginState)
	if err != nil {
		return WAContactProfilePicture{}, err
	}
	defer release()
	resolver, ok := runner.(waContactProfilePictureResolver)
	if !ok {
		return WAContactProfilePicture{}, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_UNSUPPORTED_OPERATION, "WA account profile picture resolver is not configured", false)
	}
	remoteTimeout := contactProfilePictureRemoteTimeout(runner)
	result := resolver.ResolveContactProfilePicture(ctx, wacore.EngineContactProfilePictureInput{
		WAAccountID:          loginState.GetWaAccountId(),
		ClientProfileID:      loginState.GetClientProfileId(),
		RegisteredIdentityID: loginState.GetRegisteredIdentityId(),
		AppVersion:           s.loginStateAppVersion(ctx, loginState),
		ContactJID:           pnJID,
		ContactPNJID:         pnJID,
		RemoteTimeout:        remoteTimeout,
	})
	if result.Err != nil {
		if shouldCacheProfilePictureFailure(result.Err) {
			s.cacheWAProfilePictureFailure(ctx, accountCacheKey)
		}
		logWAProfilePictureError("account", result.Err)
		return WAContactProfilePicture{}, result.Err
	}
	picture := WAContactProfilePicture{ProfilePictureID: result.ProfilePictureID, ContentType: result.ContentType, Data: result.Data}
	s.cacheWAAccountProfilePicture(ctx, account.GetWaAccountId(), picture)
	return picture, nil
}

func (s *serverCore) GetWAContactProfilePicture(ctx context.Context, contactID string) (WAContactProfilePicture, error) {
	contactID = strings.TrimSpace(contactID)
	if contactID == "" {
		return WAContactProfilePicture{}, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "WA contact id is required", false)
	}
	contact, err := s.store.GetWAContact(ctx, contactID)
	if err != nil {
		return WAContactProfilePicture{}, err
	}
	contactCacheKey := contactProfilePictureCacheKey(contact.GetContactId(), contactProfilePictureCacheVersion(contact.GetProfilePictureId()))
	if cached, ok := s.cachedWAContactProfilePicture(ctx, contact); ok {
		return cached, nil
	}
	if s.cachedWAProfilePictureFailure(ctx, contactCacheKey) {
		return WAContactProfilePicture{}, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND, "WA profile picture not found", false)
	}
	loginState, err := s.activeContactResolveLoginState(ctx, contact.GetWaAccountId())
	if err != nil {
		return WAContactProfilePicture{}, err
	}
	runner, release, err := s.contactProfilePictureRunner(ctx, loginState)
	if err != nil {
		return WAContactProfilePicture{}, err
	}
	defer release()
	resolver, ok := runner.(waContactProfilePictureResolver)
	if !ok {
		return WAContactProfilePicture{}, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_UNSUPPORTED_OPERATION, "WA contact profile picture resolver is not configured", false)
	}
	remoteTimeout := contactProfilePictureRemoteTimeout(runner)
	result := resolver.ResolveContactProfilePicture(ctx, wacore.EngineContactProfilePictureInput{
		WAAccountID:          contact.GetWaAccountId(),
		ClientProfileID:      loginState.GetClientProfileId(),
		RegisteredIdentityID: loginState.GetRegisteredIdentityId(),
		AppVersion:           s.loginStateAppVersion(ctx, loginState),
		ContactJID:           contact.GetJid(),
		ContactPNJID:         engine.PhoneNumberWAJID(contact.GetNumber()),
		ContactPictureID:     contact.GetProfilePictureId(),
		RemoteTimeout:        remoteTimeout,
	})
	if result.Err != nil {
		if shouldCacheProfilePictureFailure(result.Err) {
			s.cacheWAProfilePictureFailure(ctx, contactCacheKey)
		}
		logWAProfilePictureError("contact", result.Err)
		return WAContactProfilePicture{}, result.Err
	}
	if result.ProfilePictureID != "" && result.ProfilePictureID != contact.GetProfilePictureId() {
		contact.ProfilePictureId = result.ProfilePictureID
		_ = s.store.SaveWAContacts(ctx, []*waappv1.WAContact{contact})
	}
	picture := WAContactProfilePicture{
		ProfilePictureID: shared.FirstNonEmpty(result.ProfilePictureID, contact.GetProfilePictureId()),
		ContentType:      result.ContentType,
		Data:             result.Data,
	}
	s.cacheWAContactProfilePicture(ctx, contact.GetContactId(), picture)
	return picture, nil
}

func (s *serverCore) cachedWAAccountProfilePicture(ctx context.Context, accountID string) (WAContactProfilePicture, bool) {
	return s.cachedWAProfilePicture(ctx, accountProfilePictureCacheKey(accountID))
}

func (s *serverCore) cachedWAContactProfilePicture(ctx context.Context, contact *waappv1.WAContact) (WAContactProfilePicture, bool) {
	if s == nil || s.runtime == nil || contact == nil || contact.GetContactId() == "" {
		return WAContactProfilePicture{}, false
	}
	version := contactProfilePictureCacheVersion(contact.GetProfilePictureId())
	picture, ok := s.cachedWAProfilePicture(ctx, contactProfilePictureCacheKey(contact.GetContactId(), version))
	if picture.ProfilePictureID == "" {
		picture.ProfilePictureID = contact.GetProfilePictureId()
	}
	return picture, ok
}

func (s *serverCore) cachedWAProfilePicture(ctx context.Context, key string) (WAContactProfilePicture, bool) {
	if s == nil || s.runtime == nil || strings.TrimSpace(key) == "" {
		return WAContactProfilePicture{}, false
	}
	data, err := s.runtime.GetTransientState(ctx, key)
	if err != nil || len(data) == 0 {
		return WAContactProfilePicture{}, false
	}
	var entry contactProfilePictureCacheEntry
	if json.Unmarshal(data, &entry) != nil || len(entry.Data) == 0 || entry.ContentType == "" {
		return WAContactProfilePicture{}, false
	}
	return WAContactProfilePicture{ProfilePictureID: entry.ProfilePictureID, ContentType: entry.ContentType, Data: entry.Data}, true
}

func (s *serverCore) cacheWAAccountProfilePicture(ctx context.Context, accountID string, picture WAContactProfilePicture) {
	s.cacheWAProfilePicture(ctx, accountProfilePictureCacheKey(accountID), picture)
}

func (s *serverCore) cacheWAContactProfilePicture(ctx context.Context, contactID string, picture WAContactProfilePicture) {
	s.cacheWAProfilePicture(ctx, contactProfilePictureCacheKey(contactID, contactProfilePictureCacheVersion(picture.ProfilePictureID)), picture)
}

func (s *serverCore) cacheWAProfilePicture(ctx context.Context, key string, picture WAContactProfilePicture) {
	if s == nil || s.runtime == nil || strings.TrimSpace(key) == "" || len(picture.Data) == 0 {
		return
	}
	data, err := json.Marshal(contactProfilePictureCacheEntry{ProfilePictureID: picture.ProfilePictureID, ContentType: picture.ContentType, Data: picture.Data})
	if err != nil {
		return
	}
	_ = s.runtime.SaveTransientState(ctx, key, data, contactProfilePictureCacheTTL)
	_ = s.runtime.DeleteTransientState(ctx, profilePictureFailureCacheKey(key))
}

func (s *serverCore) cachedWAProfilePictureFailure(ctx context.Context, key string) bool {
	if s == nil || s.runtime == nil || strings.TrimSpace(key) == "" {
		return false
	}
	data, err := s.runtime.GetTransientState(ctx, profilePictureFailureCacheKey(key))
	return err == nil && len(data) > 0
}

func (s *serverCore) cacheWAProfilePictureFailure(ctx context.Context, key string) {
	if s == nil || s.runtime == nil || strings.TrimSpace(key) == "" {
		return
	}
	_ = s.runtime.SaveTransientState(ctx, profilePictureFailureCacheKey(key), []byte("1"), profilePictureFailureCacheTTL)
}

func profilePictureFailureCacheKey(key string) string {
	return key + ":failure"
}

func shouldCacheProfilePictureFailure(err error) bool {
	var appErr *shared.AppError
	if !errors.As(err, &appErr) {
		return false
	}
	if appErr == nil {
		return false
	}
	return appErr.Code == waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND
}

func (s *serverCore) deleteWAAccountProfilePictureCache(ctx context.Context, accountID string) {
	if s == nil || s.runtime == nil || accountID == "" {
		return
	}
	key := accountProfilePictureCacheKey(accountID)
	_ = s.runtime.DeleteTransientState(ctx, key)
	_ = s.runtime.DeleteTransientState(ctx, profilePictureFailureCacheKey(key))
}

func accountProfilePictureCacheKey(accountID string) string {
	return "wa-account-profile-picture:" + strings.TrimSpace(accountID)
}

func contactProfilePictureCacheKey(contactID string, profilePictureID string) string {
	return "wa-contact-profile-picture:" + contactID + ":" + profilePictureID
}

func contactProfilePictureCacheVersion(profilePictureID string) string {
	profilePictureID = strings.TrimSpace(profilePictureID)
	if profilePictureID == "" {
		return contactProfilePictureLatestCacheVersion
	}
	return profilePictureID
}

func accountProfilePictureJID(account *waappv1.WAAccount) string {
	if account == nil {
		return ""
	}
	phone := wamodel.NormalizePhone(account.GetPhone())
	digits := shared.DigitsOnly(phone.GetE164Number())
	if digits == "" {
		digits = shared.DigitsOnly(phone.GetCountryCallingCode() + phone.GetNationalNumber())
	}
	return wacore.NormalizeWAJID(digits)
}

func IsWAProfilePictureNotFound(err error) bool {
	var appErr *shared.AppError
	return errors.As(err, &appErr) && appErr.Code == waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND
}

func IsWAContactProfilePictureNotFound(err error) bool {
	return IsWAProfilePictureNotFound(err)
}

func logWAProfilePictureError(scope string, err error) {
	var appErr *shared.AppError
	if errors.As(err, &appErr) {
		log.Printf("WA %s profile picture fetch failed code=%s retryable=%t", shared.SafeProxyLogToken(scope, "profile"), appErr.Code.String(), appErr.Retryable)
		return
	}
	log.Printf("WA %s profile picture fetch failed code=%s retryable=false reason=%s", shared.SafeProxyLogToken(scope, "profile"), waappv1.WaErrorCode_WA_ERROR_CODE_INTERNAL.String(), engine.ContactProfilePictureFailureReason(err))
}
