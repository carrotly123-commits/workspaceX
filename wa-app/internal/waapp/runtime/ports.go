package runtime

import (
	"context"
	"time"
)

// RuntimeState is the ephemeral coordination port: request idempotency,
// transient state, leases and message-session liveness. Backed by Redis when
// configured, otherwise by the no-config SQLite fallback.
type RuntimeState interface {
	Close() error
	ClaimRequest(context.Context, string, time.Duration) (bool, error)
	SaveTransientState(context.Context, string, []byte, time.Duration) error
	GetTransientState(context.Context, string) ([]byte, error)
	DeleteTransientState(context.Context, string) error
	ClaimLease(context.Context, string, string, time.Duration) (bool, error)
	RenewLease(context.Context, string, string, time.Duration) (bool, error)
	ReleaseLease(context.Context, string, string) error
	OpenSessionLease(context.Context, string, time.Duration) error
	CloseSessionLease(context.Context, string) error
}
