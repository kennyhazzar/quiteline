package message

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"time"
)

type Envelope struct {
	ID        string          `json:"id"`
	Topic     string          `json:"topic"`
	Data      json.RawMessage `json:"data"`
	Source    string          `json:"source"`
	CreatedAt time.Time       `json:"createdAt"`
}

func New(topic string, data json.RawMessage, source string) Envelope {
	return Envelope{
		ID:        newID(),
		Topic:     topic,
		Data:      data,
		Source:    source,
		CreatedAt: time.Now().UTC(),
	}
}

func newID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(bytes[:])
}
