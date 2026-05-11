package notifications

import (
	"context"
	"crypto/elliptic"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"highload-ws-pubsub/internal/config"

	webpush "github.com/SherClockHolmes/webpush-go"
)

type EventType string

const (
	EventMessage EventType = "message"
	EventChat    EventType = "chat"
	EventSession EventType = "session"
	EventFriend  EventType = "friend"
)

type Payload struct {
	Type  string `json:"type"`
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url,omitempty"`
}

type Service struct {
	cfg    config.Config
	store  Store
	logger *slog.Logger
	vapid  vapidState
}

type vapidState struct {
	enabled bool
	reason  string
}

func NewService(cfg config.Config, store Store, logger *slog.Logger) *Service {
	if store == nil {
		store = NewMemoryStore()
	}
	if logger == nil {
		logger = slog.Default()
	}
	vapid := validateVAPID(cfg.VAPIDPublicKey, cfg.VAPIDPrivateKey)
	if !vapid.enabled && vapid.reason != "missing" {
		logger.Warn("web push disabled because VAPID keys are invalid", "reason", vapid.reason)
	}
	return &Service{cfg: cfg, store: store, logger: logger, vapid: vapid}
}

func (s *Service) Enabled() bool {
	return s.vapid.enabled
}

func (s *Service) PublicKey() string {
	return strings.TrimSpace(s.cfg.VAPIDPublicKey)
}

func (s *Service) DisabledReason() string {
	if s.Enabled() {
		return ""
	}
	return s.vapid.reason
}

func (s *Service) Store() Store {
	return s.store
}

func (s *Service) NotifyUser(ctx context.Context, userID string, event EventType, payload Payload) {
	userID = strings.TrimSpace(userID)
	if userID == "" || !s.Enabled() {
		return
	}
	subs, err := s.store.ListByUser(ctx, userID)
	if err != nil {
		s.logger.Warn("list push subscriptions failed", "user", userID, "error", err)
		return
	}
	data, err := json.Marshal(payload)
	if err != nil {
		s.logger.Warn("marshal push payload failed", "user", userID, "type", payload.Type, "error", err)
		return
	}
	for _, sub := range subs {
		if !allows(sub.Preferences, event) {
			continue
		}
		s.send(ctx, sub, data)
	}
}

func (s *Service) send(ctx context.Context, sub Subscription, data []byte) {
	sendCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	resp, err := webpush.SendNotificationWithContext(sendCtx, data, &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys: webpush.Keys{
			Auth:   sub.Auth,
			P256dh: sub.P256DH,
		},
	}, &webpush.Options{
		Subscriber:      s.cfg.VAPIDSubject,
		VAPIDPublicKey:  s.cfg.VAPIDPublicKey,
		VAPIDPrivateKey: s.cfg.VAPIDPrivateKey,
		TTL:             3600,
	})
	if resp != nil {
		defer resp.Body.Close()
	}
	if err != nil {
		s.logger.Warn("send push notification failed", "subscription", sub.ID, "error", err)
		return
	}
	if resp != nil && (resp.StatusCode == http.StatusGone || resp.StatusCode == http.StatusNotFound) {
		_ = s.store.Delete(context.Background(), sub.UserID, sub.ID)
		return
	}
	if resp != nil && resp.StatusCode >= 300 {
		responseBody := ""
		if resp.Body != nil {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
			responseBody = strings.TrimSpace(string(body))
		}
		s.logger.Warn("push endpoint returned non-success", "subscription", sub.ID, "status", resp.StatusCode, "body", responseBody)
		if resp.StatusCode == http.StatusForbidden {
			_ = s.store.Delete(context.Background(), sub.UserID, sub.ID)
		}
		return
	}
	_ = s.store.Touch(context.Background(), sub.ID)
}

func allows(prefs Preferences, event EventType) bool {
	switch event {
	case EventMessage:
		return prefs.Messages
	case EventChat:
		return prefs.Chats
	case EventSession:
		return prefs.Sessions
	case EventFriend:
		return prefs.Friends
	default:
		return false
	}
}

func validateVAPID(publicKey string, privateKey string) vapidState {
	publicKey = strings.TrimSpace(publicKey)
	privateKey = strings.TrimSpace(privateKey)
	if publicKey == "" || privateKey == "" {
		return vapidState{reason: "missing"}
	}
	privateBytes, err := decodeVAPIDKey(privateKey)
	if err != nil || len(privateBytes) != 32 {
		return vapidState{reason: "invalid_private_key"}
	}
	publicBytes, err := decodeVAPIDKey(publicKey)
	if err != nil || len(publicBytes) != 65 || publicBytes[0] != 4 {
		return vapidState{reason: "invalid_public_key"}
	}
	curve := elliptic.P256()
	x, y := curve.ScalarBaseMult(privateBytes)
	derived := elliptic.Marshal(curve, x, y)
	if string(derived) != string(publicBytes) {
		return vapidState{reason: "key_pair_mismatch"}
	}
	return vapidState{enabled: true}
}

func decodeVAPIDKey(value string) ([]byte, error) {
	if decoded, err := base64.RawURLEncoding.DecodeString(value); err == nil {
		return decoded, nil
	}
	if decoded, err := base64.URLEncoding.DecodeString(value); err == nil {
		return decoded, nil
	}
	if decoded, err := base64.RawStdEncoding.DecodeString(value); err == nil {
		return decoded, nil
	}
	return base64.StdEncoding.DecodeString(value)
}
