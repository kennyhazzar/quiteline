package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"highload-ws-pubsub/internal/auth"
	"highload-ws-pubsub/internal/broker"
	"highload-ws-pubsub/internal/config"
	"highload-ws-pubsub/internal/files"
	"highload-ws-pubsub/internal/message"
	"highload-ws-pubsub/internal/metrics"
	"highload-ws-pubsub/internal/ws"
	"highload-ws-pubsub/internal/zk"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Dependencies struct {
	Config  config.Config
	Broker  broker.Broker
	Hub     *ws.Hub
	Metrics *metrics.Registry
	Logger  *slog.Logger
	Auth    *auth.Service
	ZKStore zk.Store
	Files   files.Store
}

func New(deps Dependencies) http.Handler {
	mux := http.NewServeMux()
	wsHandler := ws.NewHandler(deps.Config, deps.Hub, deps.Broker, deps.Metrics, deps.Logger, deps.Auth, deps.ZKStore)

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("GET /metrics", promhttp.HandlerFor(deps.Metrics.Prometheus, promhttp.HandlerOpts{}))
	mux.Handle("GET /ws", wsHandler)
	mux.HandleFunc("OPTIONS /", handleOptions)
	mux.HandleFunc("POST /v1/auth/token", func(w http.ResponseWriter, r *http.Request) {
		handleToken(w, r, deps)
	})
	mux.HandleFunc("POST /v1/auth/register", func(w http.ResponseWriter, r *http.Request) {
		handleRegister(w, r, deps)
	})
	mux.HandleFunc("POST /v1/auth/login", func(w http.ResponseWriter, r *http.Request) {
		handleLogin(w, r, deps)
	})
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
	mux.HandleFunc("POST /v1/zk/rooms", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleCreateRoom(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/chat/rooms", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleCreateRoom(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/zk/rooms/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("GET /v1/chat/rooms/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/zk/rooms/", requireScope(deps, "publish", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("POST /v1/chat/rooms/", requireScope(deps, "publish", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("PUT /v1/zk/rooms/", requireScope(deps, "publish", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("PUT /v1/chat/rooms/", requireScope(deps, "publish", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("DELETE /v1/zk/rooms/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
		handleZKRoomSubroutes(w, r, deps)
	}))
	mux.HandleFunc("DELETE /v1/chat/rooms/", requireScope(deps, "topics:read", func(w http.ResponseWriter, r *http.Request) {
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
	Username string `json:"username"`
	UserID   string `json:"userId"`
}

type inviteFriendRequest struct {
	UserID string `json:"userId"`
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
	w.WriteHeader(http.StatusNoContent)
}

func handleRevokeOtherSessions(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	if err := deps.Auth.RevokeOtherSessions(r.Context(), principalFromContext(r.Context())); err != nil {
		writeError(w, http.StatusBadRequest, "revoke_failed")
		return
	}
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
		user, err := deps.Auth.UserByUsername(r.Context(), req.Username)
		if err != nil {
			writeError(w, http.StatusNotFound, "user_not_found")
			return
		}
		targetID = user.UserID
		_, _ = ensureCurrentIdentity(r.Context(), deps, auth.Principal{UserID: user.UserID, Username: user.Username, DisplayName: user.DisplayName})
	}
	if err := deps.ZKStore.RequestFriend(r.Context(), principalFromContext(r.Context()).UserID, targetID); err != nil {
		writeStoreError(w, err)
		return
	}
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
		if tail != "messages" {
			writeError(w, http.StatusNotFound, "not_found")
			return
		}
		handleListEncryptedMessages(w, r, deps, roomID)
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
	if err := deps.ZKStore.MarkRoomRead(r.Context(), roomID, principalFromContext(r.Context()).UserID); err != nil {
		writeStoreError(w, err)
		return
	}
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
	rooms, err := deps.ZKStore.ListRooms(r.Context(), principal.UserID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	member := false
	for _, room := range rooms {
		if room.RoomID == roomID {
			member = true
			break
		}
	}
	if !member {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	if err := deps.ZKStore.AddRoomMember(r.Context(), roomID, friendID); err != nil {
		writeStoreError(w, err)
		return
	}
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
	w.WriteHeader(http.StatusNoContent)
}

func handleListEncryptedMessages(w http.ResponseWriter, r *http.Request, deps Dependencies, roomID string) {
	if !requireRoomMember(w, r, deps, roomID) {
		return
	}
	messages, err := deps.ZKStore.ListMessages(r.Context(), roomID, 100)
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
	writeJSON(w, http.StatusOK, msg)
}

func handleUploadEncryptedFile(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	r.Body = http.MaxBytesReader(w, r.Body, deps.Config.MaxFileBytes+1024*1024)
	if err := r.ParseMultipartForm(deps.Config.MaxFileBytes); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_multipart")
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
	writeJSON(w, http.StatusCreated, fileUploadResponse{FileID: stored.FileID, Size: stored.Size})
}

func handleDownloadEncryptedFile(w http.ResponseWriter, r *http.Request, deps Dependencies) {
	fileID := fileIDFromPath(r.URL.Path)
	if fileID == "" || strings.ContainsAny(fileID, " \t\r\n") {
		writeError(w, http.StatusNotFound, "not_found")
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
	for _, candidate := range []string{"/v1/zk/rooms/", "/v1/chat/rooms/"} {
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
