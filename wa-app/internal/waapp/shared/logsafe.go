package shared

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// ProbeLogValue collapses whitespace and truncates a value so it is safe to log.
func ProbeLogValue(value string) string {
	value = strings.TrimSpace(strings.NewReplacer("\n", " ", "\r", " ", "\t", " ").Replace(value))
	if len(value) <= 160 {
		return value
	}
	return value[:160]
}

// SanitizeLogError reduces an error to a redacted, single-line message safe to log.
func SanitizeLogError(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s", SafeInternalErrorMessage(err))
}

// SafeProxyLogToken reduces a value to a lowercase [a-z0-9_-] token (max 64
// chars) suitable for logging, falling back when the value has no safe content.
func SafeProxyLogToken(value string, fallback string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var out strings.Builder
	for _, char := range value {
		switch {
		case char >= 'a' && char <= 'z':
			out.WriteRune(char)
		case char >= '0' && char <= '9':
			out.WriteRune(char)
		case char == '_' || char == '-':
			out.WriteRune(char)
		}
	}
	token := strings.Trim(out.String(), "_-")
	if token == "" {
		return fallback
	}
	if len(token) > 64 {
		return token[:64]
	}
	return token
}

// SleepContext sleeps for d, returning false if the context is cancelled first.
func SleepContext(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return true
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
