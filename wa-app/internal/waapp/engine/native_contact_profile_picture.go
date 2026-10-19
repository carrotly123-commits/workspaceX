package engine

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
)

const (
	DefaultContactProfilePictureTimeout = 20 * time.Second
	profilePictureDirectPathHost        = "https://pps.whatsapp.net"
	ProfilePictureDownloadMaxBytes      = 2 << 20
	profilePictureTypeImage             = "image"
	profilePictureTypePreview           = "preview"
)

var contactProfilePictureQueryTypes = []string{profilePictureTypeImage, profilePictureTypePreview}

type contactProfilePictureLocation struct {
	ID         string
	DirectPath string
	URL        string
	InlineData []byte
}

type chatdIQSender interface {
	sendIQ(context.Context, NativeState, string, string, chatdNode, string) (chatdNode, chatdSessionUpdate, error)
}

func (e *contactsService) ResolveContactProfilePicture(ctx context.Context, input wacore.EngineContactProfilePictureInput) wacore.EngineContactProfilePictureResult {
	return e.resolveContactProfilePictureWithSender(ctx, input, nil)
}

func (e *contactsService) resolveContactProfilePictureWithSender(ctx context.Context, input wacore.EngineContactProfilePictureInput, sender chatdIQSender) wacore.EngineContactProfilePictureResult {
	jid := wacore.NormalizeWAJID(input.ContactJID)
	if input.WAAccountID == "" || input.ClientProfileID == "" || input.RegisteredIdentityID == "" || jid == "" {
		return wacore.EngineContactProfilePictureResult{Err: shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "WA contact profile picture input is incomplete", false)}
	}
	state, err := e.loadState(ctx, input.ClientProfileID)
	if err != nil {
		return wacore.EngineContactProfilePictureResult{Err: err}
	}
	state.ensureMaps()
	if state.ChatStatic.Private == "" || state.ChatStatic.Public == "" {
		state.ChatStatic = ensureChatStatic(state.ChatStatic)
		if err := e.SaveState(ctx, input.ClientProfileID, state); err != nil {
			return wacore.EngineContactProfilePictureResult{Err: err}
		}
	}
	timeout := input.RemoteTimeout
	if timeout <= 0 {
		timeout = DefaultContactProfilePictureTimeout
	}
	operationCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if sender == nil {
		proxyURL, err := e.proxyURL()
		if err != nil {
			return wacore.EngineContactProfilePictureResult{Err: err}
		}
		cfg := chatdConfigForState(proxyURL, state, timeout)
		cfg.MaxEndpoints = 1
		sender = newChatdClient(cfg)
	}
	locations, update, err := e.contactProfilePictureLocationsFromProfileIQ(operationCtx, sender, state, input, jid)
	if applyChatdSessionUpdateState(&state, update) {
		_ = e.SaveState(ctx, input.ClientProfileID, state)
	}
	if err != nil && len(locations) == 0 {
		return wacore.EngineContactProfilePictureResult{Err: err}
	}
	var lastErr error
	for _, location := range locations {
		if !contactProfilePictureLocationDownloadable(location) {
			lastErr = shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND, "WA profile picture not found", false)
			continue
		}
		if len(location.InlineData) > 0 {
			contentType, err := ProfilePictureContentType(location.InlineData, "")
			return wacore.EngineContactProfilePictureResult{ProfilePictureID: location.ID, ContentType: contentType, Data: location.InlineData, Err: err}
		}
		data, contentType, downloadErr := e.downloadContactProfilePicture(operationCtx, location, nativeUserAgentForState(state, input.AppVersion))
		if downloadErr == nil {
			return wacore.EngineContactProfilePictureResult{ProfilePictureID: location.ID, ContentType: contentType, Data: data}
		}
		lastErr = downloadErr
	}
	if lastErr != nil {
		return wacore.EngineContactProfilePictureResult{Err: lastErr}
	}
	if err != nil {
		return wacore.EngineContactProfilePictureResult{Err: err}
	}
	return wacore.EngineContactProfilePictureResult{Err: shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND, "WA profile picture not found", false)}
}

func (e *contactsService) contactProfilePictureLocationsFromProfileIQ(ctx context.Context, sender chatdIQSender, state NativeState, input wacore.EngineContactProfilePictureInput, jid string) ([]contactProfilePictureLocation, chatdSessionUpdate, error) {
	targets := contactProfilePictureTargets(jid, input.ContactPNJID)
	if len(targets) == 0 {
		return nil, chatdSessionUpdate{}, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "WA contact profile picture target is incomplete", false)
	}
	locations := []contactProfilePictureLocation{}
	var lastUpdate chatdSessionUpdate
	var lastErr error
	for _, target := range targets {
		for _, pictureType := range contactProfilePictureQueryTypes {
			for _, pictureID := range contactProfilePictureRequestIDs(input.ContactPictureID) {
				trustedContactToken := trustedContactTokenForProfilePicture(state, target, e.clock.Now())
				request := buildContactProfilePictureIQ(e.ids.NewID("wappic_"), target, pictureType, pictureID, trustedContactToken)
				response, update, err := sender.sendIQ(ctx, state, input.RegisteredIdentityID, input.AppVersion, request, "profile picture iq timed out")
				lastUpdate = mergeContactProfilePictureUpdate(lastUpdate, update)
				applyChatdSessionUpdateState(&state, update)
				if err != nil {
					if ctx.Err() != nil {
						return locations, lastUpdate, err
					}
					lastErr = err
					logWAContactProfilePictureIQFailure(target, pictureType, pictureID != "", err)
					continue
				}
				location, err := contactProfilePictureLocationFromIQ(response)
				if err != nil {
					lastErr = err
					logWAContactProfilePictureIQFailure(target, pictureType, pictureID != "", err)
					continue
				}
				if !contactProfilePictureLocationDownloadable(location) {
					lastErr = shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND, "WA profile picture download location not found", false)
					logWAContactProfilePictureIQFailure(target, pictureType, pictureID != "", lastErr)
					continue
				}
				locations = append(locations, location)
				logWAContactProfilePictureIQLocation(target, pictureType, pictureID != "", location)
				if len(location.InlineData) > 0 {
					return locations, lastUpdate, nil
				}
			}
		}
	}
	if len(locations) > 0 {
		return locations, lastUpdate, nil
	}
	if lastErr == nil {
		lastErr = shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND, "WA profile picture not found", false)
	}
	return nil, lastUpdate, lastErr
}

func mergeContactProfilePictureUpdate(current chatdSessionUpdate, next chatdSessionUpdate) chatdSessionUpdate {
	return mergeChatdSessionUpdate(current, next)
}

func contactProfilePictureTargets(jid string, pnJID string) []string {
	jid = wacore.NormalizeWAJID(jid)
	pnJID = wacore.NormalizeWAJID(pnJID)
	candidates := []string{pnJID, jid}
	out := []string{}
	seen := map[string]struct{}{}
	for _, candidate := range candidates {
		candidate = wacore.NormalizeWAJID(candidate)
		if candidate == "" {
			continue
		}
		if _, ok := seen[candidate]; ok {
			continue
		}
		seen[candidate] = struct{}{}
		out = append(out, candidate)
	}
	return out
}

func contactProfilePictureRequestIDs(pictureID string) []string {
	pictureID = contactProfilePictureRequestID(pictureID)
	if pictureID == "" {
		return []string{""}
	}
	return []string{pictureID, ""}
}

func buildContactProfilePictureIQ(id string, jid string, pictureType string, pictureID string, trustedContactToken []byte) chatdNode {
	pictureType = shared.FirstNonEmpty(pictureType, profilePictureTypeImage)
	pictureAttrs := map[string]string{"type": pictureType}
	if contactProfilePictureNeedsURLQuery(jid, pictureType) {
		pictureAttrs["query"] = "url"
	}
	if requestID := contactProfilePictureRequestID(pictureID); requestID != "" {
		pictureAttrs["id"] = requestID
	}
	picture := chatdNode{Tag: "picture", Attrs: pictureAttrs}
	if len(trustedContactToken) > 0 {
		picture.Content = []chatdNode{{Tag: "tctoken", Content: bytes.Clone(trustedContactToken)}}
	}
	return chatdNode{
		Tag:     "iq",
		Attrs:   map[string]string{"xmlns": "w:profile:picture", "id": id, "to": "s.whatsapp.net", "type": "get", "target": wacore.NormalizeWAJID(jid)},
		Content: []chatdNode{picture},
	}
}

func contactProfilePictureNeedsURLQuery(jid string, pictureType string) bool {
	return pictureType == profilePictureTypeImage || contactProfilePictureTargetNeedsURLQuery(jid)
}

func contactProfilePictureTargetNeedsURLQuery(jid string) bool {
	jid = wacore.NormalizeWAJID(jid)
	user := strings.SplitN(jid, "@", 2)[0]
	user = strings.SplitN(user, ":", 2)[0]
	value, ok := parsePositiveInt64(user)
	if !ok {
		return false
	}
	return (value >= 13135550000 && value <= 13135559999) || (value >= 13165550000 && value <= 13165550099)
}

func parsePositiveInt64(value string) (int64, bool) {
	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	return parsed, err == nil && parsed > 0
}

func (e *contactsService) downloadContactProfilePicture(ctx context.Context, location contactProfilePictureLocation, userAgent string) ([]byte, string, error) {
	httpClient, err := e.httpForProxy()
	if err != nil {
		return nil, "", err
	}
	data, contentType, err := httpClient.getProfilePicture(ctx, location, userAgent)
	if err == nil {
		return data, contentType, nil
	}
	if strings.TrimSpace(e.activeProxyURL) == "" || !profilePictureDownloadRetryable(err) {
		return nil, "", err
	}
	logWAContactProfilePictureDownloadFallback(err)
	directClient, directErr := newNativeHTTPClient("")
	if directErr != nil {
		return nil, "", err
	}
	defer directClient.CloseIdleConnections()
	data, contentType, directErr = directClient.getProfilePicture(ctx, location, userAgent)
	if directErr == nil {
		return data, contentType, nil
	}
	return nil, "", err
}

func logWAContactProfilePictureIQFailure(target string, pictureType string, requestIDPresent bool, err error) {
	if err == nil {
		return
	}
	log.Printf("WA contact profile picture iq failed target_kind=%s picture_type=%s request_id=%t reason=%s", contactProfilePictureTargetKind(target), shared.SafeProxyLogToken(pictureType, "unknown"), requestIDPresent, ContactProfilePictureFailureReason(err))
}

func logWAContactProfilePictureIQLocation(target string, pictureType string, requestIDPresent bool, location contactProfilePictureLocation) {
	log.Printf("WA contact profile picture iq location target_kind=%s picture_type=%s request_id=%t inline=%t direct_path=%t url=%t", contactProfilePictureTargetKind(target), shared.SafeProxyLogToken(pictureType, "unknown"), requestIDPresent, len(location.InlineData) > 0, location.DirectPath != "", location.URL != "")
}

func logWAContactProfilePictureDownloadFallback(err error) {
	log.Printf("WA contact profile picture download retry without proxy reason=%s", ContactProfilePictureFailureReason(err))
}

func contactProfilePictureTargetKind(jid string) string {
	jid = wacore.NormalizeWAJID(jid)
	switch {
	case strings.HasSuffix(jid, "@lid"):
		return "lid"
	case strings.HasSuffix(jid, "@s.whatsapp.net"):
		return "pn"
	case jid == "":
		return "empty"
	default:
		return "other"
	}
}

func contactProfilePictureRequestID(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || shared.DigitsOnly(value) != value || strings.TrimLeft(value, "0") == "" {
		return ""
	}
	return value
}

func contactProfilePictureLocationFromIQ(response chatdNode) (contactProfilePictureLocation, error) {
	if response.Attrs["type"] == "error" {
		return contactProfilePictureLocation{}, contactProfilePictureIQError(response)
	}
	picture, ok := findChatdNode(response, "picture")
	if !ok {
		return contactProfilePictureLocation{}, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND, "WA profile picture not found", false)
	}
	return contactProfilePictureLocationFromPicture(picture)
}

func contactProfilePictureIQError(response chatdNode) error {
	code := strings.TrimSpace(response.Attrs["code"])
	if errorNode, ok := findChatdNode(response, "error"); ok {
		code = shared.FirstNonEmpty(code, strings.TrimSpace(errorNode.Attrs["code"]))
	}
	if code == "404" || code == "410" {
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND, "WA profile picture not found", false)
	}
	return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, "WA profile picture request was rejected", false)
}

func contactProfilePictureLocationFromPicture(picture chatdNode) (contactProfilePictureLocation, error) {
	status := strings.TrimSpace(picture.Attrs["status"])
	if status != "" && status != "200" && status != "ok" {
		return contactProfilePictureLocation{}, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND, "WA profile picture not found", false)
	}
	location := contactProfilePictureLocation{
		ID:         contactProfilePictureIDFromPicture(picture),
		DirectPath: strings.TrimSpace(picture.Attrs["direct_path"]),
		URL:        strings.TrimSpace(picture.Attrs["url"]),
	}
	if data, ok := picture.Content.([]byte); ok && len(data) > 0 {
		location.InlineData = data
	}
	if len(location.InlineData) == 0 && location.DirectPath == "" && location.URL == "" {
		return contactProfilePictureLocation{}, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND, "WA profile picture not found", false)
	}
	return location, nil
}

func contactProfilePictureIDFromPicture(picture chatdNode) string {
	return strings.TrimSpace(shared.FirstNonEmpty(picture.Attrs["id"], picture.Attrs["photo_id"], picture.Attrs["picture_id"]))
}

func contactProfilePictureLocationDownloadable(location contactProfilePictureLocation) bool {
	if len(location.InlineData) > 0 {
		return true
	}
	if _, ok := normalizeProfilePictureURL(location.URL); ok {
		return true
	}
	directPath := strings.TrimSpace(location.DirectPath)
	if !profilePictureDirectPathSigned(directPath) {
		return false
	}
	_, ok := normalizeProfilePictureURL(directPath)
	return ok
}

func (c *nativeHTTPClient) getProfilePicture(ctx context.Context, location contactProfilePictureLocation, userAgent string) ([]byte, string, error) {
	endpoints := profilePictureDownloadURLs(location)
	var lastErr error
	for _, endpoint := range endpoints {
		for attempt := 0; attempt < 3; attempt++ {
			if attempt > 0 {
				if err := sleepWithContext(ctx, 250*time.Millisecond); err != nil {
					return nil, "", err
				}
			}
			data, contentType, err := c.getProfilePictureOnce(ctx, endpoint, userAgent)
			if err == nil {
				return data, contentType, nil
			}
			lastErr = err
			if !profilePictureDownloadRetryable(err) {
				break
			}
		}
	}
	if lastErr == nil {
		lastErr = shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND, "WA profile picture not found", false)
	}
	return nil, "", lastErr
}

func (c *nativeHTTPClient) getProfilePictureOnce(ctx context.Context, endpoint string, userAgent string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", shared.FirstNonEmpty(userAgent, nativeUserAgent(DefaultWAAppVersion)))
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	data, err := readLimitedProfilePicture(resp.Body)
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
		return nil, "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_MESSAGE_NOT_FOUND, "WA profile picture not found", false)
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, "", profilePictureHTTPError(resp.StatusCode)
	}
	contentType, err := ProfilePictureContentType(data, resp.Header.Get("Content-Type"))
	if err != nil {
		return nil, "", err
	}
	return data, contentType, nil
}

func profilePictureDownloadURLs(location contactProfilePictureLocation) []string {
	out := []string{}
	seen := map[string]struct{}{}
	appendEndpoint := func(endpoint string) {
		if endpoint == "" {
			return
		}
		if _, ok := seen[endpoint]; ok {
			return
		}
		seen[endpoint] = struct{}{}
		out = append(out, endpoint)
	}
	if endpoint, ok := normalizeProfilePictureURL(location.URL); ok {
		appendEndpoint(endpoint)
	}
	directPath := strings.TrimSpace(location.DirectPath)
	if profilePictureDirectPathSigned(directPath) {
		if endpoint, ok := normalizeProfilePictureURL(directPath); ok {
			appendEndpoint(endpoint)
		}
	}
	return out
}

func normalizeProfilePictureURL(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", false
	}
	if strings.HasPrefix(value, "/") {
		return profilePictureDirectPathHost + value, true
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed == nil {
		return "", false
	}
	if parsed.Scheme == "" && strings.HasPrefix(parsed.Path, "/") {
		return profilePictureDirectPathHost + parsed.String(), true
	}
	if (parsed.Scheme != "https" && parsed.Scheme != "http") || !profilePictureURLHostAllowed(parsed.Host) {
		return "", false
	}
	return parsed.String(), true
}

func profilePictureDirectPathSigned(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return false
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed == nil {
		return false
	}
	query := parsed.Query()
	return query.Get("oe") != "" && query.Get("oh") != ""
}

func profilePictureURLHostAllowed(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if cut, _, ok := strings.Cut(host, ":"); ok {
		host = cut
	}
	return host == "whatsapp.net" || strings.HasSuffix(host, ".whatsapp.net") ||
		host == "fbcdn.net" || strings.HasSuffix(host, ".fbcdn.net") ||
		host == "fbsbx.com" || strings.HasSuffix(host, ".fbsbx.com")
}

func readLimitedProfilePicture(reader io.Reader) ([]byte, error) {
	var buf bytes.Buffer
	limited := io.LimitReader(reader, ProfilePictureDownloadMaxBytes+1)
	if _, err := buf.ReadFrom(limited); err != nil {
		return nil, err
	}
	data := buf.Bytes()
	if len(data) > ProfilePictureDownloadMaxBytes {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, "WA profile picture is too large", false)
	}
	return data, nil
}

func ProfilePictureContentType(data []byte, header string) (string, error) {
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(header, ";")[0]))
	if profilePictureContentTypeAllowed(contentType) {
		return contentType, nil
	}
	detected := strings.ToLower(http.DetectContentType(data))
	if profilePictureContentTypeAllowed(detected) {
		return detected, nil
	}
	return "", shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, "WA profile picture content type is not supported", false)
}

func profilePictureContentTypeAllowed(contentType string) bool {
	switch contentType {
	case "image/jpeg", "image/png", "image/webp":
		return true
	default:
		return false
	}
}

func profilePictureHTTPError(statusCode int) error {
	retryable := statusCode == http.StatusTooManyRequests || statusCode >= http.StatusInternalServerError
	return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_ROUTE_UNAVAILABLE, fmt.Sprintf("WA profile picture download failed with HTTP %d", statusCode), retryable)
}

func profilePictureDownloadRetryable(err error) bool {
	appErr, ok := err.(*shared.AppError)
	if !ok {
		return true
	}
	return appErr.Retryable
}

func sleepWithContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func ContactProfilePictureFailureReason(err error) string {
	if err == nil {
		return "unknown"
	}
	if errors.Is(err, context.Canceled) {
		return "context_canceled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	text := strings.ToLower(err.Error())
	switch {
	case strings.Contains(text, "username/password authentication failed"):
		return "proxy_auth_failed"
	case strings.Contains(text, "socks5 connect failed"):
		return "proxy_connect_failed"
	case strings.Contains(text, "proxy"):
		return "proxy_failed"
	case strings.Contains(text, "timeout") || strings.Contains(text, "deadline"):
		return "timeout"
	case strings.Contains(text, "no such host"):
		return "dns_failed"
	case strings.Contains(text, "connection refused"):
		return "connect_refused"
	case strings.Contains(text, "tls"):
		return "tls_failed"
	}
	reason := chatdFailureReason(text)
	if reason != "" && reason != "chatd_failed" {
		return shared.SafeProxyLogToken(reason, "chatd_failed")
	}
	return "unexpected_failure"
}
