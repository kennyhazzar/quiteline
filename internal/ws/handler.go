package ws

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"highload-ws-pubsub/internal/auth"
	"highload-ws-pubsub/internal/broker"
	"highload-ws-pubsub/internal/config"
	"highload-ws-pubsub/internal/message"
	"highload-ws-pubsub/internal/metrics"

	"github.com/gorilla/websocket"
)

type Handler struct {
	cfg      config.Config
	hub      *Hub
	broker   broker.Broker
	metrics  *metrics.Registry
	logger   *slog.Logger
	auth     *auth.Service
	upgrader websocket.Upgrader
	rooms    RoomAuthorizer
}

type RoomAuthorizer interface {
	IsRoomMember(ctx context.Context, roomID string, userID string) (bool, error)
}

func NewHandler(cfg config.Config, hub *Hub, broker broker.Broker, metrics *metrics.Registry, logger *slog.Logger, authService *auth.Service, rooms RoomAuthorizer) *Handler {
	return &Handler{
		cfg:     cfg,
		hub:     hub,
		broker:  broker,
		metrics: metrics,
		logger:  logger,
		auth:    authService,
		rooms:   rooms,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				origin := r.Header.Get("Origin")
				if origin == "" {
					return true
				}
				for _, allowed := range cfg.CORSAllowedOrigins {
					if origin == allowed {
						return true
					}
				}
				return false
			},
		},
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	principal, err := h.auth.AuthenticateRequest(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if !h.auth.HasScope(principal, "subscribe") {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.logger.Warn("websocket upgrade failed", "error", err)
		return
	}

	client := NewClient(h.cfg, h.authorizedTopics(r.Context(), principal, topicsFromQuery(r)))
	h.hub.Register(client)

	go h.writePump(conn, client)
	h.readPump(r.Context(), conn, client, principal)
}

func (h *Handler) readPump(ctx context.Context, conn *websocket.Conn, client *Client, principal auth.Principal) {
	defer func() {
		h.hub.Unregister(client)
		_ = conn.Close()
	}()

	conn.SetReadLimit(h.cfg.MaxMessageBytes)
	_ = conn.SetReadDeadline(time.Now().Add(h.cfg.PongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(h.cfg.PongWait))
	})

	for {
		_, payload, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var command ClientCommand
		if err := json.Unmarshal(payload, &command); err != nil {
			client.SendError("invalid_json")
			continue
		}

		topic := normalizeTopic(command.Topic)
		switch command.Type {
		case "subscribe":
			if topic == "" {
				client.SendError("topic_required")
				continue
			}
			if !h.authorizeTopic(ctx, principal, topic) {
				client.SendError("forbidden")
				continue
			}
			h.hub.Subscribe(client, topic)
		case "unsubscribe":
			if topic == "" {
				client.SendError("topic_required")
				continue
			}
			h.hub.Unsubscribe(client, topic)
		case "publish":
			if !h.auth.HasScope(principal, "publish") {
				client.SendError("forbidden")
				continue
			}
			if topic == "" || len(command.Data) == 0 {
				client.SendError("topic_and_data_required")
				continue
			}
			if !h.authorizeTopic(ctx, principal, topic) {
				client.SendError("forbidden")
				continue
			}
			msg := message.New(topic, command.Data, h.cfg.NodeID)
			if err := h.broker.Publish(ctx, msg); err != nil {
				h.metrics.BrokerPublishErrors.Inc()
				client.SendError("publish_failed")
				continue
			}
			h.metrics.MessagesPublished.Inc()
		default:
			client.SendError("unknown_command")
		}
	}
}

func (h *Handler) authorizedTopics(ctx context.Context, principal auth.Principal, topics []string) []string {
	result := make([]string, 0, len(topics))
	for _, topic := range topics {
		if h.authorizeTopic(ctx, principal, topic) {
			result = append(result, topic)
		}
	}
	return result
}

func (h *Handler) authorizeTopic(ctx context.Context, principal auth.Principal, topic string) bool {
	roomID, ok := roomIDFromTopic(topic)
	if !ok {
		return true
	}
	if principal.UserID == "" || h.rooms == nil {
		return false
	}
	allowed, err := h.rooms.IsRoomMember(ctx, roomID, principal.UserID)
	if err != nil {
		h.logger.Warn("websocket room authorization failed", "room", roomID, "user", principal.UserID, "error", err)
		return false
	}
	return allowed
}

func (h *Handler) writePump(conn *websocket.Conn, client *Client) {
	ticker := time.NewTicker(h.cfg.PingPeriod)
	defer func() {
		ticker.Stop()
		_ = conn.Close()
	}()

	for {
		select {
		case payload, ok := <-client.send:
			_ = conn.SetWriteDeadline(time.Now().Add(h.cfg.WriteWait))
			if !ok {
				_ = conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				return
			}
		case <-ticker.C:
			_ = conn.SetWriteDeadline(time.Now().Add(h.cfg.WriteWait))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func topicsFromQuery(r *http.Request) []string {
	values := strings.Split(r.URL.Query().Get("topics"), ",")
	topics := make([]string, 0, len(values))
	for _, value := range values {
		if topic := normalizeTopic(value); topic != "" {
			topics = append(topics, topic)
		}
	}
	return topics
}

func normalizeTopic(topic string) string {
	topic = strings.TrimSpace(topic)
	topic = strings.Trim(topic, "/")
	if strings.ContainsAny(topic, " \t\r\n") {
		return ""
	}
	return topic
}

func roomIDFromTopic(topic string) (string, bool) {
	const prefix = "room:"
	if !strings.HasPrefix(topic, prefix) {
		return "", false
	}
	roomID := strings.TrimSpace(strings.TrimPrefix(topic, prefix))
	if roomID == "" || strings.ContainsAny(roomID, " \t\r\n/") {
		return "", true
	}
	return roomID, true
}
