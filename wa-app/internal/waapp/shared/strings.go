package shared

import "strings"

// UniqueNonEmptyStrings returns the input values trimmed of surrounding
// whitespace, dropping empty and duplicate entries while preserving order.
func UniqueNonEmptyStrings(values ...string) []string {
	out := []string{}
	seen := map[string]struct{}{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}
