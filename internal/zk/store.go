package zk

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"highload-ws-pubsub/internal/message"
)

var (
	ErrNotFound   = errors.New("not found")
	ErrBadRequest = errors.New("bad request")
)

type Identity struct {
	UserID            string    `json:"userId"`
	DisplayName       string    `json:"displayName"`
	IdentityPublicKey string    `json:"identityPublicKey"`
	CreatedAt         time.Time `json:"createdAt"`
	LastSeenAt        time.Time `json:"lastSeenAt"`
}

type Room struct {
	RoomID    string    `json:"roomId"`
	Name      string    `json:"name"`
	Members   []string  `json:"members"`
	CreatedAt time.Time `json:"createdAt"`
}

type EncryptedMessage struct {
	ID         string    `json:"id"`
	RoomID     string    `json:"roomId"`
	SenderID   string    `json:"senderId"`
	Ciphertext string    `json:"ciphertext"`
	Nonce      string    `json:"nonce"`
	Algorithm  string    `json:"algorithm"`
	KeyID      string    `json:"keyId"`
	CreatedAt  time.Time `json:"createdAt"`
}

type Store interface {
	UpsertIdentity(ctx context.Context, identity Identity) (Identity, error)
	GetIdentity(ctx context.Context, userID string) (Identity, error)
	TouchIdentity(ctx context.Context, userID string) (Identity, error)
	CreateRoom(ctx context.Context, room Room) (Room, error)
	LeaveRoom(ctx context.Context, roomID string, userID string) error
	ListRooms(ctx context.Context, userID string) ([]Room, error)
	AppendMessage(ctx context.Context, msg EncryptedMessage) (EncryptedMessage, error)
	ListMessages(ctx context.Context, roomID string, limit int) ([]EncryptedMessage, error)
}

type MemoryStore struct {
	mu         sync.RWMutex
	identities map[string]Identity
	rooms      map[string]Room
	messages   map[string][]EncryptedMessage
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		identities: make(map[string]Identity),
		rooms:      make(map[string]Room),
		messages:   make(map[string][]EncryptedMessage),
	}
}

func (s *MemoryStore) UpsertIdentity(_ context.Context, identity Identity) (Identity, error) {
	identity.UserID = normalizeID(identity.UserID)
	identity.DisplayName = strings.TrimSpace(identity.DisplayName)
	identity.IdentityPublicKey = strings.TrimSpace(identity.IdentityPublicKey)
	if identity.UserID == "" || identity.DisplayName == "" || identity.IdentityPublicKey == "" {
		return Identity{}, ErrBadRequest
	}
	if identity.CreatedAt.IsZero() {
		identity.CreatedAt = time.Now().UTC()
	}
	if identity.LastSeenAt.IsZero() {
		identity.LastSeenAt = time.Now().UTC()
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.identities[identity.UserID]; ok {
		identity.CreatedAt = existing.CreatedAt
		if existing.LastSeenAt.After(identity.LastSeenAt) {
			identity.LastSeenAt = existing.LastSeenAt
		}
	}
	s.identities[identity.UserID] = identity
	return identity, nil
}

func (s *MemoryStore) GetIdentity(_ context.Context, userID string) (Identity, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	identity, ok := s.identities[normalizeID(userID)]
	if !ok {
		return Identity{}, ErrNotFound
	}
	return identity, nil
}

func (s *MemoryStore) TouchIdentity(_ context.Context, userID string) (Identity, error) {
	userID = normalizeID(userID)
	s.mu.Lock()
	defer s.mu.Unlock()
	identity, ok := s.identities[userID]
	if !ok {
		return Identity{}, ErrNotFound
	}
	identity.LastSeenAt = time.Now().UTC()
	s.identities[userID] = identity
	return identity, nil
}

func (s *MemoryStore) CreateRoom(_ context.Context, room Room) (Room, error) {
	room.RoomID = normalizeID(room.RoomID)
	room.Name = strings.TrimSpace(room.Name)
	room.Members = normalizeMembers(room.Members)
	if room.RoomID == "" {
		room.RoomID = newID()
	}
	if room.Name == "" || len(room.Members) == 0 {
		return Room{}, ErrBadRequest
	}
	if room.CreatedAt.IsZero() {
		room.CreatedAt = time.Now().UTC()
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.rooms[room.RoomID]; ok {
		return existing, nil
	}
	s.rooms[room.RoomID] = room
	return room, nil
}

func (s *MemoryStore) ListRooms(_ context.Context, userID string) ([]Room, error) {
	userID = normalizeID(userID)
	s.mu.RLock()
	defer s.mu.RUnlock()

	rooms := make([]Room, 0)
	for _, room := range s.rooms {
		if userID == "" || hasMember(room.Members, userID) {
			rooms = append(rooms, room)
		}
	}
	sort.Slice(rooms, func(i, j int) bool {
		return rooms[i].CreatedAt.After(rooms[j].CreatedAt)
	})
	return rooms, nil
}

func (s *MemoryStore) LeaveRoom(_ context.Context, roomID string, userID string) error {
	roomID = normalizeID(roomID)
	userID = normalizeID(userID)
	if roomID == "" || userID == "" {
		return ErrBadRequest
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	room, ok := s.rooms[roomID]
	if !ok {
		return ErrNotFound
	}
	nextMembers := make([]string, 0, len(room.Members))
	for _, member := range room.Members {
		if member != userID {
			nextMembers = append(nextMembers, member)
		}
	}
	room.Members = nextMembers
	s.rooms[roomID] = room
	return nil
}

func (s *MemoryStore) AppendMessage(_ context.Context, msg EncryptedMessage) (EncryptedMessage, error) {
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
	if msg.CreatedAt.IsZero() {
		msg.CreatedAt = time.Now().UTC()
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.rooms[msg.RoomID]; !ok {
		return EncryptedMessage{}, ErrNotFound
	}
	s.messages[msg.RoomID] = append(s.messages[msg.RoomID], msg)
	return msg, nil
}

func (s *MemoryStore) ListMessages(_ context.Context, roomID string, limit int) ([]EncryptedMessage, error) {
	roomID = normalizeID(roomID)
	if limit <= 0 || limit > 500 {
		limit = 100
	}

	s.mu.RLock()
	defer s.mu.RUnlock()
	messages := s.messages[roomID]
	if len(messages) > limit {
		messages = messages[len(messages)-limit:]
	}
	result := make([]EncryptedMessage, len(messages))
	copy(result, messages)
	return result, nil
}

func Envelope(msg EncryptedMessage, source string) message.Envelope {
	return message.New("room:"+msg.RoomID, mustJSON(msg), source)
}

func normalizeMembers(members []string) []string {
	seen := make(map[string]struct{}, len(members))
	result := make([]string, 0, len(members))
	for _, member := range members {
		member = normalizeID(member)
		if member == "" {
			continue
		}
		if _, ok := seen[member]; ok {
			continue
		}
		seen[member] = struct{}{}
		result = append(result, member)
	}
	sort.Strings(result)
	return result
}

func normalizeID(value string) string {
	value = strings.TrimSpace(value)
	value = strings.Trim(value, "/")
	if strings.ContainsAny(value, " \t\r\n") {
		return ""
	}
	return value
}

func hasMember(members []string, userID string) bool {
	for _, member := range members {
		if member == userID {
			return true
		}
	}
	return false
}

func newID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(bytes[:])
}
