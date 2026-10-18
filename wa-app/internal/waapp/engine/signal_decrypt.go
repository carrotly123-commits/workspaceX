package engine

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

type signalMessage struct {
	version         int
	ratchetKey      []byte
	counter         int
	previousCounter *int
	ciphertext      []byte
	body            []byte
	mac             []byte
	raw             []byte
}

type preKeySignalMessage struct {
	version             int
	preKeyID            *int
	signedPreKeyID      int
	baseKey             []byte
	identityKey         []byte
	registrationID      *int
	message             signalMessage
	kyberPreKeyID       *int
	kyberCiphertextSize *int
}

type signalMessageKeys struct {
	cipherKey []byte
	macKey    []byte
	iv        []byte
	index     int
}

type signalDecryptOutput struct {
	encType   string
	variant   string
	version   int
	counter   int
	plaintext []byte
}

func decryptNativeSignalPayload(state *NativeState, payload nativeMessagePayload, commit bool) (signalDecryptOutput, error) {
	state.ensureMaps()
	enc, err := decodeB64Any(payload.Payload)
	if err != nil {
		return signalDecryptOutput{}, err
	}
	typeHint := normalizeNativeSignalEncType(payload.EncType)
	if typeHint == "auto" {
		var errors []string
		for _, candidate := range []string{"pkmsg", "msg"} {
			out, err := decryptNativeSignalPayloadByType(state, enc, candidate, payload.Sender, commit)
			if err == nil {
				return out, nil
			}
			errors = append(errors, candidate+": "+err.Error())
		}
		return signalDecryptOutput{}, fmt.Errorf("auto decrypt failed; %s", strings.Join(errors, "; "))
	}
	return decryptNativeSignalPayloadByType(state, enc, typeHint, payload.Sender, commit)
}

func normalizeNativeSignalEncType(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "auto":
		return "auto"
	case "<tok:50>":
		return "skmsg"
	case "<tok:77>":
		return "msg"
	case "<tok:83>":
		return "pkmsg"
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func decryptNativeSignalPayloadByType(state *NativeState, enc []byte, encType string, sender string, commit bool) (signalDecryptOutput, error) {
	switch encType {
	case "pkmsg":
		return decryptNativePKMsg(state, enc, sender, commit)
	case "msg":
		return decryptNativeMsg(state, enc, sender, commit)
	default:
		return signalDecryptOutput{}, fmt.Errorf("unsupported enc type %q; implemented: pkmsg,msg", encType)
	}
}

func decryptNativePKMsg(state *NativeState, enc []byte, sender string, commit bool) (signalDecryptOutput, error) {
	pkmsg, err := parsePreKeySignalMessage(enc)
	if err != nil {
		return signalDecryptOutput{}, err
	}
	if pkmsg.kyberPreKeyID != nil || pkmsg.kyberCiphertextSize != nil {
		return signalDecryptOutput{}, fmt.Errorf("PQ/Kyber prekey message is present; only X25519 prekey path is implemented")
	}
	signedPreKey := state.Signal.SignedPreKey
	if int(signedPreKey.ID) != pkmsg.signedPreKeyID {
		return signalDecryptOutput{}, fmt.Errorf("signed prekey %d not found", pkmsg.signedPreKeyID)
	}
	signedPrivate, err := signedPreKey.KeyPair.privateBytes()
	if err != nil {
		return signalDecryptOutput{}, err
	}
	identityPrivate, err := state.Signal.Identity.privateBytes()
	if err != nil {
		return signalDecryptOutput{}, err
	}
	master := bytes.Repeat([]byte{0xff}, 32)
	part, err := nativeX25519Agree(signedPrivate, pkmsg.identityKey)
	if err != nil {
		return signalDecryptOutput{}, err
	}
	master = append(master, part...)
	part, err = nativeX25519Agree(identityPrivate, pkmsg.baseKey)
	if err != nil {
		return signalDecryptOutput{}, err
	}
	master = append(master, part...)
	part, err = nativeX25519Agree(signedPrivate, pkmsg.baseKey)
	if err != nil {
		return signalDecryptOutput{}, err
	}
	master = append(master, part...)
	if pkmsg.preKeyID != nil {
		oneTime, ok := findNativeOneTimePreKey(state.Signal.OneTimePreKeys, *pkmsg.preKeyID)
		if !ok {
			return signalDecryptOutput{}, fmt.Errorf("one-time prekey %d not found", *pkmsg.preKeyID)
		}
		oneTimePrivate, err := oneTime.KeyPair.privateBytes()
		if err != nil {
			return signalDecryptOutput{}, err
		}
		part, err = nativeX25519Agree(oneTimePrivate, pkmsg.baseKey)
		if err != nil {
			return signalDecryptOutput{}, err
		}
		master = append(master, part...)
	}
	rootKey, initialSenderChain := deriveX3DHInitial(master)
	type attempt struct {
		variant  string
		chainKey []byte
		index    int
		rootKey  []byte
	}
	attempts := []attempt{}
	if newRoot, receiverChain, err := rootRatchet(rootKey, pkmsg.message.ratchetKey, signedPrivate); err == nil {
		attempts = append(attempts, attempt{variant: "x3dh_root_ratchet_signed_prekey", chainKey: receiverChain, index: 0, rootKey: newRoot})
	}
	attempts = append(attempts, attempt{variant: "x3dh_initial_chain_fallback", chainKey: initialSenderChain, index: 0, rootKey: rootKey})
	var errors []string
	for _, item := range attempts {
		plaintext, nextKey, nextIndex, err := decryptSignalWithChain(state, pkmsg.message, item.chainKey, item.index, pkmsg.identityKey)
		if err != nil {
			errors = append(errors, item.variant+": "+err.Error())
			continue
		}
		if commit {
			commitPKMsgSession(state, sender, pkmsg, signedPreKey, item.rootKey, nextKey, nextIndex)
		}
		return signalDecryptOutput{encType: "pkmsg", variant: item.variant, version: pkmsg.message.version, counter: pkmsg.message.counter, plaintext: plaintext}, nil
	}
	return signalDecryptOutput{}, fmt.Errorf("pkmsg decrypt failed; %s", strings.Join(errors, "; "))
}

func decryptNativeMsg(state *NativeState, enc []byte, sender string, commit bool) (signalDecryptOutput, error) {
	msg, err := parseSignalMessage(enc)
	if err != nil {
		return signalDecryptOutput{}, err
	}
	ratchetKey, err := withSignalCurvePrefix(msg.ratchetKey)
	if err != nil {
		return signalDecryptOutput{}, err
	}
	ratchetID := hex.EncodeToString(ratchetKey)
	var errors []string
	for key, session := range matchingSignalSessions(state.Signal.Sessions, sender) {
		remoteIdentity, err := decodeB64Any(session.RemoteIdentityPublic)
		if err != nil {
			errors = append(errors, key+": "+err.Error())
			continue
		}
		if chain, ok := session.ReceiverChains[ratchetID]; ok {
			chainKey, err := decodeB64Any(chain.ChainKey)
			if err != nil {
				errors = append(errors, key+": "+err.Error())
				continue
			}
			plaintext, nextKey, nextIndex, err := decryptSignalWithChain(state, msg, chainKey, chain.Index, remoteIdentity)
			if err != nil {
				errors = append(errors, key+": "+err.Error())
				continue
			}
			if commit {
				chain.ChainKey = b64u(nextKey)
				chain.Index = nextIndex
				session.ReceiverChains[ratchetID] = chain
				state.Signal.Sessions[key] = session
			}
			return signalDecryptOutput{encType: "msg", variant: "receiver_chain", version: msg.version, counter: msg.counter, plaintext: plaintext}, nil
		}
		if session.RootKey == "" || session.SenderRatchetPrivate == "" {
			errors = append(errors, key+": no matching receiver chain and no root/sender ratchet private")
			continue
		}
		rootKey, err := decodeB64Any(session.RootKey)
		if err != nil {
			errors = append(errors, key+": "+err.Error())
			continue
		}
		senderPrivate, err := decodeB64Any(session.SenderRatchetPrivate)
		if err != nil {
			errors = append(errors, key+": "+err.Error())
			continue
		}
		newRoot, chainKey, err := rootRatchet(rootKey, msg.ratchetKey, senderPrivate)
		if err != nil {
			errors = append(errors, key+": "+err.Error())
			continue
		}
		plaintext, nextKey, nextIndex, err := decryptSignalWithChain(state, msg, chainKey, 0, remoteIdentity)
		if err != nil {
			errors = append(errors, key+": "+err.Error())
			continue
		}
		if commit {
			if session.ReceiverChains == nil {
				session.ReceiverChains = map[string]nativeReceiverChain{}
			}
			session.RootKey = b64u(newRoot)
			session.ReceiverChains[ratchetID] = nativeReceiverChain{RatchetKey: b64u(ratchetKey), ChainKey: b64u(nextKey), Index: nextIndex, RootKey: b64u(newRoot)}
			state.Signal.Sessions[key] = session
		}
		return signalDecryptOutput{encType: "msg", variant: "root_ratchet", version: msg.version, counter: msg.counter, plaintext: plaintext}, nil
	}
	return signalDecryptOutput{}, fmt.Errorf("normal msg decrypt failed%s", errorSuffix(errors))
}

func parseSignalMessage(raw []byte) (signalMessage, error) {
	if len(raw) < 10 {
		return signalMessage{}, fmt.Errorf("SignalMessage too short")
	}
	version := int(raw[0] >> 4)
	if version != 3 && version != 4 {
		return signalMessage{}, fmt.Errorf("unsupported SignalMessage version %d", version)
	}
	fields, err := parsePBFields(raw[1 : len(raw)-8])
	if err != nil {
		return signalMessage{}, err
	}
	ratchetKey, err := firstPBBytes(fields, 1, "ratchetKey")
	if err != nil {
		return signalMessage{}, err
	}
	counter, err := firstPBVarint(fields, 2, "counter", nil)
	if err != nil {
		return signalMessage{}, err
	}
	defaultPrevious := uint64(^uint64(0))
	previous, err := firstPBVarint(fields, 3, "previousCounter", &defaultPrevious)
	if err != nil {
		return signalMessage{}, err
	}
	ciphertext, err := firstPBBytes(fields, 4, "ciphertext")
	if err != nil {
		return signalMessage{}, err
	}
	var previousCounter *int
	if previous != defaultPrevious {
		value := int(previous)
		previousCounter = &value
	}
	return signalMessage{version: version, ratchetKey: ratchetKey, counter: int(counter), previousCounter: previousCounter, ciphertext: ciphertext, body: append([]byte{}, raw[:len(raw)-8]...), mac: append([]byte{}, raw[len(raw)-8:]...), raw: append([]byte{}, raw...)}, nil
}

func parsePreKeySignalMessage(raw []byte) (preKeySignalMessage, error) {
	if len(raw) < 2 {
		return preKeySignalMessage{}, fmt.Errorf("PreKeySignalMessage too short")
	}
	version := int(raw[0] >> 4)
	if version != 3 && version != 4 {
		return preKeySignalMessage{}, fmt.Errorf("unsupported PreKeySignalMessage version %d", version)
	}
	fields, err := parsePBFields(raw[1:])
	if err != nil {
		return preKeySignalMessage{}, err
	}
	baseKey, err := firstPBBytes(fields, 2, "baseKey")
	if err != nil {
		return preKeySignalMessage{}, err
	}
	identityKey, err := firstPBBytes(fields, 3, "identityKey")
	if err != nil {
		return preKeySignalMessage{}, err
	}
	embedded, err := firstPBBytes(fields, 4, "message")
	if err != nil {
		return preKeySignalMessage{}, err
	}
	signedPreKeyID, err := firstPBVarint(fields, 6, "signedPreKeyId", nil)
	if err != nil {
		return preKeySignalMessage{}, err
	}
	minusOne := uint64(^uint64(0))
	preKeyID, _ := firstPBVarint(fields, 1, "preKeyId", &minusOne)
	registrationID, _ := firstPBVarint(fields, 5, "registrationId", &minusOne)
	kyberPreKeyID, _ := firstPBVarint(fields, 7, "kyberPreKeyId", &minusOne)
	kyberCiphertext, _ := firstPBBytes(fields, 8, "kyberCiphertext")
	message, err := parseSignalMessage(embedded)
	if err != nil {
		return preKeySignalMessage{}, err
	}
	out := preKeySignalMessage{version: version, signedPreKeyID: int(signedPreKeyID), baseKey: baseKey, identityKey: identityKey, message: message}
	if preKeyID != minusOne {
		value := int(preKeyID)
		out.preKeyID = &value
	}
	if registrationID != minusOne {
		value := int(registrationID)
		out.registrationID = &value
	}
	if kyberPreKeyID != minusOne {
		value := int(kyberPreKeyID)
		out.kyberPreKeyID = &value
	}
	if kyberCiphertext != nil {
		value := len(kyberCiphertext)
		out.kyberCiphertextSize = &value
	}
	return out, nil
}

func deriveX3DHInitial(masterSecret []byte) ([]byte, []byte) {
	expanded := signalHKDFV3(masterSecret, []byte("WhisperText"), 64)
	return expanded[:32], expanded[32:64]
}

func rootRatchet(rootKey []byte, theirRatchetPublic []byte, ourRatchetPrivate []byte) ([]byte, []byte, error) {
	dh, err := nativeX25519Agree(ourRatchetPrivate, theirRatchetPublic)
	if err != nil {
		return nil, nil, err
	}
	expanded := hkdfExpand(hmacSHA256(rootKey, dh), []byte("WhisperRatchet"), 64)
	return expanded[:32], expanded[32:64], nil
}

func deriveMessageKeys(chainKey []byte, index int) signalMessageKeys {
	seed := hmacSHA256(chainKey, []byte{0x01})
	expanded := signalHKDFV3(seed, []byte("WhisperMessageKeys"), 80)
	return signalMessageKeys{cipherKey: expanded[:32], macKey: expanded[32:64], iv: expanded[64:80], index: index}
}

func nextChainKey(chainKey []byte) []byte {
	return hmacSHA256(chainKey, []byte{0x02})
}

func messageKeysForCounter(chainKey []byte, chainIndex int, counter int) (signalMessageKeys, []byte, int, error) {
	if counter < chainIndex {
		return signalMessageKeys{}, nil, 0, fmt.Errorf("old message counter %d < chain index %d", counter, chainIndex)
	}
	for chainIndex < counter {
		chainKey = nextChainKey(chainKey)
		chainIndex++
	}
	keys := deriveMessageKeys(chainKey, counter)
	return keys, nextChainKey(chainKey), counter + 1, nil
}

func signalMessageMAC(macKey []byte, senderIdentity []byte, receiverIdentity []byte, body []byte, version int) ([]byte, error) {
	mac := hmac.New(sha256.New, macKey)
	if version >= 3 {
		sender, err := withSignalCurvePrefix(senderIdentity)
		if err != nil {
			return nil, err
		}
		receiver, err := withSignalCurvePrefix(receiverIdentity)
		if err != nil {
			return nil, err
		}
		_, _ = mac.Write(sender)
		_, _ = mac.Write(receiver)
	}
	_, _ = mac.Write(body)
	return mac.Sum(nil)[:8], nil
}

func decryptSignalWithChain(state *NativeState, msg signalMessage, chainKey []byte, chainIndex int, remoteIdentity []byte) ([]byte, []byte, int, error) {
	keys, nextKey, nextIndex, err := messageKeysForCounter(chainKey, chainIndex, msg.counter)
	if err != nil {
		return nil, nil, 0, err
	}
	identityPublic, err := state.Signal.Identity.publicBytes()
	if err != nil {
		return nil, nil, 0, err
	}
	expected, err := signalMessageMAC(keys.macKey, remoteIdentity, identityPublic, msg.body, msg.version)
	if err != nil {
		return nil, nil, 0, err
	}
	if !hmac.Equal(expected, msg.mac) {
		return nil, nil, 0, fmt.Errorf("bad SignalMessage MAC")
	}
	plaintext, err := aesCBCPKCS7Decrypt(msg.ciphertext, keys.cipherKey, keys.iv)
	if err != nil {
		return nil, nil, 0, err
	}
	return plaintext, nextKey, nextIndex, nil
}

func commitPKMsgSession(state *NativeState, sender string, pkmsg preKeySignalMessage, signedPreKey nativeSignalPreKey, rootKey []byte, nextChainKey []byte, nextIndex int) {
	state.ensureMaps()
	senderKey := signalSenderKey(sender)
	remoteIdentity, _ := withSignalCurvePrefix(pkmsg.identityKey)
	ratchetKey, _ := withSignalCurvePrefix(pkmsg.message.ratchetKey)
	ratchetID := hex.EncodeToString(ratchetKey)
	signedPublic, _ := signedPreKey.KeyPair.publicBytes()
	signedPrivate, _ := signedPreKey.KeyPair.privateBytes()
	session := nativeSignalSession{Sender: sender, Version: pkmsg.message.version, RemoteIdentityPublic: b64u(remoteIdentity), RootKey: b64u(rootKey), SenderRatchetPublic: b64u(signedPublic), SenderRatchetPrivate: b64u(signedPrivate), ReceiverChains: map[string]nativeReceiverChain{}}
	if pkmsg.message.previousCounter != nil {
		value := *pkmsg.message.previousCounter
		session.PreviousCounter = &value
	}
	if pkmsg.registrationID != nil {
		value := *pkmsg.registrationID
		session.RemoteRegistrationID = &value
	}
	session.AliceBaseKey = b64u(pkmsg.baseKey)
	session.ReceiverChains[ratchetID] = nativeReceiverChain{RatchetKey: b64u(ratchetKey), ChainKey: b64u(nextChainKey), Index: nextIndex, RootKey: b64u(rootKey)}
	state.Signal.RemoteIdentities[senderKey] = b64u(remoteIdentity)
	state.Signal.Sessions[senderKey] = session
}

func findNativeOneTimePreKey(keys []nativeSignalPreKey, id int) (nativeSignalPreKey, bool) {
	for _, key := range keys {
		if int(key.ID) == id {
			return key, true
		}
	}
	return nativeSignalPreKey{}, false
}

func matchingSignalSessions(sessions map[string]nativeSignalSession, sender string) map[string]nativeSignalSession {
	out := map[string]nativeSignalSession{}
	if session, ok := sessions[signalSenderKey(sender)]; ok {
		out[signalSenderKey(sender)] = session
	}
	if sender != "" {
		if session, ok := sessions[signalSenderKey("")]; ok {
			out[signalSenderKey("")] = session
		}
	}
	if len(out) == 0 {
		for key, session := range sessions {
			out[key] = session
		}
	}
	return out
}

func signalSenderKey(sender string) string {
	if strings.TrimSpace(sender) == "" {
		return "__default__"
	}
	return strings.TrimSpace(sender)
}

func errorSuffix(errors []string) string {
	if len(errors) == 0 {
		return ""
	}
	if len(errors) > 12 {
		errors = append(errors[:12], fmt.Sprintf("... %d more", len(errors)-12))
	}
	return "; " + strings.Join(errors, "; ")
}
