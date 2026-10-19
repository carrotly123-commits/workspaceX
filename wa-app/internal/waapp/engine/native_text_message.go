package engine

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"sort"
	"strings"
	"time"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
)

const DefaultTextMessageSendTimeout = 20 * time.Second

const textMessageAckTimeoutMessage = "WA text message send acknowledgement timed out"

type chatdTextMessageSendResult struct {
	wacore.EngineTextMessageResult
	Items  []chatdReceivedItem
	Update chatdSessionUpdate
}

func (e *messagingService) SendTextMessage(ctx context.Context, input wacore.EngineTextMessageInput) wacore.EngineTextMessageResult {
	if e == nil {
		return wacore.EngineTextMessageResult{Err: shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_INTERNAL, "native engine is required", false)}
	}
	state, err := e.loadState(ctx, input.ClientProfileID)
	if err != nil {
		return wacore.EngineTextMessageResult{Err: err}
	}
	state.ensureMaps()
	state.ChatStatic = ensureChatStatic(state.ChatStatic)
	proxyURL, err := e.proxyURL()
	if err != nil {
		return wacore.EngineTextMessageResult{Err: err}
	}
	timeout := textMessageSendTimeout(input.RemoteTimeout)
	operationCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	client := newChatdClient(chatdConfigForState(proxyURL, state, timeout))
	session, err := client.openSession(operationCtx, state, input.RegisteredIdentityID, defaultLoginPayload, input.AppVersion)
	if err != nil {
		return wacore.EngineTextMessageResult{Err: chatdReceiveError(err)}
	}
	defer session.Close()
	receiveInput := wacore.EngineMessageInput{WAAccountID: input.WAAccountID, ClientProfileID: input.ClientProfileID, RegisteredIdentityID: input.RegisteredIdentityID, AppVersion: input.AppVersion}
	result := e.sendTextMessageOnSession(operationCtx, session, &state, input, receiveInput, timeout)
	if err := e.applyTextMessageSendUpdate(operationCtx, input.ClientProfileID, &state, receiveInput, result.Items, result.Update); err != nil && result.Err == nil {
		result.Err = err
	}
	return result.EngineTextMessageResult
}

func (e *LongConnectionNativeEngine) SendTextMessage(ctx context.Context, input wacore.EngineTextMessageInput) wacore.EngineTextMessageResult {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return wacore.EngineTextMessageResult{Err: shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_CONFLICT, "WA long connection runner is closed", true)}
	}
	state, err := e.loadState(ctx, input.ClientProfileID)
	if err != nil {
		return wacore.EngineTextMessageResult{Err: err}
	}
	state.ensureMaps()
	state.ChatStatic = ensureChatStatic(state.ChatStatic)
	messageInput := e.textMessageReceiveInput(input)
	session, err := e.ensureSessionForIQLocked(ctx, messageInput, state)
	if err != nil {
		e.closeLocked()
		return wacore.EngineTextMessageResult{Err: chatdReceiveError(err)}
	}
	timeout := contextBoundTimeout(ctx, textMessageSendTimeout(input.RemoteTimeout))
	result := e.NativeEngine.sendTextMessageOnSession(ctx, session, &state, input, messageInput, timeout)
	e.bufferPendingLocked(result.Items, result.Update)
	if err := e.NativeEngine.applyTextMessageSendUpdate(ctx, input.ClientProfileID, &state, messageInput, result.Items, result.Update); err != nil && result.Err == nil {
		result.Err = err
	}
	if result.Err != nil && isChatdSendError(result.Err) {
		e.closeLocked()
	}
	return result.EngineTextMessageResult
}

func (e *messagingService) sendTextMessageOnSession(ctx context.Context, session *chatdSession, state *NativeState, input wacore.EngineTextMessageInput, receiveInput wacore.EngineMessageInput, timeout time.Duration) chatdTextMessageSendResult {
	providerID := NewTextProviderMessageID(input.ClientMessageID)
	sentAt := e.clock.Now()
	result := chatdTextMessageSendResult{EngineTextMessageResult: wacore.EngineTextMessageResult{ProviderMessageID: providerID, SentAt: sentAt}}
	node, err := buildNativeTextMessageNode(state, input, providerID)
	if err != nil {
		result.Err = err
		return result
	}
	applyChatdSessionUpdateState(state, session.update())
	if err := e.SaveState(ctx, input.ClientProfileID, *state); err != nil {
		result.Err = err
		return result
	}
	items, update, err := session.sendMessageWithAck(ctx, receiveInput, node, providerID, timeout)
	result.Items = items
	result.Update = update
	if err != nil {
		result.Err = chatdSendError(err)
		return result
	}
	result.AckStatus = waappv1.MessageAckStatus_MESSAGE_ACK_STATUS_ACKED
	return result
}

func (e *messagingService) applyTextMessageSendUpdate(ctx context.Context, clientProfileID string, state *NativeState, input wacore.EngineMessageInput, items []chatdReceivedItem, update chatdSessionUpdate) error {
	if state == nil {
		return nil
	}
	_, payloads, _ := splitReceivedItems(items)
	if !applyChatdReceiveState(state, input, payloads, update) {
		return nil
	}
	return e.SaveState(ctx, clientProfileID, *state)
}

func (e *LongConnectionNativeEngine) textMessageReceiveInput(input wacore.EngineTextMessageInput) wacore.EngineMessageInput {
	messageInput := e.input
	messageInput.WAAccountID = shared.FirstNonEmpty(messageInput.WAAccountID, input.WAAccountID)
	messageInput.ClientProfileID = shared.FirstNonEmpty(messageInput.ClientProfileID, input.ClientProfileID)
	messageInput.RegisteredIdentityID = shared.FirstNonEmpty(messageInput.RegisteredIdentityID, input.RegisteredIdentityID)
	messageInput.AppVersion = shared.FirstNonEmpty(messageInput.AppVersion, input.AppVersion)
	return messageInput
}

func buildNativeTextMessageNode(state *NativeState, input wacore.EngineTextMessageInput, providerID string) (chatdNode, error) {
	contactJID := wacore.NormalizeWAJID(input.ContactJID)
	text := strings.TrimSpace(input.Text)
	if contactJID == "" {
		return chatdNode{}, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "contact_ref is required", false)
	}
	if text == "" {
		return chatdNode{}, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "text is required", false)
	}
	ciphertext, err := encryptNativeTextSignalMessage(state, contactJID, text)
	if err != nil {
		return chatdNode{}, err
	}
	return chatdNode{
		Tag:   "message",
		Attrs: map[string]string{"id": providerID, "to": contactJID, "type": "text"},
		Content: []chatdNode{{
			Tag:     "enc",
			Attrs:   map[string]string{"type": "msg", "v": "2"},
			Content: ciphertext,
		}},
	}, nil
}

func encryptNativeTextSignalMessage(state *NativeState, contactJID string, text string) ([]byte, error) {
	state.ensureMaps()
	key, session, ok := exactSignalSession(state.Signal.Sessions, contactJID)
	if !ok {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_UNSUPPORTED_OPERATION, "WA text send requires an existing Signal session for this contact", false)
	}
	if err := ensureOutboundSignalChain(&session); err != nil {
		return nil, err
	}
	raw, err := encryptSignalPlaintext(state, &session, nativeTextMessagePlaintext(text))
	if err != nil {
		return nil, err
	}
	state.Signal.Sessions[key] = session
	return raw, nil
}

func exactSignalSession(sessions map[string]nativeSignalSession, contactJID string) (string, nativeSignalSession, bool) {
	for _, candidate := range shared.UniqueNonEmptyStrings(contactJID, wacore.NormalizeWAJID(contactJID)) {
		key := signalSenderKey(candidate)
		if session, ok := sessions[key]; ok {
			return key, session, true
		}
	}
	return "", nativeSignalSession{}, false
}

func ensureOutboundSignalChain(session *nativeSignalSession) error {
	if session.SenderChain != nil && session.SenderChain.ChainKey != "" && session.SenderRatchetPrivate != "" {
		return nil
	}
	if session.RootKey == "" {
		return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_UNSUPPORTED_OPERATION, "WA text send requires a learned Signal root key", false)
	}
	remoteRatchet, err := latestReceiverRatchetKey(*session)
	if err != nil {
		return err
	}
	rootKey, err := decodeB64Any(session.RootKey)
	if err != nil {
		return err
	}
	localRatchet, err := newNativeCurveKeyPair()
	if err != nil {
		return err
	}
	localPrivate, err := localRatchet.privateBytes()
	if err != nil {
		return err
	}
	localPublic, err := localRatchet.publicBytes()
	if err != nil {
		return err
	}
	nextRoot, chainKey, err := rootRatchet(rootKey, remoteRatchet, localPrivate)
	if err != nil {
		return err
	}
	session.RootKey = b64u(nextRoot)
	session.SenderRatchetPrivate = b64u(localPrivate)
	session.SenderRatchetPublic = b64u(localPublic)
	session.SenderChain = &nativeSenderChain{RatchetKey: b64u(localPublic), ChainKey: b64u(chainKey)}
	return nil
}

func latestReceiverRatchetKey(session nativeSignalSession) ([]byte, error) {
	if len(session.ReceiverChains) == 0 {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_UNSUPPORTED_OPERATION, "WA text send requires a learned receiver chain", false)
	}
	keys := make([]string, 0, len(session.ReceiverChains))
	for key := range session.ReceiverChains {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var selected nativeReceiverChain
	selectedOK := false
	for _, key := range keys {
		chain := session.ReceiverChains[key]
		if !selectedOK || chain.Index >= selected.Index {
			selected = chain
			selectedOK = true
		}
	}
	if selected.RatchetKey != "" {
		return decodeB64Any(selected.RatchetKey)
	}
	for _, key := range keys {
		if raw, err := hex.DecodeString(key); err == nil && len(raw) > 0 {
			return raw, nil
		}
	}
	return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_UNSUPPORTED_OPERATION, "WA text send receiver ratchet is unavailable", false)
}

func encryptSignalPlaintext(state *NativeState, session *nativeSignalSession, plaintext []byte) ([]byte, error) {
	if session.SenderChain == nil {
		return nil, fmt.Errorf("missing sender chain")
	}
	chainKey, err := decodeB64Any(session.SenderChain.ChainKey)
	if err != nil {
		return nil, err
	}
	ratchetPublic, err := decodeB64Any(shared.FirstNonEmpty(session.SenderChain.RatchetKey, session.SenderRatchetPublic))
	if err != nil {
		return nil, err
	}
	ratchetPublic, err = stripSignalCurvePrefix(ratchetPublic)
	if err != nil {
		return nil, err
	}
	version := signalMessageVersion(session.Version)
	counter := session.SenderChain.Index
	keys := deriveMessageKeys(chainKey, counter)
	ciphertext, err := aesCBCPKCS7Encrypt(plaintext, keys.cipherKey, keys.iv)
	if err != nil {
		return nil, err
	}
	body := []byte{byte(version<<4 | version)}
	body = protoBytesInto(body, 1, ratchetPublic)
	body = protoVarintInto(body, 2, uint64(counter))
	body = protoBytesInto(body, 4, ciphertext)
	identityPublic, err := state.Signal.Identity.publicBytes()
	if err != nil {
		return nil, err
	}
	remoteIdentity, err := decodeB64Any(session.RemoteIdentityPublic)
	if err != nil {
		return nil, err
	}
	mac, err := signalMessageMAC(keys.macKey, identityPublic, remoteIdentity, body, version)
	if err != nil {
		return nil, err
	}
	session.SenderChain.ChainKey = b64u(nextChainKey(chainKey))
	session.SenderChain.Index = counter + 1
	return append(body, mac...), nil
}

func nativeTextMessagePlaintext(text string) []byte {
	return protoBytes(1, []byte(text))
}

func signalMessageVersion(version int) int {
	if version == 3 || version == 4 {
		return version
	}
	return 3
}

func (s *chatdSession) sendMessageWithAck(ctx context.Context, input wacore.EngineMessageInput, node chatdNode, providerID string, timeout time.Duration) ([]chatdReceivedItem, chatdSessionUpdate, error) {
	if s == nil || s.conn == nil {
		return nil, chatdSessionUpdate{}, fmt.Errorf("chatd session is not open")
	}
	deadline := textMessageSendDeadline(ctx, timeout)
	update := s.update()
	if !deadline.After(time.Now()) {
		return nil, update, errors.New(textMessageAckTimeoutMessage)
	}
	conn := s.conn
	transport := s.transport
	_ = conn.SetDeadline(deadline)
	defer func() { _ = conn.SetDeadline(time.Time{}) }()
	if err := transport.sendNode(node); err != nil {
		return nil, update, chatdPhase("chatd message write", err)
	}
	items := []chatdReceivedItem{}
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return items, update, ctx.Err()
		}
		_ = conn.SetReadDeadline(deadline)
		next, err := transport.readNode()
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				return items, update, errors.New(textMessageAckTimeoutMessage)
			}
			return items, update, chatdPhase("chatd message read", err)
		}
		if err := chatdMessageSendRejection(next, providerID); err != nil {
			return items, update, err
		}
		if isChatdMessageSendAck(next, providerID) {
			return items, update, nil
		}
		nextUpdate, nextItems, err := s.consumeIncomingNode(input, next, update, time.Now())
		update = nextUpdate
		items = append(items, nextItems...)
		if err != nil {
			return items, update, err
		}
	}
	return items, update, errors.New(textMessageAckTimeoutMessage)
}

func textMessageSendDeadline(ctx context.Context, timeout time.Duration) time.Time {
	deadline := time.Now().Add(textMessageSendTimeout(timeout))
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	return deadline
}

func isChatdMessageSendAck(node chatdNode, providerID string) bool {
	if providerID == "" || node.Attrs["id"] != providerID {
		return false
	}
	switch node.Tag {
	case "ack":
		return node.Attrs["class"] == "" || node.Attrs["class"] == "message"
	case "receipt":
		return true
	default:
		return false
	}
}

func chatdMessageSendRejection(node chatdNode, providerID string) error {
	if providerID == "" || node.Attrs["id"] != providerID {
		return nil
	}
	if node.Attrs["type"] == "error" {
		return fmt.Errorf("WA text message was rejected")
	}
	if node.Tag == "failure" || node.Tag == "error" {
		return fmt.Errorf("WA text message was rejected")
	}
	if errorNode, ok := chatdChild(node, "error"); ok {
		if code := strings.TrimSpace(errorNode.Attrs["code"]); code != "" {
			return fmt.Errorf("WA text message was rejected: code %s", SafeResponseSnippet(code))
		}
		return fmt.Errorf("WA text message was rejected")
	}
	return nil
}

func textMessageSendTimeout(timeout time.Duration) time.Duration {
	if timeout <= 0 {
		return DefaultTextMessageSendTimeout
	}
	return timeout
}

func chatdSendError(err error) error {
	message := "native chatd send failed"
	if ne, ok := err.(net.Error); ok && ne.Timeout() {
		message += ": timeout"
	} else {
		message = chatdFailureMessage(message, err)
	}
	return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_REJECTED, message, true)
}

func isChatdSendError(err error) bool {
	var appErr *shared.AppError
	return errors.As(err, &appErr) && strings.HasPrefix(appErr.Message, "native chatd send failed")
}

func NewTextProviderMessageID(clientID string) string {
	clientID = strings.TrimSpace(clientID)
	if validTextProviderMessageID(clientID) {
		return clientID
	}
	return "3EB0" + strings.ToUpper(hex.EncodeToString(randomBytes(8)))
}

func validTextProviderMessageID(value string) bool {
	if value == "" || len(value) > 96 {
		return false
	}
	for _, r := range value {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.' {
			continue
		}
		return false
	}
	return true
}
