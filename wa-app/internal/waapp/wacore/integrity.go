package wacore

import "strings"

// IntegrityMode selects how the engine supplies device-integrity material for a
// registration request.
type IntegrityMode string

const (
	IntegrityModeErrorCode        IntegrityMode = "error_code"
	IntegrityModePlayIntegrityAPI IntegrityMode = "play_integrity_api"
)

// NormalizeIntegrityMode maps the accepted spellings onto the canonical modes,
// defaulting to the error-code mode.
func NormalizeIntegrityMode(value string) IntegrityMode {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "error", "errorcode", "error_code", "error-code", "gpia_error_code":
		return IntegrityModeErrorCode
	case "play_integrity", "play-integrity", "play_integrity_api", "play-integrity-api", "pi", "pi_api":
		return IntegrityModePlayIntegrityAPI
	default:
		return IntegrityModeErrorCode
	}
}

func (m IntegrityMode) String() string {
	mode := NormalizeIntegrityMode(string(m))
	if mode == "" {
		return string(IntegrityModeErrorCode)
	}
	return string(mode)
}
