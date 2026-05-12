package ws

import (
	"log/slog"
	"sort"
	"sync"

	"highload-ws-pubsub/internal/config"
	"highload-ws-pubsub/internal/message"
	"highload-ws-pubsub/internal/metrics"
)

type Hub struct {
	cfg     config.Config
	metrics *metrics.Registry
	logger  *slog.Logger

	mu      sync.RWMutex
	clients map[*Client]struct{}
	topics  map[string]map[*Client]struct{}
	closed  bool
}

type TopicStats struct {
	Topic       string `json:"topic"`
	Subscribers int    `json:"subscribers"`
}

func NewHub(cfg config.Config, metrics *metrics.Registry, logger *slog.Logger) *Hub {
	return &Hub{
		cfg:     cfg,
		metrics: metrics,
		logger:  logger,
		clients: make(map[*Client]struct{}),
		topics:  make(map[string]map[*Client]struct{}),
	}
}

func (h *Hub) Register(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		client.Close()
		return
	}
	h.clients[client] = struct{}{}
	for topic := range client.Topics() {
		h.subscribeLocked(client, topic)
	}
	h.metrics.WSConnections.Inc()
}

func (h *Hub) Unregister(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[client]; !ok {
		return
	}
	delete(h.clients, client)
	for topic := range client.Topics() {
		h.unsubscribeLocked(client, topic)
	}
	client.Close()
	h.metrics.WSConnections.Dec()
}

func (h *Hub) Subscribe(client *Client, topic string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[client]; !ok {
		return
	}
	client.AddTopic(topic)
	h.subscribeLocked(client, topic)
}

func (h *Hub) Unsubscribe(client *Client, topic string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[client]; !ok {
		return
	}
	client.RemoveTopic(topic)
	h.unsubscribeLocked(client, topic)
}

func (h *Hub) Deliver(msg message.Envelope) {
	h.mu.RLock()
	subscribers := make([]*Client, 0, len(h.topics[msg.Topic]))
	for client := range h.topics[msg.Topic] {
		subscribers = append(subscribers, client)
	}
	h.mu.RUnlock()

	for _, client := range subscribers {
		if client.Send(msg) {
			h.metrics.MessagesDelivered.Inc()
			continue
		}
		h.metrics.MessagesDropped.Inc()
		h.logger.Warn("dropping slow websocket client", "topic", msg.Topic)
		h.Unregister(client)
	}
}

func (h *Hub) Stats() []TopicStats {
	h.mu.RLock()
	defer h.mu.RUnlock()

	stats := make([]TopicStats, 0, len(h.topics))
	for topic, subscribers := range h.topics {
		stats = append(stats, TopicStats{Topic: topic, Subscribers: len(subscribers)})
	}
	sort.Slice(stats, func(i, j int) bool {
		return stats[i].Topic < stats[j].Topic
	})
	return stats
}

func (h *Hub) ConnectionCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

func (h *Hub) HasUserSubscription(topic string, userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if userID == "" {
		return false
	}
	for client := range h.topics[topic] {
		if client.UserID() == userID {
			return true
		}
	}
	return false
}

func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for client := range h.clients {
		client.Close()
	}
	h.clients = make(map[*Client]struct{})
	h.topics = make(map[string]map[*Client]struct{})
}

func (h *Hub) subscribeLocked(client *Client, topic string) {
	if h.topics[topic] == nil {
		h.topics[topic] = make(map[*Client]struct{})
	}
	h.topics[topic][client] = struct{}{}
}

func (h *Hub) unsubscribeLocked(client *Client, topic string) {
	subscribers := h.topics[topic]
	if subscribers == nil {
		return
	}
	delete(subscribers, client)
	if len(subscribers) == 0 {
		delete(h.topics, topic)
	}
}
