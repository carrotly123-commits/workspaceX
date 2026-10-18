package runtime

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/store"
	_ "modernc.org/sqlite"
)

type SQLiteRuntime struct{ db *sql.DB }

func NewSQLiteRuntime(ctx context.Context, dataDir string) (*SQLiteRuntime, error) {
	dataDir = strings.TrimSpace(dataDir)
	if dataDir == "" {
		dataDir = store.DefaultWAAppDataDir
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	return NewSQLiteRuntimeFile(ctx, filepath.Join(dataDir, store.SQLiteStoreFileName))
}

func NewSQLiteRuntimeFile(ctx context.Context, path string) (*SQLiteRuntime, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("sqlite runtime path is required")
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	runtime := &SQLiteRuntime{db: db}
	if err := runtime.configure(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	if _, err := db.ExecContext(ctx, store.SQLiteStoreSchema); err != nil {
		_ = db.Close()
		return nil, err
	}
	return runtime, nil
}

func (r *SQLiteRuntime) configure(ctx context.Context) error {
	for _, statement := range []string{
		`PRAGMA journal_mode=WAL`,
		`PRAGMA synchronous=NORMAL`,
		`PRAGMA busy_timeout=5000`,
	} {
		if _, err := r.db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func (r *SQLiteRuntime) Close() error {
	if r == nil || r.db == nil {
		return nil
	}
	return r.db.Close()
}

func (r *SQLiteRuntime) ClaimRequest(ctx context.Context, requestID string, ttl time.Duration) (bool, error) {
	if strings.TrimSpace(requestID) == "" {
		return true, nil
	}
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	now := time.Now().UTC()
	if err := r.cleanup(ctx, now); err != nil {
		return false, err
	}
	expiresAt := store.SQLiteTimeValue(now.Add(ttl))
	result, err := r.db.ExecContext(ctx, `INSERT OR IGNORE INTO wa_sqlite_runtime_state (kind,key,value,expires_at) VALUES (?,?,?,?)`, "idempotency", requestID, []byte("1"), expiresAt)
	if err != nil {
		return false, err
	}
	changed, err := result.RowsAffected()
	return changed > 0, err
}

func (r *SQLiteRuntime) SaveTransientState(ctx context.Context, ref string, data []byte, ttl time.Duration) error {
	if strings.TrimSpace(ref) == "" {
		return fmt.Errorf("transient state ref is required")
	}
	if ttl <= 0 {
		ttl = 30 * time.Minute
	}
	return r.save(ctx, "transient", ref, data, ttl)
}

func (r *SQLiteRuntime) GetTransientState(ctx context.Context, ref string) ([]byte, error) {
	if strings.TrimSpace(ref) == "" {
		return nil, fmt.Errorf("transient state ref is required")
	}
	data, err := r.load(ctx, "transient", ref)
	if err != nil {
		return nil, fmt.Errorf("transient state ref not found")
	}
	return data, nil
}

func (r *SQLiteRuntime) DeleteTransientState(ctx context.Context, ref string) error {
	if strings.TrimSpace(ref) == "" {
		return nil
	}
	return r.delete(ctx, "transient", ref)
}

func (r *SQLiteRuntime) ClaimLease(ctx context.Context, key string, holder string, ttl time.Duration) (bool, error) {
	key = strings.TrimSpace(key)
	holder = strings.TrimSpace(holder)
	if key == "" || holder == "" {
		return true, nil
	}
	now := time.Now().UTC()
	if err := r.cleanup(ctx, now); err != nil {
		return false, err
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	var current []byte
	var expiresAt int64
	err = tx.QueryRowContext(ctx, `SELECT value,expires_at FROM wa_sqlite_runtime_state WHERE kind=? AND key=?`, "lease", key).Scan(&current, &expiresAt)
	switch {
	case err == nil && string(current) != holder && expiresAt > store.SQLiteTimeValue(now):
		return false, tx.Commit()
	case err != nil && err != sql.ErrNoRows:
		return false, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO wa_sqlite_runtime_state (kind,key,value,expires_at) VALUES (?,?,?,?)
ON CONFLICT(kind,key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at`, "lease", key, []byte(holder), store.SQLiteTimeValue(now.Add(shared.NormalizeLeaseTTL(ttl))))
	if err != nil {
		return false, err
	}
	return true, tx.Commit()
}

func (r *SQLiteRuntime) RenewLease(ctx context.Context, key string, holder string, ttl time.Duration) (bool, error) {
	key = strings.TrimSpace(key)
	holder = strings.TrimSpace(holder)
	if key == "" || holder == "" {
		return true, nil
	}
	now := time.Now().UTC()
	result, err := r.db.ExecContext(ctx, `UPDATE wa_sqlite_runtime_state
SET expires_at=?
WHERE kind=? AND key=? AND value=? AND expires_at>?`, store.SQLiteTimeValue(now.Add(shared.NormalizeLeaseTTL(ttl))), "lease", key, []byte(holder), store.SQLiteTimeValue(now))
	if err != nil {
		return false, err
	}
	changed, err := result.RowsAffected()
	return changed > 0, err
}

func (r *SQLiteRuntime) ReleaseLease(ctx context.Context, key string, holder string) error {
	key = strings.TrimSpace(key)
	holder = strings.TrimSpace(holder)
	if key == "" || holder == "" {
		return nil
	}
	_, err := r.db.ExecContext(ctx, `DELETE FROM wa_sqlite_runtime_state WHERE kind=? AND key=? AND value=?`, "lease", key, []byte(holder))
	return err
}

func (r *SQLiteRuntime) OpenSessionLease(ctx context.Context, sessionID string, ttl time.Duration) error {
	if strings.TrimSpace(sessionID) == "" {
		return nil
	}
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	return r.save(ctx, "message-session", sessionID, []byte("open"), ttl)
}

func (r *SQLiteRuntime) CloseSessionLease(ctx context.Context, sessionID string) error {
	return r.delete(ctx, "message-session", sessionID)
}

func (r *SQLiteRuntime) save(ctx context.Context, kind string, key string, value []byte, ttl time.Duration) error {
	expiresAt := store.SQLiteTimeValue(time.Now().UTC().Add(ttl))
	_, err := r.db.ExecContext(ctx, `INSERT INTO wa_sqlite_runtime_state (kind,key,value,expires_at) VALUES (?,?,?,?)
ON CONFLICT(kind,key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at`, kind, key, value, expiresAt)
	return err
}

func (r *SQLiteRuntime) load(ctx context.Context, kind string, key string) ([]byte, error) {
	var value []byte
	err := r.db.QueryRowContext(ctx, `SELECT value FROM wa_sqlite_runtime_state WHERE kind=? AND key=? AND expires_at>?`, kind, key, store.SQLiteTimeValue(time.Now().UTC())).Scan(&value)
	if err != nil {
		return nil, err
	}
	return append([]byte(nil), value...), nil
}

func (r *SQLiteRuntime) delete(ctx context.Context, kind string, key string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM wa_sqlite_runtime_state WHERE kind=? AND key=?`, kind, key)
	return err
}

func (r *SQLiteRuntime) cleanup(ctx context.Context, now time.Time) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM wa_sqlite_runtime_state WHERE expires_at<=?`, store.SQLiteTimeValue(now))
	return err
}
