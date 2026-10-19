package rpc

import (
	"context"
	"time"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
	"github.com/byte-v-forge/wa-app/internal/waapp/wamodel"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func (s *registrationHandler) ProbeAccount(ctx context.Context, req *waappv1.ProbeAccountRequest) (*waappv1.ProbeAccountResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.ProbeAccountResponse{Error: shared.ToProtoError(err)}, nil
	}
	account, profile, err := s.waAccountAndProfile(ctx, req.GetWaAccountId(), req.GetClientProfileId())
	if err != nil {
		return &waappv1.ProbeAccountResponse{Error: shared.ToProtoError(err)}, nil
	}
	result := s.runner.ProbeAccount(ctx, wacore.EngineRegistrationInput{WAAccountID: wamodel.WAAccountID(account), ClientProfileID: profile.GetClientProfileId(), ProtocolProfileID: profile.GetProtocolProfileId(), AppVersion: s.clientProfileAppVersion(ctx, profile), Phone: account.GetPhone(), DeliveryMethod: waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_SMS})
	now := s.clock.Now()
	probe := &waappv1.AccountProbe{AccountProbeId: s.ids.NewID("waprobe_"), WaAccountId: wamodel.WAAccountID(account), ClientProfileId: profile.GetClientProfileId(), Status: result.Status, SupportedMethods: result.SupportedMethods, ProbedAt: timestamppb.New(now), LastError: shared.ToProtoError(result.Err), MethodStatuses: protoVerificationMethodStatuses(result.MethodStatuses)}
	if err := s.store.SaveAccountProbe(ctx, probe); err != nil {
		return &waappv1.ProbeAccountResponse{Error: shared.ToProtoError(err)}, nil
	}
	return &waappv1.ProbeAccountResponse{Probe: probe, Error: probe.GetLastError()}, nil
}

func (s *registrationHandler) RequestVerificationCode(ctx context.Context, req *waappv1.RequestVerificationCodeRequest) (*waappv1.RequestVerificationCodeResponse, error) {
	return s.RequestVerificationCodeWithRunner(ctx, req, s.runner)
}

func (s *serverCore) RequestVerificationCodeWithRunner(ctx context.Context, req *waappv1.RequestVerificationCodeRequest, runner wacore.ProtocolEngine) (*waappv1.RequestVerificationCodeResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.RequestVerificationCodeResponse{Error: shared.ToProtoError(err)}, nil
	}
	account, profile, err := s.waAccountAndProfile(ctx, req.GetWaAccountId(), req.GetClientProfileId())
	if err != nil {
		return &waappv1.RequestVerificationCodeResponse{Error: shared.ToProtoError(err)}, nil
	}
	method := req.GetDeliveryMethod()
	if method == waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_UNSPECIFIED {
		method = waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_SMS
	}
	result := runner.RequestVerificationCode(ctx, wacore.EngineRegistrationInput{WAAccountID: wamodel.WAAccountID(account), ClientProfileID: profile.GetClientProfileId(), ProtocolProfileID: profile.GetProtocolProfileId(), AppVersion: s.clientProfileAppVersion(ctx, profile), Phone: account.GetPhone(), DeliveryMethod: method})
	record := s.NewVerificationCodeRequestRecord(account, profile, method, result)
	challenge := result.AccountTransferChallenge
	if challenge != nil {
		challenge.VerificationRequestId = record.GetVerificationRequestId()
	}
	if err := s.store.SaveVerificationRequest(ctx, record); err != nil {
		return &waappv1.RequestVerificationCodeResponse{Error: shared.ToProtoError(err)}, nil
	}
	return &waappv1.RequestVerificationCodeResponse{VerificationRequest: record, AccountTransferChallenge: challenge, Error: record.GetLastError()}, nil
}

func (s *registrationHandler) RefreshAccountTransferChallenge(ctx context.Context, req *waappv1.RefreshAccountTransferChallengeRequest) (*waappv1.RefreshAccountTransferChallengeResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.RefreshAccountTransferChallengeResponse{Error: shared.ToProtoError(err)}, nil
	}
	verification, err := s.store.GetVerificationRequest(ctx, req.GetVerificationRequestId())
	if err != nil {
		return &waappv1.RefreshAccountTransferChallengeResponse{Error: shared.ToProtoError(err)}, nil
	}
	if verification.GetDeliveryMethod() != waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_ACCOUNT_TRANSFER {
		return &waappv1.RefreshAccountTransferChallengeResponse{Error: shared.ToProtoError(shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "verification request is not account transfer", false))}, nil
	}
	account, profile, err := s.waAccountAndProfile(ctx, verification.GetWaAccountId(), verification.GetClientProfileId())
	if err != nil {
		return &waappv1.RefreshAccountTransferChallengeResponse{Error: shared.ToProtoError(err)}, nil
	}
	result := s.runner.RefreshAccountTransferChallenge(ctx, wacore.EngineAccountTransferChallengeInput{
		EngineRegistrationInput: wacore.EngineRegistrationInput{
			WAAccountID:       wamodel.WAAccountID(account),
			ClientProfileID:   profile.GetClientProfileId(),
			ProtocolProfileID: profile.GetProtocolProfileId(),
			AppVersion:        s.clientProfileAppVersion(ctx, profile),
			Phone:             account.GetPhone(),
			DeliveryMethod:    verification.GetDeliveryMethod(),
		},
		VerificationRequestID: verification.GetVerificationRequestId(),
	})
	return &waappv1.RefreshAccountTransferChallengeResponse{AccountTransferChallenge: result.Challenge, Error: shared.ToProtoError(result.Err)}, nil
}

func (s *registrationHandler) SubmitVerificationCode(ctx context.Context, req *waappv1.SubmitVerificationCodeRequest) (*waappv1.SubmitVerificationCodeResponse, error) {
	return s.SubmitVerificationCodeWithRunner(ctx, req, s.runner)
}

func (s *serverCore) SubmitVerificationCodeWithRunner(ctx context.Context, req *waappv1.SubmitVerificationCodeRequest, runner wacore.ProtocolEngine) (*waappv1.SubmitVerificationCodeResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.SubmitVerificationCodeResponse{Error: shared.ToProtoError(err)}, nil
	}
	verification, err := s.store.GetVerificationRequest(ctx, req.GetVerificationRequestId())
	if err != nil {
		return &waappv1.SubmitVerificationCodeResponse{Error: shared.ToProtoError(err)}, nil
	}
	account, profile, err := s.waAccountAndProfile(ctx, verification.GetWaAccountId(), verification.GetClientProfileId())
	if err != nil {
		return &waappv1.SubmitVerificationCodeResponse{Error: shared.ToProtoError(err)}, nil
	}
	now := s.clock.Now()
	registration := &waappv1.RegistrationRecord{RegistrationId: s.ids.NewID("wareg_"), VerificationRequestId: verification.GetVerificationRequestId(), WaAccountId: wamodel.WAAccountID(account), ClientProfileId: profile.GetClientProfileId(), Status: waappv1.RegistrationStatus_REGISTRATION_STATUS_SUBMITTED, SubmittedAt: timestamppb.New(now)}
	result := runner.SubmitVerificationCode(ctx, wacore.EngineSubmitInput{EngineRegistrationInput: wacore.EngineRegistrationInput{WAAccountID: wamodel.WAAccountID(account), ClientProfileID: profile.GetClientProfileId(), ProtocolProfileID: profile.GetProtocolProfileId(), AppVersion: s.clientProfileAppVersion(ctx, profile), Phone: account.GetPhone(), DeliveryMethod: verification.GetDeliveryMethod()}, VerificationRequestID: verification.GetVerificationRequestId(), Code: req.GetCode(), CodeSecretRef: req.GetCodeSecretRef()})
	registration.Status = result.Status
	registration.LastError = shared.ToProtoError(result.Err)
	if result.Status == waappv1.RegistrationStatus_REGISTRATION_STATUS_REGISTERED {
		completedAt := result.CompletedAt
		if completedAt.IsZero() {
			completedAt = s.clock.Now()
		}
		registration.CompletedAt = timestamppb.New(completedAt)
		registration.Identity = &waappv1.RegisteredIdentity{RegisteredIdentityId: shared.FirstNonEmpty(result.RegisteredID, s.ids.NewID("waid_")), WaAccountId: wamodel.WAAccountID(account), ClientProfileId: profile.GetClientProfileId(), ServiceAccountId: result.ServiceAccountID, ServiceLoginId: result.ServiceLoginID, RegisteredAt: timestamppb.New(completedAt)}
	}
	if err := s.store.SaveRegistration(ctx, registration); err != nil {
		return &waappv1.SubmitVerificationCodeResponse{Error: shared.ToProtoError(err)}, nil
	}
	if registration.GetStatus() == waappv1.RegistrationStatus_REGISTRATION_STATUS_REGISTERED {
		if _, err := s.SaveWAAccountRecord(ctx, withWAAccountStatus(account, waappv1.WAAccountStatus_WA_ACCOUNT_STATUS_ACTIVE, s.clock.Now())); err != nil {
			return &waappv1.SubmitVerificationCodeResponse{Registration: registration, Error: shared.ToProtoError(err)}, nil
		}
	}
	loginState, err := s.loginStateFromRegistration(registration)
	if err != nil {
		return &waappv1.SubmitVerificationCodeResponse{Registration: registration, Error: shared.ToProtoError(err)}, nil
	}
	if loginState != nil {
		if err := s.store.SaveLoginState(ctx, loginState, "native-db:"+profile.GetClientProfileId()); err != nil {
			return &waappv1.SubmitVerificationCodeResponse{Registration: registration, Error: shared.ToProtoError(err)}, nil
		}
		s.ensureLongConnection(ctx, loginState)
	}
	return &waappv1.SubmitVerificationCodeResponse{Registration: registration, LoginState: loginState, Error: registration.GetLastError()}, nil
}

func (s *registrationHandler) GetRegistration(ctx context.Context, req *waappv1.GetRegistrationRequest) (*waappv1.GetRegistrationResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.GetRegistrationResponse{Error: shared.ToProtoError(err)}, nil
	}
	registration, err := s.store.GetRegistration(ctx, req.GetRegistrationId())
	if err != nil {
		return &waappv1.GetRegistrationResponse{Error: shared.ToProtoError(err)}, nil
	}
	return &waappv1.GetRegistrationResponse{Registration: registration}, nil
}

func (s *registrationHandler) GetLoginState(ctx context.Context, req *waappv1.GetLoginStateRequest) (*waappv1.GetLoginStateResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.GetLoginStateResponse{Error: shared.ToProtoError(err)}, nil
	}
	loginState, err := s.store.GetLoginState(ctx, req.GetLoginStateId())
	if err != nil {
		return &waappv1.GetLoginStateResponse{Error: shared.ToProtoError(err)}, nil
	}
	return &waappv1.GetLoginStateResponse{LoginState: loginState}, nil
}

func (s *registrationHandler) GetActiveLoginState(ctx context.Context, req *waappv1.GetActiveLoginStateRequest) (*waappv1.GetActiveLoginStateResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.GetActiveLoginStateResponse{Error: shared.ToProtoError(err)}, nil
	}
	accountID, err := wamodel.RequireWAAccountID(req.GetWaAccountId())
	if err != nil {
		return &waappv1.GetActiveLoginStateResponse{Error: shared.ToProtoError(err)}, nil
	}
	loginState, err := s.store.GetActiveLoginState(ctx, accountID, req.GetClientProfileId())
	if err != nil {
		return &waappv1.GetActiveLoginStateResponse{Error: shared.ToProtoError(err)}, nil
	}
	return &waappv1.GetActiveLoginStateResponse{LoginState: loginState}, nil
}

func (s *registrationHandler) CheckLoginState(ctx context.Context, req *waappv1.CheckLoginStateRequest) (*waappv1.CheckLoginStateResponse, error) {
	return s.CheckLoginStateWithRunner(ctx, req, s.runner)
}

func (s *serverCore) CheckLoginStateWithRunner(ctx context.Context, req *waappv1.CheckLoginStateRequest, runner wacore.ProtocolEngine) (*waappv1.CheckLoginStateResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.CheckLoginStateResponse{Error: shared.ToProtoError(err)}, nil
	}
	loginState, err := s.loginStateForCheck(ctx, req)
	if err != nil {
		return &waappv1.CheckLoginStateResponse{Error: shared.ToProtoError(err)}, nil
	}
	result := wacore.EngineLoginCheckResult{Status: waappv1.LoginStateCheckStatus_LOGIN_STATE_CHECK_STATUS_ACTIVE}
	if s.longConnections == nil || s.longConnections.ActiveRunner(loginState) == nil {
		result = runner.CheckLoginState(ctx, wacore.EngineLoginCheckInput{WAAccountID: loginState.GetWaAccountId(), ClientProfileID: loginState.GetClientProfileId(), RegisteredIdentityID: loginState.GetRegisteredIdentityId(), AppVersion: s.loginStateAppVersion(ctx, loginState), RemoteTimeout: shared.DurationFromProto(req.GetRemoteTimeout())})
	}
	now := s.clock.Now()
	check := &waappv1.LoginStateCheck{
		LoginStateCheckId:    s.ids.NewID("walogchk_"),
		LoginStateId:         loginState.GetLoginStateId(),
		WaAccountId:          loginState.GetWaAccountId(),
		ClientProfileId:      loginState.GetClientProfileId(),
		RegisteredIdentityId: loginState.GetRegisteredIdentityId(),
		Status:               result.Status,
		CheckedAt:            timestamppb.New(now),
		Error:                shared.ToProtoError(result.Err),
	}
	if check.GetStatus() == waappv1.LoginStateCheckStatus_LOGIN_STATE_CHECK_STATUS_UNSPECIFIED && result.Err == nil {
		check.Status = waappv1.LoginStateCheckStatus_LOGIN_STATE_CHECK_STATUS_ACTIVE
	}
	if s.applyLoginStateCheck(loginState, check, now) {
		if err := s.store.SaveLoginState(ctx, loginState, "native-db:"+loginState.GetClientProfileId()); err != nil {
			return &waappv1.CheckLoginStateResponse{LoginState: loginState, Check: check, Error: shared.ToProtoError(err)}, nil
		}
	}
	if check.GetStatus() == waappv1.LoginStateCheckStatus_LOGIN_STATE_CHECK_STATUS_ACTIVE && loginState.GetStatus() == waappv1.LoginStateStatus_LOGIN_STATE_STATUS_ACTIVE {
		s.ensureLongConnection(ctx, loginState)
	}
	return &waappv1.CheckLoginStateResponse{LoginState: loginState, Check: check, Error: check.GetError()}, nil
}

func (s *serverCore) loginStateForCheck(ctx context.Context, req *waappv1.CheckLoginStateRequest) (*waappv1.LoginState, error) {
	if req.GetLoginStateId() != "" {
		return s.store.GetLoginState(ctx, req.GetLoginStateId())
	}
	if req.GetRegisteredIdentityId() != "" {
		return s.store.GetLoginStateByRegisteredIdentity(ctx, req.GetRegisteredIdentityId())
	}
	if req.GetWaAccountId() != "" && req.GetClientProfileId() != "" {
		accountID, err := wamodel.RequireWAAccountID(req.GetWaAccountId())
		if err != nil {
			return nil, err
		}
		return s.store.GetActiveLoginState(ctx, accountID, req.GetClientProfileId())
	}
	return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "login_state_id, registered_identity_id, or wa_account_id/client_profile_id is required", false)
}

func (s *serverCore) applyLoginStateCheck(loginState *waappv1.LoginState, check *waappv1.LoginStateCheck, now time.Time) bool {
	if loginState.GetAudit() == nil {
		loginState.Audit = &waappv1.AuditStamp{CreatedAt: timestamppb.New(now)}
	}
	switch check.GetStatus() {
	case waappv1.LoginStateCheckStatus_LOGIN_STATE_CHECK_STATUS_ACTIVE:
		loginState.Status = waappv1.LoginStateStatus_LOGIN_STATE_STATUS_ACTIVE
		loginState.LastVerifiedAt = check.GetCheckedAt()
		loginState.LastError = nil
	case waappv1.LoginStateCheckStatus_LOGIN_STATE_CHECK_STATUS_INVALID:
		loginState.Status = waappv1.LoginStateStatus_LOGIN_STATE_STATUS_INVALID
		loginState.LastError = check.GetError()
	case waappv1.LoginStateCheckStatus_LOGIN_STATE_CHECK_STATUS_UNREACHABLE:
		loginState.LastError = check.GetError()
	default:
		return false
	}
	loginState.Audit.UpdatedAt = timestamppb.New(now)
	return true
}

func (s *serverCore) loginStateFromRegistration(registration *waappv1.RegistrationRecord) (*waappv1.LoginState, error) {
	if registration.GetStatus() != waappv1.RegistrationStatus_REGISTRATION_STATUS_REGISTERED {
		return nil, nil
	}
	identity := registration.GetIdentity()
	if identity.GetRegisteredIdentityId() == "" {
		return nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "registered identity is required for active login state", false)
	}
	registeredAt := identity.GetRegisteredAt()
	if registeredAt == nil {
		registeredAt = registration.GetCompletedAt()
	}
	if registeredAt == nil {
		registeredAt = timestamppb.New(s.clock.Now())
	}
	now := s.clock.Now()
	return &waappv1.LoginState{
		LoginStateId:         "walogin_" + shared.StableID(identity.GetRegisteredIdentityId()),
		RegistrationId:       registration.GetRegistrationId(),
		WaAccountId:          registration.GetWaAccountId(),
		ClientProfileId:      registration.GetClientProfileId(),
		RegisteredIdentityId: identity.GetRegisteredIdentityId(),
		ServiceAccountId:     identity.GetServiceAccountId(),
		ServiceLoginId:       identity.GetServiceLoginId(),
		Status:               waappv1.LoginStateStatus_LOGIN_STATE_STATUS_ACTIVE,
		RegisteredAt:         registeredAt,
		LastVerifiedAt:       registeredAt,
		Audit:                &waappv1.AuditStamp{CreatedAt: timestamppb.New(now), UpdatedAt: timestamppb.New(now)},
	}, nil
}

func (s *serverCore) waAccountAndProfile(ctx context.Context, waAccountIDValue string, clientProfileID string) (*waappv1.WAAccount, *waappv1.ClientProfile, error) {
	accountID, err := wamodel.RequireWAAccountID(waAccountIDValue)
	if err != nil {
		return nil, nil, err
	}
	account, err := s.GetWAAccountRecord(ctx, accountID)
	if err != nil {
		return nil, nil, err
	}
	profile, err := s.store.GetClientProfile(ctx, clientProfileID)
	if err != nil {
		return nil, nil, err
	}
	if profile.GetWaAccountId() != wamodel.WAAccountID(account) {
		return nil, nil, shared.NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "client profile does not belong to WA account", false)
	}
	return account, profile, nil
}

func defaultExpiry(now time.Time, expiresAt *timestamppb.Timestamp) *timestamppb.Timestamp {
	if expiresAt != nil {
		return expiresAt
	}
	return timestamppb.New(now.Add(10 * time.Minute))
}

func (s *serverCore) NewVerificationCodeRequestRecord(account *waappv1.WAAccount, profile *waappv1.ClientProfile, method waappv1.VerificationDeliveryMethod, result wacore.EngineCodeResult) *waappv1.VerificationCodeRequestRecord {
	now := s.clock.Now()
	return &waappv1.VerificationCodeRequestRecord{
		VerificationRequestId: s.ids.NewID("wavrf_"),
		WaAccountId:           wamodel.WAAccountID(account),
		ClientProfileId:       profile.GetClientProfileId(),
		DeliveryMethod:        method,
		Status:                result.Status,
		ExpectedCodeLength:    result.ExpectedCodeLength,
		RequestedAt:           timestamppb.New(now),
		ExpiresAt:             defaultExpiry(now, shared.ProtoTimestamp(result.ExpiresAt)),
		LastError:             shared.ToProtoError(result.Err),
		RetryAfter:            shared.DurationToProto(result.RetryAfter),
		MethodStatuses:        protoVerificationMethodStatuses(result.MethodStatuses),
	}
}

func protoVerificationMethodStatuses(statuses []wacore.VerificationMethodStatus) []*waappv1.VerificationMethodStatus {
	out := make([]*waappv1.VerificationMethodStatus, 0, len(statuses))
	for _, status := range statuses {
		if status.Method == waappv1.VerificationDeliveryMethod_VERIFICATION_DELIVERY_METHOD_UNSPECIFIED {
			continue
		}
		out = append(out, &waappv1.VerificationMethodStatus{
			DeliveryMethod: status.Method,
			Available:      status.Available,
			Cooldown:       shared.DurationFromSeconds(status.CooldownSeconds),
		})
	}
	return out
}
