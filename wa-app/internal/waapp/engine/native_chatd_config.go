package engine

import "time"

const (
	chatdFallbackHost = "g-fallback.whatsapp.net"
)

func chatdConfigForState(proxyURL string, state NativeState, timeout time.Duration) chatdClientConfig {
	cfg := chatdClientConfig{
		ProxyURL:    proxyURL,
		RoutingInfo: state.ChatRoutingInfo,
		Endpoints:   chatdEndpointsForState(state),
	}
	if timeout > 0 {
		cfg.Timeout = timeout
	}
	return cfg
}

func accountSettingsChatdConfig(proxyURL string, state NativeState) chatdClientConfig {
	cfg := chatdConfigForState(proxyURL, state, defaultAccountIQTimeout)
	cfg.OpenTimeout = defaultAccountSettingsOpenTimeout
	return cfg
}

func chatdEndpointsForState(state NativeState) []chatdEndpoint {
	endpoints := []chatdEndpoint{}
	if state.ChatConnection.LastHost != "" && state.ChatConnection.LastPort > 0 {
		endpoints = append(endpoints, chatdEndpoint{Host: state.ChatConnection.LastHost, Port: state.ChatConnection.LastPort})
	}
	endpoints = append(endpoints, chatdEndpoint{Host: defaultChatdHost, Port: defaultChatdPort})
	endpoints = append(endpoints, chatdEndpoint{Host: chatdFallbackHost, Port: defaultChatdPort})
	return endpoints
}
