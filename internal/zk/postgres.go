package zk

import (
	"context"
	"database/sql"
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
		INSERT INTO room_reads (room_id, user_id, last_read_at)
		SELECT $1, $2, now()
		WHERE EXISTS(SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2)
		ON CONFLICT (room_id, user_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at
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

func (s *PostgresStore) ListMessages(ctx context.Context, roomID string, limit int) ([]EncryptedMessage, error) {
	roomID = normalizeID(roomID)
	if limit <= 0 || limit > 500 {
		limit = 100
	}

	rows, err := s.pool.Query(ctx, `
		WITH recent AS (
			SELECT id, room_id, sender_id, ciphertext, nonce, algorithm, key_id, created_at, edited_at, deleted_at
			FROM messages WHERE room_id = $1
			ORDER BY created_at DESC LIMIT $2
		)
		SELECT recent.id, recent.room_id, recent.sender_id, recent.ciphertext, recent.nonce,
		       recent.algorithm, recent.key_id, recent.created_at, recent.edited_at, recent.deleted_at,
		       COALESCE(reads.read_by, '') AS read_by,
		       COALESCE(reads.read_count, 0) >= GREATEST(member_counts.member_count - 1, 0) AS read
		FROM recent
		LEFT JOIN LATERAL (
			SELECT string_agg(rr.user_id, ',' ORDER BY rr.user_id) AS read_by,
			       COUNT(*) AS read_count
			FROM room_members rm
			JOIN room_reads rr ON rr.room_id = recent.room_id AND rr.user_id = rm.user_id
			WHERE rm.room_id = recent.room_id
			  AND rm.user_id <> recent.sender_id
			  AND rr.last_read_at >= recent.created_at
		) reads ON true
		LEFT JOIN LATERAL (
			SELECT COUNT(*) AS member_count FROM room_members WHERE room_id = recent.room_id
		) member_counts ON true
		ORDER BY recent.created_at ASC
	`, roomID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	msgs := []EncryptedMessage{}
	for rows.Next() {
		var m EncryptedMessage
		var readByCSV string
		var editedAt, deletedAt sql.NullTime
		if err := rows.Scan(
			&m.ID, &m.RoomID, &m.SenderID,
			&m.Ciphertext, &m.Nonce, &m.Algorithm, &m.KeyID,
			&m.CreatedAt, &editedAt, &deletedAt, &readByCSV, &m.Read,
		); err != nil {
			return nil, err
		}
		assignOptionalMessageTimes(&m, editedAt, deletedAt)
		if readByCSV != "" {
			m.ReadBy = strings.Split(readByCSV, ",")
		}
		msgs = append(msgs, m)
	}
	return msgs, rows.Err()
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
