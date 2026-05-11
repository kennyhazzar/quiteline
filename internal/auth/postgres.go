package auth

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresUserStore struct {
	pool *pgxpool.Pool
}

func NewPostgresUserStore(ctx context.Context, dsn string) (*PostgresUserStore, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	store := &PostgresUserStore{pool: pool}
	if err := store.migrate(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return store, nil
}

func (s *PostgresUserStore) Close() {
	s.pool.Close()
}

func (s *PostgresUserStore) migrate(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS users (
	user_id       TEXT PRIMARY KEY,
	username      TEXT NOT NULL UNIQUE,
	display_name  TEXT NOT NULL,
	theme         TEXT NOT NULL DEFAULT 'dark',
	avatar_file_id TEXT NOT NULL DEFAULT '',
	avatar_mime_type TEXT NOT NULL DEFAULT '',
	avatar_size BIGINT NOT NULL DEFAULT 0,
	password_hash TEXT NOT NULL,
	totp_secret TEXT NOT NULL DEFAULT '',
	totp_enabled BOOLEAN NOT NULL DEFAULT false,
	created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'dark';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_file_id TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime_type TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_size BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS auth_sessions (
	session_id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
	username TEXT NOT NULL,
	refresh_token_hash TEXT NOT NULL DEFAULT '',
	device_name TEXT NOT NULL DEFAULT '',
	user_agent TEXT NOT NULL DEFAULT '',
	ip_address TEXT NOT NULL DEFAULT '',
	location TEXT NOT NULL DEFAULT '',
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	expires_at TIMESTAMPTZ NOT NULL,
	revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions(user_id);
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS refresh_token_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS device_name TEXT NOT NULL DEFAULT '';
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS user_agent TEXT NOT NULL DEFAULT '';
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS ip_address TEXT NOT NULL DEFAULT '';
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT '';
`)
	return err
}

func (s *PostgresUserStore) CreateUser(ctx context.Context, user User) (User, error) {
	user.Username = normalizeUsername(user.Username)
	user.DisplayName = strings.TrimSpace(user.DisplayName)
	if user.Username == "" || user.DisplayName == "" || user.PasswordHash == "" {
		return User{}, ErrInvalidCredentials
	}
	if user.UserID == "" {
		user.UserID = newUserID()
	}
	user.Theme = normalizeThemeOrDefault(user.Theme)

	var result User
	err := s.pool.QueryRow(ctx, `
		INSERT INTO users (user_id, username, display_name, theme, password_hash)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING user_id, username, display_name, theme, avatar_file_id, avatar_mime_type, avatar_size, password_hash, totp_secret, totp_enabled, created_at
	`, user.UserID, user.Username, user.DisplayName, user.Theme, user.PasswordHash).
		Scan(&result.UserID, &result.Username, &result.DisplayName, &result.Theme, &result.AvatarFileID, &result.AvatarMimeType, &result.AvatarSize, &result.PasswordHash, &result.TOTPSecret, &result.TOTPEnabled, &result.CreatedAt)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return User{}, ErrUserExists
	}
	return result, err
}

func (s *PostgresUserStore) GetUserByUsername(ctx context.Context, username string) (User, error) {
	var result User
	err := s.pool.QueryRow(ctx, `
		SELECT user_id, username, display_name, theme, avatar_file_id, avatar_mime_type, avatar_size, password_hash, totp_secret, totp_enabled, created_at
		FROM users WHERE username = $1
	`, normalizeUsername(username)).
		Scan(&result.UserID, &result.Username, &result.DisplayName, &result.Theme, &result.AvatarFileID, &result.AvatarMimeType, &result.AvatarSize, &result.PasswordHash, &result.TOTPSecret, &result.TOTPEnabled, &result.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUserNotFound
	}
	result.FriendCode = friendCodeForUserID(result.UserID)
	return result, err
}

func (s *PostgresUserStore) GetUserByFriendCode(ctx context.Context, friendCode string) (User, error) {
	friendCode = normalizeFriendCode(friendCode)
	if friendCode == "" {
		return User{}, ErrUserNotFound
	}
	rows, err := s.pool.Query(ctx, `
		SELECT user_id, username, display_name, theme, avatar_file_id, avatar_mime_type, avatar_size, password_hash, totp_secret, totp_enabled, created_at
		FROM users
	`)
	if err != nil {
		return User{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var result User
		if err := rows.Scan(&result.UserID, &result.Username, &result.DisplayName, &result.Theme, &result.AvatarFileID, &result.AvatarMimeType, &result.AvatarSize, &result.PasswordHash, &result.TOTPSecret, &result.TOTPEnabled, &result.CreatedAt); err != nil {
			return User{}, err
		}
		if friendCodeForUserID(result.UserID) == friendCode {
			result.FriendCode = friendCode
			return result, nil
		}
	}
	if err := rows.Err(); err != nil {
		return User{}, err
	}
	return User{}, ErrUserNotFound
}

func (s *PostgresUserStore) GetUserByID(ctx context.Context, userID string) (User, error) {
	var result User
	err := s.pool.QueryRow(ctx, `
		SELECT user_id, username, display_name, theme, avatar_file_id, avatar_mime_type, avatar_size, password_hash, totp_secret, totp_enabled, created_at
		FROM users WHERE user_id = $1
	`, strings.TrimSpace(userID)).
		Scan(&result.UserID, &result.Username, &result.DisplayName, &result.Theme, &result.AvatarFileID, &result.AvatarMimeType, &result.AvatarSize, &result.PasswordHash, &result.TOTPSecret, &result.TOTPEnabled, &result.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUserNotFound
	}
	result.FriendCode = friendCodeForUserID(result.UserID)
	return result, err
}

func (s *PostgresUserStore) UpdateUserTheme(ctx context.Context, userID string, theme string) (User, error) {
	theme = normalizeTheme(theme)
	if userID == "" || theme == "" {
		return User{}, ErrInvalidCredentials
	}
	var result User
	err := s.pool.QueryRow(ctx, `
		UPDATE users SET theme = $2
		WHERE user_id = $1
		RETURNING user_id, username, display_name, theme, avatar_file_id, avatar_mime_type, avatar_size, password_hash, totp_secret, totp_enabled, created_at
	`, userID, theme).
		Scan(&result.UserID, &result.Username, &result.DisplayName, &result.Theme, &result.AvatarFileID, &result.AvatarMimeType, &result.AvatarSize, &result.PasswordHash, &result.TOTPSecret, &result.TOTPEnabled, &result.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUserNotFound
	}
	return result, err
}

func (s *PostgresUserStore) UpdateUserAvatar(ctx context.Context, userID string, avatarFileID string, mimeType string, size int64) (User, error) {
	userID = strings.TrimSpace(userID)
	avatarFileID = strings.TrimSpace(avatarFileID)
	mimeType = strings.TrimSpace(mimeType)
	if userID == "" || avatarFileID == "" || mimeType == "" || size <= 0 {
		return User{}, ErrInvalidCredentials
	}
	var result User
	err := s.pool.QueryRow(ctx, `
		UPDATE users
		SET avatar_file_id = $2, avatar_mime_type = $3, avatar_size = $4
		WHERE user_id = $1
		RETURNING user_id, username, display_name, theme, avatar_file_id, avatar_mime_type, avatar_size, password_hash, totp_secret, totp_enabled, created_at
	`, userID, avatarFileID, mimeType, size).
		Scan(&result.UserID, &result.Username, &result.DisplayName, &result.Theme, &result.AvatarFileID, &result.AvatarMimeType, &result.AvatarSize, &result.PasswordHash, &result.TOTPSecret, &result.TOTPEnabled, &result.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUserNotFound
	}
	return result, err
}

func (s *PostgresUserStore) UpdateUserTOTP(ctx context.Context, userID string, secret string, enabled bool) (User, error) {
	userID = strings.TrimSpace(userID)
	secret = strings.TrimSpace(secret)
	if userID == "" {
		return User{}, ErrInvalidCredentials
	}
	var result User
	err := s.pool.QueryRow(ctx, `
		UPDATE users
		SET totp_secret = $2, totp_enabled = $3
		WHERE user_id = $1
		RETURNING user_id, username, display_name, theme, avatar_file_id, avatar_mime_type, avatar_size, password_hash, totp_secret, totp_enabled, created_at
	`, userID, secret, enabled).
		Scan(&result.UserID, &result.Username, &result.DisplayName, &result.Theme, &result.AvatarFileID, &result.AvatarMimeType, &result.AvatarSize, &result.PasswordHash, &result.TOTPSecret, &result.TOTPEnabled, &result.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUserNotFound
	}
	return result, err
}

func (s *PostgresUserStore) CreateSession(ctx context.Context, session Session) (Session, error) {
	if session.SessionID == "" || session.UserID == "" || session.RefreshTokenHash == "" || session.ExpiresAt.IsZero() {
		return Session{}, ErrInvalidCredentials
	}
	if session.CreatedAt.IsZero() {
		session.CreatedAt = time.Now().UTC()
	}
	var result Session
	err := s.pool.QueryRow(ctx, `
		INSERT INTO auth_sessions (session_id, user_id, username, refresh_token_hash, device_name, user_agent, ip_address, location, created_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING session_id, user_id, username, refresh_token_hash, device_name, user_agent, ip_address, location, created_at, expires_at, COALESCE(revoked_at, '0001-01-01T00:00:00Z'::timestamptz)
	`, session.SessionID, session.UserID, session.Username, session.RefreshTokenHash, session.DeviceName, session.UserAgent, session.IPAddress, session.Location, session.CreatedAt, session.ExpiresAt).
		Scan(&result.SessionID, &result.UserID, &result.Username, &result.RefreshTokenHash, &result.DeviceName, &result.UserAgent, &result.IPAddress, &result.Location, &result.CreatedAt, &result.ExpiresAt, &result.RevokedAt)
	return result, err
}

func (s *PostgresUserStore) UpdateSessionMetadata(ctx context.Context, userID string, sessionID string, deviceName string, userAgent string, ipAddress string, location string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE auth_sessions
		SET device_name = $3, user_agent = $4, ip_address = $5, location = $6
		WHERE user_id = $1 AND session_id = $2
	`, strings.TrimSpace(userID), strings.TrimSpace(sessionID), strings.TrimSpace(deviceName), strings.TrimSpace(userAgent), strings.TrimSpace(ipAddress), strings.TrimSpace(location))
	return err
}

func (s *PostgresUserStore) GetSession(ctx context.Context, sessionID string) (Session, error) {
	var result Session
	err := s.pool.QueryRow(ctx, `
		SELECT session_id, user_id, username, refresh_token_hash, device_name, user_agent, ip_address, location, created_at, expires_at, COALESCE(revoked_at, '0001-01-01T00:00:00Z'::timestamptz)
		FROM auth_sessions WHERE session_id = $1
	`, strings.TrimSpace(sessionID)).
		Scan(&result.SessionID, &result.UserID, &result.Username, &result.RefreshTokenHash, &result.DeviceName, &result.UserAgent, &result.IPAddress, &result.Location, &result.CreatedAt, &result.ExpiresAt, &result.RevokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrInvalidToken
	}
	return result, err
}

func (s *PostgresUserStore) RotateRefreshToken(ctx context.Context, sessionID string, oldHash string, newHash string, expiresAt time.Time) (Session, error) {
	var result Session
	err := s.pool.QueryRow(ctx, `
		UPDATE auth_sessions
		SET refresh_token_hash = $3, expires_at = $4
		WHERE session_id = $1 AND refresh_token_hash = $2 AND revoked_at IS NULL AND expires_at > now()
		RETURNING session_id, user_id, username, refresh_token_hash, device_name, user_agent, ip_address, location, created_at, expires_at, COALESCE(revoked_at, '0001-01-01T00:00:00Z'::timestamptz)
	`, strings.TrimSpace(sessionID), strings.TrimSpace(oldHash), strings.TrimSpace(newHash), expiresAt).
		Scan(&result.SessionID, &result.UserID, &result.Username, &result.RefreshTokenHash, &result.DeviceName, &result.UserAgent, &result.IPAddress, &result.Location, &result.CreatedAt, &result.ExpiresAt, &result.RevokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrInvalidToken
	}
	return result, err
}

func (s *PostgresUserStore) ListSessions(ctx context.Context, userID string) ([]Session, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT session_id, user_id, username, device_name, user_agent, ip_address, location, created_at, expires_at, COALESCE(revoked_at, '0001-01-01T00:00:00Z'::timestamptz)
		FROM auth_sessions
		WHERE user_id = $1 AND expires_at > now() AND revoked_at IS NULL
		ORDER BY created_at DESC
	`, strings.TrimSpace(userID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []Session
	for rows.Next() {
		var session Session
		if err := rows.Scan(&session.SessionID, &session.UserID, &session.Username, &session.DeviceName, &session.UserAgent, &session.IPAddress, &session.Location, &session.CreatedAt, &session.ExpiresAt, &session.RevokedAt); err != nil {
			return nil, err
		}
		result = append(result, session)
	}
	return result, rows.Err()
}

func (s *PostgresUserStore) RevokeSession(ctx context.Context, userID string, sessionID string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now())
		WHERE user_id = $1 AND session_id = $2
	`, strings.TrimSpace(userID), strings.TrimSpace(sessionID))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrInvalidToken
	}
	return nil
}

func (s *PostgresUserStore) RevokeOtherSessions(ctx context.Context, userID string, keepSessionID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now())
		WHERE user_id = $1 AND session_id <> $2 AND revoked_at IS NULL
	`, strings.TrimSpace(userID), strings.TrimSpace(keepSessionID))
	return err
}
