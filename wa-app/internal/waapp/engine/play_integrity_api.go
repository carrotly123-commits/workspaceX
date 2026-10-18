package engine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
)

const (
	defaultPlayIntegrityAPIRoute = "/v1/play-integrity/tokens"
	defaultPlayIntegrityStatus   = "/v1/play-integrity/status"
	playIntegrityAPITimeout      = 240 * time.Second
	playIntegrityAPIMaxAttempts  = 2
)

type playIntegrityAPIClient struct {
	endpoint string
	status   string
	token    string
	http     *http.Client
}

type playIntegrityTokenRequest struct {
	RequestHash string         `json:"requestHash"`
	PackageName string         `json:"packageName"`
	VersionCode int            `json:"versionCode"`
	Hardware    map[string]any `json:"hardware"`
	DG          map[string]any `json:"dg"`
}

type playIntegrityTokenResponse struct {
	Token string `json:"token"`
}

type PlayIntegrityAPIStatus struct {
	Configured           bool           `json:"configured"`
	OK                   bool           `json:"ok"`
	DGRunnerMode         string         `json:"dgRunnerMode,omitempty"`
	MaxConcurrency       int            `json:"maxConcurrency,omitempty"`
	TotalRequests        int            `json:"totalRequests,omitempty"`
	SuccessRequests      int            `json:"successRequests,omitempty"`
	FailedRequests       int            `json:"failedRequests,omitempty"`
	POTokenBackend       bool           `json:"poTokenBackendConfigured,omitempty"`
	VM                   map[string]any `json:"vm,omitempty"`
	RawValuesPrinted     bool           `json:"rawValuesPrinted"`
	Available            bool           `json:"available"`
	UnavailableReasonLen int            `json:"unavailableReasonLen,omitempty"`
}

func newPlayIntegrityAPIClient(endpoint, token string) (*playIntegrityAPIClient, error) {
	endpoint = strings.TrimSpace(endpoint)
	token = strings.TrimSpace(token)
	if endpoint == "" && token == "" {
		return nil, nil
	}
	if endpoint == "" || token == "" {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "play integrity api url and token must be configured together", false)
	}
	normalized, err := normalizePlayIntegrityAPIEndpoint(endpoint)
	if err != nil {
		return nil, err
	}
	status, err := normalizePlayIntegrityAPIStatusEndpoint(normalized)
	if err != nil {
		return nil, err
	}
	return &playIntegrityAPIClient{endpoint: normalized, status: status, token: token, http: &http.Client{Timeout: playIntegrityAPITimeout}}, nil
}

func normalizePlayIntegrityAPIEndpoint(endpoint string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "play integrity api url must be an absolute http endpoint", false)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "play integrity api url scheme must be http or https", false)
	}
	if strings.Trim(parsed.Path, "/") == "" {
		parsed.Path = defaultPlayIntegrityAPIRoute
	}
	return parsed.String(), nil
}

func normalizePlayIntegrityAPIStatusEndpoint(endpoint string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "play integrity api status endpoint is invalid", false)
	}
	parsed.Path = defaultPlayIntegrityStatus
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func (c *playIntegrityAPIClient) Status(ctx context.Context) PlayIntegrityAPIStatus {
	if c == nil {
		return PlayIntegrityAPIStatus{Configured: false, Available: false, RawValuesPrinted: false}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.status, nil)
	if err != nil {
		return playIntegrityStatusUnavailable(err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return playIntegrityStatusUnavailable(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return PlayIntegrityAPIStatus{Configured: true, Available: false, RawValuesPrinted: false, UnavailableReasonLen: len(strconv.Itoa(resp.StatusCode))}
	}
	var parsed PlayIntegrityAPIStatus
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&parsed); err != nil {
		return playIntegrityStatusUnavailable(err)
	}
	parsed.Configured = true
	parsed.Available = parsed.OK
	parsed.RawValuesPrinted = false
	parsed.VM = sanitizePlayIntegrityVMStatus(parsed.VM)
	return parsed
}

func playIntegrityStatusUnavailable(err error) PlayIntegrityAPIStatus {
	return PlayIntegrityAPIStatus{Configured: true, Available: false, RawValuesPrinted: false, UnavailableReasonLen: len(err.Error())}
}

func sanitizePlayIntegrityVMStatus(vm map[string]any) map[string]any {
	if len(vm) == 0 {
		return nil
	}
	allowed := map[string]struct{}{
		"enabled":          {},
		"state":            {},
		"processRunning":   {},
		"busy":             {},
		"prewarmStarted":   {},
		"prewarmCompleted": {},
		"prewarmElapsedMs": {},
		"requestCount":     {},
		"successCount":     {},
		"failureCount":     {},
		"warmupTimings":    {},
		"lastTimings":      {},
		"rawValuesPrinted": {},
	}
	out := make(map[string]any, len(allowed)+1)
	for key := range allowed {
		if value, ok := vm[key]; ok {
			out[key] = value
		}
	}
	if value, ok := vm["lastError"].(string); ok && value != "" {
		out["lastErrorLen"] = len(value)
	}
	return out
}

func (c *playIntegrityAPIClient) Issue(ctx context.Context, input wamsysMaterialInput) (string, error) {
	if c == nil {
		return "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "play integrity api is not configured", false)
	}
	requestHash := nativeGPIARequestHash(input.State)
	if requestHash == "" {
		return "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "gpia request hash is unavailable", false)
	}
	payload := playIntegrityTokenRequest{
		RequestHash: requestHash,
		PackageName: nativeGPIAPackageName,
		VersionCode: nativeWAAppVersionCode(input.AppVersion),
		Hardware:    nativeGMSHardwareProfile(input),
		DG: map[string]any{
			"flowName":          "po-token-hw",
			"contentBindingKey": "b",
			"legacyEmptyField4": false,
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_INTERNAL, "build play integrity token request failed", false)
	}
	requestID := playIntegrityAPIRequestID(input, requestHash)
	var lastErr error
	for attempt := 1; attempt <= playIntegrityAPIMaxAttempts; attempt++ {
		token, retry, err := c.issueOnce(ctx, body, requestID)
		if err == nil {
			return token, nil
		}
		lastErr = err
		if !retry || attempt == playIntegrityAPIMaxAttempts || ctx.Err() != nil {
			break
		}
		if !shared.SleepContext(ctx, time.Duration(attempt)*500*time.Millisecond) {
			if err := ctx.Err(); err != nil {
				return "", err
			}
			break
		}
	}
	return "", lastErr
}

func (c *playIntegrityAPIClient) issueOnce(ctx context.Context, body []byte, requestID string) (string, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return "", false, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_INTERNAL, "build play integrity api request failed", false)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	if requestID != "" {
		req.Header.Set("X-Request-ID", requestID)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", true, fmt.Errorf("play integrity token request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return "", playIntegrityStatusRetryable(resp.StatusCode), fmt.Errorf("play integrity token request rejected with HTTP %d", resp.StatusCode)
	}
	var parsed playIntegrityTokenResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&parsed); err != nil {
		return "", false, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_INTERNAL, "decode play integrity token response failed", false)
	}
	if strings.TrimSpace(parsed.Token) == "" {
		return "", false, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_INTERNAL, "play integrity token response did not include token", false)
	}
	return parsed.Token, false, nil
}

func playIntegrityStatusRetryable(status int) bool {
	return status == http.StatusTooManyRequests || status >= 500
}

func playIntegrityAPIRequestID(input wamsysMaterialInput, requestHash string) string {
	seed := shared.FirstNonEmpty(input.Phone.GetE164Number(), requestHash)
	if seed == "" {
		return ""
	}
	return "wa-gpia-" + shared.StableID(seed)
}

func nativeGMSHardwareProfile(input wamsysMaterialInput) map[string]any {
	state := input.State
	profile := NormalizeNativePhoneProfile(state.Profile, "")
	release := shared.FirstNonEmpty(profile.AndroidVersion, defaultNativeDeviceModel().Android)
	sdk := nativeAndroidSDKInt(release)
	vendor := shared.FirstNonEmpty(profile.DeviceVendor, defaultNativeDeviceModel().Vendor)
	model := shared.FirstNonEmpty(profile.DeviceModel, defaultNativeDeviceModel().Model)
	display := shared.FirstNonEmpty(profile.BuildDisplayID, nativeBuildDisplayIDForModel(nativeDeviceModel{Vendor: vendor, Model: model, Android: release}))
	device := nativeGMSDeviceCode(vendor, model)
	brand := nativeGMSBrand(vendor)
	manufacturer := shared.FirstNonEmpty(vendor, brand)
	buildID := nativeGMSBuildID(display)
	buildTimeMillis := nativeGMSBuildTimeMillis(display)
	securityPatch := nativePlayIntegritySecurityPatch(sdk)
	fingerprint := strings.Join([]string{
		brand + "/" + device + "/" + device + ":" + release,
		buildID + "/" + buildID,
		"user/release-keys",
	}, "/")
	supportedABIs := []string{"arm64-v8a", "armeabi-v7a", "armeabi"}
	build := map[string]any{
		"BOARD":                  device,
		"BOOTLOADER":             "unknown",
		"BRAND":                  brand,
		"CPU_ABI":                "arm64-v8a",
		"CPU_ABI2":               "armeabi-v7a",
		"SUPPORTED_ABIS":         supportedABIs,
		"DEVICE":                 device,
		"DISPLAY":                display,
		"FINGERPRINT":            fingerprint,
		"HARDWARE":               device,
		"HOST":                   "abfarm-release",
		"ID":                     buildID,
		"MANUFACTURER":           manufacturer,
		"MODEL":                  model,
		"PRODUCT":                device,
		"RADIO":                  "unknown",
		"TAGS":                   "release-keys",
		"TIME":                   strconv.FormatInt(buildTimeMillis, 10),
		"TYPE":                   "user",
		"USER":                   "android-build",
		"VERSION.CODENAME":       "REL",
		"VERSION.INCREMENTAL":    buildID,
		"VERSION.RELEASE":        release,
		"VERSION.SECURITY_PATCH": securityPatch,
		"VERSION.SDK":            strconv.Itoa(sdk),
		"VERSION.SDK_INT":        strconv.Itoa(sdk),
		"DEVICE_INITIAL_SDK_INT": strconv.Itoa(nativePlayIntegrityInitialSDK(sdk)),
	}
	ctx := nativeGMSHardwareContext{
		Input:           input,
		State:           state,
		Fields:          NativeDeviceMapFields(state),
		Release:         release,
		SDK:             sdk,
		Model:           model,
		Display:         display,
		Device:          device,
		Brand:           brand,
		Manufacturer:    manufacturer,
		BuildID:         buildID,
		BuildTimeMillis: buildTimeMillis,
		Fingerprint:     fingerprint,
		SecurityPatch:   securityPatch,
		SupportedABIs:   supportedABIs,
	}
	return map[string]any{
		"build":         build,
		"securityPatch": securityPatch,
		"device": map[string]any{
			"brand":         ctx.Brand,
			"manufacturer":  ctx.Manufacturer,
			"model":         ctx.Model,
			"product":       ctx.Device,
			"device":        ctx.Device,
			"sdkInt":        ctx.SDK,
			"fingerprint":   ctx.Fingerprint,
			"securityPatch": ctx.SecurityPatch,
			"supportedAbis": ctx.SupportedABIs,
		},
		"runtime": map[string]any{
			"osArch":         "aarch64",
			"forceArm64Only": false,
			"source":         "wa-app registration profile expanded for GMS",
		},
		"hooks": nativeGMSHardwareHooks(ctx),
	}
}

func nativeAndroidSDKInt(release string) int {
	release = strings.TrimSpace(release)
	if idx := strings.IndexByte(release, '.'); idx > 0 {
		release = release[:idx]
	}
	switch release {
	case "16":
		return 36
	case "15":
		return 35
	case "14":
		return 34
	case "13":
		return 33
	case "12":
		return 31
	case "11":
		return 30
	case "10":
		return 29
	case "9":
		return 28
	case "8":
		return 26
	case "7":
		return 24
	default:
		return 35
	}
}

func nativeGMSBrand(vendor string) string {
	value := strings.TrimSpace(vendor)
	if strings.EqualFold(value, "Google") {
		return "google"
	}
	if value == "" {
		return "android"
	}
	return strings.ToLower(value)
}

func nativeGMSDeviceCode(vendor, model string) string {
	if strings.EqualFold(strings.TrimSpace(vendor), "Google") {
		switch strings.ToLower(strings.TrimSpace(model)) {
		case "pixel 9 pro xl":
			return "komodo"
		case "pixel 9 pro":
			return "caiman"
		case "pixel 9":
			return "tokay"
		case "pixel 8 pro":
			return "husky"
		case "pixel 8":
			return "shiba"
		case "pixel 7 pro":
			return "cheetah"
		case "pixel 7":
			return "panther"
		case "pixel 6 pro":
			return "raven"
		case "pixel 6":
			return "oriole"
		}
	}
	return sanitizeNativeGMSDeviceCode(model)
}

func sanitizeNativeGMSDeviceCode(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var b strings.Builder
	lastUnderscore := false
	for _, char := range value {
		ok := (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')
		if ok {
			b.WriteRune(char)
			lastUnderscore = false
			continue
		}
		if !lastUnderscore && b.Len() > 0 {
			b.WriteByte('_')
			lastUnderscore = true
		}
	}
	out := strings.Trim(b.String(), "_")
	if out == "" {
		return "device"
	}
	return out
}

func nativeGMSBuildID(display string) string {
	display = strings.TrimSpace(display)
	if idx := strings.IndexByte(display, '_'); idx >= 0 && idx+1 < len(display) {
		return display[idx+1:]
	}
	if display == "" {
		return "UNKNOWN"
	}
	return display
}

func nativeGMSBuildTimeMillis(display string) int64 {
	sum := sha256.Sum256([]byte(display))
	const start = int64(1735689600)
	const spread = int64(540 * 24 * 3600)
	seconds := start + int64(binary.BigEndian.Uint32(sum[:4]))%spread
	return seconds * 1000
}

func nativeWAAppVersionCode(appVersion string) int {
	if NativeAppVersion(appVersion) == DefaultWAAppVersion {
		return defaultWAAppVersionCode
	}
	return defaultWAAppVersionCode
}
