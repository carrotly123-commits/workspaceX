package shared

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ObjectField returns the nested object at key, or an empty map when absent or
// not an object. It never returns nil, so callers can chain accesses safely.
func ObjectField(data map[string]any, key string) map[string]any {
	if data == nil {
		return map[string]any{}
	}
	if value, ok := data[key].(map[string]any); ok {
		return value
	}
	return map[string]any{}
}

// TextField returns the value at key rendered as a trimmed string, coercing
// numbers and other scalars to their textual form.
func TextField(data map[string]any, key string) string {
	if data == nil {
		return ""
	}
	value, ok := data[key]
	if !ok || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	case float64:
		return fmt.Sprintf("%.0f", typed)
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}
