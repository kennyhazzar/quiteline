package ws

import (
	"encoding/json"
	"sync"

	"highload-ws-pubsub/internal/config"
	"highload-ws-pubsub/internal/message"
)

type Client struct {
	cfg    config.Config
	userID string
	send   chan []byte
	topics map[string]struct{}
	mu     sync.RWMutex
	closed bool
}

func NewClient(cfg config.Config, userID string, initialTopics []string) *Client {
	client := &Client{
		cfg:    cfg,
		userID: userID,
		send:   make(chan []byte, cfg.ClientBuffer),
		topics: make(map[string]struct{}),
	}
	for _, topic := range initialTopics {
		client.topics[topic] = struct{}{}
	}
	return client
}

func (c *Client) UserID() string {
	return c.userID
}

func (c *Client) Send(msg message.Envelope) bool {
	payload, err := json.Marshal(msg)
	if err != nil {
		return false
	}
	return c.sendPayload(payload)
}

func (c *Client) SendError(code string) bool {
	payload, err := json.Marshal(map[string]string{"type": "error", "code": code})
	if err != nil {
		return false
	}
	return c.sendPayload(payload)
}

func (c *Client) sendPayload(payload []byte) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.closed {
		return false
	}
	select {
	case c.send <- payload:
		return true
	default:
		return false
	}
}

func (c *Client) AddTopic(topic string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.topics[topic] = struct{}{}
}

func (c *Client) RemoveTopic(topic string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.topics, topic)
}

func (c *Client) Topics() map[string]struct{} {
	c.mu.RLock()
	defer c.mu.RUnlock()
	copy := make(map[string]struct{}, len(c.topics))
	for topic := range c.topics {
		copy[topic] = struct{}{}
	}
	return copy
}

func (c *Client) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	close(c.send)
}

type ClientCommand struct {
	Type  string          `json:"type"`
	Topic string          `json:"topic,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
}
