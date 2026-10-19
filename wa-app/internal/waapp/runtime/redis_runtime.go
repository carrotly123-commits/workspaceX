package runtime

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/redis/go-redis/v9"
)

type RedisRuntime struct {
	client *redis.Client
}

func NewRedisRuntime(ctx context.Context, rawURL string) (*RedisRuntime, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return nil, errors.New("WA_APP_REDIS_URL is required")
	}
	opts, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, fmt.Errorf("parse WA_APP_REDIS_URL: %w", err)
	}
	client := redis.NewClient(opts)
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("ping redis: %w", err)
	}
	return &RedisRuntime{client: client}, nil
}

func (r *RedisRuntime) Close() error {
	if r == nil || r.client == nil {
		return nil
	}
	return r.client.Close()
}

func (r *RedisRuntime) ClaimRequest(ctx context.Context, requestID string, ttl time.Duration) (bool, error) {
	if requestID == "" {
		return true, nil
	}
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	return r.client.SetNX(ctx, redisKey("idempotency", requestID), "1", ttl).Result()
}

func (r *RedisRuntime) SaveTransientState(ctx context.Context, ref string, data []byte, ttl time.Duration) error {
	if strings.TrimSpace(ref) == "" {
		return fmt.Errorf("transient state ref is required")
	}
	if ttl <= 0 {
		ttl = 30 * time.Minute
	}
	return r.client.Set(ctx, redisKey("transient-state", ref), string(data), ttl).Err()
}

func (r *RedisRuntime) GetTransientState(ctx context.Context, ref string) ([]byte, error) {
	if strings.TrimSpace(ref) == "" {
		return nil, fmt.Errorf("transient state ref is required")
	}
	value, err := r.client.Get(ctx, redisKey("transient-state", ref)).Result()
	if errors.Is(err, redis.Nil) {
		return nil, fmt.Errorf("transient state ref not found")
	}
	if err != nil {
		return nil, err
	}
	return []byte(value), nil
}

func (r *RedisRuntime) DeleteTransientState(ctx context.Context, ref string) error {
	if strings.TrimSpace(ref) == "" {
		return nil
	}
	return r.client.Del(ctx, redisKey("transient-state", ref)).Err()
}

func (r *RedisRuntime) ClaimLease(ctx context.Context, key string, holder string, ttl time.Duration) (bool, error) {
	key = strings.TrimSpace(key)
	holder = strings.TrimSpace(holder)
	if key == "" || holder == "" {
		return true, nil
	}
	ttl = shared.NormalizeLeaseTTL(ttl)
	result, err := r.client.Eval(ctx, `
local current = redis.call("GET", KEYS[1])
if not current or current == ARGV[1] then
  redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
  return 1
end
return 0
`, []string{redisKey("lease", key)}, holder, shared.LeaseTTLMilliseconds(ttl)).Int()
	return result == 1, err
}

func (r *RedisRuntime) RenewLease(ctx context.Context, key string, holder string, ttl time.Duration) (bool, error) {
	key = strings.TrimSpace(key)
	holder = strings.TrimSpace(holder)
	if key == "" || holder == "" {
		return true, nil
	}
	ttl = shared.NormalizeLeaseTTL(ttl)
	result, err := r.client.Eval(ctx, `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
  return 1
end
return 0
`, []string{redisKey("lease", key)}, holder, shared.LeaseTTLMilliseconds(ttl)).Int()
	return result == 1, err
}

func (r *RedisRuntime) ReleaseLease(ctx context.Context, key string, holder string) error {
	key = strings.TrimSpace(key)
	holder = strings.TrimSpace(holder)
	if key == "" || holder == "" {
		return nil
	}
	return r.client.Eval(ctx, `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`, []string{redisKey("lease", key)}, holder).Err()
}

func (r *RedisRuntime) OpenSessionLease(ctx context.Context, sessionID string, ttl time.Duration) error {
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	return r.client.Set(ctx, redisKey("message-session", sessionID), "open", ttl).Err()
}

func (r *RedisRuntime) CloseSessionLease(ctx context.Context, sessionID string) error {
	return r.client.Del(ctx, redisKey("message-session", sessionID)).Err()
}

func redisKey(scope string, key string) string {
	return "wa-app:" + strings.Trim(scope, ":") + ":" + strings.Trim(strings.TrimSpace(key), ":")
}
