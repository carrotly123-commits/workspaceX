package engine

import (
	"sync"
	"time"
)

const proxyLogInterval = 10 * time.Minute

type proxyLogLimiter struct {
	mu   sync.Mutex
	last map[string]time.Time
}

func (l *proxyLogLimiter) allow(purpose string, reason string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	key := purpose + ":" + reason
	if last, ok := l.last[key]; ok && now.Sub(last) < proxyLogInterval {
		return false
	}
	l.last[key] = now
	return true
}
