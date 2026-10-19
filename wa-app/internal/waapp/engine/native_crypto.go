package engine

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"

	stepx25519 "go.step.sm/crypto/x25519"
	"golang.org/x/crypto/curve25519"
)

const signalCurvePrefix = byte(0x05)

type nativeCurveKeyPair struct {
	Public  string `json:"public"`
	Private string `json:"private"`
}

func newNativeCurveKeyPair() (nativeCurveKeyPair, error) {
	private := make([]byte, curve25519.ScalarSize)
	if _, err := io.ReadFull(rand.Reader, private); err != nil {
		return nativeCurveKeyPair{}, err
	}
	public, err := curve25519.X25519(private, curve25519.Basepoint)
	if err != nil {
		return nativeCurveKeyPair{}, err
	}
	return nativeCurveKeyPair{Public: b64u(public), Private: b64u(private)}, nil
}

func (k nativeCurveKeyPair) publicBytes() ([]byte, error) {
	return decodeB64Any(k.Public)
}

func (k nativeCurveKeyPair) privateBytes() ([]byte, error) {
	return decodeB64Any(k.Private)
}

func decodeB64Any(value string) ([]byte, error) {
	if value == "" {
		return nil, errors.New("empty base64 value")
	}
	if out, err := base64.RawURLEncoding.DecodeString(value); err == nil {
		return out, nil
	}
	if out, err := base64.URLEncoding.DecodeString(value); err == nil {
		return out, nil
	}
	if out, err := base64.RawStdEncoding.DecodeString(value); err == nil {
		return out, nil
	}
	return base64.StdEncoding.DecodeString(value)
}

func stripSignalCurvePrefix(publicKey []byte) ([]byte, error) {
	if len(publicKey) == curve25519.PointSize {
		return append([]byte{}, publicKey...), nil
	}
	if len(publicKey) == curve25519.PointSize+1 && (publicKey[0] == 0x05 || publicKey[0] == 0x04) {
		return append([]byte{}, publicKey[1:]...), nil
	}
	return nil, fmt.Errorf("unexpected curve public key length %d", len(publicKey))
}

func withSignalCurvePrefix(publicKey []byte) ([]byte, error) {
	if len(publicKey) == curve25519.PointSize+1 && (publicKey[0] == 0x05 || publicKey[0] == 0x04) {
		return append([]byte{}, publicKey...), nil
	}
	if len(publicKey) == curve25519.PointSize {
		out := make([]byte, 0, curve25519.PointSize+1)
		out = append(out, signalCurvePrefix)
		out = append(out, publicKey...)
		return out, nil
	}
	return nil, fmt.Errorf("unexpected curve public key length %d", len(publicKey))
}

func nativeX25519Agree(privateKey []byte, publicKey []byte) ([]byte, error) {
	if len(privateKey) != curve25519.ScalarSize {
		return nil, fmt.Errorf("unexpected curve private key length %d", len(privateKey))
	}
	stripped, err := stripSignalCurvePrefix(publicKey)
	if err != nil {
		return nil, err
	}
	return curve25519.X25519(privateKey, stripped)
}

func hmacSHA256(key []byte, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(data)
	return mac.Sum(nil)
}

func hkdfExpand(prk []byte, info []byte, length int) []byte {
	return hkdfExpandWithHash(sha256.New, prk, info, length, 1)
}

func hkdfExpandWithHash(hashFactory func() hash.Hash, prk []byte, info []byte, length int, counterStart byte) []byte {
	out := make([]byte, 0, length)
	previous := []byte{}
	counter := counterStart
	for len(out) < length {
		mac := hmac.New(hashFactory, prk)
		_, _ = mac.Write(previous)
		_, _ = mac.Write(info)
		_, _ = mac.Write([]byte{counter})
		previous = mac.Sum(nil)
		out = append(out, previous...)
		counter++
	}
	return out[:length]
}

func hkdfExtractExpand(chainingKey []byte, inputKeyMaterial []byte, info []byte, length int) []byte {
	prk := hmacSHA256(chainingKey, inputKeyMaterial)
	return hkdfExpand(prk, info, length)
}

func signalHKDFV3(inputKeyMaterial []byte, info []byte, length int) []byte {
	return hkdfExpand(hmacSHA256(make([]byte, 32), inputKeyMaterial), info, length)
}

func aesGCMSeal(key []byte, nonce []byte, plaintext []byte, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Seal(nil, nonce, plaintext, aad), nil
}

func aesGCMOpen(key []byte, nonce []byte, ciphertext []byte, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, ciphertext, aad)
}

func aesCBCPKCS7Decrypt(ciphertext []byte, key []byte, iv []byte) ([]byte, error) {
	if len(ciphertext) == 0 || len(ciphertext)%aes.BlockSize != 0 {
		return nil, fmt.Errorf("invalid AES-CBC ciphertext length %d", len(ciphertext))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	if len(iv) != aes.BlockSize {
		return nil, fmt.Errorf("invalid AES-CBC IV length %d", len(iv))
	}
	plain := make([]byte, len(ciphertext))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plain, ciphertext)
	padLen := int(plain[len(plain)-1])
	if padLen < 1 || padLen > aes.BlockSize || padLen > len(plain) {
		return nil, errors.New("invalid PKCS5/PKCS7 padding")
	}
	for _, value := range plain[len(plain)-padLen:] {
		if int(value) != padLen {
			return nil, errors.New("invalid PKCS5/PKCS7 padding")
		}
	}
	return plain[:len(plain)-padLen], nil
}

func aesCBCPKCS7Encrypt(plaintext []byte, key []byte, iv []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	if len(iv) != aes.BlockSize {
		return nil, fmt.Errorf("invalid AES-CBC IV length %d", len(iv))
	}
	padded := pkcs7Pad(plaintext, aes.BlockSize)
	ciphertext := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ciphertext, padded)
	return ciphertext, nil
}

func nativeNonce(counter uint64) []byte {
	out := make([]byte, 12)
	binary.BigEndian.PutUint64(out[4:], counter)
	return out
}

func xeddsaSignCurve25519(identityPrivate []byte, message []byte) ([]byte, error) {
	if len(identityPrivate) != stepx25519.PrivateKeySize {
		return nil, fmt.Errorf("unexpected XEdDSA private key length %d", len(identityPrivate))
	}
	return stepx25519.Sign(rand.Reader, stepx25519.PrivateKey(identityPrivate), message)
}

func xeddsaVerifyCurve25519(identityPublic []byte, message []byte, signature []byte) (bool, error) {
	public, err := stripSignalCurvePrefix(identityPublic)
	if err != nil {
		return false, err
	}
	if len(public) != stepx25519.PublicKeySize {
		return false, fmt.Errorf("unexpected XEdDSA public key length %d", len(public))
	}
	if len(signature) != stepx25519.SignatureSize {
		return false, fmt.Errorf("unexpected XEdDSA signature length %d", len(signature))
	}
	return stepx25519.Verify(stepx25519.PublicKey(public), message, signature), nil
}

func hexKey(parts ...[]byte) string {
	h := sha256.New()
	for _, part := range parts {
		_, _ = h.Write(part)
	}
	return hex.EncodeToString(h.Sum(nil))
}
