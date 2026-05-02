package auth

import (
	"context"
	"errors"
	"strings"

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
	created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'dark';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_file_id TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime_type TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_size BIGINT NOT NULL DEFAULT 0;
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
		RETURNING user_id, username, display_name, theme, avatar_file_id, avatar_mime_type, avatar_size, password_hash, created_at
	`, user.UserID, user.Username, user.DisplayName, user.Theme, user.PasswordHash).
		Scan(&result.UserID, &result.Username, &result.DisplayName, &result.Theme, &result.AvatarFileID, &result.AvatarMimeType, &result.AvatarSize, &result.PasswordHash, &result.CreatedAt)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return User{}, ErrUserExists
	}
	return result, err
}

func (s *PostgresUserStore) GetUserByUsername(ctx context.Context, username string) (User, error) {
	var result User
	err := s.pool.QueryRow(ctx, `
		SELECT user_id, username, display_name, theme, avatar_file_id, avatar_mime_type, avatar_size, password_hash, created_at
		FROM users WHERE username = $1
	`, normalizeUsername(username)).
		Scan(&result.UserID, &result.Username, &result.DisplayName, &result.Theme, &result.AvatarFileID, &result.AvatarMimeType, &result.AvatarSize, &result.PasswordHash, &result.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUserNotFound
	}
	return result, err
}

func (s *PostgresUserStore) GetUserByID(ctx context.Context, userID string) (User, error) {
	var result User
	err := s.pool.QueryRow(ctx, `
		SELECT user_id, username, display_name, theme, avatar_file_id, avatar_mime_type, avatar_size, password_hash, created_at
		FROM users WHERE user_id = $1
	`, strings.TrimSpace(userID)).
		Scan(&result.UserID, &result.Username, &result.DisplayName, &result.Theme, &result.AvatarFileID, &result.AvatarMimeType, &result.AvatarSize, &result.PasswordHash, &result.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUserNotFound
	}
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
		RETURNING user_id, username, display_name, theme, avatar_file_id, avatar_mime_type, avatar_size, password_hash, created_at
	`, userID, theme).
		Scan(&result.UserID, &result.Username, &result.DisplayName, &result.Theme, &result.AvatarFileID, &result.AvatarMimeType, &result.AvatarSize, &result.PasswordHash, &result.CreatedAt)
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
		RETURNING user_id, username, display_name, theme, avatar_file_id, avatar_mime_type, avatar_size, password_hash, created_at
	`, userID, avatarFileID, mimeType, size).
		Scan(&result.UserID, &result.Username, &result.DisplayName, &result.Theme, &result.AvatarFileID, &result.AvatarMimeType, &result.AvatarSize, &result.PasswordHash, &result.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUserNotFound
	}
	return result, err
}
