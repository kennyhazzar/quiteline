package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

type MemoryUserStore struct {
	mu     sync.RWMutex
	byName map[string]User
}

func NewMemoryUserStore() *MemoryUserStore {
	return &MemoryUserStore{byName: make(map[string]User)}
}

func (s *MemoryUserStore) CreateUser(_ context.Context, user User) (User, error) {
	user.Username = normalizeUsername(user.Username)
	if user.Username == "" || user.PasswordHash == "" {
		return User{}, ErrInvalidCredentials
	}
	if user.UserID == "" {
		user.UserID = newUserID()
	}
	if user.CreatedAt.IsZero() {
		user.CreatedAt = time.Now().UTC()
	}
	user.Theme = normalizeThemeOrDefault(user.Theme)
	if user.DisplayName == "" {
		user.DisplayName = user.Username
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.byName[user.Username]; ok {
		return User{}, ErrUserExists
	}
	s.byName[user.Username] = user
	return user, nil
}

func (s *MemoryUserStore) GetUserByID(_ context.Context, userID string) (User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, user := range s.byName {
		if user.UserID == userID {
			return user, nil
		}
	}
	return User{}, ErrUserNotFound
}

func (s *MemoryUserStore) UpdateUserTheme(_ context.Context, userID string, theme string) (User, error) {
	theme = normalizeTheme(theme)
	if theme == "" {
		return User{}, ErrInvalidCredentials
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for username, user := range s.byName {
		if user.UserID == userID {
			user.Theme = theme
			s.byName[username] = user
			return user, nil
		}
	}
	return User{}, ErrUserNotFound
}

func (s *MemoryUserStore) UpdateUserAvatar(_ context.Context, userID string, avatarFileID string, mimeType string, size int64) (User, error) {
	if userID == "" || avatarFileID == "" || mimeType == "" || size <= 0 {
		return User{}, ErrInvalidCredentials
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for username, user := range s.byName {
		if user.UserID == userID {
			user.AvatarFileID = avatarFileID
			user.AvatarMimeType = mimeType
			user.AvatarSize = size
			s.byName[username] = user
			return user, nil
		}
	}
	return User{}, ErrUserNotFound
}

func (s *MemoryUserStore) GetUserByUsername(_ context.Context, username string) (User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	user, ok := s.byName[normalizeUsername(username)]
	if !ok {
		return User{}, ErrUserNotFound
	}
	return user, nil
}

func newUserID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(bytes[:])
}

type MemorySessionStore struct {
	mu       sync.RWMutex
	sessions map[string]Session
}

func NewMemorySessionStore() *MemorySessionStore {
	return &MemorySessionStore{sessions: make(map[string]Session)}
}

func (s *MemorySessionStore) CreateSession(_ context.Context, session Session) (Session, error) {
	if session.SessionID == "" || session.UserID == "" || session.ExpiresAt.IsZero() {
		return Session{}, ErrInvalidCredentials
	}
	if session.CreatedAt.IsZero() {
		session.CreatedAt = time.Now().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[session.SessionID] = session
	return session, nil
}

func (s *MemorySessionStore) GetSession(_ context.Context, sessionID string) (Session, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	session, ok := s.sessions[sessionID]
	if !ok {
		return Session{}, ErrInvalidToken
	}
	return session, nil
}

func (s *MemorySessionStore) ListSessions(_ context.Context, userID string) ([]Session, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]Session, 0)
	now := time.Now().UTC()
	for _, session := range s.sessions {
		if session.UserID == userID && session.RevokedAt.IsZero() && session.ExpiresAt.After(now) {
			result = append(result, session)
		}
	}
	return result, nil
}

func (s *MemorySessionStore) RevokeSession(_ context.Context, userID string, sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[sessionID]
	if !ok || session.UserID != userID {
		return ErrInvalidToken
	}
	if session.RevokedAt.IsZero() {
		session.RevokedAt = time.Now().UTC()
	}
	s.sessions[sessionID] = session
	return nil
}

func (s *MemorySessionStore) RevokeOtherSessions(_ context.Context, userID string, keepSessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	for sessionID, session := range s.sessions {
		if session.UserID == userID && sessionID != keepSessionID && session.RevokedAt.IsZero() {
			session.RevokedAt = now
			s.sessions[sessionID] = session
		}
	}
	return nil
}
