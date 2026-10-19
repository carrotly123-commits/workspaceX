package store

import (
	"context"
	"time"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
)

// Store is the composite durable-persistence port. It is deliberately an
// aggregate of per-domain repositories so callers can depend on the narrow slice
// they use (interface segregation); the concrete backends implement the whole set.
type Store interface {
	DiscoveryRepository
	WAAccountRepository
	ClientProfileRepository
	NativeStateStore
	RegistrationRepository
	MessagingRepository
	WAContactRepository
	Close()
}

// DiscoveryRepository persists app artifacts and protocol profiles.
type DiscoveryRepository interface {
	SaveAppArtifact(context.Context, *waappv1.AppArtifact) error
	GetAppArtifact(context.Context, string) (*waappv1.AppArtifact, error)
	SaveProtocolProfile(context.Context, *waappv1.ProtocolProfile) error
	GetProtocolProfile(context.Context, string) (*waappv1.ProtocolProfile, error)
}

// WAAccountRepository persists WA accounts.
type WAAccountRepository interface {
	SaveWAAccount(context.Context, *waappv1.WAAccount) error
	GetWAAccount(context.Context, string) (*waappv1.WAAccount, error)
	FindWAAccountByPhone(context.Context, string) (*waappv1.WAAccount, error)
	ListWAAccounts(context.Context, string, int) ([]*waappv1.WAAccount, string, error)
	DeleteWAAccount(context.Context, string) error
}

// ClientProfileRepository persists client (device) profiles.
type ClientProfileRepository interface {
	SaveClientProfile(context.Context, *waappv1.ClientProfile) error
	GetClientProfile(context.Context, string) (*waappv1.ClientProfile, error)
	ListClientProfiles(context.Context, string, string, int) ([]*waappv1.ClientProfile, string, error)
}

// RegistrationRepository persists registration, verification and login-state records.
type RegistrationRepository interface {
	SaveAccountProbe(context.Context, *waappv1.AccountProbe) error
	SaveVerificationRequest(context.Context, *waappv1.VerificationCodeRequestRecord) error
	GetVerificationRequest(context.Context, string) (*waappv1.VerificationCodeRequestRecord, error)
	SaveRegistration(context.Context, *waappv1.RegistrationRecord) error
	GetRegistration(context.Context, string) (*waappv1.RegistrationRecord, error)
	SaveLoginState(context.Context, *waappv1.LoginState, string) error
	GetLoginState(context.Context, string) (*waappv1.LoginState, error)
	GetActiveLoginState(context.Context, string, string) (*waappv1.LoginState, error)
	ListActiveLoginStates(context.Context) ([]LoginStateRecord, error)
	ListRevokedLoginStates(context.Context) ([]LoginStateRecord, error)
	GetLoginStateByRegistration(context.Context, string) (*waappv1.LoginState, error)
	GetLoginStateByRegisteredIdentity(context.Context, string) (*waappv1.LoginState, error)
}

// MessagingRepository persists message sessions, inbound/decrypted messages,
// extracted candidates and OTP messages.
type MessagingRepository interface {
	SaveMessageSession(context.Context, *waappv1.MessageSession) error
	GetMessageSession(context.Context, string) (*waappv1.MessageSession, error)
	CloseStaleOpenMessageSessions(context.Context, time.Time) (int64, error)
	SaveInboundMessages(context.Context, []*waappv1.InboundMessage) error
	GetInboundMessage(context.Context, string) (*waappv1.InboundMessage, error)
	ListPendingEncryptedInboundMessages(context.Context, string, string, int) ([]*waappv1.InboundMessage, error)
	ListUnreadInboundMessagesByContactRefs(context.Context, string, []string, int) ([]*waappv1.InboundMessage, error)
	ListAccountMessages(context.Context, string, []string, string, int, bool) ([]*waappv1.AccountMessage, string, error)
	SaveDecryptedMessage(context.Context, *waappv1.DecryptedMessage) error
	GetDecryptedMessage(context.Context, string) (*waappv1.DecryptedMessage, error)
	SaveCandidates(context.Context, []*waappv1.ExtractedCandidate) error
	SaveOTPMessage(context.Context, *waappv1.OtpMessage) error
	ListAccountOTPMessages(context.Context, string, string, int, bool) ([]*waappv1.OtpMessage, string, error)
}

// WAContactRepository persists WA contacts.
type WAContactRepository interface {
	SaveWAContacts(context.Context, []*waappv1.WAContact) error
	GetWAContact(context.Context, string) (*waappv1.WAContact, error)
	GetWAContactByRef(context.Context, string, string) (*waappv1.WAContact, error)
	ListWAContacts(context.Context, string, string, int) ([]*waappv1.WAContact, string, error)
	DeleteWAContact(context.Context, string, []string, time.Time) (DeleteWAContactResult, error)
}

// NativeStateStore persists the engine's native protocol state. The state is
// engine-internal; the store treats it as an opaque serialized blob and never
// depends on its shape (the engine owns marshal/unmarshal).
type NativeStateStore interface {
	SaveNativeState(context.Context, string, []byte) error
	GetNativeState(context.Context, string) ([]byte, error)
}

type DeleteWAContactResult struct {
	Deleted             bool
	DeletedMessageCount int
}

type LoginStateRecord struct {
	LoginState *waappv1.LoginState
}
