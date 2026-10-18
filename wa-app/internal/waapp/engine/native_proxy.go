package engine

import (
	"fmt"
	"net/url"
	"strings"
)

func (e *engineCore) httpForProxy() (*nativeHTTPClient, error) {
	if _, err := e.proxyURL(); err != nil {
		return nil, err
	}
	return e.http, nil
}

func (e *engineCore) proxyURL() (string, error) {
	if proxyURL := strings.TrimSpace(e.activeProxyURL); proxyURL != "" {
		return normalizeProxyURLString(proxyURL)
	}
	return "", nil
}

func normalizeProxyURLString(value string) (string, error) {
	parsed, err := parseOutboundProxyURL(value)
	if err != nil || parsed == nil {
		return "", err
	}
	return parsed.String(), nil
}

func parseOutboundProxyURL(value string) (*url.URL, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	if !strings.Contains(value, "://") {
		value = "socks5://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return nil, fmt.Errorf("invalid proxy URL")
	}
	parsed.Scheme = normalizeProxyScheme(parsed.Scheme)
	if parsed.Scheme == "" {
		return nil, fmt.Errorf("invalid proxy URL scheme")
	}
	if strings.TrimSpace(parsed.Hostname()) == "" {
		return nil, fmt.Errorf("proxy host is required")
	}
	parsed.Path = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed, nil
}

func normalizeProxyScheme(scheme string) string {
	scheme = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(scheme)), "://")
	switch scheme {
	case "http", "https", "socks5", "socks5h":
		return scheme
	case "socks", "socks5-proxy":
		return "socks5"
	default:
		return ""
	}
}
