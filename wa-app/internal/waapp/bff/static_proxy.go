package bff

import (
	"strings"

	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
)

const staticCommonProxyMode = "COMMON_PROXY"

func staticProxyRoute(name string, proxyURL string, mode string) wacore.WAProxyRoute {
	return wacore.WAProxyRoute{
		AccountID:   "static-" + name + "-proxy",
		RouteID:     "static-" + name + "-proxy",
		ProxyURL:    strings.TrimSpace(proxyURL),
		ProxyMode:   mode,
		CountryCode: "UNKNOWN",
	}
}
