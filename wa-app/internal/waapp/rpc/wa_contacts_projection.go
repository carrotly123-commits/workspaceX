package rpc

import (
	"context"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/wamodel"
)

func (s *serverCore) saveInboundMessagesForSession(ctx context.Context, session *waappv1.MessageSession, messages []*waappv1.InboundMessage) error {
	if err := s.store.SaveInboundMessages(ctx, messages); err != nil {
		return err
	}
	contacts := wamodel.ContactsFromInboundMessages(session.GetWaAccountId(), messages, s.clock.Now())
	if len(contacts) == 0 {
		return nil
	}
	return s.store.SaveWAContacts(ctx, contacts)
}
