package engine

import (
	"bytes"
	"strconv"
	"strings"
	"time"

	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
)

const trustedContactTokenMaxAge = 182 * 24 * time.Hour

type nativePrivacyTokenUpdate struct {
	JID       string
	Token     []byte
	Timestamp int64
}

func privacyTokenUpdatesFromChatdNode(node chatdNode) []nativePrivacyTokenUpdate {
	updates := []nativePrivacyTokenUpdate{}
	var walk func(chatdNode)
	walk = func(current chatdNode) {
		updates = append(updates, privacyTokenUpdatesFromNotificationNode(current)...)
		for _, child := range chatdChildren(current) {
			walk(child)
		}
	}
	walk(node)
	return dedupePrivacyTokenUpdates(updates)
}

func privacyTokenUpdatesFromNotificationNode(node chatdNode) []nativePrivacyTokenUpdate {
	tokens, ok := chatdChild(node, "tokens")
	if !ok {
		return nil
	}
	jid := trustedContactTokenJID(node)
	if jid == "" {
		return nil
	}
	parentTimestamp := privacyTokenTimestamp(node.Attrs["t"])
	updates := []nativePrivacyTokenUpdate{}
	for _, tokenNode := range chatdChildren(tokens) {
		if tokenNode.Tag != "token" || tokenNode.Attrs["type"] != "trusted_contact" {
			continue
		}
		token := privacyTokenContent(tokenNode.Content)
		if len(token) == 0 {
			continue
		}
		timestamp := privacyTokenTimestamp(tokenNode.Attrs["t"])
		if timestamp == 0 {
			timestamp = parentTimestamp
		}
		updates = append(updates, nativePrivacyTokenUpdate{JID: jid, Token: token, Timestamp: timestamp})
	}
	return updates
}

func trustedContactTokenJID(node chatdNode) string {
	for _, value := range []string{node.Attrs["sender_lid"], node.Attrs["from"]} {
		jid := wacore.NormalizeWAJID(value)
		if strings.HasSuffix(jid, "@lid") || strings.HasSuffix(jid, "@s.whatsapp.net") {
			return jid
		}
	}
	return ""
}

func privacyTokenContent(content any) []byte {
	switch value := content.(type) {
	case []byte:
		return bytes.Clone(value)
	case string:
		return []byte(strings.TrimSpace(value))
	default:
		return nil
	}
}

func privacyTokenTimestamp(value string) int64 {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	timestamp, err := strconv.ParseInt(value, 10, 64)
	if err != nil || timestamp <= 0 {
		return 0
	}
	if timestamp > 1000000000000 {
		return timestamp / 1000
	}
	return timestamp
}

func dedupePrivacyTokenUpdates(updates []nativePrivacyTokenUpdate) []nativePrivacyTokenUpdate {
	if len(updates) == 0 {
		return nil
	}
	merged := map[string]nativePrivacyTokenUpdate{}
	order := []string{}
	for _, update := range updates {
		if update.JID == "" || len(update.Token) == 0 {
			continue
		}
		key := update.JID
		current, ok := merged[key]
		if !ok {
			merged[key] = update
			order = append(order, key)
			continue
		}
		if update.Timestamp >= current.Timestamp {
			merged[key] = update
		}
	}
	out := make([]nativePrivacyTokenUpdate, 0, len(order))
	for _, key := range order {
		out = append(out, merged[key])
	}
	return out
}

func applyPrivacyTokenUpdates(state *NativeState, updates []nativePrivacyTokenUpdate) bool {
	if state == nil || len(updates) == 0 {
		return false
	}
	state.ensureMaps()
	changed := false
	for _, update := range updates {
		if update.JID == "" || len(update.Token) == 0 {
			continue
		}
		next := nativePrivacyToken{Token: b64u(update.Token), Timestamp: update.Timestamp}
		current, ok := state.PrivacyTokens[update.JID]
		if ok && current.Timestamp > next.Timestamp {
			continue
		}
		if ok && current.Timestamp == next.Timestamp && current.Token == next.Token {
			continue
		}
		state.PrivacyTokens[update.JID] = next
		changed = true
	}
	return changed
}

func trustedContactTokenForProfilePicture(state NativeState, jid string, now time.Time) []byte {
	return privacyTokenForJID(state, jid, now)
}

func privacyTokenForJID(state NativeState, jid string, now time.Time) []byte {
	jid = wacore.NormalizeWAJID(jid)
	if jid == "" || len(state.PrivacyTokens) == 0 {
		return nil
	}
	record, ok := state.PrivacyTokens[jid]
	if !ok || !privacyTokenTimestampActive(record.Timestamp, now) {
		return nil
	}
	token, err := decodeB64Any(record.Token)
	if err != nil || len(token) == 0 {
		return nil
	}
	return token
}

func privacyTokenTimestampActive(timestamp int64, now time.Time) bool {
	if timestamp == 0 {
		return true
	}
	current := now.Unix()
	if current <= 0 {
		return true
	}
	return timestamp >= current-int64(trustedContactTokenMaxAge/time.Second)
}
