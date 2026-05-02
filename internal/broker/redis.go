package broker

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"highload-ws-pubsub/internal/config"
	"highload-ws-pubsub/internal/message"

	"github.com/redis/go-redis/v9"
)

type Redis struct {
	client *redis.Client
	cfg    config.Config
	logger *slog.Logger
}

func NewRedis(ctx context.Context, cfg config.Config, logger *slog.Logger) (*Redis, error) {
	client := redis.NewClient(&redis.Options{
		Addr:     cfg.RedisAddr,
		Password: cfg.RedisPassword,
		DB:       cfg.RedisDB,
	})
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, err
	}
	return &Redis{client: client, cfg: cfg, logger: logger}, nil
}

func (r *Redis) Publish(ctx context.Context, msg message.Envelope) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return r.client.Publish(ctx, r.channel(msg.Topic), payload).Err()
}

func (r *Redis) Subscribe(ctx context.Context, handle func(message.Envelope)) error {
	pubsub := r.client.PSubscribe(ctx, r.channel("*"))
	defer pubsub.Close()

	if _, err := pubsub.Receive(ctx); err != nil {
		return err
	}

	ch := pubsub.Channel()
	for {
		select {
		case redisMsg, ok := <-ch:
			if !ok {
				return nil
			}
			var msg message.Envelope
			if err := json.Unmarshal([]byte(redisMsg.Payload), &msg); err != nil {
				r.logger.Warn("invalid redis payload", "error", err)
				continue
			}
			handle(msg)
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (r *Redis) Close() error {
	return r.client.Close()
}

func (r *Redis) channel(topic string) string {
	return fmt.Sprintf("%s:%s", r.cfg.RedisChannelPrefix, strings.TrimSpace(topic))
}
