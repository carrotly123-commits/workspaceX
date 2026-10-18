package rpc

import (
	"context"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
	"github.com/byte-v-forge/wa-app/internal/waapp/wamodel"
)

func (s *extractionHandler) DecryptMessage(ctx context.Context, req *waappv1.DecryptMessageRequest) (*waappv1.DecryptMessageResponse, error) {
	return s.decryptMessage(ctx, req, s.runner, waappv1.WaOtpSource_WA_OTP_SOURCE_AUTO_EXTRACTION)
}

func (s *serverCore) decryptMessage(ctx context.Context, req *waappv1.DecryptMessageRequest, runner wacore.ProtocolEngine, otpSource waappv1.WaOtpSource) (*waappv1.DecryptMessageResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.DecryptMessageResponse{Error: shared.ToProtoError(err)}, nil
	}
	msg, err := s.store.GetInboundMessage(ctx, req.GetMessageId())
	if err != nil {
		return &waappv1.DecryptMessageResponse{Error: shared.ToProtoError(err)}, nil
	}
	session, err := s.store.GetMessageSession(ctx, msg.GetMessageSessionId())
	if err != nil {
		return &waappv1.DecryptMessageResponse{Error: shared.ToProtoError(err)}, nil
	}
	if runner == nil {
		runner = s.runner
	}
	result := runner.DecryptMessage(ctx, wacore.EngineDecryptInput{MessageID: msg.GetMessageId(), MessageSessionID: msg.GetMessageSessionId(), ClientProfileID: session.GetClientProfileId(), PayloadRef: msg.GetPayloadRef(), SessionCommitPolicy: req.GetSessionCommitPolicy(), IncludePlaintextText: req.GetIncludeSensitivePlaintext()})
	if result.Err != nil {
		return &waappv1.DecryptMessageResponse{Error: shared.ToProtoError(result.Err)}, nil
	}
	if err := s.store.SaveDecryptedMessage(ctx, result.DecryptedMessage); err != nil {
		return &waappv1.DecryptMessageResponse{Error: shared.ToProtoError(err)}, nil
	}
	if contact := wamodel.ContactFromDecryptedMessage(session.GetWaAccountId(), msg, shared.FirstNonEmpty(result.DecryptedMessage.GetPlaintextText().GetValue(), result.DecryptedMessage.GetPlaintextText().GetRedactedValue()), s.clock.Now()); contact != nil {
		_ = s.store.SaveWAContacts(ctx, []*waappv1.WAContact{contact})
	}
	if contacts := wamodel.ContactsFromContactHints(session.GetWaAccountId(), msg, result.ContactHints, s.clock.Now()); len(contacts) > 0 {
		_ = s.store.SaveWAContacts(ctx, contacts)
	}
	if len(result.Candidates) > 0 {
		_ = s.store.SaveCandidates(ctx, result.Candidates)
		s.publishOTPCandidates(context.WithoutCancel(ctx), msg, session, result.Candidates, otpSource)
	}
	msg.EncryptionState = waappv1.MessageEncryptionState_MESSAGE_ENCRYPTION_STATE_DECRYPTED
	_ = s.saveInboundMessagesForSession(ctx, session, []*waappv1.InboundMessage{msg})
	return &waappv1.DecryptMessageResponse{DecryptedMessage: result.DecryptedMessage}, nil
}

func (s *extractionHandler) ExtractCandidates(ctx context.Context, req *waappv1.ExtractCandidatesRequest) (*waappv1.ExtractCandidatesResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.ExtractCandidatesResponse{Error: shared.ToProtoError(err)}, nil
	}
	messageID := req.GetMessageId()
	if messageID == "" {
		decrypted, err := s.store.GetDecryptedMessage(ctx, req.GetDecryptedMessageId())
		if err != nil {
			return &waappv1.ExtractCandidatesResponse{Error: shared.ToProtoError(err)}, nil
		}
		messageID = decrypted.GetMessageId()
	}
	msg, err := s.store.GetInboundMessage(ctx, messageID)
	if err != nil {
		return &waappv1.ExtractCandidatesResponse{Error: shared.ToProtoError(err)}, nil
	}
	session, err := s.store.GetMessageSession(ctx, msg.GetMessageSessionId())
	if err != nil {
		return &waappv1.ExtractCandidatesResponse{Error: shared.ToProtoError(err)}, nil
	}
	result := s.runner.DecryptMessage(ctx, wacore.EngineDecryptInput{MessageID: msg.GetMessageId(), MessageSessionID: msg.GetMessageSessionId(), ClientProfileID: session.GetClientProfileId(), PayloadRef: msg.GetPayloadRef(), SessionCommitPolicy: waappv1.SessionCommitPolicy_SESSION_COMMIT_POLICY_TRANSIENT, IncludePlaintextText: req.GetIncludeSensitiveValues()})
	if result.Err != nil {
		return &waappv1.ExtractCandidatesResponse{Error: shared.ToProtoError(result.Err)}, nil
	}
	candidates := filterCandidates(result.Candidates, req.GetCandidateKinds())
	if err := s.store.SaveCandidates(ctx, candidates); err != nil {
		return &waappv1.ExtractCandidatesResponse{Error: shared.ToProtoError(err)}, nil
	}
	s.publishOTPCandidates(context.WithoutCancel(ctx), msg, session, candidates, waappv1.WaOtpSource_WA_OTP_SOURCE_AUTO_EXTRACTION)
	return &waappv1.ExtractCandidatesResponse{Candidates: candidates}, nil
}

func (s *extractionHandler) ListAccountOtpMessages(ctx context.Context, req *waappv1.ListAccountOtpMessagesRequest) (*waappv1.ListAccountOtpMessagesResponse, error) {
	if err := shared.ValidateContext(req.GetContext()); err != nil {
		return &waappv1.ListAccountOtpMessagesResponse{Error: shared.ToProtoError(err)}, nil
	}
	accountID, err := wamodel.RequireWAAccountID(req.GetWaAccountId())
	if err != nil {
		return &waappv1.ListAccountOtpMessagesResponse{Error: shared.ToProtoError(err)}, nil
	}
	if _, err := s.GetWAAccountRecord(ctx, accountID); err != nil {
		return &waappv1.ListAccountOtpMessagesResponse{Error: shared.ToProtoError(err)}, nil
	}
	items, nextCursor, err := s.store.ListAccountOTPMessages(ctx, accountID, req.GetCursor(), int(req.GetLimit()), req.GetIncludeSensitiveValues())
	if err != nil {
		return &waappv1.ListAccountOtpMessagesResponse{Error: shared.ToProtoError(err)}, nil
	}
	return &waappv1.ListAccountOtpMessagesResponse{OtpMessages: items, NextCursor: nextCursor}, nil
}

func filterCandidates(candidates []*waappv1.ExtractedCandidate, kinds []waappv1.CandidateKind) []*waappv1.ExtractedCandidate {
	if len(kinds) == 0 {
		return candidates
	}
	allowed := map[waappv1.CandidateKind]struct{}{}
	for _, kind := range kinds {
		allowed[kind] = struct{}{}
	}
	out := []*waappv1.ExtractedCandidate{}
	for _, candidate := range candidates {
		if _, ok := allowed[candidate.GetKind()]; ok {
			out = append(out, candidate)
		}
	}
	return out
}
