package bff

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/engine"
	"github.com/byte-v-forge/wa-app/internal/waapp/rpc"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
	"github.com/byte-v-forge/wa-app/internal/waapp/wamodel"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const transientStateTTL = 30 * time.Minute
const registrationAttemptStateTTL = 26 * time.Hour
const registrationOTPWaitDefaultTTL = 20 * time.Minute

type actionGateway struct{ server *rpc.Server }

func NewActionGateway(server *rpc.Server) http.Handler {
	return &actionGateway{server: server}
}

func (g *actionGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeActionJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	payload, ok := readActionPayload(w, r)
	if !ok {
		return
	}
	action := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/wa/actions/"), "/")
	var result any
	var err error
	switch action {
	case "proxy-settings":
		result, err = g.proxySettings(r.Context(), payload)
	case "fingerprints/random":
		result, err = g.generateTransientFingerprint(r.Context(), payload)
	case "fingerprints/commit":
		result, err = g.commitFingerprint(r.Context(), payload)
	case "registration/request-sms-otp":
		result, err = g.requestSMSOTP(r.Context(), payload)
	case "registration/await-otp":
		result, err = g.awaitOTP(r.Context(), payload)
	case "registration/resume-otp":
		result, err = g.resumeOTP(r.Context(), payload)
	case "registration/submit-otp":
		result, err = g.submitOTP(r.Context(), payload)
	case "registration/account-transfer/refresh":
		result, err = g.refreshAccountTransferChallenge(r.Context(), payload)
	case "registration/account-transfer/poll":
		result, err = g.pollAccountTransferRegistration(r.Context(), payload)
	case "registration/cleanup-failed-account":
		result, err = g.cleanupFailedRegistration(r.Context(), payload)
	case "registration/persist-login-state":
		result, err = g.persistLoginState(r.Context(), payload)
	case "registration/check-login-state":
		result, err = g.CheckLoginStateWithRunner(r.Context(), payload)
	default:
		writeActionJSON(w, http.StatusNotFound, map[string]string{"error": "unknown WA action"})
		return
	}
	if err != nil {
		writeActionJSON(w, http.StatusOK, actionError(err))
		return
	}
	writeActionJSON(w, http.StatusOK, result)
}

func (g *actionGateway) proxySettings(ctx context.Context, payload map[string]any) (map[string]any, error) {
	route, useProxy := g.resolveWAProxyRoute(waProxyResolveRequest{
		Payload:     payload,
		CountryCode: proxyCountryCodeFromPayload(payload),
	})
	out := waProxySummary(route, useProxy)
	out["preflight"] = false
	return out, nil
}

type transientFingerprintDTO struct {
	Success                 bool           `json:"success"`
	FingerprintRef          string         `json:"fingerprint_ref"`
	TransientFingerprintRef string         `json:"transient_fingerprint_ref"`
	FingerprintPersistence  string         `json:"fingerprint_persistence"`
	Fingerprint             fingerprintDTO `json:"fingerprint"`
}

func (g *actionGateway) generateTransientFingerprint(ctx context.Context, payload map[string]any) (any, error) {
	nativeEngine, err := g.nativeEngine()
	if err != nil {
		return nil, err
	}
	phone := wamodel.NormalizePhone(phoneFromAction(payload))
	if phone.GetE164Number() == "" {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "phone is required", false)
	}
	state, err := nativeEngine.NewState(phone)
	if err != nil {
		return nil, err
	}
	data, err := engine.MarshalNativeState(state)
	if err != nil {
		return nil, err
	}
	ref := g.server.IDs().NewID("wafp_")
	if err := g.server.Runtime().SaveTransientState(ctx, ref, data, transientStateTTL); err != nil {
		return nil, err
	}
	profile := engine.PhoneProfileToProto(phone, state.Profile)
	return transientFingerprintDTO{
		Success:                 true,
		FingerprintRef:          ref,
		TransientFingerprintRef: ref,
		FingerprintPersistence:  "TRANSIENT_NOT_COMMITTED",
		Fingerprint:             fingerprintSummary(profile),
	}, nil
}

// fingerprintDTO is the dashboard-facing device-fingerprint summary. Field tags
// mirror the previous map[string]any keys exactly (no omitempty) so the JSON
// object contract is unchanged.
type fingerprintDTO struct {
	Schema         string `json:"schema"`
	ProfileSHA256  string `json:"profile_sha256"`
	PhoneSHA256    string `json:"phone_sha256"`
	DeviceVendor   string `json:"device_vendor"`
	DeviceModel    string `json:"device_model"`
	AndroidVersion string `json:"android_version"`
}

func fingerprintSummary(profile *waappv1.PhoneFingerprintProfile) fingerprintDTO {
	return fingerprintDTO{
		Schema:         profile.GetSchema(),
		ProfileSHA256:  profile.GetProfileSha256(),
		PhoneSHA256:    profile.GetPhoneSha256(),
		DeviceVendor:   profile.GetDeviceVendor(),
		DeviceModel:    profile.GetDeviceModel(),
		AndroidVersion: profile.GetAndroidVersion(),
	}
}

type commitFingerprintDTO struct {
	Success           bool           `json:"success"`
	WAAccountID       string         `json:"wa_account_id"`
	ClientProfileID   string         `json:"client_profile_id"`
	ProtocolProfileID string         `json:"protocol_profile_id"`
	ClientProfile     map[string]any `json:"client_profile"`
}

func (g *actionGateway) commitFingerprint(ctx context.Context, payload map[string]any) (any, error) {
	ref := shared.TextField(payload, "transient_fingerprint_ref")
	state, err := g.loadTransientState(ctx, ref)
	if err != nil {
		return nil, err
	}
	account, profile, protocol, err := g.commitNativeState(ctx, wamodel.NormalizePhone(phoneFromAction(payload)), state)
	if err != nil {
		return nil, err
	}
	_ = g.server.Runtime().DeleteTransientState(ctx, ref)
	return commitFingerprintDTO{
		Success:           true,
		WAAccountID:       wamodel.WAAccountID(account),
		ClientProfileID:   profile.GetClientProfileId(),
		ProtocolProfileID: protocol.GetProtocolProfileId(),
		ClientProfile:     protoMap(profile),
	}, nil
}

func (g *actionGateway) requestSMSOTP(ctx context.Context, payload map[string]any) (any, error) {
	method := registrationMethodFromPayload(payload)
	if reason := directRegistrationMethodUnsupportedReason(method); reason != "" {
		return registrationMethodUnsupportedMap(method, reason), nil
	}
	runner, route, managedRoute, err := g.registrationRunner(payload)
	if err != nil {
		return nil, err
	}
	reqCtx := actionContext(payload)
	resp, err := g.server.RequestVerificationCodeWithRunner(ctx, &waappv1.RequestVerificationCodeRequest{
		Context:           reqCtx,
		WaAccountId:       shared.TextField(payload, "wa_account_id"),
		ClientProfileId:   shared.TextField(payload, "client_profile_id"),
		ProtocolProfileId: shared.TextField(payload, "protocol_profile_id"),
		DeliveryMethod:    method,
	}, runner)
	runner.CloseIdleConnections()
	if err != nil {
		return nil, err
	}
	if resp.GetError() != nil {
		return actionErrorFromProto(resp.GetError()), nil
	}
	record := resp.GetVerificationRequest()
	success := record.GetStatus() == waappv1.VerificationRequestStatus_VERIFICATION_REQUEST_STATUS_SENT || record.GetStatus() == waappv1.VerificationRequestStatus_VERIFICATION_REQUEST_STATUS_WAITING
	result := requestSMSOTPResultDTO{
		Success:               success,
		Status:                record.GetStatus().String(),
		VerificationRequestID: record.GetVerificationRequestId(),
		VerificationRequest:   protoMap(record),
		MethodStatuses:        protoMethodStatusMaps(record.GetMethodStatuses()),
		Proxy:                 registrationProxyRouteMap(route, managedRoute),
	}
	if challenge := resp.GetAccountTransferChallenge(); challenge != nil {
		result.AccountTransferChallenge = protoMap(challenge)
		result.RegistrationPhase = "ACCOUNT_TRANSFER_WAITING"
	}
	if seconds := shared.DurationSeconds(record.GetRetryAfter()); seconds > 0 {
		result.RetryAfterSeconds = seconds
	}
	return result, nil
}

// requestSMSOTPResultDTO is the request-verification success shape. The six base
// keys are always present (no omitempty, matching the old map — including an
// empty method_statuses which marshals to []); account_transfer_challenge /
// registration_phase / retry_after_seconds are the conditionally-added keys.
type requestSMSOTPResultDTO struct {
	Success                  bool             `json:"success"`
	Status                   string           `json:"status"`
	VerificationRequestID    string           `json:"verification_request_id"`
	VerificationRequest      map[string]any   `json:"verification_request"`
	MethodStatuses           []map[string]any `json:"method_statuses"`
	Proxy                    map[string]any   `json:"proxy"`
	AccountTransferChallenge map[string]any   `json:"account_transfer_challenge,omitempty"`
	RegistrationPhase        string           `json:"registration_phase,omitempty"`
	RetryAfterSeconds        int64            `json:"retry_after_seconds,omitempty"`
}

type awaitOTPDTO struct {
	Success               bool   `json:"success"`
	WAAccountID           string `json:"wa_account_id"`
	VerificationRequestID string `json:"verification_request_id"`
	TimeoutSeconds        int    `json:"timeout_seconds"`
}

func (g *actionGateway) awaitOTP(ctx context.Context, payload map[string]any) (any, error) {
	wait, ttl, err := registrationOTPWaitFromPayload(payload)
	if err != nil {
		return nil, err
	}
	if err := g.saveRegistrationOTPWait(ctx, wait, ttl); err != nil {
		return nil, err
	}
	return awaitOTPDTO{
		Success:               true,
		WAAccountID:           wait.WAAccountID,
		VerificationRequestID: wait.VerificationRequestID,
		TimeoutSeconds:        int(ttl.Seconds()),
	}, nil
}

func (g *actionGateway) resumeOTP(ctx context.Context, payload map[string]any) (map[string]any, error) {
	code := shared.FirstNonEmpty(shared.TextField(payload, "otp"), shared.TextField(payload, "code"), shared.TextField(payload, "verification_code"))
	if strings.TrimSpace(code) == "" {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "otp is required", false)
	}
	wait, err := g.loadRegistrationOTPWait(ctx, shared.TextField(payload, "wa_account_id"), shared.TextField(payload, "verification_request_id"))
	if err != nil {
		return nil, err
	}
	if wait.ResumeURL != "" {
		if err := postRegistrationOTPResume(ctx, wait, code); err != nil {
			return nil, err
		}
		_ = g.deleteRegistrationOTPWait(ctx, wait)
		return map[string]any{"success": true, "wa_account_id": wait.WAAccountID, "verification_request_id": wait.VerificationRequestID}, nil
	}
	submitPayload := cloneActionPayload(payload)
	submitPayload["verification_request_id"] = wait.VerificationRequestID
	submitPayload["code"] = code
	result, err := g.submitOTP(ctx, submitPayload)
	if err != nil {
		return nil, err
	}
	if result["success"] == true {
		_ = g.deleteRegistrationOTPWait(ctx, wait)
	}
	return result, nil
}

func registrationOTPWaitFromPayload(payload map[string]any) (wamodel.RegistrationOTPWait, time.Duration, error) {
	wait := wamodel.RegistrationOTPWait{
		WAAccountID:           shared.TextField(payload, "wa_account_id"),
		VerificationRequestID: shared.TextField(payload, "verification_request_id"),
		ResumeURL:             shared.TextField(payload, "resume_url"),
		CreatedAtUnix:         time.Now().UTC().Unix(),
	}
	if wait.VerificationRequestID == "" {
		return wamodel.RegistrationOTPWait{}, 0, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "verification_request_id is required", false)
	}
	if wait.WAAccountID != "" {
		accountID, err := wamodel.RequireWAAccountID(wait.WAAccountID)
		if err != nil {
			return wamodel.RegistrationOTPWait{}, 0, err
		}
		wait.WAAccountID = accountID
	}
	ttl := time.Duration(numberField(payload, "timeout_seconds")) * time.Second
	if ttl <= 0 {
		ttl = registrationOTPWaitDefaultTTL
	}
	return wait, ttl, nil
}

func (g *actionGateway) saveRegistrationOTPWait(ctx context.Context, wait wamodel.RegistrationOTPWait, ttl time.Duration) error {
	data, err := json.Marshal(wait)
	if err != nil {
		return err
	}
	if err := g.server.Runtime().SaveTransientState(ctx, wamodel.RegistrationOTPWaitKey(wait.VerificationRequestID), data, ttl); err != nil {
		return err
	}
	if wait.WAAccountID != "" {
		if err := g.server.Runtime().SaveTransientState(ctx, wamodel.RegistrationOTPWaitAccountKey(wait.WAAccountID), data, ttl); err != nil {
			return err
		}
	}
	return nil
}

func (g *actionGateway) loadRegistrationOTPWait(ctx context.Context, waAccountIDValue string, verificationRequestID string) (wamodel.RegistrationOTPWait, error) {
	key := ""
	if verificationRequestID != "" {
		key = wamodel.RegistrationOTPWaitKey(verificationRequestID)
	} else if waAccountIDValue != "" {
		accountID, err := wamodel.RequireWAAccountID(waAccountIDValue)
		if err != nil {
			return wamodel.RegistrationOTPWait{}, err
		}
		key = wamodel.RegistrationOTPWaitAccountKey(accountID)
	}
	if key == "" {
		return wamodel.RegistrationOTPWait{}, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "wa_account_id or verification_request_id is required", false)
	}
	data, err := g.server.Runtime().GetTransientState(ctx, key)
	if err != nil {
		return wamodel.RegistrationOTPWait{}, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_PROFILE_NOT_FOUND, "registration otp wait not found", false)
	}
	var wait wamodel.RegistrationOTPWait
	if err := json.Unmarshal(data, &wait); err != nil {
		return wamodel.RegistrationOTPWait{}, err
	}
	return wait, nil
}

func (g *actionGateway) deleteRegistrationOTPWait(ctx context.Context, wait wamodel.RegistrationOTPWait) error {
	_ = g.server.Runtime().DeleteTransientState(ctx, wamodel.RegistrationOTPWaitKey(wait.VerificationRequestID))
	if wait.WAAccountID != "" {
		_ = g.server.Runtime().DeleteTransientState(ctx, wamodel.RegistrationOTPWaitAccountKey(wait.WAAccountID))
	}
	return nil
}

func postRegistrationOTPResume(ctx context.Context, wait wamodel.RegistrationOTPWait, code string) error {
	body, err := json.Marshal(map[string]any{
		"otp":                     code,
		"code":                    code,
		"verification_code":       code,
		"verification_request_id": wait.VerificationRequestID,
		"otp_source":              "manual_frontend",
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, wait.ResumeURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("resume registration otp wait: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1024))
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("resume registration otp wait returned HTTP %d", resp.StatusCode)
	}
	return nil
}

func (g *actionGateway) submitOTP(ctx context.Context, payload map[string]any) (map[string]any, error) {
	runner, route, managedRoute, err := g.registrationRunner(payload)
	if err != nil {
		return nil, err
	}
	resp, err := g.server.SubmitVerificationCodeWithRunner(ctx, &waappv1.SubmitVerificationCodeRequest{
		Context:               actionContext(payload),
		VerificationRequestId: shared.TextField(payload, "verification_request_id"),
		SubmittedCode:         &waappv1.SubmitVerificationCodeRequest_Code{Code: shared.TextField(payload, "code")},
	}, runner)
	runner.CloseIdleConnections()
	if err != nil {
		return nil, err
	}
	if resp.GetError() != nil {
		return map[string]any{"success": false, "error": protoMap(resp.GetError()), "error_message": resp.GetError().GetMessage(), "registration": protoMap(resp.GetRegistration())}, nil
	}
	success := resp.GetRegistration().GetStatus() == waappv1.RegistrationStatus_REGISTRATION_STATUS_REGISTERED && resp.GetLoginState().GetStatus() == waappv1.LoginStateStatus_LOGIN_STATE_STATUS_ACTIVE
	if success {
		_ = g.deleteRegistrationOTPWait(ctx, wamodel.RegistrationOTPWait{
			WAAccountID:           resp.GetRegistration().GetWaAccountId(),
			VerificationRequestID: resp.GetRegistration().GetVerificationRequestId(),
		})
	}
	return map[string]any{
		"success":      success,
		"status":       resp.GetRegistration().GetStatus().String(),
		"registration": protoMap(resp.GetRegistration()),
		"login_state":  protoMap(resp.GetLoginState()),
		"proxy":        registrationProxyRouteMap(route, managedRoute),
	}, nil
}

func (g *actionGateway) refreshAccountTransferChallenge(ctx context.Context, payload map[string]any) (any, error) {
	resp, err := g.server.RefreshAccountTransferChallenge(ctx, &waappv1.RefreshAccountTransferChallengeRequest{
		Context:               actionContext(payload),
		VerificationRequestId: shared.TextField(payload, "verification_request_id"),
	})
	if err != nil {
		return nil, err
	}
	if resp.GetError() != nil {
		return actionErrorFromProto(resp.GetError()), nil
	}
	return accountTransferChallengeDTO{
		Success:                  true,
		RegistrationPhase:        "ACCOUNT_TRANSFER_WAITING",
		AccountTransferChallenge: protoMap(resp.GetAccountTransferChallenge()),
	}, nil
}

type accountTransferChallengeDTO struct {
	Success                  bool           `json:"success"`
	RegistrationPhase        string         `json:"registration_phase"`
	AccountTransferChallenge map[string]any `json:"account_transfer_challenge"`
}

func (g *actionGateway) pollAccountTransferRegistration(ctx context.Context, payload map[string]any) (map[string]any, error) {
	attempts := int(numberField(payload, "max_attempts"))
	if attempts <= 0 {
		attempts = 1
	}
	if attempts > 100 {
		attempts = 100
	}
	interval := time.Duration(numberField(payload, "interval_seconds")) * time.Second
	var result map[string]any
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 && interval > 0 {
			timer := time.NewTimer(interval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			case <-timer.C:
			}
		}
		submitPayload := cloneActionPayload(payload)
		submitPayload["code"] = ""
		resultValue, err := g.submitOTP(ctx, submitPayload)
		if err != nil {
			return nil, err
		}
		result = resultValue
		if boolField(result, "success") {
			_ = g.deleteRegistrationOTPWait(ctx, wamodel.RegistrationOTPWait{WAAccountID: shared.TextField(payload, "wa_account_id"), VerificationRequestID: shared.TextField(payload, "verification_request_id")})
			result["attempts"] = attempt + 1
			return result, nil
		}
		if !accountTransferPollRetryable(result) {
			result["attempts"] = attempt + 1
			return result, nil
		}
	}
	if result == nil {
		result = map[string]any{"success": false}
	}
	result["registration_phase"] = "ACCOUNT_TRANSFER_WAITING"
	result["attempts"] = attempts
	return result, nil
}

func accountTransferPollRetryable(result map[string]any) bool {
	if result == nil {
		return true
	}
	if shared.TextField(result, "status") == waappv1.RegistrationStatus_REGISTRATION_STATUS_SUBMITTED.String() {
		return true
	}
	errorMap := shared.ObjectField(result, "error")
	if boolField(errorMap, "retryable") {
		return true
	}
	message := strings.ToLower(shared.FirstNonEmpty(shared.TextField(result, "error_message"), shared.TextField(errorMap, "message")))
	return strings.Contains(message, "pending") || strings.Contains(message, "temporarily") || strings.Contains(message, "too_recent")
}

func (g *actionGateway) cleanupFailedRegistration(ctx context.Context, payload map[string]any) (map[string]any, error) {
	reqCtx := actionContext(payload)
	accountID := cleanupWAAccountID(payload)
	verificationRequestID := cleanupVerificationRequestID(payload)
	if verificationRequestID != "" || accountID != "" {
		_ = g.deleteRegistrationOTPWait(ctx, wamodel.RegistrationOTPWait{
			WAAccountID:           accountID,
			VerificationRequestID: verificationRequestID,
		})
	}
	if accountID == "" {
		return map[string]any{"success": true, "deleted": false, "reason": "missing_wa_account_id"}, nil
	}
	normalizedAccountID, err := wamodel.RequireWAAccountID(accountID)
	if err != nil {
		return nil, err
	}
	account, err := g.server.GetWAAccountRecord(ctx, normalizedAccountID)
	if wamodel.IsWAAccountNotFound(err) {
		return map[string]any{"success": true, "deleted": false, "wa_account_id": normalizedAccountID, "reason": "already_deleted"}, nil
	}
	if err != nil {
		return nil, err
	}
	status := wamodel.WAAccountStatus(account)
	if status != waappv1.WAAccountStatus_WA_ACCOUNT_STATUS_PENDING_REGISTRATION {
		return map[string]any{"success": true, "deleted": false, "wa_account_id": normalizedAccountID, "status": status.String(), "reason": "not_pending_registration"}, nil
	}
	resp, err := g.server.DeleteWAAccount(ctx, &waappv1.DeleteWAAccountRequest{Context: reqCtx, WaAccountId: normalizedAccountID})
	if err != nil {
		return nil, err
	}
	if resp.GetError() != nil {
		return map[string]any{"success": false, "deleted": false, "wa_account_id": normalizedAccountID, "error": protoMap(resp.GetError()), "error_message": resp.GetError().GetMessage()}, nil
	}
	return map[string]any{"success": true, "deleted": resp.GetSuccess(), "wa_account_id": normalizedAccountID}, nil
}

func (g *actionGateway) persistLoginState(ctx context.Context, payload map[string]any) (any, error) {
	registration := shared.ObjectField(payload, "registration")
	if nested := shared.ObjectField(registration, "registration"); len(nested) > 0 {
		registration = nested
	}
	registrationID := shared.TextField(registration, "registration_id")
	var loginState *waappv1.LoginState
	var err error
	if registrationID != "" {
		loginState, err = g.server.Store().GetLoginStateByRegistration(ctx, registrationID)
	} else if clientProfileID := shared.TextField(payload, "client_profile_id"); clientProfileID != "" {
		loginState, err = g.server.Store().GetActiveLoginState(ctx, shared.TextField(registration, "wa_account_id"), clientProfileID)
	} else {
		err = shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "registration_id or client_profile_id is required", false)
	}
	if err != nil {
		return actionError(err), nil
	}
	ok := loginState.GetStatus() == waappv1.LoginStateStatus_LOGIN_STATE_STATUS_ACTIVE
	return loginStateResultDTO{Success: ok, Status: loginState.GetStatus().String(), LoginState: protoMap(loginState)}, nil
}

type loginStateResultDTO struct {
	Success    bool           `json:"success"`
	Status     string         `json:"status"`
	LoginState map[string]any `json:"login_state"`
}

// checkLoginStateResultDTO carries the base result plus an optional error
// envelope. ErrorMessage is a *string so it is present-even-when-empty exactly
// when there is an error, and absent otherwise (matching the previous
// conditionally-added map keys).
type checkLoginStateResultDTO struct {
	Success      bool           `json:"success"`
	Status       string         `json:"status"`
	LoginState   map[string]any `json:"login_state"`
	Check        map[string]any `json:"check"`
	Error        map[string]any `json:"error,omitempty"`
	ErrorMessage *string        `json:"error_message,omitempty"`
}

func (g *actionGateway) CheckLoginStateWithRunner(ctx context.Context, payload map[string]any) (any, error) {
	runner, err := g.nativeEngineForPayload(payload)
	if err != nil {
		return nil, err
	}
	loginStatePayload := shared.ObjectField(payload, "login_state")
	req := &waappv1.CheckLoginStateRequest{
		Context:              actionContext(payload),
		LoginStateId:         shared.FirstNonEmpty(shared.TextField(payload, "login_state_id"), shared.TextField(loginStatePayload, "login_state_id")),
		WaAccountId:          shared.FirstNonEmpty(shared.TextField(payload, "wa_account_id"), shared.TextField(loginStatePayload, "wa_account_id")),
		ClientProfileId:      shared.FirstNonEmpty(shared.TextField(payload, "client_profile_id"), shared.TextField(loginStatePayload, "client_profile_id")),
		RegisteredIdentityId: shared.FirstNonEmpty(shared.TextField(payload, "registered_identity_id"), shared.TextField(loginStatePayload, "registered_identity_id")),
	}
	if timeout := numberField(payload, "remote_timeout_seconds"); timeout > 0 {
		req.RemoteTimeout = durationpb.New(time.Duration(timeout) * time.Second)
	}
	resp, err := g.server.CheckLoginStateWithRunner(ctx, req, runner)
	if err != nil {
		return nil, err
	}
	check := resp.GetCheck()
	ok := resp.GetError() == nil && check.GetStatus() == waappv1.LoginStateCheckStatus_LOGIN_STATE_CHECK_STATUS_ACTIVE && resp.GetLoginState().GetStatus() == waappv1.LoginStateStatus_LOGIN_STATE_STATUS_ACTIVE
	result := checkLoginStateResultDTO{
		Success:    ok,
		Status:     check.GetStatus().String(),
		LoginState: protoMap(resp.GetLoginState()),
		Check:      protoMap(check),
	}
	if resp.GetError() != nil {
		result.Error = protoMap(resp.GetError())
		msg := resp.GetError().GetMessage()
		result.ErrorMessage = &msg
	}
	return result, nil
}

func (g *actionGateway) commitNativeState(ctx context.Context, phone *waappv1.PhoneTarget, state engine.NativeState) (*waappv1.WAAccount, *waappv1.ClientProfile, *waappv1.ProtocolProfile, error) {
	saver, ok := g.server.Runner().(nativeStateSaver)
	if !ok {
		return nil, nil, nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_UNSUPPORTED_OPERATION, "native engine is required", false)
	}
	if phone.GetE164Number() == "" {
		return nil, nil, nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "phone is required", false)
	}
	account, err := g.server.Store().FindWAAccountByPhone(ctx, phone.GetE164Number())
	if err != nil {
		now := g.server.Clock().Now()
		account = wamodel.NewWAAccount(g.server.IDs().NewID("waacc_"), "", phone, waappv1.WAAccountStatus_WA_ACCOUNT_STATUS_PENDING_REGISTRATION, &waappv1.AuditStamp{CreatedAt: timestamppb.New(now), UpdatedAt: timestamppb.New(now)})
		account, err = g.server.SaveWAAccountRecord(ctx, account)
		if err != nil {
			return nil, nil, nil, err
		}
	}
	protocol, err := g.ensureDefaultProtocolProfile(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	now := g.server.Clock().Now()
	profile := &waappv1.ClientProfile{ClientProfileId: g.server.IDs().NewID("wacp_"), WaAccountId: wamodel.WAAccountID(account), ProtocolProfileId: protocol.GetProtocolProfileId(), Status: waappv1.ClientProfileStatus_CLIENT_PROFILE_STATUS_PREPARING, RegistrationKeyState: waappv1.KeyMaterialStatus_KEY_MATERIAL_STATUS_PENDING, MessagingKeyState: waappv1.KeyMaterialStatus_KEY_MATERIAL_STATUS_PENDING, Audit: &waappv1.AuditStamp{CreatedAt: timestamppb.New(now), UpdatedAt: timestamppb.New(now)}}
	if err := g.server.Store().SaveClientProfile(ctx, profile); err != nil {
		return nil, nil, nil, err
	}
	state.CC = shared.FirstNonEmpty(state.CC, shared.PhoneCC(phone))
	state.Phone = shared.FirstNonEmpty(state.Phone, shared.PhoneNational(phone))
	if err := saver.SaveState(ctx, profile.GetClientProfileId(), state); err != nil {
		profile.Status = waappv1.ClientProfileStatus_CLIENT_PROFILE_STATUS_REJECTED
		profile.LastError = shared.ToProtoError(err)
		_ = g.server.Store().SaveClientProfile(ctx, profile)
		return nil, nil, nil, err
	}
	profile.Status = waappv1.ClientProfileStatus_CLIENT_PROFILE_STATUS_READY
	profile.RegistrationKeyState = waappv1.KeyMaterialStatus_KEY_MATERIAL_STATUS_READY
	profile.MessagingKeyState = waappv1.KeyMaterialStatus_KEY_MATERIAL_STATUS_READY
	profile.Audit.UpdatedAt = timestamppb.New(g.server.Clock().Now())
	if err := g.server.Store().SaveClientProfile(ctx, profile); err != nil {
		return nil, nil, nil, err
	}
	return account, profile, protocol, nil
}

type nativeStateSaver interface {
	SaveState(context.Context, string, engine.NativeState) error
}

func (g *actionGateway) ensureDefaultProtocolProfile(ctx context.Context) (*waappv1.ProtocolProfile, error) {
	protocolID := "waproto_native"
	if profile, err := g.server.Store().GetProtocolProfile(ctx, protocolID); err == nil {
		if engine.NativeAppVersion(profile.GetAppVersion()) != engine.DefaultWAAppVersion {
			profile.AppVersion = engine.DefaultWAAppVersion
			_ = g.server.Store().SaveProtocolProfile(ctx, profile)
		}
		return profile, nil
	}
	now := g.server.Clock().Now()
	artifactID := "waart_native"
	artifact := &waappv1.AppArtifact{ArtifactId: artifactID, Label: "WA native app", VersionLabel: "native", ObservedAt: timestamppb.New(now)}
	if err := g.server.Store().SaveAppArtifact(ctx, artifact); err != nil {
		return nil, err
	}
	profile := &waappv1.ProtocolProfile{
		ProtocolProfileId: protocolID,
		AppArtifactId:     artifactID,
		DisplayName:       "WA native protocol",
		AppVersion:        engine.DefaultWAAppVersion,
		Status:            waappv1.ProtocolProfileStatus_PROTOCOL_PROFILE_STATUS_ACTIVE,
		Capabilities: []waappv1.ProtocolCapability{
			waappv1.ProtocolCapability_PROTOCOL_CAPABILITY_ACCOUNT_PROBE,
			waappv1.ProtocolCapability_PROTOCOL_CAPABILITY_CODE_REQUEST,
			waappv1.ProtocolCapability_PROTOCOL_CAPABILITY_CODE_SUBMIT,
			waappv1.ProtocolCapability_PROTOCOL_CAPABILITY_MESSAGE_SESSION,
			waappv1.ProtocolCapability_PROTOCOL_CAPABILITY_ACCOUNT_SETTINGS,
		},
		RegistrationFlows: []waappv1.RegistrationFlowKind{waappv1.RegistrationFlowKind_REGISTRATION_FLOW_KIND_NEW_ACCOUNT, waappv1.RegistrationFlowKind_REGISTRATION_FLOW_KIND_EXISTING_ACCOUNT},
		MessageTransports: []waappv1.MessageTransportKind{waappv1.MessageTransportKind_MESSAGE_TRANSPORT_KIND_LONG_CONNECTION},
		DiscoveredAt:      timestamppb.New(now),
		Audit:             &waappv1.AuditStamp{CreatedAt: timestamppb.New(now), UpdatedAt: timestamppb.New(now)},
	}
	if err := g.server.Store().SaveProtocolProfile(ctx, profile); err != nil {
		return nil, err
	}
	return profile, nil
}

func (g *actionGateway) nativeEngineForPayload(payload map[string]any) (*engine.NativeEngine, error) {
	engine, err := g.nativeEngine()
	if err != nil {
		return nil, err
	}
	proxyURL := actionProxyURL(payload)
	if proxyURL == "" {
		return engine, nil
	}
	return engine.WithProxyURL(proxyURL)
}

func (g *actionGateway) registrationRunner(payload map[string]any) (*engine.NativeEngine, wacore.WAProxyRoute, bool, error) {
	engine, err := g.nativeEngine()
	if err != nil {
		return nil, wacore.WAProxyRoute{}, false, err
	}
	route, useProxy := g.resolveWAProxyRoute(waProxyResolveRequest{
		Payload:     payload,
		CountryCode: proxyCountryCodeFromPayload(payload),
	})
	if !useProxy {
		return engine, route, false, nil
	}
	proxied, err := engine.WithProxyURL(route.ProxyURL)
	if err != nil {
		return nil, wacore.WAProxyRoute{}, false, err
	}
	return proxied, route, true, nil
}

func registrationProxyRouteMap(route wacore.WAProxyRoute, managed bool) map[string]any {
	if !managed {
		return map[string]any{}
	}
	result := map[string]any{
		"proxy_mode":   shared.FirstNonEmpty(route.ProxyMode, "PROXY"),
		"country_code": shared.FirstNonEmpty(route.CountryCode, "UNKNOWN"),
	}
	if strings.TrimSpace(route.AccountID) != "" {
		result["account_id"] = route.AccountID
	}
	if strings.TrimSpace(route.RouteID) != "" {
		result["route_id"] = route.RouteID
	}
	if strings.TrimSpace(route.Source) != "" {
		result["source"] = route.Source
	}
	if strings.TrimSpace(route.PolicyMode) != "" {
		result["policy_mode"] = route.PolicyMode
	}
	return result
}

func actionProxyURL(payload map[string]any) string {
	if proxyURL := shared.FirstNonEmpty(shared.TextField(payload, "proxy_url"), shared.TextField(shared.ObjectField(payload, "proxy"), "proxy_url")); proxyURL != "" {
		return proxyURL
	}
	rawState := shared.FirstNonEmpty(shared.TextField(payload, "proxy_state_json"), shared.TextField(payload, "state_json"), shared.TextField(shared.ObjectField(payload, "proxy"), "proxy_state_json"), shared.TextField(shared.ObjectField(payload, "proxy"), "state_json"))
	if rawState == "" {
		return ""
	}
	state := map[string]any{}
	if err := json.Unmarshal([]byte(rawState), &state); err != nil {
		return ""
	}
	return shared.FirstNonEmpty(shared.TextField(state, "_gopay_proxy"), shared.TextField(state, "proxy_url"), shared.TextField(shared.ObjectField(state, "proxy"), "proxy_url"))
}

func cleanupWAAccountID(payload map[string]any) string {
	registration := shared.ObjectField(payload, "registration")
	if nested := shared.ObjectField(registration, "registration"); len(nested) > 0 {
		registration = nested
	}
	verificationRequest := shared.ObjectField(payload, "verification_request")
	data := shared.ObjectField(payload, "data")
	return shared.FirstNonEmpty(
		shared.TextField(payload, "wa_account_id"),
		shared.TextField(registration, "wa_account_id"),
		shared.TextField(verificationRequest, "wa_account_id"),
		shared.TextField(shared.ObjectField(payload, "account"), "wa_account_id"),
		shared.TextField(data, "wa_account_id"),
		shared.TextField(shared.ObjectField(data, "registration"), "wa_account_id"),
		shared.TextField(shared.ObjectField(data, "verification_request"), "wa_account_id"),
	)
}

func cleanupVerificationRequestID(payload map[string]any) string {
	verificationRequest := shared.ObjectField(payload, "verification_request")
	data := shared.ObjectField(payload, "data")
	return shared.FirstNonEmpty(
		shared.TextField(payload, "verification_request_id"),
		shared.TextField(verificationRequest, "verification_request_id"),
		shared.TextField(data, "verification_request_id"),
		shared.TextField(shared.ObjectField(data, "verification_request"), "verification_request_id"),
	)
}

func (g *actionGateway) nativeEngine() (*engine.NativeEngine, error) {
	engine, ok := g.server.Runner().(*engine.NativeEngine)
	if !ok {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_UNSUPPORTED_OPERATION, "native engine is required", false)
	}
	return engine, nil
}

func (g *actionGateway) loadTransientState(ctx context.Context, ref string) (engine.NativeState, error) {
	data, err := g.server.Runtime().GetTransientState(ctx, ref)
	if err != nil {
		return engine.NativeState{}, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_PROFILE_NOT_FOUND, "transient fingerprint state not found", false)
	}
	return engine.UnmarshalNativeState(data)
}

func readActionPayload(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		writeActionJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return nil, false
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return map[string]any{}, true
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	payload := map[string]any{}
	if err := dec.Decode(&payload); err != nil {
		writeActionJSON(w, http.StatusBadRequest, map[string]string{"error": "request body must be json"})
		return nil, false
	}
	return payload, true
}

func writeActionJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func actionContext(payload map[string]any) *waappv1.RequestContext {
	return &waappv1.RequestContext{
		RequestId:     shared.TextField(payload, "request_id"),
		ActorId:       shared.TextField(payload, "actor_id"),
		CorrelationId: shared.FirstNonEmpty(shared.TextField(payload, "correlation_id"), shared.TextField(payload, "job_id")),
		TraceId:       shared.TextField(payload, "trace_id"),
	}
}

func phoneFromAction(payload map[string]any) *waappv1.PhoneTarget {
	phone := shared.ObjectField(payload, "phone")
	if len(phone) == 0 {
		phone = payload
	}
	return &waappv1.PhoneTarget{
		E164Number:         shared.FirstNonEmpty(shared.TextField(phone, "e164_number"), shared.TextField(payload, "e164_number")),
		CountryCallingCode: shared.FirstNonEmpty(shared.TextField(phone, "country_calling_code"), shared.TextField(payload, "country_calling_code"), shared.TextField(payload, "cc")),
		NationalNumber:     shared.FirstNonEmpty(shared.TextField(phone, "national_number"), shared.TextField(payload, "national_number"), shared.TextField(payload, "phone"), shared.TextField(payload, "number")),
		CountryIso2:        shared.FirstNonEmpty(shared.TextField(phone, "country_iso2"), shared.TextField(payload, "country_iso2"), shared.TextField(payload, "country_code")),
	}
}

func numberField(data map[string]any, key string) int64 {
	switch value := data[key].(type) {
	case json.Number:
		n, _ := value.Int64()
		return n
	case float64:
		return int64(value)
	case string:
		var n int64
		_, _ = fmt.Sscan(value, &n)
		return n
	default:
		return 0
	}
}

func protoMap(msg proto.Message) map[string]any {
	if msg == nil {
		return map[string]any{}
	}
	data, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(msg)
	if err != nil {
		return map[string]any{}
	}
	out := map[string]any{}
	_ = json.Unmarshal(data, &out)
	return out
}

// actionErrorDTO is the uniform dashboard error envelope. Both keys are always
// present (no omitempty), matching the previous map[string]any error responses.
type actionErrorDTO struct {
	Success      bool           `json:"success"`
	Error        map[string]any `json:"error"`
	ErrorMessage string         `json:"error_message"`
}

func actionError(err error) actionErrorDTO {
	return actionErrorFromProto(shared.ToProtoError(err))
}

func actionErrorFromProto(protoErr *waappv1.WaError) actionErrorDTO {
	return actionErrorDTO{Success: false, Error: protoMap(protoErr), ErrorMessage: protoErr.GetMessage()}
}

func enumNames[T interface{ String() string }](values []T) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, value.String())
	}
	return out
}
