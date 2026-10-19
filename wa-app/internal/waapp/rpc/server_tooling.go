package rpc

import (
	"context"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
)

func (s *toolingHandler) GeneratePhoneFingerprintProfile(ctx context.Context, req *waappv1.GeneratePhoneFingerprintProfileRequest) (*waappv1.GeneratePhoneFingerprintProfileResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.GeneratePhoneFingerprintProfileResponse{Error: shared.ToProtoError(err)}, nil
	}
	tooling, err := s.tooling()
	if err != nil {
		return &waappv1.GeneratePhoneFingerprintProfileResponse{Error: shared.ToProtoError(err)}, nil
	}
	profile, err := tooling.GeneratePhoneFingerprintProfile(ctx, req)
	return &waappv1.GeneratePhoneFingerprintProfileResponse{Profile: profile, Error: shared.ToProtoError(err)}, nil
}

func (s *toolingHandler) ImportWamsysCapture(ctx context.Context, req *waappv1.ImportWamsysCaptureRequest) (*waappv1.ImportWamsysCaptureResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.ImportWamsysCaptureResponse{Error: shared.ToProtoError(err)}, nil
	}
	tooling, err := s.tooling()
	if err != nil {
		return &waappv1.ImportWamsysCaptureResponse{Error: shared.ToProtoError(err)}, nil
	}
	capture, err := tooling.ImportWamsysCapture(ctx, req)
	return &waappv1.ImportWamsysCaptureResponse{Capture: capture, Error: shared.ToProtoError(err)}, nil
}

func (s *toolingHandler) BuildRegistrationRequest(ctx context.Context, req *waappv1.BuildRegistrationRequestRequest) (*waappv1.BuildRegistrationRequestResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.BuildRegistrationRequestResponse{Error: shared.ToProtoError(err)}, nil
	}
	tooling, err := s.tooling()
	if err != nil {
		return &waappv1.BuildRegistrationRequestResponse{Error: shared.ToProtoError(err)}, nil
	}
	resp, err := tooling.BuildRegistrationRequest(ctx, req)
	if resp == nil {
		resp = &waappv1.BuildRegistrationRequestResponse{}
	}
	resp.Error = shared.ToProtoError(err)
	return resp, nil
}

func (s *toolingHandler) EncryptWASafeEnvelope(ctx context.Context, req *waappv1.EncryptWASafeEnvelopeRequest) (*waappv1.EncryptWASafeEnvelopeResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.EncryptWASafeEnvelopeResponse{Error: shared.ToProtoError(err)}, nil
	}
	tooling, err := s.tooling()
	if err != nil {
		return &waappv1.EncryptWASafeEnvelopeResponse{Error: shared.ToProtoError(err)}, nil
	}
	resp, err := tooling.EncryptWASafeEnvelope(ctx, req)
	if resp == nil {
		resp = &waappv1.EncryptWASafeEnvelopeResponse{}
	}
	resp.Error = shared.ToProtoError(err)
	return resp, nil
}

func (s *toolingHandler) DeriveRegistrationToken(ctx context.Context, req *waappv1.DeriveRegistrationTokenRequest) (*waappv1.DeriveRegistrationTokenResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.DeriveRegistrationTokenResponse{Error: shared.ToProtoError(err)}, nil
	}
	tooling, err := s.tooling()
	if err != nil {
		return &waappv1.DeriveRegistrationTokenResponse{Error: shared.ToProtoError(err)}, nil
	}
	resp, err := tooling.DeriveRegistrationToken(ctx, req)
	if resp == nil {
		resp = &waappv1.DeriveRegistrationTokenResponse{}
	}
	resp.Error = shared.ToProtoError(err)
	return resp, nil
}

func (s *toolingHandler) DeriveAuthKey(ctx context.Context, req *waappv1.DeriveAuthKeyRequest) (*waappv1.DeriveAuthKeyResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.DeriveAuthKeyResponse{Error: shared.ToProtoError(err)}, nil
	}
	tooling, err := s.tooling()
	if err != nil {
		return &waappv1.DeriveAuthKeyResponse{Error: shared.ToProtoError(err)}, nil
	}
	resp, err := tooling.DeriveAuthKey(ctx, req)
	if resp == nil {
		resp = &waappv1.DeriveAuthKeyResponse{}
	}
	resp.Error = shared.ToProtoError(err)
	return resp, nil
}

func (s *serverCore) tooling() (wacore.ProtocolTooling, error) {
	tooling, ok := s.runner.(wacore.ProtocolTooling)
	if !ok {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_UNSUPPORTED_OPERATION, "protocol tooling is not available", false)
	}
	return tooling, nil
}
