package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
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
	ErrTwoFactorRequired  = errors.New("two factor required")
)

const maxPasswordBytes = 256

var dummyPasswordHash = []byte("$2a$10$7EqJtq98hPqEX7fNZaFWoOhiIUhO5lAVot6gM2VqK4lP0HpxUq1Eim")

type Service struct {
	cfg      config.Config
	users    UserStore
	sessions SessionStore
}

type Principal struct {
	ClientID    string   `json:"clientId"`
	UserID      string   `json:"userId,omitempty"`
	SessionID   string   `json:"sessionId,omitempty"`
	Username    string   `json:"username,omitempty"`
	DisplayName string   `json:"displayName,omitempty"`
	Theme       string   `json:"theme,omitempty"`
	AvatarURL   string   `json:"avatarUrl,omitempty"`
	TOTPEnabled bool     `json:"totpEnabled"`
	Scopes      []string `json:"scopes"`
	Expires     int64    `json:"expires"`
}

type Claims struct {
	Subject  string   `json:"sub"`
	Session  string   `json:"sid,omitempty"`
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
	TOTPSecret     string    `json:"-"`
	TOTPEnabled    bool      `json:"totpEnabled"`
	CreatedAt      time.Time `json:"createdAt"`
}

type UserStore interface {
	CreateUser(ctx context.Context, user User) (User, error)
	GetUserByID(ctx context.Context, userID string) (User, error)
	GetUserByUsername(ctx context.Context, username string) (User, error)
	UpdateUserAvatar(ctx context.Context, userID string, avatarFileID string, mimeType string, size int64) (User, error)
	UpdateUserTheme(ctx context.Context, userID string, theme string) (User, error)
	UpdateUserTOTP(ctx context.Context, userID string, secret string, enabled bool) (User, error)
}

type TOTPSetup struct {
	Secret     string `json:"secret"`
	OtpauthURL string `json:"otpauthUrl"`
}

type Session struct {
	SessionID string    `json:"sessionId"`
	UserID    string    `json:"userId"`
	Username  string    `json:"username"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
	RevokedAt time.Time `json:"revokedAt,omitempty"`
	Current   bool      `json:"current,omitempty"`
}

type SessionStore interface {
	CreateSession(ctx context.Context, session Session) (Session, error)
	GetSession(ctx context.Context, sessionID string) (Session, error)
	ListSessions(ctx context.Context, userID string) ([]Session, error)
	RevokeSession(ctx context.Context, userID string, sessionID string) error
	RevokeOtherSessions(ctx context.Context, userID string, keepSessionID string) error
}

func NewService(cfg config.Config, users UserStore) *Service {
	if users == nil {
		users = NewMemoryUserStore()
	}
	return &Service{cfg: cfg, users: users, sessions: NewMemorySessionStore()}
}

func (s *Service) SetSessionStore(store SessionStore) {
	if store != nil {
		s.sessions = store
	}
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
	if username == "" || len(password) < 8 || len(password) > maxPasswordBytes {
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
	return s.issueUserToken(ctx, user)
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
	next := userPrincipal(user, principal.Expires)
	next.SessionID = principal.SessionID
	return next, nil
}

func (s *Service) UpdateAvatar(ctx context.Context, principal Principal, avatarFileID string, mimeType string, size int64) (Principal, error) {
	if principal.UserID == "" || avatarFileID == "" || mimeType == "" || size <= 0 {
		return Principal{}, ErrInvalidCredentials
	}
	user, err := s.users.UpdateUserAvatar(ctx, principal.UserID, avatarFileID, mimeType, size)
	if err != nil {
		return Principal{}, err
	}
	next := userPrincipal(user, principal.Expires)
	next.SessionID = principal.SessionID
	return next, nil
}

func (s *Service) UserByID(ctx context.Context, userID string) (User, error) {
	if strings.TrimSpace(userID) == "" {
		return User{}, ErrUserNotFound
	}
	return s.users.GetUserByID(ctx, strings.TrimSpace(userID))
}

func (s *Service) UserByUsername(ctx context.Context, username string) (User, error) {
	if normalizeUsername(username) == "" {
		return User{}, ErrUserNotFound
	}
	return s.users.GetUserByUsername(ctx, username)
}

func (s *Service) PrincipalFor(ctx context.Context, principal Principal) (Principal, error) {
	if principal.UserID == "" || principal.Username == "" {
		return principal, nil
	}
	user, err := s.users.GetUserByID(ctx, principal.UserID)
	if err != nil {
		return Principal{}, err
	}
	next := userPrincipal(user, principal.Expires)
	next.SessionID = principal.SessionID
	return next, nil
}

func (s *Service) Login(ctx context.Context, username, password string, totpCode string) (string, Principal, error) {
	user, err := s.users.GetUserByUsername(ctx, normalizeUsername(username))
	if err != nil {
		_ = bcrypt.CompareHashAndPassword(dummyPasswordHash, []byte(password))
		return "", Principal{}, ErrInvalidCredentials
	}
	if len(password) > maxPasswordBytes {
		return "", Principal{}, ErrInvalidCredentials
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		return "", Principal{}, ErrInvalidCredentials
	}
	if user.TOTPEnabled {
		if strings.TrimSpace(totpCode) == "" {
			return "", Principal{}, ErrTwoFactorRequired
		}
		if !validateTOTP(user.TOTPSecret, totpCode, time.Now().UTC()) {
			return "", Principal{}, ErrInvalidCredentials
		}
	}
	return s.issueUserToken(ctx, user)
}

func (s *Service) BeginTOTPSetup(ctx context.Context, principal Principal) (TOTPSetup, error) {
	if principal.UserID == "" {
		return TOTPSetup{}, ErrInvalidCredentials
	}
	user, err := s.users.GetUserByID(ctx, principal.UserID)
	if err != nil {
		return TOTPSetup{}, err
	}
	if user.TOTPEnabled {
		return TOTPSetup{}, ErrInvalidCredentials
	}
	secret, err := newTOTPSecret()
	if err != nil {
		return TOTPSetup{}, err
	}
	if _, err := s.users.UpdateUserTOTP(ctx, principal.UserID, secret, false); err != nil {
		return TOTPSetup{}, err
	}
	return TOTPSetup{Secret: secret, OtpauthURL: otpauthURL("Quietline", user.Username, secret)}, nil
}

func (s *Service) ConfirmTOTP(ctx context.Context, principal Principal, code string) (Principal, error) {
	if principal.UserID == "" {
		return Principal{}, ErrInvalidCredentials
	}
	user, err := s.users.GetUserByID(ctx, principal.UserID)
	if err != nil {
		return Principal{}, err
	}
	if user.TOTPSecret == "" || !validateTOTP(user.TOTPSecret, code, time.Now().UTC()) {
		return Principal{}, ErrInvalidCredentials
	}
	user, err = s.users.UpdateUserTOTP(ctx, principal.UserID, user.TOTPSecret, true)
	if err != nil {
		return Principal{}, err
	}
	next := userPrincipal(user, principal.Expires)
	next.SessionID = principal.SessionID
	return next, nil
}

func (s *Service) DisableTOTP(ctx context.Context, principal Principal, password string, code string) (Principal, error) {
	if principal.UserID == "" {
		return Principal{}, ErrInvalidCredentials
	}
	user, err := s.users.GetUserByID(ctx, principal.UserID)
	if err != nil {
		return Principal{}, err
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		return Principal{}, ErrInvalidCredentials
	}
	if user.TOTPEnabled && !validateTOTP(user.TOTPSecret, code, time.Now().UTC()) {
		return Principal{}, ErrInvalidCredentials
	}
	user, err = s.users.UpdateUserTOTP(ctx, principal.UserID, "", false)
	if err != nil {
		return Principal{}, err
	}
	next := userPrincipal(user, principal.Expires)
	next.SessionID = principal.SessionID
	return next, nil
}

func (s *Service) AuthenticateRequest(r *http.Request) (Principal, error) {
	if !s.cfg.AuthEnabled {
		return Principal{ClientID: "anonymous", UserID: "anonymous", Username: "anonymous", Theme: "dark", Scopes: defaultScopes()}, nil
	}

	token := bearerToken(r.Header.Get("Authorization"))
	// Token in query param is allowed only for WebSocket upgrades: browsers cannot
	// set custom headers in the native WebSocket API.
	if token == "" && strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		token = strings.TrimSpace(r.URL.Query().Get("token"))
	}
	return s.VerifyToken(r.Context(), token)
}

func (s *Service) VerifyToken(ctx context.Context, token string) (Principal, error) {
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
	nowUnix := time.Now().UTC().Unix()
	if nowUnix >= claims.Expires {
		return Principal{}, ErrTokenExpired
	}
	// Reject tokens with iat far in the future (> 30s clock skew tolerance).
	if claims.Issued > nowUnix+30 {
		return Principal{}, ErrInvalidToken
	}
	if claims.Username != "" {
		if claims.Session == "" {
			return Principal{}, ErrInvalidToken
		}
		session, err := s.sessions.GetSession(ctx, claims.Session)
		if err != nil || session.UserID != claims.Subject || !session.RevokedAt.IsZero() || !session.ExpiresAt.After(time.Now().UTC()) {
			return Principal{}, ErrInvalidToken
		}
	}

	return Principal{ClientID: claims.Subject, UserID: claims.Subject, SessionID: claims.Session, Username: claims.Username, Theme: normalizeThemeOrDefault(claims.Theme), Scopes: claims.Scopes, Expires: claims.Expires}, nil
}

func (s *Service) ListSessions(ctx context.Context, principal Principal) ([]Session, error) {
	if principal.UserID == "" {
		return nil, ErrInvalidCredentials
	}
	sessions, err := s.sessions.ListSessions(ctx, principal.UserID)
	if err != nil {
		return nil, err
	}
	for idx := range sessions {
		sessions[idx].Current = sessions[idx].SessionID == principal.SessionID
	}
	return sessions, nil
}

func (s *Service) RevokeSession(ctx context.Context, principal Principal, sessionID string) error {
	if principal.UserID == "" || strings.TrimSpace(sessionID) == "" {
		return ErrInvalidCredentials
	}
	return s.sessions.RevokeSession(ctx, principal.UserID, strings.TrimSpace(sessionID))
}

func (s *Service) RevokeOtherSessions(ctx context.Context, principal Principal) error {
	if principal.UserID == "" || principal.SessionID == "" {
		return ErrInvalidCredentials
	}
	return s.sessions.RevokeOtherSessions(ctx, principal.UserID, principal.SessionID)
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

func (s *Service) issueUserToken(ctx context.Context, user User) (string, Principal, error) {
	now := time.Now().UTC()
	expires := now.Add(s.cfg.AuthTokenTTL)
	session, err := s.sessions.CreateSession(ctx, Session{
		SessionID: newSessionID(),
		UserID:    user.UserID,
		Username:  user.Username,
		CreatedAt: now,
		ExpiresAt: expires,
	})
	if err != nil {
		return "", Principal{}, err
	}
	claims := Claims{
		Subject:  user.UserID,
		Session:  session.SessionID,
		Issuer:   s.cfg.AuthIssuer,
		Issued:   now.Unix(),
		Expires:  expires.Unix(),
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
		SessionID:   session.SessionID,
		Username:    user.Username,
		DisplayName: user.DisplayName,
		Theme:       claims.Theme,
		AvatarURL:   avatarURL(user),
		TOTPEnabled: user.TOTPEnabled,
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
		TOTPEnabled: user.TOTPEnabled,
		Scopes:      defaultScopes(),
		Expires:     expires,
	}
}

func newSessionID() string {
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(bytes[:])
}

func newTOTPSecret() (string, error) {
	var bytes [20]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return strings.TrimRight(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(bytes[:]), "="), nil
}

func otpauthURL(issuer string, account string, secret string) string {
	values := url.Values{}
	values.Set("secret", secret)
	values.Set("issuer", issuer)
	values.Set("algorithm", "SHA1")
	values.Set("digits", "6")
	values.Set("period", "30")
	return "otpauth://totp/" + url.PathEscape(issuer+":"+account) + "?" + values.Encode()
}

func validateTOTP(secret string, code string, now time.Time) bool {
	code = strings.TrimSpace(code)
	if len(code) != 6 {
		return false
	}
	for _, r := range code {
		if r < '0' || r > '9' {
			return false
		}
	}
	for offset := int64(-1); offset <= 1; offset++ {
		expected, err := totpAt(secret, now.Unix()/30+offset)
		if err == nil && subtle.ConstantTimeCompare([]byte(expected), []byte(code)) == 1 {
			return true
		}
	}
	return false
}

func totpAt(secret string, counter int64) (string, error) {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil {
		return "", err
	}
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], uint64(counter))
	mac := hmac.New(sha1.New, key)
	_, _ = mac.Write(buf[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	binaryCode := (int(sum[offset])&0x7f)<<24 |
		(int(sum[offset+1])&0xff)<<16 |
		(int(sum[offset+2])&0xff)<<8 |
		(int(sum[offset+3]) & 0xff)
	return fmt.Sprintf("%06d", binaryCode%1000000), nil
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
