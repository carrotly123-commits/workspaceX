package engine

import (
	"bufio"
	"compress/gzip"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	stdtls "crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	utls "github.com/refraction-networking/utls"
	xproxy "golang.org/x/net/proxy"
)

const (
	defaultWASafeServerPublicKeyHex = "8e8c0f74c3ebc5d7a6865c6c3c843856b06121cce8ea774d22fb6f122512302d"
	defaultNativeHTTPForwardedHost  = "v.whatsapp.net"
)

type nativeHTTPClient struct {
	client         *http.Client
	dialTLSContext func(context.Context, string, string) (net.Conn, error)
	timeout        time.Duration
}

func (c *nativeHTTPClient) CloseIdleConnections() {
	if c == nil || c.client == nil {
		return
	}
	c.client.CloseIdleConnections()
}

func newNativeHTTPClient(proxy string) (*nativeHTTPClient, error) {
	dialer := &net.Dialer{Timeout: 20 * time.Second, KeepAlive: 20 * time.Second}
	dialTLSContext := nativeAndroidDialTLSContext(dialer.DialContext)
	transport := &http.Transport{
		ForceAttemptHTTP2: false,
		TLSClientConfig:   &stdtls.Config{InsecureSkipVerify: true},
		DialContext:       dialer.DialContext,
		DialTLSContext:    dialTLSContext,
	}
	if proxy != "" {
		parsed, err := parseOutboundProxyURL(proxy)
		if err != nil {
			return nil, err
		}
		if err := configureNativeHTTPProxy(transport, parsed, dialer); err != nil {
			return nil, err
		}
		proxyDialTLSContext, err := nativeProxyDialTLSContext(parsed, dialer)
		if err != nil {
			return nil, err
		}
		dialTLSContext = proxyDialTLSContext
	}
	return &nativeHTTPClient{client: &http.Client{Timeout: 20 * time.Second, Transport: transport}, dialTLSContext: dialTLSContext, timeout: 20 * time.Second}, nil
}

func configureNativeHTTPProxy(transport *http.Transport, parsed *url.URL, dialer *net.Dialer) error {
	if transport == nil || parsed == nil {
		return nil
	}
	if dialer == nil {
		dialer = &net.Dialer{Timeout: 20 * time.Second, KeepAlive: 20 * time.Second}
	}
	switch {
	case parsed.Scheme == "http" || parsed.Scheme == "https":
		transport.Proxy = nil
		transport.DialContext = dialer.DialContext
		transport.DialTLSContext = nativeAndroidDialTLSContext(nativeHTTPProxyConnectDialContext(dialer.DialContext, parsed))
	case strings.HasPrefix(parsed.Scheme, "socks5"):
		var auth *xproxy.Auth
		if parsed.User != nil {
			password, _ := parsed.User.Password()
			auth = &xproxy.Auth{User: parsed.User.Username(), Password: password}
		}
		proxyDialer, err := xproxy.SOCKS5("tcp", parsed.Host, auth, dialer)
		if err != nil {
			return err
		}
		contextDialer, ok := proxyDialer.(xproxy.ContextDialer)
		if !ok {
			return fmt.Errorf("SOCKS5 proxy dialer does not support context")
		}
		transport.DialContext = contextDialer.DialContext
		transport.DialTLSContext = nativeAndroidDialTLSContext(contextDialer.DialContext)
	default:
		return fmt.Errorf("unsupported HTTP proxy scheme")
	}
	return nil
}

func nativeProxyDialTLSContext(parsed *url.URL, dialer *net.Dialer) (func(context.Context, string, string) (net.Conn, error), error) {
	if parsed == nil {
		return nil, fmt.Errorf("proxy URL is required")
	}
	if dialer == nil {
		dialer = &net.Dialer{Timeout: 20 * time.Second, KeepAlive: 20 * time.Second}
	}
	switch {
	case parsed.Scheme == "http" || parsed.Scheme == "https":
		return nativeAndroidDialTLSContext(nativeHTTPProxyConnectDialContext(dialer.DialContext, parsed)), nil
	case strings.HasPrefix(parsed.Scheme, "socks5"):
		var auth *xproxy.Auth
		if parsed.User != nil {
			password, _ := parsed.User.Password()
			auth = &xproxy.Auth{User: parsed.User.Username(), Password: password}
		}
		proxyDialer, err := xproxy.SOCKS5("tcp", parsed.Host, auth, dialer)
		if err != nil {
			return nil, err
		}
		contextDialer, ok := proxyDialer.(xproxy.ContextDialer)
		if !ok {
			return nil, fmt.Errorf("SOCKS5 proxy dialer does not support context")
		}
		return nativeAndroidDialTLSContext(contextDialer.DialContext), nil
	default:
		return nil, fmt.Errorf("unsupported HTTP proxy scheme")
	}
}

func nativeHTTPProxyConnectDialContext(dialContext func(context.Context, string, string) (net.Conn, error), parsed *url.URL) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network string, addr string) (net.Conn, error) {
		if dialContext == nil {
			return nil, fmt.Errorf("native proxy dialer is not configured")
		}
		if parsed == nil || parsed.Host == "" {
			return nil, fmt.Errorf("HTTP proxy host is required")
		}
		proxyAddress := nativeProxyAddress(parsed)
		conn, err := dialContext(ctx, network, proxyAddress)
		if err != nil {
			return nil, err
		}
		if parsed.Scheme == "https" {
			tlsConn := stdtls.Client(conn, &stdtls.Config{ServerName: parsed.Hostname(), InsecureSkipVerify: true})
			if err := tlsConn.HandshakeContext(ctx); err != nil {
				_ = conn.Close()
				return nil, err
			}
			conn = tlsConn
		}
		_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
		if err := writeNativeHTTPConnect(conn, parsed, addr); err != nil {
			_ = conn.Close()
			return nil, err
		}
		reader := bufio.NewReader(conn)
		statusLine, err := reader.ReadString('\n')
		if err != nil {
			_ = conn.Close()
			return nil, err
		}
		statusLine = strings.TrimSpace(statusLine)
		if !nativeHTTPConnectStatusOK(statusLine) {
			_ = conn.Close()
			return nil, fmt.Errorf("HTTP CONNECT proxy failed")
		}
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				_ = conn.Close()
				return nil, err
			}
			if line == "\r\n" || line == "\n" {
				break
			}
		}
		_ = conn.SetDeadline(time.Time{})
		return &bufferedConn{Conn: conn, reader: reader}, nil
	}
}

func nativeProxyAddress(parsed *url.URL) string {
	if parsed == nil {
		return ""
	}
	if _, _, err := net.SplitHostPort(parsed.Host); err == nil {
		return parsed.Host
	}
	port := "80"
	if parsed.Scheme == "https" {
		port = "443"
	}
	return net.JoinHostPort(parsed.Hostname(), port)
}

func writeNativeHTTPConnect(conn net.Conn, parsed *url.URL, target string) error {
	headers := []string{
		"CONNECT " + target + " HTTP/1.1",
		"Host: " + target,
		"Proxy-Connection: Keep-Alive",
	}
	if parsed != nil && parsed.User != nil {
		password, _ := parsed.User.Password()
		credential := parsed.User.Username() + ":" + password
		headers = append(headers, "Proxy-Authorization: Basic "+base64.StdEncoding.EncodeToString([]byte(credential)))
	}
	_, err := conn.Write([]byte(strings.Join(headers, "\r\n") + "\r\n\r\n"))
	return err
}

func nativeHTTPConnectStatusOK(statusLine string) bool {
	parts := strings.Fields(statusLine)
	return len(parts) >= 2 && len(parts[1]) == 3 && parts[1][0] == '2'
}

func nativeAndroidDialTLSContext(dialContext func(context.Context, string, string) (net.Conn, error)) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network string, addr string) (net.Conn, error) {
		if dialContext == nil {
			return nil, fmt.Errorf("native TLS dialer is not configured")
		}
		rawConn, err := dialContext(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			_ = rawConn.Close()
			return nil, err
		}
		tlsConn := utls.UClient(rawConn, &utls.Config{ServerName: host, InsecureSkipVerify: true, NextProtos: []string{"http/1.1"}}, utls.HelloCustom)
		if err := tlsConn.ApplyPreset(nativeAndroidOkHTTPClientHelloSpec()); err != nil {
			_ = rawConn.Close()
			return nil, err
		}
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = rawConn.Close()
			return nil, err
		}
		return tlsConn, nil
	}
}

func nativeAndroidOkHTTPClientHelloSpec() *utls.ClientHelloSpec {
	return &utls.ClientHelloSpec{
		CipherSuites: []uint16{
			utls.TLS_AES_256_GCM_SHA384,
			utls.TLS_AES_128_GCM_SHA256,
			utls.TLS_CHACHA20_POLY1305_SHA256,
			utls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			utls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			utls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
			utls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			utls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			utls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
			utls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
			utls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
			utls.TLS_RSA_WITH_AES_128_GCM_SHA256,
			utls.TLS_RSA_WITH_AES_256_GCM_SHA384,
			utls.TLS_RSA_WITH_AES_128_CBC_SHA,
			utls.TLS_RSA_WITH_AES_256_CBC_SHA,
		},
		CompressionMethods: []byte{0},
		Extensions: []utls.TLSExtension{
			&utls.SNIExtension{},
			&utls.ExtendedMasterSecretExtension{},
			&utls.RenegotiationInfoExtension{Renegotiation: utls.RenegotiateOnceAsClient},
			&utls.SupportedCurvesExtension{Curves: []utls.CurveID{
				utls.X25519,
				utls.CurveP256,
				utls.CurveP384,
			}},
			&utls.SupportedPointsExtension{SupportedPoints: []byte{0}},
			&utls.SessionTicketExtension{},
			&utls.ALPNExtension{AlpnProtocols: []string{"http/1.1"}},
			&utls.StatusRequestExtension{},
			&utls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: []utls.SignatureScheme{
				utls.ECDSAWithP256AndSHA256,
				utls.PSSWithSHA256,
				utls.PKCS1WithSHA256,
				utls.ECDSAWithP384AndSHA384,
				utls.PSSWithSHA384,
				utls.PKCS1WithSHA384,
				utls.PSSWithSHA512,
				utls.PKCS1WithSHA512,
				utls.PKCS1WithSHA1,
			}},
			&utls.KeyShareExtension{KeyShares: []utls.KeyShare{{Group: utls.X25519}}},
			&utls.PSKKeyExchangeModesExtension{Modes: []uint8{utls.PskModeDHE}},
			&utls.SupportedVersionsExtension{Versions: []uint16{utls.VersionTLS13, utls.VersionTLS12}},
		},
	}
}

func (c *nativeHTTPClient) postWASafe(ctx context.Context, endpoint string, plain string, userAgent string, attestation nativeSoftwareAttestation) (map[string]any, string, error) {
	return c.postWASafeEnvelope(ctx, endpoint, plain, userAgent, attestation)
}

func (c *nativeHTTPClient) postWASafeNoAuth(ctx context.Context, endpoint string, plain string, userAgent string) (map[string]any, error) {
	data, _, err := c.postWASafeEnvelope(ctx, endpoint, plain, userAgent, nativeSoftwareAttestation{})
	return data, err
}

func (c *nativeHTTPClient) postWASafeEnvelope(ctx context.Context, endpoint string, plain string, userAgent string, attestation nativeSoftwareAttestation) (map[string]any, string, error) {
	if endpoint == "" {
		return nil, "", fmt.Errorf("endpoint is not configured")
	}
	if c == nil || c.dialTLSContext == nil {
		return nil, "", fmt.Errorf("native HTTP client is not configured")
	}
	envelope, err := buildWASafeEnvelope([]byte(plain), defaultWASafeServerPublicKeyHex, attestation)
	if err != nil {
		return nil, "", err
	}
	endpointURL, err := url.Parse(endpoint)
	if err != nil {
		return nil, "", err
	}
	if endpointURL.Scheme != "https" || endpointURL.Host == "" {
		return nil, "", fmt.Errorf("native endpoint must be https")
	}
	effectiveUserAgent := shared.FirstNonEmpty(userAgent, nativeUserAgent(DefaultWAAppVersion))
	logWASafeEnvelopeShape(endpointURL, envelope, effectiveUserAgent)
	resp, err := c.postOrderedForm(ctx, endpointURL, envelope.Body, effectiveUserAgent, envelope.Authorization)
	if err != nil {
		return nil, envelope.Enc, err
	}
	defer resp.Body.Close()
	body := io.Reader(resp.Body)
	if strings.EqualFold(resp.Header.Get("Content-Encoding"), "gzip") {
		gzipReader, gzipErr := gzip.NewReader(resp.Body)
		if gzipErr != nil {
			return nil, envelope.Enc, gzipErr
		}
		defer gzipReader.Close()
		body = gzipReader
	}
	data, _ := io.ReadAll(io.LimitReader(body, 1<<20))
	result := map[string]any{"status_code": float64(resp.StatusCode), "response_text": string(data)}
	var parsed map[string]any
	if json.Unmarshal(data, &parsed) == nil {
		for key, value := range parsed {
			result[key] = value
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return result, envelope.Enc, fmt.Errorf("wasafe endpoint returned status %d", resp.StatusCode)
	}
	return result, envelope.Enc, nil
}

func (c *nativeHTTPClient) postOrderedForm(ctx context.Context, endpoint *url.URL, body string, userAgent string, authorization string) (*http.Response, error) {
	host := endpoint.Host
	address := nativeEndpointAddress(endpoint)
	conn, err := c.dialTLSContext(ctx, "tcp", address)
	if err != nil {
		return nil, err
	}
	release := true
	defer func() {
		if release {
			_ = conn.Close()
		}
	}()
	if deadline := nativeRequestDeadline(ctx, c.timeout); !deadline.IsZero() {
		_ = conn.SetDeadline(deadline)
	}
	headers := []string{
		"POST " + nativeRequestURI(endpoint) + " HTTP/1.1",
		"User-Agent: " + userAgent,
		"WaMsysRequest: 1",
	}
	if authorization != "" {
		headers = append(headers, "Authorization: "+authorization)
	}
	headers = append(headers,
		"request_token: "+strings.ToUpper(newUUIDString()),
		"X-Forwarded-Host: "+defaultNativeHTTPForwardedHost,
		"Host: "+host,
		"Content-Type: application/x-www-form-urlencoded",
		fmt.Sprintf("Content-Length: %d", len(body)),
		"Connection: Keep-Alive",
		"Accept-Encoding: gzip",
	)
	if _, err := conn.Write([]byte(strings.Join(headers, "\r\n") + "\r\n\r\n" + body)); err != nil {
		return nil, err
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodPost})
	if err != nil {
		return nil, err
	}
	release = false
	resp.Body = &nativeResponseBody{ReadCloser: resp.Body, conn: conn}
	return resp, nil
}

func logWASafeEnvelopeShape(endpoint *url.URL, envelope waSafeEnvelope, userAgent string) {
	if endpoint == nil {
		return
	}
	path := nativeRegistrationEndpointKind(endpoint)
	if path == "" {
		return
	}
	log.Printf(
		"wa_registration_envelope_shape kind=%s app_version=%s body_len=%d enc_len=%d h_len=%d authorization=%t",
		shared.ProbeLogValue(path),
		shared.ProbeLogValue(nativeAppVersionFromUserAgent(userAgent)),
		len(envelope.Body),
		len(envelope.Enc),
		nativeWASafeHLength(envelope.Body),
		envelope.Authorization != "",
	)
}

func nativeRegistrationEndpointKind(endpoint *url.URL) string {
	if endpoint == nil {
		return ""
	}
	raw := endpoint.Query().Get("_")
	switch raw {
	case "/v2/reg_onboard_abprop":
		return "abprop"
	case "/v2/exist":
		return "exist"
	case "/v2/code":
		return "code"
	case "/v2/register":
		return "register"
	default:
		return ""
	}
}

func nativeWASafeHLength(body string) int {
	for _, part := range strings.Split(body, "&") {
		if strings.HasPrefix(part, "H=") {
			return len(strings.TrimPrefix(part, "H="))
		}
	}
	return 0
}

func nativeEndpointAddress(endpoint *url.URL) string {
	if endpoint == nil {
		return ""
	}
	if _, _, err := net.SplitHostPort(endpoint.Host); err == nil {
		return endpoint.Host
	}
	return net.JoinHostPort(endpoint.Hostname(), "443")
}

func nativeRequestURI(endpoint *url.URL) string {
	if endpoint == nil {
		return "/"
	}
	uri := endpoint.RequestURI()
	if uri == "" {
		return "/"
	}
	return uri
}

func nativeRequestDeadline(ctx context.Context, timeout time.Duration) time.Time {
	deadline := time.Time{}
	if timeout > 0 {
		deadline = time.Now().Add(timeout)
	}
	if ctxDeadline, ok := ctx.Deadline(); ok && (deadline.IsZero() || ctxDeadline.Before(deadline)) {
		deadline = ctxDeadline
	}
	return deadline
}

type nativeResponseBody struct {
	io.ReadCloser
	conn net.Conn
}

func (b *nativeResponseBody) Close() error {
	err := b.ReadCloser.Close()
	if b.conn != nil {
		if closeErr := b.conn.Close(); err == nil {
			err = closeErr
		}
	}
	return err
}

func encryptWASafe(plaintext []byte, serverPublicKeyHex string) (string, error) {
	serverRaw, err := hex.DecodeString(serverPublicKeyHex)
	if err != nil {
		return "", err
	}
	serverPublic, err := ecdh.X25519().NewPublicKey(serverRaw)
	if err != nil {
		return "", err
	}
	ephemeral, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	shared, err := ephemeral.ECDH(serverPublic)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(shared)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, make([]byte, 12), plaintext, nil)
	combined := append(append([]byte{}, ephemeral.PublicKey().Bytes()...), sealed...)
	return b64u(combined), nil
}

func encHash(enc string) string {
	sum := sha256.Sum256([]byte(enc))
	return hex.EncodeToString(sum[:])
}
