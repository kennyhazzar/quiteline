package notifications

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct {
	pool *pgxpool.Pool
}

func NewPostgresStore(ctx context.Context, dsn string) (*PostgresStore, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	store := &PostgresStore{pool: pool}
	if err := store.migrate(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return store, nil
}

func (s *PostgresStore) Close() {
	s.pool.Close()
}

func (s *PostgresStore) migrate(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS push_subscriptions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	endpoint TEXT NOT NULL UNIQUE,
	p256dh TEXT NOT NULL,
	auth TEXT NOT NULL,
	user_agent TEXT NOT NULL DEFAULT '',
	notify_messages BOOLEAN NOT NULL DEFAULT true,
	notify_chats BOOLEAN NOT NULL DEFAULT true,
	notify_sessions BOOLEAN NOT NULL DEFAULT true,
	notify_friends BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	last_used_at TIMESTAMPTZ,
	revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx ON push_subscriptions(user_id);
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS notify_messages BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS notify_chats BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS notify_sessions BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS notify_friends BOOLEAN NOT NULL DEFAULT true;
`)
	return err
}

func (s *PostgresStore) Save(ctx context.Context, sub Subscription) (Subscription, error) {
	sub = normalizeSubscription(sub)
	if sub.ID == "" || sub.UserID == "" || sub.Endpoint == "" || sub.P256DH == "" || sub.Auth == "" {
		return Subscription{}, ErrBadRequest
	}
	var result Subscription
	var prefs Preferences
	err := s.pool.QueryRow(ctx, `
		INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, notify_messages, notify_chats, notify_sessions, notify_friends)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (endpoint) DO UPDATE SET
			user_id = EXCLUDED.user_id,
			p256dh = EXCLUDED.p256dh,
			auth = EXCLUDED.auth,
			user_agent = EXCLUDED.user_agent,
			notify_messages = EXCLUDED.notify_messages,
			notify_chats = EXCLUDED.notify_chats,
			notify_sessions = EXCLUDED.notify_sessions,
			notify_friends = EXCLUDED.notify_friends,
			revoked_at = NULL
		RETURNING id, user_id, endpoint, p256dh, auth, user_agent, notify_messages, notify_chats, notify_sessions, notify_friends, created_at, COALESCE(last_used_at, '0001-01-01T00:00:00Z'::timestamptz), COALESCE(revoked_at, '0001-01-01T00:00:00Z'::timestamptz)
	`, sub.ID, sub.UserID, sub.Endpoint, sub.P256DH, sub.Auth, sub.UserAgent, sub.Preferences.Messages, sub.Preferences.Chats, sub.Preferences.Sessions, sub.Preferences.Friends).
		Scan(&result.ID, &result.UserID, &result.Endpoint, &result.P256DH, &result.Auth, &result.UserAgent, &prefs.Messages, &prefs.Chats, &prefs.Sessions, &prefs.Friends, &result.CreatedAt, &result.LastUsedAt, &result.RevokedAt)
	result.Preferences = prefs
	return result, err
}

func (s *PostgresStore) ListByUser(ctx context.Context, userID string) ([]Subscription, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, user_id, endpoint, p256dh, auth, user_agent, notify_messages, notify_chats, notify_sessions, notify_friends, created_at, COALESCE(last_used_at, '0001-01-01T00:00:00Z'::timestamptz), COALESCE(revoked_at, '0001-01-01T00:00:00Z'::timestamptz)
		FROM push_subscriptions
		WHERE user_id = $1 AND revoked_at IS NULL
		ORDER BY created_at DESC
	`, strings.TrimSpace(userID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Subscription{}
	for rows.Next() {
		sub, err := scanSubscription(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, sub)
	}
	return result, rows.Err()
}

func (s *PostgresStore) UpdatePreferences(ctx context.Context, userID string, id string, prefs Preferences) (Subscription, error) {
	var result Subscription
	var next Preferences
	err := s.pool.QueryRow(ctx, `
		UPDATE push_subscriptions
		SET notify_messages = $3, notify_chats = $4, notify_sessions = $5, notify_friends = $6
		WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL
		RETURNING id, user_id, endpoint, p256dh, auth, user_agent, notify_messages, notify_chats, notify_sessions, notify_friends, created_at, COALESCE(last_used_at, '0001-01-01T00:00:00Z'::timestamptz), COALESCE(revoked_at, '0001-01-01T00:00:00Z'::timestamptz)
	`, strings.TrimSpace(userID), strings.TrimSpace(id), prefs.Messages, prefs.Chats, prefs.Sessions, prefs.Friends).
		Scan(&result.ID, &result.UserID, &result.Endpoint, &result.P256DH, &result.Auth, &result.UserAgent, &next.Messages, &next.Chats, &next.Sessions, &next.Friends, &result.CreatedAt, &result.LastUsedAt, &result.RevokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Subscription{}, ErrNotFound
	}
	result.Preferences = next
	return result, err
}

func (s *PostgresStore) Delete(ctx context.Context, userID string, id string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE push_subscriptions SET revoked_at = COALESCE(revoked_at, now())
		WHERE user_id = $1 AND id = $2
	`, strings.TrimSpace(userID), strings.TrimSpace(id))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) Touch(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE push_subscriptions SET last_used_at = now() WHERE id = $1`, strings.TrimSpace(id))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

type subscriptionScanner interface {
	Scan(dest ...any) error
}

func scanSubscription(row subscriptionScanner) (Subscription, error) {
	var sub Subscription
	var prefs Preferences
	err := row.Scan(&sub.ID, &sub.UserID, &sub.Endpoint, &sub.P256DH, &sub.Auth, &sub.UserAgent, &prefs.Messages, &prefs.Chats, &prefs.Sessions, &prefs.Friends, &sub.CreatedAt, &sub.LastUsedAt, &sub.RevokedAt)
	sub.Preferences = prefs
	if sub.LastUsedAt.Equal(time.Time{}) {
		sub.LastUsedAt = time.Time{}
	}
	return sub, err
}
