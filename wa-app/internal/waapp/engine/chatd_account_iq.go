package engine

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
)

const (
	defaultAccountIQTimeout                = 32 * time.Second
	defaultAccountSettingsOpenTimeout      = 8 * time.Second
	DefaultAccountSettingsOperationTimeout = 45 * time.Second
	defaultAccountSettingsProxyTTL         = DefaultAccountSettingsOperationTimeout + 5*time.Second
	accountSettingsRequestTimeoutMessage   = "WA account settings request timed out"
	accountSettingsIQTimeoutMessage        = "account settings iq timed out"
)

func (c *chatdClient) sendAccountIQ(ctx context.Context, state NativeState, input wacore.EngineAccountSettingsInput, appVersion string, request chatdNode) (chatdNode, chatdSessionUpdate, error) {
	return c.sendIQ(ctx, state, input.RegisteredIdentityID, appVersion, request, accountSettingsIQTimeoutMessage)
}

func (c *chatdClient) sendIQ(ctx context.Context, state NativeState, registeredIdentityID string, appVersion string, request chatdNode, timeoutMessage string) (chatdNode, chatdSessionUpdate, error) {
	session, err := c.openSession(ctx, state, registeredIdentityID, defaultLoginPayload, appVersion)
	if err != nil {
		return chatdNode{}, chatdSessionUpdate{}, err
	}
	defer session.Close()
	response, _, update, err := session.sendIQ(ctx, wacore.EngineMessageInput{}, request, c.cfg.Timeout, timeoutMessage)
	return response, update, err
}

func (s *chatdSession) sendIQ(ctx context.Context, input wacore.EngineMessageInput, request chatdNode, timeout time.Duration, timeoutMessage string) (chatdNode, []chatdReceivedItem, chatdSessionUpdate, error) {
	if s == nil || s.conn == nil {
		return chatdNode{}, nil, chatdSessionUpdate{}, fmt.Errorf("chatd session is not open")
	}
	if timeout <= 0 {
		timeout = defaultChatdReadWindow
	}
	conn := s.conn
	transport := s.transport
	update := s.update()
	deadline := time.Now().Add(timeout)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	if !deadline.After(time.Now()) {
		return chatdNode{}, nil, update, errors.New(timeoutMessage)
	}
	_ = conn.SetDeadline(deadline)
	defer func() { _ = conn.SetDeadline(time.Time{}) }()
	if err := transport.sendNode(request); err != nil {
		return chatdNode{}, nil, update, chatdPhase("chatd iq write", err)
	}
	items := []chatdReceivedItem{}
	requestID := request.Attrs["id"]
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return chatdNode{}, items, update, ctx.Err()
		}
		_ = conn.SetReadDeadline(deadline)
		node, err := transport.readNode()
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				return chatdNode{}, items, update, errors.New(timeoutMessage)
			}
			return chatdNode{}, items, update, chatdPhase("chatd iq read", err)
		}
		nextUpdate, nextItems, err := s.consumeIncomingNode(input, node, update, time.Now())
		update = nextUpdate
		items = append(items, nextItems...)
		if err != nil {
			return chatdNode{}, items, update, err
		}
		if node.Tag == "iq" && node.Attrs["id"] == requestID {
			return node, items, update, nil
		}
	}
	return chatdNode{}, items, update, errors.New(timeoutMessage)
}

func chatdIQError(node chatdNode) error {
	if node.Attrs["type"] != "error" {
		return nil
	}
	message := "WA account settings request was rejected"
	if errorNode, ok := chatdChild(node, "error"); ok {
		if code := strings.TrimSpace(errorNode.Attrs["code"]); code != "" {
			message = message + chatdIQErrorCodeMessage(code)
		}
	}
	return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, message, false)
}

func chatdIQErrorCodeMessage(code string) string {
	if strings.HasPrefix(code, "<tok:") && strings.HasSuffix(code, ">") {
		return " (upstream error code could not be decoded)"
	}
	if code == "533" {
		return " (WA rejected this settings operation for this account right now; code 533)"
	}
	return " (code " + code + ")"
}

func chatdChild(node chatdNode, tag string) (chatdNode, bool) {
	for _, child := range chatdChildren(node) {
		if child.Tag == tag {
			return child, true
		}
	}
	return chatdNode{}, false
}

func chatdChildren(node chatdNode) []chatdNode {
	children, ok := node.Content.([]chatdNode)
	if !ok {
		return nil
	}
	return children
}

func chatdNodeValue(node chatdNode, name string) string {
	if value := strings.TrimSpace(node.Attrs[name]); value != "" {
		return value
	}
	if child, ok := chatdChild(node, name); ok {
		return chatdNodeText(child)
	}
	return ""
}

func chatdNodeText(node chatdNode) string {
	switch value := node.Content.(type) {
	case string:
		return strings.TrimSpace(value)
	case []byte:
		return strings.TrimSpace(string(value))
	default:
		return ""
	}
}

func chatdNodeBool(node chatdNode, name string) bool {
	value, _ := chatdNodeBoolValue(node, name)
	return value
}

func chatdNodeBoolValue(node chatdNode, name string) (bool, bool) {
	value, ok := chatdNodeStringValue(node, name)
	if !ok {
		return false, false
	}
	switch strings.ToLower(value) {
	case "true", "1", "yes", "ok", "success":
		return true, true
	case "false", "0", "no", "fail", "failed":
		return false, true
	default:
		return false, false
	}
}

func chatdNodeStringValue(node chatdNode, name string) (string, bool) {
	if value := strings.TrimSpace(node.Attrs[name]); value != "" {
		return value, true
	}
	child, ok := chatdChild(node, name)
	if !ok {
		return "", false
	}
	if value := strings.TrimSpace(chatdNodeText(child)); value != "" {
		return value, true
	}
	for _, attr := range []string{"status", "result", "code"} {
		if value := strings.TrimSpace(child.Attrs[attr]); value != "" {
			return value, true
		}
	}
	return "", true
}

func chatdNodeStatus(node chatdNode, name string) string {
	value, _ := chatdNodeStringValue(node, name)
	return strings.ToLower(strings.TrimSpace(value))
}

func chatdNodeDuration(node chatdNode, name string) time.Duration {
	value := strings.TrimSpace(chatdNodeValue(node, name))
	if value == "" {
		return 0
	}
	seconds, err := strconv.ParseInt(value, 10, 64)
	if err != nil || seconds <= 0 {
		return 0
	}
	return time.Duration(seconds) * time.Second
}
