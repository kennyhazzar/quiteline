package zk

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
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

CREATE TABLE IF NOT EXISTS room_reads (
	room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
	user_id TEXT NOT NULL,
	last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
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
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	edited_at  TIMESTAMPTZ,
	deleted_at TIMESTAMPTZ
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS messages_room_created ON messages(room_id, created_at);

CREATE TABLE IF NOT EXISTS message_reads (
	message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
	room_id    TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
	user_id    TEXT NOT NULL,
	read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS message_reads_room_user_idx ON message_reads(room_id, user_id, read_at);

CREATE TABLE IF NOT EXISTS message_reactions (
	message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
	room_id    TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
	user_id    TEXT NOT NULL,
	emoji      TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS message_reactions_room_idx ON message_reactions(room_id);

CREATE TABLE IF NOT EXISTS friendships (
	user_a TEXT NOT NULL,
	user_b TEXT NOT NULL,
	requester_id TEXT NOT NULL,
	status TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (user_a, user_b)
);
CREATE INDEX IF NOT EXISTS friendships_user_a_idx ON friendships(user_a);
CREATE INDEX IF NOT EXISTS friendships_user_b_idx ON friendships(user_b);
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

func (s *PostgresStore) IsRoomMember(ctx context.Context, roomID string, userID string) (bool, error) {
	roomID = normalizeID(roomID)
	userID = normalizeID(userID)
	if roomID == "" || userID == "" {
		return false, ErrBadRequest
	}
	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2)`,
		roomID, userID,
	).Scan(&exists)
	return exists, err
}

func (s *PostgresStore) ListRoomMembers(ctx context.Context, roomID string) ([]string, error) {
	roomID = normalizeID(roomID)
	if roomID == "" {
		return nil, ErrBadRequest
	}
	rows, err := s.pool.Query(ctx, `SELECT user_id FROM room_members WHERE room_id = $1 ORDER BY user_id`, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := []string{}
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			return nil, err
		}
		members = append(members, userID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(members) == 0 {
		return nil, ErrNotFound
	}
	return members, nil
}

func (s *PostgresStore) AddRoomMember(ctx context.Context, roomID string, userID string) error {
	roomID = normalizeID(roomID)
	userID = normalizeID(userID)
	if roomID == "" || userID == "" {
		return ErrBadRequest
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO room_members (room_id, user_id)
		SELECT $1, $2 WHERE EXISTS(SELECT 1 FROM rooms WHERE room_id = $1)
		ON CONFLICT DO NOTHING
	`, roomID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM rooms WHERE room_id = $1)`, roomID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
	}
	return nil
}

func (s *PostgresStore) ListRooms(ctx context.Context, userID string) ([]Room, error) {
	userID = normalizeID(userID)

	var (
		rows pgx.Rows
		err  error
	)
	if userID == "" {
		rows, err = s.pool.Query(ctx,
			`SELECT r.room_id, r.name, r.room_secret, r.created_at,
			        lm.last_message_at,
			        0::bigint AS unread_count
			   FROM rooms r
			   LEFT JOIN (
			       SELECT room_id, max(created_at) AS last_message_at
			       FROM messages GROUP BY room_id
			   ) lm ON lm.room_id = r.room_id
			   ORDER BY COALESCE(lm.last_message_at, r.created_at) DESC`)
	} else {
		rows, err = s.pool.Query(ctx, `
			SELECT r.room_id, r.name, r.room_secret, r.created_at,
			       lm.last_message_at,
			       COALESCE(uc.unread_count, 0)
			FROM rooms r
			JOIN room_members rm ON rm.room_id = r.room_id AND rm.user_id = $1
			LEFT JOIN (
				SELECT room_id, max(created_at) AS last_message_at
				FROM messages GROUP BY room_id
			) lm ON lm.room_id = r.room_id
			LEFT JOIN room_reads rr ON rr.room_id = r.room_id AND rr.user_id = $1
			LEFT JOIN LATERAL (
				SELECT count(*) AS unread_count
				FROM messages m
				WHERE m.room_id = r.room_id
				  AND m.sender_id <> $1
				  AND m.deleted_at IS NULL
				  AND NOT EXISTS (
					SELECT 1 FROM message_reads mr
					WHERE mr.message_id = m.id AND mr.user_id = $1
				  )
				  AND (rr.last_read_at IS NULL OR m.created_at > rr.last_read_at)
			) uc ON true
			ORDER BY COALESCE(lm.last_message_at, r.created_at) DESC
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
		var lastMessageAt *time.Time
		if err := rows.Scan(&r.RoomID, &r.Name, &r.RoomSecret, &r.CreatedAt, &lastMessageAt, &r.UnreadCount); err != nil {
			return nil, err
		}
		if lastMessageAt != nil {
			r.LastMessageAt = *lastMessageAt
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

func (s *PostgresStore) MarkRoomRead(ctx context.Context, roomID string, userID string) error {
	roomID = normalizeID(roomID)
	userID = normalizeID(userID)
	if roomID == "" || userID == "" {
		return ErrBadRequest
	}
	tag, err := s.pool.Exec(ctx, `
		WITH member AS (
			SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2
		), mark_room AS (
			INSERT INTO room_reads (room_id, user_id, last_read_at)
			SELECT $1, $2, now() WHERE EXISTS(SELECT 1 FROM member)
			ON CONFLICT (room_id, user_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at
			RETURNING 1
		), mark_messages AS (
			INSERT INTO message_reads (message_id, room_id, user_id, read_at)
			SELECT m.id, m.room_id, $2, now()
			FROM messages m
			WHERE m.room_id = $1
			  AND m.sender_id <> $2
			  AND m.deleted_at IS NULL
			  AND EXISTS(SELECT 1 FROM member)
			ON CONFLICT (message_id, user_id) DO UPDATE SET read_at = EXCLUDED.read_at
			RETURNING 1
		)
		SELECT 1 FROM mark_room
	`, roomID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
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
	if err := validateMessagePayload(msg); err != nil {
		return EncryptedMessage{}, err
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
	var editedAt, deletedAt sql.NullTime
	err := s.pool.QueryRow(ctx, `
		INSERT INTO messages (id, room_id, sender_id, ciphertext, nonce, algorithm, key_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, room_id, sender_id, ciphertext, nonce, algorithm, key_id, created_at, edited_at, deleted_at
	`, msg.ID, msg.RoomID, msg.SenderID, msg.Ciphertext, msg.Nonce, msg.Algorithm, msg.KeyID).
		Scan(&result.ID, &result.RoomID, &result.SenderID,
			&result.Ciphertext, &result.Nonce, &result.Algorithm, &result.KeyID,
			&result.CreatedAt, &editedAt, &deletedAt)
	assignOptionalMessageTimes(&result, editedAt, deletedAt)
	return result, err
}

func (s *PostgresStore) UpdateMessage(ctx context.Context, roomID string, messageID string, userID string, msg EncryptedMessage) (EncryptedMessage, error) {
	roomID = normalizeID(roomID)
	messageID = normalizeID(messageID)
	userID = normalizeID(userID)
	msg.RoomID = roomID
	msg.SenderID = userID
	msg.Ciphertext = strings.TrimSpace(msg.Ciphertext)
	msg.Nonce = strings.TrimSpace(msg.Nonce)
	msg.Algorithm = strings.TrimSpace(msg.Algorithm)
	msg.KeyID = strings.TrimSpace(msg.KeyID)
	if messageID == "" {
		return EncryptedMessage{}, ErrBadRequest
	}
	if err := validateMessagePayload(msg); err != nil {
		return EncryptedMessage{}, err
	}

	var result EncryptedMessage
	var editedAt, deletedAt sql.NullTime
	err := s.pool.QueryRow(ctx, `
		UPDATE messages
		SET ciphertext = $4, nonce = $5, algorithm = $6, key_id = $7, edited_at = now()
		WHERE room_id = $1 AND id = $2 AND sender_id = $3 AND deleted_at IS NULL
		RETURNING id, room_id, sender_id, ciphertext, nonce, algorithm, key_id, created_at, edited_at, deleted_at
	`, roomID, messageID, userID, msg.Ciphertext, msg.Nonce, msg.Algorithm, msg.KeyID).
		Scan(&result.ID, &result.RoomID, &result.SenderID,
			&result.Ciphertext, &result.Nonce, &result.Algorithm, &result.KeyID,
			&result.CreatedAt, &editedAt, &deletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return EncryptedMessage{}, ErrNotFound
	}
	assignOptionalMessageTimes(&result, editedAt, deletedAt)
	return result, err
}

func (s *PostgresStore) DeleteMessageForAll(ctx context.Context, roomID string, messageID string, userID string) (EncryptedMessage, error) {
	roomID = normalizeID(roomID)
	messageID = normalizeID(messageID)
	userID = normalizeID(userID)
	if roomID == "" || messageID == "" || userID == "" {
		return EncryptedMessage{}, ErrBadRequest
	}

	var result EncryptedMessage
	var editedAt, deletedAt sql.NullTime
	err := s.pool.QueryRow(ctx, `
		UPDATE messages
		SET deleted_at = now()
		WHERE room_id = $1 AND id = $2 AND sender_id = $3
		RETURNING id, room_id, sender_id, ciphertext, nonce, algorithm, key_id, created_at, edited_at, deleted_at
	`, roomID, messageID, userID).
		Scan(&result.ID, &result.RoomID, &result.SenderID,
			&result.Ciphertext, &result.Nonce, &result.Algorithm, &result.KeyID,
			&result.CreatedAt, &editedAt, &deletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return EncryptedMessage{}, ErrNotFound
	}
	assignOptionalMessageTimes(&result, editedAt, deletedAt)
	return result, err
}

func (s *PostgresStore) ToggleMessageReaction(ctx context.Context, roomID string, messageID string, userID string, emoji string) (EncryptedMessage, error) {
	roomID = normalizeID(roomID)
	messageID = normalizeID(messageID)
	userID = normalizeID(userID)
	emoji = strings.TrimSpace(emoji)
	if roomID == "" || messageID == "" || userID == "" || emoji == "" || len([]rune(emoji)) > 8 {
		return EncryptedMessage{}, ErrBadRequest
	}

	var existing string
	err := s.pool.QueryRow(ctx, `
		SELECT emoji FROM message_reactions WHERE room_id = $1 AND message_id = $2 AND user_id = $3
	`, roomID, messageID, userID).Scan(&existing)
	switch {
	case err == nil && existing == emoji:
		_, err = s.pool.Exec(ctx, `DELETE FROM message_reactions WHERE room_id = $1 AND message_id = $2 AND user_id = $3`, roomID, messageID, userID)
	case err == nil:
		_, err = s.pool.Exec(ctx, `UPDATE message_reactions SET emoji = $4, created_at = now() WHERE room_id = $1 AND message_id = $2 AND user_id = $3`, roomID, messageID, userID, emoji)
	case errors.Is(err, pgx.ErrNoRows):
		_, err = s.pool.Exec(ctx, `
			INSERT INTO message_reactions (message_id, room_id, user_id, emoji)
			SELECT id, room_id, $3, $4 FROM messages WHERE room_id = $1 AND id = $2 AND deleted_at IS NULL
		`, roomID, messageID, userID, emoji)
	default:
		return EncryptedMessage{}, err
	}
	if err != nil {
		return EncryptedMessage{}, err
	}
	messages, err := s.ListMessages(ctx, roomID, 500, nil)
	if err != nil {
		return EncryptedMessage{}, err
	}
	for _, msg := range messages {
		if msg.ID == messageID {
			return msg, nil
		}
	}
	return EncryptedMessage{}, ErrNotFound
}

func assignOptionalMessageTimes(msg *EncryptedMessage, editedAt sql.NullTime, deletedAt sql.NullTime) {
	if editedAt.Valid {
		value := editedAt.Time
		msg.EditedAt = &value
	}
	if deletedAt.Valid {
		value := deletedAt.Time
		msg.DeletedAt = &value
	}
}

func (s *PostgresStore) ListMessages(ctx context.Context, roomID string, limit int, before *time.Time) ([]EncryptedMessage, error) {
	roomID = normalizeID(roomID)
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	var beforeValue any
	if before != nil {
		beforeValue = before.UTC()
	}

	rows, err := s.pool.Query(ctx, `
		WITH recent AS (
			SELECT id, room_id, sender_id, ciphertext, nonce, algorithm, key_id, created_at, edited_at, deleted_at
			FROM messages
			WHERE room_id = $1 AND ($3::timestamptz IS NULL OR created_at < $3)
			ORDER BY created_at DESC LIMIT $2
		)
		SELECT recent.id, recent.room_id, recent.sender_id, recent.ciphertext, recent.nonce,
		       recent.algorithm, recent.key_id, recent.created_at, recent.edited_at, recent.deleted_at,
		       COALESCE(reads.read_by, '') AS read_by,
		       COALESCE(reads.read_receipts, '[]') AS read_receipts,
		       COALESCE(reads.read_count, 0) >= GREATEST(member_counts.member_count - 1, 0) AS read,
		       COALESCE(reactions.summary, '') AS reactions
		FROM recent
		LEFT JOIN LATERAL (
			SELECT string_agg(reader.user_id, ',' ORDER BY reader.user_id) AS read_by,
			       COALESCE(json_agg(json_build_object('userId', reader.user_id, 'readAt', reader.read_at) ORDER BY reader.read_at, reader.user_id), '[]') AS read_receipts,
			       COUNT(*) AS read_count
			FROM (
				SELECT rm.user_id, COALESCE(mr.read_at, rr.last_read_at) AS read_at
				FROM room_members rm
				LEFT JOIN message_reads mr ON mr.room_id = recent.room_id AND mr.message_id = recent.id AND mr.user_id = rm.user_id
				LEFT JOIN room_reads rr ON rr.room_id = recent.room_id AND rr.user_id = rm.user_id AND rr.last_read_at >= recent.created_at
				WHERE rm.room_id = recent.room_id
				  AND rm.user_id <> recent.sender_id
				  AND COALESCE(mr.read_at, rr.last_read_at) IS NOT NULL
			) reader
		) reads ON true
		LEFT JOIN LATERAL (
			SELECT COUNT(*) AS member_count FROM room_members WHERE room_id = recent.room_id
		) member_counts ON true
		LEFT JOIN LATERAL (
			SELECT string_agg(emoji || ':' || count, ',' ORDER BY emoji) AS summary
			FROM (
				SELECT emoji, COUNT(*) AS count
				FROM message_reactions
				WHERE room_id = recent.room_id AND message_id = recent.id
				GROUP BY emoji
			) grouped
		) reactions ON true
		ORDER BY recent.created_at ASC
	`, roomID, limit, beforeValue)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	msgs := []EncryptedMessage{}
	for rows.Next() {
		var m EncryptedMessage
		var readByCSV, readReceiptsJSON, reactionsCSV string
		var editedAt, deletedAt sql.NullTime
		if err := rows.Scan(
			&m.ID, &m.RoomID, &m.SenderID,
			&m.Ciphertext, &m.Nonce, &m.Algorithm, &m.KeyID,
			&m.CreatedAt, &editedAt, &deletedAt, &readByCSV, &readReceiptsJSON, &m.Read, &reactionsCSV,
		); err != nil {
			return nil, err
		}
		assignOptionalMessageTimes(&m, editedAt, deletedAt)
		if readByCSV != "" {
			m.ReadBy = strings.Split(readByCSV, ",")
		}
		m.ReadReceipts = parseReadReceipts(readReceiptsJSON)
		m.Reactions = parseReactionSummary(reactionsCSV)
		msgs = append(msgs, m)
	}
	return msgs, rows.Err()
}

func (s *PostgresStore) ListAttachmentMessages(ctx context.Context, roomID string, limit int) ([]EncryptedMessage, error) {
	roomID = normalizeID(roomID)
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}

	rows, err := s.pool.Query(ctx, `
		SELECT id, room_id, sender_id, ciphertext, nonce, algorithm, key_id, created_at, edited_at, deleted_at
		FROM messages
		WHERE room_id = $1 AND deleted_at IS NULL AND algorithm = 'PLAIN-JSON-V1'
		ORDER BY created_at DESC
		LIMIT $2
	`, roomID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	msgs := make([]EncryptedMessage, 0)
	for rows.Next() {
		var m EncryptedMessage
		var editedAt, deletedAt sql.NullTime
		if err := rows.Scan(
			&m.ID, &m.RoomID, &m.SenderID,
			&m.Ciphertext, &m.Nonce, &m.Algorithm, &m.KeyID,
			&m.CreatedAt, &editedAt, &deletedAt,
		); err != nil {
			return nil, err
		}
		assignOptionalMessageTimes(&m, editedAt, deletedAt)
		if messageHasPlainAttachment(m) {
			msgs = append(msgs, m)
		}
	}
	return msgs, rows.Err()
}

func parseReadReceipts(value string) []ReadReceipt {
	if value == "" || value == "[]" {
		return nil
	}
	var receipts []ReadReceipt
	if err := json.Unmarshal([]byte(value), &receipts); err != nil {
		return nil
	}
	return receipts
}

func parseReactionSummary(value string) []Reaction {
	if value == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	result := make([]Reaction, 0, len(parts))
	for _, part := range parts {
		emoji, countText, ok := strings.Cut(part, ":")
		if !ok {
			continue
		}
		var count int
		_, _ = fmt.Sscanf(countText, "%d", &count)
		if emoji != "" && count > 0 {
			result = append(result, Reaction{Emoji: emoji, Count: count})
		}
	}
	return result
}

func (s *PostgresStore) ListFriends(ctx context.Context, userID string) ([]Friend, error) {
	userID = normalizeID(userID)
	if userID == "" {
		return nil, ErrBadRequest
	}
	rows, err := s.pool.Query(ctx, `
		SELECT CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END AS friend_id,
		       COALESCE(i.display_name, CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END) AS display_name,
		       f.status,
		       CASE WHEN f.requester_id = $1 THEN 'outgoing' ELSE 'incoming' END AS direction,
		       f.created_at
		FROM friendships f
		LEFT JOIN identities i ON i.user_id = CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END
		WHERE f.user_a = $1 OR f.user_b = $1
		ORDER BY f.created_at DESC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Friend{}
	for rows.Next() {
		var friend Friend
		if err := rows.Scan(&friend.UserID, &friend.DisplayName, &friend.Status, &friend.Direction, &friend.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, friend)
	}
	return result, rows.Err()
}

func (s *PostgresStore) RequestFriend(ctx context.Context, fromUserID string, toUserID string) error {
	fromUserID = normalizeID(fromUserID)
	toUserID = normalizeID(toUserID)
	if fromUserID == "" || toUserID == "" || fromUserID == toUserID {
		return ErrBadRequest
	}
	userA, userB := orderedPair(fromUserID, toUserID)
	_, err := s.pool.Exec(ctx, `
		INSERT INTO friendships (user_a, user_b, requester_id, status)
		VALUES ($1, $2, $3, 'pending')
		ON CONFLICT (user_a, user_b) DO UPDATE
		SET status = CASE
			WHEN friendships.status = 'pending' AND friendships.requester_id <> EXCLUDED.requester_id THEN 'accepted'
			ELSE friendships.status
		END
	`, userA, userB, fromUserID)
	return err
}

func (s *PostgresStore) RespondFriend(ctx context.Context, userID string, friendID string, accept bool) error {
	userID = normalizeID(userID)
	friendID = normalizeID(friendID)
	if userID == "" || friendID == "" {
		return ErrBadRequest
	}
	userA, userB := orderedPair(userID, friendID)
	if accept {
		tag, err := s.pool.Exec(ctx, `
			UPDATE friendships SET status = 'accepted'
			WHERE user_a = $1 AND user_b = $2 AND requester_id <> $3 AND status = 'pending'
		`, userA, userB, userID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	}
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM friendships
		WHERE user_a = $1 AND user_b = $2 AND requester_id <> $3 AND status = 'pending'
	`, userA, userB, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) AreFriends(ctx context.Context, userID string, friendID string) (bool, error) {
	userID = normalizeID(userID)
	friendID = normalizeID(friendID)
	if userID == "" || friendID == "" {
		return false, ErrBadRequest
	}
	userA, userB := orderedPair(userID, friendID)
	var exists bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2 AND status = 'accepted')
	`, userA, userB).Scan(&exists)
	return exists, err
}
