package broker

import (
	"context"
	"fmt"
	"log/slog"

	"highload-ws-pubsub/internal/config"
	"highload-ws-pubsub/internal/message"
)

type Broker interface {
	Publish(ctx context.Context, msg message.Envelope) error
	Subscribe(ctx context.Context, handle func(message.Envelope)) error
	Close() error
}

func New(ctx context.Context, cfg config.Config, logger *slog.Logger) (Broker, error) {
	switch cfg.Broker {
	case "memory", "inmemory":
		return NewMemory(), nil
	case "redis":
		return NewRedis(ctx, cfg, logger)
	default:
		return nil, fmt.Errorf("unsupported broker %q", cfg.Broker)
	}
}
