package engine

import (
	"bytes"
	"compress/zlib"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
	"github.com/byte-v-forge/wa-app/internal/waapp/waproto"
	"golang.org/x/crypto/hkdf"
	"google.golang.org/protobuf/encoding/protowire"
)

const (
	waAppStateProtoMaxDepth       = 6
	waAppStateProtoMaxFields      = 256
	waAppStateCollectionNameLimit = 96
)

const waAppStateMutationKeyInfo = "WhatsApp Mutation Keys"

func applyNativeAppStateKeys(state *NativeState, raw []byte) bool {
	if state == nil || len(raw) == 0 {
		return false
	}
	keys := nativeAppStateKeys(raw)
	if len(keys) == 0 {
		return false
	}
	state.ensureMaps()
	changed := false
	for _, key := range keys {
		key = key.normalized()
		if !key.valid() {
			continue
		}
		current, exists := state.AppState.Keys[key.KeyID]
		if exists && current.KeyData == key.KeyData && current.Fingerprint == key.Fingerprint && current.Timestamp == key.Timestamp {
			continue
		}
		state.AppState.Keys[key.KeyID] = key
		changed = true
	}
	return changed
}

func nativeAppStateKeys(raw []byte) []nativeAppStateKey {
	keys := []nativeAppStateKey{}
	collectNativeAppStateKeys(raw, nil, 0, &keys)
	return dedupeNativeAppStateKeys(keys)
}

func collectNativeAppStateKeys(raw []byte, path []protowire.Number, depth int, keys *[]nativeAppStateKey) {
	if depth > waAppStateProtoMaxDepth || len(raw) == 0 {
		return
	}
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, waAppStateProtoMaxFields)
	if !ok {
		return
	}
	for _, field := range fields {
		if field.Kind != protowire.BytesType {
			continue
		}
		fieldPath := waproto.AppendWAPath(path, field.Number)
		normalized := waproto.NormalizeWAMessagePath(fieldPath)
		if waproto.SameWAPath(normalized, 12, 7) {
			*keys = append(*keys, parseNativeAppStateKeyShare(field.Value)...)
			continue
		}
		if maybeNativeAppStateKeyShare(field.Value) {
			*keys = append(*keys, parseNativeAppStateKeyShare(field.Value)...)
		}
		collectNativeAppStateKeys(field.Value, fieldPath, depth+1, keys)
	}
}

func maybeNativeAppStateKeyShare(raw []byte) bool {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 8)
	if !ok {
		return false
	}
	keyRecords := 0
	for _, field := range fields {
		if field.Kind == protowire.BytesType && field.Number == 1 && parseNativeAppStateKeyRecord(field.Value).valid() {
			keyRecords++
		}
	}
	return keyRecords > 0
}

func parseNativeAppStateKeyShare(raw []byte) []nativeAppStateKey {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, waAppStateProtoMaxFields)
	if !ok {
		return nil
	}
	keys := []nativeAppStateKey{}
	for _, field := range fields {
		if field.Kind != protowire.BytesType || field.Number != 1 {
			continue
		}
		if key := parseNativeAppStateKeyRecord(field.Value); key.valid() {
			keys = append(keys, key)
		}
	}
	return dedupeNativeAppStateKeys(keys)
}

func parseNativeAppStateKeyRecord(raw []byte) nativeAppStateKey {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 8)
	if !ok {
		return nativeAppStateKey{}
	}
	var keyID []byte
	var keyData nativeAppStateKeyData
	for _, field := range fields {
		if field.Kind != protowire.BytesType {
			continue
		}
		switch field.Number {
		case 1:
			keyID = parseNativeAppStateKeyID(field.Value)
		case 2:
			keyData = parseNativeAppStateKeyData(field.Value)
		}
	}
	out := nativeAppStateKey{
		KeyID:       b64u(keyID),
		KeyData:     b64u(keyData.keyData),
		Fingerprint: b64u(keyData.fingerprint),
		Timestamp:   keyData.timestamp,
	}
	return out.normalized()
}

func parseNativeAppStateKeyID(raw []byte) []byte {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 4)
	if !ok {
		return nil
	}
	for _, field := range fields {
		if field.Kind == protowire.BytesType && field.Number == 1 && validNativeAppStateKeyID(field.Value) {
			return append([]byte{}, field.Value...)
		}
	}
	return nil
}

type nativeAppStateKeyData struct {
	keyData     []byte
	fingerprint []byte
	timestamp   int64
}

func parseNativeAppStateKeyData(raw []byte) nativeAppStateKeyData {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 16)
	if !ok {
		return nativeAppStateKeyData{}
	}
	var out nativeAppStateKeyData
	for _, field := range fields {
		switch {
		case field.Kind == protowire.BytesType && field.Number == 1:
			out.keyData = append([]byte{}, field.Value...)
		case field.Kind == protowire.BytesType && field.Number == 2:
			out.fingerprint = append([]byte{}, field.Value...)
		case field.Kind == protowire.VarintType && field.Number == 3:
			out.timestamp = int64(field.Varint)
		}
	}
	if !validNativeAppStateKeyData(out.keyData) {
		out.keyData = nil
	}
	return out
}

func validNativeAppStateKeyID(raw []byte) bool {
	return len(raw) == 6
}

func validNativeAppStateKeyData(raw []byte) bool {
	return len(raw) >= 16 && len(raw) <= 64
}

func (k nativeAppStateKey) normalized() nativeAppStateKey {
	keyID, err := decodeB64Any(k.KeyID)
	if err != nil || !validNativeAppStateKeyID(keyID) {
		k.KeyID = ""
	} else {
		k.KeyID = b64u(keyID)
	}
	keyData, err := decodeB64Any(k.KeyData)
	if err != nil || !validNativeAppStateKeyData(keyData) {
		k.KeyData = ""
	} else {
		k.KeyData = b64u(keyData)
	}
	if k.Fingerprint != "" {
		if fingerprint, err := decodeB64Any(k.Fingerprint); err == nil {
			k.Fingerprint = b64u(fingerprint)
		} else if _, err := hex.DecodeString(k.Fingerprint); err != nil {
			k.Fingerprint = ""
		}
	}
	return k
}

func (k nativeAppStateKey) valid() bool {
	k = k.normalized()
	return k.KeyID != "" && k.KeyData != ""
}

func dedupeNativeAppStateKeys(keys []nativeAppStateKey) []nativeAppStateKey {
	if len(keys) == 0 {
		return nil
	}
	merged := map[string]nativeAppStateKey{}
	order := []string{}
	for _, key := range keys {
		key = key.normalized()
		if !key.valid() {
			continue
		}
		current, exists := merged[key.KeyID]
		if !exists {
			order = append(order, key.KeyID)
			merged[key.KeyID] = key
			continue
		}
		if current.Timestamp <= key.Timestamp || !bytes.Equal(mustDecodeNativeAppStateValue(current.KeyData), mustDecodeNativeAppStateValue(key.KeyData)) {
			merged[key.KeyID] = key
		}
	}
	out := make([]nativeAppStateKey, 0, len(order))
	for _, keyID := range order {
		out = append(out, merged[keyID])
	}
	return out
}

func mustDecodeNativeAppStateValue(value string) []byte {
	out, err := decodeB64Any(value)
	if err != nil {
		return nil
	}
	return out
}

func nativeAppStateContactHints(state *NativeState, raw []byte) []wacore.WAContactHint {
	if len(raw) == 0 {
		return nil
	}
	hints := []wacore.WAContactHint{}
	collectNativeAppStateContactHints(state, raw, 0, &hints)
	return dedupeWAContactHints(hints)
}

func collectNativeAppStateContactHints(state *NativeState, raw []byte, depth int, hints *[]wacore.WAContactHint) {
	if depth > waAppStateProtoMaxDepth || len(raw) == 0 {
		return
	}
	*hints = append(*hints, waAppStateSnapshotContactHints(raw)...)
	*hints = append(*hints, waAppStatePatchContactHints(state, raw)...)
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, waAppStateProtoMaxFields)
	if !ok {
		return
	}
	for _, field := range fields {
		if field.Kind != protowire.BytesType {
			continue
		}
		collectNativeAppStateContactHints(state, field.Value, depth+1, hints)
	}
}

func waAppStateSnapshotContactHints(raw []byte) []wacore.WAContactHint {
	payloads := [][]byte{raw}
	if snapshot, ok := waAppStateSnapshotEnvelopePayload(raw); ok {
		payloads = append([][]byte{snapshot}, payloads...)
	}
	hints := []wacore.WAContactHint{}
	for _, payload := range payloads {
		fields, ok := waproto.ParseWAProtoFieldsWithLimit(payload, waAppStateProtoMaxFields)
		if !ok {
			continue
		}
		collectionName := ""
		records := [][]byte{}
		for _, field := range fields {
			switch {
			case field.Kind == protowire.BytesType && field.Number == 2:
				collectionName = waAppStateCollectionName(field.Value)
			case field.Kind == protowire.BytesType && field.Number == 3:
				records = append(records, field.Value)
			}
		}
		if collectionName == "" || len(records) == 0 {
			continue
		}
		for _, record := range records {
			hints = append(hints, waAppStateSnapshotRecordContactHints(record)...)
		}
		if len(hints) > 0 {
			break
		}
	}
	return dedupeWAContactHints(hints)
}

func waAppStateSnapshotEnvelopePayload(raw []byte) ([]byte, bool) {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 8)
	if !ok {
		return nil, false
	}
	var payload []byte
	compressed := false
	for _, field := range fields {
		switch {
		case field.Kind == protowire.BytesType && field.Number == 1:
			payload = field.Value
		case field.Kind == protowire.VarintType && field.Number == 2:
			compressed = field.Varint != 0
		}
	}
	if len(payload) == 0 {
		return nil, false
	}
	if compressed {
		if inflated, ok := waAppStateInflatePayload(payload); ok {
			payload = inflated
		}
	}
	return payload, true
}

func waAppStateSnapshotRecordContactHints(raw []byte) []wacore.WAContactHint {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 16)
	if !ok {
		return nil
	}
	for _, field := range fields {
		if field.Kind == protowire.BytesType && field.Number == 1 {
			return waSyncdIndexedContactHints(field.Value)
		}
	}
	return nil
}

func waAppStatePatchContactHints(state *NativeState, raw []byte) []wacore.WAContactHint {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, waAppStateProtoMaxFields)
	if !ok {
		return nil
	}
	patch := nativeAppStatePatch{collectionName: "", keyID: nil, mutations: []nativeAppStateMutation{}}
	fieldOneMutations := []nativeAppStateMutation{}
	for _, field := range fields {
		switch {
		case field.Kind == protowire.BytesType && field.Number == 2:
			if mutation, ok := parseNativeAppStateMutation(field.Value); ok {
				patch.mutations = append(patch.mutations, mutation)
			}
		case field.Kind == protowire.BytesType && field.Number == 1:
			if mutation, ok := parseNativeAppStateMutation(field.Value); ok {
				fieldOneMutations = append(fieldOneMutations, mutation)
			}
		case field.Kind == protowire.BytesType && field.Number == 6:
			patch.keyID = parseNativeAppStateRawKeyID(field.Value)
		case field.Kind == protowire.BytesType && field.Number == 9:
			patch.collectionName = shared.FirstNonEmpty(patch.collectionName, waAppStatePatchDebugCollectionName(field.Value))
		}
	}
	if len(patch.mutations) == 0 {
		patch.mutations = fieldOneMutations
	}
	if len(patch.mutations) == 0 {
		return nil
	}
	hints := []wacore.WAContactHint{}
	for _, mutation := range patch.mutations {
		if len(mutation.keyID) == 0 {
			mutation.keyID = patch.keyID
		}
		hints = append(hints, nativeAppStateMutationContactHints(state, patch.collectionName, mutation)...)
	}
	return dedupeWAContactHints(hints)
}

type nativeAppStatePatch struct {
	collectionName string
	keyID          []byte
	mutations      []nativeAppStateMutation
}

type nativeAppStateMutation struct {
	operation uint64
	record    nativeAppStateMutationRecord
	keyID     []byte
}

type nativeAppStateMutationRecord struct {
	index []byte
	value []byte
	keyID []byte
}

func parseNativeAppStateMutation(raw []byte) (nativeAppStateMutation, bool) {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 16)
	if !ok {
		return nativeAppStateMutation{}, false
	}
	mutation := nativeAppStateMutation{}
	hasOperation := false
	hasRecord := false
	for _, field := range fields {
		switch {
		case field.Kind == protowire.VarintType && field.Number == 1:
			if field.Varint > 1 {
				return nativeAppStateMutation{}, false
			}
			mutation.operation = field.Varint
			hasOperation = true
		case field.Kind == protowire.BytesType && field.Number == 2:
			if record, ok := parseNativeAppStateMutationRecord(field.Value); ok {
				mutation.record = record
				mutation.keyID = record.keyID
				hasRecord = true
			}
		}
	}
	if !hasOperation || !hasRecord {
		return nativeAppStateMutation{}, false
	}
	return mutation, true
}

func parseNativeAppStateMutationRecord(raw []byte) (nativeAppStateMutationRecord, bool) {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 16)
	if !ok {
		return nativeAppStateMutationRecord{}, false
	}
	record := nativeAppStateMutationRecord{}
	for _, field := range fields {
		if field.Kind != protowire.BytesType {
			continue
		}
		switch field.Number {
		case 1:
			record.index = parseNativeAppStateBlob(field.Value)
		case 2:
			record.value = parseNativeAppStateBlob(field.Value)
		case 3:
			record.keyID = parseNativeAppStateRawKeyID(field.Value)
		}
	}
	if len(record.value) == 0 || len(record.index) == 0 {
		return nativeAppStateMutationRecord{}, false
	}
	return record, true
}

func parseNativeAppStateBlob(raw []byte) []byte {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 4)
	if !ok {
		return nil
	}
	for _, field := range fields {
		if field.Kind == protowire.BytesType && field.Number == 1 {
			return append([]byte{}, field.Value...)
		}
	}
	return nil
}

func parseNativeAppStateRawKeyID(raw []byte) []byte {
	if validNativeAppStateKeyID(raw) {
		return append([]byte{}, raw...)
	}
	return parseNativeAppStateKeyID(raw)
}

func nativeAppStateMutationContactHints(state *NativeState, collectionName string, mutation nativeAppStateMutation) []wacore.WAContactHint {
	if hints := waSyncdIndexedContactHints(mutation.record.value); len(hints) > 0 {
		return hints
	}
	if state == nil || collectionName == "" || len(mutation.keyID) == 0 {
		return nil
	}
	decrypted, ok := decryptNativeAppStateMutation(state, collectionName, mutation)
	if !ok {
		return nil
	}
	return waSyncdIndexedContactHints(decrypted)
}

func decryptNativeAppStateMutation(state *NativeState, collectionName string, mutation nativeAppStateMutation) ([]byte, bool) {
	if state == nil || len(mutation.record.value) < 48 || collectionName == "" {
		return nil, false
	}
	keyData, ok := nativeAppStateKeyDataForID(state, mutation.keyID)
	if !ok {
		return nil, false
	}
	keys, ok := deriveNativeAppStateMutationKeys(keyData)
	if !ok {
		return nil, false
	}
	cipherValue := mutation.record.value
	macOffset := len(cipherValue) - 32
	iv := cipherValue[:16]
	ciphertext := cipherValue[16:macOffset]
	dataMAC := cipherValue[macOffset:]
	if len(ciphertext) == 0 || len(ciphertext)%aes.BlockSize != 0 {
		return nil, false
	}
	opByte, ok := nativeAppStateOperationByte(mutation.operation)
	if !ok {
		return nil, false
	}
	macPayload := cipherValue[:macOffset]
	if !validNativeAppStateMutationMAC(keys.valueMAC, opByte, macPayload, dataMAC, mutation.keyID, collectionName) {
		return nil, false
	}
	block, err := aes.NewCipher(keys.valueEncryption)
	if err != nil {
		return nil, false
	}
	plaintext := make([]byte, len(ciphertext))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plaintext, ciphertext)
	plaintext, ok = pkcs7Unpad(plaintext, aes.BlockSize)
	if !ok {
		return nil, false
	}
	index := nativeAppStateSyncActionIndex(plaintext)
	if len(index) == 0 {
		return nil, false
	}
	mac := hmac.New(sha256.New, keys.indexMAC)
	_, _ = mac.Write(index)
	if !hmac.Equal(mutation.record.index, mac.Sum(nil)) {
		return nil, false
	}
	return plaintext, true
}

type nativeAppStateMutationKeys struct {
	indexMAC        []byte
	valueEncryption []byte
	valueMAC        []byte
	snapshotMAC     []byte
	patchMAC        []byte
}

func deriveNativeAppStateMutationKeys(keyData []byte) (nativeAppStateMutationKeys, bool) {
	if !validNativeAppStateKeyData(keyData) {
		return nativeAppStateMutationKeys{}, false
	}
	reader := hkdf.New(sha256.New, keyData, nil, []byte(waAppStateMutationKeyInfo))
	out := make([]byte, 160)
	if _, err := io.ReadFull(reader, out); err != nil {
		return nativeAppStateMutationKeys{}, false
	}
	return nativeAppStateMutationKeys{
		indexMAC:        append([]byte{}, out[:32]...),
		valueEncryption: append([]byte{}, out[32:64]...),
		valueMAC:        append([]byte{}, out[64:96]...),
		snapshotMAC:     append([]byte{}, out[96:128]...),
		patchMAC:        append([]byte{}, out[128:160]...),
	}, true
}

func nativeAppStateKeyDataForID(state *NativeState, keyID []byte) ([]byte, bool) {
	if state == nil || len(keyID) == 0 {
		return nil, false
	}
	key := state.AppState.Keys[b64u(keyID)]
	if !key.valid() {
		return nil, false
	}
	keyData, err := decodeB64Any(key.KeyData)
	if err != nil || !validNativeAppStateKeyData(keyData) {
		return nil, false
	}
	return keyData, true
}

func nativeAppStateOperationByte(operation uint64) (byte, bool) {
	switch operation {
	case 0:
		return 1, true
	case 1:
		return 2, true
	default:
		return 0, false
	}
}

func nativeAppStateSyncActionIndex(raw []byte) []byte {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 8)
	if !ok {
		return nil
	}
	for _, field := range fields {
		if field.Kind == protowire.BytesType && field.Number == 1 && len(waSyncdIndexValues(field.Value)) > 0 {
			return append([]byte{}, field.Value...)
		}
	}
	return nil
}

func pkcs7Unpad(raw []byte, blockSize int) ([]byte, bool) {
	if len(raw) == 0 || blockSize <= 0 || len(raw)%blockSize != 0 {
		return nil, false
	}
	pad := int(raw[len(raw)-1])
	if pad == 0 || pad > blockSize || pad > len(raw) {
		return nil, false
	}
	for _, value := range raw[len(raw)-pad:] {
		if int(value) != pad {
			return nil, false
		}
	}
	return raw[:len(raw)-pad], true
}

func waAppStatePatchDebugCollectionName(raw []byte) string {
	fields, ok := waproto.ParseWAProtoFieldsWithLimit(raw, 32)
	if !ok {
		return ""
	}
	for _, field := range fields {
		if field.Kind == protowire.BytesType && field.Number == 4 {
			if value := waAppStateCollectionName(field.Value); value != "" {
				return value
			}
		}
	}
	return ""
}

func waAppStateCollectionName(raw []byte) string {
	if len(raw) == 0 || len(raw) > waAppStateCollectionNameLimit || !utf8.Valid(raw) {
		return ""
	}
	value := strings.TrimSpace(string(raw))
	if value == "" || strings.ContainsRune(value, 0) || strings.ContainsAny(value, "[]{}\n\r\t") {
		return ""
	}
	return value
}

func waAppStateInflatePayload(raw []byte) ([]byte, bool) {
	if decoded, ok := waGunzipPayload(raw); ok {
		return decoded, true
	}
	reader, err := zlib.NewReader(bytes.NewReader(raw))
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
