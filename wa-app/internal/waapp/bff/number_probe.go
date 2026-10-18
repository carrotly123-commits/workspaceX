package bff

import (
	"context"
	"errors"
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

const numberProbeMaxAttempts = 3

// ProbeNumberSMS is the dashboard number-probe entry point.
func ProbeNumberSMS(server *rpc.Server, ctx context.Context, payload map[string]any) (map[string]any, error) {
	return (&actionGateway{server: server}).probeNumberSMS(ctx, payload)
}

func (g *actionGateway) probeNumberSMS(ctx context.Context, payload map[string]any) (map[string]any, error) {
	if payload == nil {
		payload = map[string]any{}
	}
	ctxData := actionContext(payload)
	phone := wamodel.NormalizePhone(phoneFromAction(payload))
	if phone.GetE164Number() == "" {
		err := shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "phone is required", false)
		result := numberProbeError(payload, err)
		logNumberProbeResult(ctxData, phone, wacore.WAProxyRoute{}, result)
		return result, nil
	}
	engine, ok := g.server.Runner().(*engine.NativeEngine)
	if !ok {
		err := shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_UNSUPPORTED_OPERATION, "native engine is required", false)
		result := numberProbeError(payload, err)
		logNumberProbeResult(ctxData, phone, wacore.WAProxyRoute{}, result)
		return result, nil
	}
	var lastResult map[string]any
	var lastRoute wacore.WAProxyRoute
	for attempt := 1; attempt <= numberProbeMaxAttempts; attempt++ {
		result, route, retry, reason := g.probeNumberSMSAttempt(ctx, payload, ctxData, phone, engine, attempt)
		lastResult, lastRoute = result, route
		if !retry || attempt == numberProbeMaxAttempts {
			if retry {
				markNumberProbeRetriesExhausted(result)
			}
			logNumberProbeResult(ctxData, phone, route, result)
			return result, nil
		}
		logNumberProbeRetry(ctxData, phone, route, attempt, numberProbeMaxAttempts, reason)
		if !waitNumberProbeRetry(ctx, attempt) {
			logNumberProbeResult(ctxData, phone, route, result)
			return result, nil
		}
	}
	logNumberProbeResult(ctxData, phone, lastRoute, lastResult)
	return lastResult, nil
}

func (g *actionGateway) probeNumberSMSAttempt(ctx context.Context, payload map[string]any, ctxData *waappv1.RequestContext, phone *waappv1.PhoneTarget, nativeEngine *engine.NativeEngine, attempt int) (map[string]any, wacore.WAProxyRoute, bool, string) {
	route, proxyURL, proxy := g.numberProbeProxy(payload)
	probeEngine := nativeEngine
	defer func() {
		if proxyURL != "" {
			probeEngine.CloseIdleConnections()
		}
	}()
	if proxyURL != "" {
		proxied, err := nativeEngine.WithProxyURL(proxyURL)
		if err != nil {
			result := numberProbeError(payload, err)
			annotateNumberProbeAttempt(result, attempt)
			return result, route, false, ""
		}
		probeEngine = proxied
	}
	state, err := probeEngine.NewState(phone)
	if err != nil {
		result := numberProbeError(payload, err)
		annotateNumberProbeAttempt(result, attempt)
		return result, route, false, ""
	}
	fingerprint := map[string]any{
		"fingerprint_persistence": "RANDOM_NOT_COMMITTED",
		"fingerprint":             fingerprintSummary(engine.PhoneProfileToProto(phone, state.Profile)),
	}
	probeResult, _ := probeEngine.ProbeAccountWithState(ctx, wacore.EngineRegistrationInput{AppVersion: engine.DefaultWAAppVersion, Phone: phone}, state)
	account := probeResultMap(probeResult)
	sms := smsProbeMap(account)
	result := buildNumberProbeResult(payload, proxy, fingerprint, account, sms)
	annotateNumberProbeAttempt(result, attempt)
	if retryableNumberProbeAttempt(proxy, probeResult) {
		return result, route, true, numberProbeRetryReason(probeResult.Err)
	}
	return result, route, false, ""
}

func (g *actionGateway) numberProbeProxy(payload map[string]any) (wacore.WAProxyRoute, string, map[string]any) {
	route, useProxy := g.resolveWAProxyRoute(waProxyResolveRequest{
		Payload:     payload,
		CountryCode: proxyCountryCodeFromPayload(payload),
	})
	if !useProxy {
		return route, "", waProxySummary(route, false)
	}
	return route, route.ProxyURL, waProxySummary(route, true)
}

func buildNumberProbeResult(input map[string]any, proxy map[string]any, fingerprint map[string]any, account map[string]any, sms map[string]any) map[string]any {
	accountStatus := shared.FirstNonEmpty(shared.TextField(account, "status"), shared.TextField(account, "account_status"), shared.TextField(shared.ObjectField(account, "probe"), "status"), "UNKNOWN")
	accountRawStatus := shared.FirstNonEmpty(shared.TextField(account, "raw_status"), shared.TextField(account, "rawStatus"), shared.TextField(account, "status_text"))
	accountRawReason := shared.FirstNonEmpty(shared.TextField(account, "raw_reason"), shared.TextField(account, "reason"))
	accountError := shared.FirstNonEmpty(shared.TextField(account, "error_message"), shared.TextField(shared.ObjectField(account, "error"), "message"))
	accountFlow := shared.FirstNonEmpty(shared.TextField(account, "account_flow"), engine.AccountProbeFlowUnknown)
	smsStatus := shared.FirstNonEmpty(shared.TextField(sms, "status"), shared.TextField(sms, "sms_status"), shared.TextField(sms, "route_status"), "UNKNOWN")
	methodStatuses := objectListField(account, "method_statuses")
	registered, registeredKnown := optionalBoolField(account, "registered")
	if statusIn(accountRawStatus, "exists", "registered", "account_exists") || statusIn(accountStatus, "registered", "exists") {
		registered = true
		registeredKnown = true
	}
	blocked := accountFlow == engine.AccountProbeFlowBlocked || boolField(account, "blocked") || statusIn(accountRawStatus, "blocked") || statusIn(accountRawReason, "blocked") || statusIn(accountStatus, "blocked")
	accountReachable := statusIn(accountStatus, "reachable", "account_probe_status_reachable", "ok", "sent", "valid", "exists") || statusIn(accountRawStatus, "ok", "sent", "valid", "exists") || accountFlow == engine.AccountProbeFlowRegistered || accountFlow == engine.AccountProbeFlowNotRegistered
	smsAvailable := boolField(sms, "can_send_sms") || boolField(sms, "sms_available") || statusIn(smsStatus, "available", "sms_available", "verification_request_status_sent", "sent", "waiting", "ok")
	smsWaitSeconds := firstNumberValue(sms, "sms_wait_seconds", "wait_seconds", "retry_after_seconds", "cooldown_seconds", "remaining_seconds", "retry_after", "wait")
	methodStatuses = numberProbeMethodStatuses(methodStatuses, smsAvailable, smsWaitSeconds)
	smsWaitUntil := shared.FirstNonEmpty(shared.TextField(sms, "sms_wait_until"), shared.TextField(sms, "wait_until"), shared.TextField(sms, "retry_after_at"), shared.TextField(sms, "cooldown_until"))
	proxyAccepted := boolField(proxy, "accepted")
	if accountFlow == engine.AccountProbeFlowUnknown {
		accountFlow = accountFlowFromRawReason(accountRawReason)
	}
	requestFailed := !proxyAccepted || accountProbeRequestFailed(accountFlow, accountStatus, accountRawStatus, accountRawReason, accountError)
	requestSucceeded := !requestFailed
	if requestFailed && !terminalAccountFlow(accountFlow) {
		accountFlow = engine.AccountProbeFlowProbeFailed
	}
	canRegister := canRegisterValue(requestSucceeded, accountReachable, smsAvailable, blocked, accountFlow)
	failureReason := ""
	if requestFailed {
		failureReason = numberProbeFailureReason(proxyAccepted, accountStatus, accountRawStatus, accountRawReason, accountError)
	}
	return map[string]any{
		"success":                 requestSucceeded,
		"passed":                  requestSucceeded,
		"request_failed":          requestFailed,
		"error_message":           failureReason,
		"reject_reason":           failureReason,
		"phone":                   shared.ObjectField(input, "phone"),
		"proxy":                   map[string]any{"proxy_mode": shared.FirstNonEmpty(shared.TextField(proxy, "proxy_mode"), "US_ROTATING_DYNAMIC_IP"), "country_code": shared.FirstNonEmpty(shared.TextField(proxy, "country_code"), "US")},
		"fingerprint_persistence": shared.FirstNonEmpty(shared.TextField(fingerprint, "fingerprint_persistence"), "RANDOM_NOT_COMMITTED"),
		"fingerprint":             shared.ObjectField(fingerprint, "fingerprint"),
		"account_probe":           account,
		"sms_probe":               sms,
		"phone_status": map[string]any{
			"account_status":     accountStatus,
			"account_flow":       accountFlow,
			"account_raw_status": accountRawStatus,
			"account_raw_reason": accountRawReason,
			"account_error":      accountError,
			"account_reachable":  accountReachable,
			"request_failed":     requestFailed,
			"registered":         optionalBoolValue(registered, registeredKnown),
			"blocked":            blocked,
			"sms_status":         smsStatus,
			"sms_available":      smsAvailable,
			"sms_wait_seconds":   smsWaitSeconds,
			"sms_wait_until":     smsWaitUntil,
			"method_statuses":    methodStatuses,
			"reject_reason":      failureReason,
			"can_register":       canRegister,
		},
	}
}

func numberProbeMethodStatuses(statuses []map[string]any, smsAvailable bool, smsWaitSeconds any) []map[string]any {
	if len(statuses) > 0 {
		return statuses
	}
	cooldownSeconds := numberProbeInt64(smsWaitSeconds)
	if !smsAvailable && cooldownSeconds <= 0 {
		return statuses
	}
	return []map[string]any{{
		"method":           "sms",
		"delivery_method":  waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_SMS.String(),
		"available":        smsAvailable && cooldownSeconds <= 0,
		"cooldown_seconds": cooldownSeconds,
	}}
}

func numberProbeInt64(value any) int64 {
	switch typed := value.(type) {
	case int:
		return engine.NormalizeWaitSeconds(int64(typed))
	case int32:
		return engine.NormalizeWaitSeconds(int64(typed))
	case int64:
		return engine.NormalizeWaitSeconds(typed)
	case float32:
		return engine.NormalizeWaitSeconds(int64(typed))
	case float64:
		return engine.NormalizeWaitSeconds(int64(typed))
	case string:
		return engine.NormalizeWaitSeconds(engine.JsonInt64(typed))
	default:
		return 0
	}
}

func accountFlowFromRawReason(reason string) string {
	normalized := strings.ToLower(strings.TrimSpace(reason))
	switch {
	case engine.ExistInvalidNumberReason(normalized):
		return engine.AccountProbeFlowInvalidNumber
	case engine.ExistRateLimitedReason(normalized):
		return engine.AccountProbeFlowRateLimited
	case normalized == "blocked":
		return engine.AccountProbeFlowBlocked
	default:
		return engine.AccountProbeFlowUnknown
	}
}

func terminalAccountFlow(flow string) bool {
	switch flow {
	case engine.AccountProbeFlowInvalidNumber, engine.AccountProbeFlowRateLimited, engine.AccountProbeFlowBlocked:
		return true
	default:
		return false
	}
}

func accountProbeRequestFailed(accountFlow string, accountStatus string, accountRawStatus string, accountRawReason string, accountError string) bool {
	if strings.TrimSpace(accountError) != "" {
		return true
	}
	if accountFlow == engine.AccountProbeFlowRegistered {
		return false
	}
	status := strings.ToLower(strings.TrimSpace(accountStatus))
	raw := strings.ToLower(strings.TrimSpace(accountRawStatus + " " + accountRawReason))
	if status == "" || status == "unknown" || status == "account_probe_status_rejected" || status == "rejected" || status == "error" {
		return true
	}
	return strings.Contains(raw, "invalid_skey") || strings.Contains(raw, "bad_token") || strings.Contains(raw, "missing_param") || strings.Contains(raw, "bad_param") || strings.Contains(raw, "old_version")
}

func numberProbeFailureReason(proxyAccepted bool, accountStatus string, accountRawStatus string, accountRawReason string, accountError string) string {
	if !proxyAccepted {
		return "dynamic IP route unavailable"
	}
	if strings.TrimSpace(accountError) != "" {
		return "account probe request failed: " + accountError
	}
	rawReason := strings.ToLower(strings.TrimSpace(accountRawReason))
	if engine.ExistInvalidNumberReason(rawReason) {
		return "phone format is invalid: " + rawReason
	}
	if engine.ExistRateLimitedReason(rawReason) {
		return "verification request is cooling down: " + rawReason
	}
	if accountStatus == "ACCOUNT_PROBE_STATUS_REJECTED" {
		return "account probe request rejected: " + shared.FirstNonEmpty(accountRawReason, accountRawStatus, "UNKNOWN")
	}
	return "account probe request failed: " + shared.FirstNonEmpty(accountRawReason, accountRawStatus, accountStatus, "UNKNOWN")
}

func canRegisterValue(requestSucceeded bool, accountReachable bool, smsAvailable bool, blocked bool, accountFlow string) bool {
	if !requestSucceeded || !accountReachable || !smsAvailable || blocked {
		return false
	}
	switch accountFlow {
	case engine.AccountProbeFlowInvalidNumber, engine.AccountProbeFlowRateLimited, engine.AccountProbeFlowProbeFailed:
		return false
	default:
		return true
	}
}

func optionalBoolValue(value bool, known bool) any {
	if !known {
		return nil
	}
	return value
}

func numberProbeProxyFailure(payload map[string]any, err error) map[string]any {
	return map[string]any{
		"success":                 false,
		"passed":                  false,
		"request_failed":          true,
		"error_message":           err.Error(),
		"reject_reason":           err.Error(),
		"phone":                   shared.ObjectField(payload, "phone"),
		"proxy":                   map[string]any{"proxy_mode": "US_ROTATING_DYNAMIC_IP", "country_code": "US"},
		"fingerprint_persistence": "NOT_CREATED",
		"phone_status": map[string]any{
			"account_status":    "UNKNOWN",
			"account_flow":      engine.AccountProbeFlowProbeFailed,
			"account_reachable": false,
			"request_failed":    true,
			"registered":        nil,
			"blocked":           nil,
			"sms_status":        "UNKNOWN",
			"sms_available":     false,
			"sms_wait_seconds":  nil,
			"sms_wait_until":    "",
			"method_statuses":   []map[string]any{},
			"can_register":      false,
		},
	}
}

func retryableNumberProbeAttempt(proxy map[string]any, result wacore.EngineProbeResult) bool {
	if shared.TextField(proxy, "proxy_mode") != "US_ROTATING_DYNAMIC_IP" {
		return false
	}
	return retryableNumberProbeTransportError(result.Err)
}

func retryableNumberProbeTransportError(err error) bool {
	if err == nil {
		return false
	}
	var appErr *shared.AppError
	if errors.As(err, &appErr) {
		switch appErr.Code {
		case waappv1.WaErrorCode_WA_ERROR_CODE_RATE_LIMITED,
			waappv1.WaErrorCode_WA_ERROR_CODE_ROUTE_UNAVAILABLE,
			waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED:
			return false
		}
	}
	message := strings.ToLower(err.Error())
	for _, marker := range []string{
		"eof",
		"connection reset",
		"connection refused",
		"unexpected close",
		"i/o timeout",
		"timeout awaiting response",
		"context deadline exceeded",
		"tls handshake",
		"proxyconnect",
		"network is unreachable",
		"no such host",
		"wasafe upstream http 5",
	} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

func numberProbeRetryReason(err error) string {
	if err == nil {
		return ""
	}
	reason := strings.Join(strings.Fields(err.Error()), " ")
	if len(reason) > 160 {
		return reason[:160]
	}
	return reason
}

func waitNumberProbeRetry(ctx context.Context, attempt int) bool {
	delay := time.Duration(attempt) * 300 * time.Millisecond
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func annotateNumberProbeAttempt(result map[string]any, attempt int) {
	if result == nil {
		return
	}
	result["probe_attempt"] = attempt
	result["max_probe_attempts"] = numberProbeMaxAttempts
	if phoneStatus := shared.ObjectField(result, "phone_status"); len(phoneStatus) > 0 {
		phoneStatus["probe_attempt"] = attempt
		phoneStatus["max_probe_attempts"] = numberProbeMaxAttempts
	}
	if proxy := shared.ObjectField(result, "proxy"); len(proxy) > 0 {
		proxy["probe_attempt"] = attempt
		proxy["max_probe_attempts"] = numberProbeMaxAttempts
	}
}

func markNumberProbeRetriesExhausted(result map[string]any) {
	if result == nil {
		return
	}
	result["retry_exhausted"] = true
	if phoneStatus := shared.ObjectField(result, "phone_status"); len(phoneStatus) > 0 {
		phoneStatus["retry_exhausted"] = true
	}
}

func numberProbeError(payload map[string]any, err error) map[string]any {
	result := numberProbeProxyFailure(payload, err)
	result["fingerprint_persistence"] = "RANDOM_NOT_COMMITTED"
	return result
}

func logNumberProbeResult(ctxData *waappv1.RequestContext, phone *waappv1.PhoneTarget, route wacore.WAProxyRoute, result map[string]any) {
	phoneStatus := shared.ObjectField(result, "phone_status")
	phoneHash := ""
	if phone != nil && phone.GetE164Number() != "" {
		phoneHash = shared.StableID(phone.GetE164Number())
	}
	log.Printf(
		"wa_phone_probe_result correlation=%s phone_hash=%s proxy_account=%s route_id=%s request_failed=%t success=%t account_flow=%s account_status=%s raw_status=%s raw_reason=%s sms_status=%s sms_available=%t sms_wait_seconds=%v error=%s",
		shared.ProbeLogValue(ctxData.GetCorrelationId()),
		phoneHash,
		shared.ProbeLogValue(route.AccountID),
		shared.ProbeLogValue(route.RouteID),
		boolField(phoneStatus, "request_failed") || boolField(result, "request_failed"),
		boolField(result, "success"),
		shared.ProbeLogValue(shared.TextField(phoneStatus, "account_flow")),
		shared.ProbeLogValue(shared.TextField(phoneStatus, "account_status")),
		shared.ProbeLogValue(shared.TextField(phoneStatus, "account_raw_status")),
		shared.ProbeLogValue(shared.TextField(phoneStatus, "account_raw_reason")),
		shared.ProbeLogValue(shared.TextField(phoneStatus, "sms_status")),
		boolField(phoneStatus, "sms_available"),
		firstNumberValue(phoneStatus, "sms_wait_seconds"),
		shared.ProbeLogValue(shared.FirstNonEmpty(shared.TextField(result, "error_message"), shared.TextField(phoneStatus, "account_error"))),
	)
}

func logNumberProbeRetry(ctxData *waappv1.RequestContext, phone *waappv1.PhoneTarget, route wacore.WAProxyRoute, attempt int, maxAttempts int, reason string) {
	phoneHash := ""
	if phone != nil && phone.GetE164Number() != "" {
		phoneHash = shared.StableID(phone.GetE164Number())
	}
	log.Printf(
		"wa_phone_probe_retry correlation=%s phone_hash=%s proxy_account=%s route_id=%s attempt=%d max_attempts=%d reason=%s",
		shared.ProbeLogValue(ctxData.GetCorrelationId()),
		phoneHash,
		shared.ProbeLogValue(route.AccountID),
		shared.ProbeLogValue(route.RouteID),
		attempt,
		maxAttempts,
		shared.ProbeLogValue(reason),
	)
}

func statusIn(value string, expected ...string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	for _, item := range expected {
		if normalized == strings.ToLower(item) {
			return true
		}
	}
	return false
}

func probeResultMap(result wacore.EngineProbeResult) map[string]any {
	out := map[string]any{
		"success":           result.Status == waappv1.AccountProbeStatus_ACCOUNT_PROBE_STATUS_REACHABLE,
		"status":            result.Status.String(),
		"account_status":    result.Status.String(),
		"account_flow":      shared.FirstNonEmpty(result.AccountFlow, engine.AccountProbeFlowUnknown),
		"raw_status":        result.RawStatus,
		"raw_reason":        result.RawReason,
		"blocked":           result.Blocked,
		"sms_wait_seconds":  result.SMSWaitSeconds,
		"can_send_sms":      result.CanSendSMS,
		"supported_methods": enumNames(result.SupportedMethods),
		"method_statuses":   methodStatusMaps(result.MethodStatuses),
	}
	if result.RegisteredKnown {
		out["registered"] = result.Registered
	}
	if result.Err != nil {
		protoErr := shared.ToProtoError(result.Err)
		out["success"] = false
		out["error"] = protoMap(protoErr)
		out["error_message"] = protoErr.GetMessage()
	}
	return out
}

func smsProbeMap(account map[string]any) map[string]any {
	status := shared.FirstNonEmpty(shared.TextField(account, "account_status"), shared.TextField(account, "status"))
	reachable := status == waappv1.AccountProbeStatus_ACCOUNT_PROBE_STATUS_REACHABLE.String() || strings.EqualFold(status, "REACHABLE") || strings.EqualFold(status, "ok")
	waitSeconds := firstNumberValue(account, "sms_wait_seconds")
	if !reachable || !boolField(account, "can_send_sms") {
		return map[string]any{"success": false, "status": "UNAVAILABLE", "sms_status": "UNAVAILABLE", "can_send_sms": false, "sms_wait_seconds": waitSeconds}
	}
	return map[string]any{"success": true, "status": "AVAILABLE", "sms_status": "AVAILABLE", "can_send_sms": true, "sms_wait_seconds": waitSeconds}
}

func boolField(data map[string]any, key string) bool {
	value, ok := optionalBoolField(data, key)
	return ok && value
}

func objectListField(data map[string]any, key string) []map[string]any {
	values, ok := data[key].([]map[string]any)
	if ok {
		return values
	}
	raw, ok := data[key].([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if value, ok := item.(map[string]any); ok {
			out = append(out, value)
		}
	}
	return out
}

func methodStatusMaps(statuses []wacore.VerificationMethodStatus) []map[string]any {
	out := make([]map[string]any, 0, len(statuses))
	for _, status := range statuses {
		method := status.Code
		if method == "" {
			method = status.Method.String()
		}
		out = append(out, map[string]any{
			"method":           method,
			"delivery_method":  status.Method.String(),
			"available":        status.Available,
			"cooldown_seconds": status.CooldownSeconds,
		})
	}
	return out
}

func protoMethodStatusMaps(statuses []*waappv1.VerificationMethodStatus) []map[string]any {
	out := make([]map[string]any, 0, len(statuses))
	for _, status := range statuses {
		if status.GetDeliveryMethod() == waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_UNSPECIFIED {
			continue
		}
		method := engine.RegistrationMethodName(status.GetDeliveryMethod(), "")
		out = append(out, map[string]any{
			"method":           method,
			"delivery_method":  status.GetDeliveryMethod().String(),
			"available":        status.GetAvailable(),
			"cooldown_seconds": shared.DurationSeconds(status.GetCooldown()),
		})
	}
	return out
}

func optionalBoolField(data map[string]any, key string) (bool, bool) {
	switch value := data[key].(type) {
	case bool:
		return value, true
	case string:
		if strings.EqualFold(value, "true") || value == "1" || strings.EqualFold(value, "yes") {
			return true, true
		}
		if strings.EqualFold(value, "false") || value == "0" || strings.EqualFold(value, "no") {
			return false, true
		}
		return false, false
	default:
		return false, false
	}
}

func firstNumberValue(data map[string]any, keys ...string) any {
	for _, key := range keys {
		value := data[key]
		switch typed := value.(type) {
		case int, int32, int64, float32, float64:
			return typed
		case string:
			if strings.TrimSpace(typed) != "" {
				return typed
			}
		}
	}
	return nil
}
