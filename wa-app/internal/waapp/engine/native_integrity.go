package engine

import (
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
)

func NativeIntegrityModeFromPayload(payload map[string]any) wacore.IntegrityMode {
	mode := shared.FirstNonEmpty(
		shared.TextField(payload, "integrity_mode"),
		shared.TextField(payload, "integrityMode"),
		shared.TextField(payload, "gpia_mode"),
		shared.TextField(payload, "play_integrity_mode"),
		shared.TextField(shared.ObjectField(payload, "registration"), "integrity_mode"),
	)
	return wacore.NormalizeIntegrityMode(mode)
}
