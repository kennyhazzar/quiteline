package broker

import (
	"context"
	"sync"

	"highload-ws-pubsub/internal/message"
)

type Memory struct {
	mu      sync.RWMutex
	closed  bool
	updates chan message.Envelope
}

func NewMemory() *Memory {
	return &Memory{updates: make(chan message.Envelope, 4096)}
}

func (m *Memory) Publish(ctx context.Context, msg message.Envelope) error {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.closed {
		return context.Canceled
	}

	select {
	case m.updates <- msg:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *Memory) Subscribe(ctx context.Context, handle func(message.Envelope)) error {
	for {
		select {
		case msg, ok := <-m.updates:
			if !ok {
				return nil
			}
			handle(msg)
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (m *Memory) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.closed {
		m.closed = true
		close(m.updates)
	}
	return nil
}
