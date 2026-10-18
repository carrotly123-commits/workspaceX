package shared

import "time"

func NormalizeLeaseTTL(ttl time.Duration) time.Duration {
	if ttl <= 0 {
		return 30 * time.Second
	}
	return ttl
}

func LeaseTTLMilliseconds(ttl time.Duration) int64 {
	milliseconds := ttl.Milliseconds()
	if milliseconds <= 0 {
		return int64(time.Second / time.Millisecond)
	}
	return milliseconds
}
