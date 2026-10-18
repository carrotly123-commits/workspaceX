package shared

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const (
	defaultPageLimit = 100
	maxPageLimit     = 500
)

type KeysetCursor struct {
	UpdatedAt time.Time `json:"updated_at"`
	ID        string    `json:"id"`
}

func DecodeKeysetCursor(value string) (KeysetCursor, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return KeysetCursor{}, nil
	}
	data, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return KeysetCursor{}, fmt.Errorf("invalid page cursor")
	}
	var cursor KeysetCursor
	if err := json.Unmarshal(data, &cursor); err != nil {
		return KeysetCursor{}, fmt.Errorf("invalid page cursor")
	}
	if cursor.UpdatedAt.IsZero() || strings.TrimSpace(cursor.ID) == "" {
		return KeysetCursor{}, fmt.Errorf("invalid page cursor")
	}
	cursor.UpdatedAt = cursor.UpdatedAt.UTC()
	cursor.ID = strings.TrimSpace(cursor.ID)
	return cursor, nil
}

func encodeKeysetCursor(updatedAt time.Time, id string) string {
	id = strings.TrimSpace(id)
	if updatedAt.IsZero() || id == "" {
		return ""
	}
	data, err := json.Marshal(KeysetCursor{UpdatedAt: updatedAt.UTC(), ID: id})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(data)
}

func HasKeysetCursor(cursor KeysetCursor) bool {
	return !cursor.UpdatedAt.IsZero() && strings.TrimSpace(cursor.ID) != ""
}

func NormalizePageLimit(limit int) int {
	if limit <= 0 {
		return defaultPageLimit
	}
	if limit > maxPageLimit {
		return maxPageLimit
	}
	return limit
}

func KeysetLookaheadLimit(limit int) int {
	return NormalizePageLimit(limit) + 1
}

func trimLimit[T any](rows []T, limit int) ([]T, bool) {
	if limit < 0 {
		limit = 0
	}
	if len(rows) <= limit {
		return rows, false
	}
	return rows[:limit], true
}

func NewKeysetPage[T any](rows []T, limit int, cursorOf func(T) KeysetCursor) ([]T, string) {
	limit = NormalizePageLimit(limit)
	items, hasMore := trimLimit(rows, limit)
	if !hasMore || len(items) == 0 || cursorOf == nil {
		return items, ""
	}
	cursor := cursorOf(items[len(items)-1])
	return items, encodeKeysetCursor(cursor.UpdatedAt, cursor.ID)
}

func KeysetCursorValue(updatedAt time.Time, id string) KeysetCursor {
	id = strings.TrimSpace(id)
	if updatedAt.IsZero() || id == "" {
		return KeysetCursor{}
	}
	return KeysetCursor{UpdatedAt: updatedAt.UTC(), ID: id}
}
