package zk

import (
	"context"
	"errors"
	"strings"

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
	s := &PostgresStore{pool: pool}
	if err := s.migrate(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return s, nil
}

func (s *PostgresStore) Close() {
	s.pool.Close()
}

const schema = `
CREATE TABLE IF NOT EXISTS identities (
	user_id             TEXT PRIMARY KEY,
	display_name        TEXT NOT NULL,
	identity_public_key TEXT NOT NULL,
	created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
	last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE identities ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS rooms (
	room_id    TEXT PRIMARY KEY,
	name       TEXT NOT NULL,
	room_secret TEXT NOT NULL DEFAULT '',
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_secret TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS room_members (
	room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
	user_id TEXT NOT NULL,
	PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
	id         TEXT PRIMARY KEY,
	room_id    TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
	sender_id  TEXT NOT NULL,
	ciphertext TEXT NOT NULL,
	nonce      TEXT NOT NULL,
	algorithm  TEXT NOT NULL,
	key_id     TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_room_created ON messages(room_id, created_at);
`

func (s *PostgresStore) migrate(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, schema)
	return err
}

func (s *PostgresStore) UpsertIdentity(ctx context.Context, identity Identity) (Identity, error) {
	identity.UserID = normalizeID(identity.UserID)
	identity.DisplayName = strings.TrimSpace(identity.DisplayName)
	identity.IdentityPublicKey = strings.TrimSpace(identity.IdentityPublicKey)
	if identity.UserID == "" || identity.DisplayName == "" || identity.IdentityPublicKey == "" {
		return Identity{}, ErrBadRequest
	}

	var result Identity
	err := s.pool.QueryRow(ctx, `
		INSERT INTO identities (user_id, display_name, identity_public_key)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE
			SET display_name        = EXCLUDED.display_name,
			    identity_public_key = EXCLUDED.identity_public_key,
			    last_seen_at        = now()
		RETURNING user_id, display_name, identity_public_key, created_at, last_seen_at
	`, identity.UserID, identity.DisplayName, identity.IdentityPublicKey).
		Scan(&result.UserID, &result.DisplayName, &result.IdentityPublicKey, &result.CreatedAt, &result.LastSeenAt)
	return result, err
}

func (s *PostgresStore) GetIdentity(ctx context.Context, userID string) (Identity, error) {
	var result Identity
	err := s.pool.QueryRow(ctx, `
		SELECT user_id, display_name, identity_public_key, created_at, last_seen_at
		FROM identities WHERE user_id = $1
	`, normalizeID(userID)).
		Scan(&result.UserID, &result.DisplayName, &result.IdentityPublicKey, &result.CreatedAt, &result.LastSeenAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Identity{}, ErrNotFound
	}
	return result, err
}

func (s *PostgresStore) TouchIdentity(ctx context.Context, userID string) (Identity, error) {
	var result Identity
	err := s.pool.QueryRow(ctx, `
		UPDATE identities SET last_seen_at = now()
		WHERE user_id = $1
		RETURNING user_id, display_name, identity_public_key, created_at, last_seen_at
	`, normalizeID(userID)).
		Scan(&result.UserID, &result.DisplayName, &result.IdentityPublicKey, &result.CreatedAt, &result.LastSeenAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Identity{}, ErrNotFound
	}
	return result, err
}

func (s *PostgresStore) CreateRoom(ctx context.Context, room Room) (Room, error) {
	room.RoomID = normalizeID(room.RoomID)
	room.Name = strings.TrimSpace(room.Name)
	room.Members = normalizeMembers(room.Members)
	if room.RoomID == "" {
		room.RoomID = newID()
	}
	requestedSecret := strings.TrimSpace(room.RoomSecret)
	room.RoomSecret = requestedSecret
	if room.RoomSecret == "" {
		room.RoomSecret = newRoomSecret()
	}
	if room.Name == "" || len(room.Members) == 0 {
		return Room{}, ErrBadRequest
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Room{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var existingSecret string
	err = tx.QueryRow(ctx, `SELECT room_secret FROM rooms WHERE room_id = $1`, room.RoomID).Scan(&existingSecret)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Room{}, err
	}
	if err == nil && existingSecret != "" && room.RoomSecret != existingSecret {
		return Room{}, ErrBadRequest
	}
	if err == nil && existingSecret == "" && requestedSecret == "" {
		return Room{}, ErrBadRequest
	}

	err = tx.QueryRow(ctx, `
		INSERT INTO rooms (room_id, name, room_secret)
		VALUES ($1, $2, $3)
		ON CONFLICT (room_id) DO UPDATE
			SET room_secret = CASE
				WHEN rooms.room_secret = '' AND EXCLUDED.room_secret <> '' THEN EXCLUDED.room_secret
				ELSE rooms.room_secret
			END
		RETURNING room_secret, created_at
	`, room.RoomID, room.Name, room.RoomSecret).Scan(&room.RoomSecret, &room.CreatedAt)
	if err != nil {
		return Room{}, err
	}

	for _, member := range room.Members {
		if _, err := tx.Exec(ctx, `
			INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)
			ON CONFLICT DO NOTHING
		`, room.RoomID, member); err != nil {
			return Room{}, err
		}
	}

	return room, tx.Commit(ctx)
}

func (s *PostgresStore) ListRooms(ctx context.Context, userID string) ([]Room, error) {
	userID = normalizeID(userID)

	var (
		rows pgx.Rows
		err  error
	)
	if userID == "" {
		rows, err = s.pool.Query(ctx,
			`SELECT room_id, name, room_secret, created_at FROM rooms ORDER BY created_at DESC`)
	} else {
		rows, err = s.pool.Query(ctx, `
			SELECT r.room_id, r.name, r.room_secret, r.created_at
			FROM rooms r
			JOIN room_members rm ON rm.room_id = r.room_id AND rm.user_id = $1
			ORDER BY r.created_at DESC
		`, userID)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	rooms := []Room{}
	roomIDs := []string{}
	byID := map[string]*Room{}

	for rows.Next() {
		var r Room
		if err := rows.Scan(&r.RoomID, &r.Name, &r.RoomSecret, &r.CreatedAt); err != nil {
			return nil, err
		}
		r.Members = []string{}
		rooms = append(rooms, r)
		roomIDs = append(roomIDs, r.RoomID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	if len(rooms) == 0 {
		return rooms, nil
	}
	for i := range rooms {
		byID[rooms[i].RoomID] = &rooms[i]
	}

	mRows, err := s.pool.Query(ctx,
		`SELECT room_id, user_id FROM room_members WHERE room_id = ANY($1)`, roomIDs)
	if err != nil {
		return nil, err
	}
	defer mRows.Close()
	for mRows.Next() {
		var rid, uid string
		if err := mRows.Scan(&rid, &uid); err != nil {
			return nil, err
		}
		if r, ok := byID[rid]; ok {
			r.Members = append(r.Members, uid)
		}
	}
	return rooms, mRows.Err()
}

func (s *PostgresStore) LeaveRoom(ctx context.Context, roomID string, userID string) error {
	roomID = normalizeID(roomID)
	userID = normalizeID(userID)
	if roomID == "" || userID == "" {
		return ErrBadRequest
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM room_members WHERE room_id = $1 AND user_id = $2`, roomID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) AppendMessage(ctx context.Context, msg EncryptedMessage) (EncryptedMessage, error) {
	msg.RoomID = normalizeID(msg.RoomID)
	msg.SenderID = normalizeID(msg.SenderID)
	msg.Ciphertext = strings.TrimSpace(msg.Ciphertext)
	msg.Nonce = strings.TrimSpace(msg.Nonce)
	msg.Algorithm = strings.TrimSpace(msg.Algorithm)
	msg.KeyID = strings.TrimSpace(msg.KeyID)
	if msg.RoomID == "" || msg.SenderID == "" || msg.Ciphertext == "" || msg.Nonce == "" || msg.Algorithm == "" {
		return EncryptedMessage{}, ErrBadRequest
	}
	if msg.ID == "" {
		msg.ID = newID()
	}

	var exists bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM rooms WHERE room_id = $1)`, msg.RoomID,
	).Scan(&exists); err != nil {
		return EncryptedMessage{}, err
	}
	if !exists {
		return EncryptedMessage{}, ErrNotFound
	}

	var result EncryptedMessage
	err := s.pool.QueryRow(ctx, `
		INSERT INTO messages (id, room_id, sender_id, ciphertext, nonce, algorithm, key_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, room_id, sender_id, ciphertext, nonce, algorithm, key_id, created_at
	`, msg.ID, msg.RoomID, msg.SenderID, msg.Ciphertext, msg.Nonce, msg.Algorithm, msg.KeyID).
		Scan(&result.ID, &result.RoomID, &result.SenderID,
			&result.Ciphertext, &result.Nonce, &result.Algorithm, &result.KeyID,
			&result.CreatedAt)
	return result, err
}

func (s *PostgresStore) ListMessages(ctx context.Context, roomID string, limit int) ([]EncryptedMessage, error) {
	roomID = normalizeID(roomID)
	if limit <= 0 || limit > 500 {
		limit = 100
	}

	rows, err := s.pool.Query(ctx, `
		SELECT id, room_id, sender_id, ciphertext, nonce, algorithm, key_id, created_at FROM (
			SELECT id, room_id, sender_id, ciphertext, nonce, algorithm, key_id, created_at
			FROM messages WHERE room_id = $1
			ORDER BY created_at DESC LIMIT $2
		) recent
		ORDER BY created_at ASC
	`, roomID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	msgs := []EncryptedMessage{}
	for rows.Next() {
		var m EncryptedMessage
		if err := rows.Scan(
			&m.ID, &m.RoomID, &m.SenderID,
			&m.Ciphertext, &m.Nonce, &m.Algorithm, &m.KeyID,
			&m.CreatedAt,
		); err != nil {
			return nil, err
		}
		msgs = append(msgs, m)
	}
	return msgs, rows.Err()
}
