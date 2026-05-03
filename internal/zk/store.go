package zk

import (
	"context"
	"crypto/rand"
	"encoding/base64"
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
	ErrForbidden  = errors.New("forbidden")
)

type Identity struct {
	UserID            string    `json:"userId"`
	DisplayName       string    `json:"displayName"`
	IdentityPublicKey string    `json:"identityPublicKey"`
	CreatedAt         time.Time `json:"createdAt"`
	LastSeenAt        time.Time `json:"lastSeenAt"`
}

type Room struct {
	RoomID        string    `json:"roomId"`
	Name          string    `json:"name"`
	Members       []string  `json:"members"`
	RoomSecret    string    `json:"roomSecret,omitempty"`
	LastMessageAt time.Time `json:"lastMessageAt,omitempty"`
	UnreadCount   int       `json:"unreadCount,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
}

type Friend struct {
	UserID      string    `json:"userId"`
	DisplayName string    `json:"displayName"`
	Status      string    `json:"status"`
	Direction   string    `json:"direction"`
	CreatedAt   time.Time `json:"createdAt"`
}

type EncryptedMessage struct {
	ID           string        `json:"id"`
	RoomID       string        `json:"roomId"`
	SenderID     string        `json:"senderId"`
	Ciphertext   string        `json:"ciphertext"`
	Nonce        string        `json:"nonce"`
	Algorithm    string        `json:"algorithm"`
	KeyID        string        `json:"keyId"`
	CreatedAt    time.Time     `json:"createdAt"`
	EditedAt     *time.Time    `json:"editedAt,omitempty"`
	DeletedAt    *time.Time    `json:"deletedAt,omitempty"`
	ReadBy       []string      `json:"readBy,omitempty"`
	ReadReceipts []ReadReceipt `json:"readReceipts,omitempty"`
	Read         bool          `json:"read,omitempty"`
	Reactions    []Reaction    `json:"reactions,omitempty"`
}

type ReadReceipt struct {
	UserID string    `json:"userId"`
	ReadAt time.Time `json:"readAt"`
}

type Reaction struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
}

type Store interface {
	UpsertIdentity(ctx context.Context, identity Identity) (Identity, error)
	GetIdentity(ctx context.Context, userID string) (Identity, error)
	TouchIdentity(ctx context.Context, userID string) (Identity, error)
	CreateRoom(ctx context.Context, room Room) (Room, error)
	IsRoomMember(ctx context.Context, roomID string, userID string) (bool, error)
	ListRoomMembers(ctx context.Context, roomID string) ([]string, error)
	AddRoomMember(ctx context.Context, roomID string, userID string) error
	LeaveRoom(ctx context.Context, roomID string, userID string) error
	ListRooms(ctx context.Context, userID string) ([]Room, error)
	MarkRoomRead(ctx context.Context, roomID string, userID string) error
	AppendMessage(ctx context.Context, msg EncryptedMessage) (EncryptedMessage, error)
	UpdateMessage(ctx context.Context, roomID string, messageID string, userID string, msg EncryptedMessage) (EncryptedMessage, error)
	DeleteMessageForAll(ctx context.Context, roomID string, messageID string, userID string) (EncryptedMessage, error)
	ToggleMessageReaction(ctx context.Context, roomID string, messageID string, userID string, emoji string) (EncryptedMessage, error)
	ListMessages(ctx context.Context, roomID string, limit int) ([]EncryptedMessage, error)
	ListFriends(ctx context.Context, userID string) ([]Friend, error)
	RequestFriend(ctx context.Context, fromUserID string, toUserID string) error
	RespondFriend(ctx context.Context, userID string, friendID string, accept bool) error
	AreFriends(ctx context.Context, userID string, friendID string) (bool, error)
}

type MemoryStore struct {
	mu           sync.RWMutex
	identities   map[string]Identity
	rooms        map[string]Room
	messages     map[string][]EncryptedMessage
	reactions    map[string]map[string]string
	roomReads    map[string]map[string]time.Time
	messageReads map[string]map[string]time.Time
	friends      map[string]friendEdge
}

type friendEdge struct {
	UserA     string
	UserB     string
	Requester string
	Status    string
	CreatedAt time.Time
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		identities:   make(map[string]Identity),
		rooms:        make(map[string]Room),
		messages:     make(map[string][]EncryptedMessage),
		reactions:    make(map[string]map[string]string),
		roomReads:    make(map[string]map[string]time.Time),
		messageReads: make(map[string]map[string]time.Time),
		friends:      make(map[string]friendEdge),
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
	requestedSecret := strings.TrimSpace(room.RoomSecret)
	room.RoomSecret = requestedSecret
	if room.RoomSecret == "" {
		room.RoomSecret = newRoomSecret()
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
		if existing.RoomSecret != "" && room.RoomSecret != existing.RoomSecret {
			return Room{}, ErrBadRequest
		}
		if existing.RoomSecret == "" && requestedSecret == "" {
			return Room{}, ErrBadRequest
		}
		if existing.RoomSecret == "" && room.RoomSecret != "" {
			existing.RoomSecret = room.RoomSecret
		}
		for _, member := range room.Members {
			if !hasMember(existing.Members, member) {
				existing.Members = append(existing.Members, member)
			}
		}
		sort.Strings(existing.Members)
		s.rooms[room.RoomID] = existing
		return existing, nil
	}
	s.rooms[room.RoomID] = room
	return room, nil
}

func (s *MemoryStore) IsRoomMember(_ context.Context, roomID string, userID string) (bool, error) {
	roomID = normalizeID(roomID)
	userID = normalizeID(userID)
	if roomID == "" || userID == "" {
		return false, ErrBadRequest
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	room, ok := s.rooms[roomID]
	if !ok {
		return false, ErrNotFound
	}
	return hasMember(room.Members, userID), nil
}

func (s *MemoryStore) ListRoomMembers(_ context.Context, roomID string) ([]string, error) {
	roomID = normalizeID(roomID)
	if roomID == "" {
		return nil, ErrBadRequest
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	room, ok := s.rooms[roomID]
	if !ok {
		return nil, ErrNotFound
	}
	members := append([]string(nil), room.Members...)
	sort.Strings(members)
	return members, nil
}

func (s *MemoryStore) AddRoomMember(_ context.Context, roomID string, userID string) error {
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
	if !hasMember(room.Members, userID) {
		room.Members = append(room.Members, userID)
		sort.Strings(room.Members)
		s.rooms[roomID] = room
	}
	return nil
}

func (s *MemoryStore) ListRooms(_ context.Context, userID string) ([]Room, error) {
	userID = normalizeID(userID)
	s.mu.RLock()
	defer s.mu.RUnlock()

	rooms := make([]Room, 0)
	for _, room := range s.rooms {
		if userID == "" || hasMember(room.Members, userID) {
			room.LastMessageAt = s.lastMessageAt(room.RoomID)
			room.UnreadCount = s.unreadCount(room.RoomID, userID)
			rooms = append(rooms, room)
		}
	}
	sort.Slice(rooms, func(i, j int) bool {
		left := rooms[i].LastMessageAt
		if left.IsZero() {
			left = rooms[i].CreatedAt
		}
		right := rooms[j].LastMessageAt
		if right.IsZero() {
			right = rooms[j].CreatedAt
		}
		return left.After(right)
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
	if err := validateMessagePayload(msg); err != nil {
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

func (s *MemoryStore) UpdateMessage(_ context.Context, roomID string, messageID string, userID string, msg EncryptedMessage) (EncryptedMessage, error) {
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

	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.messages[roomID] {
		current := &s.messages[roomID][i]
		if current.ID != messageID {
			continue
		}
		if current.SenderID != userID {
			return EncryptedMessage{}, ErrForbidden
		}
		if current.DeletedAt != nil {
			return EncryptedMessage{}, ErrBadRequest
		}
		current.Ciphertext = msg.Ciphertext
		current.Nonce = msg.Nonce
		current.Algorithm = msg.Algorithm
		current.KeyID = msg.KeyID
		now := time.Now().UTC()
		current.EditedAt = &now
		result := *current
		s.decorateReadState(&result)
		return result, nil
	}
	return EncryptedMessage{}, ErrNotFound
}

func (s *MemoryStore) DeleteMessageForAll(_ context.Context, roomID string, messageID string, userID string) (EncryptedMessage, error) {
	roomID = normalizeID(roomID)
	messageID = normalizeID(messageID)
	userID = normalizeID(userID)
	if roomID == "" || messageID == "" || userID == "" {
		return EncryptedMessage{}, ErrBadRequest
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.messages[roomID] {
		current := &s.messages[roomID][i]
		if current.ID != messageID {
			continue
		}
		if current.SenderID != userID {
			return EncryptedMessage{}, ErrForbidden
		}
		now := time.Now().UTC()
		current.DeletedAt = &now
		result := *current
		s.decorateReadState(&result)
		return result, nil
	}
	return EncryptedMessage{}, ErrNotFound
}

func (s *MemoryStore) ToggleMessageReaction(_ context.Context, roomID string, messageID string, userID string, emoji string) (EncryptedMessage, error) {
	roomID = normalizeID(roomID)
	messageID = normalizeID(messageID)
	userID = normalizeID(userID)
	emoji = strings.TrimSpace(emoji)
	if roomID == "" || messageID == "" || userID == "" || emoji == "" || len([]rune(emoji)) > 8 {
		return EncryptedMessage{}, ErrBadRequest
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	for _, current := range s.messages[roomID] {
		if current.ID != messageID {
			continue
		}
		if current.DeletedAt != nil {
			return EncryptedMessage{}, ErrBadRequest
		}
		if s.reactions[messageID] == nil {
			s.reactions[messageID] = make(map[string]string)
		}
		if s.reactions[messageID][userID] == emoji {
			delete(s.reactions[messageID], userID)
		} else {
			s.reactions[messageID][userID] = emoji
		}
		result := current
		s.decorateReadState(&result)
		s.decorateReactions(&result)
		return result, nil
	}
	return EncryptedMessage{}, ErrNotFound
}

func validateMessagePayload(msg EncryptedMessage) error {
	if msg.RoomID == "" || msg.SenderID == "" || msg.Ciphertext == "" || msg.Algorithm == "" {
		return ErrBadRequest
	}
	if msg.Nonce == "" && !allowsEmptyNonce(msg.Algorithm) {
		return ErrBadRequest
	}
	return nil
}

func allowsEmptyNonce(algorithm string) bool {
	return strings.HasPrefix(algorithm, "PLAIN-")
}

func (s *MemoryStore) MarkRoomRead(_ context.Context, roomID string, userID string) error {
	roomID = normalizeID(roomID)
	userID = normalizeID(userID)
	if roomID == "" || userID == "" {
		return ErrBadRequest
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.rooms[roomID]; !ok {
		return ErrNotFound
	}
	if s.roomReads[roomID] == nil {
		s.roomReads[roomID] = make(map[string]time.Time)
	}
	now := time.Now().UTC()
	s.roomReads[roomID][userID] = now
	for _, msg := range s.messages[roomID] {
		if msg.SenderID == userID || msg.DeletedAt != nil {
			continue
		}
		if s.messageReads[msg.ID] == nil {
			s.messageReads[msg.ID] = make(map[string]time.Time)
		}
		s.messageReads[msg.ID][userID] = now
	}
	return nil
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
	for i := range result {
		s.decorateReadState(&result[i])
	}
	return result, nil
}

func (s *MemoryStore) decorateReadState(msg *EncryptedMessage) {
	room, ok := s.rooms[msg.RoomID]
	if !ok {
		return
	}
	reads := s.roomReads[msg.RoomID]
	readBy := make([]string, 0, len(room.Members))
	receipts := make([]ReadReceipt, 0, len(room.Members))
	for _, memberID := range room.Members {
		memberID = normalizeID(memberID)
		if memberID == "" || memberID == msg.SenderID {
			continue
		}
		readAt, ok := s.messageReads[msg.ID][memberID]
		if !ok {
			readAt, ok = reads[memberID]
		}
		if ok && !readAt.Before(msg.CreatedAt) {
			readBy = append(readBy, memberID)
			receipts = append(receipts, ReadReceipt{UserID: memberID, ReadAt: readAt})
		}
	}
	sort.Strings(readBy)
	sort.Slice(receipts, func(i, j int) bool {
		if receipts[i].ReadAt.Equal(receipts[j].ReadAt) {
			return receipts[i].UserID < receipts[j].UserID
		}
		return receipts[i].ReadAt.Before(receipts[j].ReadAt)
	})
	msg.ReadBy = readBy
	msg.ReadReceipts = receipts
	msg.Read = len(readBy) >= max(len(room.Members)-1, 0)
	s.decorateReactions(msg)
}

func (s *MemoryStore) decorateReactions(msg *EncryptedMessage) {
	counts := map[string]int{}
	for _, emoji := range s.reactions[msg.ID] {
		counts[emoji]++
	}
	reactions := make([]Reaction, 0, len(counts))
	for emoji, count := range counts {
		reactions = append(reactions, Reaction{Emoji: emoji, Count: count})
	}
	sort.Slice(reactions, func(i, j int) bool {
		return reactions[i].Emoji < reactions[j].Emoji
	})
	msg.Reactions = reactions
}

func (s *MemoryStore) ListFriends(_ context.Context, userID string) ([]Friend, error) {
	userID = normalizeID(userID)
	if userID == "" {
		return nil, ErrBadRequest
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := []Friend{}
	for _, edge := range s.friends {
		if edge.UserA != userID && edge.UserB != userID {
			continue
		}
		friendID := edge.UserB
		if friendID == userID {
			friendID = edge.UserA
		}
		identity := s.identities[friendID]
		direction := "incoming"
		if edge.Requester == userID {
			direction = "outgoing"
		}
		result = append(result, Friend{
			UserID: friendID, DisplayName: identity.DisplayName, Status: edge.Status, Direction: direction, CreatedAt: edge.CreatedAt,
		})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt.After(result[j].CreatedAt) })
	return result, nil
}

func (s *MemoryStore) RequestFriend(_ context.Context, fromUserID string, toUserID string) error {
	fromUserID = normalizeID(fromUserID)
	toUserID = normalizeID(toUserID)
	if fromUserID == "" || toUserID == "" || fromUserID == toUserID {
		return ErrBadRequest
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := friendKey(fromUserID, toUserID)
	if existing, ok := s.friends[key]; ok {
		if existing.Status == "pending" && existing.Requester != fromUserID {
			existing.Status = "accepted"
			s.friends[key] = existing
		}
		return nil
	}
	a, b := orderedPair(fromUserID, toUserID)
	s.friends[key] = friendEdge{UserA: a, UserB: b, Requester: fromUserID, Status: "pending", CreatedAt: time.Now().UTC()}
	return nil
}

func (s *MemoryStore) RespondFriend(_ context.Context, userID string, friendID string, accept bool) error {
	userID = normalizeID(userID)
	friendID = normalizeID(friendID)
	if userID == "" || friendID == "" {
		return ErrBadRequest
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := friendKey(userID, friendID)
	edge, ok := s.friends[key]
	if !ok {
		return ErrNotFound
	}
	if edge.Requester == userID {
		return ErrBadRequest
	}
	if accept {
		edge.Status = "accepted"
		s.friends[key] = edge
	} else {
		delete(s.friends, key)
	}
	return nil
}

func (s *MemoryStore) AreFriends(_ context.Context, userID string, friendID string) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	edge, ok := s.friends[friendKey(userID, friendID)]
	return ok && edge.Status == "accepted", nil
}

func (s *MemoryStore) lastMessageAt(roomID string) time.Time {
	messages := s.messages[roomID]
	if len(messages) == 0 {
		return time.Time{}
	}
	return messages[len(messages)-1].CreatedAt
}

func (s *MemoryStore) unreadCount(roomID string, userID string) int {
	if userID == "" {
		return 0
	}
	readAt := s.roomReads[roomID][userID]
	count := 0
	for _, msg := range s.messages[roomID] {
		if msg.SenderID != userID && (readAt.IsZero() || msg.CreatedAt.After(readAt)) {
			count++
		}
	}
	return count
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

func newRoomSecret() string {
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return newID() + newID()
	}
	return base64.RawURLEncoding.EncodeToString(bytes[:])
}

func friendKey(a string, b string) string {
	left, right := orderedPair(a, b)
	return left + ":" + right
}

func orderedPair(a string, b string) (string, string) {
	if a < b {
		return a, b
	}
	return b, a
}
