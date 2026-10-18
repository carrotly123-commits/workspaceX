package engine

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
)

const (
	nativeABCodeGPIA               = 3753
	nativeABCodeSIMSignal          = 4435
	nativeABCodeRecaptchaThreshold = 7343
	nativeABCodeRandomRequestID    = 9463
)

type nativePreChatdABConfig struct {
	Value string
}

type nativePreChatdABSummary struct {
	ConfigCount      int
	GPIAEnabled      bool
	SIMSignalEnabled bool
	RecaptchaStage   string
	RequestIDRandom  bool
}

func nativePreChatdABConfigs(state NativeState) map[int]nativePreChatdABConfig {
	return parseNativePreChatdABConfigs(state.PreChatdAB.ExpConfig)
}

func parseNativePreChatdABConfigs(expConfig string) map[int]nativePreChatdABConfig {
	expConfig = strings.TrimSpace(expConfig)
	if expConfig == "" || expConfig == "wamsys initialization fails" {
		return nil
	}
	if configs, ok := parseNativePreChatdABConfigArray(expConfig); ok {
		return configs
	}
	var nested string
	if err := json.Unmarshal([]byte(expConfig), &nested); err == nil {
		if configs, ok := parseNativePreChatdABConfigArray(nested); ok {
			return configs
		}
	}
	return nil
}

func parseNativePreChatdABConfigArray(expConfig string) (map[int]nativePreChatdABConfig, bool) {
	var items []map[string]any
	if err := json.Unmarshal([]byte(expConfig), &items); err != nil {
		return nil, false
	}
	configs := make(map[int]nativePreChatdABConfig, len(items))
	for _, item := range items {
		code, err := strconv.Atoi(strings.TrimSpace(nativeJSONScalarString(item["config_code"])))
		if err != nil {
			continue
		}
		configs[code] = nativePreChatdABConfig{Value: strings.TrimSpace(nativeJSONScalarString(item["config_value"]))}
	}
	return configs, true
}

func nativeJSONScalarString(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case float64:
		if v == float64(int64(v)) {
			return strconv.FormatInt(int64(v), 10)
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		if v {
			return "1"
		}
		return "0"
	case json.Number:
		return v.String()
	default:
		return ""
	}
}

func nativeABBoolFromConfigs(configs map[int]nativePreChatdABConfig, code int, fallback bool) bool {
	config, ok := configs[code]
	if !ok {
		return fallback
	}
	value := strings.ToLower(strings.TrimSpace(config.Value))
	switch value {
	case "1", "true", "yes", "on":
		return true
	case "", "0", "false", "no", "off":
		return false
	default:
		n, err := strconv.ParseFloat(value, 64)
		return err == nil && n != 0
	}
}

func nativeABIntFromConfigs(configs map[int]nativePreChatdABConfig, code int) (int, bool) {
	config, ok := configs[code]
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimSpace(config.Value))
	if err != nil {
		return 0, false
	}
	return n, true
}

func nativePreChatdABLogSummary(state NativeState) nativePreChatdABSummary {
	configs := nativePreChatdABConfigs(state)
	return nativePreChatdABSummary{
		ConfigCount:      len(configs),
		GPIAEnabled:      nativeABBoolFromConfigs(configs, nativeABCodeGPIA, true),
		SIMSignalEnabled: nativeABBoolFromConfigs(configs, nativeABCodeSIMSignal, true),
		RecaptchaStage:   nativeRecaptchaStage(state, configs),
		RequestIDRandom:  nativeABBoolFromConfigs(configs, nativeABCodeRandomRequestID, false),
	}
}

func nativeShouldSendRegistrationGPIA(state NativeState) bool {
	return nativeABBoolFromConfigs(nativePreChatdABConfigs(state), nativeABCodeGPIA, true)
}

func nativeShouldRandomizeRegistrationRequestID(state NativeState) bool {
	return nativeABBoolFromConfigs(nativePreChatdABConfigs(state), nativeABCodeRandomRequestID, false)
}

func applyNativePreChatdABDeviceFields(fields map[string]string, state NativeState) {
	if fields == nil {
		return
	}
	configs := nativePreChatdABConfigs(state)
	if nativeABBoolFromConfigs(configs, nativeABCodeSIMSignal, true) {
		fields["sim_type"] = nativeABSIMType(fields)
		fields["airplane_mode_type"] = "0"
		fields["cellular_strength"] = "5"
		fields["roaming_type"] = "0"
	}
	fields["recaptcha"] = nativeRecaptchaPayload(nativeRecaptchaStage(state, configs))
}

func nativeABSIMType(fields map[string]string) string {
	if fields["simnum"] == "1" || nativeOperatorPresent(fields["sim_mcc"], fields["sim_mnc"]) {
		return "1"
	}
	return "0"
}

func nativeOperatorPresent(mcc string, mnc string) bool {
	mcc = strings.TrimSpace(mcc)
	mnc = strings.TrimSpace(mnc)
	return mcc != "" && mcc != "000" && mnc != "" && mnc != "000"
}

func nativeRecaptchaStage(state NativeState, configs map[int]nativePreChatdABConfig) string {
	threshold, ok := nativeABIntFromConfigs(configs, nativeABCodeRecaptchaThreshold)
	if !ok || threshold <= 0 {
		return "ABPROP_DISABLED"
	}
	if nativeRecaptchaInstallRoll(state) < threshold {
		return "ABPROP_ENABLED"
	}
	return "ABPROP_DISABLED"
}

func nativeRecaptchaInstallRoll(state NativeState) int {
	seed := shared.FirstNonEmpty(state.Profile.ExpID, state.Profile.FDID, state.Profile.PhoneSHA256, state.AuthKey)
	sum := sha256.Sum256([]byte(seed))
	return 1 + int(binary.BigEndian.Uint16(sum[:2])%1000)
}

func nativeRecaptchaPayload(stage string) string {
	if strings.TrimSpace(stage) == "" {
		stage = "ABPROP_DISABLED"
	}
	data, err := json.Marshal(map[string]string{"stage": stage})
	if err != nil {
		return `{"stage":"ABPROP_DISABLED"}`
	}
	return string(data)
}
