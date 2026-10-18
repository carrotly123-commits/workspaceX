package wacore

// WAProxyRoute is the resolved egress-proxy binding for a WA account or request,
// together with the routing metadata that produced the choice.
type WAProxyRoute struct {
	AccountID   string
	RouteID     string
	ProxyURL    string
	ProxyMode   string
	CountryCode string
	Source      string
	PolicyMode  string
}
