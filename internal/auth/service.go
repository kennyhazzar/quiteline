package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"highload-ws-pubsub/internal/config"

	"golang.org/x/crypto/bcrypt"
)

var (
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrInvalidToken       = errors.New("invalid token")
	ErrTokenExpired       = errors.New("token expired")
	ErrUserExists         = errors.New("user exists")
	ErrUserNotFound       = errors.New("user not found")
)

type Service struct {
	cfg   config.Config
	users UserStore
}

type Principal struct {
	ClientID    string   `json:"clientId"`
	UserID      string   `json:"userId,omitempty"`
	Username    string   `json:"username,omitempty"`
	DisplayName string   `json:"displayName,omitempty"`
	Theme       string   `json:"theme,omitempty"`
	AvatarURL   string   `json:"avatarUrl,omitempty"`
	Scopes      []string `json:"scopes"`
	Expires     int64    `json:"expires"`
}

type Claims struct {
	Subject  string   `json:"sub"`
	Issuer   string   `json:"iss"`
	Issued   int64    `json:"iat"`
	Expires  int64    `json:"exp"`
	Scopes   []string `json:"scopes"`
	Username string   `json:"username,omitempty"`
	Theme    string   `json:"theme,omitempty"`
}

type User struct {
	UserID         string    `json:"userId"`
	Username       string    `json:"username"`
	DisplayName    string    `json:"displayName"`
	Theme          string    `json:"theme"`
	AvatarFileID   string    `json:"avatarFileId,omitempty"`
	AvatarMimeType string    `json:"avatarMimeType,omitempty"`
	AvatarSize     int64     `json:"avatarSize,omitempty"`
	PasswordHash   string    `json:"-"`
	CreatedAt      time.Time `json:"createdAt"`
}

type UserStore interface {
	CreateUser(ctx context.Context, user User) (User, error)
	GetUserByID(ctx context.Context, userID string) (User, error)
	GetUserByUsername(ctx context.Context, username string) (User, error)
	UpdateUserAvatar(ctx context.Context, userID string, avatarFileID string, mimeType string, size int64) (User, error)
	UpdateUserTheme(ctx context.Context, userID string, theme string) (User, error)
}

func NewService(cfg config.Config, users UserStore) *Service {
	if users == nil {
		users = NewMemoryUserStore()
	}
	return &Service{cfg: cfg, users: users}
}

func (s *Service) Enabled() bool {
	return s.cfg.AuthEnabled
}

func (s *Service) IssueToken(clientID, secret string) (string, Principal, error) {
	expected, ok := s.cfg.APIKeys[clientID]
	if !ok || subtle.ConstantTimeCompare([]byte(expected), []byte(secret)) != 1 {
		return "", Principal{}, ErrInvalidCredentials
	}

	now := time.Now().UTC()
	claims := Claims{
		Subject: clientID,
		Issuer:  s.cfg.AuthIssuer,
		Issued:  now.Unix(),
		Expires: now.Add(s.cfg.AuthTokenTTL).Unix(),
		Scopes:  []string{"publish", "subscribe", "topics:read"},
	}
	token, err := s.sign(claims)
	if err != nil {
		return "", Principal{}, err
	}

	return token, Principal{ClientID: clientID, Scopes: claims.Scopes, Expires: claims.Expires}, nil
}

func (s *Service) Register(ctx context.Context, username, password, displayName string) (string, Principal, error) {
	username = normalizeUsername(username)
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		displayName = username
	}
	if username == "" || len(password) < 8 {
		return "", Principal{}, ErrInvalidCredentials
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", Principal{}, err
	}
	user, err := s.users.CreateUser(ctx, User{
		Username:     username,
		DisplayName:  displayName,
		PasswordHash: string(hash),
	})
	if err != nil {
		return "", Principal{}, err
	}
	return s.issueUserToken(user)
}

func (s *Service) UpdateTheme(ctx context.Context, principal Principal, theme string) (Principal, error) {
	theme = normalizeTheme(theme)
	if principal.UserID == "" || theme == "" {
		return Principal{}, ErrInvalidCredentials
	}
	user, err := s.users.UpdateUserTheme(ctx, principal.UserID, theme)
	if err != nil {
		return Principal{}, err
	}
	return userPrincipal(user, principal.Expires), nil
}

func (s *Service) UpdateAvatar(ctx context.Context, principal Principal, avatarFileID string, mimeType string, size int64) (Principal, error) {
	if principal.UserID == "" || avatarFileID == "" || mimeType == "" || size <= 0 {
		return Principal{}, ErrInvalidCredentials
	}
	user, err := s.users.UpdateUserAvatar(ctx, principal.UserID, avatarFileID, mimeType, size)
	if err != nil {
		return Principal{}, err
	}
	return userPrincipal(user, principal.Expires), nil
}

func (s *Service) UserByID(ctx context.Context, userID string) (User, error) {
	if strings.TrimSpace(userID) == "" {
		return User{}, ErrUserNotFound
	}
	return s.users.GetUserByID(ctx, strings.TrimSpace(userID))
}

func (s *Service) PrincipalFor(ctx context.Context, principal Principal) (Principal, error) {
	if principal.UserID == "" || principal.Username == "" {
		return principal, nil
	}
	user, err := s.users.GetUserByID(ctx, principal.UserID)
	if err != nil {
		return Principal{}, err
	}
	return userPrincipal(user, principal.Expires), nil
}

func (s *Service) Login(ctx context.Context, username, password string) (string, Principal, error) {
	user, err := s.users.GetUserByUsername(ctx, normalizeUsername(username))
	if err != nil {
		return "", Principal{}, ErrInvalidCredentials
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		return "", Principal{}, ErrInvalidCredentials
	}
	return s.issueUserToken(user)
}

func (s *Service) AuthenticateRequest(r *http.Request) (Principal, error) {
	if !s.cfg.AuthEnabled {
		return Principal{ClientID: "anonymous", UserID: "anonymous", Username: "anonymous", Theme: "dark", Scopes: defaultScopes()}, nil
	}

	token := bearerToken(r.Header.Get("Authorization"))
	if token == "" {
		token = strings.TrimSpace(r.URL.Query().Get("token"))
	}
	return s.VerifyToken(token)
}

func (s *Service) VerifyToken(token string) (Principal, error) {
	if token == "" {
		return Principal{}, ErrInvalidToken
	}

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Principal{}, ErrInvalidToken
	}

	signed := parts[0] + "." + parts[1]
	expected := s.signature(signed)
	if subtle.ConstantTimeCompare([]byte(expected), []byte(parts[2])) != 1 {
		return Principal{}, ErrInvalidToken
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Principal{}, ErrInvalidToken
	}

	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return Principal{}, ErrInvalidToken
	}
	if claims.Issuer != s.cfg.AuthIssuer || claims.Subject == "" {
		return Principal{}, ErrInvalidToken
	}
	if time.Now().UTC().Unix() >= claims.Expires {
		return Principal{}, ErrTokenExpired
	}

	return Principal{ClientID: claims.Subject, UserID: claims.Subject, Username: claims.Username, Theme: normalizeThemeOrDefault(claims.Theme), Scopes: claims.Scopes, Expires: claims.Expires}, nil
}

func (s *Service) HasScope(principal Principal, scope string) bool {
	for _, candidate := range principal.Scopes {
		if candidate == scope {
			return true
		}
	}
	return false
}

func (s *Service) sign(claims Claims) (string, error) {
	header, err := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}

	signed := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	return signed + "." + s.signature(signed), nil
}

func (s *Service) issueUserToken(user User) (string, Principal, error) {
	now := time.Now().UTC()
	claims := Claims{
		Subject:  user.UserID,
		Issuer:   s.cfg.AuthIssuer,
		Issued:   now.Unix(),
		Expires:  now.Add(s.cfg.AuthTokenTTL).Unix(),
		Scopes:   defaultScopes(),
		Username: user.Username,
		Theme:    normalizeThemeOrDefault(user.Theme),
	}
	token, err := s.sign(claims)
	if err != nil {
		return "", Principal{}, err
	}
	return token, Principal{
		ClientID:    user.UserID,
		UserID:      user.UserID,
		Username:    user.Username,
		DisplayName: user.DisplayName,
		Theme:       claims.Theme,
		AvatarURL:   avatarURL(user),
		Scopes:      claims.Scopes,
		Expires:     claims.Expires,
	}, nil
}

func userPrincipal(user User, expires int64) Principal {
	return Principal{
		ClientID:    user.UserID,
		UserID:      user.UserID,
		Username:    user.Username,
		DisplayName: user.DisplayName,
		Theme:       normalizeThemeOrDefault(user.Theme),
		AvatarURL:   avatarURL(user),
		Scopes:      defaultScopes(),
		Expires:     expires,
	}
}

func avatarURL(user User) string {
	if user.UserID == "" || user.AvatarFileID == "" {
		return ""
	}
	return "/v1/users/" + user.UserID + "/avatar"
}

func (s *Service) signature(value string) string {
	mac := hmac.New(sha256.New, []byte(s.cfg.AuthSecret))
	_, _ = mac.Write([]byte(value))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func bearerToken(header string) string {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(header, prefix))
}

func defaultScopes() []string {
	return []string{"publish", "subscribe", "topics:read"}
}

func normalizeUsername(username string) string {
	username = strings.ToLower(strings.TrimSpace(username))
	if len(username) < 3 || strings.ContainsAny(username, " \t\r\n:/") {
		return ""
	}
	return username
}

func normalizeTheme(theme string) string {
	switch strings.ToLower(strings.TrimSpace(theme)) {
	case "light":
		return "light"
	case "dark":
		return "dark"
	default:
		return ""
	}
}

func normalizeThemeOrDefault(theme string) string {
	if normalized := normalizeTheme(theme); normalized != "" {
		return normalized
	}
	return "dark"
}
