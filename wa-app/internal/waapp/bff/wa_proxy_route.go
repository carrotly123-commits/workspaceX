package bff

import (
	"strings"

	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
)

func proxyCountryCodeFromPayload(payload map[string]any) string {
	phone := shared.ObjectField(payload, "phone")
	proxy := shared.ObjectField(payload, "proxy")
	value := shared.FirstNonEmpty(
		shared.TextField(payload, "proxy_country_code"),
		shared.TextField(proxy, "country_code"),
		shared.TextField(proxy, "proxy_country_code"),
		shared.TextField(payload, "country_iso2"),
		shared.TextField(payload, "country_region"),
		shared.TextField(payload, "region"),
		shared.TextField(phone, "country_iso2"),
	)
	if value != "" {
		return normalizeProxyCountryCode(value)
	}
	callingCode := shared.FirstNonEmpty(
		shared.TextField(payload, "country_calling_code"),
		shared.TextField(payload, "cc"),
		shared.TextField(payload, "country_code"),
		shared.TextField(phone, "country_calling_code"),
	)
	return normalizeProxyCountryCode(proxyCountryCodeFromCallingCode(callingCode))
}

func proxyCountryCodeFromCallingCode(value string) string {
	switch strings.TrimPrefix(strings.TrimSpace(value), "+") {
	case "1":
		return "US"
	case "48":
		return "PL"
	case "57":
		return "CO"
	case "63":
		return "PH"
	case "84":
		return "VN"
	case "86":
		return "CN"
	default:
		return ""
	}
}

func normalizeProxyCountryCode(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	value = strings.TrimPrefix(value, "+")
	switch value {
	case "", "1", "USA", "UNITEDSTATES", "UNITED_STATES":
		return "US"
	default:
		return value
	}
}
