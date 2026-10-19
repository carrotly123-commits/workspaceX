package engine

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
	"github.com/byte-v-forge/wa-app/internal/waapp/waproto"
	"google.golang.org/protobuf/encoding/protowire"
)

const (
	waContactProtoMaxDepth       = 8
	waContactProtoMaxFields      = 8192
	waContactDecodedPayloadLimit = 4 << 20
)

func nativeContactHints(raw []byte) []wacore.WAContactHint {
	if len(raw) == 0 {
		return nil
	}
	hints := waKnownContactRecordHints(raw)
	collectWAContactHints(raw, nil, 0, &hints)
	return dedupeWAContactHints(hints)
}

func contactHintsFromNativePayloadMetadata(payload nativeMessagePayload) []wacore.WAContactHint {
	hints := append([]wacore.WAContactHint{}, payload.ContactHints...)
	appendPayloadHint := func(lidRef string, pnRef string) {
		hint := wacore.WAContactHint{
			LIDJID:      wacore.NormalizeWAJID(lidRef),
			PNJID:       wacore.NormalizeWAJID(pnRef),
			DisplayName: wacore.WAContactName(payload.NotifyName),
			Username:    wacore.WAContactName(payload.ParticipantUsername),
		}
		if hint.Valid() {
			hints = append(hints, hint)
		}
	}
	appendPayloadHint(payload.Sender, payload.SenderPN)
	appendPayloadHint(payload.Contact, payload.ContactPN)
	appendPayloadHint(payload.Sender, payload.ContactPN)
	appendPayloadHint(payload.Contact, payload.SenderPN)
	return dedupeWAContactHints(hints)
}

func contactHintsFromChatdNode(node chatdNode) []wacore.WAContactHint {
	hints := []wacore.WAContactHint{}
	var walk func(chatdNode)
	walk = func(current chatdNode) {
		hints = append(hints, contactHintsFromChatdAttrs(current.Attrs)...)
		if raw, ok := current.Content.([]byte); ok && shouldScanChatdBinaryContactPayload(current.Tag) {
			hints = append(hints, nativeContactHints(raw)...)
		}
		for _, child := range chatdChildren(current) {
			walk(child)
		}
	}
	walk(node)
	return dedupeWAContactHints(hints)
}

func shouldScanChatdBinaryContactPayload(tag string) bool {
	switch tag {
	case "enc",
		"routing_info",
		"edge_routing",
		"media",
		"picture",
		"preview",
		"thumbnail-image",
		"thumbnail-video",
		"thumbnail-document",
		"thumbnail-link",
		"download",
		"key",
		"identity",
		"device-identity",
		"privacy_token":
		return false
	default:
		return true
	}
}

func contactHintsFromChatdAttrs(attrs map[string]string) []wacore.WAContactHint {
	if len(attrs) == 0 {
		return nil
	}
	displayName := wacore.WAContactName(firstChatdAttr(attrs, "notify", "notify_name", "display_name"))
	username := waContactUsername(firstChatdAttr(attrs, "participant_username", "peer_recipient_username", "author_username", "username"))
	verifiedName := wacore.WAContactName(firstChatdAttr(attrs, "verified_name", "business_verified_name", "verified_business_name"))
	peerLIDKeys := []string{"peer_recipient_lid", "recipient_latest_lid", "recipient_lid", "peer_lid"}
	peerPNKeys := []string{"peer_recipient_pn", "peer_recipient_pn_jid", "recipient_pn", "recipient_pn_jid", "peer_pn", "peer_pn_jid"}
	actorLIDKeys := []string{"author", "author_lid", "creator_lid"}
	actorPNKeys := []string{"author_pn", "author_pn_jid", "creator_pn", "creator_pn_jid", "pn_jid"}
	contactLIDKeys := []string{"contact_lid"}
	contactPNKeys := []string{"contact_pn", "contact_pn_jid", "pn_jid", "new_jid", "number", "phone", "phone_number", "business_phone_number", "wa_id"}
	fallbackLIDKeys := []string{
		"sender_lid", "participant_lid", "peer_recipient_lid", "recipient_latest_lid", "recipient_lid", "peer_lid",
		"contact_lid", "author_lid", "creator_lid", "caller_lid", "invitee_lid", "lid", "jid", "participant", "author", "from",
	}
	fallbackPNKeys := []string{
		"sender_pn", "sender_pn_jid", "participant_pn", "participant_pn_jid", "peer_recipient_pn", "peer_recipient_pn_jid",
		"recipient_pn", "recipient_pn_jid", "peer_pn", "peer_pn_jid", "contact_pn", "contact_pn_jid", "author_pn", "author_pn_jid",
		"creator_pn", "creator_pn_jid", "caller_pn", "caller_pn_jid", "invitee_pn", "invitee_pn_jid", "from_pn", "from_pn_jid",
		"pn", "pn_jid", "new_jid", "number", "phone", "phone_number", "business_phone_number", "wa_id", "jid", "participant", "author", "from",
	}
	hints := []wacore.WAContactHint{}
	appendChatdAttrHints(&hints, attrs, displayName, username, verifiedName, []string{"sender_lid"}, []string{"sender_pn", "sender_pn_jid"})
	appendChatdAttrHints(&hints, attrs, displayName, username, verifiedName, []string{"participant_lid", "participant", "jid"}, []string{"participant_pn", "participant_pn_jid", "pn_jid", "jid"})
	appendChatdAttrHints(&hints, attrs, displayName, waContactUsername(firstChatdAttr(attrs, "peer_recipient_username", "username")), verifiedName, peerLIDKeys, peerPNKeys)
	appendChatdAttrHints(&hints, attrs, displayName, waContactUsername(firstChatdAttr(attrs, "author_username", "username")), verifiedName, actorLIDKeys, actorPNKeys)
	appendChatdAttrHints(&hints, attrs, displayName, username, verifiedName, []string{"from"}, []string{"from_pn", "from_pn_jid", "pn_jid", "new_jid"})
	appendChatdAttrHints(&hints, attrs, wacore.WAContactName(shared.FirstNonEmpty(firstChatdAttr(attrs, "contact_push_name"), displayName)), waContactUsername(firstChatdAttr(attrs, "contact_username", "username")), verifiedName, contactLIDKeys, contactPNKeys)
	appendChatdAttrHints(&hints, attrs, displayName, username, verifiedName, []string{"caller_lid"}, []string{"caller_pn", "caller_pn_jid"})
	appendChatdAttrHints(&hints, attrs, displayName, username, verifiedName, []string{"invitee_lid"}, []string{"invitee_pn", "invitee_pn_jid"})
	if len(hints) == 0 {
		lids := chatdAttrJIDs(attrs, "@lid", fallbackLIDKeys...)
		pns := chatdAttrJIDs(attrs, "@s.whatsapp.net", fallbackPNKeys...)
		if len(lids) == 1 && len(pns) <= 1 {
			hint := wacore.WAContactHint{LIDJID: lids[0], DisplayName: displayName, Username: username, VerifiedName: verifiedName}
			if len(pns) == 1 {
				hint.PNJID = pns[0]
			}
			if hint.Valid() {
				hints = append(hints, hint)
			}
		}
	}
	return dedupeWAContactHints(hints)
}

func firstChatdAttr(attrs map[string]string, keys ...string) string {
	values := make([]string, 0, len(keys))
	for _, key := range keys {
		values = append(values, attrs[key])
	}
	return shared.FirstNonEmpty(values...)
}

func appendChatdAttrHints(hints *[]wacore.WAContactHint, attrs map[string]string, displayName string, username string, verifiedName string, lidKeys []string, pnKeys []string) {
	lids := chatdAttrJIDs(attrs, "@lid", lidKeys...)
	if len(lids) == 0 {
		return
	}
	pns := chatdAttrJIDs(attrs, "@s.whatsapp.net", pnKeys...)
	if len(pns) == 0 {
		if len(lids) != 1 {
			return
		}
		hint := wacore.WAContactHint{LIDJID: lids[0], DisplayName: displayName, Username: username, VerifiedName: verifiedName}
		if hint.Valid() {
			*hints = append(*hints, hint)
		}
		return
	}
	for _, lid := range lids {
		for _, pn := range pns {
			hint := wacore.WAContactHint{LIDJID: lid, PNJID: pn, DisplayName: displayName, Username: username, VerifiedName: verifiedName}
			if hint.Valid() {
				*hints = append(*hints, hint)
			}
		}
	}
}

func chatdAttrJIDs(attrs map[string]string, suffix string, keys ...string) []string {
	out := []string{}
	seen := map[string]struct{}{}
	for _, key := range keys {
		jid := wacore.NormalizeWAJID(attrs[key])
		if !strings.HasSuffix(jid, suffix) {
			continue
		}
		if _, ok := seen[jid]; ok {
			continue
		}
		seen[jid] = struct{}{}
		out = append(out, jid)
	}
	return out
}

func collectWAContactHints(raw []byte, path []protowire.Number, depth int, hints *[]wacore.WAContactHint) {
	if depth > waContactProtoMaxDepth || len(raw) == 0 {
		return
	}
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, waContactProtoMaxFields)
	if !ok {
		return
	}
	for _, field := range fields {
		if field.Kind != protowire.BytesType {
			continue
		}
		fieldPath := waproto.AppendWAPath(path, field.Number)
		normalized := waproto.NormalizeWAMessagePath(fieldPath)
		switch {
		case waproto.SameWAPath(normalized, 12, 23, 1):
			*hints = append(*hints, waLIDMigrationMappingPayloadHints(field.Value)...)
		case waproto.SameWAPath(normalized, 12, 6, 11):
			*hints = append(*hints, waHistorySyncContactHints(field.Value)...)
		}
		*hints = append(*hints, waKnownContactRecordHints(field.Value)...)
		collectWAContactHints(field.Value, fieldPath, depth+1, hints)
	}
}

func waKnownContactRecordHints(raw []byte) []wacore.WAContactHint {
	hints := []wacore.WAContactHint{}
	hints = append(hints, waSyncdIndexedContactHints(raw)...)
	if hint := waInlineContactRecordHint(raw); hint.Valid() {
		hints = append(hints, hint)
	}
	if hint := waHistorySyncConversationRecordHint(raw); hint.Valid() {
		hints = append(hints, hint)
	}
	if hint := waHistorySyncMessageRecordHint(raw); hint.Valid() {
		hints = append(hints, hint)
	}
	if hint := waContactMetadataRecordHint(raw); hint.Valid() {
		hints = append(hints, hint)
	}
	if hint := waAppStateContactActionHint(raw); hint.Valid() {
		hints = append(hints, hint)
	}
	if hint := waLIDContactActionHint(raw); hint.Valid() {
		hints = append(hints, hint)
	}
	return dedupeWAContactHints(hints)
}

func waSyncdIndexedContactHints(raw []byte) []wacore.WAContactHint {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 16)
	if !ok {
		return nil
	}
	var indexRaw []byte
	var valueRaw []byte
	for _, field := range fields {
		if field.Kind != protowire.BytesType {
			continue
		}
		switch field.Number {
		case 1:
			indexRaw = field.Value
		case 2:
			valueRaw = field.Value
		}
	}
	index := waSyncdIndexValues(indexRaw)
	if len(index) == 0 || len(valueRaw) == 0 {
		return nil
	}
	return waAppStateActionHintsForIndex(index, valueRaw)
}

func waSyncdIndexValues(raw []byte) []string {
	if len(raw) == 0 || len(raw) > 16<<10 || !utf8.Valid(raw) {
		return nil
	}
	text := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(text, "[") || !strings.HasSuffix(text, "]") {
		return nil
	}
	var values []string
	if err := json.Unmarshal([]byte(text), &values); err != nil {
		return nil
	}
	out := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			out = append(out, value)
		}
	}
	return out
}

func waAppStateActionHintsForIndex(index []string, raw []byte) []wacore.WAContactHint {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 256)
	if !ok {
		return nil
	}
	indexLID := waSyncdIndexJID(index, "@lid")
	indexPN := waSyncdIndexJID(index, "@s.whatsapp.net")
	hints := []wacore.WAContactHint{}
	for _, field := range fields {
		if field.Kind != protowire.BytesType {
			continue
		}
		switch field.Number {
		case 3:
			if hint := waIndexedAppStateContactActionHint(field.Value, indexLID, indexPN); hint.Valid() {
				hints = append(hints, hint)
			}
		case 37:
			if hint := waIndexedPNForLIDChatActionHint(field.Value, indexLID); hint.Valid() {
				hints = append(hints, hint)
			}
		case 61:
			if hint := waIndexedLIDContactActionHint(field.Value, indexLID, indexPN); hint.Valid() {
				hints = append(hints, hint)
			}
		case 79:
			if hint := waIndexedOutContactActionHint(field.Value, indexLID, indexPN); hint.Valid() {
				hints = append(hints, hint)
			}
		}
	}
	return dedupeWAContactHints(hints)
}

func waSyncdIndexJID(index []string, suffix string) string {
	for i := 1; i < len(index); i++ {
		jid := wacore.NormalizeWAJID(index[i])
		if strings.HasSuffix(jid, suffix) {
			return jid
		}
	}
	return ""
}

func waIndexedAppStateContactActionHint(raw []byte, indexLID string, indexPN string) wacore.WAContactHint {
	hint := waAppStateContactActionHint(raw)
	hint.LIDJID = shared.FirstNonEmpty(hint.LIDJID, indexLID)
	hint.PNJID = shared.FirstNonEmpty(hint.PNJID, indexPN)
	return hint.Normalized()
}

func waIndexedPNForLIDChatActionHint(raw []byte, indexLID string) wacore.WAContactHint {
	hint := waPNForLIDChatActionHint(raw)
	hint.LIDJID = shared.FirstNonEmpty(hint.LIDJID, indexLID)
	return hint.Normalized()
}

func waIndexedLIDContactActionHint(raw []byte, indexLID string, indexPN string) wacore.WAContactHint {
	hint := waLIDContactActionHint(raw)
	hint.LIDJID = shared.FirstNonEmpty(hint.LIDJID, indexLID)
	hint.PNJID = shared.FirstNonEmpty(hint.PNJID, indexPN)
	return hint.Normalized()
}

func waIndexedOutContactActionHint(raw []byte, indexLID string, indexPN string) wacore.WAContactHint {
	hint := waOutContactActionHint(raw)
	hint.LIDJID = shared.FirstNonEmpty(hint.LIDJID, indexLID)
	hint.PNJID = shared.FirstNonEmpty(hint.PNJID, indexPN)
	return hint.Normalized()
}

func waAppStateContactActionHint(raw []byte) wacore.WAContactHint {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 32)
	if !ok {
		return wacore.WAContactHint{}
	}
	var hint wacore.WAContactHint
	for _, field := range fields {
		if field.Kind != protowire.BytesType {
			continue
		}
		switch field.Number {
		case 1:
			hint.DisplayName = waContactNameString(field.Value)
		case 2:
			hint.WAName = waContactNameString(field.Value)
		case 3:
			hint.LIDJID = wacore.NormalizeWAJID(waProtoPlainString(field.Value))
		case 5:
			hint.PNJID = wacore.NormalizeWAJID(waProtoPlainString(field.Value))
		case 6:
			hint.Username = waContactNameString(field.Value)
		}
	}
	return hint.Normalized()
}

func waLIDContactActionHint(raw []byte) wacore.WAContactHint {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 16)
	if !ok {
		return wacore.WAContactHint{}
	}
	var hint wacore.WAContactHint
	for _, field := range fields {
		if field.Kind != protowire.BytesType {
			continue
		}
		switch field.Number {
		case 1:
			hint.DisplayName = waContactNameString(field.Value)
		case 2:
			hint.WAName = waContactNameString(field.Value)
		case 3:
			hint.Username = waContactNameString(field.Value)
		}
	}
	return hint.Normalized()
}

func waOutContactActionHint(raw []byte) wacore.WAContactHint {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 8)
	if !ok {
		return wacore.WAContactHint{}
	}
	var hint wacore.WAContactHint
	for _, field := range fields {
		if field.Kind != protowire.BytesType {
			continue
		}
		switch field.Number {
		case 1:
			hint.DisplayName = waContactNameString(field.Value)
		case 2:
			hint.WAName = waContactNameString(field.Value)
		}
	}
	return hint.Normalized()
}

func waPNForLIDChatActionHint(raw []byte) wacore.WAContactHint {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 8)
	if !ok {
		return wacore.WAContactHint{}
	}
	var hint wacore.WAContactHint
	for _, field := range fields {
		if field.Kind != protowire.BytesType {
			continue
		}
		if field.Number == 1 {
			hint.PNJID = wacore.NormalizeWAJID(waProtoPlainString(field.Value))
		}
	}
	return hint.Normalized()
}

func waLIDMigrationMappingPayloadHints(raw []byte) []wacore.WAContactHint {
	payloads := [][]byte{raw}
	if decoded, ok := waGunzipPayload(raw); ok {
		payloads = append([][]byte{decoded}, payloads...)
	}
	hints := []wacore.WAContactHint{}
	for _, payload := range payloads {
		fields, ok := waproto.ParseWAProtoFieldsWithLimit(payload, waContactProtoMaxFields)
		if !ok {
			continue
		}
		for _, field := range fields {
			if field.Kind != protowire.BytesType || field.Number != 1 {
				continue
			}
			hints = append(hints, waNumericLIDMappingRecordHints(field.Value)...)
		}
		if len(hints) > 0 {
			break
		}
	}
	return dedupeWAContactHints(hints)
}

func waNumericLIDMappingRecordHints(raw []byte) []wacore.WAContactHint {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 16)
	if !ok {
		return nil
	}
	var pn uint64
	lids := []uint64{}
	for _, field := range fields {
		if field.Kind != protowire.VarintType {
			continue
		}
		switch field.Number {
		case 1:
			pn = field.Varint
		case 2, 3:
			if field.Varint > 0 {
				lids = append(lids, field.Varint)
			}
		}
	}
	if pn == 0 || len(lids) == 0 {
		return nil
	}
	pnJID := numericWAJID(pn, "s.whatsapp.net")
	if pnJID == "" {
		return nil
	}
	hints := []wacore.WAContactHint{}
	for _, lid := range lids {
		if lidJID := numericWAJID(lid, "lid"); lidJID != "" {
			hints = append(hints, wacore.WAContactHint{LIDJID: lidJID, PNJID: pnJID})
		}
	}
	return dedupeWAContactHints(hints)
}

func waHistorySyncContactHints(raw []byte) []wacore.WAContactHint {
	payloads := [][]byte{raw}
	if decoded, ok := waGunzipPayload(raw); ok {
		payloads = append([][]byte{decoded}, payloads...)
	}
	hints := []wacore.WAContactHint{}
	for _, payload := range payloads {
		fields, ok := waproto.ParseWAProtoFieldsWithLimit(payload, waContactProtoMaxFields)
		if !ok {
			continue
		}
		for _, field := range fields {
			if field.Kind != protowire.BytesType {
				continue
			}
			switch field.Number {
			case 15:
				if hint := waStringLIDMappingRecordHint(field.Value); hint.Valid() {
					hints = append(hints, hint)
				}
			case 20:
				if hint := waInlineContactRecordHint(field.Value); hint.Valid() {
					hints = append(hints, hint)
				}
			}
		}
		if len(hints) > 0 {
			break
		}
	}
	return dedupeWAContactHints(hints)
}

func waStringLIDMappingRecordHint(raw []byte) wacore.WAContactHint {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 16)
	if !ok {
		return wacore.WAContactHint{}
	}
	var hint wacore.WAContactHint
	for _, field := range fields {
		if field.Kind != protowire.BytesType {
			continue
		}
		switch field.Number {
		case 1:
			hint.PNJID = wacore.NormalizeWAJID(waProtoPlainString(field.Value))
		case 2:
			hint.LIDJID = wacore.NormalizeWAJID(waProtoPlainString(field.Value))
		}
	}
	return hint.Normalized()
}

func waInlineContactRecordHint(raw []byte) wacore.WAContactHint {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 16)
	if !ok {
		return wacore.WAContactHint{}
	}
	var hint wacore.WAContactHint
	for _, field := range fields {
		if field.Kind != protowire.BytesType {
			continue
		}
		switch field.Number {
		case 1:
			hint.PNJID = wacore.NormalizeWAJID(waProtoPlainString(field.Value))
		case 2:
			hint.LIDJID = wacore.NormalizeWAJID(waProtoPlainString(field.Value))
		case 3:
			hint.DisplayName = waContactNameString(field.Value)
		case 4:
			hint.WAName = waContactNameString(field.Value)
		case 5:
			hint.Username = waContactNameString(field.Value)
		}
	}
	return hint.Normalized()
}

func waHistorySyncConversationRecordHint(raw []byte) wacore.WAContactHint {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 96)
	if !ok {
		return wacore.WAContactHint{}
	}
	var hint wacore.WAContactHint
	for _, field := range fields {
		if field.Kind != protowire.BytesType {
			continue
		}
		switch field.Number {
		case 1:
			applyContactRecordJID(&hint, waProtoPlainString(field.Value))
		case 13:
			hint.WAName = waContactNameString(field.Value)
		case 38:
			hint.DisplayName = waContactNameString(field.Value)
		case 39:
			hint.PNJID = wacore.NormalizeWAJID(waProtoPlainString(field.Value))
		case 42:
			hint.LIDJID = wacore.NormalizeWAJID(waProtoPlainString(field.Value))
		case 43:
			hint.Username = waContactNameString(field.Value)
		}
	}
	return hint.Normalized()
}

func waHistorySyncMessageRecordHint(raw []byte) wacore.WAContactHint {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 128)
	if !ok {
		return wacore.WAContactHint{}
	}
	var hint wacore.WAContactHint
	for _, field := range fields {
		if field.Kind != protowire.BytesType {
			continue
		}
		switch field.Number {
		case 1:
			for _, jid := range waMessageKeyJIDs(field.Value) {
				applyContactRecordJID(&hint, jid)
			}
		case 5:
			applyContactRecordJID(&hint, waProtoPlainString(field.Value))
		case 19:
			hint.DisplayName = waContactNameString(field.Value)
		case 37:
			hint.WAName = waContactNameString(field.Value)
		}
	}
	return hint.Normalized()
}

func waContactMetadataRecordHint(raw []byte) wacore.WAContactHint {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 16)
	if !ok {
		return wacore.WAContactHint{}
	}
	var firstName string
	var lastName string
	var hasContactMetadataMarker bool
	var hint wacore.WAContactHint
	for _, field := range fields {
		switch {
		case field.Kind == protowire.BytesType:
			switch field.Number {
			case 1:
				firstName = waContactNameString(field.Value)
			case 2:
				lastName = waContactNameString(field.Value)
			case 3:
				hint.DisplayName = waContactNameString(field.Value)
			case 6:
				hint.Username = waContactNameString(field.Value)
			case 7:
				hint.PNJID = PhoneNumberWAJID(waProtoPlainString(field.Value))
			}
		case field.Kind == protowire.VarintType:
			switch field.Number {
			case 4, 9:
				hasContactMetadataMarker = true
			case 8:
				hint.LIDJID = numericWAJID(field.Varint, "lid")
			}
		}
	}
	if !hasContactMetadataMarker {
		return wacore.WAContactHint{}
	}
	if personName := strings.Join(shared.UniqueNonEmptyStrings(firstName, lastName), " "); personName != "" {
		hint.DisplayName = shared.FirstNonEmpty(hint.DisplayName, personName)
	}
	return hint.Normalized()
}

func waMessageKeyJIDs(raw []byte) []string {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 8)
	if !ok {
		return nil
	}
	out := []string{}
	for _, field := range fields {
		if field.Kind != protowire.BytesType {
			continue
		}
		switch field.Number {
		case 1, 4:
			if jid := waProtoPlainString(field.Value); jid != "" {
				out = append(out, jid)
			}
		}
	}
	return out
}

func applyContactRecordJID(hint *wacore.WAContactHint, value string) {
	if hint == nil {
		return
	}
	jid := wacore.NormalizeWAJID(value)
	switch {
	case strings.HasSuffix(jid, "@lid"):
		hint.LIDJID = shared.FirstNonEmpty(hint.LIDJID, jid)
	case strings.HasSuffix(jid, "@s.whatsapp.net"):
		hint.PNJID = shared.FirstNonEmpty(hint.PNJID, jid)
	}
}

func dedupeWAContactHints(hints []wacore.WAContactHint) []wacore.WAContactHint {
	if len(hints) == 0 {
		return nil
	}
	merged := map[string]wacore.WAContactHint{}
	order := []string{}
	for _, hint := range hints {
		hint = hint.Normalized()
		if !hint.Valid() {
			continue
		}
		key := hint.LIDJID + "\x00" + hint.PNJID
		current, exists := merged[key]
		if !exists {
			order = append(order, key)
		}
		current.LIDJID = hint.LIDJID
		current.PNJID = hint.PNJID
		current.DisplayName = shared.FirstNonEmpty(current.DisplayName, hint.DisplayName)
		current.WAName = shared.FirstNonEmpty(current.WAName, hint.WAName)
		current.Username = shared.FirstNonEmpty(current.Username, hint.Username)
		current.VerifiedName = shared.FirstNonEmpty(current.VerifiedName, hint.VerifiedName)
		merged[key] = current
	}
	out := make([]wacore.WAContactHint, 0, len(order))
	for _, key := range order {
		out = append(out, merged[key])
	}
	return out
}

func numericWAJID(value uint64, domain string) string {
	if value == 0 {
		return ""
	}
	local := strconv.FormatUint(value, 10)
	if len(local) < 5 || len(local) > 24 {
		return ""
	}
	return local + "@" + domain
}

func PhoneNumberWAJID(value string) string {
	digits := shared.DigitsOnly(value)
	if len(digits) < 5 || len(digits) > 24 {
		return ""
	}
	return digits + "@s.whatsapp.net"
}

func waGunzipPayload(raw []byte) ([]byte, bool) {
	if len(raw) < 2 || raw[0] != 0x1f || raw[1] != 0x8b {
		return nil, false
	}
	reader, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, false
	}
	defer func() { _ = reader.Close() }()
	data, err := io.ReadAll(io.LimitReader(reader, waContactDecodedPayloadLimit+1))
	if err != nil || len(data) == 0 || len(data) > waContactDecodedPayloadLimit {
		return nil, false
	}
	return data, true
}

func waProtoPlainString(raw []byte) string {
	if len(raw) == 0 || !utf8.Valid(raw) {
		return ""
	}
	text := strings.TrimSpace(string(raw))
	if text == "" || strings.ContainsRune(text, 0) {
		return ""
	}
	return text
}

func waContactNameString(raw []byte) string {
	return wacore.WAContactName(waProtoPlainString(raw))
}
