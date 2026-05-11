package notifications

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"sync"
	"time"
)

type Preferences struct {
	Messages bool `json:"messages"`
	Chats    bool `json:"chats"`
	Sessions bool `json:"sessions"`
	Friends  bool `json:"friends"`
}

func DefaultPreferences() Preferences {
	return Preferences{Messages: true, Chats: true, Sessions: true, Friends: true}
}

type Subscription struct {
	ID          string      `json:"id"`
	UserID      string      `json:"userId"`
	Endpoint    string      `json:"endpoint"`
	P256DH      string      `json:"p256dh"`
	Auth        string      `json:"auth"`
	UserAgent   string      `json:"userAgent,omitempty"`
	Preferences Preferences `json:"preferences"`
	CreatedAt   time.Time   `json:"createdAt"`
	LastUsedAt  time.Time   `json:"lastUsedAt,omitempty"`
	RevokedAt   time.Time   `json:"revokedAt,omitempty"`
}

type Store interface {
	Save(ctx context.Context, sub Subscription) (Subscription, error)
	ListByUser(ctx context.Context, userID string) ([]Subscription, error)
	UpdatePreferences(ctx context.Context, userID string, id string, prefs Preferences) (Subscription, error)
	Delete(ctx context.Context, userID string, id string) error
	Touch(ctx context.Context, id string) error
}

type MemoryStore struct {
	mu   sync.RWMutex
	subs map[string]Subscription
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{subs: make(map[string]Subscription)}
}

func (s *MemoryStore) Save(_ context.Context, sub Subscription) (Subscription, error) {
	sub = normalizeSubscription(sub)
	if sub.ID == "" || sub.UserID == "" || sub.Endpoint == "" || sub.P256DH == "" || sub.Auth == "" {
		return Subscription{}, ErrBadRequest
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.subs[sub.ID]; ok {
		sub.CreatedAt = existing.CreatedAt
		sub.LastUsedAt = existing.LastUsedAt
	}
	if sub.CreatedAt.IsZero() {
		sub.CreatedAt = time.Now().UTC()
	}
	s.subs[sub.ID] = sub
	return sub, nil
}

func (s *MemoryStore) ListByUser(_ context.Context, userID string) ([]Subscription, error) {
	userID = strings.TrimSpace(userID)
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := []Subscription{}
	for _, sub := range s.subs {
		if sub.UserID == userID && sub.RevokedAt.IsZero() {
			result = append(result, sub)
		}
	}
	return result, nil
}

func (s *MemoryStore) UpdatePreferences(_ context.Context, userID string, id string, prefs Preferences) (Subscription, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sub, ok := s.subs[strings.TrimSpace(id)]
	if !ok || sub.UserID != strings.TrimSpace(userID) || !sub.RevokedAt.IsZero() {
		return Subscription{}, ErrNotFound
	}
	sub.Preferences = prefs
	s.subs[sub.ID] = sub
	return sub, nil
}

func (s *MemoryStore) Delete(_ context.Context, userID string, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sub, ok := s.subs[strings.TrimSpace(id)]
	if !ok || sub.UserID != strings.TrimSpace(userID) {
		return ErrNotFound
	}
	sub.RevokedAt = time.Now().UTC()
	s.subs[sub.ID] = sub
	return nil
}

func (s *MemoryStore) Touch(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sub, ok := s.subs[strings.TrimSpace(id)]
	if !ok {
		return ErrNotFound
	}
	sub.LastUsedAt = time.Now().UTC()
	s.subs[sub.ID] = sub
	return nil
}

func normalizeSubscription(sub Subscription) Subscription {
	sub.UserID = strings.TrimSpace(sub.UserID)
	sub.Endpoint = strings.TrimSpace(sub.Endpoint)
	sub.P256DH = strings.TrimSpace(sub.P256DH)
	sub.Auth = strings.TrimSpace(sub.Auth)
	sub.UserAgent = strings.TrimSpace(sub.UserAgent)
	if sub.ID == "" && sub.UserID != "" && sub.Endpoint != "" {
		sum := sha256.Sum256([]byte(sub.UserID + ":" + sub.Endpoint))
		sub.ID = hex.EncodeToString(sum[:16])
	}
	if !sub.Preferences.Messages && !sub.Preferences.Chats && !sub.Preferences.Sessions && !sub.Preferences.Friends {
		sub.Preferences = DefaultPreferences()
	}
	return sub
}
