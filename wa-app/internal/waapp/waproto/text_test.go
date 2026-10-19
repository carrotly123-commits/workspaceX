package waproto

import (
	"testing"

	"google.golang.org/protobuf/encoding/protowire"
)

func encodeConversationMessage(text string) []byte {
	// WA Message field 1 (conversation) as a length-delimited string.
	raw := protowire.AppendTag(nil, 1, protowire.BytesType)
	return protowire.AppendBytes(raw, []byte(text))
}

func TestMessageDisplayTextWellFormed(t *testing.T) {
	raw := encodeConversationMessage("hello from a plain conversation")
	text, ok := MessageDisplayText(raw)
	if !ok {
		t.Fatalf("expected display text from well-formed message")
	}
	if text != "hello from a plain conversation" {
		t.Fatalf("unexpected display text: %q", text)
	}
}

func TestMessageDisplayTextLenientTrailingGarbage(t *testing.T) {
	raw := encodeConversationMessage("hello before trailing garbage")
	// A bytes-type tag whose declared length runs past the payload makes the
	// strict parser reject the whole frame; the leading field must survive.
	raw = protowire.AppendTag(raw, 2, protowire.BytesType)
	raw = protowire.AppendVarint(raw, 200)
	raw = append(raw, 0x01)

	text, ok := MessageDisplayText(raw)
	if !ok {
		t.Fatalf("expected lenient parsing to recover display text from frame with trailing garbage")
	}
	if text != "hello before trailing garbage" {
		t.Fatalf("unexpected display text: %q", text)
	}
}

func TestMessageDisplayTextLenientTopLevelOnly(t *testing.T) {
	// The same truncated tail nested inside a submessage must not be
	// rescued: lenient parsing applies to the top-level frame only.
	nested := protowire.AppendTag(nil, 1, protowire.BytesType)
	nested = protowire.AppendBytes(nested, []byte("nested text"))
	nested = protowire.AppendTag(nested, 2, protowire.BytesType)
	nested = protowire.AppendVarint(nested, 200)
	nested = append(nested, 0x01)

	raw := protowire.AppendTag(nil, 99, protowire.BytesType)
	raw = protowire.AppendBytes(raw, nested)

	if text, ok := MessageDisplayText(raw); ok && text == "nested text" {
		t.Fatalf("lenient parsing must not rescue fields nested inside a malformed submessage")
	}
}
