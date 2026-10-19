package engine

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"
	"time"
)

type waSafeEnvelope struct {
	Body          string
	Enc           string
	Authorization string
}

type nativeSoftwareAttestation struct {
	PrivateKeyPKCS8     string `json:"private_key_pkcs8,omitempty"`
	CertificateChainDER string `json:"certificate_chain_der,omitempty"`
}

var androidKeyAttestationOID = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 11129, 2, 1, 17}
var nativeAttestationPaddingOID = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 11129, 2, 1, 777}

const (
	nativeAttestationRootDERLength         = 1312
	nativeAttestationFirstIntermediateDER  = 920
	nativeAttestationSecondIntermediateDER = 505
	nativeAttestationLeafDERLength         = 685
	nativeAttestationChainDERLength        = nativeAttestationRootDERLength +
		nativeAttestationFirstIntermediateDER +
		nativeAttestationSecondIntermediateDER +
		nativeAttestationLeafDERLength
	nativeAttestationFreshness             = 5 * time.Minute
	nativeAttestationFutureSkew            = 2 * time.Minute
	nativeAttestationSignatureRawURLLength = 96
	nativeAttestationSignatureMaxAttempts  = 64
)

func buildWASafeEnvelope(plain []byte, serverPublicKeyHex string, attestation nativeSoftwareAttestation) (waSafeEnvelope, error) {
	enc, err := encryptWASafe(plain, serverPublicKeyHex)
	if err != nil {
		return waSafeEnvelope{}, err
	}
	body := "ENC=" + enc
	if !attestation.ready() {
		return waSafeEnvelope{Body: body, Enc: enc}, nil
	}
	signature, authorization, err := attestation.sign([]byte(enc))
	if err != nil {
		return waSafeEnvelope{}, err
	}
	return waSafeEnvelope{Body: body + "&H=" + signature, Enc: enc, Authorization: authorization}, nil
}

func ensureNativeSoftwareAttestation(state *NativeState, now time.Time) error {
	if state == nil {
		return nil
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}
	if state.Attestation.ready() &&
		nativeAttestationChainShapeOK(state.Attestation.CertificateChainDER) &&
		state.Attestation.freshAt(now) {
		return nil
	}
	challenge, err := nativeAttestationChallenge(*state)
	if err != nil {
		return err
	}
	attestation, err := newNativeSoftwareAttestation(challenge, now)
	if err != nil {
		return err
	}
	state.Attestation = attestation
	return nil
}

func nativeAttestationChallenge(state NativeState) ([]byte, error) {
	if state.AuthKey != "" {
		return decodeB64Any(state.AuthKey)
	}
	return state.ChatStatic.publicBytes()
}

func newNativeSoftwareAttestation(clientStaticPublic []byte, now time.Time) (nativeSoftwareAttestation, error) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nativeSoftwareAttestation{}, err
	}
	privateKeyDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return nativeSoftwareAttestation{}, err
	}
	certificateChainDER, err := newNativeSoftwareAttestationCertificateChain(privateKey, clientStaticPublic, now)
	if err != nil {
		return nativeSoftwareAttestation{}, err
	}
	return nativeSoftwareAttestation{
		PrivateKeyPKCS8:     b64u(privateKeyDER),
		CertificateChainDER: b64u(certificateChainDER),
	}, nil
}

func newNativeSoftwareAttestationCertificateChain(privateKey *ecdsa.PrivateKey, clientStaticPublic []byte, now time.Time) ([]byte, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	rootKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	firstIntermediateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	secondIntermediateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	rootSerial, err := nativeAttestationSerial()
	if err != nil {
		return nil, err
	}
	firstIntermediateSerial, err := nativeAttestationSerial()
	if err != nil {
		return nil, err
	}
	secondIntermediateSerial, err := nativeAttestationSerial()
	if err != nil {
		return nil, err
	}
	leafSerial, err := nativeAttestationSerial()
	if err != nil {
		return nil, err
	}
	extension, err := nativeSoftwareAndroidKeyAttestationExtension(nativeAndroidKeyAttestationChallenge(clientStaticPublic, now))
	if err != nil {
		return nil, err
	}
	root := &x509.Certificate{
		SerialNumber:          rootSerial,
		Subject:               pkix.Name{SerialNumber: nativeAttestationSubjectSerial()},
		NotBefore:             now.Add(-time.Minute),
		NotAfter:              now.Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            2,
	}
	rootDER, err := createNativePaddedAttestationCertificate(root, root, &rootKey.PublicKey, rootKey, nil, nativeAttestationRootDERLength)
	if err != nil {
		return nil, err
	}
	firstIntermediate := &x509.Certificate{
		SerialNumber: firstIntermediateSerial,
		Subject: pkix.Name{
			SerialNumber:       nativeAttestationSubjectSerial(),
			OrganizationalUnit: []string{"TEE"},
		},
		NotBefore:             now.Add(-time.Minute),
		NotAfter:              now.Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            1,
	}
	firstIntermediateDER, err := createNativePaddedAttestationCertificate(firstIntermediate, root, &firstIntermediateKey.PublicKey, rootKey, nil, nativeAttestationFirstIntermediateDER)
	if err != nil {
		return nil, err
	}
	secondIntermediate := &x509.Certificate{
		SerialNumber: secondIntermediateSerial,
		Subject: pkix.Name{
			SerialNumber:       nativeAttestationSubjectSerial(),
			OrganizationalUnit: []string{"TEE"},
		},
		NotBefore:             now.Add(-time.Minute),
		NotAfter:              now.Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            0,
	}
	secondIntermediateDER, err := createNativePaddedAttestationCertificate(secondIntermediate, firstIntermediate, &secondIntermediateKey.PublicKey, firstIntermediateKey, nil, nativeAttestationSecondIntermediateDER)
	if err != nil {
		return nil, err
	}
	leaf := &x509.Certificate{
		SerialNumber:          leafSerial,
		Subject:               pkix.Name{CommonName: "Android Keystore Key"},
		NotBefore:             now.Add(-time.Minute),
		NotAfter:              now.Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}
	leafDER, err := createNativePaddedAttestationCertificate(leaf, secondIntermediate, &privateKey.PublicKey, secondIntermediateKey, []pkix.Extension{{
		Id:    androidKeyAttestationOID,
		Value: extension,
	}}, nativeAttestationLeafDERLength)
	if err != nil {
		return nil, err
	}
	chain := make([]byte, 0, nativeAttestationChainDERLength)
	chain = append(chain, rootDER...)
	chain = append(chain, firstIntermediateDER...)
	chain = append(chain, secondIntermediateDER...)
	chain = append(chain, leafDER...)
	return chain, nil
}

func createNativePaddedAttestationCertificate(
	template *x509.Certificate,
	parent *x509.Certificate,
	publicKey any,
	signer any,
	baseExtensions []pkix.Extension,
	targetLength int,
) ([]byte, error) {
	paddingLength := 0
	var best []byte
	for attempt := 0; attempt < 24; attempt++ {
		certificate := *template
		certificate.ExtraExtensions = append([]pkix.Extension{}, baseExtensions...)
		if paddingLength > 0 {
			certificate.ExtraExtensions = append(certificate.ExtraExtensions, pkix.Extension{Id: nativeAttestationPaddingOID, Value: randomBytes(paddingLength)})
		}
		der, err := x509.CreateCertificate(rand.Reader, &certificate, parent, publicKey, signer)
		if err != nil {
			return nil, err
		}
		best = der
		diff := targetLength - len(der)
		if diff == 0 {
			return der, nil
		}
		paddingLength += diff
		if paddingLength < 0 {
			paddingLength = 0
		}
	}
	return best, nil
}

func nativeAttestationSerial() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
}

func nativeAttestationSubjectSerial() string {
	return hex.EncodeToString(randomBytes(16))
}

func nativeAndroidKeyAttestationChallenge(clientStaticPublic []byte, now time.Time) []byte {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	out := make([]byte, 0, len(clientStaticPublic)+9)
	out = binary.BigEndian.AppendUint64(out, uint64(now.Unix()))
	out = append(out, 0x1f)
	out = append(out, clientStaticPublic...)
	return out
}

type nativeSoftwareAndroidKeyDescription struct {
	AttestationVersion       int
	AttestationSecurityLevel asn1.Enumerated
	KeymasterVersion         int
	KeymasterSecurityLevel   asn1.Enumerated
	AttestationChallenge     []byte
	UniqueID                 []byte
	SoftwareEnforced         asn1.RawValue
	TEEEnforced              asn1.RawValue
}

func nativeSoftwareAndroidKeyAttestationExtension(challenge []byte) ([]byte, error) {
	emptyAuthorizationList := asn1.RawValue{FullBytes: []byte{0x30, 0x00}}
	return asn1.Marshal(nativeSoftwareAndroidKeyDescription{
		AttestationVersion:       3,
		AttestationSecurityLevel: 1,
		KeymasterVersion:         4,
		KeymasterSecurityLevel:   1,
		AttestationChallenge:     append([]byte{}, challenge...),
		UniqueID:                 []byte{},
		SoftwareEnforced:         emptyAuthorizationList,
		TEEEnforced:              emptyAuthorizationList,
	})
}

func (a nativeSoftwareAttestation) ready() bool {
	if a.PrivateKeyPKCS8 == "" || a.CertificateChainDER == "" {
		return false
	}
	certificateDER, err := decodeB64Any(a.CertificateChainDER)
	if err != nil {
		return false
	}
	certificates, err := x509.ParseCertificates(certificateDER)
	if err != nil || len(certificates) == 0 {
		return false
	}
	return certificates[0].IsCA
}

func nativeAttestationChainShapeOK(certificateChain string) bool {
	certificateDER, err := decodeB64Any(certificateChain)
	if err != nil {
		return false
	}
	if len(certificateDER) < nativeAttestationChainDERLength-16 || len(certificateDER) > nativeAttestationChainDERLength+16 {
		return false
	}
	certificates, err := x509.ParseCertificates(certificateDER)
	if err != nil || len(certificates) != 4 {
		return false
	}
	if !certificates[0].IsCA || !certificates[1].IsCA || !certificates[2].IsCA || certificates[3].IsCA {
		return false
	}
	return strings.EqualFold(certificates[3].Subject.CommonName, "Android Keystore Key")
}

func (a nativeSoftwareAttestation) freshAt(now time.Time) bool {
	issuedAt, ok := nativeAttestationIssuedAt(a.CertificateChainDER)
	if !ok {
		return false
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}
	if issuedAt.After(now.Add(nativeAttestationFutureSkew)) {
		return false
	}
	return !now.After(issuedAt.Add(nativeAttestationFreshness))
}

func nativeAttestationIssuedAt(certificateChain string) (time.Time, bool) {
	certificateDER, err := decodeB64Any(certificateChain)
	if err != nil {
		return time.Time{}, false
	}
	certificates, err := x509.ParseCertificates(certificateDER)
	if err != nil || len(certificates) == 0 {
		return time.Time{}, false
	}
	leaf := certificates[len(certificates)-1]
	for _, extension := range leaf.Extensions {
		if extension.Id.String() != androidKeyAttestationOID.String() {
			continue
		}
		var description nativeSoftwareAndroidKeyDescription
		if _, err := asn1.Unmarshal(extension.Value, &description); err != nil {
			return time.Time{}, false
		}
		challenge := description.AttestationChallenge
		if len(challenge) < 9 || challenge[8] != 0x1f {
			return time.Time{}, false
		}
		return time.Unix(int64(binary.BigEndian.Uint64(challenge[:8])), 0).UTC(), true
	}
	return time.Time{}, false
}

func (a nativeSoftwareAttestation) sign(body []byte) (string, string, error) {
	privateKeyDER, err := decodeB64Any(a.PrivateKeyPKCS8)
	if err != nil {
		return "", "", err
	}
	parsedKey, err := x509.ParsePKCS8PrivateKey(privateKeyDER)
	if err != nil {
		return "", "", err
	}
	privateKey, ok := parsedKey.(*ecdsa.PrivateKey)
	if !ok {
		return "", "", fmt.Errorf("native software attestation key is not ECDSA")
	}
	digest := sha256.Sum256(body)
	var signature []byte
	for attempt := 0; attempt < nativeAttestationSignatureMaxAttempts; attempt++ {
		candidate, err := ecdsa.SignASN1(rand.Reader, privateKey, digest[:])
		if err != nil {
			return "", "", err
		}
		signature = candidate
		if len(base64.RawURLEncoding.EncodeToString(candidate)) == nativeAttestationSignatureRawURLLength {
			break
		}
	}
	certificateDER, err := decodeB64Any(a.CertificateChainDER)
	if err != nil {
		return "", "", err
	}
	return base64.RawURLEncoding.EncodeToString(signature), base64.StdEncoding.EncodeToString(certificateDER), nil
}
