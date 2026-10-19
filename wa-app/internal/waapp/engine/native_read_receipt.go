package engine

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
)

const DefaultMessageReadReceiptTimeout = 15 * time.Second

func (e *messagingService) SendReadReceipts(ctx context.Context, input wacore.EngineMessageReadReceiptInput) wacore.EngineMessageReadReceiptResult {
	if e == nil {
		return wacore.EngineMessageReadReceiptResult{Err: fmt.Errorf("native engine is required")}
	}
	messages := normalizeReadReceiptMessages(input.Messages)
	if len(messages) == 0 {
		return wacore.EngineMessageReadReceiptResult{}
	}
	state, err := e.loadState(ctx, input.ClientProfileID)
	if err != nil {
		return wacore.EngineMessageReadReceiptResult{Err: err}
	}
	proxyURL, err := e.proxyURL()
	if err != nil {
		return wacore.EngineMessageReadReceiptResult{Err: err}
	}
	timeout := input.RemoteTimeout
	if timeout <= 0 {
		timeout = DefaultMessageReadReceiptTimeout
	}
	client := newChatdClient(chatdConfigForState(proxyURL, state, timeout))
	session, err := client.openSession(ctx, state, input.RegisteredIdentityID, defaultLoginPayload, input.AppVersion)
	if err != nil {
		return wacore.EngineMessageReadReceiptResult{Err: chatdReceiveError(err)}
	}
	defer session.Close()
	if applyChatdSessionUpdateState(&state, session.update()) {
		_ = e.SaveState(ctx, input.ClientProfileID, state)
	}
	sent := 0
	for _, node := range buildReadReceiptNodes(messages) {
		if err := session.transport.sendNode(node); err != nil {
			return wacore.EngineMessageReadReceiptResult{Sent: sent, Err: chatdReceiveError(err)}
		}
		sent += readReceiptNodeMessageCount(node)
	}
	return wacore.EngineMessageReadReceiptResult{Sent: sent}
}

func normalizeReadReceiptMessages(messages []wacore.EngineMessageReadReceipt) []wacore.EngineMessageReadReceipt {
	out := make([]wacore.EngineMessageReadReceipt, 0, len(messages))
	seen := map[string]struct{}{}
	for _, message := range messages {
		message.ChatJID = strings.TrimSpace(message.ChatJID)
		message.ParticipantJID = strings.TrimSpace(message.ParticipantJID)
		message.ProviderMessageID = strings.TrimSpace(message.ProviderMessageID)
		if message.ChatJID == "" || message.ProviderMessageID == "" {
			continue
		}
		key := strings.Join([]string{message.ChatJID, message.ParticipantJID, message.ProviderMessageID}, "\x00")
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, message)
	}
	return out
}

func buildReadReceiptNodes(messages []wacore.EngineMessageReadReceipt) []chatdNode {
	groups := map[string][]wacore.EngineMessageReadReceipt{}
	order := []string{}
	for _, message := range messages {
		key := strings.Join([]string{message.ChatJID, message.ParticipantJID}, "\x00")
		if _, ok := groups[key]; !ok {
			order = append(order, key)
		}
		groups[key] = append(groups[key], message)
	}
	nodes := make([]chatdNode, 0, len(groups))
	for _, key := range order {
		items := groups[key]
		if len(items) == 0 {
			continue
		}
		attrs := map[string]string{
			"to":   items[0].ChatJID,
			"id":   items[0].ProviderMessageID,
			"type": "read",
		}
		if participant := items[0].ParticipantJID; participant != "" && participant != items[0].ChatJID {
			attrs["participant"] = participant
		}
		node := chatdNode{Tag: "receipt", Attrs: attrs}
		if len(items) > 1 {
			children := make([]chatdNode, 0, len(items)-1)
			for _, item := range items[1:] {
				children = append(children, chatdNode{Tag: "item", Attrs: map[string]string{"id": item.ProviderMessageID}})
			}
			node.Content = []chatdNode{{Tag: "list", Content: children}}
		}
		nodes = append(nodes, node)
	}
	return nodes
}

func readReceiptNodeMessageCount(node chatdNode) int {
	count := 1
	for _, child := range chatdChildren(node) {
		if child.Tag != "list" {
			continue
		}
		count += len(chatdChildren(child))
	}
	return count
}
