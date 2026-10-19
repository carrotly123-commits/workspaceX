package engine

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"fmt"
	"io"
	"slices"
	"strings"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"golang.org/x/crypto/hkdf"
	"google.golang.org/protobuf/encoding/protowire"
)

const (
	waAppStatePushNameCollection = "critical_block"
	waAppStatePushNameIndex      = "setting_pushName"
	waAppStatePushNameAPIVersion = 1
	waAppStateHashBytes          = 128
	waAppStateMACBytes           = 32
	waAppStateIntegrityInfo      = "WhatsApp Patch Integrity"
	waAppStateKeyUnavailable     = "WA app-state key is not available; reconnect the account before changing profile name"
)

func buildNativePushNamePatch(state *NativeState, displayName string, timestampMS uint64) (chatdNode, nativeAppStateCollection, error) {
	keyID, keyData, err := selectedNativeAppStateKey(state)
	if err != nil {
		return chatdNode{}, nativeAppStateCollection{}, err
	}
	keys, ok := deriveNativeAppStateMutationKeys(keyData)
	if !ok {
		return chatdNode{}, nativeAppStateCollection{}, appStatePatchError("WA app-state mutation key is invalid")
	}
	current := normalizedNativeAppStateCollection(state, waAppStatePushNameCollection)
	index := []byte(`["` + waAppStatePushNameIndex + `"]`)
	encodedAction := encodeNativePushNameSyncAction(index, displayName, timestampMS)
	encryptedAction, err := encryptNativeAppStateValue(encodedAction, keys.valueEncryption)
	if err != nil {
		return chatdNode{}, nativeAppStateCollection{}, err
	}
	valueMAC, ok := nativeAppStateMutationMAC(keys.valueMAC, 0, encryptedAction, keyID)
	if !ok {
		return chatdNode{}, nativeAppStateCollection{}, appStatePatchError("WA app-state mutation operation is invalid")
	}
	indexMAC := nativeAppStateHMACSHA256(index, keys.indexMAC)
	next, hash, err := nextNativeAppStateCollection(current, indexMAC, valueMAC)
	if err != nil {
		return chatdNode{}, nativeAppStateCollection{}, err
	}
	snapshotMAC := nativeAppStateSnapshotMAC(hash, next.Version, waAppStatePushNameCollection, keys.snapshotMAC)
	patchMAC := nativeAppStatePatchMAC(snapshotMAC, [][]byte{valueMAC}, next.Version, waAppStatePushNameCollection, keys.patchMAC)
	patch := encodeNativeSyncdPatch(nativeSyncdPatch{
		KeyID:       keyID,
		IndexMAC:    indexMAC,
		Value:       append(append([]byte{}, encryptedAction...), valueMAC...),
		SnapshotMAC: snapshotMAC,
		PatchMAC:    patchMAC,
	})
	return buildNativeAppStatePatchIQ("", waAppStatePushNameCollection, current.Version, patch), next, nil
}

func buildNativeAppStatePatchIQ(id string, collectionName string, version uint64, patch []byte) chatdNode {
	attrs := map[string]string{
		"to":    "s.whatsapp.net",
		"xmlns": "w:sync:app:state",
		"type":  "set",
	}
	if strings.TrimSpace(id) != "" {
		attrs["id"] = id
	}
	return chatdNode{
		Tag:   "iq",
		Attrs: attrs,
		Content: []chatdNode{{
			Tag: "sync",
			Content: []chatdNode{{
				Tag: "collection",
				Attrs: map[string]string{
					"name":            collectionName,
					"version":         fmt.Sprintf("%d", version),
					"return_snapshot": "false",
				},
				Content: []chatdNode{{Tag: "patch", Content: patch}},
			}},
		}},
	}
}

func selectedNativeAppStateKey(state *NativeState) ([]byte, []byte, error) {
	if state == nil || len(state.AppState.Keys) == 0 {
		return nil, nil, appStatePatchError(waAppStateKeyUnavailable)
	}
	keys := make([]nativeAppStateKey, 0, len(state.AppState.Keys))
	for _, key := range state.AppState.Keys {
		key = key.normalized()
		if key.valid() {
			keys = append(keys, key)
		}
	}
	if len(keys) == 0 {
		return nil, nil, appStatePatchError(waAppStateKeyUnavailable)
	}
	slices.SortFunc(keys, func(left nativeAppStateKey, right nativeAppStateKey) int {
		if left.Timestamp != right.Timestamp {
			if left.Timestamp > right.Timestamp {
				return -1
			}
			return 1
		}
		return strings.Compare(left.KeyID, right.KeyID)
	})
	key := keys[0]
	keyID, err := decodeB64Any(key.KeyID)
	if err != nil || !validNativeAppStateKeyID(keyID) {
		return nil, nil, appStatePatchError("WA app-state key id is invalid")
	}
	keyData, err := decodeB64Any(key.KeyData)
	if err != nil || !validNativeAppStateKeyData(keyData) {
		return nil, nil, appStatePatchError("WA app-state key data is invalid")
	}
	return keyID, keyData, nil
}

func normalizedNativeAppStateCollection(state *NativeState, name string) nativeAppStateCollection {
	if state == nil {
		return nativeAppStateCollection{}
	}
	collection := state.AppState.Collections[name]
	if collection.IndexValueMACs == nil {
		collection.IndexValueMACs = map[string]string{}
	}
	if hash, err := decodeB64Any(collection.Hash); err != nil || len(hash) != waAppStateHashBytes {
		collection.Hash = b64u(make([]byte, waAppStateHashBytes))
	}
	for indexMAC, valueMAC := range collection.IndexValueMACs {
		indexRaw, indexErr := decodeB64Any(indexMAC)
		valueRaw, valueErr := decodeB64Any(valueMAC)
		if indexErr != nil || valueErr != nil || len(indexRaw) != waAppStateMACBytes || len(valueRaw) != waAppStateMACBytes {
			delete(collection.IndexValueMACs, indexMAC)
		}
	}
	return collection
}

func nextNativeAppStateCollection(collection nativeAppStateCollection, indexMAC []byte, valueMAC []byte) (nativeAppStateCollection, []byte, error) {
	hash, err := decodeB64Any(collection.Hash)
	if err != nil || len(hash) != waAppStateHashBytes {
		hash = make([]byte, waAppStateHashBytes)
	}
	var subtract [][]byte
	key := b64u(indexMAC)
	if previous := collection.IndexValueMACs[key]; previous != "" {
		previousMAC, err := decodeB64Any(previous)
		if err == nil && len(previousMAC) == waAppStateMACBytes {
			subtract = append(subtract, previousMAC)
		}
	}
	nextHash, err := nativeAppStateLTHash(hash, subtract, [][]byte{valueMAC})
	if err != nil {
		return nativeAppStateCollection{}, nil, err
	}
	next := nativeAppStateCollection{
		Version:        collection.Version + 1,
		Hash:           b64u(nextHash),
		IndexValueMACs: map[string]string{},
	}
	for currentIndex, currentValue := range collection.IndexValueMACs {
		next.IndexValueMACs[currentIndex] = currentValue
	}
	next.IndexValueMACs[key] = b64u(valueMAC)
	return next, nextHash, nil
}

func encodeNativePushNameSyncAction(index []byte, displayName string, timestampMS uint64) []byte {
	pushName := protoBytes(1, []byte(displayName))
	value := protoVarint(1, timestampMS)
	value = protoBytesInto(value, 7, pushName)
	out := []byte{}
	out = protoBytesInto(out, 1, index)
	out = protoBytesInto(out, 2, value)
	out = protoBytesInto(out, 3, nil)
	return protoVarintInto(out, 4, waAppStatePushNameAPIVersion)
}

type nativeSyncdPatch struct {
	KeyID       []byte
	IndexMAC    []byte
	Value       []byte
	SnapshotMAC []byte
	PatchMAC    []byte
}

func encodeNativeSyncdPatch(patch nativeSyncdPatch) []byte {
	keyID := protoBytes(1, patch.KeyID)
	index := protoBytes(1, patch.IndexMAC)
	value := protoBytes(1, patch.Value)
	record := []byte{}
	record = protoBytesInto(record, 1, index)
	record = protoBytesInto(record, 2, value)
	record = protoBytesInto(record, 3, keyID)
	mutation := protoVarint(1, 0)
	mutation = protoBytesInto(mutation, 2, record)
	out := protoBytes(2, mutation)
	out = protoBytesInto(out, 4, patch.SnapshotMAC)
	out = protoBytesInto(out, 5, patch.PatchMAC)
	return protoBytesInto(out, 6, keyID)
}

func protoBytes(number protowire.Number, value []byte) []byte {
	return protoBytesInto(nil, number, value)
}

func protoBytesInto(out []byte, number protowire.Number, value []byte) []byte {
	out = protowire.AppendTag(out, number, protowire.BytesType)
	return protowire.AppendBytes(out, value)
}

func protoVarint(number protowire.Number, value uint64) []byte {
	return protoVarintInto(nil, number, value)
}

func protoVarintInto(out []byte, number protowire.Number, value uint64) []byte {
	out = protowire.AppendTag(out, number, protowire.VarintType)
	return protowire.AppendVarint(out, value)
}

func encryptNativeAppStateValue(plaintext []byte, key []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	iv := randomBytes(aes.BlockSize)
	padded := pkcs7Pad(plaintext, aes.BlockSize)
	ciphertext := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ciphertext, padded)
	return append(append([]byte{}, iv...), ciphertext...), nil
}

func pkcs7Pad(raw []byte, blockSize int) []byte {
	if blockSize <= 0 {
		return append([]byte{}, raw...)
	}
	pad := blockSize - len(raw)%blockSize
	if pad == 0 {
		pad = blockSize
	}
	out := make([]byte, 0, len(raw)+pad)
	out = append(out, raw...)
	return append(out, bytes.Repeat([]byte{byte(pad)}, pad)...)
}

func nativeAppStateMutationMAC(key []byte, operation uint64, data []byte, keyID []byte) ([]byte, bool) {
	opByte, ok := nativeAppStateOperationByte(operation)
	if !ok || len(keyID) == 0 {
		return nil, false
	}
	return nativeAppStateMAC(key, append([]byte{opByte}, keyID...), data), true
}

func validNativeAppStateMutationMAC(key []byte, opByte byte, data []byte, expected []byte, keyID []byte, collectionName string) bool {
	prefixes := [][]byte{}
	if len(keyID) > 0 {
		prefixes = append(prefixes, append([]byte{opByte}, keyID...))
	}
	if strings.TrimSpace(collectionName) != "" {
		prefixes = append(prefixes, append([]byte{opByte}, []byte(collectionName)...))
	}
	for _, prefix := range prefixes {
		if hmac.Equal(expected, nativeAppStateMAC(key, prefix, data)) {
			return true
		}
	}
	return false
}

func nativeAppStateMAC(key []byte, prefix []byte, data []byte) []byte {
	macInput := make([]byte, 0, len(prefix)+len(data)+8)
	macInput = append(macInput, prefix...)
	macInput = append(macInput, data...)
	macInput = binary.BigEndian.AppendUint64(macInput, uint64(len(prefix)))
	mac := hmac.New(sha512.New, key)
	_, _ = mac.Write(macInput)
	return mac.Sum(nil)[:waAppStateMACBytes]
}

func nativeAppStateSnapshotMAC(hash []byte, version uint64, name string, key []byte) []byte {
	payload := make([]byte, 0, len(hash)+8+len(name))
	payload = append(payload, hash...)
	payload = binary.BigEndian.AppendUint64(payload, version)
	payload = append(payload, []byte(name)...)
	return nativeAppStateHMACSHA256(payload, key)
}

func nativeAppStatePatchMAC(snapshotMAC []byte, valueMACs [][]byte, version uint64, name string, key []byte) []byte {
	payload := append([]byte{}, snapshotMAC...)
	for _, valueMAC := range valueMACs {
		payload = append(payload, valueMAC...)
	}
	payload = binary.BigEndian.AppendUint64(payload, version)
	payload = append(payload, []byte(name)...)
	return nativeAppStateHMACSHA256(payload, key)
}

func nativeAppStateHMACSHA256(data []byte, key []byte) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(data)
	return mac.Sum(nil)
}

func nativeAppStateLTHash(hash []byte, subtract [][]byte, add [][]byte) ([]byte, error) {
	if len(hash) != waAppStateHashBytes {
		return nil, appStatePatchError("WA app-state hash is invalid")
	}
	out := append([]byte{}, hash...)
	var err error
	for _, item := range subtract {
		out, err = nativeAppStateLTHashApply(out, item, -1)
		if err != nil {
			return nil, err
		}
	}
	for _, item := range add {
		out, err = nativeAppStateLTHashApply(out, item, 1)
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

func nativeAppStateLTHashApply(hash []byte, item []byte, sign int) ([]byte, error) {
	derived := make([]byte, waAppStateHashBytes)
	reader := hkdf.New(sha256.New, item, nil, []byte(waAppStateIntegrityInfo))
	if _, err := io.ReadFull(reader, derived); err != nil {
		return nil, err
	}
	out := append([]byte{}, hash...)
	for offset := 0; offset < len(out); offset += 2 {
		left := binary.LittleEndian.Uint16(out[offset:])
		right := binary.LittleEndian.Uint16(derived[offset:])
		if sign < 0 {
			left -= right
		} else {
			left += right
		}
		binary.LittleEndian.PutUint16(out[offset:], left)
	}
	return out, nil
}

func appStatePatchError(message string) *shared.AppError {
	return shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_CONFLICT, message, false)
}
