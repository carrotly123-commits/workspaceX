package engine

import (
	"bufio"
	"bytes"
	"compress/zlib"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"golang.org/x/crypto/curve25519"
)

const (
	waNoisePrologue = "WA\x06\x03"
	waRoutingPrefix = "ED\x00\x01"
)

var noiseXXName = []byte("Noise_XX_25519_AESGCM_SHA256")

type chatdError struct{ message string }

func (e chatdError) Error() string { return e.message }

func newChatdError(format string, args ...any) error {
	return chatdError{message: fmt.Sprintf(format, args...)}
}

func chatdInt24(value int) ([]byte, error) {
	if value < 0 || value >= 1<<24 {
		return nil, fmt.Errorf("24-bit length out of range: %d", value)
	}
	return []byte{byte(value >> 16), byte(value >> 8), byte(value)}, nil
}

func chatdReadFrame(r *bufio.Reader, maxFrameBytes int) ([]byte, error) {
	header := make([]byte, 3)
	if _, err := io.ReadFull(r, header); err != nil {
		return nil, err
	}
	if bytes.Equal(header, []byte("GOA")) {
		return nil, newChatdError("server returned GOA before/inside frame")
	}
	length := int(header[0])<<16 | int(header[1])<<8 | int(header[2])
	if maxFrameBytes > 0 && length > maxFrameBytes {
		return nil, newChatdError("chatd frame too large: %d", length)
	}
	payload := make([]byte, length)
	_, err := io.ReadFull(r, payload)
	return payload, err
}

func chatdWriteFrame(w *bufio.Writer, payload []byte) error {
	header, err := chatdInt24(len(payload))
	if err != nil {
		return err
	}
	if _, err := w.Write(header); err != nil {
		return err
	}
	if _, err := w.Write(payload); err != nil {
		return err
	}
	return w.Flush()
}

func pbVarint(value uint64) []byte {
	out := make([]byte, 0, 10)
	for {
		b := byte(value & 0x7f)
		value >>= 7
		if value != 0 {
			out = append(out, b|0x80)
			continue
		}
		out = append(out, b)
		return out
	}
}

func pbKey(fieldNo int, wireType int) []byte {
	return pbVarint(uint64(fieldNo<<3 | wireType))
}

func pbVarintField(fieldNo int, value uint64) []byte {
	out := pbKey(fieldNo, 0)
	out = append(out, pbVarint(value)...)
	return out
}

func pbBoolField(fieldNo int, value bool) []byte {
	if value {
		return pbVarintField(fieldNo, 1)
	}
	return pbVarintField(fieldNo, 0)
}

func pbBytesField(fieldNo int, value []byte) []byte {
	if value == nil {
		return nil
	}
	out := pbKey(fieldNo, 2)
	out = append(out, pbVarint(uint64(len(value)))...)
	out = append(out, value...)
	return out
}

func pbStringField(fieldNo int, value string) []byte {
	if value == "" {
		return nil
	}
	return pbBytesField(fieldNo, []byte(value))
}

type pbValue struct {
	wireType int
	varint   uint64
	bytes    []byte
}

func readPBVarint(data []byte, pos int) (uint64, int, error) {
	var value uint64
	for shift := 0; ; shift += 7 {
		if pos >= len(data) {
			return 0, pos, newChatdError("truncated protobuf varint")
		}
		b := data[pos]
		pos++
		value |= uint64(b&0x7f) << shift
		if b&0x80 == 0 {
			return value, pos, nil
		}
		if shift > 63 {
			return 0, pos, newChatdError("protobuf varint too long")
		}
	}
}

func parsePBFields(data []byte) (map[int][]pbValue, error) {
	pos := 0
	result := map[int][]pbValue{}
	for pos < len(data) {
		key, next, err := readPBVarint(data, pos)
		if err != nil {
			return nil, err
		}
		pos = next
		fieldNo := int(key >> 3)
		wireType := int(key & 7)
		value := pbValue{wireType: wireType}
		switch wireType {
		case 0:
			v, next, err := readPBVarint(data, pos)
			if err != nil {
				return nil, err
			}
			pos = next
			value.varint = v
		case 1:
			if pos+8 > len(data) {
				return nil, newChatdError("truncated protobuf fixed64")
			}
			value.bytes = append([]byte{}, data[pos:pos+8]...)
			pos += 8
		case 2:
			size, next, err := readPBVarint(data, pos)
			if err != nil {
				return nil, err
			}
			pos = next
			if pos+int(size) > len(data) {
				return nil, newChatdError("truncated protobuf bytes field")
			}
			value.bytes = append([]byte{}, data[pos:pos+int(size)]...)
			pos += int(size)
		case 5:
			if pos+4 > len(data) {
				return nil, newChatdError("truncated protobuf fixed32")
			}
			value.bytes = append([]byte{}, data[pos:pos+4]...)
			pos += 4
		default:
			return nil, newChatdError("unsupported protobuf wire type %d", wireType)
		}
		result[fieldNo] = append(result[fieldNo], value)
	}
	return result, nil
}

func firstPBBytes(fields map[int][]pbValue, fieldNo int, label string) ([]byte, error) {
	for _, value := range fields[fieldNo] {
		if value.wireType == 2 {
			return append([]byte{}, value.bytes...), nil
		}
	}
	return nil, newChatdError("missing protobuf bytes/message field %d (%s)", fieldNo, label)
}

func firstPBVarint(fields map[int][]pbValue, fieldNo int, label string, defaultValue *uint64) (uint64, error) {
	for _, value := range fields[fieldNo] {
		if value.wireType == 0 {
			return value.varint, nil
		}
	}
	if defaultValue != nil {
		return *defaultValue, nil
	}
	return 0, newChatdError("missing protobuf varint field %d (%s)", fieldNo, label)
}

func optionalPBBytes(fields map[int][]pbValue, fieldNo int) []byte {
	for _, value := range fields[fieldNo] {
		if value.wireType == 2 {
			return append([]byte{}, value.bytes...)
		}
	}
	return nil
}

type serverHello struct {
	ephemeral         []byte
	staticCiphertext  []byte
	payloadCiphertext []byte
}

type clientHelloMessage struct {
	ephemeral []byte
}

func buildClientHello(message clientHelloMessage) []byte {
	out := []byte{}
	out = append(out, pbBytesField(1, message.ephemeral)...)
	return pbBytesField(2, out)
}

func parseServerHello(wrapper []byte) (serverHello, error) {
	wrapperFields, err := parsePBFields(wrapper)
	if err != nil {
		return serverHello{}, err
	}
	helloBytes, err := firstPBBytes(wrapperFields, 3, "serverHello")
	if err != nil {
		return serverHello{}, err
	}
	fields, err := parsePBFields(helloBytes)
	if err != nil {
		return serverHello{}, err
	}
	ephemeral, err := firstPBBytes(fields, 1, "ephemeral")
	if err != nil {
		return serverHello{}, err
	}
	payloadCiphertext, err := firstPBBytes(fields, 3, "payload")
	if err != nil {
		return serverHello{}, err
	}
	return serverHello{
		ephemeral:         ephemeral,
		staticCiphertext:  optionalPBBytes(fields, 2),
		payloadCiphertext: payloadCiphertext,
	}, nil
}

func buildClientFinish(staticCiphertext []byte, payloadCiphertext []byte) []byte {
	out := []byte{}
	out = append(out, pbBytesField(1, staticCiphertext)...)
	out = append(out, pbBytesField(2, payloadCiphertext)...)
	return pbBytesField(4, out)
}

type noiseXXState struct {
	chainingKey   []byte
	handshakeHash []byte
	cipherKey     []byte
	nonce         uint64
}

func newNoiseState(handshakeName []byte) *noiseXXState {
	name := normalizeNoiseHandshakeName(handshakeName)
	state := &noiseXXState{chainingKey: append([]byte{}, name...), handshakeHash: append([]byte{}, name...)}
	state.mixHash([]byte(waNoisePrologue))
	return state
}

func normalizeNoiseHandshakeName(handshakeName []byte) []byte {
	if len(handshakeName) > 32 {
		sum := sha256.Sum256(handshakeName)
		return append([]byte{}, sum[:]...)
	}
	out := make([]byte, 32)
	copy(out, handshakeName)
	return out
}

func (s *noiseXXState) mixHash(data []byte) {
	sum := sha256.Sum256(append(append([]byte{}, s.handshakeHash...), data...))
	s.handshakeHash = sum[:]
}

func (s *noiseXXState) mixKey(inputKeyMaterial []byte) {
	expanded := hkdfExtractExpand(s.chainingKey, inputKeyMaterial, nil, 64)
	s.chainingKey = append([]byte{}, expanded[:32]...)
	s.cipherKey = append([]byte{}, expanded[32:64]...)
	s.nonce = 0
}

func (s *noiseXXState) encryptAndHash(plaintext []byte) ([]byte, error) {
	ciphertext := append([]byte{}, plaintext...)
	var err error
	if s.cipherKey != nil {
		ciphertext, err = aesGCMSeal(s.cipherKey, nativeNonce(s.nonce), plaintext, s.handshakeHash)
		if err != nil {
			return nil, err
		}
		s.nonce++
	}
	s.mixHash(ciphertext)
	return ciphertext, nil
}

func (s *noiseXXState) decryptAndHash(ciphertext []byte) ([]byte, error) {
	plaintext := append([]byte{}, ciphertext...)
	var err error
	if s.cipherKey != nil {
		plaintext, err = aesGCMOpen(s.cipherKey, nativeNonce(s.nonce), ciphertext, s.handshakeHash)
		if err != nil {
			return nil, err
		}
		s.nonce++
	}
	s.mixHash(ciphertext)
	return plaintext, nil
}

func (s *noiseXXState) split() ([]byte, []byte) {
	expanded := hkdfExtractExpand(s.chainingKey, nil, nil, 64)
	return append([]byte{}, expanded[:32]...), append([]byte{}, expanded[32:64]...)
}

type chatdTransportKeys struct {
	sendKey            []byte
	recvKey            []byte
	serverStaticPublic []byte
	sendCounter        uint64
	recvCounter        uint64
}

func (k *chatdTransportKeys) encrypt(plaintext []byte) ([]byte, error) {
	ciphertext, err := aesGCMSeal(k.sendKey, nativeNonce(k.sendCounter), plaintext, nil)
	if err != nil {
		return nil, err
	}
	k.sendCounter++
	return ciphertext, nil
}

func (k *chatdTransportKeys) decrypt(ciphertext []byte) ([]byte, error) {
	plaintext, err := aesGCMOpen(k.recvKey, nativeNonce(k.recvCounter), ciphertext, nil)
	if err != nil {
		return nil, err
	}
	k.recvCounter++
	return plaintext, nil
}

func doNoiseHandshake(rw *bufio.ReadWriter, clientStaticPrivate []byte, clientStaticPublic []byte, loginPayload []byte, routingInfo []byte, maxFrameBytes int) (*chatdTransportKeys, error) {
	if len(routingInfo) > 0 {
		header, err := chatdInt24(len(routingInfo))
		if err != nil {
			return nil, chatdPhase("chatd encode routing info", err)
		}
		if _, err := rw.Write(append(append([]byte(waRoutingPrefix), header...), routingInfo...)); err != nil {
			return nil, chatdPhase("chatd write routing info", err)
		}
	}
	if _, err := rw.Write([]byte(waNoisePrologue)); err != nil {
		return nil, chatdPhase("chatd write noise prologue", err)
	}
	if err := rw.Flush(); err != nil {
		return nil, chatdPhase("chatd flush noise prologue", err)
	}
	clientEphemeralPrivate := make([]byte, curve25519.ScalarSize)
	if _, err := io.ReadFull(rand.Reader, clientEphemeralPrivate); err != nil {
		return nil, chatdPhase("chatd generate ephemeral", err)
	}
	clientEphemeralPublic, err := curve25519.X25519(clientEphemeralPrivate, curve25519.Basepoint)
	if err != nil {
		return nil, chatdPhase("chatd generate ephemeral", err)
	}
	return doNoiseXXHandshake(rw, clientStaticPrivate, clientStaticPublic, loginPayload, maxFrameBytes, clientEphemeralPrivate, clientEphemeralPublic)
}

func doNoiseXXHandshake(rw *bufio.ReadWriter, clientStaticPrivate []byte, clientStaticPublic []byte, loginPayload []byte, maxFrameBytes int, clientEphemeralPrivate []byte, clientEphemeralPublic []byte) (*chatdTransportKeys, error) {
	noise := newNoiseState(noiseXXName)
	noise.mixHash(clientEphemeralPublic)
	if err := chatdWriteFrame(rw.Writer, buildClientHello(clientHelloMessage{ephemeral: clientEphemeralPublic})); err != nil {
		return nil, chatdPhase("chatd write client hello", err)
	}
	serverWrapper, err := chatdReadFrame(rw.Reader, maxFrameBytes)
	if err != nil {
		return nil, chatdPhase("chatd read server hello", err)
	}
	hello, err := parseServerHello(serverWrapper)
	if err != nil {
		return nil, chatdPhase("chatd parse server hello", err)
	}
	if len(hello.ephemeral) != curve25519.PointSize {
		return nil, newChatdError("server ephemeral length is %d", len(hello.ephemeral))
	}
	if len(hello.staticCiphertext) == 0 {
		return nil, newChatdError("server hello is missing static ciphertext")
	}
	noise.mixHash(hello.ephemeral)
	ee, err := nativeX25519Agree(clientEphemeralPrivate, hello.ephemeral)
	if err != nil {
		return nil, chatdPhase("chatd mix ee", err)
	}
	noise.mixKey(ee)
	serverStaticPublic, err := noise.decryptAndHash(hello.staticCiphertext)
	if err != nil {
		return nil, chatdPhase("chatd decrypt server static", err)
	}
	if len(serverStaticPublic) != curve25519.PointSize {
		return nil, newChatdError("server static public length is %d", len(serverStaticPublic))
	}
	es, err := nativeX25519Agree(clientEphemeralPrivate, serverStaticPublic)
	if err != nil {
		return nil, chatdPhase("chatd mix es", err)
	}
	noise.mixKey(es)
	_, err = noise.decryptAndHash(hello.payloadCiphertext)
	if err != nil {
		return nil, chatdPhase("chatd decrypt server payload", err)
	}
	encryptedStatic, err := noise.encryptAndHash(clientStaticPublic)
	if err != nil {
		return nil, chatdPhase("chatd encrypt client static", err)
	}
	se, err := nativeX25519Agree(clientStaticPrivate, hello.ephemeral)
	if err != nil {
		return nil, chatdPhase("chatd mix se", err)
	}
	noise.mixKey(se)
	encryptedPayload, err := noise.encryptAndHash(loginPayload)
	if err != nil {
		return nil, chatdPhase("chatd encrypt login payload", err)
	}
	if err := chatdWriteFrame(rw.Writer, buildClientFinish(encryptedStatic, encryptedPayload)); err != nil {
		return nil, chatdPhase("chatd write client finish", err)
	}
	sendKey, recvKey := noise.split()
	return &chatdTransportKeys{sendKey: sendKey, recvKey: recvKey, serverStaticPublic: serverStaticPublic}, nil
}

type loginIdentity struct {
	jid      string
	username uint64
}

type userAgentConfig struct {
	version       string
	osVersion     string
	manufacturer  string
	device        string
	osBuildNumber string
	phoneID       string
	localeLang    string
	localeCountry string
	deviceBoard   string
	deviceExpID   string
	deviceType    uint64
	modelType     string
	mcc           string
	mnc           string
}

type loginPayloadConfig struct {
	sessionID           uint64
	passive             bool
	pushName            string
	shortConnect        bool
	connectType         uint64
	connectReason       uint64
	connectAttemptCount uint64
	deviceID            *uint64
	product             uint64
	oc                  bool
	lc                  uint64
}

func parseVersion(version string) [5]uint64 {
	var out [5]uint64
	parts := strings.Split(version, ".")
	for i := 0; i < len(parts) && i < len(out); i++ {
		var value uint64
		for _, r := range parts[i] {
			if r < '0' || r > '9' {
				break
			}
			value = value*10 + uint64(r-'0')
		}
		out[i] = value
	}
	return out
}

func buildAppVersion(version string) []byte {
	v := parseVersion(version)
	out := []byte{}
	for i, value := range v {
		out = append(out, pbVarintField(i+1, value)...)
	}
	return out
}

func buildUserAgentPayload(cfg userAgentConfig) []byte {
	out := []byte{}
	out = append(out, pbVarintField(1, 0)...)
	out = append(out, pbBytesField(2, buildAppVersion(cfg.version))...)
	out = append(out, pbStringField(3, cfg.mcc)...)
	out = append(out, pbStringField(4, cfg.mnc)...)
	out = append(out, pbStringField(5, cfg.osVersion)...)
	out = append(out, pbStringField(6, cfg.manufacturer)...)
	out = append(out, pbStringField(7, cfg.device)...)
	out = append(out, pbStringField(8, cfg.osBuildNumber)...)
	out = append(out, pbStringField(9, cfg.phoneID)...)
	out = append(out, pbVarintField(10, 0)...)
	out = append(out, pbStringField(11, cfg.localeLang)...)
	out = append(out, pbStringField(12, cfg.localeCountry)...)
	out = append(out, pbStringField(13, cfg.deviceBoard)...)
	out = append(out, pbStringField(14, cfg.deviceExpID)...)
	out = append(out, pbVarintField(15, cfg.deviceType)...)
	out = append(out, pbStringField(16, cfg.modelType)...)
	return out
}

func buildLoginPayload(identity loginIdentity, ua userAgentConfig, cfg loginPayloadConfig) []byte {
	out := []byte{}
	out = append(out, pbVarintField(1, identity.username)...)
	out = append(out, pbBoolField(3, cfg.passive)...)
	out = append(out, pbBytesField(5, buildUserAgentPayload(ua))...)
	out = append(out, pbStringField(7, cfg.pushName)...)
	out = append(out, pbVarintField(9, cfg.sessionID)...)
	out = append(out, pbBoolField(10, cfg.shortConnect)...)
	out = append(out, pbVarintField(12, cfg.connectType)...)
	out = append(out, pbVarintField(13, cfg.connectReason)...)
	out = append(out, pbVarintField(16, cfg.connectAttemptCount)...)
	if cfg.deviceID != nil {
		out = append(out, pbVarintField(18, *cfg.deviceID)...)
	}
	out = append(out, pbVarintField(20, cfg.product)...)
	out = append(out, pbBoolField(23, cfg.oc)...)
	out = append(out, pbVarintField(24, cfg.lc)...)
	return out
}

func defaultLoginPayload(identity loginIdentity, state NativeState, version string) []byte {
	return loginPayload(identity, state, version, false, false)
}

func passiveLoginCheckPayload(identity loginIdentity, state NativeState, version string) []byte {
	return loginPayload(identity, state, version, true, true)
}

func loginPayload(identity loginIdentity, state NativeState, version string, passive bool, shortConnect bool) []byte {
	ua := chatdUserAgentForState(state, version)
	buf := make([]byte, 8)
	_, _ = io.ReadFull(rand.Reader, buf)
	sessionID := binary.BigEndian.Uint64(buf)&0x7fffffff + 1
	cfg := loginPayloadConfig{sessionID: sessionID, passive: passive, shortConnect: shortConnect, connectType: 1, connectReason: 1, product: 0, oc: true, lc: 0}
	return buildLoginPayload(identity, ua, cfg)
}

func chatdUserAgentForState(state NativeState, version string) userAgentConfig {
	profile := NormalizeNativePhoneProfile(state.Profile, "")
	cfg := userAgentConfig{
		version:       NativeAppVersion(version),
		osVersion:     profile.AndroidVersion,
		manufacturer:  profile.DeviceVendor,
		device:        profile.DeviceModel,
		osBuildNumber: "TP1A.220624.014",
		phoneID:       profile.FDID,
		localeLang:    "en",
		localeCountry: "US",
		deviceBoard:   "lahaina",
		deviceExpID:   shared.FirstNonEmpty(profile.ExpIDUUID, profile.ExpID),
		modelType:     "phone",
	}
	if profile.AdditionalMapFields != nil {
		cfg.mcc = profile.AdditionalMapFields["mcc"]
		cfg.mnc = profile.AdditionalMapFields["mnc"]
	}
	return cfg
}

func compressMaybeDecodeNodePayload(plaintext []byte) ([]byte, error) {
	if len(plaintext) == 0 {
		return nil, newChatdError("empty decrypted frame")
	}
	if len(plaintext) == 1 {
		return nil, newChatdError("header-only decrypted frame")
	}
	header := plaintext[0]
	body := plaintext[1:]
	if header&2 != 0 {
		zr, err := zlib.NewReader(bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		decompressed, err := io.ReadAll(zr)
		_ = zr.Close()
		if err != nil {
			return nil, err
		}
		body = decompressed
	}
	if header&1 != 0 {
		return nil, newChatdError("fragmented stanza is not supported")
	}
	return body, nil
}

func waitDeadline(timeout time.Duration) time.Time {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return time.Now().Add(timeout)
}
