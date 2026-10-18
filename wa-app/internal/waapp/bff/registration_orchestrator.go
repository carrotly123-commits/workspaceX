package bff

import (
	"context"
	"log"
	"strings"
	"time"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/engine"
	"github.com/byte-v-forge/wa-app/internal/waapp/rpc"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
	"github.com/byte-v-forge/wa-app/internal/waapp/wamodel"
)

// StartRegistration is the dashboard registration entry point; it drives the
// multi-step orchestration on a fresh action gateway bound to the given server.
func StartRegistration(server *rpc.Server, ctx context.Context, payload map[string]any) (map[string]any, error) {
	return (&actionGateway{server: server}).startRegistration(ctx, payload)
}

func (g *actionGateway) startRegistration(ctx context.Context, payload map[string]any) (map[string]any, error) {
	if g == nil || g.server == nil {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_UNSUPPORTED_OPERATION, "wa-app service is not configured", false)
	}
	if payload == nil {
		payload = map[string]any{}
	}
	basePayload := cloneActionPayload(payload)
	basePayload["purpose"] = shared.FirstNonEmpty(shared.TextField(basePayload, "purpose"), "WA_REGISTRATION")
	basePayload["proxy_session_mode"] = shared.FirstNonEmpty(shared.TextField(basePayload, "proxy_session_mode"), "STICKY")
	method := registrationMethodFromPayload(basePayload)
	authCodeContext := authCodeContextFromPayload(basePayload)
	integrityMode := engine.NativeIntegrityModeFromPayload(basePayload)
	if reason := directRegistrationMethodUnsupportedReason(method); reason != "" {
		return rejectedRegistrationResult(basePayload, registrationMethodUnsupportedMap(method, reason)), nil
	}
	phone := wamodel.NormalizePhone(phoneFromAction(basePayload))
	state, stateRef, reusedState, err := g.registrationAttemptState(ctx, phone)
	if err != nil {
		return nil, err
	}
	logRegistrationAttemptState(basePayload, phone, reusedState)
	runner, route, managedRoute, err := g.registrationRunner(basePayload)
	if err != nil {
		return nil, err
	}
	defer runner.CloseIdleConnections()
	probeResult, state := runner.ProbeAccountWithState(ctx, wacore.EngineRegistrationInput{AppVersion: engine.DefaultWAAppVersion, Phone: phone, DeliveryMethod: method, AuthCodeContext: authCodeContext, IntegrityMode: integrityMode}, state)
	_ = g.saveRegistrationAttemptState(context.Background(), stateRef, state)
	logRegistrationProbeResult(basePayload, phone, route, method, probeResult)
	if !registrationProbeAllowsMethod(probeResult, method) {
		return rejectedRegistrationResult(basePayload, registrationProbeFailureMap(probeResult, route, managedRoute)), nil
	}
	codeResult, method, updatedState := g.requestVerificationCodeWithFallback(ctx, runner, phone, method, authCodeContext, integrityMode, state, stateRef)
	logRegistrationCodeResult(basePayload, phone, route, method, codeResult)
	if !verificationCodeRequestAccepted(codeResult) {
		return rejectedRegistrationResult(basePayload, registrationRequestFailureMap(codeResult, method, route, managedRoute)), nil
	}
	account, profile, protocol, err := g.commitNativeState(ctx, phone, updatedState)
	if err != nil {
		return nil, err
	}
	record := g.server.NewVerificationCodeRequestRecord(account, profile, method, codeResult)
	challenge := codeResult.AccountTransferChallenge
	if challenge != nil {
		challenge.VerificationRequestId = record.GetVerificationRequestId()
	}
	if err := g.server.Store().SaveVerificationRequest(ctx, record); err != nil {
		_ = g.discardRejectedRegistration(context.Background(), basePayload, wamodel.WAAccountID(account), record.GetVerificationRequestId())
		return nil, err
	}
	verificationRequestID := record.GetVerificationRequestId()
	wait := wamodel.RegistrationOTPWait{
		WAAccountID:           wamodel.WAAccountID(account),
		VerificationRequestID: verificationRequestID,
		CreatedAtUnix:         time.Now().UTC().Unix(),
	}
	if err := g.saveRegistrationOTPWait(ctx, wait, registrationOTPWaitDefaultTTL); err != nil {
		_ = g.discardRejectedRegistration(context.Background(), basePayload, wamodel.WAAccountID(account), verificationRequestID)
		return nil, err
	}
	_ = g.server.Runtime().DeleteTransientState(context.Background(), stateRef)
	response := map[string]any{
		"success":                 true,
		"status":                  record.GetStatus().String(),
		"error_message":           "",
		"phone":                   shared.ObjectField(basePayload, "phone"),
		"wa_account_id":           wamodel.WAAccountID(account),
		"client_profile_id":       profile.GetClientProfileId(),
		"protocol_profile_id":     protocol.GetProtocolProfileId(),
		"verification_request_id": verificationRequestID,
		"verification_request":    protoMap(record),
		"delivery_method":         method.String(),
		"method":                  engine.RegistrationMethodName(method, "sms"),
		"method_statuses":         methodStatusMaps(codeResult.MethodStatuses),
		"registration_phase":      registrationPhase(true, verificationRequestID, shared.DurationFromProto(record.GetRetryAfter())),
		"fingerprint_persistence": "COMMITTED",
		"persisted":               true,
		"phone_status":            registrationCodeResultPhoneStatus(codeResult, method, false),
		"proxy":                   registrationOrchestratorProxySummary(registrationProxyRouteMap(route, managedRoute)),
	}
	if challenge != nil {
		response["account_transfer_challenge"] = protoMap(challenge)
		response["registration_phase"] = "ACCOUNT_TRANSFER_WAITING"
	}
	if seconds := shared.DurationSeconds(record.GetRetryAfter()); seconds > 0 {
		response["retry_after_seconds"] = seconds
	}
	return response, nil
}

func (g *actionGateway) registrationAttemptState(ctx context.Context, phone *waappv1.PhoneTarget) (engine.NativeState, string, bool, error) {
	ref := registrationAttemptStateKey(phone)
	if data, err := g.server.Runtime().GetTransientState(ctx, ref); err == nil {
		state, err := engine.UnmarshalNativeState(data)
		if err == nil {
			return state, ref, true, nil
		}
		_ = g.server.Runtime().DeleteTransientState(ctx, ref)
	}
	nativeEngine, err := g.nativeEngine()
	if err != nil {
		return engine.NativeState{}, "", false, err
	}
	state, err := nativeEngine.NewState(phone)
	if err != nil {
		return engine.NativeState{}, "", false, err
	}
	if err := g.saveRegistrationAttemptState(ctx, ref, state); err != nil {
		return engine.NativeState{}, "", false, err
	}
	return state, ref, false, nil
}

func (g *actionGateway) saveRegistrationAttemptState(ctx context.Context, ref string, state engine.NativeState) error {
	data, err := engine.MarshalNativeState(state)
	if err != nil {
		return err
	}
	return g.server.Runtime().SaveTransientState(ctx, ref, data, registrationAttemptStateTTL)
}

func registrationAttemptStateKey(phone *waappv1.PhoneTarget) string {
	return "wa-register-state:" + shared.StableID(shared.FirstNonEmpty(phone.GetE164Number(), engine.FullPhoneKey(shared.PhoneCC(phone), shared.PhoneNational(phone))))
}

func logRegistrationAttemptState(payload map[string]any, phone *waappv1.PhoneTarget, reused bool) {
	phoneHash := ""
	if phone != nil && phone.GetE164Number() != "" {
		phoneHash = shared.StableID(phone.GetE164Number())
	}
	log.Printf(
		"wa_registration_attempt_state correlation=%s phone_hash=%s reused=%t ttl_seconds=%d",
		shared.ProbeLogValue(actionContext(payload).GetCorrelationId()),
		phoneHash,
		reused,
		int64(registrationAttemptStateTTL/time.Second),
	)
}

func logRegistrationCodeResult(payload map[string]any, phone *waappv1.PhoneTarget, route wacore.WAProxyRoute, method waappv1.VerificationDeliveryMethod, result wacore.EngineCodeResult) {
	phoneHash := ""
	if phone != nil && phone.GetE164Number() != "" {
		phoneHash = shared.StableID(phone.GetE164Number())
	}
	protoErr := shared.ToProtoError(result.Err)
	log.Printf(
		"wa_registration_code_result correlation=%s phone_hash=%s proxy_account=%s route_id=%s accepted=%t method=%s status=%s raw_status=%s raw_reason=%s retry_after_seconds=%d method_status_count=%d error=%s",
		shared.ProbeLogValue(actionContext(payload).GetCorrelationId()),
		phoneHash,
		shared.ProbeLogValue(route.AccountID),
		shared.ProbeLogValue(route.RouteID),
		verificationCodeRequestAccepted(result),
		shared.ProbeLogValue(engine.RegistrationMethodName(method, "sms")),
		shared.ProbeLogValue(result.Status.String()),
		shared.ProbeLogValue(result.RawStatus),
		shared.ProbeLogValue(result.RawReason),
		int64(result.RetryAfter/time.Second),
		len(result.MethodStatuses),
		shared.ProbeLogValue(protoErr.GetMessage()),
	)
}

func logRegistrationProbeResult(payload map[string]any, phone *waappv1.PhoneTarget, route wacore.WAProxyRoute, method waappv1.VerificationDeliveryMethod, result wacore.EngineProbeResult) {
	phoneHash := ""
	if phone != nil && phone.GetE164Number() != "" {
		phoneHash = shared.StableID(phone.GetE164Number())
	}
	protoErr := shared.ToProtoError(result.Err)
	log.Printf(
		"wa_registration_probe_result correlation=%s phone_hash=%s proxy_account=%s route_id=%s allowed=%t method=%s account_flow=%s account_status=%s raw_status=%s raw_reason=%s sms_available=%t sms_wait_seconds=%d method_status_count=%d error=%s",
		shared.ProbeLogValue(actionContext(payload).GetCorrelationId()),
		phoneHash,
		shared.ProbeLogValue(route.AccountID),
		shared.ProbeLogValue(route.RouteID),
		registrationProbeAllowsMethod(result, method),
		shared.ProbeLogValue(engine.RegistrationMethodName(method, "sms")),
		shared.ProbeLogValue(result.AccountFlow),
		shared.ProbeLogValue(result.Status.String()),
		shared.ProbeLogValue(result.RawStatus),
		shared.ProbeLogValue(result.RawReason),
		result.CanSendSMS,
		result.SMSWaitSeconds,
		len(result.MethodStatuses),
		shared.ProbeLogValue(protoErr.GetMessage()),
	)
}

func authCodeContextFromPayload(payload map[string]any) string {
	return shared.FirstNonEmpty(
		shared.TextField(payload, "auth_code_context"),
		shared.TextField(payload, "authCodeContext"),
		shared.TextField(payload, "code_entrypoint"),
	)
}

func registrationMethodFromPayload(payload map[string]any) waappv1.VerificationDeliveryMethod {
	method := engine.VerificationMethodFromName(shared.FirstNonEmpty(
		shared.TextField(payload, "delivery_method"),
		shared.TextField(payload, "verification_method"),
		shared.TextField(payload, "method"),
	))
	if method == waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_UNSPECIFIED {
		return waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_SMS
	}
	return method
}

func directRegistrationMethodUnsupportedReason(method waappv1.VerificationDeliveryMethod) string {
	switch method {
	case waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_FLASH:
		return "flash call verification requires Android missed-call/call-log runtime"
	default:
		return ""
	}
}

func registrationMethodUnsupportedMap(method waappv1.VerificationDeliveryMethod, reason string) map[string]any {
	return map[string]any{
		"success":        false,
		"request_failed": true,
		"status":         "REGISTRATION_METHOD_UNSUPPORTED",
		"error_message":  reason,
		"reject_reason":  reason,
		"phone_status": map[string]any{
			"account_status":      waappv1.AccountProbeStatus_ACCOUNT_PROBE_STATUS_REJECTED.String(),
			"account_flow":        engine.AccountProbeFlowProbeFailed,
			"account_reachable":   false,
			"request_failed":      true,
			"sms_available":       false,
			"can_register":        false,
			"delivery_method":     method.String(),
			"registration_method": engine.RegistrationMethodName(method, ""),
			"reject_reason":       reason,
		},
	}
}

func cloneActionPayload(payload map[string]any) map[string]any {
	cloned := make(map[string]any, len(payload))
	for key, value := range payload {
		cloned[key] = value
	}
	return cloned
}

func registrationPhase(success bool, verificationRequestID string, retryAfter time.Duration) string {
	if !success || strings.TrimSpace(verificationRequestID) == "" {
		return "OTP_REQUEST_FAILED"
	}
	if retryAfter > 0 {
		return "OTP_COOLDOWN"
	}
	return "OTP_WAITING"
}

func verificationCodeRequestAccepted(result wacore.EngineCodeResult) bool {
	return result.Err == nil && (result.Status == waappv1.VerificationRequestStatus_VERIFICATION_REQUEST_STATUS_SENT || result.Status == waappv1.VerificationRequestStatus_VERIFICATION_REQUEST_STATUS_WAITING)
}

var registrationFallbackMethods = map[waappv1.VerificationDeliveryMethod]bool{
	waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_SMS:       true,
	waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_VOICE:     true,
	waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_WA_OLD:    true,
	waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_SEND_SMS:  true,
	waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_EMAIL_OTP: true,
}

// requestVerificationCodeWithFallback drives /v2/code for the requested method
// and, mirroring the APK registration flow, auto-switches to the next method the
// server lists in fallback_methods when the current method fails non-terminally
// (next_method, no_routes, provider timeout, cooldown). It stops on the first
// accepted request, a terminal rejection, or once no offered method remains.
func (g *actionGateway) requestVerificationCodeWithFallback(ctx context.Context, runner *engine.NativeEngine, phone *waappv1.PhoneTarget, requested waappv1.VerificationDeliveryMethod, authCodeContext string, integrityMode wacore.IntegrityMode, state engine.NativeState, stateRef string) (wacore.EngineCodeResult, waappv1.VerificationDeliveryMethod, engine.NativeState) {
	tried := map[waappv1.VerificationDeliveryMethod]bool{}
	current := requested
	currentState := state
	var result wacore.EngineCodeResult
	for {
		result, currentState = runner.RequestVerificationCodeWithState(ctx, wacore.EngineRegistrationInput{AppVersion: engine.DefaultWAAppVersion, Phone: phone, DeliveryMethod: current, AuthCodeContext: authCodeContext, IntegrityMode: integrityMode}, currentState)
		_ = g.saveRegistrationAttemptState(context.Background(), stateRef, currentState)
		tried[current] = true
		if verificationCodeRequestAccepted(result) || !codeFailureAllowsFallback(result) {
			return result, current, currentState
		}
		next, ok := nextFallbackMethod(result, tried)
		if !ok {
			return result, current, currentState
		}
		log.Printf(
			"wa_registration_method_fallback from=%s to=%s reason=%s",
			engine.RegistrationMethodName(current, ""),
			engine.RegistrationMethodName(next, ""),
			shared.ProbeLogValue(result.RawReason),
		)
		current = next
	}
}

// codeFailureAllowsFallback reports whether a failed /v2/code response is a
// non-terminal failure for which the APK would try another delivery method.
func codeFailureAllowsFallback(result wacore.EngineCodeResult) bool {
	switch strings.ToLower(strings.TrimSpace(result.RawReason)) {
	case "blocked", "format_wrong", "length_short", "length_long",
		"bad_param", "missing_param", "bad_token", "old_version", "invalid_skey",
		"security_code", "second_code", "device_confirm_or_second_code",
		"consent", "challenge", "challenge_email_start":
		return false
	default:
		return true
	}
}

// nextFallbackMethod picks the next untried delivery method the server offers as
// available (via fallback_methods) in the APK's default method order.
func nextFallbackMethod(result wacore.EngineCodeResult, tried map[waappv1.VerificationDeliveryMethod]bool) (waappv1.VerificationDeliveryMethod, bool) {
	for _, code := range engine.ApkDefaultRegistrationMethodOrder {
		method := engine.VerificationMethodFromName(code)
		if method == waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_UNSPECIFIED || tried[method] || !registrationFallbackMethods[method] {
			continue
		}
		if fallbackMethodAvailable(result.MethodStatuses, method) {
			return method, true
		}
	}
	return waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_UNSPECIFIED, false
}

func fallbackMethodAvailable(statuses []wacore.VerificationMethodStatus, method waappv1.VerificationDeliveryMethod) bool {
	for _, status := range statuses {
		if status.Method == method {
			return status.Available
		}
	}
	return false
}

func registrationProbeAllowsMethod(result wacore.EngineProbeResult, method waappv1.VerificationDeliveryMethod) bool {
	if result.Err != nil || result.Blocked ||
		result.AccountFlow == engine.AccountProbeFlowInvalidNumber ||
		result.AccountFlow == engine.AccountProbeFlowConsentRequired ||
		result.AccountFlow == engine.AccountProbeFlowChallengeRequired {
		return false
	}
	if method == waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_UNSPECIFIED ||
		method == waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_SMS {
		return registrationProbeMethodAvailable(result, waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_SMS) || result.CanSendSMS
	}
	if method == waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_ACCOUNT_TRANSFER {
		return result.Status == waappv1.AccountProbeStatus_ACCOUNT_PROBE_STATUS_REACHABLE &&
			(result.Registered || registrationProbeMethodAvailable(result, method) || registrationProbeMethodAvailable(result, waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_WA_OLD))
	}
	return registrationProbeMethodAvailable(result, method)
}

func registrationProbeMethodAvailable(result wacore.EngineProbeResult, method waappv1.VerificationDeliveryMethod) bool {
	for _, status := range result.MethodStatuses {
		if status.Method == method {
			return status.Available
		}
	}
	return result.Status == waappv1.AccountProbeStatus_ACCOUNT_PROBE_STATUS_REACHABLE && method == waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_SMS && result.CanSendSMS
}

func registrationRequestFailureMap(result wacore.EngineCodeResult, method waappv1.VerificationDeliveryMethod, route wacore.WAProxyRoute, managedRoute bool) map[string]any {
	err := result.Err
	if err == nil {
		err = registrationCodeRequestError(result)
	}
	protoErr := shared.ToProtoError(err)
	seconds := int64(result.RetryAfter / time.Second)
	accountFlow := registrationCodeRequestFlow(result, protoErr)
	response := map[string]any{
		"success":         false,
		"request_failed":  true,
		"status":          shared.FirstNonEmpty(result.Status.String(), "VERIFICATION_REQUEST_STATUS_REJECTED"),
		"error":           protoMap(protoErr),
		"error_message":   protoErr.GetMessage(),
		"reject_reason":   registrationRejectReason(protoErr.GetMessage()),
		"method_statuses": methodStatusMaps(result.MethodStatuses),
		"proxy":           registrationProxyRouteMap(route, managedRoute),
		"sms_probe": map[string]any{
			"status":              result.Status.String(),
			"raw_status":          result.RawStatus,
			"raw_reason":          result.RawReason,
			"retry_after_seconds": seconds,
			"method_statuses":     methodStatusMaps(result.MethodStatuses),
		},
		"phone_status": registrationCodeResultPhoneStatus(result, method, true),
	}
	phoneStatus := shared.ObjectField(response, "phone_status")
	phoneStatus["account_flow"] = accountFlow
	phoneStatus["account_error"] = protoErr.GetMessage()
	phoneStatus["blocked"] = accountFlow == engine.AccountProbeFlowBlocked
	phoneStatus["reject_reason"] = protoErr.GetMessage()
	if seconds > 0 {
		response["retry_after_seconds"] = seconds
		response["registration_phase"] = "OTP_COOLDOWN"
	}
	return response
}

func registrationCodeRequestError(result wacore.EngineCodeResult) error {
	switch {
	case result.RetryAfter > 0 || engine.ExistRateLimitedReason(result.RawReason):
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_RATE_LIMITED, "verification request is cooling down", true)
	case engine.ExistInvalidNumberReason(result.RawReason):
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, "verification request rejected: phone format is invalid", false)
	case strings.EqualFold(result.RawReason, "no_routes") || strings.EqualFold(result.RawStatus, "no_routes"):
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_ROUTE_UNAVAILABLE, "no_routes: verification route is unavailable", false)
	case strings.TrimSpace(result.RawReason) != "":
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, "verification request was rejected: reason="+result.RawReason, false)
	case strings.TrimSpace(result.RawStatus) != "":
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, "verification request was rejected: status="+result.RawStatus, false)
	default:
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, "verification request was rejected", false)
	}
}

func registrationCodeRequestFlow(result wacore.EngineCodeResult, protoErr *waappv1.WaError) string {
	raw := strings.ToLower(strings.TrimSpace(result.RawReason + " " + result.RawStatus + " " + protoErr.GetMessage()))
	switch {
	case engine.ExistInvalidNumberReason(raw) || strings.Contains(raw, "format_wrong") || strings.Contains(raw, "length_short") || strings.Contains(raw, "length_long"):
		return engine.AccountProbeFlowInvalidNumber
	case engine.ExistRateLimitedReason(raw) || strings.Contains(raw, "cooling down"):
		return engine.AccountProbeFlowRateLimited
	case strings.Contains(raw, "blocked"):
		return engine.AccountProbeFlowBlocked
	default:
		return engine.AccountProbeFlowProbeFailed
	}
}

func registrationProbeFailureMap(result wacore.EngineProbeResult, route wacore.WAProxyRoute, managedRoute bool) map[string]any {
	err := result.Err
	if err == nil {
		err = registrationProbeError(result)
	}
	protoErr := shared.ToProtoError(err)
	response := map[string]any{
		"success":         false,
		"status":          shared.FirstNonEmpty(result.Status.String(), "ACCOUNT_PROBE_STATUS_UNREACHABLE"),
		"error":           protoMap(protoErr),
		"error_message":   protoErr.GetMessage(),
		"method_statuses": methodStatusMaps(result.MethodStatuses),
		"proxy":           registrationProxyRouteMap(route, managedRoute),
		"phone_status": map[string]any{
			"account_status":     result.Status.String(),
			"account_flow":       result.AccountFlow,
			"account_raw_status": result.RawStatus,
			"account_raw_reason": result.RawReason,
			"blocked":            result.Blocked,
			"registered":         result.Registered,
			"sms_available":      result.CanSendSMS,
			"sms_status":         registrationProbeSMSStatus(result),
			"sms_wait_seconds":   result.SMSWaitSeconds,
			"supported_methods":  enumNames(result.SupportedMethods),
			"method_statuses":    methodStatusMaps(result.MethodStatuses),
		},
	}
	if result.SMSWaitSeconds > 0 {
		response["retry_after_seconds"] = result.SMSWaitSeconds
		response["registration_phase"] = "OTP_COOLDOWN"
	}
	return response
}

func registrationProbeError(result wacore.EngineProbeResult) error {
	switch {
	case result.SMSWaitSeconds > 0 || result.AccountFlow == engine.AccountProbeFlowRateLimited:
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_RATE_LIMITED, "verification request is cooling down", true)
	case result.Blocked:
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, "number is blocked", false)
	case result.AccountFlow == engine.AccountProbeFlowConsentRequired:
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, "registration requires consent before a code can be requested", false)
	case result.AccountFlow == engine.AccountProbeFlowChallengeRequired:
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, "registration requires challenge verification before a code can be requested", false)
	case result.Status != waappv1.AccountProbeStatus_ACCOUNT_PROBE_STATUS_REACHABLE:
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, "account probe is not reachable", false)
	default:
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_ROUTE_UNAVAILABLE, "verification route unavailable", true)
	}
}

func registrationProbeSMSStatus(result wacore.EngineProbeResult) string {
	if result.CanSendSMS {
		return "AVAILABLE"
	}
	if result.SMSWaitSeconds > 0 {
		return "COOLDOWN"
	}
	return "UNAVAILABLE"
}

func registrationCodeResultPhoneStatus(result wacore.EngineCodeResult, method waappv1.VerificationDeliveryMethod, failed bool) map[string]any {
	smsStatus, smsAvailable, smsWaitSeconds := registrationCodeSMSStatus(result.MethodStatuses)
	if method == waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_SMS && smsStatus == "UNKNOWN" && result.RetryAfter > 0 {
		smsStatus = "COOLDOWN"
		smsAvailable = false
		smsWaitSeconds = int64(result.RetryAfter / time.Second)
	}
	registrationPhaseValue := registrationPhase(!failed, "accepted", result.RetryAfter)
	if failed {
		registrationPhaseValue = "OTP_REQUEST_FAILED"
		if result.RetryAfter > 0 {
			registrationPhaseValue = "OTP_COOLDOWN"
		}
	}
	rawStatus := result.RawStatus
	rawReason := result.RawReason
	return map[string]any{
		"account_status":               registrationCodeAccountStatus(failed),
		"account_flow":                 engine.AccountProbeFlowUnknown,
		"account_raw_status":           rawStatus,
		"account_raw_reason":           rawReason,
		"account_reachable":            !failed,
		"request_failed":               failed,
		"sms_status":                   smsStatus,
		"sms_available":                smsAvailable,
		"sms_wait_seconds":             smsWaitSeconds,
		"delivery_method":              method.String(),
		"registration_method":          engine.RegistrationMethodName(method, ""),
		"selected_method_wait_seconds": int64(result.RetryAfter / time.Second),
		"method_statuses":              methodStatusMaps(result.MethodStatuses),
		"can_register":                 !failed,
		"registration_phase":           registrationPhaseValue,
		"verification_status":          result.Status.String(),
		"verification_reason":          rawReason,
		"verification_outcome":         rawStatus,
	}
}

func registrationCodeSMSStatus(statuses []wacore.VerificationMethodStatus) (string, bool, int64) {
	for _, status := range statuses {
		if status.Code == "sms" || status.Method == waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_SMS {
			if status.CooldownSeconds > 0 {
				return "COOLDOWN", false, status.CooldownSeconds
			}
			if status.Available {
				return "AVAILABLE", true, 0
			}
			return "UNAVAILABLE", false, 0
		}
	}
	return "UNKNOWN", false, 0
}

func registrationCodeAccountStatus(failed bool) string {
	if failed {
		return waappv1.AccountProbeStatus_ACCOUNT_PROBE_STATUS_REJECTED.String()
	}
	return waappv1.AccountProbeStatus_ACCOUNT_PROBE_STATUS_REACHABLE.String()
}

func (g *actionGateway) discardRejectedRegistration(ctx context.Context, basePayload map[string]any, WAAccountID string, verificationRequestID string) error {
	if strings.TrimSpace(WAAccountID) == "" {
		return nil
	}
	result, err := g.cleanupFailedRegistration(ctx, map[string]any{
		"wa_account_id":           WAAccountID,
		"verification_request_id": verificationRequestID,
	})
	if err != nil {
		return err
	}
	if boolField(result, "success") {
		return nil
	}
	return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_INTERNAL, shared.FirstNonEmpty(shared.TextField(result, "error_message"), "discard rejected WA registration failed"), false)
}

func rejectedRegistrationResult(basePayload map[string]any, requested map[string]any) map[string]any {
	errorMessage := shared.FirstNonEmpty(shared.TextField(requested, "error_message"), shared.TextField(shared.ObjectField(requested, "error"), "message"), "WA registration request was rejected")
	response := map[string]any{
		"success":                 false,
		"status":                  shared.FirstNonEmpty(shared.TextField(requested, "status"), "OTP_REQUEST_REJECTED"),
		"error":                   shared.ObjectField(requested, "error"),
		"error_message":           errorMessage,
		"reject_reason":           registrationRejectReason(errorMessage),
		"phone":                   shared.ObjectField(basePayload, "phone"),
		"registration_phase":      shared.FirstNonEmpty(shared.TextField(requested, "registration_phase"), "OTP_REQUEST_REJECTED"),
		"fingerprint_persistence": "DISCARDED",
		"persisted":               false,
		"phone_status":            shared.ObjectField(requested, "phone_status"),
		"proxy":                   registrationOrchestratorProxySummary(shared.ObjectField(requested, "proxy")),
	}
	if seconds := numberField(requested, "retry_after_seconds"); seconds > 0 {
		response["retry_after_seconds"] = seconds
	}
	if methodStatuses, ok := requested["method_statuses"]; ok {
		response["method_statuses"] = methodStatuses
	}
	return response
}

func registrationRejectReason(errorMessage string) string {
	normalized := strings.ToLower(errorMessage)
	if strings.Contains(normalized, "format_wrong") || strings.Contains(normalized, "length_short") || strings.Contains(normalized, "length_long") || strings.Contains(normalized, "phone format") {
		return "invalid_number"
	}
	if strings.Contains(normalized, "too_recent") || strings.Contains(normalized, "too_many") || strings.Contains(normalized, "temporarily_unavailable") || strings.Contains(normalized, "cooldown") || strings.Contains(normalized, "cooling down") {
		return "rate_limited"
	}
	if strings.Contains(normalized, "no_routes") {
		return "no_routes"
	}
	if strings.Contains(normalized, "blocked") {
		return "blocked"
	}
	if strings.Contains(normalized, "consent") {
		return "consent_required"
	}
	if strings.Contains(normalized, "challenge") {
		return "challenge_required"
	}
	return "rejected"
}

func registrationOrchestratorProxySummary(proxy map[string]any) map[string]any {
	mode := shared.FirstNonEmpty(shared.TextField(proxy, "proxy_mode"), "DIRECT")
	countryCode := shared.FirstNonEmpty(shared.TextField(proxy, "country_code"), "LOCAL")
	return map[string]any{"proxy_mode": mode, "country_code": countryCode}
}
