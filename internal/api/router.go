package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"highload-ws-pubsub/internal/auth"
	"highload-ws-pubsub/internal/broker"
	"highload-ws-pubsub/internal/config"
	"highload-ws-pubsub/internal/files"
	"highload-ws-pubsub/internal/message"
	"highload-ws-pubsub/internal/metrics"
	"highload-ws-pubsub/internal/notifications"
	"highload-ws-pubsub/internal/ws"
	"highload-ws-pubsub/internal/zk"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Dependencies struct {
	Config    config.Config
	Broker    broker.Broker
	Hub       *ws.Hub
	Metrics   *metrics.Registry
	Logger    *slog.Logger
	Auth      *auth.Service
	Push      *notifications.Service
	ZKStore   zk.Store
	Files     files.Store
	FileRooms *fileRegistry
}

func New(deps Dependencies) http.Handler {
	if deps.FileRooms == nil {
		deps.FileRooms = &fileRegistry{rooms: make(map[string]string)}
	}
	authLimiter := newIPRateLimiter(10, time.Minute)

	mux := http.NewServeMux()
	wsHandler := ws.NewHandler(deps.Config, deps.Hub, deps.Broker, deps.Metrics, deps.Logger, deps.Auth, deps.ZKStore)

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("GET /metrics", promhttp.HandlerFor(deps.Metrics.Prometheus, promhttp.HandlerOpts{}))
	mux.Handle("GET /ws", wsHandler)
	mux.HandleFunc("OPTIONS /", handleOptions)
	mux.HandleFunc("POST /v1/auth/token", rateLimitMiddleware(authLimiter, func(w http.ResponseWriter, r *http.Request) {
		handleToken(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/auth/register", rateLimitMiddleware(authLimiter, func(w http.ResponseWriter, r *http.Request) {
		handleRegister(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/auth/login", rateLimitMiddleware(authLimiter, func(w http.ResponseWriter, r *http.Request) {
		handleLogin(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/me", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		principal, err := deps.Auth.PrincipalFor(r.Context(), principalFromContext(r.Context()))
		if err != nil {
			writeError(w, http.StatusNotFound, "not_found")
			return
		}
		writeJSON(w, http.StatusOK, principal)
	}))
	mux.HandleFunc("PUT /v1/me/theme", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleUpdateTheme(w, r, deps)
	}))
	mux.HandleFunc("PUT /v1/me/avatar", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleUploadAvatar(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/me/2fa/setup", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleBeginTOTPSetup(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/me/2fa/confirm", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleConfirmTOTP(w, r, deps)
	}))
	mux.HandleFunc("DELETE /v1/me/2fa", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleDisableTOTP(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/me/identity", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleCurrentIdentity(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/chat/friends", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleListFriends(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/chat/friends", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleRequestFriend(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/chat/friends/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleRespondFriend(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/me/sessions", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleListSessions(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/me/push-public-key", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handlePushPublicKey(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/me/push-subscriptions", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleListPushSubscriptions(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/me/push-subscriptions", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleSavePushSubscription(w, r, deps)
	}))
	mux.HandleFunc("PUT /v1/me/push-subscriptions/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleUpdatePushSubscription(w, r, deps)
	}))
	mux.HandleFunc("DELETE /v1/me/push-subscriptions/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleDeletePushSubscription(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/me/push-test", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleTestPush(w, r, deps)
	}))
	mux.HandleFunc("DELETE /v1/me/sessions/others", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleRevokeOtherSessions(w, r, deps)
	}))
	mux.HandleFunc("DELETE /v1/me/sessions/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleRevokeSession(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/users/", func(w http.ResponseWriter, r *http.Request) {
		handleUserAvatar(w, r, deps)
	})
	mux.HandleFunc("GET /v1/topics", requireScope(deps, "topics:read", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"connections": deps.Hub.ConnectionCount(),
			"topics":      deps.Hub.Stats(),
		})
	}))
	mux.HandleFunc("PUT /v1/zk/identities/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(strings.Trim(r.URL.Path, "/"), "/last-seen") {
			handleTouchIdentity(w, r, deps)
			return
		}
		handleUpsertIdentity(w, r, deps)
	}))
	mux.HandleFunc("PUT /v1/chat/identities/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(strings.Trim(r.URL.Path, "/"), "/last-seen") {
			handleTouchIdentity(w, r, deps)
			return
		}
		handleUpsertIdentity(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/zk/identities/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleGetIdentity(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/chat/identities/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleGetIdentity(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/zk/rooms", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleListRooms(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/chat/rooms", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleListRooms(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/chats", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleListRooms(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/zk/rooms", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleCreateRoom(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/chat/rooms", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleCreateRoom(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/chats", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleCreateRoom(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/zk/rooms/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/chat/rooms/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/chats/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/zk/rooms/", requireScope(deps, "publish", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/chat/rooms/", requireScope(deps, "publish", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/chats/", requireScope(deps, "publish", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("PUT /v1/zk/rooms/", requireScope(deps, "publish", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("PUT /v1/chat/rooms/", requireScope(deps, "publish", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("PUT /v1/chats/", requireScope(deps, "publish", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("DELETE /v1/zk/rooms/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("DELETE /v1/chat/rooms/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("DELETE /v1/chats/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/zk/files", requireScope(deps, "publish", func(w http.ResponseWriter, r *http.Request) {
		handleUploadEncryptedFile(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/chat/files", requireScope(deps, "publish", func(w http.ResponseWriter, r *http.Request) {
		handleUploadEncryptedFile(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/zk/files/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleDownloadEncryptedFile(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/chat/files/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleDownloadEncryptedFile(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/topics/", func(w http.ResponseWriter, r *http.Request) {
		requireScope(deps, "publish", func(w http.ResponseWriter, r *http.Request) {
			handlePublish(w, r, deps)
		})(w, r)
	})

	return recoveryMiddleware(securityHeadersMiddleware(corsMiddleware(deps.Config, loggingMiddleware(deps.Logger, mux))))
}

type tokenRequest struct {
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
}

type authRequest struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	DisplayName string `json:"displayName,omitempty"`
	TOTPCode    string `json:"totpCode,omitempty"`
}

type themeRequest struct {
	Theme string `json:"theme"`
}

type totpCodeRequest struct {
	Code string `json:"code"`
}

type disableTOTPRequest struct {
	Password string `json:"password"`
	Code     string `json:"code"`
}

type tokenResponse struct {
	AccessToken string         `json:"accessToken"`
	TokenType   string         `json:"tokenType"`
	ExpiresAt   int64          `json:"expiresAt"`
	Principal   auth.Principal `json:"principal"`
}

type publishRequest struct {
	Data json.RawMessage `json:"data"`
}

type upsertIdentityRequest struct {
	DisplayName       string `json:"displayName"`
	IdentityPublicKey string `json:"identityPublicKey"`
}

type createRoomRequest struct {
	RoomID     string   `json:"roomId"`
	Name       string   `json:"name"`
	Members    []string `json:"members"`
	RoomSecret string   `json:"roomSecret,omitempty"`
}

type friendRequest struct {
	Username   string `json:"username"`
	UserID     string `json:"userId"`
	FriendCode string `json:"friendCode"`
}

type inviteFriendRequest struct {
	UserID string `json:"userId"`
}

type pushSubscriptionRequest struct {
	Endpoint    string                    `json:"endpoint"`
	Keys        pushSubscriptionKeys      `json:"keys"`
	Preferences notifications.Preferences `json:"preferences"`
}

type pushSubscriptionKeys struct {
	P256DH string `json:"p256dh"`
	Auth   string `json:"auth"`
}

type encryptedMessageRequest struct {
	SenderID   string `json:"senderId"`
	Ciphertext string `json:"ciphertext"`
	Nonce      string `json:"nonce"`
	Algorithm  string `json:"algorithm"`
	KeyID      string `json:"keyId"`
}

type reactionRequest struct {
	Emoji string `json:"emoji"`
}

type fileUploadResponse struct {
	FileID string `json:"fileId"`
	Size   int64  `json:"size"`
}

type realtimeStateEvent struct {
	Kind      string `json:"kind"`
	RoomID    string `json:"roomId,omitempty"`
	UserID    string `json:"userId,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	MessageID string `json:"messageId,omitempty"`
	SenderID  string `json:"senderId,omitempty"`
	At        string `json:"at"`
}

const maxAvatarBytes int64 = 1024 * 1024

func handleToken(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	var req tokenRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json")
		return
	}

	token, principal, err := deps.Auth.IssueToken(strings.TrimSpace(req.ClientID), req.ClientSecret)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_credentials")
		return
	}

	writeJSON(w, http.StatusOK, tokenResponse{
		AccessToken: token,
		TokenType:   "Bearer",
		ExpiresAt:   principal.Expires,
		Principal:   principal,
	})
}

func handleRegister(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	var req authRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json")
		return
	}
	token, principal, err := deps.Auth.Register(r.Context(), req.Username, req.Password, req.DisplayName)
	if err != nil {
		if err == auth.ErrUserExists {
			writeError(w, http.StatusConflict, "user_exists")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid_registration")
		return
	}
	updateSessionMetadata(r, deps, principal)
	publishUserEvent(r.Context(), deps, principal.UserID, "sessions.changed", "", "")
	notifyUser(deps, principal.UserID, notifications.EventSession, notifications.Payload{
		Type:  "session.created",
		Title: "Quietline",
		Body:  "New account session started.",
		URL:   "/profile",
	})
	writeJSON(w, http.StatusCreated, tokenResponse{AccessToken: token, TokenType: "Bearer", ExpiresAt: principal.Expires, Principal: principal})
}

func handleLogin(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	var req authRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json")
		return
	}
	token, principal, err := deps.Auth.Login(r.Context(), req.Username, req.Password, req.TOTPCode)
	if err != nil {
		if err == auth.ErrTwoFactorRequired {
			writeJSON(w, http.StatusAccepted, map[string]any{"twoFactorRequired": true})
			return
		}
		writeError(w, http.StatusUnauthorized, "invalid_credentials")
		return
	}
	updateSessionMetadata(r, deps, principal)
	publishUserEvent(r.Context(), deps, principal.UserID, "sessions.changed", "", "")
	notifyUser(deps, principal.UserID, notifications.EventSession, notifications.Payload{
		Type:  "session.created",
		Title: "Quietline",
		Body:  "New account session started.",
		URL:   "/profile",
	})
	writeJSON(w, http.StatusOK, tokenResponse{AccessToken: token, TokenType: "Bearer", ExpiresAt: principal.Expires, Principal: principal})
}

func handleBeginTOTPSetup(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	setup, err := deps.Auth.BeginTOTPSetup(r.Context(), principalFromContext(r.Context()))
	if err != nil {
		writeError(w, http.StatusBadRequest, "totp_setup_failed")
		return
	}
	writeJSON(w, http.StatusOK, setup)
}

func handleConfirmTOTP(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	var req totpCodeRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json")
		return
	}
	principal, err := deps.Auth.ConfirmTOTP(r.Context(), principalFromContext(r.Context()), req.Code)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_totp")
		return
	}
	writeJSON(w, http.StatusOK, principal)
}

func handleDisableTOTP(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	var req disableTOTPRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json")
		return
	}
	principal, err := deps.Auth.DisableTOTP(r.Context(), principalFromContext(r.Context()), req.Password, req.Code)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_totp")
		return
	}
	writeJSON(w, http.StatusOK, principal)
}

func handleUpdateTheme(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	var req themeRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json")
		return
	}
	principal, err := deps.Auth.UpdateTheme(r.Context(), principalFromContext(r.Context()), req.Theme)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_theme")
		return
	}
	writeJSON(w, http.StatusOK, principal)
}

func handleUploadAvatar(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAvatarBytes+64*1024)
	if err := r.ParseMultipartForm(maxAvatarBytes); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_multipart")
		return
	}
	file, header, err := r.FormFile("avatar")
	if err != nil {
		writeError(w, http.StatusBadRequest, "avatar_required")
		return
	}
	defer file.Close()
	if header.Size <= 0 || header.Size > maxAvatarBytes {
		writeError(w, http.StatusBadRequest, "avatar_too_large")
		return
	}

	head := make([]byte, 512)
	n, err := io.ReadFull(file, head)
	if err != nil && err != io.ErrUnexpectedEOF {
		writeError(w, http.StatusBadRequest, "avatar_read_failed")
		return
	}
	head = head[:n]
	mimeType := http.DetectContentType(head)
	if !allowedAvatarMimeType(mimeType) {
		writeError(w, http.StatusBadRequest, "unsupported_avatar_type")
		return
	}

	stored, err := deps.Files.Put(r.Context(), io.MultiReader(bytes.NewReader(head), file), header.Size)
	if err != nil {
		writeError(w, http.StatusBadGateway, "avatar_upload_failed")
		return
	}
	principal, err := deps.Auth.UpdateAvatar(r.Context(), principalFromContext(r.Context()), stored.FileID, mimeType, stored.Size)
	if err != nil {
		writeError(w, http.StatusBadRequest, "avatar_update_failed")
		return
	}
	writeJSON(w, http.StatusOK, principal)
}

func handleListSessions(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	sessions, err := deps.Auth.ListSessions(r.Context(), principalFromContext(r.Context()))
	if err != nil {
		writeError(w, http.StatusBadRequest, "sessions_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

func handleRevokeSession(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	sessionID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/me/sessions/"), "/")
	if sessionID == "" {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	if err := deps.Auth.RevokeSession(r.Context(), principalFromContext(r.Context()), sessionID); err != nil {
		writeError(w, http.StatusBadRequest, "revoke_failed")
		return
	}
	publishUserEvent(r.Context(), deps, principalFromContext(r.Context()).UserID, "session.revoked", "", sessionID)
	w.WriteHeader(http.StatusNoContent)
}

func handleRevokeOtherSessions(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	if err := deps.Auth.RevokeOtherSessions(r.Context(), principalFromContext(r.Context())); err != nil {
		writeError(w, http.StatusBadRequest, "revoke_failed")
		return
	}
	publishUserEvent(r.Context(), deps, principalFromContext(r.Context()).UserID, "sessions.changed", "", "")
	w.WriteHeader(http.StatusNoContent)
}

func handlePushPublicKey(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	enabled := deps.Push != nil && deps.Push.Enabled()
	publicKey := ""
	reason := "not_configured"
	if enabled {
		publicKey = deps.Push.PublicKey()
		reason = ""
	} else if deps.Push != nil {
		reason = deps.Push.DisabledReason()
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": enabled, "publicKey": publicKey, "reason": reason})
}

func handleListPushSubscriptions(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	if deps.Push == nil {
		writeJSON(w, http.StatusOK, map[string]any{"subscriptions": []notifications.Subscription{}})
		return
	}
	subs, err := deps.Push.Store().ListByUser(r.Context(), principalFromContext(r.Context()).UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "push_list_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"subscriptions": subs})
}

func handleSavePushSubscription(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	if deps.Push == nil || !deps.Push.Enabled() {
		writeError(w, http.StatusBadRequest, "push_not_configured")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	var req pushSubscriptionRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json")
		return
	}
	sub, err := deps.Push.Store().Save(r.Context(), notifications.Subscription{
		UserID:      principalFromContext(r.Context()).UserID,
		Endpoint:    req.Endpoint,
		P256DH:      req.Keys.P256DH,
		Auth:        req.Keys.Auth,
		UserAgent:   r.UserAgent(),
		Preferences: req.Preferences,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, "push_subscription_failed")
		return
	}
	writeJSON(w, http.StatusCreated, sub)
}

func handleUpdatePushSubscription(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	if deps.Push == nil {
		writeError(w, http.StatusBadRequest, "push_not_configured")
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/me/push-subscriptions/"), "/")
	if id == "" {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	var req struct {
		Preferences notifications.Preferences `json:"preferences"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json")
		return
	}
	sub, err := deps.Push.Store().UpdatePreferences(r.Context(), principalFromContext(r.Context()).UserID, id, req.Preferences)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	writeJSON(w, http.StatusOK, sub)
}

func handleDeletePushSubscription(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	if deps.Push == nil {
		writeError(w, http.StatusBadRequest, "push_not_configured")
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/me/push-subscriptions/"), "/")
	if id == "" {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	if err := deps.Push.Store().Delete(r.Context(), principalFromContext(r.Context()).UserID, id); err != nil {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func handleTestPush(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	if deps.Push == nil || !deps.Push.Enabled() {
		writeError(w, http.StatusBadRequest, "push_not_configured")
		return
	}
	userID := principalFromContext(r.Context()).UserID
	go deps.Push.NotifyUser(context.Background(), userID, notifications.EventSession, notifications.Payload{
		Type:  "test",
		Title: "Quietline",
		Body:  "Push notifications are enabled.",
		URL:   "/profile",
	})
	w.WriteHeader(http.StatusNoContent)
}

func handleUserAvatar(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	userID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/users/"), "/")
	userID, tail, ok := strings.Cut(userID, "/")
	if !ok || tail != "avatar" || userID == "" {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	user, err := deps.Auth.UserByID(r.Context(), userID)
	if err != nil || user.AvatarFileID == "" {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	reader, size, err := deps.Files.Get(r.Context(), user.AvatarFileID)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	defer reader.Close()
	w.Header().Set("Content-Type", user.AvatarMimeType)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Cache-Control", "private, max-age=300")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, reader)
}

func handleCurrentIdentity(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	identity, err := ensureCurrentIdentity(r.Context(), deps, principalFromContext(r.Context()))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, identity)
}

func handleListFriends(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	friends, err := deps.ZKStore.ListFriends(r.Context(), principalFromContext(r.Context()).UserID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"friends": friends})
}

func handleRequestFriend(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	var req friendRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json")
		return
	}
	targetID := strings.TrimSpace(req.UserID)
	if targetID == "" {
		if strings.TrimSpace(req.FriendCode) != "" {
			user, err := deps.Auth.UserByFriendCode(r.Context(), req.FriendCode)
			if err != nil {
				writeError(w, http.StatusNotFound, "friend_code_not_found")
				return
			}
			targetID = user.UserID
		} else {
			user, err := deps.Auth.UserByUsername(r.Context(), req.Username)
			if err != nil {
				writeError(w, http.StatusNotFound, "user_not_found")
				return
			}
			targetID = user.UserID
		}
	}
	if err := deps.ZKStore.RequestFriend(r.Context(), principalFromContext(r.Context()).UserID, targetID); err != nil {
		writeStoreError(w, err)
		return
	}
	publishUserEvent(r.Context(), deps, principalFromContext(r.Context()).UserID, "friends.changed", "", "")
	publishUserEvent(r.Context(), deps, targetID, "friends.changed", "", "")
	notifyUser(deps, targetID, notifications.EventFriend, notifications.Payload{
		Type:  "friend.request",
		Title: "Quietline",
		Body:  "New friend request.",
		URL:   "/profile",
	})
	handleListFriends(w, r, deps)
}

func handleRespondFriend(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	friendID, action, ok := friendActionSubroute(r.URL.Path)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	accept := action == "accept"
	if err := deps.ZKStore.RespondFriend(r.Context(), principalFromContext(r.Context()).UserID, friendID, accept); err != nil {
		writeStoreError(w, err)
		return
	}
	publishUserEvent(r.Context(), deps, principalFromContext(r.Context()).UserID, "friends.changed", "", "")
	publishUserEvent(r.Context(), deps, friendID, "friends.changed", "", "")
	if accept {
		notifyUser(deps, friendID, notifications.EventFriend, notifications.Payload{
			Type:  "friend.accepted",
			Title: "Quietline",
			Body:  "Friend request accepted.",
			URL:   "/profile",
		})
	}
	w.WriteHeader(http.StatusNoContent)
}

func ensureCurrentIdentity(ctx context.Context, deps Dependencies, principal auth.Principal) (zk.Identity, error) {
	if principal.UserID == "" {
		return zk.Identity{}, zk.ErrBadRequest
	}
	current, err := deps.Auth.PrincipalFor(ctx, principal)
	if err != nil {
		current = principal
	}
	displayName := strings.TrimSpace(current.DisplayName)
	if displayName == "" {
		displayName = strings.TrimSpace(current.Username)
	}
	if displayName == "" {
		displayName = current.UserID
	}
	return deps.ZKStore.UpsertIdentity(ctx, zk.Identity{
		UserID:            current.UserID,
		DisplayName:       displayName,
		IdentityPublicKey: "account:" + current.UserID,
	})
}

func allowedAvatarMimeType(mimeType string) bool {
	switch mimeType {
	case "image/jpeg", "image/png", "image/webp":
		return true
	default:
		return false
	}
}

func handlePublish(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	topic, ok := topicFromPath(r.URL.Path)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	if !canPublishTopic(r.Context(), deps, principalFromContext(r.Context()), topic) {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, deps.Config.MaxMessageBytes)
	var req publishRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json")
		return
	}
	if len(req.Data) == 0 {
		writeError(w, http.StatusBadRequest, "data_required")
		return
	}

	msg := message.New(topic, req.Data, deps.Config.NodeID)
	if err := deps.Broker.Publish(r.Context(), msg); err != nil {
		deps.Metrics.BrokerPublishErrors.Inc()
		writeError(w, http.StatusBadGateway, "publish_failed")
		return
	}

	deps.Metrics.MessagesPublished.Inc()
	writeJSON(w, http.StatusAccepted, msg)
}

func handleUpsertIdentity(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	userID := identityIDFromPath(r.URL.Path)
	if userID == "" {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	principal := principalFromContext(r.Context())
	if principal.UserID == "" || userID != principal.UserID {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, deps.Config.MaxMessageBytes)
	var req upsertIdentityRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json")
		return
	}

	identity, err := deps.ZKStore.UpsertIdentity(r.Context(), zk.Identity{
		UserID:            userID,
		DisplayName:       req.DisplayName,
		IdentityPublicKey: req.IdentityPublicKey,
	})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, identity)
}

func handleGetIdentity(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	userID := identityIDFromPath(r.URL.Path)
	if userID == "" {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	principal := principalFromContext(r.Context())
	if principal.UserID != userID {
		friends, err := deps.ZKStore.AreFriends(r.Context(), principal.UserID, userID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		if !friends {
			shared, err := shareRoom(r.Context(), deps, principal.UserID, userID)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			if !shared {
				writeError(w, http.StatusForbidden, "forbidden")
				return
			}
		}
	}
	identity, err := deps.ZKStore.GetIdentity(r.Context(), userID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, identity)
}

func handleTouchIdentity(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	userID := identityIDFromPath(r.URL.Path)
	userID = strings.TrimSuffix(strings.Trim(userID, "/"), "/last-seen")
	userID = strings.Trim(userID, "/")
	if userID == "" {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	if userID != principalFromContext(r.Context()).UserID {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}

	identity, err := deps.ZKStore.TouchIdentity(r.Context(), userID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, identity)
}

func handleCreateRoom(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	r.Body = http.MaxBytesReader(w, r.Body, deps.Config.MaxMessageBytes)
	var req createRoomRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json")
		return
	}

	room, err := deps.ZKStore.CreateRoom(r.Context(), zk.Room{
		RoomID:     req.RoomID,
		Name:       req.Name,
		RoomSecret: req.RoomSecret,
		Members:    []string{principalFromContext(r.Context()).UserID},
	})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	publishRoomMembersEvent(r.Context(), deps, room.RoomID, "chats.changed")
	notifyUser(deps, principalFromContext(r.Context()).UserID, notifications.EventChat, notifications.Payload{
		Type:  "chat.created",
		Title: "Quietline",
		Body:  "Chat created.",
		URL:   "/chats/" + room.RoomID,
	})
	writeJSON(w, http.StatusCreated, room)
}

func handleListRooms(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	rooms, err := deps.ZKStore.ListRooms(r.Context(), principalFromContext(r.Context()).UserID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rooms": rooms})
}

func handleZKRoomSubroutes(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	roomID, tail, ok := zkRoomSubroute(r.URL.Path)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	switch r.Method {
	case http.MethodGet:
		switch tail {
		case "messages":
			handleListEncryptedMessages(w, r, deps, roomID)
		case "attachments":
			handleListRoomAttachments(w, r, deps, roomID)
		default:
			writeError(w, http.StatusNotFound, "not_found")
			return
		}
	case http.MethodPost:
		switch {
		case tail == "messages":
			handleAppendEncryptedMessage(w, r, deps, roomID)
		case strings.HasPrefix(tail, "messages/") && strings.HasSuffix(tail, "/reactions"):
			messageID := strings.TrimSuffix(strings.TrimPrefix(tail, "messages/"), "/reactions")
			if messageID == "" || strings.ContainsAny(messageID, " \t\r\n/") {
				writeError(w, http.StatusNotFound, "not_found")
				return
			}
			handleToggleMessageReaction(w, r, deps, roomID, messageID)
		case tail == "read":
			handleMarkRoomRead(w, r, deps, roomID)
		case tail == "friends":
			handleInviteFriendToRoom(w, r, deps, roomID)
		default:
			writeError(w, http.StatusNotFound, "not_found")
			return
		}
	case http.MethodPut:
		messageID, ok := messageSubroute(tail)
		if !ok {
			writeError(w, http.StatusNotFound, "not_found")
			return
		}
		handleUpdateEncryptedMessage(w, r, deps, roomID, messageID)
	case http.MethodDelete:
		if userID, ok := memberSubroute(tail); ok {
			handleLeaveRoom(w, r, deps, roomID, userID)
			return
		}
		if messageID, ok := messageSubroute(tail); ok {
			handleDeleteEncryptedMessage(w, r, deps, roomID, messageID)
			return
		}
		writeError(w, http.StatusNotFound, "not_found")
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}

func handleMarkRoomRead(w http.ResponseWriter, r *http.Request, deps Dependencies, roomID string) {
	if !requireRoomMember(w, r, deps, roomID) {
		return
	}
	principal := principalFromContext(r.Context())
	if err := deps.ZKStore.MarkRoomRead(r.Context(), roomID, principal.UserID); err != nil {
		writeStoreError(w, err)
		return
	}
	event := realtimeStateEvent{
		Kind:   "message.read",
		RoomID: roomID,
		UserID: principal.UserID,
	}
	publishRoomEvent(r.Context(), deps, roomID, event)
	publishRoomMembersStateEvent(r.Context(), deps, roomID, event)
	w.WriteHeader(http.StatusNoContent)
}

func handleInviteFriendToRoom(w http.ResponseWriter, r *http.Request, deps Dependencies, roomID string) {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	var req inviteFriendRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json")
		return
	}
	principal := principalFromContext(r.Context())
	friendID := strings.TrimSpace(req.UserID)
	ok, err := deps.ZKStore.AreFriends(r.Context(), principal.UserID, friendID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if !ok {
		writeError(w, http.StatusForbidden, "not_friends")
		return
	}
	isMember, err := deps.ZKStore.IsRoomMember(r.Context(), roomID, principal.UserID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if !isMember {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	if err := deps.ZKStore.AddRoomMember(r.Context(), roomID, friendID); err != nil {
		writeStoreError(w, err)
		return
	}
	publishRoomMembersEvent(r.Context(), deps, roomID, "chats.changed")
	notifyUser(deps, friendID, notifications.EventChat, notifications.Payload{
		Type:  "chat.invite",
		Title: "Quietline",
		Body:  "You were invited to a chat.",
		URL:   "/chats/" + roomID,
	})
	w.WriteHeader(http.StatusNoContent)
}

func handleLeaveRoom(w http.ResponseWriter, r *http.Request, deps Dependencies, roomID string, userID string) {
	if userID != "" && userID != principalFromContext(r.Context()).UserID {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	if err := deps.ZKStore.LeaveRoom(r.Context(), roomID, principalFromContext(r.Context()).UserID); err != nil {
		writeStoreError(w, err)
		return
	}
	publishRoomEvent(r.Context(), deps, roomID, realtimeStateEvent{
		Kind:   "chats.changed",
		RoomID: roomID,
		UserID: principalFromContext(r.Context()).UserID,
	})
	publishRoomMembersEvent(r.Context(), deps, roomID, "chats.changed")
	publishUserEvent(r.Context(), deps, principalFromContext(r.Context()).UserID, "chats.changed", roomID, "")
	w.WriteHeader(http.StatusNoContent)
}

func handleListEncryptedMessages(w http.ResponseWriter, r *http.Request, deps Dependencies, roomID string) {
	if !requireRoomMember(w, r, deps, roomID) {
		return
	}
	var before *time.Time
	if raw := r.URL.Query().Get("before"); raw != "" {
		parsed, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_before")
			return
		}
		before = &parsed
	}
	const pageSize = 50
	messages, err := deps.ZKStore.ListMessages(r.Context(), roomID, pageSize+1, before)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	hasMore := len(messages) > pageSize
	if hasMore {
		messages = messages[1:]
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": messages, "hasMore": hasMore})
}

func handleListRoomAttachments(w http.ResponseWriter, r *http.Request, deps Dependencies, roomID string) {
	if !requireRoomMember(w, r, deps, roomID) {
		return
	}
	messages, err := deps.ZKStore.ListAttachmentMessages(r.Context(), roomID, 1000)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": messages})
}

func handleAppendEncryptedMessage(w http.ResponseWriter, r *http.Request, deps Dependencies, roomID string) {
	if !requireRoomMember(w, r, deps, roomID) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, deps.Config.MaxMessageBytes)
	var req encryptedMessageRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json")
		return
	}

	msg, err := deps.ZKStore.AppendMessage(r.Context(), zk.EncryptedMessage{
		RoomID:     roomID,
		SenderID:   principalFromContext(r.Context()).UserID,
		Ciphertext: req.Ciphertext,
		Nonce:      req.Nonce,
		Algorithm:  req.Algorithm,
		KeyID:      req.KeyID,
	})
	if err != nil {
		writeStoreError(w, err)
		return
	}

	if err := deps.Broker.Publish(r.Context(), zk.Envelope(msg, deps.Config.NodeID)); err != nil {
		deps.Metrics.BrokerPublishErrors.Inc()
		writeError(w, http.StatusBadGateway, "publish_failed")
		return
	}
	publishRoomMembersStateEvent(r.Context(), deps, roomID, realtimeStateEvent{
		Kind:      "message.created",
		RoomID:    roomID,
		MessageID: msg.ID,
		SenderID:  msg.SenderID,
		At:        msg.CreatedAt.Format(time.RFC3339Nano),
	})
	notifyRoomMembers(deps, roomID, msg.SenderID, notifications.EventMessage, notifications.Payload{
		Type:  "message.created",
		Title: "Quietline",
		Body:  "New message.",
		URL:   "/chats/" + roomID,
	})
	deps.Metrics.MessagesPublished.Inc()
	writeJSON(w, http.StatusAccepted, msg)
}

func handleUpdateEncryptedMessage(w http.ResponseWriter, r *http.Request, deps Dependencies, roomID string, messageID string) {
	if !requireRoomMember(w, r, deps, roomID) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, deps.Config.MaxMessageBytes)
	var req encryptedMessageRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json")
		return
	}

	msg, err := deps.ZKStore.UpdateMessage(r.Context(), roomID, messageID, principalFromContext(r.Context()).UserID, zk.EncryptedMessage{
		RoomID:     roomID,
		SenderID:   principalFromContext(r.Context()).UserID,
		Ciphertext: req.Ciphertext,
		Nonce:      req.Nonce,
		Algorithm:  req.Algorithm,
		KeyID:      req.KeyID,
	})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if err := deps.Broker.Publish(r.Context(), zk.Envelope(msg, deps.Config.NodeID)); err != nil {
		deps.Metrics.BrokerPublishErrors.Inc()
		writeError(w, http.StatusBadGateway, "publish_failed")
		return
	}
	publishRoomMembersEvent(r.Context(), deps, roomID, "chats.changed")
	writeJSON(w, http.StatusOK, msg)
}

func handleDeleteEncryptedMessage(w http.ResponseWriter, r *http.Request, deps Dependencies, roomID string, messageID string) {
	if !requireRoomMember(w, r, deps, roomID) {
		return
	}
	msg, err := deps.ZKStore.DeleteMessageForAll(r.Context(), roomID, messageID, principalFromContext(r.Context()).UserID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if err := deps.Broker.Publish(r.Context(), zk.Envelope(msg, deps.Config.NodeID)); err != nil {
		deps.Metrics.BrokerPublishErrors.Inc()
		writeError(w, http.StatusBadGateway, "publish_failed")
		return
	}
	publishRoomMembersEvent(r.Context(), deps, roomID, "chats.changed")
	writeJSON(w, http.StatusOK, msg)
}

func handleToggleMessageReaction(w http.ResponseWriter, r *http.Request, deps Dependencies, roomID string, messageID string) {
	if !requireRoomMember(w, r, deps, roomID) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024)
	var req reactionRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json")
		return
	}
	msg, err := deps.ZKStore.ToggleMessageReaction(r.Context(), roomID, messageID, principalFromContext(r.Context()).UserID, req.Emoji)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if err := deps.Broker.Publish(r.Context(), zk.Envelope(msg, deps.Config.NodeID)); err != nil {
		deps.Metrics.BrokerPublishErrors.Inc()
		writeError(w, http.StatusBadGateway, "publish_failed")
		return
	}
	publishRoomMembersEvent(r.Context(), deps, roomID, "chats.changed")
	writeJSON(w, http.StatusOK, msg)
}

func handleUploadEncryptedFile(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	r.Body = http.MaxBytesReader(w, r.Body, deps.Config.MaxFileBytes+1024*1024)
	if err := r.ParseMultipartForm(deps.Config.MaxFileBytes); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_multipart")
		return
	}
	roomID := strings.TrimSpace(r.FormValue("roomId"))
	if roomID == "" || strings.ContainsAny(roomID, " \t\r\n") {
		writeError(w, http.StatusBadRequest, "room_id_required")
		return
	}
	if !requireRoomMember(w, r, deps, roomID) {
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "file_required")
		return
	}
	defer file.Close()
	if header.Size <= 0 || header.Size > deps.Config.MaxFileBytes {
		writeError(w, http.StatusBadRequest, "file_too_large")
		return
	}
	stored, err := deps.Files.Put(r.Context(), file, header.Size)
	if err != nil {
		writeError(w, http.StatusBadGateway, "file_upload_failed")
		return
	}
	deps.FileRooms.set(stored.FileID, roomID)
	writeJSON(w, http.StatusCreated, fileUploadResponse{FileID: stored.FileID, Size: stored.Size})
}

func handleDownloadEncryptedFile(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	fileID := fileIDFromPath(r.URL.Path)
	if fileID == "" || strings.ContainsAny(fileID, " \t\r\n") {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	roomID := strings.TrimSpace(r.URL.Query().Get("roomId"))
	if roomID == "" {
		writeError(w, http.StatusBadRequest, "room_id_required")
		return
	}
	// If the registry knows this file, the caller must supply the correct room.
	if storedRoom, ok := deps.FileRooms.get(fileID); ok && storedRoom != roomID {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	if !requireRoomMember(w, r, deps, roomID) {
		return
	}
	reader, size, err := deps.Files.Get(r.Context(), fileID)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	defer reader.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, reader)
}

func publishRoomMembersEvent(ctx context.Context, deps Dependencies, roomID string, kind string) {
	publishRoomMembersStateEvent(ctx, deps, roomID, realtimeStateEvent{
		Kind:   kind,
		RoomID: roomID,
	})
}

func publishRoomMembersStateEvent(ctx context.Context, deps Dependencies, roomID string, event realtimeStateEvent) {
	members, err := deps.ZKStore.ListRoomMembers(ctx, roomID)
	if err != nil {
		deps.Logger.Warn("list room members for realtime event failed", "room", roomID, "kind", event.Kind, "error", err)
		return
	}
	for _, member := range members {
		publishStateEvent(ctx, deps, "user:"+member, event)
	}
}

func publishRoomEvent(ctx context.Context, deps Dependencies, roomID string, event realtimeStateEvent) {
	event.RoomID = roomID
	publishStateEvent(ctx, deps, "room:"+roomID, event)
}

func publishUserEvent(ctx context.Context, deps Dependencies, userID string, kind string, roomID string, sessionID string) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return
	}
	publishStateEvent(ctx, deps, "user:"+userID, realtimeStateEvent{
		Kind:      kind,
		RoomID:    roomID,
		UserID:    userID,
		SessionID: sessionID,
	})
}

func publishStateEvent(ctx context.Context, deps Dependencies, topic string, event realtimeStateEvent) {
	if event.At == "" {
		event.At = time.Now().UTC().Format(time.RFC3339Nano)
	}
	payload, err := json.Marshal(event)
	if err != nil {
		deps.Logger.Warn("marshal realtime event failed", "topic", topic, "kind", event.Kind, "error", err)
		return
	}
	if err := deps.Broker.Publish(ctx, message.New(topic, payload, deps.Config.NodeID)); err != nil {
		deps.Metrics.BrokerPublishErrors.Inc()
		deps.Logger.Warn("publish realtime event failed", "topic", topic, "kind", event.Kind, "error", err)
	}
}

func notifyUser(deps Dependencies, userID string, event notifications.EventType, payload notifications.Payload) {
	if deps.Push == nil {
		return
	}
	go deps.Push.NotifyUser(context.Background(), userID, event, payload)
}

func notifyRoomMembers(deps Dependencies, roomID string, exceptUserID string, event notifications.EventType, payload notifications.Payload) {
	if deps.Push == nil {
		return
	}
	members, err := deps.ZKStore.ListRoomMembers(context.Background(), roomID)
	if err != nil {
		deps.Logger.Warn("list room members for push failed", "room", roomID, "error", err)
		return
	}
	for _, member := range members {
		if member == exceptUserID {
			continue
		}
		notifyUser(deps, member, event, payload)
	}
}

func canPublishTopic(ctx context.Context, deps Dependencies, principal auth.Principal, topic string) bool {
	if roomID, ok := strings.CutPrefix(topic, "room:"); ok {
		roomID = strings.TrimSpace(roomID)
		if roomID == "" || strings.ContainsAny(roomID, " \t\r\n/") || principal.UserID == "" {
			return false
		}
		allowed, err := deps.ZKStore.IsRoomMember(ctx, roomID, principal.UserID)
		if err != nil {
			deps.Logger.Warn("REST room publish authorization failed", "room", roomID, "user", principal.UserID, "error", err)
			return false
		}
		return allowed
	}
	if userID, ok := strings.CutPrefix(topic, "user:"); ok {
		userID = strings.TrimSpace(userID)
		return userID != "" && !strings.ContainsAny(userID, " \t\r\n/") && principal.UserID == userID
	}
	return false
}

func requireRoomMember(w http.ResponseWriter, r *http.Request, deps Dependencies, roomID string) bool {
	principal := principalFromContext(r.Context())
	if principal.UserID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return false
	}
	ok, err := deps.ZKStore.IsRoomMember(r.Context(), roomID, principal.UserID)
	if err != nil {
		writeStoreError(w, err)
		return false
	}
	if !ok {
		writeError(w, http.StatusForbidden, "forbidden")
		return false
	}
	return true
}

func topicFromPath(path string) (string, bool) {
	const prefix = "/v1/topics/"
	const suffix = "/messages"
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return "", false
	}
	topic := strings.TrimSuffix(strings.TrimPrefix(path, prefix), suffix)
	topic = strings.Trim(topic, "/")
	if topic == "" || strings.ContainsAny(topic, " \t\r\n") {
		return "", false
	}
	return topic, true
}

func zkRoomSubroute(path string) (string, string, bool) {
	prefix := ""
	for _, candidate := range []string{"/v1/zk/rooms/", "/v1/chat/rooms/", "/v1/chats/"} {
		if strings.HasPrefix(path, candidate) {
			prefix = candidate
			break
		}
	}
	if prefix == "" {
		return "", "", false
	}
	rest := strings.Trim(strings.TrimPrefix(path, prefix), "/")
	roomID, tail, ok := strings.Cut(rest, "/")
	if !ok || roomID == "" || tail == "" || strings.ContainsAny(roomID, " \t\r\n") {
		return "", "", false
	}
	return roomID, tail, true
}

func identityIDFromPath(path string) string {
	for _, prefix := range []string{"/v1/zk/identities/", "/v1/chat/identities/"} {
		if strings.HasPrefix(path, prefix) {
			return strings.Trim(strings.TrimPrefix(path, prefix), "/")
		}
	}
	return ""
}

func fileIDFromPath(path string) string {
	for _, prefix := range []string{"/v1/zk/files/", "/v1/chat/files/"} {
		if strings.HasPrefix(path, prefix) {
			return strings.Trim(strings.TrimPrefix(path, prefix), "/")
		}
	}
	return ""
}

func friendActionSubroute(path string) (string, string, bool) {
	const prefix = "/v1/chat/friends/"
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}
	rest := strings.Trim(strings.TrimPrefix(path, prefix), "/")
	friendID, action, ok := strings.Cut(rest, "/")
	if !ok || friendID == "" || (action != "accept" && action != "decline") || strings.ContainsAny(friendID, " \t\r\n") {
		return "", "", false
	}
	return friendID, action, true
}

func memberSubroute(tail string) (string, bool) {
	const prefix = "members/"
	if !strings.HasPrefix(tail, prefix) {
		return "", false
	}
	userID := strings.Trim(strings.TrimPrefix(tail, prefix), "/")
	if userID == "" || strings.ContainsAny(userID, " \t\r\n") {
		return "", false
	}
	return userID, true
}

func messageSubroute(tail string) (string, bool) {
	const prefix = "messages/"
	if !strings.HasPrefix(tail, prefix) {
		return "", false
	}
	messageID := strings.Trim(strings.TrimPrefix(tail, prefix), "/")
	if messageID == "" || strings.ContainsAny(messageID, " \t\r\n/") {
		return "", false
	}
	return messageID, true
}

func decodeJSON(r *http.Request, value any) error {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	return decoder.Decode(value)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

func writeStoreError(w http.ResponseWriter, err error) {
	switch err {
	case zk.ErrBadRequest:
		writeError(w, http.StatusBadRequest, "bad_request")
	case zk.ErrNotFound:
		writeError(w, http.StatusNotFound, "not_found")
	case zk.ErrForbidden:
		writeError(w, http.StatusForbidden, "forbidden")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error")
	}
}

type contextKey string

const principalContextKey contextKey = "principal"

func requireScope(deps Dependencies, scope string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		principal, err := deps.Auth.AuthenticateRequest(r)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		if !deps.Auth.HasScope(principal, scope) {
			writeError(w, http.StatusForbidden, "forbidden")
			return
		}
		ctx := context.WithValue(r.Context(), principalContextKey, principal)
		next.ServeHTTP(w, r.WithContext(ctx))
	}
}

func principalFromContext(ctx context.Context) auth.Principal {
	principal, _ := ctx.Value(principalContextKey).(auth.Principal)
	return principal
}

func corsMiddleware(cfg config.Config, next http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(cfg.CORSAllowedOrigins))
	for _, origin := range cfg.CORSAllowedOrigins {
		allowed[origin] = struct{}{}
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if _, ok := allowed[origin]; ok {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if strings.HasPrefix(r.URL.Path, "/v1/auth/") || strings.HasPrefix(r.URL.Path, "/v1/me") {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func handleOptions(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}

func loggingMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		logger.Info("request", "method", r.Method, "path", r.URL.Path, "remote", r.RemoteAddr)
	})
}

func recoveryMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				writeError(w, http.StatusInternalServerError, "internal_error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// fileRegistry tracks which room each uploaded encrypted file belongs to.
// This is in-memory and resets on restart; production deployments should persist this in DB.
type fileRegistry struct {
	mu    sync.RWMutex
	rooms map[string]string // fileID -> roomID
}

func (fr *fileRegistry) set(fileID, roomID string) {
	fr.mu.Lock()
	fr.rooms[fileID] = roomID
	fr.mu.Unlock()
}

func (fr *fileRegistry) get(fileID string) (string, bool) {
	fr.mu.RLock()
	roomID, ok := fr.rooms[fileID]
	fr.mu.RUnlock()
	return roomID, ok
}

// ipRateLimiter is a sliding-window per-IP rate limiter.
type ipRateLimiter struct {
	mu     sync.Mutex
	hits   map[string][]time.Time
	limit  int
	window time.Duration
}

func newIPRateLimiter(limit int, window time.Duration) *ipRateLimiter {
	return &ipRateLimiter{
		hits:   make(map[string][]time.Time),
		limit:  limit,
		window: window,
	}
}

func (rl *ipRateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-rl.window)
	prev := rl.hits[ip]
	fresh := prev[:0]
	for _, t := range prev {
		if t.After(cutoff) {
			fresh = append(fresh, t)
		}
	}
	if len(fresh) >= rl.limit {
		rl.hits[ip] = fresh
		return false
	}
	rl.hits[ip] = append(fresh, now)
	return true
}

func rateLimitMiddleware(rl *ipRateLimiter, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !rl.allow(clientIP(r)) {
			writeError(w, http.StatusTooManyRequests, "rate_limited")
			return
		}
		next(w, r)
	}
}

// clientIP extracts the real client IP, respecting X-Forwarded-For when present.
// Note: X-Forwarded-For can be spoofed if the app is not behind a trusted proxy.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.Index(xff, ","); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func updateSessionMetadata(r *http.Request, deps Dependencies, principal auth.Principal) {
	if principal.SessionID == "" {
		return
	}
	userAgent := strings.TrimSpace(r.UserAgent())
	deviceName := sessionDeviceName(userAgent)
	ip := clientIP(r)
	location := sessionLocation(r, ip)
	if err := deps.Auth.UpdateSessionMetadata(r.Context(), principal, deviceName, userAgent, ip, location); err != nil {
		deps.Logger.Warn("session metadata update failed", "user", principal.UserID, "session", principal.SessionID, "error", err)
	}
}

func sessionDeviceName(userAgent string) string {
	ua := strings.ToLower(userAgent)
	if ua == "" {
		return "Unknown device"
	}
	os := "Unknown"
	switch {
	case strings.Contains(ua, "windows"):
		os = "Windows"
	case strings.Contains(ua, "iphone") || strings.Contains(ua, "ipad"):
		os = "iOS"
	case strings.Contains(ua, "android"):
		os = "Android"
	case strings.Contains(ua, "mac os") || strings.Contains(ua, "macintosh"):
		os = "macOS"
	case strings.Contains(ua, "linux"):
		os = "Linux"
	}
	browser := "Browser"
	switch {
	case strings.Contains(ua, "edg/"):
		browser = "Edge"
	case strings.Contains(ua, "firefox/"):
		browser = "Firefox"
	case strings.Contains(ua, "chrome/") || strings.Contains(ua, "chromium/"):
		browser = "Chrome"
	case strings.Contains(ua, "safari/"):
		browser = "Safari"
	}
	return strings.TrimSpace(os + " · " + browser)
}

func sessionLocation(r *http.Request, ip string) string {
	city := firstHeader(r, "CF-IPCity", "X-Geo-City", "X-Vercel-IP-City")
	country := firstHeader(r, "CF-IPCountry", "X-Geo-Country", "X-Vercel-IP-Country", "X-Country-Code")
	parts := make([]string, 0, 2)
	if city != "" {
		parts = append(parts, city)
	}
	if country != "" && country != "XX" {
		parts = append(parts, country)
	}
	if len(parts) > 0 {
		return strings.Join(parts, ", ")
	}
	if ip != "" {
		return ip
	}
	return "Unknown"
}

func firstHeader(r *http.Request, names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(r.Header.Get(name)); value != "" {
			return value
		}
	}
	return ""
}

// shareRoom reports whether userID1 and userID2 share at least one common room.
func shareRoom(ctx context.Context, deps Dependencies, userID1, userID2 string) (bool, error) {
	rooms, err := deps.ZKStore.ListRooms(ctx, userID1)
	if err != nil {
		return false, err
	}
	for _, room := range rooms {
		for _, member := range room.Members {
			if member == userID2 {
				return true, nil
			}
		}
	}
	return false, nil
}
