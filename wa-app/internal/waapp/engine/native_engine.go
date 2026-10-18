package engine

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/store"
	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
	"github.com/byte-v-forge/wa-app/internal/waapp/wamodel"
	"github.com/byte-v-forge/wa-app/internal/waapp/waproto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const (
	DefaultWAAppVersion     = "2.26.26.72"
	defaultWAAppVersionCode = 262607220
	defaultWAABPropURL      = "https://y9yrsygcg6.execute-api.us-east-1.amazonaws.com/s/s?_=/v2/reg_onboard_abprop&"
	defaultWAExistURL       = "https://y9yrsygcg6.execute-api.us-east-1.amazonaws.com/s/s?_=/v2/exist&"
	defaultWACodeURL        = "https://y9yrsygcg6.execute-api.us-east-1.amazonaws.com/s/s?_=/v2/code&"
	defaultWARegisterURL    = "https://y9yrsygcg6.execute-api.us-east-1.amazonaws.com/s/s?_=/v2/register&"

	nativeDefaultSMSCodeLength int32 = 6
)

var chatdNodeTokenErrorPattern = regexp.MustCompile(`(?i)(readstring could not match token|invalid list-size token)\s+([0-9]{1,3})`)

// engineCore holds the immutable per-proxy-binding collaborators plus the request
// material shaping shared by every native domain service. A fresh core is produced
// for each proxy rebinding (see WithProxyURL).
type engineCore struct {
	stateStore     store.NativeStateStore
	activeProxyURL string
	http           *nativeHTTPClient
	clock          shared.Clock
	ids            shared.IDGenerator
	wamsys         wamsysMaterialProvider
}

// NativeEngine is the facade over the per-domain native services. It embeds the
// shared core plus one focused service per domain, so its full protocol and
// capability method set is promoted from small single-responsibility services
// instead of living on one god object.
type NativeEngine struct {
	*engineCore
	*registrationService
	*messagingService
	*contactsService
	*accountSettingsService
	*toolingService
}

// registrationService owns the account probe / verification / login flows.
type registrationService struct{ *engineCore }

// messagingService owns inbound batch receive, decryption, text send and receipts.
type messagingService struct{ *engineCore }

// contactsService owns usync contact resolution and contact profile pictures.
type contactsService struct{ *engineCore }

// accountSettingsService owns 2FA / email / profile-name / picture operations.
type accountSettingsService struct{ *engineCore }

// toolingService owns the offline fingerprint / capture / crypto tooling.
type toolingService struct{ *engineCore }

func newNativeEngine(core *engineCore) *NativeEngine {
	return &NativeEngine{
		engineCore:             core,
		registrationService:    &registrationService{core},
		messagingService:       &messagingService{core},
		contactsService:        &contactsService{core},
		accountSettingsService: &accountSettingsService{core},
		toolingService:         &toolingService{core},
	}
}

func NewNativeEngine(stateStore store.NativeStateStore, clock shared.Clock, ids shared.IDGenerator) (*NativeEngine, error) {
	if stateStore == nil {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_INTERNAL, "native state store is required", false)
	}
	if clock == nil {
		clock = shared.SystemClock{}
	}
	if ids == nil {
		ids = shared.RandomIDGenerator{}
	}
	hc, err := newNativeHTTPClient("")
	if err != nil {
		return nil, err
	}
	return newNativeEngine(&engineCore{stateStore: stateStore, http: hc, clock: clock, ids: ids, wamsys: localWamsysMaterialProvider{}}), nil
}

func (e *NativeEngine) WithPlayIntegrityAPI(endpoint, token string) (*NativeEngine, error) {
	client, err := newPlayIntegrityAPIClient(endpoint, token)
	if err != nil {
		return nil, err
	}
	return newNativeEngine(&engineCore{stateStore: e.stateStore, activeProxyURL: e.activeProxyURL, http: e.http, clock: e.clock, ids: e.ids, wamsys: localWamsysMaterialProvider{playIntegrity: client}}), nil
}

func (e *NativeEngine) WithProxyURL(proxyURL string) (*NativeEngine, error) {
	proxyURL, err := normalizeProxyURLString(proxyURL)
	if err != nil {
		return nil, err
	}
	hc, err := newNativeHTTPClient(proxyURL)
	if err != nil {
		return nil, err
	}
	return newNativeEngine(&engineCore{stateStore: e.stateStore, activeProxyURL: proxyURL, http: hc, clock: e.clock, ids: e.ids, wamsys: e.wamsysProvider()}), nil
}

func (e *engineCore) wamsysProvider() wamsysMaterialProvider {
	if e != nil && e.wamsys != nil {
		return e.wamsys
	}
	return localWamsysMaterialProvider{}
}

func (e *engineCore) PlayIntegrityAPIConfigured() bool {
	provider, ok := e.wamsysProvider().(localWamsysMaterialProvider)
	return ok && provider.playIntegrity != nil
}

func (e *engineCore) PlayIntegrityAPIStatus(ctx context.Context) PlayIntegrityAPIStatus {
	provider, ok := e.wamsysProvider().(localWamsysMaterialProvider)
	if !ok || provider.playIntegrity == nil {
		return PlayIntegrityAPIStatus{Configured: false, Available: false, RawValuesPrinted: false}
	}
	return provider.playIntegrity.Status(ctx)
}

func (e *engineCore) CloseIdleConnections() {
	if e == nil || e.http == nil {
		return
	}
	e.http.CloseIdleConnections()
}

func (e *registrationService) PrepareClientProfile(ctx context.Context, input wacore.EngineProfileInput) error {
	_ = ctx
	state, err := newNativeState(input.Phone)
	if err != nil {
		return err
	}
	return e.SaveState(ctx, input.ClientProfileID, state)
}

// existProbeTransientAttempts 限定 /v2/exist 探测在纯传输层失败(代理/网络抖动,响应
// 无任何可解析的应用层结论)时的最大尝试次数。exist 是幂等检查,重试安全。
const existProbeTransientAttempts = 3

func (e *registrationService) ProbeAccount(ctx context.Context, input wacore.EngineRegistrationInput) wacore.EngineProbeResult {
	state, err := e.NewState(input.Phone)
	if err != nil {
		return wacore.EngineProbeResult{Status: waappv1.AccountProbeStatus_ACCOUNT_PROBE_STATUS_REJECTED, Err: err}
	}
	result, _ := e.ProbeAccountWithState(ctx, input, state)
	return result
}

func (e *registrationService) ProbeAccountWithState(ctx context.Context, input wacore.EngineRegistrationInput, state NativeState) (wacore.EngineProbeResult, NativeState) {
	if err := ensureNativeSoftwareAttestation(&state, e.clock.Now()); err != nil {
		return wacore.EngineProbeResult{Status: waappv1.AccountProbeStatus_ACCOUNT_PROBE_STATUS_REJECTED, Err: err}, state
	}
	built, err := e.existOrderedParamsWithWamsys(ctx, input.Phone, state, nil, true, input.AppVersion, input.IntegrityMode)
	if err != nil {
		return wacore.EngineProbeResult{Status: waappv1.AccountProbeStatus_ACCOUNT_PROBE_STATUS_REJECTED, Err: err}, state
	}
	logNativeRegistrationOrderedShape("exist", input.Phone, input.DeliveryMethod, built)
	plain := built.render()
	client, err := e.httpForProxy()
	if err != nil {
		return wacore.EngineProbeResult{Status: waappv1.AccountProbeStatus_ACCOUNT_PROBE_STATUS_REJECTED, Err: err}, state
	}
	// /v2/exist 幂等;纯传输层抖动(代理 EOF/重置/超时,响应无任何可解析的应用层结论)
	// 时重试若干次,避免单次代理失败被判成 probe_failed —— 那会让前端对同一号码"通道
	// 忽有忽无"。拿到成功响应、真正的应用层结论(含协议拒绝)或 ctx 取消即停。
	var data map[string]any
	var result wacore.EngineProbeResult
	for attempt := 1; attempt <= existProbeTransientAttempts; attempt++ {
		data, _, err = client.postWASafe(ctx, defaultWAExistURL, plain, nativeUserAgentForState(state, input.AppVersion), state.Attestation)
		result = parseExistProbeResult(data)
		if err == nil || result.Err != nil || parsedExistApplicationOutcome(result) || ctx.Err() != nil {
			break
		}
	}
	if err != nil {
		if result.Err != nil || parsedExistApplicationOutcome(result) {
			return result, state
		}
		result.Status = waappv1.AccountProbeStatus_ACCOUNT_PROBE_STATUS_REJECTED
		result.AccountFlow = AccountProbeFlowProbeFailed
		result.Err = classifyHTTPError(data, err)
	}
	return result, state
}

func parsedExistApplicationOutcome(result wacore.EngineProbeResult) bool {
	return result.Status != waappv1.AccountProbeStatus_ACCOUNT_PROBE_STATUS_UNKNOWN ||
		result.AccountFlow != AccountProbeFlowUnknown ||
		result.RawStatus != "" ||
		result.RawReason != "" ||
		len(result.MethodStatuses) > 0
}

func (e *registrationService) RequestVerificationCode(ctx context.Context, input wacore.EngineRegistrationInput) wacore.EngineCodeResult {
	state, err := e.loadState(ctx, input.ClientProfileID)
	if err != nil {
		return wacore.EngineCodeResult{Status: waappv1.VerificationRequestStatus_VERIFICATION_REQUEST_STATUS_REJECTED, Err: err}
	}
	result, updated := e.RequestVerificationCodeWithState(ctx, input, state)
	_ = e.SaveState(ctx, input.ClientProfileID, updated)
	return result
}

func (e *registrationService) RequestVerificationCodeWithState(ctx context.Context, input wacore.EngineRegistrationInput, state NativeState) (wacore.EngineCodeResult, NativeState) {
	if err := ensureNativeSoftwareAttestation(&state, e.clock.Now()); err != nil {
		return wacore.EngineCodeResult{Status: waappv1.VerificationRequestStatus_VERIFICATION_REQUEST_STATUS_REJECTED, Err: err}, state
	}
	state.nextGenerateCodeAttempt()
	params, err := e.codeRequestOrderedParams(ctx, input.Phone, input.DeliveryMethod, state, input.AuthCodeContext, input.AppVersion, input.IntegrityMode)
	if err != nil {
		return wacore.EngineCodeResult{Status: waappv1.VerificationRequestStatus_VERIFICATION_REQUEST_STATUS_REJECTED, Err: err}, state
	}
	logNativeRegistrationOrderedShape("code", input.Phone, input.DeliveryMethod, params)
	plain := params.render()
	client, err := e.httpForProxy()
	if err != nil {
		return wacore.EngineCodeResult{Status: waappv1.VerificationRequestStatus_VERIFICATION_REQUEST_STATUS_REJECTED, Err: err}, state
	}
	data, enc, err := client.postWASafe(ctx, defaultWACodeURL, plain, nativeUserAgentForState(state, input.AppVersion), state.Attestation)
	state.LastCodeParams = params.toMap()
	state.LastCodeResult = sanitizeResponse(data)
	if enc != "" {
		state.LastCodeResult["enc_sha256"] = encHash(enc)
	}
	if input.DeliveryMethod != waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_ACCOUNT_TRANSFER {
		state.AccountTransfer = nativeAccountTransferState{}
	}
	retryAfter := verificationCodeRetryAfter(data, input.DeliveryMethod)
	now := e.clock.Now()
	if err != nil {
		if verificationCodeRateLimited(data) {
			return verificationCodeRejectedResult(data, input.DeliveryMethod, now, retryAfter, "verification request is cooling down"), state
		}
		return wacore.EngineCodeResult{
			Status:         waappv1.VerificationRequestStatus_VERIFICATION_REQUEST_STATUS_REJECTED,
			RetryAfter:     retryAfter,
			MethodStatuses: verificationCodeMethodStatuses(data, input.DeliveryMethod),
			RawStatus:      responseStatus(data),
			RawReason:      responseReason(data),
			Err:            classifyHTTPError(data, err),
		}, state
	}
	status := waappv1.VerificationRequestStatus_VERIFICATION_REQUEST_STATUS_WAITING
	s := responseStatus(data)
	if s == "sent" || s == "ok" {
		status = waappv1.VerificationRequestStatus_VERIFICATION_REQUEST_STATUS_SENT
	} else if verificationCodeRateLimited(data) {
		return verificationCodeRejectedResult(data, input.DeliveryMethod, now, retryAfter, "verification request is cooling down"), state
	} else if s != "" {
		return wacore.EngineCodeResult{
			Status:         waappv1.VerificationRequestStatus_VERIFICATION_REQUEST_STATUS_REJECTED,
			RetryAfter:     retryAfter,
			MethodStatuses: verificationCodeMethodStatuses(data, input.DeliveryMethod),
			RawStatus:      responseStatus(data),
			RawReason:      responseReason(data),
			Err:            waProtocolError(data, "verification request was rejected"),
		}, state
	}
	result := verificationCodeResult(status, data, input.DeliveryMethod, now, retryAfter)
	if input.DeliveryMethod == waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_ACCOUNT_TRANSFER {
		challenge, challengeErr := e.prepareAccountTransferChallenge(input.Phone, &state, data, now)
		if challengeErr != nil {
			result.Status = waappv1.VerificationRequestStatus_VERIFICATION_REQUEST_STATUS_REJECTED
			result.Err = challengeErr
			result.RawStatus = responseStatus(data)
			result.RawReason = responseReason(data)
			return result, state
		}
		result.AccountTransferChallenge = challenge
		result.ExpectedCodeLength = challenge.GetCurrentCodeLength()
		result.ExpiresAt = challenge.GetExpiresAt().AsTime()
		result.MethodStatuses = upsertVerificationMethodStatus(result.MethodStatuses, "acc_tr", verificationWaitStatus{Present: true})
	}
	return result, state
}

func (e *registrationService) prepareAccountTransferChallenge(phone *waappv1.PhoneTarget, state *NativeState, data map[string]any, now time.Time) (*waappv1.AccountTransferChallenge, error) {
	codes := accountTransferCodesFromResponse(data)
	if len(codes) == 0 {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, "account transfer code list is missing", false)
	}
	state.AccountTransfer = newNativeAccountTransferState(phone, codes, now)
	return state.AccountTransfer.challenge("", now)
}

func (e *registrationService) RefreshAccountTransferChallenge(ctx context.Context, input wacore.EngineAccountTransferChallengeInput) wacore.EngineAccountTransferChallengeResult {
	state, err := e.loadState(ctx, input.ClientProfileID)
	if err != nil {
		return wacore.EngineAccountTransferChallengeResult{Err: err}
	}
	if state.AccountTransfer.empty() {
		return wacore.EngineAccountTransferChallengeResult{Err: shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_EXPIRED, "account transfer challenge is not available", false)}
	}
	challenge, err := state.AccountTransfer.challenge(input.VerificationRequestID, e.clock.Now())
	if err != nil {
		return wacore.EngineAccountTransferChallengeResult{Err: err}
	}
	_ = e.SaveState(ctx, input.ClientProfileID, state)
	return wacore.EngineAccountTransferChallengeResult{Challenge: challenge}
}

func (e *registrationService) SubmitVerificationCode(ctx context.Context, input wacore.EngineSubmitInput) wacore.EngineRegisterResult {
	state, err := e.loadState(ctx, input.ClientProfileID)
	if err != nil {
		return wacore.EngineRegisterResult{Status: waappv1.RegistrationStatus_REGISTRATION_STATUS_REJECTED, Err: err}
	}
	if err := ensureNativeSoftwareAttestation(&state, e.clock.Now()); err != nil {
		return wacore.EngineRegisterResult{Status: waappv1.RegistrationStatus_REGISTRATION_STATUS_REJECTED, Err: err}
	}
	code := strings.TrimSpace(input.Code)
	if input.DeliveryMethod == waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_ACCOUNT_TRANSFER {
		code, _, err = state.AccountTransfer.currentCode(e.clock.Now())
		if err != nil {
			return wacore.EngineRegisterResult{Status: waappv1.RegistrationStatus_REGISTRATION_STATUS_REJECTED, Err: err}
		}
	}
	if code == "" {
		return wacore.EngineRegisterResult{Status: waappv1.RegistrationStatus_REGISTRATION_STATUS_REJECTED, Err: shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "verification code is required", false)}
	}
	params, err := e.registerOrderedParams(ctx, input.Phone, input.DeliveryMethod, code, state, input.AuthCodeContext, input.AppVersion, input.IntegrityMode)
	if err != nil {
		return wacore.EngineRegisterResult{Status: waappv1.RegistrationStatus_REGISTRATION_STATUS_REJECTED, Err: err}
	}
	logNativeRegistrationOrderedShape("register", input.Phone, input.DeliveryMethod, params)
	plain := params.render()
	client, err := e.httpForProxy()
	if err != nil {
		return wacore.EngineRegisterResult{Status: waappv1.RegistrationStatus_REGISTRATION_STATUS_REJECTED, Err: err}
	}
	data, enc, err := postRegisterWithRetry(ctx, client, plain, nativeUserAgentForState(state, input.AppVersion), state.Attestation)
	state.LastRegister = sanitizeResponse(data)
	if routingInfo := chatRoutingInfoFromValue(data["edge_routing_info"]); routingInfo != "" {
		state.ChatRoutingInfo = routingInfo
	}
	if enc != "" {
		state.LastRegister["enc_sha256"] = encHash(enc)
	}
	if err != nil {
		_ = e.SaveState(ctx, input.ClientProfileID, state)
		return wacore.EngineRegisterResult{Status: waappv1.RegistrationStatus_REGISTRATION_STATUS_REJECTED, Err: classifyHTTPError(data, err)}
	}
	if status := responseStatus(data); status != "ok" && status != "registered" {
		if input.DeliveryMethod == waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_ACCOUNT_TRANSFER && !accountTransferRegisterTerminalFailure(data) {
			_ = e.SaveState(ctx, input.ClientProfileID, state)
			return wacore.EngineRegisterResult{Status: waappv1.RegistrationStatus_REGISTRATION_STATUS_SUBMITTED, Err: shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_CONFLICT, "account transfer confirmation is pending", true)}
		}
		if input.DeliveryMethod == waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_ACCOUNT_TRANSFER {
			state.AccountTransfer = nativeAccountTransferState{}
		}
		_ = e.SaveState(ctx, input.ClientProfileID, state)
		return wacore.EngineRegisterResult{Status: waappv1.RegistrationStatus_REGISTRATION_STATUS_REJECTED, Err: waProtocolError(data, "registration was rejected")}
	}
	login := shared.FirstNonEmpty(jsonString(data["login"]), jsonString(data["jid"]), jsonString(data["registration_jid"]), state.CC+state.Phone)
	lid := shared.FirstNonEmpty(jsonString(data["lid"]), login)
	if login != "" {
		state.RegistrationJID = normalizeJID(login)
	}
	if input.DeliveryMethod == waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_ACCOUNT_TRANSFER {
		state.AccountTransfer = nativeAccountTransferState{}
	}
	_ = e.SaveState(ctx, input.ClientProfileID, state)
	completedAt := e.clock.Now()
	return wacore.EngineRegisterResult{Status: waappv1.RegistrationStatus_REGISTRATION_STATUS_REGISTERED, RegisteredID: "waid_" + shared.StableID(login), ServiceAccountID: lid, ServiceLoginID: login, CompletedAt: completedAt}
}

func postRegisterWithRetry(ctx context.Context, client *nativeHTTPClient, plain string, userAgent string, attestation nativeSoftwareAttestation) (map[string]any, string, error) {
	const maxRegisterRetries = 2
	data, enc, err := client.postWASafe(ctx, defaultWARegisterURL, plain, userAgent, attestation)
	for attempt := 1; err != nil && retryableRegisterHTTPFailure(data, err) && attempt <= maxRegisterRetries; attempt++ {
		log.Printf(
			"wa_registration_register_retry status=scheduled attempt=%d http_status=%d wa_status=%s wa_reason=%s",
			attempt,
			int(jsonNumber(data["status_code"])),
			shared.ProbeLogValue(responseStatus(data)),
			shared.ProbeLogValue(responseReason(data)),
		)
		if ctxErr := ctx.Err(); ctxErr != nil {
			return data, enc, ctxErr
		}
		data, enc, err = client.postWASafe(ctx, defaultWARegisterURL, plain, userAgent, attestation)
		if err == nil {
			log.Printf(
				"wa_registration_register_retry status=accepted attempt=%d http_status=%d wa_status=%s wa_reason=%s",
				attempt,
				int(jsonNumber(data["status_code"])),
				shared.ProbeLogValue(responseStatus(data)),
				shared.ProbeLogValue(responseReason(data)),
			)
		} else {
			log.Printf(
				"wa_registration_register_retry status=failed attempt=%d http_status=%d wa_status=%s wa_reason=%s retryable=%t",
				attempt,
				int(jsonNumber(data["status_code"])),
				shared.ProbeLogValue(responseStatus(data)),
				shared.ProbeLogValue(responseReason(data)),
				retryableRegisterHTTPFailure(data, err),
			)
		}
	}
	return data, enc, err
}

func retryableRegisterHTTPFailure(data map[string]any, err error) bool {
	if err == nil {
		return false
	}
	statusCode := int(jsonNumber(data["status_code"]))
	if statusCode == 429 || statusCode >= 500 {
		return true
	}
	if statusCode > 0 {
		return false
	}
	message := strings.ToLower(err.Error())
	for _, marker := range []string{"timeout", "deadline", "temporary", "connection reset", "connection refused", "eof", "proxy", "network"} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

func (e *registrationService) CheckLoginState(ctx context.Context, input wacore.EngineLoginCheckInput) wacore.EngineLoginCheckResult {
	state, err := e.loadState(ctx, input.ClientProfileID)
	if err != nil {
		return wacore.EngineLoginCheckResult{Status: waappv1.LoginStateCheckStatus_LOGIN_STATE_CHECK_STATUS_INVALID, Err: err}
	}
	proxyURL, err := e.proxyURL()
	if err != nil {
		return wacore.EngineLoginCheckResult{Status: waappv1.LoginStateCheckStatus_LOGIN_STATE_CHECK_STATUS_UNSPECIFIED, Err: err}
	}
	timeout := defaultChatdReadWindow
	if input.RemoteTimeout > 0 {
		timeout = input.RemoteTimeout
	}
	client := newChatdClient(chatdConfigForState(proxyURL, state, timeout))
	update, err := client.checkLoginState(ctx, state, input, input.AppVersion)
	if applyChatdSessionUpdateState(&state, update) {
		_ = e.SaveState(ctx, input.ClientProfileID, state)
	}
	if err != nil {
		status := loginCheckStatusForError(err)
		message := chatdFailureMessage("login state remote check failed", err)
		return wacore.EngineLoginCheckResult{Status: status, Err: shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, message, status == waappv1.LoginStateCheckStatus_LOGIN_STATE_CHECK_STATUS_UNREACHABLE)}
	}
	return wacore.EngineLoginCheckResult{Status: waappv1.LoginStateCheckStatus_LOGIN_STATE_CHECK_STATUS_ACTIVE}
}

func loginCheckStatusForError(err error) waappv1.LoginStateCheckStatus {
	if err == nil {
		return waappv1.LoginStateCheckStatus_LOGIN_STATE_CHECK_STATUS_ACTIVE
	}
	lower := strings.ToLower(err.Error())
	for _, marker := range []string{"timeout", "deadline", "proxy", "dial", "connect", "network", "tls", "no such host", "connection refused", "temporary"} {
		if strings.Contains(lower, marker) {
			return waappv1.LoginStateCheckStatus_LOGIN_STATE_CHECK_STATUS_UNREACHABLE
		}
	}
	return waappv1.LoginStateCheckStatus_LOGIN_STATE_CHECK_STATUS_INVALID
}

func (e *messagingService) ReceiveMessageBatch(ctx context.Context, input wacore.EngineMessageInput) wacore.EngineMessageBatchResult {
	state, err := e.loadState(ctx, input.ClientProfileID)
	if err != nil {
		return wacore.EngineMessageBatchResult{Err: err}
	}
	state.ensureMaps()
	if state.ChatStatic.Private == "" || state.ChatStatic.Public == "" {
		state.ChatStatic = ensureChatStatic(state.ChatStatic)
		_ = e.SaveState(ctx, input.ClientProfileID, state)
	}
	proxyURL, err := e.proxyURL()
	if err != nil {
		return wacore.EngineMessageBatchResult{Err: err}
	}
	client := newChatdClient(chatdConfigForState(proxyURL, state, 0))
	now := e.clock.Now()
	messages, payloads, otps, update, err := client.receiveBatch(ctx, state, input, input.AppVersion, now)
	if err != nil {
		return wacore.EngineMessageBatchResult{Err: chatdReceiveError(err)}
	}
	if applyChatdReceiveState(&state, input, payloads, update) {
		_ = e.SaveState(ctx, input.ClientProfileID, state)
	}
	return wacore.EngineMessageBatchResult{Messages: messages, Contacts: wamodel.ContactsFromContactHints(input.WAAccountID, nil, update.ContactHints, now), OTPMessages: otps, AccountLogout: accountLogoutFromUpdate(update.AccountLogout)}
}

func applyChatdReceiveState(state *NativeState, input wacore.EngineMessageInput, payloads []chatdEncPayload, update chatdSessionUpdate) bool {
	if state == nil {
		return false
	}
	changed := false
	state.ensureMaps()
	for _, payload := range payloads {
		ref := payloadRefForEnc(input.WAAccountID, payload.Payload)
		state.MessagePayloads[ref] = nativeMessagePayload{
			Contact:             payload.Contact,
			Sender:              payload.Sender,
			ContactPN:           payload.ContactPN,
			SenderPN:            payload.SenderPN,
			NotifyName:          payload.NotifyName,
			ParticipantUsername: payload.ParticipantUsername,
			ContactHints:        dedupeWAContactHints(payload.ContactHints),
			EncType:             payload.EncType,
			Path:                payload.Path,
			Payload:             b64u(payload.Payload),
		}
		changed = true
	}
	if len(update.ContactHints) > 0 {
		state.ContactHints = dedupeWAContactHints(append(state.ContactHints, update.ContactHints...))
		changed = true
	}
	if applyChatdSessionUpdateState(state, update) {
		changed = true
	}
	return changed
}

func applyChatdSessionUpdateState(state *NativeState, update chatdSessionUpdate) bool {
	changed := false
	if applyChatdConnectionState(state, update) {
		changed = true
	}
	if applyPrivacyTokenUpdates(state, update.PrivacyTokens) {
		changed = true
	}
	return changed
}

func mergeChatdSessionUpdate(current chatdSessionUpdate, next chatdSessionUpdate) chatdSessionUpdate {
	if next.RoutingInfo != "" {
		current.RoutingInfo = next.RoutingInfo
	}
	if next.Endpoint.Host != "" {
		current.Endpoint = next.Endpoint
	}
	if next.ServerStaticPublic != "" {
		current.ServerStaticPublic = next.ServerStaticPublic
	}
	if len(next.ContactHints) > 0 {
		current.ContactHints = append(current.ContactHints, next.ContactHints...)
	}
	if len(next.PrivacyTokens) > 0 {
		current.PrivacyTokens = dedupePrivacyTokenUpdates(append(current.PrivacyTokens, next.PrivacyTokens...))
	}
	if next.AccountLogout != nil {
		current.AccountLogout = next.AccountLogout
	}
	return current
}

func hasChatdSessionUpdate(update chatdSessionUpdate) bool {
	return update.RoutingInfo != "" || update.Endpoint.Host != "" || update.ServerStaticPublic != "" || len(update.ContactHints) > 0 || len(update.PrivacyTokens) > 0 || update.AccountLogout != nil
}

func applyChatdConnectionState(state *NativeState, update chatdSessionUpdate) bool {
	if state == nil {
		return false
	}
	changed := false
	if update.RoutingInfo != "" && state.ChatRoutingInfo != update.RoutingInfo {
		state.ChatRoutingInfo = update.RoutingInfo
		changed = true
	}
	if update.Endpoint.Host != "" && (state.ChatConnection.LastHost != update.Endpoint.Host || state.ChatConnection.LastPort != update.Endpoint.Port) {
		state.ChatConnection.LastHost = update.Endpoint.Host
		state.ChatConnection.LastPort = update.Endpoint.Port
		changed = true
	}
	if update.ServerStaticPublic != "" && state.ChatConnection.ServerStaticPublic != update.ServerStaticPublic {
		state.ChatConnection.ServerStaticPublic = update.ServerStaticPublic
		changed = true
	}
	return changed
}

func chatRoutingInfoFromValue(value any) string {
	switch typed := value.(type) {
	case []byte:
		if len(typed) == 0 || len(typed) > 256 {
			return ""
		}
		return b64u(typed)
	case string:
		return normalizeChatRoutingInfo(typed)
	default:
		return ""
	}
}

// chatdFailureMessage appends any redacted chatd failure snippet to base.
func chatdFailureMessage(base string, err error) string {
	if snippet := chatdSafeFailureMessage(err); snippet != "" {
		return base + ": " + snippet
	}
	return base
}

func chatdReceiveError(err error) error {
	message := chatdFailureMessage("native chatd receive failed", err)
	// 账号被接管(device_removed/replaced)是不可重试的登出终态(号码已在其他设备注册),透传为
	// CONFLICT 并保留标记,使长连接据此持久化"已转出"而非无限重连;其余 chatd 收包失败仍为可重试 REJECTED。
	if IsAccountTakeoverError(err) {
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_CONFLICT, chatdAccountTakeoverMarker+" "+message, false)
	}
	return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, message, true)
}

func chatdSafeFailureMessage(err error) string {
	if err == nil {
		return ""
	}
	text := strings.ToLower(err.Error())
	phase := chatdFailurePhase(text)
	reason := chatdFailureReason(text)
	switch {
	case phase != "" && reason != "":
		return phase + ": " + reason
	case phase != "":
		return phase
	default:
		return SafeResponseSnippet(upstreamFailureMessage(nil, err))
	}
}

func chatdFailurePhase(text string) string {
	for _, phase := range []string{
		"prepare chatd static identity",
		"resolve chatd login identity",
		"decode chatd routing info",
		"chatd dial",
		"chatd encode routing info",
		"chatd write routing info",
		"chatd write noise prologue",
		"chatd flush noise prologue",
		"chatd generate ephemeral",
		"chatd write client hello",
		"chatd read server hello",
		"chatd parse server hello",
		"chatd mix ee",
		"chatd decrypt server static",
		"chatd mix es",
		"chatd decrypt server payload",
		"chatd encrypt client static",
		"chatd mix se",
		"chatd encrypt login payload",
		"chatd write client finish",
		"chatd noise handshake",
		"chatd ping write",
		"chatd frame read",
		"chatd ack write",
		"chatd iq write",
		"chatd iq read",
		"chatd message write",
		"chatd message read",
	} {
		if strings.Contains(text, phase) {
			return phase + " failed"
		}
	}
	return ""
}

func chatdFailureReason(text string) string {
	switch {
	case strings.Contains(text, "connection reset by peer"):
		return "connection reset by peer"
	case strings.Contains(text, "eof"):
		return "EOF"
	case strings.Contains(text, "i/o timeout") || strings.Contains(text, "deadline") || strings.Contains(text, "timeout"):
		return "timeout"
	case strings.Contains(text, "server returned goa"):
		return "server returned GOA"
	case strings.Contains(text, "message authentication failed") || strings.Contains(text, "authentication failed") || strings.Contains(text, "cipher"):
		return "decrypt authentication failed"
	case strings.Contains(text, "invalid list-size token"):
		return chatdNodeTokenFailureReason(text, "invalid list-size token")
	case strings.Contains(text, "readstring could not match token"):
		return chatdNodeTokenFailureReason(text, "unsupported node string token")
	case strings.Contains(text, "unexpected end of binary node"):
		return "unexpected end of binary node"
	case strings.Contains(text, "truncated"):
		return "truncated binary node"
	case strings.Contains(text, "fragmented stanza"):
		return "fragmented stanza"
	case strings.Contains(text, "zlib") || strings.Contains(text, "flate"):
		return "compressed stanza decode failed"
	case strings.Contains(text, "server static public length"):
		return "invalid server static"
	case strings.Contains(text, "server ephemeral length"):
		return "invalid server ephemeral"
	case strings.Contains(text, "no such host"):
		return "DNS lookup failed"
	case strings.Contains(text, "socks5 connect failed"):
		return "SOCKS5 connect failed"
	case strings.Contains(text, "proxy rejected"):
		return "proxy rejected"
	case strings.Contains(text, "tls"):
		return "TLS handshake failed"
	default:
		return ""
	}
}

func chatdNodeTokenFailureReason(text string, fallback string) string {
	match := chatdNodeTokenErrorPattern.FindStringSubmatch(text)
	if len(match) < 3 {
		return fallback
	}
	return fallback + " " + match[2]
}

func (e *messagingService) DecryptMessage(ctx context.Context, input wacore.EngineDecryptInput) wacore.EngineDecryptResult {
	_ = ctx
	if strings.HasPrefix(input.PayloadRef, "plaintext:") {
		plain := strings.TrimPrefix(input.PayloadRef, "plaintext:")
		decryptedID := e.ids.NewID("wadec_")
		text := &waappv1.SensitiveText{RedactedValue: shared.Redacted(plain), SecretRef: "plaintext:" + decryptedID}
		if input.IncludePlaintextText {
			text.Value = plain
		}
		msg := &waappv1.DecryptedMessage{DecryptedMessageId: decryptedID, MessageId: input.MessageID, Status: waappv1.DecryptionStatus_DECRYPTION_STATUS_DECRYPTED, PlaintextRef: "inline:" + decryptedID, PlaintextText: text, DecryptedAt: timestamppb.New(e.clock.Now())}
		return wacore.EngineDecryptResult{DecryptedMessage: msg, Candidates: extractCandidates(input.MessageID, decryptedID, plain, input.IncludePlaintextText, e.clock.Now(), e.ids)}
	}
	if strings.HasPrefix(input.PayloadRef, "native-enc:") {
		state, err := e.loadState(ctx, input.ClientProfileID)
		if err != nil {
			return wacore.EngineDecryptResult{Err: err}
		}
		payload, ok := state.MessagePayloads[input.PayloadRef]
		if !ok {
			return wacore.EngineDecryptResult{Err: shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND, "encrypted message payload ref not found", false)}
		}
		commit := input.SessionCommitPolicy == waappv1.SessionCommitPolicy_SESSION_COMMIT_POLICY_COMMIT_LEARNED_STATE
		output, err := decryptNativeSignalPayload(&state, payload, commit)
		if err != nil {
			return wacore.EngineDecryptResult{Err: shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_DECRYPTION_FAILED, "native Signal message decryption failed", true)}
		}
		decryptedID := e.ids.NewID("wadec_")
		plaintextRef := "native-plain:" + decryptedID
		if commit {
			_ = applyNativeAppStateKeys(&state, output.plaintext)
			state.ensureMaps()
			state.MessagePlainRef[plaintextRef] = base64.StdEncoding.EncodeToString(output.plaintext)
			_ = e.SaveState(ctx, input.ClientProfileID, state)
		}
		plain := nativePlaintextText(output.plaintext)
		text := &waappv1.SensitiveText{RedactedValue: shared.Redacted(plain), SecretRef: plaintextRef}
		if input.IncludePlaintextText {
			text.Value = plain
		}
		msg := &waappv1.DecryptedMessage{DecryptedMessageId: decryptedID, MessageId: input.MessageID, Status: waappv1.DecryptionStatus_DECRYPTION_STATUS_DECRYPTED, PlaintextRef: plaintextRef, PlaintextText: text, DecryptedAt: timestamppb.New(e.clock.Now())}
		contactHints := nativeContactHints(output.plaintext)
		contactHints = append(contactHints, nativeAppStateContactHints(&state, output.plaintext)...)
		contactHints = append(contactHints, contactHintsFromNativePayloadMetadata(payload)...)
		return wacore.EngineDecryptResult{DecryptedMessage: msg, Candidates: extractCandidates(input.MessageID, decryptedID, plain, input.IncludePlaintextText, e.clock.Now(), e.ids), ContactHints: dedupeWAContactHints(contactHints)}
	}
	return wacore.EngineDecryptResult{Err: shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_UNSUPPORTED_OPERATION, "payload ref scheme is not supported by native decryptor", false)}
}

func nativePlaintextText(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	if text, ok := waproto.MessageDisplayText(raw); ok {
		return text
	}
	plain := string(raw)
	if text := waproto.WAJSONDisplayText(plain); text != "" {
		return text
	}
	if waproto.ReadableText(plain) {
		return strings.TrimSpace(plain)
	}
	return waproto.PrintableDisplayText(raw)
}

func omitEmptyNativeOperatorField(key string, value string) bool {
	if strings.TrimSpace(value) != "" {
		return false
	}
	switch key {
	case "mcc", "mnc", "sim_mcc", "sim_mnc":
		return true
	default:
		return false
	}
}

func (e *engineCore) loadState(ctx context.Context, clientProfileID string) (NativeState, error) {
	data, err := e.stateStore.GetNativeState(ctx, clientProfileID)
	if err != nil {
		return NativeState{}, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_PROFILE_NOT_FOUND, "native client profile state not found", false)
	}
	state, err := UnmarshalNativeState(data)
	if err != nil {
		return NativeState{}, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_PROFILE_NOT_FOUND, "native client profile state not found", false)
	}
	return state, nil
}

func (e *engineCore) NewState(phone *waappv1.PhoneTarget) (NativeState, error) {
	return newNativeState(phone)
}

func (e *engineCore) SaveState(ctx context.Context, clientProfileID string, state NativeState) error {
	data, err := MarshalNativeState(state)
	if err != nil {
		return err
	}
	return e.stateStore.SaveNativeState(ctx, clientProfileID, data)
}

func sanitizeResponse(data map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range data {
		lower := strings.ToLower(key)
		if strings.Contains(lower, "token") || strings.Contains(lower, "key") || strings.Contains(lower, "auth") || strings.Contains(lower, "code") || strings.Contains(lower, "sig") || strings.Contains(lower, "routing") {
			out[key] = "<redacted>"
			continue
		}
		if lower == "response_text" {
			out[key] = SafeResponseSnippet(jsonString(value))
			continue
		}
		out[key] = value
	}
	return out
}

func verificationCodeResult(status waappv1.VerificationRequestStatus, data map[string]any, method waappv1.VerificationDeliveryMethod, now time.Time, retryAfter time.Duration) wacore.EngineCodeResult {
	return wacore.EngineCodeResult{
		Status:             status,
		ExpectedCodeLength: int32(jsonNumber(data["length"])),
		ExpiresAt:          now.Add(10 * time.Minute),
		RetryAfter:         retryAfter,
		MethodStatuses:     verificationCodeMethodStatuses(data, method),
		RawStatus:          responseStatus(data),
		RawReason:          responseReason(data),
	}
}

func verificationCodeRejectedResult(data map[string]any, method waappv1.VerificationDeliveryMethod, now time.Time, retryAfter time.Duration, fallback string) wacore.EngineCodeResult {
	return wacore.EngineCodeResult{
		Status:             waappv1.VerificationRequestStatus_VERIFICATION_REQUEST_STATUS_REJECTED,
		ExpectedCodeLength: int32(jsonNumber(data["length"])),
		ExpiresAt:          now.Add(10 * time.Minute),
		RetryAfter:         retryAfter,
		MethodStatuses:     verificationCodeMethodStatuses(data, method),
		RawStatus:          responseStatus(data),
		RawReason:          responseReason(data),
		Err:                waProtocolError(data, fallback),
	}
}

func verificationCodeRateLimited(data map[string]any) bool {
	switch responseStatus(data) {
	case "too_recent", "too_many", "temporarily_unavailable":
		return true
	}
	switch responseReason(data) {
	case "too_recent", "too_many", "temporarily_unavailable":
		return true
	default:
		return false
	}
}

func verificationCodeRetryAfter(data map[string]any, method waappv1.VerificationDeliveryMethod) time.Duration {
	seconds := verificationMethodWaitStatus(data, RegistrationMethodName(method, "sms"), true).Seconds
	if seconds <= 0 {
		return 0
	}
	return time.Duration(seconds) * time.Second
}

func classifyHTTPError(data map[string]any, err error) error {
	status := responseStatus(data)
	switch status {
	case "no_routes":
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_ROUTE_UNAVAILABLE, "no_routes: verification route is unavailable", false)
	case "too_recent":
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_RATE_LIMITED, "verification request is too recent", true)
	case "blocked", "rejected":
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, status+": request was rejected", false)
	}
	return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, upstreamFailureMessage(data, err), true)
}

func jsonString(value any) string {
	if s, ok := value.(string); ok {
		return s
	}
	return ""
}

func upstreamFailureMessage(data map[string]any, err error) string {
	if statusCode := jsonNumber(data["status_code"]); statusCode > 0 {
		if snippet := SafeResponseSnippet(jsonString(data["response_text"])); snippet != "" {
			return fmt.Sprintf("wasafe upstream http %d: %s", statusCode, snippet)
		}
		return fmt.Sprintf("wasafe upstream http %d", statusCode)
	}
	return err.Error()
}

func SafeResponseSnippet(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if text == "" {
		return ""
	}
	text = waproto.SensitiveDigitsPattern.ReplaceAllString(text, "<digits>")
	for _, marker := range []string{"token", "auth", "key", "code", "sig"} {
		if strings.Contains(strings.ToLower(text), marker) {
			return "<redacted>"
		}
	}
	if utf8.RuneCountInString(text) <= 160 {
		return text
	}
	out := make([]rune, 0, 160)
	for _, ch := range text {
		if len(out) >= 160 {
			break
		}
		out = append(out, ch)
	}
	return string(out) + "..."
}

func jsonNumber(value any) int {
	switch v := value.(type) {
	case float64:
		return int(v)
	case int:
		return v
	case json.Number:
		n, _ := v.Int64()
		return int(n)
	default:
		return 0
	}
}

func extractCandidates(messageID string, decryptedID string, text string, includeValue bool, now time.Time, ids shared.IDGenerator) []*waappv1.ExtractedCandidate {
	if strings.TrimSpace(text) == "" {
		return nil
	}
	patterns := []struct {
		kind      waappv1.CandidateKind
		re        *regexp.Regexp
		normalize func(string) string
	}{
		{kind: waappv1.CandidateKind_CANDIDATE_KIND_FLAG, re: regexp.MustCompile(`(?i)(flag|ctf)\{[^\s}]{1,120}\}`)},
		{kind: waappv1.CandidateKind_CANDIDATE_KIND_OTP, re: regexp.MustCompile(`\b\d{4,8}\b`), normalize: shared.DigitsOnly},
		{kind: waappv1.CandidateKind_CANDIDATE_KIND_OTP, re: regexp.MustCompile(`\b\d{3}[-\s]\d{3}\b`), normalize: shared.DigitsOnly},
	}
	out := []*waappv1.ExtractedCandidate{}
	seen := map[string]struct{}{}
	for _, pattern := range patterns {
		for _, match := range pattern.re.FindAllString(text, -1) {
			value := match
			if pattern.normalize != nil {
				value = pattern.normalize(match)
			}
			if value == "" {
				continue
			}
			key := pattern.kind.String() + ":" + value
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			candidateID := ids.NewID("wacand_")
			sensitive := &waappv1.SensitiveText{RedactedValue: shared.Redacted(value), SecretRef: "candidate:" + candidateID}
			if includeValue {
				sensitive.Value = value
			}
			out = append(out, &waappv1.ExtractedCandidate{CandidateId: candidateID, MessageId: messageID, DecryptedMessageId: decryptedID, Kind: pattern.kind, Text: sensitive, Confidence: 0.9, ExtractedAt: timestamppb.New(now)})
		}
	}
	return out
}
