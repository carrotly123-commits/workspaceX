package wacore

import (
	"context"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
)

// ProtocolTooling is the offline fingerprint/crypto tooling port the engine
// exposes to the RPC layer.
type ProtocolTooling interface {
	GeneratePhoneFingerprintProfile(context.Context, *waappv1.GeneratePhoneFingerprintProfileRequest) (*waappv1.PhoneFingerprintProfile, error)
	ImportWamsysCapture(context.Context, *waappv1.ImportWamsysCaptureRequest) (*waappv1.WamsysCapture, error)
	BuildRegistrationRequest(context.Context, *waappv1.BuildRegistrationRequestRequest) (*waappv1.BuildRegistrationRequestResponse, error)
	EncryptWASafeEnvelope(context.Context, *waappv1.EncryptWASafeEnvelopeRequest) (*waappv1.EncryptWASafeEnvelopeResponse, error)
	DeriveRegistrationToken(context.Context, *waappv1.DeriveRegistrationTokenRequest) (*waappv1.DeriveRegistrationTokenResponse, error)
	DeriveAuthKey(context.Context, *waappv1.DeriveAuthKeyRequest) (*waappv1.DeriveAuthKeyResponse, error)
}
