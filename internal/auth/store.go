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
